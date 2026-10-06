# Codex context window

[中文](zh-CN/codex-context.md) · [Configuration reference](configuration.md)

The model context window is a Codex setting in `${CODEX_HOME:-$HOME/.codex}/config.toml`, separate from the console's `config.sh`. Keep the actual configuration and its backup outside this repository.

## Configure a larger window

1. Back up the existing Codex configuration outside Git.
2. Inspect `codex debug models` for the selected model's `context_window`, `max_context_window`, and `effective_context_window_percent`. The allowed maximum can vary with the model and account.
3. For a model whose catalog allows `max_context_window = 872000`, add or update this assignment at the top level of `config.toml`, before any `[section]` header:

   ```toml
   model_context_window = 872000
   ```

4. Leave `model_auto_compact_token_limit` unset to use the model default. This configuration uses the default 90% ceiling, or 784,800 tokens; the actual trigger also depends on context accounting. Preserve the existing model selection and other settings.
5. Restart Codex, start a new task, and send a short message before checking the context indicator. In the CLI, use `/status`.

With a 95% effective-window factor, the expected usable context is `872000 × 95% = 828400`, displayed as approximately **828k**. A `model_context_window = 1000000` assignment still resolves to 872,000 when that is the catalog maximum. See the [community configuration guide](https://soju06.github.io/codex-lb/client-setup/#opting-into-the-872k-context-window), [Codex override implementation](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/model_info.rs), and [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Setting the window does not establish that near-limit requests are supported by every backend. Verify the effective value after a real turn. To restore the model's default window, remove only the `model_context_window` assignment added here and restart Codex.

## Verification record

On 2026-10-06, the local GPT-6.1 Sol catalog reported a 272,000-token default, an 872,000-token maximum, a 95% effective-window factor, and no explicit compaction threshold. The private user configuration was changed only by adding `model_context_window = 872000`.

TOML parsing passed, and the desktop-bundled Codex 0.159.2 engine returned 872,000 through `config/read`. A temporary, read-only verification turn completed with the requested `OK` response and reported `thread/tokenUsage/updated.tokenUsage.modelContextWindow = 828400`. This checked the loaded runtime budget without filling the window or interrupting existing desktop tasks. Repeat the new-task check above after changing the model or configuration.
