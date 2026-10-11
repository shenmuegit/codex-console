# 独立远控控制端

目标链路是 Web → 本 server → 官方中继 → 被控 Codex 主机。server 拥有自己的
控制端身份，接收每台被控主机提供的码，不要求 server 运行 Codex 桌面应用。
官方连接码流程使用中继，码中没有自定义 server 地址。参见
[远程连接说明](https://learn.chatgpt.com/docs/remote-connections)。

## server 发起浏览器授权

`web/remote-auth.mjs` 用 Node crypto/http 实现已观察到的控制端注册授权码
流程，不加载桌面应用代码、不启动 GUI、不写凭据文件。官方授权链接绑定所
选 ChatGPT 工作区，PKCE verifier 始终留在 server。

内部接口：

```js
const attempt = await startRemoteAuthorization({ accountId });
// 向已认证的所有者显示 attempt.url。
// 浏览器在另一台电脑时，把复制的 localhost 回调 URL 作为数据提交：
attempt.submitCallback(callbackUrl);
const stepUpToken = await attempt.completion;
```

所有者的一次性账号确认仍是官方控制端注册的前提。浏览器在 server 上时，
可直接返回本机回环回调；浏览器在另一台电脑时，server 可以校验复制的回调
URL，不访问该 URL，也无需 SSH 隧道。Web 设置入口和控制端注册是后续独立
实现步骤，不能仅凭这个授权模块宣称它们已经完成。

监听仅绑定 IPv4 回环地址，依次使用官方回调端口 1455、1457。拒绝错误 state、
重复 state/code、缺少 code、复制回调的错误 origin/path 和重复消费。令牌交换
拒绝跳转，请求限时 20 秒；成功、取消、拒绝或超时后均关闭回调监听。授权等待
最多十分钟，返回凭据只交给 server 调用方。

在 `web/` 中执行 `node --test test/remote-auth.test.mjs` 和 `npm test` 验证。
检查使用真实本机回调监听及受控令牌接口，证明 server 流程的保护措施，不等于
OpenAI 实际注册成功。原生公开 OAuth client 和注册 scope 来自已安装版本
26.928.21956，独立控制端的官方兼容性仍待验证。

## 受保护密钥注册与主机连接码

`web/remote-controller.mjs` 已实现注册、刷新、提交连接码和主机列表。传入
仓库外的私人 `authFile`、权限 700 的外部 `stateDir`，以及设备密钥组件的
create/get/sign/delete 方法。模块保留日常认证文件，不复用其他设备的控制端
ID；注册前校验账号、挑战的用途/audience/目标/有效期、密钥身份、最新授权
scope，以及自身生成的签名。

server 身份和中继会话一起写入私人 `enrollment.json`，以 600 权限原子发布，
初次注册不覆盖已有记录。`pending.json` 仅标识 server 自己的待注册身份及
所属进程。重复点击设置或另一进程正在授权时，拒绝重复注册。失败时分别清理
本次身份的密钥和远端记录，清理失败则保留私人重试记录。账号变化或密钥缺失、
不匹配时保留已有记录，并阻止提交连接码；中继会话过期后使用原密钥刷新。

已把原生密钥组件复制到私人且忽略提交的
`.tools/controller-key/remote-control-device-key.node`，校验其 SHA-256 为
`517ddc383936597370f731df1d64ba6bf97555756c1b770900db608911dad8ff`。
从这个独立路径执行临时密钥的创建、读取、签名、独立验证和删除均通过，
不加载应用 JavaScript，也不启动桌面进程。组件要求 Linux TPM 资源管理设备
可用。当前 server 使用加密的软件 vTPM；组件报告 `hardware_tpm`，但不能
据此宣称存在物理硬件保护，重启后自动启动仍待配置。

在 `web/` 执行 `node --test test/remote-controller.test.mjs` 和 `npm test`。
当前验证覆盖 13 个控制端场景及 342 项 Web 测试。注册夹具使用独立 ECDSA
签名校验，不能证明官方服务实际接受注册。所有者授权、实际注册/配对、中继
RPC 控制和 Web 设置入口仍待完成及验证。
