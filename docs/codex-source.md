# Official Codex source checkout

[中文](zh-CN/codex-source.md) · [Development](development.md)

The local `codex/` directory contains the official
[`openai/codex`](https://github.com/openai/codex) source for investigation.
The root `.gitignore` excludes `/codex/`, including its nested Git repository.

From the Codex Console repository root, reproduce the checkout with:

```bash
git clone --depth 1 https://github.com/openai/codex.git codex
git -C codex rev-parse HEAD
git check-ignore -v codex/ codex/README.md
```

The checkout created on 2026-10-07 is on `main` at
`ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`. It is a shallow clone;
`git -C codex fetch --unshallow` retrieves its history if needed.

Only the ignore rule and documentation belong in Codex Console commits.
The source checkout is independent of the installed Codex executable and the
desktop application used by the console.
