# 原生浏览器客户端

[English](../native-web-client.md)

原生客户端已在 `codex/native-web-client` 实现，连接与额外桌面共享的独立源码后端。
项目、聊天、文件/照片、模型/用量及原生 `@`/`$`/`/` 操作均已接入。
原桌面的后端未迁移；界面及硬件验收范围在下方明确说明。

## Codex 桌面界面

界面沿用已安装 Codex 桌面的灰阶主题变量、系统字体及当前 290 px 侧栏宽度。
单个全局侧栏显示原生项目/会话，聊天区采用桌面式圆角输入框；模型、思考强度、权限状态
和只读上下文指示器均位于输入框内。上下文详情保留原生 token/窗口值和 12000 token
百分比基线，不增加自定义上下文上限。

登录后首次进入不带线程 ID 的页面，后端在线时会自动准备一个原生空白会话；无需先点
“新建会话”，即可添加文件/照片及选择模型/思考强度。线程 ID 写入网址，刷新会重新打开
该会话；已有会话链接及期间的新导航优先。准备过程不发送模型轮次。创建失败时在聊天区
显示错误，可用已有的“新建会话”按钮重试。

新轮次默认请求原生自动思考摘要，避免模型目录默认关闭摘要时始终留白。思考区随原生
可显示文本到达而更新；运行中空内容显示等待状态，结束后仍为空则说明模型没有提供摘要。
历史消息若未返回可显示文本，无法从加密记录补回摘要。

侧栏底部提供当前账号的全局七天用量，没有选中会话也可打开，切换会话不改变其范围。
附件加号使用已有文件/照片选择器。不提供项目/目录修改、退出登录或会话手动刷新控件。
会话菜单使用原生 Popover API，需要当前版本浏览器支持。
归档始终确认会先停止正在运行的工作，避免会话列表状态尚未更新时漏过确认。
菜单恢复会话保留当前聊天、草稿及归档筛选；点击已归档会话本身则恢复并打开，
期间有新的导航操作时以新操作为准。恢复操作沿用行级忙碌保护，避免重复提交。

## 安装和操作

需要 Linux 用户 systemd、Node.js 24+、OpenSSL，以及下文的持久原生程序。先安装唯一包：

```bash
npm --prefix web ci
node web/service.mjs init --origin https://127.0.0.1:15443 \
  --backend-bin "$HOME/.local/lib/codex-console-web/bin/codex-app-server" \
  --backend-home "$HOME/.local/state/codex-console-web/native-home" \
  --workspace "$HOME/.local/state/codex-console-web/workspace"
node web/service.mjs install
node web/service.mjs start
node web/service.mjs status
node web/service.mjs stop
```

所有命令支持 `--config /绝对/私有/config.json`，默认遵循 XDG_CONFIG_HOME/XDG_STATE_HOME。
初始化拒绝覆盖已有凭据，也拒绝原 Codex 数据目录；需要时只复制已有文件登录，不复制聊天
或账号数据库。密码/哈希、证书/私钥及按明确变量名保存的代理/证书环境文件均仅所有者可读，
不传入 API-key 或任务运行时覆盖变量。访问密码保存在配置旁 `owner-password`，不输出到日志。
可用 `--cert`、`--key` 将已有证书对复制到私有存储；默认生成匹配入口 SAN 的 30 天自签名
证书。访问设备需信任/导入该证书，或提供受信任证书；浏览器安全提示由所有者操作。

初始化写入前会沿已有父目录核对私有路径的真实位置，加载配置时再次检查。
不能通过符号链接将凭据或应用数据写入仓库。
保留已有项目工作目录的权限；仅新建工作目录和私有应用存储设为所有者专用。
初始化先检查原生程序，再生成凭据；后续失败只删除本次新建文件，保留已有材料，
修正参数后可直接重试初始化。

只管理 `codex-console-native-backend.service`、`codex-console-native-web.service`。
原生服务使用明确的持久源码程序和独立数据目录；网页握手核对原生数据目录，不启动备用引擎。
服务路径支持空格、Unicode、% 和 $，不经过 shell。服务引用的工作树必须保留。
安装会先检查两个服务文件的归属，再修改文件。启动和停止前会核对实际加载文件的
系统用户及管理标记，保留同名但不属于本项目的服务。
停止自有服务不依赖 TLS 或配置安装是否完好；证书过期或程序缺失时，状态检查仍报告
服务状态并显示 HTTPS 不可用。安装和启动继续执行完整校验。

