# 企业组织与SSO配置

自动化、机器人凭据、OIDC配置与授权事务均使用AES-256-GCM整条加密，只有记录编号和租户索引保留明文且受认证保护。独立的 `.automation-store.key` 以0600权限保存在持久根目录，必须与数据协调备份、分权保管；密钥丢失或不匹配时拒绝读取，不能生成新密钥覆盖。旧明文记录在读取时原子迁移到密文。此文件密钥模式不等同于外部KMS，应由部署方进一步限制持久卷与备份访问。

## 企业组织与部门

企业治理以既有 `tenantId` 为组织边界，保存组织名称、部门树、部门成员、启用账号席位上限及入站IP白名单。部门关系不自动授予团队或文件权限，已有工作区角色与团队ACL继续生效。租户管理员只能修改本组织，平台管理员可显式选择目标组织。

管理接口以 `/api/admin/enterprise` 开头。GET 返回 `organization` 与表单字段目录；PATCH 支持 `name`、`seatLimit` 和 `allowedCidrs`。`seatLimit: null` 表示不设置上限。`departments` POST 创建部门，带 `id` 则更新；支持 `name`、`parentId`、`accountIds`。`departments/{id}` DELETE 删除无子部门的部门。

账号创建与停用账号重新启用必须统一包在 `EnterpriseManager.withSeat(tenantId, accountId, operation)` 中。该方法按启用账号数计席位，并预约异步创建中的名额，防止同时创建超额；已经启用的账号不重复计费。席位配置不能低于已启用与正在预约的数量。文件存储和预约只支持单实例，不能据此宣称多副本一致性。

## 入站IP与代理边界

`allowedCidrs` 接受IP地址及CIDR，空列表允许全部来源。IPv4、IPv6和IPv4映射地址使用标准地址比较。所有已识别租户的请求入口应调用 `enterprise.assertRequest(tenantId, req)`，包括API凭据、Cookie会话、机器人触发与SSO回调。

默认只信任 `socket.remoteAddress`，忽略客户端自行传入的 `X-Forwarded-For`。部署可通过构造器 `trustedProxies` 明确提供代理IP/CIDR；只有直接连接来自可信代理时，才从代理链右端向左逐个跳过可信地址，取第一个不可信地址作为客户端IP。代理链最多16段，格式无效时拒绝。部署必须确保反向代理按规范追加或重写XFF，不能配置过宽的可信代理范围。

策略文件损坏时请求失败，不会回退到无限席位或开放网络。修改白名单可能阻断当前管理地址，应在生产变更流程中保留部署级恢复渠道。

## OIDC配置与身份绑定

管理接口 `oidc/providers` GET/POST 管理提供商，POST带 `id` 更新，`oidc/providers/{id}` DELETE 删除。字段：

| 字段 | 含义 |
| --- | --- |
| name | 登录入口名称 |
| issuer | 与发现文档和ID Token完全一致的HTTPS issuer |
| clientId | IdP登记的客户端标识 |
| clientSecret | 可选密钥，仅写入，不在查询中回显；省略更新时保留 |
| redirectUri | 固定HTTPS回调，指向本服务 `/api/auth/oidc/callback` |
| tokenAuthMethod | `none`、`client_secret_basic`或`client_secret_post` |
| enabled | 是否启用提供商 |

提供商应支持授权码流程与PKCE S256，回调URI必须在IdP平台精确登记。服务通过HTTPS读取发现文档与JWKS，安全出网阻止私网/元数据和重定向；私有IdP需要部署明确设计可信网络通道，不能为方便而关闭默认出网边界。未配置任何提供商时不会提供虚假的登录成功。

`oidc/bindings` GET/POST 管理显式映射，字段 `providerId`、`subject`、`accountId`；`subject` 是IdP签发的稳定 `sub`，`accountId` 必须是同组织既有启用账号。`oidc/bindings/{id}` DELETE 撤销映射。系统不按email自动绑定，不信任外部roles/groups声明，不自动创建账号或提升权限。

公开入口 `GET /api/auth/oidc/start?providerId=...` 创建10分钟有效的授权事务并跳转IdP。事务保存随机state、nonce、PKCE verifier和浏览器Cookie摘要。浏览器绑定Cookie使用Secure、HttpOnly、SameSite=Lax；回调先校验并一次性消费state，再向固定token endpoint兑换授权码。验证JWT签名、issuer、audience、azp、nonce、iat、exp，允许RS256、PS256、ES256。访问令牌不用于账号映射也不落盘。

回调使用现有内部账号当前状态与角色签发会话；账号停用、提供商停用/配置变化、映射撤销均阻止登录。SSO只能通过HTTPS使用，不能依赖非安全Cookie调试。协议测试使用注入的模拟issuer与真实JWT签名，尚不能替代真实IdP的端到端配置验收。

## 主服务集成契约

`EnterpriseOidc` 接收只读 `getAccountPrincipal(accountId)` 及内部 `loginBoundAccount(accountId)`。后者应再次确认账号启用，从原有身份存储签发会话并返回 `{ token, principal, csrf }`，不得通过请求参数直接调用，也不得使用OIDC声明中的角色代替内部角色。

`createEnterpriseHandler({ authenticate, enterprise, oidc })` 提供管理及SSO路由；公开SSO入口需要在普通登录门禁前分发，管理写请求仍走宿主Origin与CSRF检查。回调成功设置现有 `tao_session` Cookie并跳转聊天页。公开SSO请求每socket来源每分钟15次、全局100次；429返回Retry-After。
