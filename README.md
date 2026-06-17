# 原生广告封面生成 MVP

这是一个本地可运行的原生广告封面生成小系统。

它会按三段 Agent 流程工作：

1. 策略理解 Agent：理解 `appName + adCopy`
2. 封面生成 Agent：生成主标题和图片 Prompt
3. 质检回流 Agent：检查图片是否像内容封面，而不是硬广

## 功能

- 单条广告生成封面
- CSV 批量导入广告任务
- 生成横版 16:9 原生广告封面
- 自动质检评分
- 单张图片下载
- 批量结果选择文件夹保存全部图片
- 人工标记 selected / rejected / edited / shortlisted
- 本地记忆：人工偏好、失败模式、平台结果
- 预留投放结果回流接口

## 本地运行

1. 安装 Node.js 20 或更高版本。

2. 可选：复制环境变量文件。

如果你希望每个用户在网页里填写自己的 API Key，可以跳过这一步。

如果你希望服务器统一使用一个备用 Key，再复制：

```powershell
copy .env.example .env
```

3. 可选：打开 `.env`，填写服务器备用 OpenAI API Key：

```text
OPENAI_API_KEY=你的_api_key
TEXT_MODEL=gpt-5
IMAGE_MODEL=gpt-image-2
IMAGE_SIZE=auto
PORT=8787
```

4. 启动：

```powershell
.\start.ps1
```

或：

```bash
npm start
```

5. 打开：

```text
http://localhost:8787
```

如果 `8787` 已经被占用，程序会自动尝试 `8788`、`8789` 等后续端口。

## CSV 批量导入

页面顶部可以上传 CSV 表格。字段名请保持：

```text
appName,adCopy,platform,industry,targetAudience,forbiddenItems,count,visualPreference
```

示例文件：

```text
native_ad_cover_4_ads_import.csv
```

批量生成过程中，成功的图片会立即显示并保留；如果后续某条失败，前面已经生成的图片仍然可以下载。

生成结果里可以：

- 点击单张图片旁边的“下载图片”
- 点击“选择文件夹保存全部图片”，把所有已生成图片保存到本地文件夹

## API

```text
GET  /api/health
GET  /api/config
GET  /api/memory
POST /api/generate
POST /api/feedback
POST /api/platform-result
```

## GitHub 注意事项

不要上传这些文件：

- `.env`
- `API set.env`
- `public/generated/`
- `memory/*.json`
- `*.log`

这些已经写在 `.gitignore` 里。API Key 只应该放在本地 `.env` 或部署平台的环境变量里。

## 部署说明

这个项目不能直接部署到 GitHub Pages，因为它需要 Node.js 后端来保护 API Key。

推荐方式：

- GitHub 存代码
- Render / Railway / Fly.io / 服务器 运行 Node.js 服务

部署到 Render 的基本配置：

```text
Build Command: npm install
Start Command: npm start
Environment:
  TEXT_MODEL=gpt-5
  IMAGE_MODEL=gpt-image-2
  IMAGE_SIZE=auto
  PORT=10000
```

部署后访问平台给你的网址即可。默认情况下，每个用户在页面顶部填写自己的 OpenAI API Key；这个 Key 只保存在用户自己的浏览器里，不会上传到 GitHub。

## 给别人使用

把 GitHub 仓库地址发给对方。对方 clone 后：

1. 安装 Node.js
2. 复制 `.env.example` 为 `.env`
3. 运行 `npm start`
4. 打开本地地址
5. 在页面顶部填自己的 OpenAI API Key

不要把你的 `.env` 发给别人。
