# CubeSandbox SDK 来源

源自 TencentCloud/CubeSandbox `2bbaf74ba7565992ec2a3dbc9928ed5b720639a2` 的 sdk/node/src，Apache-2.0。源码保持上游实现；本地 package.json/tsconfig 用于单仓离线构建，不包含上游开发依赖。npm注册表目前未取得官方包，故固定源码版本并保留版权，禁止静默跟随master。

本地兼容补丁：filesystem.ts 使用 undici 的 FormData，并复制 Buffer 为 Uint8Array，兼容当前 Node 类型定义；不改变文件上传协议。

commands.ts 增加可选 onStdout/onStderr、AbortSignal 与最大输出字节数，保持原有返回结构及默认调用方式；用于实时进度、取消和有界响应。
