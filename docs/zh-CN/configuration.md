# 配置参考

[English](../configuration.md) · [返回首页](../../README.zh-CN.md) · [部署与维护](deployment.md)

## 配置文件

首次部署会将 [config.example.sh](../../config.example.sh) 复制到 `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh`。配置文件属于你的用户，保存在 Git 仓库之外。使用文本编辑器修改它即可，日常配置无需改动启动脚本。

可用 `CONSOLE_CONFIG` 环境变量选择其他配置文件，路径必须为**绝对路径**：

```bash
CONSOLE_CONFIG="$HOME/.config/codex-console/lab.sh" ./deploy.sh --skip-deps
CONSOLE_CONFIG="$HOME/.config/codex-console/lab.sh" ./console.sh doctor
```

可以提前创建自定义配置，也可以让部署脚本创建。`console.sh` 显式选择的配置不存在时会报错；未指定路径且默认配置不存在时，则使用内置默认值。

配置文件中的赋值优先于环境变量；配置未赋值的项使用环境变量，最后使用内置默认值。`CONSOLE_APP_ARGS` 必须使用 Bash 数组，不能用一段环境变量字符串替代。配置按 Bash 脚本加载，只使用可信文件。配置路径、数据路径及 HTML5 路径必须为绝对路径，不能含逗号或换行。

修改后先检查，再重启：

```bash
./console.sh doctor
systemctl --user restart codex-console.service
```

手动运行时停止后再启动。保留原数据目录可以继续使用已保存的登录信息。若要修改手动会话的显示号，请先使用旧配置停止会话。

## 全部配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `CONSOLE_APP_BIN` | `/usr/bin/chatgpt` | 兼容应用的可执行文件，建议使用绝对路径 |
| `CONSOLE_APP_ARGS` | `(--ozone-platform=x11 --disable-gpu)` | 额外应用参数，使用 Bash 数组 |
| `CONSOLE_HOST` | `0.0.0.0` | 浏览器访问监听的 IPv4 地址或主机名 |
| `CONSOLE_PORT` | `15443` | TCP 端口，整数 `1024`–`65535` |
| `CONSOLE_DISPLAY` | `:100` | 专用 X11 显示号，不能与已有会话冲突 |
| `CONSOLE_STATE_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/codex-console` | 密码、应用数据、页面与日志目录 |
| `XPRA_HTML_DIR` | `/usr/share/xpra/www` | 系统安装的 Xpra HTML5 资源目录 |
| `CONSOLE_TLS_CERT` | 空 | 可读 PEM 证书或完整证书链的绝对路径；与私钥一起启用 HTTPS/WSS |
| `CONSOLE_TLS_KEY` | 空 | 对应 PEM 私钥的可读绝对路径 |
| `CONSOLE_CONFIG` | `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` | 用于选择配置文件的入口环境变量 |

`0.0.0.0` 监听所有 IPv4 网卡；仅本机访问可设为 `127.0.0.1`，也可以绑定实际局域网网卡地址。当前监听配置不接受 IPv6 绑定地址。

部署时会把配置路径与 `XDG_STATE_HOME` 保存到用户服务中。持续使用的设置应写进配置文件；终端里临时设置的环境变量不会自动传入用户服务。

示例：

```bash
CONSOLE_APP_BIN='/opt/desktop app/chatgpt'
CONSOLE_APP_ARGS=(--ozone-platform=x11 --disable-gpu)
CONSOLE_HOST=192.0.2.10
CONSOLE_PORT=15443
CONSOLE_DISPLAY=:100
```

将文档示例地址 `192.0.2.10` 替换为主机实际地址。脚本会自动添加 `--user-data-dir=<数据目录>/profile`。除非兼容应用通过其他方式选择 X11，请保留 X11 参数。每个参数作为独立数组元素，不要把所有参数拼成一个元素，也不要插入 shell 命令。

如需设置代理，请在用户配置文件的 `CONSOLE_APP_ARGS` 中，或在桌面应用自身的网络设置中配置。

## 数据目录

| 数据目录中的路径 | 内容 |
| --- | --- |
| `password` | 随机生成的浏览器访问密码 |
| `profile/` | 应用设置、登录信息和会话数据 |
| `www/` | 生成的 HTML5 入口、适配后的脚本和资源链接 |
| `xpra.log` | Xpra 会话日志 |
| `app-watch.lock` | 防止重复应用监控进程的锁文件 |
| `pulse-runtime/` | 独立 PulseAudio 运行与进程文件，启动时可重建 |

