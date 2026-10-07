# 发布与自动更新流程（RELEASE 指南）

清框影的自动更新走 **electron-updater + GitHub Releases**（同 yt-dlp 的"查版本→下载→替换"思路）：

- 启动 3 秒后主进程静默 `checkForUpdates()`，发现新版本通过 `updater:event` 推送渲染层横幅（"发现新版本 vX.Y.Z，点击更新"）。
- 用户点"立即更新"→ `downloadUpdate()` 下载新安装包并显示进度条 → 下载完"立即重启"→ `quitAndInstall()` 安装生效。
- 版本源是 GitHub Releases 上的 `latest.yml`（由 electron-builder 在打包 NSIS 安装版时自动生成）。

## 一、为什么现在不能一键更新（缺什么）

代码层全部就绪（主进程 / preload / 渲染 UI / build.publish 配置）。真正缺的是**发布动作**：
GitHub Releases 里没有 `latest.yml` + 新版安装包，旧版就永远查不到更新。

## 二、发布步骤（每次发新版）

1. **bump 版本号**（自动更新比对的依据，务必每次递增）：
   ```
   # 改 package.json 的 "version" 字段,如 0.1.7 → 0.1.8
   ```
   版本号规则：`主.次.修订`，任何功能/修复发布都要递增，不得回退。

2. **自检**（发布前必跑）：
   ```
   npm run check
   ```
   含 lint、预设校验、标记校验、主进程 I/O、引擎不变量等全套检查。

3. **打包并发布到 GitHub Releases**（需 GitHub token）：
   ```
   # Windows PowerShell,先设置 token(每次新开终端都要设,不持久化)
   $env:GH_TOKEN = "你的 Personal Access Token"
   npm run release:publish
   ```
   `--publish always` 会自动：打包 NSIS 安装版 + portable 版 → 生成 `latest.yml` → 创建/更新 GitHub Release（版本 tag 取 package.json version）→ 上传产物。产物含：
   - `Qingframe-Setup-<version>-x64.exe`（NSIS 安装版，**只有它带 app-update.yml，能自动更新**）
   - `Qingframe-Portable-<version>-x64.exe`（便携单文件版，**不支持在线自动更新**，代码里已跳过）
   - `latest.yml` / `latest-mac.yml`（更新源元数据，必须随 release 一起存在）

4. **验证**：
   - 打开 GitHub Releases 页面，确认 tag 与 package.json 版本一致、`latest.yml` 已上传。
   - 装旧版 → 启动 → 3 秒后出现"发现新版本"横幅。

## 三、注意事项

- **portable 单文件版不能自动更新**：它不生成 `app-update.yml`，主进程检测到后直接跳过（日志 `[updater] 未发现 app-update.yml`）。想给便携版用户更新，只能引导到 GitHub Releases 手动下载；要"真·一键更新"就用 NSIS 安装版分发。
- **品牌 Logo 不进公开版**：`build.files` 已排除 `shared/brandlogos/**`，发布产物天然不含品牌 Logo 素材（商标/著作权考虑）。本地带 Logo 的包是单独打的，不走这个发布流程。
- **头像/用户名默认空**：打包产物不携带开发机的 userData（状态、头像、签名都留在本机 AppData），新用户安装后头像/用户名为空，符合发布要求。
- **发布无需本地跑**：`release:publish` 也可以在 GitHub Actions 上跑（配 GH_TOKEN secret），本地发布即可。
- **token 权限**：Personal Access Token 需要 `repo` 权限（创建 Release、上传 asset）。不要提交到 git。
