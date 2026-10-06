# 部署与维护

[English](../deployment.md) · [返回首页](../../README.zh-CN.md) · [配置参考](configuration.md)

以下命令均从项目目录中使用 Bash、以普通用户执行。请先安装兼容的桌面应用。自动安装系统依赖支持 Debian 12/13、Ubuntu 22.04/24.04；最小化系统需要提前准备普通用户账号、Bash、Git 和 sudo。其他 Linux 系统可以手动准备运行依赖后使用 `--skip-deps`。

## 桌面应用兼容性

默认应用路径为 `/usr/bin/chatgpt`，当前集成依赖以下行为：

- 应用可以通过 `--ozone-platform=x11` 在 X11 中运行。
- 支持独立的 `--user-data-dir` 或 `CODEX_ELECTRON_USER_DATA_PATH`。
- `WM_CLASS` 为 `"chatgpt (<profile 的绝对路径>)", "Chatgpt"`。
- 对同一个数据目录再次运行可执行文件，可以重新打开主窗口。
- 启动脚本须通过 `exec` 保留进程归属；上传使用应用进程内的 GTK 文件选择框。控制台会添加 `--xdg-portal-required-version=999`，让 Electron 回退到原生选择框。

可执行文件路径允许修改，手机布局与应用恢复依赖上述主窗口身份，窗口过滤通过 XRes 匹配监控进程的应用子进程。其他类名的应用需要同步修改主窗口检测和页面实例元数据，仅替换路径不能实现任意应用兼容。主机架构也需要满足桌面应用安装包的要求。

请从可信来源提前安装桌面应用。本仓库不内置该应用，不替它提供许可证，也不自动登录账号。

## 一键安装

```bash
git clone https://github.com/shenmuegit/codex-console.git
cd codex-console
./deploy.sh
```

应用位于其他目录时：

```bash
./deploy.sh --app /absolute/path/to/chatgpt
```

不要给整个脚本加 sudo：服务与数据应属于你的普通用户。需要安装系统包时，脚本会单独调用 sudo。应用不存在时，会在安装系统包之前给出提示并退出。

### 脚本修改哪些内容

