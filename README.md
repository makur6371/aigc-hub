# AIGC Hub

自托管的 AI 创作工作台。通过同一套界面进行图像生成与编辑、视频生成、Agent 对话和画布工作流创作。模型、能力和用量规则由实例管理员配置。开源这个框架，是为了让个人和团队能用自己的模型搭起工作台，也欢迎大家贡献通用适配、节点和文档。

## 本地启动

需要 Node.js 24 和 npm。先运行 `npm ci`，再把 `.env.example` 复制为 `.env`。填写随机生成的 `JWT_SECRET`、管理员邮箱和密码。数据库和素材默认写入本地目录。

```sh
npm run db:setup
npm run dev
```

访问 [本地工作台](http://localhost:3000)，用刚设置的邮箱和密码登录。初始化会创建内置节点和创作工作流，模型列表默认是空的。到「系统设置 → 供应商与模型」配置自有接口。文生图使用 `/images/generations`；如果接口支持 multipart 图像编辑，选「通用图像编辑接口」模板，参考图将发送到 `/images/edits`。视频的生成方式、比例、分辨率、时长和素材上限都在模型配置里声明。

管理员可以用新的邮箱和密码运行 `npm run db:setup -- --user` 创建普通账号。初始化完成后可从 `.env` 移除初始化账号和密码；重复运行不会重置已有账户密码。

## 无需 API Key 的本地演示

将 `APP_ENABLE_DEMO=1` 写入本地 `.env`，用 `npm run db:setup -- --demo` 初始化后启动。演示模型返回本地合成样图、视频和文字，供体验流程使用。视频任务会先返回排队状态，再返回可播放结果。可运行 `npm run smoke` 验证完整链路。演示模式只应用于本地实例；使用真实模型时请关闭演示并在后台停用本地演示模型。

## Docker Compose

设置 `.env` 后执行：

```sh
docker compose build
docker compose run --rm hub npm run db:setup
docker compose up -d
```

Compose 绑定本机端口并把数据库与素材放在持久卷。仅本地 HTTP 试玩可设置 `APP_ALLOW_INSECURE_HTTP=1`。正式使用请用 HTTPS 反向代理，关闭该选项，并在 `.env` 配置实际的 `NEXT_PUBLIC_APP_URL`。素材链接用于向生成服务提供输入；得到链接的人可以读取该素材，请按部署用途设置访问边界。

## 开发与验证

`npm run typecheck` · `npm test` · `npm run build` · `npm run check:lint-budget` · `npm run check:export`

第三方适配器和自定义节点代码默认禁用。只有实例所有者确认信任代码后，才应设置 APP_ENABLE_TRUSTED_CODE=1；这些代码与应用共享进程权限。用户导入工作流使用已安装的节点定义。

## 贡献

欢迎提交可以独立复现的修复、通用模型适配、工作流节点和文档改进。示例优先用本地演示模型；请勿提交 API 密钥、用户素材或生产配置。

## 许可证与出处

本仓库的项目代码采用 [Apache License 2.0](LICENSE)。再分发时请保留许可证和适用的 [NOTICE](NOTICE) 声明；第三方依赖仍适用各自的许可证。

如果你用 AIGC Hub 搭了自己的站，欢迎在「关于」页注明「基于 [AIGC Hub](https://github.com/makur6371/aigc-hub)」。这是一项建议。
