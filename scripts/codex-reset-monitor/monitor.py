#!/usr/bin/env python3
"""Read two public sources independently and notify the feishu group."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import ssl
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo
import judge_policy

STATUS_URL = "https://codex-resets.com/api/v1/status"
HISTORY_URL = "https://codex-resets.com/api/v1/resets?limit=100"
TELEGRAM_URL = "https://t.me/s/codexreset"
SOURCES = {"api": STATUS_URL, "telegram": TELEGRAM_URL}
SOURCE_NAMES = {"api": "Codex Resets 公开接口", "telegram": "TG codexreset 公开频道"}
NOTIFY_URL = "http://127.0.0.1:9876/notify"
PROJECT = "feishu"
DATA_HOME = Path(os.environ["XDG_DATA_HOME"]) if "XDG_DATA_HOME" in os.environ else Path.home() / ".local" / "share"
STATE_PATH = Path(os.environ["CODEX_RESET_STATE_PATH"]) if "CODEX_RESET_STATE_PATH" in os.environ else DATA_HOME / "codex-reset-rss" / "state.json"
MAX_DATA_AGE = 1200
ALL_SOURCES_OUTAGE_SECONDS = 2 * 60 * 60
KINDS = {"reset": "重置公告", "scheduled": "重置预告", "watch": "可能重置 · 第三方 AI 推测"}
RESET_TYPES = {"regular": "额度重置", "banked": "发放重置卡"}


def now():
    return datetime.now(timezone.utc).isoformat()


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("接口时间字段不是字符串")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("接口时间缺少时区")
    return result


def local_time(value):
    return timestamp(value).astimezone(ZoneInfo("Asia/Hong_Kong")).strftime("%Y-%m-%d %H:%M")


def save(path, state):
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def read_state(path):
    state = json.loads(path.read_text(encoding="utf-8"))
    required = {"version", "sources", "project", "seen", "last_success_at", "source_health", "pending", "delivered_events", "delivery_error", "content_snapshots", "judge_policy", "judgments", "sent_events", "judgment_log", "judge_error", "outage", "catch_up_keys"}
    if not required <= state.keys() or state["version"] != 6:
        raise ValueError("状态文件格式不正确；请显式迁移，程序不会重建基线")
    if state["sources"] != SOURCES or state["project"] != PROJECT:
        raise ValueError("状态文件的来源或通知目标与当前配置不一致")
    if not isinstance(state["seen"], dict) or not isinstance(state["pending"], list) or not isinstance(state["catch_up_keys"], list):
        raise ValueError("状态文件的历史记录或待发送队列损坏")
    if set(state["source_health"]) != set(SOURCES):
        raise ValueError("数据源健康记录不完整")
    if not set(state["seen"]) <= set(state["content_snapshots"]):
        raise ValueError("已读记录缺少对应的正文快照字段")
    if state["judge_policy"] != {"model": judge_policy.MODEL, "version": judge_policy.POLICY_VERSION}:
        raise ValueError("已配置的 GLM 判断策略与程序不一致")
    if set(state["outage"]) != {"since", "alerted_at", "message_id"}:
        raise ValueError("双来源故障计时状态不完整")
    for field in ("since", "alerted_at"):
        if state["outage"][field] is not None:
            timestamp(state["outage"][field])
    return state


class RateLimited(RuntimeError):
    def __init__(self, retry_after):
        current = time.time()
        if re.fullmatch(r"\d+", retry_after.strip()):
            self.retry_at = current + int(retry_after)
        else:
            try:
                deadline = parsedate_to_datetime(retry_after)
            except (TypeError, ValueError) as error:
                raise ValueError("Retry-After 不是有效的秒数或 HTTP 日期") from error
            if deadline.tzinfo is None:
                raise ValueError("Retry-After 日期缺少时区")
            self.retry_at = max(current, deadline.timestamp())
        super().__init__(f"公开接口限流，Retry-After={retry_after}")


def get_bytes(url, accept):
    headers = {"User-Agent": "CodexResetMonitor/1.0 (public-feed-client)", "Accept": accept, "Cache-Control": "no-cache"}
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError(f"接口返回非预期状态：{response.status}")
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError("接口响应超出大小限制")
            return raw
        except urllib.error.HTTPError as error:
            if error.code == 429:
                delay = error.headers.get("Retry-After")
                error.close()
                if delay is None:
                    raise RuntimeError("公开接口限流且未提供 Retry-After") from error
                raise RateLimited(delay) from error
            if error.code not in {500, 502, 503, 504} or attempt == 2:
                raise
            error.close()
            print(f"暂时性 HTTP 故障，第 {attempt+1} 次：{error}", file=sys.stderr)
        except (urllib.error.URLError, ConnectionResetError, TimeoutError, ssl.SSLEOFError) as error:
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            if not isinstance(reason, (ConnectionResetError, TimeoutError, ssl.SSLEOFError)) or attempt == 2:
                raise
            print(f"暂时性连接故障，第 {attempt+1} 次：{error}", file=sys.stderr)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError("接口重试未返回结果")


def get_json(url):
    result = json.loads(get_bytes(url, "application/json"))
    if result["meta"]["api_version"] != "v1":
        raise ValueError("接口版本发生变化")
    generated = timestamp(result["meta"]["generated_at"])
    age = (datetime.now(timezone.utc) - generated).total_seconds()
    if age > MAX_DATA_AGE or age < -300:
        raise ValueError(f"接口响应时间异常，距现在 {age:.0f} 秒；不作为最新数据使用")
    return result


def normalize(raw, kind):
    if not isinstance(raw, dict) or kind not in KINDS:
        raise ValueError("公告格式或类型不正确")
    required = {"text", "source"}
    if kind == "watch":
        required |= {"level", "reset_chance_percent", "forecast_window", "observed_at", "expires_at"}
    else:
        required |= {"id", "reset_type", "announced_at"}
    if kind == "scheduled":
        required |= {"status", "scheduled_for"}
    if not required <= raw.keys():
        raise ValueError(f"{kind} 缺少必要字段：{required - raw.keys()}")
    text = raw["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > 30000:
        raise ValueError("公告正文为空或过长")
    source = raw["source"]
    if not isinstance(source, dict) or source.get("type") not in {"x_post", "observed"}:
        raise ValueError("未知公告来源类型")
    if source["type"] == "x_post" and (source.get("author") != "thsottiaux" or "url" not in source):
        raise ValueError("X 公告来源作者或链接不正确")
    if "url" in source:
        url = urllib.parse.urlsplit(source["url"])
        if url.scheme != "https" or url.hostname not in {"x.com", "twitter.com"} or any(c in source["url"] for c in "\n\r<>()"):
            raise ValueError("公告原文链接不是预期来源")
    item = {"kind": kind, "text": text, "source": source}
    if kind == "watch":
        if raw["level"] not in {"elevated", "strong"}:
            raise ValueError("未知观察信号级别")
        chance = raw["reset_chance_percent"]
        if chance is not None and (type(chance) is not int or not 0 <= chance <= 100):
            raise ValueError("观察信号概率字段异常")
        timestamp(raw["expires_at"])
        item.update(published_at=raw["observed_at"], expires_at=raw["expires_at"], forecast_window=raw["forecast_window"], level=raw["level"])
        identity = source["url"] if "url" in source else raw["observed_at"]
    else:
        if raw["reset_type"] not in RESET_TYPES or not isinstance(raw["id"], str) or not raw["id"]:
            raise ValueError("重置类型或公告 ID 异常")
        item.update(published_at=raw["announced_at"], reset_type=raw["reset_type"])
        identity = raw["id"]
    if kind == "scheduled":
        if raw["status"] != "scheduled":
            raise ValueError("预告状态不是 scheduled")
        if raw["scheduled_for"] is not None:
            timestamp(raw["scheduled_for"])
        item["scheduled_for"] = raw["scheduled_for"]
    timestamp(item["published_at"])
    item["key"] = f"{kind}:{identity}"
    item["fingerprint"] = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
    return item


def fetch_snapshot():
    status = get_json(STATUS_URL)
    data = status["data"]
    if not {"latest_reset", "scheduled_reset", "active_watch", "stats"} <= data.keys():
        raise ValueError("状态接口缺少必要字段，不能将缺失字段视为没有预告")
    history, cursors = [], set()
    url = HISTORY_URL
    for page in range(20):
        response = get_json(url)
        history.extend(normalize(row, "reset") for row in response["data"])
        pagination = response["pagination"]
        if pagination["has_more"] is False:
            if pagination["next_cursor"] is not None:
                raise ValueError("历史接口分页字段矛盾")
            break
        cursor = pagination["next_cursor"]
        if pagination["has_more"] is not True or not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError("历史接口分页游标异常")
        cursors.add(cursor)
        url = HISTORY_URL + "&" + urllib.parse.urlencode({"cursor": cursor})
    else:
        raise ValueError("历史接口超过 20 页，未完成读取")
    items = {row["key"]: row for row in history}
    if len(items) != len(history):
        raise ValueError("历史接口出现重复公告 ID")
    current = {}
    for field, kind in (("latest_reset", "reset"), ("scheduled_reset", "scheduled"), ("active_watch", "watch")):
        raw = data[field]
        current[field] = None if raw is None else normalize(raw, kind)
        if current[field] is not None:
            item = current[field]
            if kind == "watch" and timestamp(item["expires_at"]) <= datetime.now(timezone.utc):
                raise ValueError("接口返回了已过期的观察信号")
            # The status endpoint is authoritative for the current entry.
            items[item["key"]] = item
    if not items:
        raise ValueError("接口没有任何记录，无法确认来源是否正常")
    # Preannouncements and watch signals have priority over history backfills.
    ordered = sorted(items.values(), key=lambda i: (i["kind"] == "reset", timestamp(i["published_at"])))
    return ordered, {"generated_at": status["meta"]["generated_at"], "history_items": len(history), **current}


def fetch_api():
    items, snapshot = fetch_snapshot()
    for item in items:
        item["provider"] = "api"
    return items, snapshot


class TelegramPreview(HTMLParser):
    """Read message bodies and dates, excluding views, reactions and previews."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.posts = []
        self.current = None
        self.depth = 0
        self.text_depth = None
        self.date_anchor = False
        self.before_url = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())
        if tag == "a" and "tme_messages_more" in classes and "href" in attrs:
            url = urllib.parse.urljoin(TELEGRAM_URL, attrs["href"])
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != "https" or parsed.netloc != "t.me" or parsed.path != "/s/codexreset":
                raise ValueError("TG 分页链接指向非预期来源")
            self.before_url = url
        if self.current is None:
            if tag == "div" and "tgme_widget_message" in classes and "data-post" in attrs:
                if not re.fullmatch(r"codexreset/\d+", attrs["data-post"]):
                    raise ValueError("TG 频道或消息 ID 发生变化")
                self.current = {"post": attrs["data-post"], "chunks": [], "links": [], "published_at": None}
                self.depth = 1
            return
        if tag == "div":
            self.depth += 1
            if "tgme_widget_message_text" in classes:
                if self.text_depth is not None:
                    raise ValueError("TG 消息正文出现重复嵌套")
                self.text_depth = self.depth
        if self.text_depth is not None:
            if tag == "br":
                self.current["chunks"].append("\n")
            if tag == "a" and "href" in attrs:
                self.current["links"].append(attrs["href"])
        if tag == "a" and "tgme_widget_message_date" in classes:
            expected = "https://t.me/" + self.current["post"]
            if attrs.get("href") != expected:
                raise ValueError("TG 消息日期链接与消息 ID 不一致")
            self.date_anchor = True
        if tag == "time" and self.date_anchor:
            self.current["published_at"] = attrs["datetime"]

    def handle_data(self, data):
        if self.current is not None and self.text_depth is not None:
            self.current["chunks"].append(data)

    def handle_endtag(self, tag):
        if self.current is None:
            return
        if tag == "a":
            self.date_anchor = False
        if tag == "div":
            if self.depth == self.text_depth:
                self.text_depth = None
            if self.depth == 1:
                if self.current["published_at"] is None:
                    raise ValueError("TG 消息缺少发布时间")
                self.posts.append(self.current)
                self.current = None
                self.date_anchor = False
            self.depth -= 1


