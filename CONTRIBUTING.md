# 参与 AIGC Hub

欢迎贡献通用模型适配、画布节点、文档和问题修复。可先用[本地演示](README.md#快速体验)复现，方便别人验证。

1. 报告问题时写清版本、环境、复现步骤，以及预期和实际结果。
2. 改动尽量集中在一个问题。提交 PR 时说明改变了什么、如何验证；界面改动可以附上脱敏截图。
3. 示例和测试优先使用合成数据与本地演示模型。不要提交 API Key、数据库、用户素材或生产配置。

本地检查：

```sh
npx prisma generate
npm run check:export
npm run typecheck
npm test
npm run check:lint-budget
npm run build
```

安全问题请按[安全说明](SECURITY.md)私下报告。代码贡献按 [Apache 2.0](LICENSE) 的贡献条款处理。
