# Docker 部署说明

这个 fork 增加了一个无头运行器：每天定时读取 Follow Builders feed，用 SiliconFlow Chat Completions 生成中文日报，并通过企业微信群机器人 webhook 推送。

## 本地运行

复制 `.env.example` 为 `.env`，填入以下值：

```bash
SILICONFLOW_API_KEY=...
WECOM_WEBHOOK_URL=...
```

常用命令：

```bash
cd scripts && npm ci
npm run healthcheck
npm run run-once
docker compose up -d --build
```

## 环境变量

- `SILICONFLOW_API_KEY`: SiliconFlow API key，必填。
- `SILICONFLOW_MODEL`: 默认 `deepseek-ai/DeepSeek-V4-Flash`。
- `WECOM_WEBHOOK_URL`: 企业微信群机器人 webhook，必填。
- `DIGEST_TIME`: 每日推送时间，默认 `08:30`，容器时区为 `Asia/Shanghai`。
- `FEED_BASE_URL`: feed 根地址，默认在 `docker-compose.yml` 中指向原作者 central feed，避免 fork 缺少 X / pod2txt 抓取密钥后内容不更新。
- `PROMPTS_BASE_URL`: prompts 根地址，默认指向当前 fork 的 `prompts` 目录。

## GitHub Actions 自动部署

`.github/workflows/deploy.yml` 会在 push 到 `main` / `master` 后：

1. 同步代码到服务器 `/www/wwwroot/follow-builders`
2. 在服务器写入运行所需 `.env`
3. 执行 `docker compose up -d --build`

需要配置 GitHub Secrets：

- `SERVER_HOST`
- `SERVER_USER`
- `SSH_PORT`
- `SSH_PRIVATE_KEY`
- `SILICONFLOW_API_KEY`
- `WECOM_WEBHOOK_URL`

`upstream` remote 保留为原作者仓库，后续同步作者更新：

```bash
git fetch upstream
git merge upstream/main
```
