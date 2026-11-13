# 部署 AIGC Hub

[返回项目首页](../README.md)

## Docker Compose

先把 `.env.example` 复制为 `.env`。按 [快速体验的配置表](../README.md#快速体验) 填写随机密钥、初始化邮箱和密码。正式实例保留 `APP_ENABLE_DEMO=0`，并把 `NEXT_PUBLIC_APP_URL` 设为浏览器访问的站点地址（只填协议、域名和可选端口）。

```sh
docker compose build
docker compose run --rm hub npm run db:setup
docker compose up -d
```

Compose 默认把应用绑定到宿主机的 `127.0.0.1:3000`。在同一台机器上用 HTTP 试跑时，可设置 `APP_ALLOW_INSECURE_HTTP=1`；对外访问请用 HTTPS 反向代理，并保持该选项为 `0`。改变 `NEXT_PUBLIC_APP_URL` 后重新构建镜像。数据库和上传文件都在 `hub-data` 持久卷中，升级前请备份该卷。

设置好后，用初始化的邮箱和密码登录。可从 `.env` 移除初始化邮箱和密码；保留 `JWT_SECRET`。重复初始化不会重置现有密码。要创建普通账号，可另行向初始化命令提供新邮箱和密码并加 `--user`。

## 接入真实模型

在「系统设置 → 供应商与模型」填写接口地址、凭据和模型名称。先用单个模型验证，再配置备用模型和用量。第三方适配器和自定义节点代码默认禁用；只有实例所有者信任代码时才应启用 `APP_ENABLE_TRUSTED_CODE=1`，这些代码与应用共享进程权限。

素材链接可能会交给生成服务；得到链接的人可以读取对应素材。请根据部署范围决定是否允许用户上传敏感内容。

## 关于 Vercel

当前版将 SQLite 和素材保存到磁盘，需要持久存储。Vercel 能识别并导入 Next.js 项目，但不是完整实例的一键部署方式。要支持这种部署，需先为数据库和素材接入持久服务，再验证异步任务。见 [Vercel 的 SQLite 说明](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)。
