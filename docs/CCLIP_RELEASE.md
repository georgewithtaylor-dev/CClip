# CClip Windows 免安装发布

目前仅支持 Windows x64 免安装版。2026-11-02，项目维护者确认按此平台范围发布已验收的测试包；Mac 不属于本次发布范围，也不宣称已验收。此范围更新优先于保留的上游双平台发布要求。

## 首个下载包

- 标签：`cclip-win-x64-preview-2026.11.02`，指向已验收源码 `e956d680ada2691eac0d3dd0d989fc8220d72dbf`。
- 附件：`CClip-Windows-x64-portable.zip`、同名 `.sha256` 校验文件和脱敏验证摘要。
- ZIP：746,187,349 字节，SHA-256 `777fd00be4df5918f229f1e99fab94d365a4acdeaf3588d78111ec8ced830931`。
- 解压：约 1.54 GiB。完整解压后运行 `CClip/CClip.exe`，保留同目录 `resources`。
- 使用 GitHub Pre-release 标识测试版；不提供 macOS、ARM64 或 Linux 包。上游的多平台自动发版及自动更新不启用。

## 发布顺序

1. 锁定已验收源码与原始分发 ZIP，确认没有私人媒体、字幕、工程、设置或密钥。
2. 保留全量源码检查、Windows 实际 EXE 操作、重开和包散列证据；源码 CI 不能代替桌面验证。
3. 创建不可覆盖的独立 CClip 标签，附验收摘要；上传 ZIP、校验文件和脱敏摘要。
4. 核对 Release 的文件名、大小、服务端 SHA-256 与本机包一致；确认下载地址可访问后更新八语 README 的入口。
5. 后续代码或包有变化时重新构建并复验受影响行为，不复用旧包身份，不覆盖已有标签和附件。

源码 Git 历史不存放运行时 ZIP。GitHub 自动生成的 Source code (zip) 是源码，不能代替程序附件。详见 [验证范围](CCLIP_VALIDATION.md) 和 [使用说明](CCLIP_USER_GUIDE.md)。
