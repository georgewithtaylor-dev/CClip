<div align="center">

<img src="src-tauri/icons/cclip/128x128.png" alt="CClip" width="80">

# CClip

**直播录播切片与字幕精剪工具**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Windows x64](https://img.shields.io/badge/Windows-x64%20portable-blue)
![macOS](https://img.shields.io/badge/macOS-validation%20pending-lightgrey)

</div>

[简体中文](README.md) · [English](README-EN.md) · [日本語](README-JA.md) · [한국어](README-KO.md) · [Español](README-ES.md) · [Português](README-PT.md) · [Русский](README-RU.md) · [Français](README-FR.md)

CClip 基于 [AutoClip](https://github.com/zhouxiaoka/autoclip) 二次开发，面向直播结束后的录播整理：从长视频找到精彩内容，再通过时间轴、字幕和波形精剪，制作适合不同平台的视频与封面。

## 功能一览

- **完整原片时间轴**：浏览 AI 未选中的部分，手动设入点、出点，添加自选片段。
- **AI 选片与口语清理**：一键依次转写、选片和清理；也能单独执行，检查建议后再剪辑。
- **字幕驱动剪辑**：逐行定位、勾选、修改、搜索和标记；成片内支持剪掉所选或仅保留所选。
- **可编辑片段**：分割、删片段、拖动起止、范围增删、吸附、波形、撤销与重做。
- **平台输出**：抖音、小红书、B站、TikTok、Instagram Reels、YouTube Shorts 与 YouTube 的画幅及包装预设。
- **封面制作**：本机模板、配色与实时预览；可下载提示词和截图，自行生图后上传封面；独立图像 API 按配置使用。
- **本地项目**：保存后继续编辑，保留导出记录；设置以悬浮窗口打开，支持亮暗主题与八种界面语言。
- **存储管理**：自定义生成成片与下载目录；目录旁说明清理边界，一键清理程序确认归属的闲置临时缓存。

本版一个项目处理一个原片，编辑过程中不追加素材；不包含账号投稿或定时发布。语音识别沿用原方案，字幕仍需人工校对。

## 使用方法

1. 完整解压 Windows 免安装 ZIP，双击 `CClip/CClip.exe`。保留旁边的 `resources` 文件夹，不要在压缩包内直接运行。
2. 选择本地录播，或从支持的视频链接导入。手动剪辑不需要 AI 接口。
3. 使用 AI 时，在右上角 **设置 → AI 模型** 配置自己的服务；确认发送范围后执行选片。
4. 在 **剪辑片段** 浏览原片、校对字幕、选择内容，再进入 **成片编辑** 调整当前片段、画面与封面。
5. 保存项目，导出视频。先在 **设置 → 存储位置** 选择空间充足的磁盘。

工程与设置默认存于 `%APPDATA%/com.cclip.workbench`；更换程序目录不会自动迁移这些数据。

## 当前版本与下载

本次为 CClip 首次公开源码。Windows x64 免安装版本已完成本地试用验收；**此源码仓库提交不附带安装包，也不代表 macOS 已验收**。后续可下载包会放在 [Releases](https://github.com/georgewithtaylor-dev/CClip/releases)，不要把上游 AutoClip 安装包当作 CClip。

程序版本与构建信息可在 **设置 → 应用** 查看，源码版本以本仓库提交记录为准。

| 平台 | 当前状态 |
| --- | --- |
| Windows x64 | 本地免安装包实测通过；完整离线包解压约 1.54 GiB |
| Intel Mac | 首版兼容目标；已有原生构建脚本，尚未完成真机验收 |
| Apple Silicon Mac | 兼容目标；尚未完成真机验收 |

完整包携带 Python、媒体工具、浏览器运行组件和本地识别依赖，**尚未达到解压后 500 MB 的目标**。源码仓库不包含这些运行时和私人测试数据。

## 隐私与接口费用

- 本地剪辑和本地转写在本机执行；选择云端分析或生图服务时，相关文字或图片会发送到所配置的服务，调用前按界面说明确认。
- AI 服务需要自己的接口和额度，CClip 不提供免费云端配额。ChatGPT 订阅账号登录不等同于可供本工具调用的图像 API。
- 本版默认关闭使用统计和崩溃上报。请勿在 Issue、日志或公开仓库中提交 API 密钥、Cookie、原片或私人字幕。

## 从源码运行

开发环境与命令见 [开发与构建](docs/CCLIP_DEVELOPMENT.md)。源码运行需要自行准备 Python、Node.js、FFmpeg 和本地识别依赖；这与最终用户使用免安装包不同。

结构概览：

| 目录 | 内容 |
| --- | --- |
| `frontend/src/cclip/` | CClip 首页、项目和设置整合 |
| `frontend/src/features/workbench/` | 时间轴、字幕与片段编辑 |
| `backend/cclip/` | 项目互通、成片与存储接口 |
| `backend/workbench/` | 本机剪辑服务、任务和项目存储 |
| `src-tauri/` | 桌面外壳与图标 |
| `scripts/` | 构建、离线检查和打包工具 |

更多信息：[使用与清理说明](docs/CCLIP_USER_GUIDE.md) · [源码审查与验证](docs/CCLIP_VALIDATION.md) · [问题反馈](https://github.com/georgewithtaylor-dev/CClip/issues)

## 致谢与许可

感谢 [zhouxiaoka/autoclip](https://github.com/zhouxiaoka/autoclip) 及其贡献者提供基础实现。CClip 保留上游版权和 [MIT License](LICENSE)，同时使用独立名称、图标和编辑工作台。

仓库中的 AutoClip 文档、CLI/MCP 和兼容代码保留其上游命名；它们的历史功能与下载说明不等同于 CClip 当前交付范围。
