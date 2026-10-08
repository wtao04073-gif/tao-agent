/** 安装指导数据不等同于已连接状态；MCP 服务仍由现有管控台安装与验权。 */
export const CONNECTOR_CATALOG = [
  { id: 'signed-webhook', name: '签名 Webhook', category: 'inbound', status: 'available', fields: ['externalUserId', 'secret'], steps: ['创建连接器并明确绑定当前账号', '将回调路径和密钥配置到发送端', '按原始请求体签名，发送唯一 eventId'] },
  { id: 'feishu', name: '飞书应用机器人', category: 'inbound', status: 'requires_credentials', fields: ['externalUserId', 'verificationToken', 'encryptKey', 'appId', 'appSecret'], steps: ['在飞书开放平台创建应用并开通消息事件与发送消息权限', '绑定发送人的 open_id 并填写应用校验凭据', '配置appId/appSecret后可在任务完成时原生私聊回发；实际接通需在应用平台验证'] },
  { id: 'wecom', name: '企业微信应用回调', category: 'inbound', status: 'requires_credentials', fields: ['externalUserId', 'token', 'encodingAESKey', 'corpId', 'corpSecret', 'agentId'], steps: ['在企业微信管理后台创建企业自建应用', '绑定企业成员 UserID，填写 Token、EncodingAESKey、CorpID', '填写corpSecret/agentId并开通应用成员可见范围，实现完成后原生私聊回发；不适用于仅发送的群机器人 Webhook'] },
  { id: 'office-mcp', name: '办公 MCP 服务', category: 'mcp', status: 'requires_configuration', fields: ['endpoint', 'authorization'], steps: ['部署可信的文档、邮件或日历 MCP 服务', '在管控台的 MCP 连接配置中填写端点及凭据', '探测工具清单并最小化授权；执行写入工具仍需原有策略确认'] },
];
export const EXPERT_TEMPLATES = [
  { id: 'meeting-assistant', name: '会议纪要助手', description: '将提供的会议材料整理成决策、负责人和待办，不推测未提供内容', systemPrompt: '只根据用户提供的会议材料整理会议纪要，分别列出已确认决策、行动项、负责人和截止时间。缺少的信息标记待确认。', skillIds: [] },
  { id: 'finance-reconciler', name: '财务对账助手', description: '读取表格、解释对账口径并输出差异清单', systemPrompt: '先核对两侧字段、期间、币种和唯一键；未确认的对账口径先询问。输出可追溯的匹配与差异表，不擅自修改原始数据。', skillIds: [] },
  { id: 'research-writer', name: '资料分析助手', description: '依据已有资料输出结构化报告并保留来源', systemPrompt: '先确认报告目的与读者，根据用户授权可访问的资料分析，区分事实、推断与未知，保留来源。', skillIds: [] },
];
