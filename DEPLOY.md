# 部署到 GitHub / Render

## 先说重点

GitHub Pages 只能放静态网页，不能安全保存 OpenAI API Key。

这个 MVP 有后端，所以推荐：

```text
GitHub 存代码
Render / Railway / Fly.io 运行服务
```

## 上传到 GitHub

在 `native-ad-cover-mvp` 文件夹里运行：

```bash
git init
git add .
git commit -m "Initial native ad cover MVP"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

确认不要上传：

```text
.env
API set.env
public/generated/
memory/*.json
*.log
```

这些文件已写入 `.gitignore`。

## 部署到 Render

方式一：直接用 `render.yaml`

1. 把代码上传到 GitHub。
2. 打开 Render，选择 `New Blueprint`。
3. 连接这个 GitHub 仓库。
4. Render 会读取 `render.yaml`。
5. 直接部署。默认由每个用户在网页里填写自己的 OpenAI API Key。

方式二：手动建 `Web Service`

1. 打开 Render，新建 `Web Service`。
2. 连接你的 GitHub 仓库。
3. 设置：

```text
Build Command: npm install
Start Command: npm start
```

4. 添加环境变量：

```text
TEXT_MODEL=gpt-5
IMAGE_MODEL=gpt-image-2
IMAGE_SIZE=auto
```

5. 部署完成后打开 Render 提供的网址。

如果你想让服务器统一承担费用，可以额外添加 `OPENAI_API_KEY`。如果你想让每个人使用自己的 Key，不要添加 `OPENAI_API_KEY`。

## 本地测试

```bash
npm run check
npm start
```

浏览器打开：

```text
http://localhost:8787
```
