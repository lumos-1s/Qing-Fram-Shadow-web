# 清框影 · Frame Studio

> 桌面照片加框工具 —— 一键为照片添加艺术边框、光影氛围、Logo 水印与个性签名，支持多图拼贴和批量导出。全部渲染在本地完成，照片不上传。
>
> A local-first desktop photo framing app —— add artistic frames, light effects, logo watermarks and personal signatures to photos, with collage layouts and batch export. Everything renders locally; your photos never leave your computer.

Built with **Electron + Canvas 2D**. Runs fully offline.

---

## 功能 · Features

- **60+ 相框样式 / 70 个内置模板** —— 杂志、拍立得、撕纸、胶带、邮票、渐变卡片、漫画分镜、3D卡片、签名纪念、头像叠加等一键套用
  **60+ frame styles / 70 built-in presets** — magazine, polaroid, torn paper, tape, stamp, gradient cards, comic panels, 3D card, signature memorials, avatar overlays, and more.

- **精准参数调节** —— 圆角、边距、照片缩放/偏移、内阴影、外阴影、描边、投影、画布比例、纹理/渐变填充等实时调节
  **Fine-grained controls** — corner radius, margins, photo scale/offset, inner & outer shadows, stroke, drop shadow, canvas ratio, texture/gradient fills; all updated live.

- **光影氛围** —— 暗角、漏光、暖光、冷光等氛围叠加
  **Light & mood** — vignette, light leaks, warm/cool glow overlays.

- **Logo 水印** —— 品牌 Logo 与自定义图标水印，透明度、大小可调
  **Logo watermarking** — brand logos and custom icon watermarks with adjustable opacity and size.

- **相机参数与签名** —— EXIF 自动识别（品牌/型号/焦距/光圈/ISO/快门）可手动修改；个性签名与头像组合排版
  **EXIF & signature** — auto-detected camera info (brand/model/focal/aperture/ISO/shutter), manually editable; personal signature and avatar layouts.

- **模板系统** —— 保存 / 导入 `/ 导出`（.qfs 工程 与 .json）；已存模板管理：搜索、按标签分组、缩略图预览、应用、重命名、删除（带确认）
  **Template manager** — save / import / export (`.qfs` projects & `.json`); search, tag groups, thumbnail previews, apply, rename, and confirmed deletes.

- **快速预设** —— 复古胶片、证件照、自动取色边框
  **Quick presets** — retro film, ID photo, auto color-pick border.

- **拼图** —— 多图网格拼贴，间距、圆角、格间距与字幕可调
  **Collage** — multi-photo grid layouts with adjustable gaps, corner radius and captions.

- **批量处理** —— 批量导入，每张照片独立记忆模板、同步到选中、装框缩略图预览，一键批量导出
  **Batch workflow** — import many photos, per-photo template memory, sync-to-selected, framed thumbnails, one-click batch export.

- **导出** —— PNG / JPEG / WebP，质量可调，导出尺寸可选（原图 / 1080 / 2048 / 4096 / 8192px），选位置渲染写入，默认输出原图尺寸
  **Export** — PNG / JPEG / WebP with adjustable quality; sizes from original to 8192px; pick a location then render & write; defaults to the original resolution.

- **隐私** —— 全本地处理，无需登录，不上传照片
  **Privacy** — everything runs locally: no account, no uploads.

---

## 技术栈 · Tech Stack

| 层 Layer | 技术 Tech |
|---|---|
| 桌面壳 Desktop shell | Electron 31（主/渲染进程分离，`contextIsolation` 开启） |
| 渲染 Rendering | 原生 HTML / CSS / JavaScript + Canvas 2D 离屏合成 |
| 打包分发 Packaging | electron-builder（NSIS 安装版 + 便携版） |
| 自动更新 Auto-update | electron-updater + GitHub Releases |

---

## 快速开始 · Quick Start

```bash
# 安装依赖 / install dependencies
npm install

# 开发模式启动 / run in dev mode
npm run start

# 打包 Windows 安装版 / build installers
npm run dist

# 仅供便携版 / portable only
npm run dist:portable
```

构建产物位于 `dist/`。Built artifacts are placed in `dist/`.

