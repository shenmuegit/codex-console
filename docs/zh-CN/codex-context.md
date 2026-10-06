# Codex 上下文窗口

[English](../codex-context.md) · [配置参考](configuration.md)

模型上下文窗口属于 Codex 自身的设置，保存在 `${CODEX_HOME:-$HOME/.codex}/config.toml`，与控制台的 `config.sh` 分开。实际配置及其备份均应保存在本仓库之外。

## 配置更大的窗口

1. 在 Git 仓库外备份已有的 Codex 配置。
2. 使用 `codex debug models` 检查所选模型的 `context_window`、`max_context_window` 和 `effective_context_window_percent`。允许的最大值可能因模型和账号而异。
3. 模型目录允许 `max_context_window = 872000` 时，在 `config.toml` 顶层、所有 `[section]` 标题之前添加或更新：

   ```toml
   model_context_window = 872000
   ```

4. 保持 `model_auto_compact_token_limit` 未设置，使用模型默认值。本配置使用默认 90% 上限，即 784,800 tokens；实际触发时点还取决于上下文计数方式。保留已有的模型选择与其他设置。
5. 重启 Codex，新建任务并发送一条简短消息，再检查上下文指示器。CLI 中可使用 `/status`。

有效窗口比例为 95% 时，预期可用上下文为 `872000 × 95% = 828400`，界面约显示 **828k**。模型目录最大值为 872,000 时，即使填写 `model_context_window = 1000000`，也会缩减至 872,000。参见[社区配置指南](https://soju06.github.io/codex-lb/client-setup/#opting-into-the-872k-context-window)、[Codex 配置覆盖实现](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/model_info.rs)和[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

配置窗口大小不能证明每个后端均支持接近上限的请求；应在实际运行一轮后核实有效值。恢复模型默认窗口时，仅删除本次添加的 `model_context_window` 配置，再重启 Codex。

## 验证记录

2026-10-06，本机 GPT-6.1 Sol 模型目录的默认窗口为 272,000 tokens，最大窗口为 872,000 tokens，有效比例为 95%，未指定自动压缩阈值。私有用户配置仅添加了 `model_context_window = 872000`。

TOML 解析检查通过，桌面客户端自带的 Codex 0.159.2 引擎通过 `config/read` 返回 872,000。临时只读验证会话完成一轮并按要求回复 `OK`，`thread/tokenUsage/updated.tokenUsage.modelContextWindow` 返回 828400。此检查核实引擎加载后的预算，未填满窗口，也未打断已有的桌面任务。更换模型或配置后，应重复上面的新任务检查。
