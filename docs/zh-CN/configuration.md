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

## 自动拥塞反馈

启动器启用 Xpra 的带宽检测，浏览器在认证握手中申请带宽管理模块。画面确认变慢时，服务器可降低窗口的带宽预算；拥塞缓解后预算可恢复。此机制与流畅、均衡、清晰档位分别生效，不设置固定的全局码率上限。

`XPRA_MIN_BANDWIDTH` 默认是每秒 `524288` 比特（约 0.52 Mbps），让 Xpra 的自动检测能低于上游默认的每秒 5 Mi 比特下限。需要覆盖时，可在私有 Bash 配置中设置 `XPRA_MIN_BANDWIDTH=1048576`，启动器会将其导出给 Xpra。更新启动器后重启服务，并刷新浏览器以使用新的握手。通过[客户端网络监控](troubleshooting.md#客户端网络监控)检查 RTT 和实际画面流量；自动反馈无法消除传播延迟或修复丢包。

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

### 仅使用 15443 端口的 HTTPS

Xpra 直接通过 `CONSOLE_PORT=15443` 提供 HTTPS 和 WSS，不需要反向代理或特权监听端口。针对公网 IP，Let's Encrypt 的 [HTTP-01 与 TLS-ALPN-01 验证](https://letsencrypt.org/docs/challenge-types/)分别需要入站 80 或 443 端口，DNS-01 无法验证 IP 地址。把本地验证端口改为 15443，不会改变 CA 的验证端口。

两个验证端口均不能使用时，可用本地 CA 签发证书，并在每台客户端设备上安装其公开证书。连接会加密，但浏览器需要完成安装后才会信任它。如果有可管理 DNS 的域名，也可以用 DNS-01 获得公开可信证书，无需开放两个验证端口，再通过该域名的 15443 端口访问。

本地 CA 只创建一次，文件保存在 Git 仓库外。将示例 IP 替换为实际访问的地址。以下命令用于新的证书目录；后续续期服务器证书时应保留原 CA 及其私钥。

```bash
umask 077
tls="${CONSOLE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-console}/tls/local"
public_ip=192.0.2.10
mkdir -p "$tls"
chmod 700 "$tls"
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
  -subj '/CN=Codex Console Local CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls/ca-key.pem" -out "$tls/ca.crt"
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=$public_ip" -keyout "$tls/server-key.pem" -out "$tls/server.csr"
cat > "$tls/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$public_ip
EOF
openssl x509 -req -sha256 -days 365 -in "$tls/server.csr" \
  -CA "$tls/ca.crt" -CAkey "$tls/ca-key.pem" -CAcreateserial \
  -extfile "$tls/server.ext" -out "$tls/server.crt"
cat "$tls/server.crt" "$tls/ca.crt" > "$tls/fullchain.pem"
openssl x509 -in "$tls/ca.crt" -outform DER -out "$tls/console-ca.cer"
openssl verify -CAfile "$tls/ca.crt" -verify_ip "$public_ip" "$tls/server.crt"
openssl x509 -in "$tls/ca.crt" -noout -sha256 -fingerprint
```

在私有配置中设置 `CONSOLE_PORT=15443`，将 `CONSOLE_TLS_CERT` 设为该目录的 `fullchain.pem`，`CONSOLE_TLS_KEY` 设为 `server-key.pem`，再执行 `./console.sh doctor` 并重启用户服务。使用 `curl --noproxy '*' --cacert "$tls/ca.crt"` 检查 `https://YOUR_PUBLIC_IP:15443/`，不要关闭证书验证。证书目录保持 `700`，私钥保持 `600`。

仅将 `console-ca.cer` 或 `ca.crt` 传到手机，并与服务器输出核对 SHA-256 指纹。iPhone/iPad 安装证书描述文件后，按 [Apple 的说明](https://support.apple.com/en-us/102390)，在“设置 → 通用 → 关于本机 → 证书信任设置”中开启完全信任。Android 在设备的证书/凭据设置中按 **CA 证书**导入，菜单名称因厂商而异。完成信任后重新打开 HTTPS 地址。仅绕过浏览器证书警告，不能证明视频解码器所需的安全上下文已启用。不要公开或传输任何私钥。

如需通过同一端口下载，仅将 `console-ca.cer` 复制到生成的状态目录下的 `www/`，即可通过 `https://YOUR_PUBLIC_IP:15443/console-ca.cer` 获取；现有资源准备过程会保留该文件。安装前应核对证书指纹。

服务器证书有效期为 365 天，CA 为十年。使用原 CSR、扩展配置与 CA 续期服务器证书，验证新证书的信任链和 IP SAN，再替换 `server.crt` 与 `fullchain.pem`，重启用户服务。无人值守安装可配置持久化的每日**用户定时器**，在有效期不足 30 天时续期（`openssl x509 -checkend 2592000 -noout -in server.crt`）。本地签名无需联网验证或额外监听端口。更换 CA 后，每台客户端均需重新安装公开证书。80 和 443 端口必须保持未使用时，不要运行旧的 Certbot 独立签发安装脚本。

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
