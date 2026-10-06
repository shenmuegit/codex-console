# Codex 官方源码目录

[English](../codex-source.md) · [开发说明](../development.md)

本地 `codex/` 目录保存官方
[`openai/codex`](https://github.com/openai/codex) 源码，用于研究。
根目录 `.gitignore` 的 `/codex/` 规则忽略整个目录及其独立 Git 仓库。

在 Codex Console 仓库根目录执行以下命令可复现：

```bash
git clone --depth 1 https://github.com/openai/codex.git codex
git -C codex rev-parse HEAD
git check-ignore -v codex/ codex/README.md
```

2026-10-07 创建的源码目录位于 `main` 分支，提交为
`ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`。这是浅克隆；需要历史时可执行
`git -C codex fetch --unshallow`。

Codex Console 只提交忽略规则和说明文档。源码目录与本机已安装的 Codex
可执行文件、控制台使用的桌面应用分别独立。
