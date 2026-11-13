# 发布

发布包由 GitHub Actions 的 `发布版本` 工作流（`.github/workflows/release.yml`）发布。本机没有仓库令牌，`secrets.NPM_TOKEN` 与 `secrets.GH_PACKAGES_TOKEN` 只存在于仓库 Secrets，因此**不要在本机执行 `npm publish`**，也不要为此改发布脚本。

## 步骤

1. 升版本：只改 `package.json` 的 `version`（未指定 minor/major 时只升 patch），例如 `0.21.31`。
2. 本地检查：`bun run typecheck`、`bun test`、`bun run build`、`bun scripts/sync-security-deps.ts --check`。
3. 提交并推送 `main`（远端名为 `github`）：`git push github main`。
4. 打并推送标签：`git tag v0.21.31 && git push github v0.21.31`。标签必须与 `version` 一致，且指向要发布的提交（工作流会校验）。
5. 触发工作流：`gh workflow run release.yml -f tag=v0.21.31`。
6. 等待结果：`gh run watch`，或 `gh run list --workflow=release.yml --limit 1`。
   工作流依次做：校验标签/版本 → 探测两个仓库身份 → `bun run ci` → `npm pack` → tarball 验收（`test-codex-plugin-upgrade`、`npm audit --omit=dev`、`check-installed-package`）→ 上传制品 → 发布 npm → 发布 GitHub Packages。
7. 发布成功后建 GitHub Release（标题、功能说明和验证结果用中文）：

   ```bash
   gh release create v0.21.31 --title "v0.21.31 <中文摘要>" --notes-file /tmp/notes.md
   ```

同一版本必须同时发布 npm 与 GitHub Packages，并推送 `main` 与 tag。

## 常见坑

- 本机 npm 是 12.x，`npm pack` 会因 `bundleDependencies`（`mathjax-full`）与 `overrides`（含 `@xmldom/xmldom`）冲突报 `EBUNDLEOVERRIDE`。发布包由工作流的 Node 22 环境生成；需要本地验收制品时才用 `npx npm@11.6.2 pack --json`，不要改 `package.json` 去绕开。
- 本机没有 `NODE_AUTH_TOKEN`，`gh` 的 OAuth 令牌也没有 `write:packages` 权限；本地 `npm publish` 和 `npm view --registry=https://npm.pkg.github.com` 都会 401，这不代表发布流程有问题。
- 发布中断但制品已验收时，用 `续发已验收版本`（`resume-release.yml`）传 `tag`、`run_id`、`attempt` 复用已验收制品，不重新打包；同一版本续发只核对远端完整性。
- `src/pid-guard.test.ts` 的 Linux 专用用例曾因进程刚 exec 时 `/proc/<pid>/cmdline` 短暂为空而偶发失败（报「命令行为空」）。守卫现在会重读空命令行，并把僵尸进程与内核线程视为不存在。若仍遇到这一条失败，确认日志只有它后 `gh run rerun <run-id> --failed` 重跑即可，不要为此改版本或移动已推送的 tag。
- `scripts/publish-verified-package.mjs` 只接受 `npm pack --json` 生成的清单（含 `name`、`version`、`filename`、`integrity`），并在 `NODE_AUTH_TOKEN` 缺失时直接拒绝发布。
