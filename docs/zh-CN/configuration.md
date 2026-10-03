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
| `CONSOLE_HOST` | `0.0.0.0` | HTTPS/WSS 监听的 IPv4 地址或主机名 |
| `CONSOLE_PORT` | `15443` | TCP 端口，整数 `1024`–`65535` |
| `CONSOLE_DISPLAY` | `:100` | 专用 X11 显示号，不能与已有会话冲突 |
| `CONSOLE_STATE_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/codex-console` | 密码、证书、应用数据、页面与日志目录 |
| `XPRA_HTML_DIR` | `/usr/share/xpra/www` | 系统安装的 Xpra HTML5 资源目录 |
| `CONSOLE_TLS_NAME` | `localhost` | 新生成证书加入的域名或 IP 地址 |
| `CONSOLE_CONFIG` | `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` | 用于选择配置文件的入口环境变量 |

`0.0.0.0` 监听所有 IPv4 网卡；仅本机访问可设为 `127.0.0.1`，也可以绑定实际局域网网卡地址。当前监听配置不接受 IPv6 绑定地址。证书可以包含 IPv6 地址，但这不会启用 IPv6 监听。

部署时会把配置路径与 `XDG_STATE_HOME` 保存到用户服务中。持续使用的设置应写进配置文件；终端里临时设置的环境变量不会自动传入用户服务。

示例：

```bash
CONSOLE_APP_BIN='/opt/desktop app/chatgpt'
CONSOLE_APP_ARGS=(--ozone-platform=x11 --disable-gpu)
CONSOLE_HOST=192.0.2.10
CONSOLE_PORT=15443
CONSOLE_DISPLAY=:100
CONSOLE_TLS_NAME=192.0.2.10
```

将文档示例地址 `192.0.2.10` 替换为主机实际地址。脚本会自动添加 `--user-data-dir=<数据目录>/profile`。除非兼容应用通过其他方式选择 X11，请保留 X11 参数。每个参数作为独立数组元素，不要把所有参数拼成一个元素，也不要插入 shell 命令。

如需设置代理，请在用户配置文件的 `CONSOLE_APP_ARGS` 中，或在桌面应用自身的网络设置中配置。

## 数据目录

| 数据目录中的路径 | 内容 |
| --- | --- |
| `password` | 随机生成的浏览器访问密码 |
| `cert.pem` / `key.pem` | TLS 证书与私钥 |
| `profile/` | 应用设置、登录信息和会话数据 |
| `www/` | 生成的 HTML5 入口、适配后的脚本和资源链接 |
| `xpra.log` | Xpra 会话日志 |
| `app-watch.lock` | 防止重复应用监控进程的锁文件 |
| `pulse-runtime/` | 独立 PulseAudio 运行与进程文件，启动时可重建 |

数据目录权限为 `700`，密码、证书与私钥文件权限为 `600`。脚本将 `CODEX_ELECTRON_USER_DATA_PATH=<数据目录>/profile` 传给应用。浏览器访问密码仅在当前页面内存中保留以供重连；刷新或关闭后需要重新输入。

不同数据目录对应不同应用配置。运行多个实例时，配置路径、数据目录、端口和显示号都必须独立。部署脚本每个用户只管理一个 `codex-console.service`；多个实例需要自行命名服务，或使用手动运行模式。

## TLS 证书

首次准备会生成 2048 位 RSA 自签名证书，有效期为 365 天。SAN 包含 `localhost`、`127.0.0.1` 和 `CONSOLE_TLS_NAME`。即使访问地址匹配，自签名证书仍需要浏览器信任。

第一次部署前设置 `CONSOLE_TLS_NAME`，可以将实际主机 IP 或域名加入证书。已有证书会复用，因此修改配置不会自动更新证书。

换用可信证书时，停止服务，将证书链与匹配的未加密私钥放到数据目录的 `cert.pem` 和 `key.pem`。加载配置后的示例：

```bash
source ./lib/config.sh
console_load_config
console_validate_config
systemctl --user stop codex-console.service
install -m 600 /path/to/fullchain.pem "$CONSOLE_STATE_DIR/cert.pem"
install -m 600 /path/to/privkey.pem "$CONSOLE_STATE_DIR/key.pem"
systemctl --user start codex-console.service
```

使用服务用户可读取的证书文件。可信证书的签发和续期需要另行管理；替换证书与私钥后重启服务。只存在一份非空证书或私钥时，准备步骤会报错，保留剩余文件。

更新自签名证书时，先停止服务，将**证书和私钥一起**移到私有备份目录，更新 `CONSOLE_TLS_NAME`，执行 `./console.sh prepare`，再启动服务。查看有效期与 SAN：

```bash
openssl x509 -in "$CONSOLE_STATE_DIR/cert.pem" -noout -dates -ext subjectAltName
```

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
