"""Offline regression tests; all sources, classification and delivery are mocked."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

import monitor
import judge_policy


PUBLISHED = "2026-10-01T00:00:00+00:00"
API_SNAPSHOT = {"latest_reset": None, "scheduled_reset": None}
TG_SNAPSHOT = {"latest_post_id": 1}


def initial_state():
    return {
        "version": 6,
        "sources": copy.deepcopy(monitor.SOURCES),
        "project": monitor.PROJECT,
        "seen": {},
        "last_success_at": None,
        "source_health": {
            provider: {"error": None, "snapshot": copy.deepcopy(snapshot)}
            for provider, snapshot in (("api", API_SNAPSHOT), ("telegram", TG_SNAPSHOT))
        },
        "pending": [],
        "delivered_events": {},
        "delivery_error": None,
        "content_snapshots": {},
        "judge_policy": {"model": judge_policy.MODEL, "version": judge_policy.POLICY_VERSION},
        "judgments": {},
        "sent_events": {},
        "judgment_log": [],
        "judge_error": None,
        "outage": {"since": None, "alerted_at": None, "message_id": None},
        "catch_up_keys": [],
    }


def api_item(source=None, identifier="test-reset-1"):
    item = monitor.normalize({
        "id": identifier,
        "text": "Codex quotas have now been reset.",
        "source": source or {"type": "x_post", "author": "thsottiaux", "url": "https://x.com/thsottiaux/status/123"},
        "reset_type": "regular",
        "announced_at": PUBLISHED,
    }, "reset")
    item["provider"] = "api"
    return item


def telegram_item():
    item = {
        "provider": "telegram", "kind": "telegram", "phase": "reset",
        "post_id": 2, "key": "telegram:codexreset/2",
        "text": "Codex quotas have now been reset.", "published_at": PUBLISHED,
        "source": {"type": "telegram_post", "url": "https://t.me/codexreset/2"},
        "original_urls": ["https://x.com/thsottiaux/status/123"],
    }
    item["fingerprint"] = monitor.telegram_fingerprint(item)
    return item


def confirmed_decisions(items, _context):
    event = {"kind": "quota_reset", "status": "completed", "event_at": None,
             "timing": "unknown", "time_evidence": ""}
    return ({item["key"]: {"key": item["key"], "events": [event], "reason": "明确重置公告"}
             for item in items}, {"model": judge_policy.MODEL})


class MonitorTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="codex-reset-monitor-test-")
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "state.json"
        self.path.write_text(json.dumps(initial_state()), encoding="utf-8")
        self.path.chmod(0o600)
        self.clock = PUBLISHED
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(monitor, "now", side_effect=lambda: self.clock))
        self.api = self.stack.enter_context(patch.object(monitor, "fetch_api", return_value=([], API_SNAPSHOT)))
        self.telegram = self.stack.enter_context(patch.object(monitor, "fetch_telegram", return_value=([], TG_SNAPSHOT)))
        self.notify = self.stack.enter_context(patch.object(monitor, "notify", return_value="test-message-id"))
        self.classify = self.stack.enter_context(patch.object(judge_policy, "classify", side_effect=confirmed_decisions))
        # Fail closed if a test accidentally reaches a network or model boundary.
        self.stack.enter_context(patch.object(monitor.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network request")))
        self.stack.enter_context(patch.object(judge_policy.subprocess, "run", side_effect=AssertionError("Unexpected classifier process")))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def state(self):
        return monitor.read_state(self.path)

    def test_dry_run_leaves_state_and_directory_unchanged(self):
        self.api.return_value = ([api_item()], API_SNAPSHOT)
        before = self.path.read_bytes()
        entries = list(self.path.parent.iterdir())
        with patch.object(monitor, "STATE_PATH", self.path), patch.object(sys, "argv", ["monitor.py", "--dry-run"]):
            self.assertEqual(monitor.main(), 0)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), entries)
        self.classify.assert_not_called()
        self.notify.assert_not_called()

    def test_dual_source_outage_alerts_once_and_recovery_restarts_timer(self):
        self.api.side_effect = RuntimeError("API offline")
        self.telegram.side_effect = RuntimeError("Telegram offline")
        self.assertEqual(monitor.run(self.path), 1)
        self.clock = "2026-10-01T02:00:00+00:00"
        self.assertEqual(monitor.run(self.path), 1)
        self.notify.assert_not_called()
        self.clock = "2026-10-01T02:00:01+00:00"
        self.assertEqual(monitor.run(self.path), 1)
        self.clock = "2026-10-01T03:00:00+00:00"
        self.assertEqual(monitor.run(self.path), 1)
        self.assertEqual(self.notify.call_count, 1)
        self.assertEqual(self.state()["outage"]["message_id"], "test-message-id")

        self.api.side_effect = None
        self.assertEqual(monitor.run(self.path), 1)
        self.assertEqual(self.state()["outage"], {"since": None, "alerted_at": None, "message_id": None})
        self.assertEqual(self.notify.call_count, 1)
        self.api.side_effect = RuntimeError("API offline again")
        self.clock = "2026-10-01T04:00:00+00:00"
        self.assertEqual(monitor.run(self.path), 1)
        self.clock = "2026-10-01T06:00:01+00:00"
        self.assertEqual(monitor.run(self.path), 1)
        self.assertEqual(self.notify.call_count, 2)
        self.classify.assert_not_called()

    def test_classifier_failure_keeps_pending_until_success(self):
        item = api_item()
        self.api.return_value = ([item], API_SNAPSHOT)
        self.classify.side_effect = RuntimeError("Classifier unavailable")
        self.assertEqual(monitor.run(self.path), 1)
        failed = self.state()
        self.assertEqual([entry["key"] for entry in failed["pending"]], [item["key"]])
        self.assertNotIn(item["key"], failed["seen"])
        self.assertIn("Classifier unavailable", failed["judge_error"]["message"])
        self.notify.assert_not_called()
        self.classify.side_effect = confirmed_decisions
        self.assertEqual(monitor.run(self.path), 0)
        recovered = self.state()
        self.assertIsNone(recovered["judge_error"])
        self.assertEqual(recovered["pending"], [])
        self.assertEqual(recovered["seen"][item["key"]], item["fingerprint"])
        self.notify.assert_called_once()

    def test_notification_failure_retries_without_reclassifying_or_losing_event(self):
        item = api_item()
        self.api.return_value = ([item], API_SNAPSHOT)
        self.notify.side_effect = RuntimeError("Notification unavailable")
        self.assertEqual(monitor.run(self.path), 1)
        failed = self.state()
        self.assertEqual(len(failed["pending"]), 1)
        self.assertEqual(failed["sent_events"], {})
        self.assertNotIn(item["key"], failed["seen"])
        self.assertIn("Notification unavailable", failed["delivery_error"]["message"])
        self.notify.side_effect = None
        self.assertEqual(monitor.run(self.path), 0)
        self.assertEqual(monitor.run(self.path), 0)
        self.assertEqual(self.classify.call_count, 1)
        self.assertEqual(self.notify.call_count, 2)
        recovered = self.state()
        self.assertEqual(recovered["pending"], [])
        self.assertEqual(len(recovered["sent_events"]), 1)
        self.assertIsNone(recovered["delivery_error"])

    def test_cross_source_url_alias_and_tracking_query_deliver_once(self):
        item = api_item({"type": "x_post", "author": "thsottiaux", "url": "https://twitter.com/thsottiaux/status/123?s=20"})
        self.api.return_value = ([item], API_SNAPSHOT)
        self.telegram.return_value = ([telegram_item()], TG_SNAPSHOT)
        self.assertEqual(monitor.run(self.path), 0)
        self.notify.assert_called_once()
        state = self.state()
        self.assertEqual(len(state["seen"]), 2)
        self.assertEqual(len(state["sent_events"]), 1)
        self.assertEqual(state["pending"], [])
        # Relative times in the mirror must also use the original announcement.
        context = self.classify.call_args.args[1]
        _, messages = judge_policy.build_request([telegram_item()], context, reference_now=PUBLISHED)
        self.assertEqual(messages[0]["reference_announcement_at"], PUBLISHED)

    def test_previous_url_hash_deduplicates_new_mirror_without_rewriting_receipt(self):
        item = api_item({"type": "x_post", "author": "thsottiaux", "url": "https://twitter.com/thsottiaux/status/123?s=20"})
        decision, _ = confirmed_decisions([item], {})
        event = decision[item["key"]]["events"][0]
        old_identity = hashlib.sha256(json.dumps({"kind": event["kind"], "announcement_url": item["source"]["url"]}, sort_keys=True).encode()).hexdigest()
        receipt = {"key": item["key"], "event": event, "message_id": "historical-message-id"}
        state = self.state()
        state["sent_events"][old_identity] = receipt
        state["seen"][item["key"]] = item["fingerprint"]
        state["content_snapshots"][item["key"]] = monitor.content_snapshot(item)
        monitor.save(self.path, state)
        self.telegram.return_value = ([telegram_item()], TG_SNAPSHOT)
        self.assertEqual(monitor.run(self.path), 0)
        self.notify.assert_not_called()
        self.assertEqual(self.state()["sent_events"], {old_identity: receipt})
        self.assertEqual(self.state()["pending"], [])

    def test_distinct_observed_announcements_without_urls_are_each_delivered(self):
        items = [api_item({"type": "observed"}, identifier) for identifier in ("observed-1", "observed-2")]
        self.api.return_value = (items, API_SNAPSHOT)
        self.assertEqual(monitor.run(self.path), 0)
        self.assertEqual(monitor.run(self.path), 0)
        self.assertEqual(self.notify.call_count, 2)
        self.assertEqual(len(self.state()["sent_events"]), 2)
        self.assertEqual(self.state()["pending"], [])

    def test_atomic_state_save_keeps_private_permissions_under_default_umask(self):
        previous_umask = os.umask(0o022)
        try:
            for path in (self.path, self.path.parent / "new-state.json"):
                with self.subTest(existing=path.exists()):
                    monitor.save(path, initial_state())
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                    self.assertEqual(monitor.read_state(path)["version"], 6)
        finally:
            os.umask(previous_umask)

    def test_retry_after_preserves_numeric_and_http_date_cooldowns(self):
        current = monitor.timestamp(PUBLISHED).timestamp()
        with patch.object(monitor.time, "time", return_value=current):
            self.assertEqual(monitor.RateLimited("600").retry_at, current + 600)
            self.assertEqual(monitor.RateLimited("Thu, 01 Oct 2026 00:10:00 GMT").retry_at, current + 600)
            self.assertEqual(monitor.RateLimited("Wed, 30 Sep 2026 23:00:00 GMT").retry_at, current)
            with self.assertRaises(ValueError):
                monitor.RateLimited("invalid")


if __name__ == "__main__":
    unittest.main(verbosity=2)
