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
