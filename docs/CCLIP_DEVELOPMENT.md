# CClip 开发与构建

本仓库同时保留 AutoClip 兼容代码与 CClip 桌面入口。下列命令启动完整 CClip，本机服务只监听回环地址。

## 源码运行

需要 Python 3.10+、Node.js 20+、FFmpeg/ffprobe（加入 PATH）。本地转写还需要 `requirements-workbench.txt` 中的 faster-whisper 和模型。建议隔离环境，不使用个人工程进行开发测试。

```bash
python -m venv .venv
```

激活环境后：

```bash
python -m pip install -r requirements.txt -r requirements-workbench.txt -r requirements-test.txt
npm --prefix frontend ci
npm --prefix frontend run build:cclip
python -m backend.workbench --full-app --data-dir ./data/cclip-dev --port 3102
```

浏览器打开 `http://127.0.0.1:3102/cclip.html`。模型和接口通过设置配置，不把真实密钥写进源码、测试或公开日志。本地识别首次准备可能需要下载模型。

## 检查

媒体测试需要中文字体和测试依赖。源码统一检查入口：

```bash
python scripts/quality_gate.py --report ./build/quality.json
```

全量包含版本与八语文档合同、Python 正确性检查、后端测试、前端 lint/类型/测试和三个生产构建。通过源码检查不等于桌面成品或真实模型验收。

## Windows 免安装包

需要 Rust、MSVC Build Tools、匹配架构的可携带 Python、运行依赖、FFmpeg、Whisper 运行目录和 WebView2 Fixed Runtime。参数使用自己准备的本地路径：

```powershell
python scripts/prepare_cclip_resources.py --full-app --destination build/cclip-resources --python-root RUNTIME_PYTHON --packages RUNTIME_PACKAGES --ffmpeg FFMPEG_FOLDER --runtime-data WHISPER_DATA --webview2 WEBVIEW2_FOLDER
```

将资源作为 `src-tauri/resources` 后，在 `src-tauri` 目录构建：

```powershell
node ../frontend/node_modules/@tauri-apps/cli/tauri.js build --config tauri.workbench.conf.json --config tauri.portable.conf.json --features workbench --no-bundle --ci -- --locked
```

源码工作区须干净，资源清单与同一提交一致，再调用 `scripts/package_cclip_portable.py`，使用 `--binary`、`--resources`、`--destination`、`--zip` 指定路径。打包器验证资源清单，禁止混入项目数据。

## macOS

`scripts/build_cclip_macos.sh` 在对应架构的 Mac 原生构建，分别支持 Intel `x86_64` 和 Apple Silicon `arm64`。脚本不发布；还需检查运行时架构、依赖、签名和真机安装。当前无 Mac 成品验收结果，不能以 Windows 成绩替代。

## 项目约定

- 不把 `data/`、原片、派生媒体、密钥、运行时或本地证据提交到仓库。
- 新增界面文案同步八种语言。
- 清理功能只删除可证明归属、未在使用的临时文件；损坏记录、未知路径、文件系统链接均保留。
- 不将上游的发版、投稿和监控自动化直接用于 CClip。公开版本需独立验收；见 [测试要求](TESTING_ACCEPTANCE.md) 和 [验证范围](CCLIP_VALIDATION.md)。