数据目录权限为 `700`，密码文件权限为 `600`。脚本将 `CODEX_ELECTRON_USER_DATA_PATH=<数据目录>/profile` 传给应用。浏览器访问密码仅在当前页面内存中保留以供重连；刷新或关闭后需要重新输入。

不同数据目录对应不同应用配置。运行多个实例时，配置路径、数据目录、端口和显示号都必须独立。部署脚本每个用户只管理一个 `codex-console.service`；多个实例需要自行命名服务，或使用手动运行模式。

## HTTP 与 HTTPS 访问

默认使用配置的主机地址和端口打开 `http://HOST_IP:15443/`。页面通过 HTTP 加载，密码认证后的会话通过 WS 连接。准备阶段仅在此默认模式下删除旧的 `cert.pem` 和 `key.pem`，保留访问密码和应用数据。

HTTP 不提供传输加密，请通过可信网络或 VPN 访问。

在配置文件中填写以下两项，即可复用 Xpra 的原生 HTTPS/WSS，在同一端口提供服务：

```bash
CONSOLE_TLS_CERT=/absolute/path/to/fullchain.pem
CONSOLE_TLS_KEY=/absolute/path/to/privkey.pem
```

证书需被浏览器信任并匹配访问的主机名，私钥应私密保存。重启服务后打开 `https://YOUR_HOSTNAME:15443/`，HTTP/WS 将替换为 HTTPS/WSS。启动器保留配置的证书，不会自动生成证书；路径不能含逗号或换行。

支持的 HTML5 客户端中，[Chrome 的离屏视频解码路径](https://github.com/Xpra-org/xpra-html5/blob/master/html5/js/OffscreenDecodeWorkerHelper.js)需要 HTTPS。最终解码器仍取决于浏览器的编码支持；HTTPS 本身不保证 H.264 或硬件加速，Safari 仍可能使用回退路径。

### 公网 IP 证书

Let’s Encrypt 支持使用 `shortlived` 配置签发[公网 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)，需使用 Certbot 5.4 或更新版本。即使控制台运行在 15443 端口，HTTP-01 验证仍必须通过公网 TCP **80** 端口访问这台服务器；改变 Certbot 的本地验证端口不会改变 CA 访问的端口。

独立签发命令，账号和证书文件保存在仓库外的私有目录：

```bash
certbot certonly --standalone --ip-address YOUR_PUBLIC_IP \
  --cert-name codex-console --required-profile shortlived \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --keep-until-expiring \
  --config-dir "$HOME/.local/state/codex-console/tls/acme" \
  --work-dir "$HOME/.local/state/codex-console/tls/work" \
  --logs-dir "$HOME/.local/state/codex-console/tls/logs"
```

监听 80 端口需要管理员协助。可通过 systemd **系统服务**以控制台用户运行 Certbot，并设置 `AmbientCapabilities=CAP_NET_BIND_SERVICE`、`CapabilityBoundingSet=CAP_NET_BIND_SERVICE` 和 `UMask=0077`。这样控制台用户可读取证书，应用仍由普通用户运行。证书目录权限设为 `700`，私钥设为 `600`。

签发成功后，将两个 TLS 路径分别设为私有状态目录下的 `tls/acme/live/codex-console/fullchain.pem` 和 `privkey.pem`，然后重启用户服务。执行 `openssl verify -verify_ip YOUR_PUBLIC_IP -untrusted fullchain.pem fullchain.pem` 验证信任链与 IP SAN，并在不关闭证书验证的情况下检查 `https://YOUR_PUBLIC_IP:15443/`。

IP 证书有效期约六天。通过持久化系统定时器每八小时执行一次上述 `--keep-until-expiring` 命令（`OnCalendar=*-*-* 00,08,16:00:00`）。使用签发成功后的 deploy hook 重启 `codex-console.service`，并为该用户的服务管理器设置 `XDG_RUNTIME_DIR=/run/user/UID` 和 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/UID/bus`。绑定或验证失败时保留原控制台配置，查看证书服务日志，再启用 HTTPS。证书续期和启用均验证成功后才能报告部署完成。

## 访问密码

执行 `./console.sh password` 查看。更换密码时，停止会话并写入新的随机值：

```bash
source ./lib/config.sh
console_load_config
console_validate_config
systemctl --user stop codex-console.service
umask 077
openssl rand -hex 24 | tr -d '\n' > "$CONSOLE_STATE_DIR/password"
chmod 600 "$CONSOLE_STATE_DIR/password"
systemctl --user start codex-console.service
```

使用新密码重新连接。重启会断开旧连接。不要将访问密码放进 URL 或公开日志；这个密码只管理浏览器访问，不会修改桌面应用账号密码。
