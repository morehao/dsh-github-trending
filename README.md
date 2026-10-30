# dsh-github-trending

> GitHub 趋势日报插件：每天抓取 GitHub Trending，生成中文简介与当日总结，写进你自己的仓库，并自动提交与合并 PR。

**状态：脚手架（0.0.1）。** 包结构、构建与发布链路已就绪，业务功能按设计文档分阶段实现。

## 它做什么

- 每天定时抓取 `github.com/trending`（全语言 + 你指定的语言）
- 用宿主已配置的模型生成每个仓库的中文简介与当日总结
- 写入你指定的本地仓库，建 `trending/YYYY-MM-DD` 分支，提交、创建 PR 并按配置自动合并
- 认证优先「打开网页输码」的 OAuth Device Flow，也支持 PAT 与本机 `gh` 凭据

## 安装

```bash
dsh plugin --profile <profile> add @morehao/dsh-github-trending
```

装完重启宿主。

## 开发

```bash
npm install
npm run build
```

## 许可

MIT