> 提示：Windows 上可双击根目录 `start.bat` 直接启动开发环境。
> Tip: on Windows you can double-click `start.bat` in the project root to launch the dev environment.

### 发布前自检 · Pre-release checks

```bash
npm run check         # ESLint + 预设与引擎风格表一致性校验
npm run release       # 先产出未压缩目录 → 校验无品牌 Logo → 再打安装包
```

`npm run release` 等价于 `app:dir` + `verify:dist` + `dist`：一旦 `app.asar` 里出现
`shared/brandlogos/`，`verify:dist` 会以退出码 1 中止，**不会**继续产出安装包。

```bash
npm run app:dir       # 只产出未压缩目录(供校验用)
npm run verify:dist   # 检查 dist/ 下所有 app.asar:无品牌 Logo、预设 70、纹理 10
```

`verify:dist` 的退出码：`0` 通过 / `1` 发现 Logo 泄漏 / `2` 无法判定（没有产物，或产物早于源码改动）。

> **它同时检查产物新鲜度**：若 `app.asar` 比 `src/`、`shared/presets/`、`package.json`
> 还旧，说明那是上一次构建的残留，会以退出码 2 拒绝通过——避免"改了配置但校验的是旧包"。

> `brandlogos/` 是本机素材：它**不在版本库中**（见 `.gitignore`），也不随安装包分发。
> 全新克隆的仓库不含该目录时，软件照常运行，只是「品牌 Logo」选择组为空、
> 「按品牌自动配 Logo」不生效——相关素材需自行准备，见
> [`THIRD-PARTY-ASSETS.md`](./THIRD-PARTY-ASSETS.md)。
>
> `shared/brandlogos/` is a local-only asset directory: it is **not** tracked by git and is
> excluded from installers. A fresh clone runs fine without it — the brand-logo picker is
> simply empty. See `THIRD-PARTY-ASSETS.md`.

---

## 目录结构 · Project Structure

```
├─ src/
│  ├─ main/          # Electron 主进程：窗口、菜单、文件 IPC、模板读写
│  │                 #   main process: window, menus, file IPC, template I/O
│  └─ renderer/      # 渲染进程：UI 与 Canvas 渲染引擎
│                    #   renderer: UI and Canvas rendering engine
├─ shared/
│  ├─ presets/       # 70 个内置模板（JSON 描述）
│  │                 #   70 built-in preset templates (JSON)
│  ├─ brandlogos/    # 品牌 Logo 素材（106 个文件 / 69 个品牌）
│  │                 #   brand logo assets — 不随发行版分发,见 THIRD-PARTY-ASSETS.md
│  └─ textures/      # 纹理素材 / texture assets (10)
├─ start.bat         # Windows 快速启动脚本 / quick-launch script
├─ THIRD-PARTY-ASSETS.md  # 第三方素材归属说明 / asset attribution notice
└─ package.json
```

> ⚠️ `shared/brandlogos/` 中的品牌图形**不在 MIT 许可范围内**，也未随打包发行版分发
> （已在 `package.json` 的 `build.files` 中排除）。品牌名称与图形仅用于标识照片的拍摄设备，
> 本软件与任何品牌无授权或合作关系。详见 [`THIRD-PARTY-ASSETS.md`](./THIRD-PARTY-ASSETS.md)。
>
> The brand artwork in `shared/brandlogos/` is **not** covered by the MIT License and is
> excluded from distributed builds. Marks are used only to indicate the camera that took a
> photo; this project is not affiliated with any brand. See `THIRD-PARTY-ASSETS.md`.

---

## License

代码采用 [MIT](./LICENSE) 许可。**该许可仅覆盖 `src/` 下的源代码与 `shared/presets/`
中的原创模板**；`shared/brandlogos/` 与 `shared/textures/` 中的素材不适用，其权利归各自
权利人所有 —— 详见 [`THIRD-PARTY-ASSETS.md`](./THIRD-PARTY-ASSETS.md)。

The source code is [MIT](./LICENSE) licensed. This license covers the code under `src/` and
the original templates in `shared/presets/` only. Assets in `shared/brandlogos/` and
`shared/textures/` are excluded — see `THIRD-PARTY-ASSETS.md`.