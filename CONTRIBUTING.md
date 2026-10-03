# Contributing

[README](README.md) · [中文说明](#中文说明)

Contributions that improve mobile interaction, reliability, portability, or documentation are welcome. Describe the concrete user problem and keep changes focused.

## Local workflow

1. Fork or clone the repository and create a branch for your change.
2. Prepare the supported Xpra runtime and Node.js 20+ as described in [Development](docs/development.md).
3. Keep personal settings in the user configuration file and credentials/profile data outside the checkout.
4. Add a behavioral regression check when changing launch, supervision, authentication, input, or rendering behavior.
5. Run `./scripts/check.sh`. For deployment/transport changes, also run `python3 test_integration.py` with Xterm installed. For app-specific changes, verify a compatible app and real mobile browser.
6. Submit a pull request describing the problem, resulting behavior, verification performed, and any known limitations.

Shell scripts use Bash with `set -euo pipefail`. Python checks use the standard library and installed Xpra modules. Frontend changes should keep working without a Node build step. Do not edit or copy generated state/HTML5 assets into the repository.

Update both README languages and the corresponding English/Chinese guides when behavior or configuration changes. Document any new dependency or compatibility requirement. Use concise commit messages that describe the resulting change.

## Bug reports

Use the [issue template](https://github.com/shenmuegit/codex-console/issues/new/choose). Include reproduction steps, expected/actual behavior, OS/architecture, app/Xpra/HTML5/browser versions, and relevant redacted errors. A minimal reproduction is more useful than an unfiltered log dump.

Security-sensitive reports should follow [SECURITY.md](SECURITY.md).

## 中文说明

贡献前请先说明具体使用问题，保持改动集中。准备运行依赖和 Node.js 20+ 后执行 `./scripts/check.sh`；部署或传输链路改动还应安装 Xterm 并执行 `python3 test_integration.py`，应用相关改动需在兼容应用和真实手机浏览器中验证。

配置、账号数据和密码保存在仓库之外。行为变化需要更新对应的中英文文档。提交 PR 时说明解决的问题、最终行为、验证结果和已知限制。反馈普通问题请使用 issue 模板，并删除私人信息；敏感漏洞按安全说明处理。
