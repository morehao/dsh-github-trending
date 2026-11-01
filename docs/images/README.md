# README 截图目录

README 从本目录引用以下图片（已就位，深色主题，2320×1514 PNG = 内容区 1160×757@2x，已裁掉宿主左侧栏）：

- `overview.png` — 概览页
- `digest.png` — 榜单页
- `runs.png` — 运行记录页
- `settings.png` — 设置页
- `subscriptions.png` — 订阅页
- （可选，未提供）`about.png` — 关于弹层

## 来源与生成方式

- 取自**真实运行的 0.7.9 插件**：另起 `dsh --profile web`（同一 `$DSH_HOME` 真实数据，装
  `@morehao/dsh-github-trending@0.7.9`），用 headless Chrome（1440×900、`--force-device-scale-factor=2`）
  打开它打印的带 token URL，进入「GitHub 趋势」面板。
- 截图由 **REA `capture-web-screenshot`** 抓取 viewport；每视图先在 DOM 里把本机绝对路径
  （`/Users/...`）脱敏为 `~/...`，再截图；随后用 `sips` 裁掉左侧宿主侧栏（0–280 CSS px），
  只保留插件面板区域，避免暴露工作区列表 / 会话 / 个人账号。
- 复现脚本见 `.dsh/tmp/real-capture.sh`。截图要求见 `.dsh/docs/notes/2026-11-01-readme-screenshots-shotlist.md`。