## 当前已验证部署

- 入口 `https://117.72.158.35:15443`，HTTPS 监听 `0.0.0.0:15443`；原生 WS 仅回环 `ws://127.0.0.1:4500`。
- 私有配置、密码、证书及环境：`~/.config/codex-console-web/`。
- 独立原生数据/桌面配置/工作目录：`~/.local/state/codex-console-web/integration/`；
  网页偏好及上传继续保留在其 `web/` 子目录。
- 代码位于托管工作树 `/home/desktop/.codex/worktrees/native-web-client/codex-console`。
- 按所有者要求停止并禁用旧 Xpra 服务 `codex-console.service`，释放 15443；
  其中的原桌面及后端进程已结束，独立原生后端继续为网页客户端提供服务。

公网入口已通过直连 HTTPS 登录、外来 Host/Origin 拒绝、原生模型读取、SSE 快照恢复和退出验证。
密码、私钥、原生数据及上传文件继续保留在原私有位置。

规范 Host/Origin 为 `https://117.72.158.35:15443`。私有配置使用
`cert-public-117.72.158.35.pem`，证书 SAN 匹配公网 IP；该证书为自签名，访问设备需信任/导入
当前证书。检查禁用代理变量并直连公网 IP，外部设备仍需人工验收。
公网 IP 或主机名变化时，同时更新配置入口和匹配证书；其他 Host/Origin 继续拒绝。

## 重启与回退

已有部署更换 HTTPS 端口时，同时修改私有配置的 `origin` 和 `port`，例如
`https://117.72.158.35:15443` 与 `15443`。主机名/IP 不变时可继续使用当前证书。
确认目标端口空闲后再重启网页服务。旧 Xpra 服务可能包含原桌面及活动后端；
停止整个服务会结束这些进程，需先确认可以关闭该桌面。

```bash
systemctl --user restart codex-console-native-web.service
systemctl --user restart codex-console-native-backend.service
node web/service.mjs status
```

只重启网页不会中断原生工作，但登录会话在内存中，需要重新登录。后端重启依赖原生持久化
并重新加载权威状态，不承诺活动任务无缝转移，也不重发已经发送的操作。仅操作上述自有服务；
原桌面改接此后端需等活动工作结束后另行迁移。

回退保留原生数据及上传文件：

```bash
node web/service.mjs stop
systemctl --user disable codex-console-native-web.service codex-console-native-backend.service
```

## 发布检查与界面限制

103 项 Node 检查通过，生产依赖审计零漏洞。原生网页版初次发布审查的 6 项重要问题和重新分级为重要的
3 项问题，均以独立验证并推送的 9 个提交修复。页面事件检查覆盖重复命令、组合 Enter
和刷新后的会话定位，真实 HTTPS/原生检查也确认子目录中文文件补全。长期服务的完整
HTTPS/原生检查通过，包含项目、双客户端聊天、打断、文件/照片、精确下载、
模型/强度/上下文/压缩、周额度、引用及命令效果。
分别重启网页和后端，验证已接受工作继续、重新同步和同一 UUID 对应一条原生消息。
运行证明保存在仓库外。
首次进入检查还通过真实 HTTPS 和原生后端运行页面控制器：模型/思考强度均保存成功，
文本及 PNG 上传字节一致。检查创建的临时会话和附件已清理，没有运行模型推理。
思考摘要检查通过真实 HTTPS/SSE 收到原生摘要增量，重新打开临时会话后摘要仍保留。

界面工具没有已启用的浏览器或原生界面，因此不宣称完成登录点击、登录后应用截图、
真实手机输入法/选择器/剪贴板/下载或桌面键盘验收。人工检查应登录，在手机打开侧栏并选择
原生项目/会话，确认输入法 Enter，选择/移除/重试文件，复制完整 ID、下载核对字节，并在额外桌面打开
相同会话双向发送。CSS 已采用可见焦点、原生控件、安全区域和键盘可视视口；实机行为待验证。
独立的离线 Firefox 静态页面检查确认：390×844 页面可见高度收缩到 430 px 时，空会话欢迎区
可以缩小，发送按钮保持可见；这不替代手机实机验收。

已知展示限制：其他页面打开同一会话时，可能将已加载的更早记录重置为最新 20 轮快照。
可再次点击“加载更早记录”，原生历史仍完整保留；该审查轻微问题暂缓处理。

## 原生连接