def telegram_phase(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    headline = lines[0].lower()
    if not re.search(r"重置|reset", headline):
        return None
    if re.search(r"可能|难道|说不定|[?？]|\bmay\b|\bmight\b", headline):
        return "watch"
    if re.search(r"现已.*重置|重置(?:卡|额度)?(?:现)?已|已(?:陆续)?到账|has now been reset|resets? (?:are|is) (?:now )?rolling out", headline):
        return "reset"
    if re.search(r"预计|将|明日|明天|即将|接下来|\bwill\b|\bexpected\b|\bincoming\b|\bsoon\b", headline):
        return "scheduled"
    return None


def content_snapshot(item):
    return {key: value for key, value in item.items() if key != "fingerprint"}


def semantic_content(item):
    content = content_snapshot(item)
    # Phase is inferred from layout; it must not turn reflow into an edit.
    if item["provider"] == "telegram":
        content.pop("phase")
        content["text"] = " ".join(item["text"].split())
        content["published_at"] = timestamp(item["published_at"]).isoformat()
    return content


def telegram_fingerprint(item):
    return hashlib.sha256(json.dumps(semantic_content(item), sort_keys=True).encode()).hexdigest()


def parse_telegram(raw):
    parser = TelegramPreview()
    parser.feed(raw.decode("utf-8"))
    parser.close()
    if parser.current is not None or not parser.posts:
        raise ValueError("TG 公开页没有完整消息，可能不可访问或页面结构变化")
    items, ids = [], set()
    for post in parser.posts:
        if post["post"] in ids:
            raise ValueError("TG 页面出现重复消息 ID")
        ids.add(post["post"])
        timestamp(post["published_at"])
        text = "\n".join(line.strip() for line in "".join(post["chunks"]).splitlines()).strip()
        if len(text) > 30000:
            raise ValueError("TG 消息文字超出长度限制")
        originals = set()
        for link in post["links"]:
            parsed = urllib.parse.urlsplit(link)
            match = re.fullmatch(r"/([A-Za-z0-9_]+)/status/(\d+)", parsed.path)
            if parsed.scheme == "https" and parsed.hostname in {"x.com", "twitter.com"} and match:
                originals.add(f"https://x.com/{match[1]}/status/{match[2]}")
        item = {"provider": "telegram", "kind": "telegram", "phase": telegram_phase(text), "post_id": int(post["post"].split("/")[1]), "key": "telegram:" + post["post"], "text": text, "published_at": post["published_at"], "source": {"type": "telegram_post", "url": "https://t.me/" + post["post"]}, "original_urls": sorted(originals)}
        item["fingerprint"] = telegram_fingerprint(item)
        items.append(item)
    return sorted(items, key=lambda i: i["post_id"]), parser.before_url


def fetch_telegram(previous_id=None):
    url, visited, collected = TELEGRAM_URL, set(), {}
    for page in range(20):
        if url in visited:
            raise ValueError("TG 分页链接循环")
        visited.add(url)
        items, before = parse_telegram(get_bytes(url, "text/html"))
        for item in items:
            if item["key"] in collected and collected[item["key"]]["fingerprint"] != item["fingerprint"]:
                raise ValueError("TG 分页期间同一消息内容不一致，请重试")
            collected[item["key"]] = item
        if previous_id is None or min(i["post_id"] for i in items) <= previous_id:
            break
        if before is None:
            raise ValueError("TG 最新页未覆盖上次消息，且没有可继续读取的分页链接")
        url = before
    else:
        raise ValueError("TG 超过 20 页仍未覆盖上次检查位置")
    ordered = sorted(collected.values(), key=lambda i: i["post_id"])
    latest = ordered[-1]
    if previous_id is not None and latest["post_id"] < previous_id:
        raise ValueError("TG 最新消息 ID 倒退，无法确认页面是否最新")
    return ordered, {"fetched_at": now(), "visible_items": len(ordered), "latest_post_id": latest["post_id"], "latest_published_at": latest["published_at"], "latest_post_url": latest["source"]["url"]}


def notify(title, text, level="info"):
    payload = json.dumps({"project": PROJECT, "title": title, "text": text, "level": level}, ensure_ascii=False).encode()
    request = urllib.request.Request(NOTIFY_URL, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    if result.get("ok") is not True or not result.get("message_id"):
        raise RuntimeError(f"通知接口未确认发送成功：{result}")
    return result["message_id"]


def migrate(path):
    state = json.loads(path.read_text(encoding="utf-8"))
    if state["version"] != 5 or state["sources"] != SOURCES or state["project"] != PROJECT:
        raise ValueError("只允许升级当前 GLM 监控的告警策略")
    state["version"] = 6
    state["outage"] = {"since": None, "alerted_at": None, "message_id": None}
    state["quiet_alert_policy_enabled_at"] = now()
    for health in state["source_health"].values():
        health.pop("recovery_pending", None)
        if health["error"] is not None:
            health["error"].pop("alert_epoch", None)
    if state["judge_error"] is not None:
        state["judge_error"].pop("alert_epoch", None)
    save(path, state)
    print(json.dumps({"upgraded": True, "version": 6, "all_sources_outage_threshold_seconds": ALL_SOURCES_OUTAGE_SECONDS, "once_per_outage": True, "pending": len(state["pending"])}))


def update_outage(state):
    if any(health["error"] is None for health in state["source_health"].values()):
        state["outage"] = {"since": None, "alerted_at": None, "message_id": None}
    elif state["outage"]["since"] is None:
        state["outage"]["since"] = now()


def alert_sustained_outage(state, path):
    outage = state["outage"]
    if outage["since"] is None or outage["alerted_at"] is not None:
        return False
    if any(health["error"] is None for health in state["source_health"].values()):
        return False
    elapsed = (timestamp(now()) - timestamp(outage["since"])).total_seconds()
    if elapsed <= ALL_SOURCES_OUTAGE_SECONDS:
        return False
    receipt = notify(
        "重置监控中断超过两小时",
        f"两个数据源自 {local_time(outage['since'])}（北京时间）起持续不可用，已超过两小时。\n目前无法获取新的重置预告，系统会继续自动检查。",
        "error",
    )
    outage["alerted_at"] = now()
    outage["message_id"] = receipt
    save(path, state)
    return True


def classify_and_deliver(state, path, successful, fresh):
    batch, characters = [], 0
    for item in state["pending"]:
        if item["provider"] not in successful:
            continue
        if len(batch) >= 8 or characters + len(item["text"]) > 90000:
            break
        batch.append(item)
        characters += len(item["text"])
    if not batch:
        return 0, 0
    context = {"announcement_times": {}, "latest_reset": None, "scheduled_reset": None}
    if "api" in successful:
        snapshot = state["source_health"]["api"]["snapshot"]
        context["latest_reset"] = snapshot["latest_reset"]
        context["scheduled_reset"] = snapshot["scheduled_reset"]
        for item in fresh:
            if item["provider"] == "api" and "url" in item["source"]:
                url = judge_policy.canonical_announcement_url(item["source"]["url"])
                context["announcement_times"][url] = item["published_at"]
    need_judgment = [item for item in batch if item["key"] not in state["judgments"] or state["judgments"][item["key"]]["fingerprint"] != item["fingerprint"]]
    if need_judgment:
        try:
            decisions, audit = judge_policy.classify(need_judgment, context)
        except Exception as error:
            traceback.print_exc()
            state["judge_error"] = {"at": now(), "message": f"{type(error).__name__}: {error}"}
            save(path, state)
            return 0, 0
        for item in need_judgment:
            state["judgments"][item["key"]] = {"fingerprint": item["fingerprint"], "evaluated_at": now(), "result": decisions[item["key"]], "model_audit": audit}
        state["judge_error"] = None
        save(path, state)
    sent, filtered = 0, 0
    sent_identities = judge_policy.delivered_event_identities(state["sent_events"], state["content_snapshots"])
    for item in batch:
        decision = state["judgments"][item["key"]]["result"]
        outcomes, finished = [], True
        for model_event in decision["events"]:
            event = {**model_event, "kind": judge_policy.event_kind(model_event, item)}
            if event["kind"] != model_event["kind"]:
                outcomes.append({"action": "source_kind_correction", "model_kind": model_event["kind"], "source_kind": event["kind"]})
            allowed, reason = judge_policy.evaluate_event(event, item)
            if not allowed:
                outcomes.append({"event": event, "action": "filtered", "reason": reason})
                filtered += 1
                continue
            identity = judge_policy.event_identity(event, item)
            if identity in sent_identities:
                outcomes.append({"event": event, "action": "deduplicated", "reason": "same_announcement_and_event_type"})
                filtered += 1
                continue
            if sent >= 5:
                finished = False
                break
            title, body = judge_policy.format_event(event, item)
            allowed, reason = judge_policy.evaluate_event(event, item)
            if not allowed:
                outcomes.append({"event": event, "action": "filtered", "reason": reason})
                filtered += 1
                continue
            if item["key"] in state["catch_up_keys"]:
                title = "补发｜" + title
                body = "此前过滤规则漏报，现补发这条已发布的公告。\n" + body
            receipt = notify(title, body)
            recorded = {"at": now(), "key": item["key"], "provider": item["provider"], "project": PROJECT, "message_id": receipt, "event": event, "model": judge_policy.MODEL, "source_published_at": item["published_at"]}
            state["sent_events"][identity] = recorded
            sent_identities.add(identity)
            state["last_notification"] = recorded
            save(path, state)
            outcomes.append({"event": event, "action": "sent", "message_id": receipt})
            sent += 1
        if not finished:
            break
        if not decision["events"]:
            outcomes.append({"action": "filtered", "reason": "no_relevant_event"})
            filtered += 1
        log_entry = {"at": now(), "key": item["key"], "fingerprint": item["fingerprint"], "model": judge_policy.MODEL, "model_reason": decision["reason"], "outcomes": outcomes}
        state["judgment_log"] = (state["judgment_log"] + [log_entry])[-100:]
        print(json.dumps({"event_decision": log_entry}, ensure_ascii=False))
        state["seen"][item["key"]] = item["fingerprint"]
        state["content_snapshots"][item["key"]] = content_snapshot(item)
        state["pending"] = [queued for queued in state["pending"] if queued["key"] != item["key"]]
        state["catch_up_keys"] = [key for key in state["catch_up_keys"] if key != item["key"]]
        save(path, state)
    return sent, filtered


def run(path, dry_run=False):
    try:
        state = read_state(path)
    except Exception as error:
        traceback.print_exc()
        return 1
    state["last_attempt_at"] = now()
    successful, fresh = set(), []
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {}
        for provider in SOURCES:
            health = state["source_health"][provider]
            previous = health["error"]
            if previous and previous.get("retry_at") and time.time() < previous["retry_at"]:
                print(json.dumps({"provider": provider, "deferred_until": previous["retry_at"], "error": previous["message"]}))
                continue
            health["last_attempt_at"] = now()
            job = pool.submit(fetch_api) if provider == "api" else pool.submit(fetch_telegram, health["snapshot"]["latest_post_id"])
            jobs[job] = provider
        for job in as_completed(jobs):
            provider = jobs[job]
            health = state["source_health"][provider]
            previous = health["error"]
            try:
                items, snapshot = job.result()
                fresh.extend(items)
                successful.add(provider)
                health["snapshot"] = snapshot
                health["last_success_at"] = now()
                health["error"] = None
            except Exception as error:
                print(f"{SOURCE_NAMES[provider]} 读取失败", file=sys.stderr)
                traceback.print_exc()
                health["error"] = {"at": now(), "message": f"{type(error).__name__}: {error}", "retry_at": error.retry_at if isinstance(error, RateLimited) else None}
    update_outage(state)
    queued = {i["key"]: i for i in state["pending"]}
    for item in fresh:
        if state["seen"].get(item["key"]) != item["fingerprint"]:
            queued[item["key"]] = item
        else:
            queued.pop(item["key"], None)
            state["content_snapshots"][item["key"]] = content_snapshot(item)
    state["pending"] = sorted(queued.values(), key=lambda i: (timestamp(i["published_at"]), i["provider"] != "api"))
    if dry_run:
        ok = all(health["error"] is None for health in state["source_health"].values())
        print(json.dumps({"ok": ok, "dry_run": True, "project": PROJECT,
                          "sources_ok": sorted(successful), "pending": len(state["pending"]),
                          "would_judge": sum(1 for item in state["pending"] if item["key"] not in state["judgments"] or state["judgments"][item["key"]]["fingerprint"] != item["fingerprint"]),
                          "source_errors": {p: h["error"] for p, h in state["source_health"].items()},
                          "state_written": False, "model_called": False, "notified": 0}, ensure_ascii=False))
        return 0 if ok else 1
    save(path, state)
    sent, filtered = 0, 0
    outage_alert_sent = False
    try:
        outage_alert_sent = alert_sustained_outage(state, path)
        sent, filtered = classify_and_deliver(state, path, successful, fresh)
        if outage_alert_sent or sent:
            state["delivery_error"] = None
    except Exception as error:
        print("推送到 feishu 群失败；未确认成功的动态保留在队列中", file=sys.stderr)
        traceback.print_exc()
        state["delivery_error"] = {"at": now(), "message": f"{type(error).__name__}: {error}"}
    ok = state["delivery_error"] is None and state["judge_error"] is None and all(h["error"] is None for h in state["source_health"].values())
    if ok:
        state["last_success_at"] = now()
    save(path, state)
    print(json.dumps({"ok": ok, "at": now(), "project": PROJECT, "sources_ok": sorted(successful), "notified": sent, "filtered_events": filtered, "pending": len(state["pending"]), "source_errors": {p: h["error"] for p, h in state["source_health"].items()}, "delivery_error": state["delivery_error"], "judge_error": state["judge_error"], "outage": state["outage"], "outage_alert_sent": outage_alert_sent}, ensure_ascii=False))
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--quiet-alerts", action="store_true")
    mode.add_argument("--check-source", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--dry-run", action="store_true", help="读取真实来源并比较增量，不调用模型、不发送、不写状态")
    args = parser.parse_args()
    if args.check_source:
        errors = False
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs = {pool.submit(fetch_api): "api", pool.submit(fetch_telegram): "telegram"}
            for job in as_completed(jobs):
                try:
                    items, snapshot = job.result()
                    print(json.dumps({"provider": jobs[job], "items": len(items), "snapshot": snapshot}, ensure_ascii=False, indent=2))
                except Exception:
                    errors = True
                    traceback.print_exc()
        return 1 if errors else 0
    if args.status:
        state = read_state(STATE_PATH)
        state["tracked_items"] = len(state.pop("seen"))
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    if args.dry_run:
        return run(STATE_PATH, dry_run=True)
    with STATE_PATH.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.quiet_alerts:
            migrate(STATE_PATH)
            return 0
        return run(STATE_PATH)


if __name__ == "__main__":
    sys.exit(main())
