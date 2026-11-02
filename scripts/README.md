# CClip 构建与检查脚本

完整操作见 [开发与构建](../docs/CCLIP_DEVELOPMENT.md)。本目录保留源码检查、离线运行、媒体处理验证和桌面打包所需的工具。

| 入口 | 用途 |
| --- | --- |
| `quality_gate.py` | 运行全部源码检查，报告绑定提交和工作区状态 |
| `prepare_cclip_resources.py` | 从明确输入准备离线资源，拒绝项目数据和设置 |
| `package_cclip_portable.py` | 校验资源清单并生成 Windows 免安装 ZIP |
| `build_cclip_macos.sh` | 在对应架构的 Mac 构建；当前仍需真机验收 |
| `verify_workbench_drafts.py` | 检查工程和剪辑稿一致性 |
| `tests/` | 构建、运行时、隐私边界和发布安全门的回归检查 |

本版移除了上游社区运营、反馈搬运、真实账号投稿及官网同步脚本。保留的发行校验器和已禁用自动发布工作流用于防止未经验证的软件发版；它们不会在 CClip 仓库自动发布。不要把源码检查通过当作桌面或 Mac 验收通过。
