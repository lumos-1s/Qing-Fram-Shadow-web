# 清框影 · Frame Studio

一款本地运行的桌面照片加框工具：为照片批量添加艺术边框、光影效果、文字装饰与 Logo，并支持多图拼贴。Electron + Canvas 2D 实现，全部渲染在本地完成，不上传照片。

## 功能

- **参数调节**：圆角、边距、内阴影、外阴影、描边、投影、水印透明度、画布扩展、间距、对比度等数十项实时调节
- **边框样式**：40 余种内置相框风格（杂志、拍立得、撕纸、胶带、邮票、渐变卡片等）
- **光影**：暖光、冷光、漏光、光束等氛围叠加
- **装饰与文字**：Logo 水印、自定义文字、贴纸装饰
- **模板系统**：40+ 预设模板一键套用，支持自定义模板的保存 / 导入 / 导出
- **拼图**：多图网格拼贴排版
- **批量导出**：单张与批量保存 PNG

## 截图

> 截图待补充（主界面 / 边框模板 / 拼图 / 批量导出）

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron 31（主进程 / 渲染进程分离，contextIsolation 开启） |
| 渲染 | 原生 HTML / CSS / JavaScript，Canvas 2D 离屏合成 |
| 打包分发 | electron-builder（NSIS 安装版 + 便携版） |
| 自动更新 | electron-updater + GitHub Releases |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式启动
npm run start

# 打包 Windows 安装版 / 便携版
npm run dist
```

产物位于 `dist/`。

## 目录结构

```
├─ src/
│  ├─ main/          # Electron 主进程（窗口、菜单、文件 IPC、模板读写）
│  └─ renderer/      # 渲染进程（UI 与 Canvas 渲染引擎）
├─ shared/
│  ├─ presets/       # 40+ 内置模板（JSON 描述）
│  ├─ brandlogos/    # Logo 资源
│  └─ textures/      # 纹理素材
└─ package.json
```

## License

MIT