`web/codex.mjs` 只连接配置中指定的回环 WebSocket 地址，必须明确端口。
连接会初始化原生实验接口、对应请求与回复、保留原生错误，单次请求超时为 30 秒，
建立连接及初始化超时为 10 秒。

每个原生消息都有连接代次和顺序游标。原子恢复得到的历史快照，会在后续增量消息
及等待中的接口处理程序之前发布。每个页面获取自己的快照；最后一个页面关闭时，
仅取消空闲会话的订阅。界面不显示项目/会话手动刷新按钮，由原生事件更新列表；
重连后即使没有选中会话，也会重新读取项目及会话目录。运行中的工作保持订阅，直到对应轮次结束。
重连后恢复订阅与快照，不会重发已提交的操作。

发送后断线的操作结果为**未知**，应先查看原生历史再决定是否重试；离线时调用则为
**未发送**。审批或输入请求只能回答一次，在原生请求解决或重连时失效，原生请求 ID
为数字零也能正常处理。

## 隔离测试环境

官方源码固定在 `ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`，使用 Rust 1.95.0、
锁定依赖及 `dev-small` 配置，编译独立 app-server，将桌面自带的官方
`codex-code-mode-host` 组件安装在旁边。本源码版本的默认工具执行需要后者，
仅测试文字回复无法发现它缺失。尝试从源码编译组件时，遇到 V8 sandbox 预编译库缺失；
该特性在依赖库说明及[上游发布资产](https://github.com/denoland/rusty_v8/releases/expanded_assets/v150.4.0)中没有对应预编译产物。
app-server 仍使用固定源码构建，功能代码不变。构建时临时写入与桌面版本对应的
`0.159.2-dev.ff9ab4a` 发布元数据；默认 `0.0.0` 会使模型服务返回不完整的兼容目录。
Cargo 仅离线更新工作区版本，验证第三方锁定依赖未变，构建后恢复源码的两个元数据文件。
模型和思考强度继续使用原生目录，隐藏的内部型号不加入桌面下拉框。
两个程序一起安装到仓库外的 `~/.local/lib/codex-console-web/bin/`。

```bash
cd /home/desktop/Documents/Codex/codex-console/codex/codex-rs
(
  set -e
  codex_build_backup=$(mktemp -d)
  cp Cargo.toml Cargo.lock "$codex_build_backup/"
  trap 'cp "$codex_build_backup/Cargo.toml" Cargo.toml; cp "$codex_build_backup/Cargo.lock" Cargo.lock; rm -rf "$codex_build_backup"' EXIT
  python3 - <<'STAMP'
from pathlib import Path
import tomllib
p = Path('Cargo.toml')
text = p.read_text()
assert tomllib.loads(text)['workspace']['package']['version'] == '0.0.0'
start = text.index('[workspace.package]')
p.write_text(text[:start] + text[start:].replace('version = "0.0.0"', 'version = "0.159.2-dev.ff9ab4a"', 1))
STAMP
  "$HOME/.cargo/bin/cargo" +1.95.0 update --offline --workspace
  python3 - "$codex_build_backup/Cargo.lock" <<'LOCK'
from pathlib import Path
import sys, tomllib
old = tomllib.loads(Path(sys.argv[1]).read_text())['package']
new = tomllib.loads(Path('Cargo.lock').read_text())['package']
assert [p for p in old if 'source' in p] == [p for p in new if 'source' in p]
LOCK
  CARGO_HTTP_MULTIPLEXING=false CARGO_INCREMENTAL=0 \
  CARGO_TARGET_DIR="$HOME/.cache/codex-console-web-build" \
    "$HOME/.cargo/bin/cargo" +1.95.0 build --offline --locked --profile dev-small -j 2 \
    -p codex-app-server --bin codex-app-server
)
install -d -m 700 "$HOME/.local/lib/codex-console-web/bin"
install -m 700 "$HOME/.cache/codex-console-web-build/dev-small/codex-app-server" \
  /usr/lib/chatgpt/resources/codex-code-mode-host "$HOME/.local/lib/codex-console-web/bin/"
```

测试数据位于
`~/.local/state/codex-console-web/integration/{codex-home,desktop-profile,workspace}`。
目录权限为 0700；现有文件登录信息可复制为 0600。不要复制原桌面的聊天或账号数据库。
额外桌面使用独立 Codex home 和 Electron 配置，通过 `CODEX_APP_SERVER_WS_URL`
连接同一个源码编译后端 `ws://127.0.0.1:4500`。原桌面与运行中的会话继续使用原后端。

两个临时用户服务为 `codex-console-native-backend-test` 和
`codex-console-native-desktop-test`，仅停止或重启这两个自有测试服务。
界面、代理和证书环境按明确的变量名写入私有环境文件传递；凭据及日志不提交。

修正后的构建返回与桌面一致的 7 个常规模型，包含 GPT-6.1-Sol、GPT-6-Sol 和 GPT-6-Luna。真实 GPT-6.1 原生文件工具调用及公网 HTTPS/模型/SSE 检查通过，一次性测试会话和文件已清理。

## 验证

```bash
npm --prefix web test
node web/test/native-probe.mjs --url ws://127.0.0.1:4500 \
  --workspace "$HOME/.local/state/codex-console-web/integration/workspace" \
  --exercise-files
```

自动测试使用模拟原生 WebSocket 事件，不访问账号。手动集成探针读取原生模型、项目、
会话及登录可用性，不输出账号内容。文件验证会新建一次性原生会话，要求实际调用文件或
命令工具，逐字节检查私有文件，完成后删除该测试会话。

新建空原生会话后，先命名再恢复。原生 `thread/name/set` 会持久化空会话的分页历史，
否则立即恢复可能返回“no rollout found”；这沿用官方测试流程。

下文记录已实现组件；客户端不使用 Xpra 连接。

任务 1 实测：源码 app-server 编译退出码 0，耗时 11m 13s；10 项原生连接检查和原项目隔离检查通过。原生目录读取返回 4 个模型，隔离项目/会话均为 0，已有登录可用；额外桌面的 WebSocket 连接已初始化。真实文件探针通过：原生工具写入的字节完全一致，一次性测试会话已删除；桌面官方组件与本次工具调用兼容。

当前 app-server 版本为 `0.159.2-dev.ff9ab4a`，SHA-256 为 `060d8d708d00c10b50d16620c9c63374c2ceb262f482163e3dbdac81110c7c37`；桌面组件 SHA-256 仍为 `5b2c075ac2380fa04d76d7313fbc044d29c8d0a0d0b9138415acd4610211ca03`。任务 1 的 `0.0.0` 构建仅作历史记录；复现模型目录时同时记录源码 commit、发布元数据和程序哈希。


## HTTPS 用户访问

`web/server.mjs` 提供固定本地页面，只接受配置中的 HTTPS Host/Origin。
登录使用有效期固定为 12 小时的 `HttpOnly; Secure; SameSite=Strict` Cookie。
密码采用异步原生 scrypt，盐为 16 字节、密钥为 64 字节，N=16384/r=8/p=1；
每 IP 每分钟失败五次后限流。密码、哈希、TLS 文件及配置保存在仓库外，
不记录请求正文或 Cookie。

浏览器只能调用固定读取接口；任意进程、配置、凭据接口及原始新建会话请求被拒绝。
读取和事件中过滤原生凭据。暂不支持的登录刷新、证明或动态工具请求明确返回
“不支持”。审批和输入请求只能回答一次；权限回答不能超过对应原生请求。

每个页面获得属于当前登录会话的视图 ID，通过认证的 SSE 接收事件，每 15 秒保活，
每条流排队上限为 1 MiB。慢速页面会断开，新建或重连的流均要求重新获取权威快照。
界面不显示退出登录按钮，沿用当前安全会话，绝对有效期结束后重新验证密码。
内部会话清理仅撤销对应会话及事件流，不影响其他登录或持久原生连接。

隔离 HTTPS 测试服务为 `codex-console-native-web-test`，仅监听
`https://127.0.0.1:8443`。临时集成配置及私有访问密码位于
`~/.config/codex-console-web/integration/`，TLS 证书为回环地址的自签名证书。
持久主机 IP 部署见上文。
运行 `node --test web/test/auth-server.test.mjs` 可执行隔离 HTTPS/认证检查。
九项检查通过，包含真实 TLS/SSE 慢速页面暂停读取时，另一页面继续接收事件。
连接源码后端的 HTTPS 实测也通过：未登录 401、其他来源 403、读取四个原生模型、
SSE 要求获取快照、退出登录；没有输出密码内容。


## 浏览器聊天

选择原生项目或全部会话，每页显示 20 条。新会话使用所选主机目录，默认完全访问、
执行免审批，服从原生托管限制。新建空会话先命名再原子恢复。页头显示真实会话 ID，
可直接复制，同时显示原生会话默认设置。读取会话不会改变当前执行权限。

发送使用稳定消息 UUID，失败或状态未知时保留草稿；浏览器允许时在会话存储中保留。
工作进行中需明确选择“补充当前轮次”或“排队到下一轮”。补充沿用当前轮次设置，
排队使用原生后续默认设置；排队前修改后续完全访问默认值，等待原生设置通知确认后
才提交消息。停止操作针对真实活动轮次 ID。

打开/切换页面使用原子恢复及有序游标。原生完成摘要不会删除已经流式展示的工具记录。
较早的完整历史向前追加，不覆盖最新内容；延迟的安全 HTML 不会替换更新的文本。
唯一依赖固定为 `markdown-it` 15.0.2，禁用原始 HTML、限制链接协议，不自动加载外部图片。
文本立即流式显示，安全 HTML 合并为最多每 100 毫秒更新一次。

原生审批、权限、问题及 MCP 表单/链接请求均有明确响应控件；已解决或过期的请求不能
再次回答。中文输入法确认、Shift+Enter 及手机 Enter 不发送草稿；桌面 Enter 发送，
所有设备均可使用发送按钮。

手动运行真实联调探针，读取私有访问密码而不输出它：

```bash
node web/test/web-probe.mjs \
  --config "$HOME/.config/codex-console-web/integration/config.json" \
  --password-file "$HOME/.config/codex-console-web/integration/owner-password" \
  --exercise-chat
```

已在源码后端验证 HTTPS 发送、第二个原生协议客户端的回复经 SSE 返回、真实命令运行中
关闭/重开、打断任务、重复 UUID 对应一条原生消息，以及仅删除一次性测试会话。
原桌面保持运行。当前环境没有可控界面，浏览器/桌面键盘操作、实际剪贴板复制及手机
视觉布局仍待人工验收：在额外桌面打开同一真实会话 ID，双向发送，再检查手机导航及复制。


## 原生项目和工作目录

项目及根目录从 Codex 读取，不再叠加网页项目归档状态。
网页不提供项目新建、编辑、文件夹创建或目录选择器；旧项目/目录写入接口在任何
原生写入前返回 `WORKSPACE_MANAGED_BY_CODEX`，浏览器原始 RPC 也不允许这些操作。

新建会话只发送选中的原生项目 ID，由网关读取 Codex 登记的主要根目录；没有选中项目时
沿用服务配置的默认目录。浏览器传入 `cwd` 覆盖会被拒绝，已有会话继续使用原生快照中的
实际工作目录。

每条会话右侧的三横线菜单提供“复制线程 ID”“归档/恢复”“删除”，聊天标题栏不再放置复制或删除按钮。
操作始终使用被点击会话的完整原生 ID，保留另一条已选会话及其草稿。原生弹出菜单支持方向键、
Escape/Tab 关闭及焦点返回；归档运行中会话前可取消停止操作。

会话删除仍只确认一次，读取最新原生活动状态，打断对应轮次并最多等待 30 秒；
拒绝、超时或出现其他活动轮次时不删除，工作目录文件和上传文件均保留。
项目检查覆盖只读边界、原生根目录、分页游标及已有停止/删除回归。

## 文件、照片和下载

通过“文件”或“照片”选择多个附件，按顺序上传，显示原生浏览器进度及可移除的预览；
全部完成后才能发送。默认单文件精确上限为 33,554,432 字节（32 MiB），可配置到固定
源码的原生图片输入上限 1 GiB；同时检查声明大小和实际流式字节数。
取消、长度不符、超限或失败时清理部分文件，保留已有完成附件及草稿。

完成的元数据和文件保存在配置的数据目录中，目录 0700、文件 0600。从草稿移除附件或
删除会话不删除历史文件。照片使用原生本地图片输入，文档使用原生文本路径及 UTF-8
文本元素，不虚构二进制输入类型。PNG/JPEG/WebP/GIF 预览经过格式签名、浏览器及原生
图片解码校验；SVG 等主动格式按普通文件下载。

下载链接只来自聊天目标及已完成上传，使用会话实际目录、已知上传存储和配置的生成目录。
通过规范路径、不跟随符号链接打开、已打开描述符及 inode 校验阻止路径替换。
链接仅携带不透明 ID，不暴露任意路径/URL 下载接口；以 Content-Disposition 保留 UTF-8
文件名，并流式读取已打开文件的实际字节。校验需要 Linux `/proc/self/fd`。

SSE 排队仍限制为 1 MiB；大快照及展示内容改由认证 HTTPS 获取，SSE 发送小型游标信号。
延迟的文件/HTML 展示不会覆盖更新的原生文本。JSON 请求限时 30 秒；上传请求限时
10 分钟，连续空闲上限 30 秒。

`web/test/files.test.mjs` 覆盖精确上限、分块/虚假长度、中断/磁盘满清理、Unicode 文件名、
无效照片、伪造 ID、符号链接竞态、项目重绑、鉴权及大历史。真实探针增加
`--exercise-attachments` 可验证文本/照片原生输入和模型生成文件的准确字节。
源码后端实测通过，删除一次性会话后上传文件仍可下载。浏览器选择器和预览交互仍按
前文人工界面验收说明检查。


## 模型和用量

模型及思考强度来自原生目录，使用 `thread/settings/update` 修改后续轮次，并等待对应
原生通知确认。保留草稿，不使用 `turn/settings/update` 改写运行中轮次。
排队消息使用共享的后续默认值，之后调整选择器也会影响它们；补充输入沿用当前轮次。
页头显示原生默认设置及托管权限；不支持的模型、强度或照片组合会被拒绝，草稿及附件保留。

上下文显示最新 `last.totalTokens`、可用的原生窗口，以及原生 12,000 token 基准百分比。
不把会话累计总数当成当前上下文；窗口/用量缺失时明确显示未知。压缩和模型活动通过原生
通知刷新数据；提交成功后才到达的执行/额度错误仍会在聊天中显示。

七天额度选择任一原生窗口中的 10080 分钟周期，优先使用 `rateLimitsByLimitId`。
各额度桶单独显示，将重置秒时间转换为本地时间。账号/模型变化时清除过期读取及缓存，
包括过期错误；不提交真实额度或账号内容作为测试证据。

七项专项检查及当前完整测试通过。真实 `web-probe.mjs --exercise-usage` 验证了两档
支持的强度、下轮实际设置、原生上下文、压缩后刷新及真实周额度元数据。


## 原生 @、$ 和 / 操作

输入 `@` 选择会话实际工作区中的文件/目录、其他会话，或可用的原生应用/插件；
支持 `@src/` 等相对于会话实际目录的子目录补全。
输入 `$` 选择已启用的工作区技能。选择后绑定该段文字，编辑该段会解除绑定；
邮件、代码及未选择的 `$HOME` 保持普通文本。中文/emoji 使用原生 UTF-8 位置，
输入法确认不选择或发送补全，原生不可用条目明确显示不可用。
补全菜单打开时，Shift+Enter 仍用于换行；单独 Enter 接受高亮条目。

文件/目录使用原生带引号路径，技能使用类型化技能输入，应用/插件使用类型化提及身份。
会话链接采用原生转义格式，排除自身/重复上下文，最多 16 个 ID、合计 768 ID 字节。
发送时只读取所选会话，JSON 引用并标为不可信快照，单会话不超过 8 KiB、总计 32 KiB。
原生 queue/add 没有 additionalContext 字段，因此排队使用单独的不可信引用文本输入。
这是发送时快照，不会向被引用会话发送消息。

支持命令：`/new`、`/model [模型 强度]`、`/permissions`、`/status`、`/usage`、`/skills`、
`/compact`、`/rename [名称]`、`/archive`、`/delete`、`/fork`、`/export`。
前一组打开已有界面/原生控件；重命名和压缩调用原生操作。归档运行中会话需确认并等候
停止，勾选“显示归档会话”后点击即可恢复。删除沿用已有确认。分支使用完全访问默认值，
延后继承目标的自动继续；导出分页原生历史为 Markdown，不写主机文件。
不虚构 commands/list 或 read_thread 工具。
命令提交会在等待原生操作前同步锁定，连续按 Enter 或点击不会重复分支或压缩。
失败保留草稿，执行期间编辑的新文本也会保留。
打开、新建或分支会话都会更新页面地址中的线程 ID，刷新后重新打开当前选中的会话。

任务 7 的八项专项及完整测试通过。真实 `web-probe.mjs --exercise-references` 验证了文件、实际
技能、实际插件、到达模型的只读会话快照、原生排队快照数据、重命名/分支/归档/恢复/导出，
以及一次性清理。当前账号/运行时没有可调用的原生应用，该目录保持不可用，类型表示由
模拟检查覆盖。界面点击仍按前文人工验收范围检查。
