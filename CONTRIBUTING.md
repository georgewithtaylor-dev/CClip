# 参与 CClip 开发

CClip 基于 AutoClip，保留其 MIT 许可证和必要兼容代码。问题与改进建议请在 [CClip Issues](https://github.com/georgewithtaylor-dev/CClip/issues) 提交，先查看 [当前验证范围](docs/CCLIP_VALIDATION.md)。

1. Fork 本仓库，从独立分支进行修改；保持改动范围清楚。
2. 按 [开发说明](docs/CCLIP_DEVELOPMENT.md) 安装隔离依赖，使用合成或已获授权的测试素材。
3. 不提交原片、私人字幕、项目数据库、密钥、Cookie、用户配置、运行时大包或个人路径。
4. 界面文案同步八种语言；新增失败处理要保留用户已有工程与输出。
5. 运行统一质量检查，并在 PR 中写明实际行为变化、验证方法和未验证的平台。桌面相关改动还需要实际包验证。

```bash
python scripts/quality_gate.py --report ./build/quality.json
```

请勿将绿色源码检查描述为完整桌面验收，不绕过 [测试要求](docs/TESTING_ACCEPTANCE.md) 创建正式发布。本版不提供账号投稿和定时发布；不要重新接入上游的发布、反馈搬运或外部站点通知。

漏洞或敏感资料按 [安全说明](SECURITY.md) 处理。