1. 配置不存在时，在 `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` 创建权限为 `600` 的配置文件；显式传入 `--app` 时只更新应用路径设置。
2. 检查已有依赖；缺失或不兼容时在支持的 APT 系统上安装。通过 HTTPS 下载官方软件源定义与签名公钥，保留已有公钥和软件源；没有 Xpra 源时添加 `codex-console-xpra.sources`。
3. 运行 `doctor`，准备私有数据目录、访问凭据和浏览器资源，保留已有配置、密码和应用数据；仅在未配置 TLS 时清理旧证书。
4. 在 `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codex-console.service` 生成用户服务，使用真实克隆目录、配置路径和状态目录环境。按绝对路径注册，使用户服务管理器也能找到自定义配置目录。服务运行期间请保留项目和配置目录。
5. 启用并启动服务；已在运行的服务会重启。尝试启用用户 lingering，使服务可在登录前启动；系统拒绝时，会打印所需的管理员命令。
6. 最多等待 30 秒检查本机 HTTP 或已配置的 HTTPS 登录页面是否就绪。页面就绪说明访问入口已启动，账号登录和手机操作仍需要在浏览器中完成。参见 [TLS 配置](configuration.md#http-与-https-访问)。

安装的依赖包括 Xpra、`xpra-html5`、Xvfb、X11 工具、Xauth、PulseAudio、D-Bus、Python、OpenSSL、GStreamer 工具与插件，以及拉丁字母和中日韩字体。即使系统默认不安装推荐包，脚本也会明确安装 Xpra 推荐的 X11 与音频子包；预检查会验证对应模块和浏览器音频编码器。软件源配置遵循 [Xpra 官方 APT 安装说明](https://github.com/Xpra-org/xpra/wiki/Download#debian-based-distributions)。

脚本不会覆盖已有的不兼容软件源；若 APT 一直选择旧版本，请检查现有源或手动安装支持的版本。Ubuntu 最小化安装若缺少多媒体依赖，可能需要启用 `universe`，参见官方说明。

### 脚本参数

| 命令或参数 | 作用 |
| --- | --- |
| `./deploy.sh` 或 `./deploy.sh install` | 完整安装并启动 |
| `--app PATH` | 保存兼容桌面应用的可执行文件路径 |
| `--skip-deps` | 跳过 APT 操作，仍检查运行依赖 |
| `--no-service` | 手动管理，不生成用户服务，不修改 lingering |
| `--no-start` | 只准备文件，不启动或重启；生成的服务仍会启用 |
| `./deploy.sh uninstall` | 禁用、停止并移除生成的用户服务，保留数据 |
| `--help` | 显示用法 |

参数可以组合。只准备手动运行环境：

```bash
./deploy.sh --skip-deps --no-service --no-start
./console.sh doctor
./console.sh start
```

准备阶段会重新生成浏览器资源。如果会话已经运行，`--no-start` 保留其进程；启动参数的修改需要之后重启才能生效。

## 手动准备依赖

对于其他系统，按照 [Xpra 官方指南](https://github.com/Xpra-org/xpra/wiki/Download)安装服务端与 HTML5 客户端，并准备前文列出的运行工具。Xpra 版本须至少为 6.5 且小于 7.0。已验证组合为 Xpra `6.5.4` 与 `xpra-html5 19-r1`，预检查还会验证必要的页面接口。

```bash
./deploy.sh --skip-deps --no-service --no-start --app /absolute/path/to/chatgpt
./console.sh doctor
./console.sh start
./console.sh status
```

`start` 在后台启动，`run` 保持前台运行，便于排查问题或交给其他进程管理器。`stop` 停止配置指定的 Xpra 会话及其子进程。安装了用户服务后，使用 `systemctl --user` 管理，避免同一显示号同时由服务和手动命令启动。

## 用户服务与开机启动

```bash
systemctl --user status codex-console.service
systemctl --user restart codex-console.service
systemctl --user stop codex-console.service
systemctl --user disable codex-console.service
journalctl --user -u codex-console.service -n 100 --no-pager
```

服务以前台模式托管 Xpra，进程退出后自动重启。应用监控会重新打开缺失的主窗口，因此关闭窗口不会停止服务；维护时应停止服务。

检查是否启用开机启动：

```bash
systemctl --user is-enabled codex-console.service
loginctl show-user "$(id -un)" -p Linger
```

需要在用户登录前启动时：

```bash
sudo loginctl enable-linger "$(id -un)"
```

使用 `--no-start` 后，可执行 `systemctl --user start codex-console.service` 启动已准备好的服务。仓库中的 `.service` 是模板，需要部署脚本生成实际文件，请不要直接复制。

## 更新与移动项目

先备份数据。在没有本地未提交改动的项目目录中：

```bash
git pull --ff-only
./deploy.sh --skip-deps
```

需要安装或更新运行依赖时，执行不带 `--skip-deps` 的 `./deploy.sh`。Git 报告本地改动或历史分叉时，先解决再更新；脚本不会重置仓库。建议保持已验证的 Xpra 与 HTML5 版本，依赖升级前执行[开发说明](../development.md)中的检查。

移动目录前先停止服务，移动后从新目录重新部署。脚本会刷新服务路径和资源链接，保留应用数据。回退时先停止服务，在干净的工作区检出曾验证的提交或标签，再重新部署。

## 备份与恢复

备份包含访问凭据与账号数据，请私密保存。先停止服务，再加载脚本使用的配置：

```bash
systemctl --user stop codex-console.service
source ./lib/config.sh
console_load_config
console_validate_config
backup_dir="$HOME/codex-console-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup_dir"
umask 077
cp "$CONSOLE_CONFIG" "$backup_dir/config.sh"
tar -C "$CONSOLE_STATE_DIR" --exclude='./pulse-runtime' -czf "$backup_dir/state.tar.gz" .
systemctl --user start codex-console.service
```

手动运行时，分别使用 `./console.sh stop` 和 `./console.sh start`。恢复到已准备好依赖的主机时，将 `backup_dir` 设为保存的目录，把配置复制到实际配置位置，调整新主机的应用和数据路径，再按上面的方式加载配置。在服务停止的状态下，将 `state.tar.gz` 解压到 `CONSOLE_STATE_DIR`。仅恢复可信的自有备份；将数据目录设为 `700`，密码文件设为 `600`，然后执行 `./deploy.sh --skip-deps` 重建资源与服务。

完整恢复需要保留 `profile/` 和 `password`。配置的 TLS 证书、私钥及续期设置若保存在该目录外，需要单独备份。生成的 `www/`、锁文件、音频运行文件与日志可以重新创建。

## 卸载

```bash
./deploy.sh uninstall
```

卸载时使用与安装时相同的 `XDG_CONFIG_HOME`。此命令移除生成的用户服务及其注册链接，保留配置、应用数据、仓库、系统依赖、Xpra 软件源与 lingering。手动启动的会话需要执行 `./console.sh stop`。

确认备份后，可自行删除实际配置目录、数据目录及仓库。其他用户服务可能依赖 lingering，不要直接禁用。系统依赖也可能由其他应用共用，仅在确定不再需要时通过包管理器移除。
