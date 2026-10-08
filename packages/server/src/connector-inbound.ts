import { createHash, createHmac, createDecipheriv, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '@tao/core';
import { GENERAL_TASK_CARD_ID } from '@tao/core';
import { AutomationManager, automationOwned, validateAutomationDelivery, type AutomationDelivery } from './automation.ts';
import { AutomationStore } from './automation-store.ts';
import { WorkspaceError } from './workspace-services.ts';
import { isSingleRecipient, type NativeConnectorDelivery } from './connector-outbound.ts';
export type ConnectorKind = 'signed-webhook' | 'feishu' | 'wecom';
interface ConnectorBinding { id: string; tenant: TenantContext; name: string; kind: ConnectorKind; externalUserId: string; enabled: boolean; credentials: Record<string,string>; delivery?: AutomationDelivery }
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function field(xml: string, key: string) { const escaped = key.replace(/[^A-Za-z]/g, ''); const value = new RegExp('<' + escaped + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</' + escaped + '>').exec(xml); return value?.[1] ?? value?.[2] ?? ''; }
export class ConnectorManager {
  private readonly bindings: AutomationStore<ConnectorBinding>;
  private readonly automation: AutomationManager;
  private readonly now: () => number;
  constructor(dir: string, automation: AutomationManager, now = Date.now) { this.bindings = new AutomationStore(dir,'connector-bindings'); this.automation = automation; this.now = now; }
  private configured(b: ConnectorBinding) { const keys = b.kind === 'signed-webhook' ? ['secret'] : b.kind === 'feishu' ? ['verificationToken','encryptKey'] : ['token','encodingAESKey','corpId']; return keys.every(key => !!b.credentials[key]); }
  private nativeDelivery(b: ConnectorBinding):NativeConnectorDelivery|undefined {
    if (!isSingleRecipient(b.externalUserId)) return undefined;
    const c=b.credentials;
    if(b.kind==='feishu'&&c.appId&&c.appSecret)return{kind:'feishu',recipient:b.externalUserId,appId:c.appId,appSecret:c.appSecret};
    if(b.kind==='wecom'&&c.corpId&&c.corpSecret&&c.agentId&&/^[1-9]\d{0,12}$/.test(c.agentId))return{kind:'wecom',recipient:b.externalUserId,corpId:c.corpId,corpSecret:c.corpSecret,agentId:c.agentId};
    return undefined;
  }
  list(tenant: TenantContext) { return this.bindings.listByTenant(tenant.tenantId,tenant.workspaceId).filter(b => automationOwned(b.tenant,tenant)).map(({ credentials: _credentials, delivery, ...b }) => ({ ...b, status: this.configured({ ...b, credentials: _credentials }) ? 'configured' : 'unconfigured', nativeDeliveryStatus:b.kind==='signed-webhook'?'not_applicable':this.nativeDelivery({...b,credentials:_credentials})?'configured':'requires_configuration', callbackPath: '/api/connectors/inbound/' + b.id, delivery: delivery ? { url: delivery.url, configured: true } : null })); }
  create(tenant: TenantContext, value: unknown) {
    const v = value as Record<string, unknown>;
    if (!v || !['signed-webhook','feishu','wecom'].includes(String(v.kind)) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120 || typeof v.externalUserId !== 'string' || !v.externalUserId.trim() || v.externalUserId.length > 256) throw new WorkspaceError(400,'连接器名称、类型和明确绑定的外部账号必填');
    if(v.kind!=='signed-webhook'&&!isSingleRecipient(v.externalUserId))throw new WorkspaceError(400,'原生消息只能绑定单个账号，不能使用@all或多个收件人');
    if (this.list(tenant).length >= 50) throw new WorkspaceError(409,'每账号最多50个连接器');
    const credentials: Record<string,string> = {};
    const keys = v.kind === 'signed-webhook' ? ['secret'] : v.kind === 'feishu' ? ['verificationToken','encryptKey','appId','appSecret'] : ['token','encodingAESKey','corpId','corpSecret','agentId'];
    for (const key of keys) { const value = (v.credentials as Record<string, unknown> | undefined)?.[key]; if (value !== undefined && (typeof value !== 'string' || value.length > 512)) throw new WorkspaceError(400,'凭据格式无效'); if (typeof value === 'string' && value) credentials[key] = value; }
    if (credentials.secret && credentials.secret.length < 32) throw new WorkspaceError(400,'签名密钥至少32字符');
    if (credentials.encodingAESKey && !/^[A-Za-z0-9+/]{43}$/.test(credentials.encodingAESKey)) throw new WorkspaceError(400,'EncodingAESKey须为43位Base64');
    if(credentials.agentId&&!/^[1-9]\d{0,12}$/.test(credentials.agentId))throw new WorkspaceError(400,'企微agentId须为正整数标识');
    const delivery = validateAutomationDelivery(v.delivery);
    const b: ConnectorBinding = { id: randomUUID(), tenant, name: v.name.trim(), kind: v.kind as ConnectorKind, externalUserId: v.externalUserId.trim(), enabled: v.enabled !== false, credentials, ...(delivery ? { delivery } : {}) };
    this.bindings.put(b); return this.list(tenant).find(item => item.id === b.id)!;
  }
  setEnabled(tenant: TenantContext, id: string, enabled: boolean) { const b = this.bindings.get(id); if (!b || !automationOwned(b.tenant,tenant)) throw new WorkspaceError(404,'连接器不存在'); this.bindings.put({ ...b, enabled }); }
  remove(tenant: TenantContext, id: string) { const b = this.bindings.get(id); if (!b || !automationOwned(b.tenant,tenant)) throw new WorkspaceError(404,'连接器不存在'); this.bindings.remove(id); }
  tenantForInbound(id: string): string { const b = this.bindings.get(id); if (!b || !b.enabled) throw new WorkspaceError(404,'连接器不存在或已停用'); return b.tenant.tenantId; }
  private fresh(timestamp: string) { if (!/^\d{10}$/.test(timestamp) || Math.abs(this.now() - Number(timestamp)*1000) > 300000) throw new WorkspaceError(401,'签名时间已过期'); }
  async receive(id: string, raw: string, headers: Record<string,string>, query: URLSearchParams, method: string): Promise<{ type: 'json' | 'text'; value: unknown }> {
    const b = this.bindings.get(id); if (!b || !b.enabled) throw new WorkspaceError(404,'连接器不存在或已停用');
    if (!this.configured(b)) throw new WorkspaceError(503,'连接器凭据尚未配置');
    let eventId = '', sender = '', text = '';
    if (b.kind === 'signed-webhook') {
      if (method !== 'POST') throw new WorkspaceError(405,'仅支持POST');
      const timestamp = headers['x-tao-timestamp'] ?? ''; this.fresh(timestamp);
      if (!same(createHmac('sha256',b.credentials.secret!).update(timestamp + '.' + raw).digest('hex'), headers['x-tao-signature'] ?? '')) throw new WorkspaceError(401,'签名校验失败');
      const event = this.json(raw); eventId = event.eventId; sender = event.senderId; text = event.text;
    } else if (b.kind === 'feishu') {
      if (method !== 'POST') throw new WorkspaceError(405,'仅支持POST');
      const timestamp = headers['x-lark-request-timestamp'] ?? ''; const nonce = headers['x-lark-request-nonce'] ?? ''; this.fresh(timestamp);
      if (!nonce || nonce.length > 256 || !same(createHash('sha256').update(timestamp + nonce + b.credentials.encryptKey + raw).digest('hex'), headers['x-lark-signature'] ?? '')) throw new WorkspaceError(401,'飞书签名校验失败');
      let event = this.json(raw);
      if (event.encrypt) {
        try {
          if (typeof event.encrypt !== 'string') throw new Error();
          const payload = Buffer.from(event.encrypt,'base64'); if (payload.length < 32) throw new Error();
          const key = createHash('sha256').update(b.credentials.encryptKey!).digest();
          const decipher = createDecipheriv('aes-256-cbc',key,payload.subarray(0,16));
          event = this.json(Buffer.concat([decipher.update(payload.subarray(16)),decipher.final()]).toString('utf8'));
        } catch { throw new WorkspaceError(401,'飞书消息解密失败'); }
      }
      const token = event.token ?? event.header?.token;
      if (typeof token !== 'string' || !same(token,b.credentials.verificationToken!)) throw new WorkspaceError(401,'飞书校验令牌无效');
      if (event.type === 'url_verification' && typeof event.challenge === 'string') return { type:'json', value: { challenge:event.challenge } };
      if (event.header?.event_type !== 'im.message.receive_v1' || event.event?.message?.message_type !== 'text') throw new WorkspaceError(400,'只接收文本消息事件');
      eventId = event.header.event_id; sender = event.event?.sender?.sender_id?.open_id; text = this.json(event.event.message.content).text;
    } else {
      const timestamp = query.get('timestamp') ?? ''; const nonce = query.get('nonce') ?? ''; this.fresh(timestamp);
      if (!nonce || nonce.length > 256 || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw new WorkspaceError(400,'企业微信回调格式无效');
      const encrypted = method === 'GET' ? query.get('echostr') ?? '' : field(raw,'Encrypt');
      if (!same(createHash('sha1').update([b.credentials.token!,timestamp,nonce,encrypted].sort().join('')).digest('hex'),query.get('msg_signature') ?? '')) throw new WorkspaceError(401,'企业微信签名校验失败');
      let plain: string;
      try {
        const key = Buffer.from(b.credentials.encodingAESKey! + '=','base64'); const decoder = createDecipheriv('aes-256-cbc',key,key.subarray(0,16)); decoder.setAutoPadding(false);
        const bytes = Buffer.concat([decoder.update(Buffer.from(encrypted,'base64')),decoder.final()]); const pad = bytes[bytes.length-1]!;
        if (pad < 1 || pad > 32 || bytes.length < 20 || !bytes.subarray(bytes.length-pad).every(v=>v===pad)) throw new Error();
        const length = bytes.readUInt32BE(16); if (20+length > bytes.length-pad) throw new Error();
        if (!same(bytes.subarray(20+length,bytes.length-pad).toString('utf8'),b.credentials.corpId!)) throw new Error();
        plain = bytes.subarray(20,20+length).toString('utf8');
      } catch { throw new WorkspaceError(401,'企业微信消息解密或企业校验失败'); }
      if (method === 'GET') return { type:'text', value:plain };
      if (method !== 'POST' || /<!DOCTYPE|<!ENTITY/i.test(plain) || field(plain,'MsgType') !== 'text') throw new WorkspaceError(400,'只接收文本消息');
      eventId = field(plain,'MsgId'); sender = field(plain,'FromUserName'); text = field(plain,'Content');
    }
    if (typeof eventId !== 'string' || !eventId || eventId.length > 256 || typeof text !== 'string' || !text.trim() || text.length > 16000) throw new WorkspaceError(400,'事件编号和文本无效');
    if (sender !== b.externalUserId) throw new WorkspaceError(403,'外部账号尚未绑定此连接器');
    if(b.kind!=='signed-webhook'&&!isSingleRecipient(b.externalUserId))throw new WorkspaceError(403,'原生消息绑定不能使用广播或多个收件人');
    const occurrence = await this.automation.submitOccurrence(b.tenant,'connector:' + b.id,eventId,{ scenarioId: GENERAL_TASK_CARD_ID, fields:{ query:text } },this.nativeDelivery(b)??b.delivery);
    return b.kind === 'wecom' ? { type:'text',value:'success' } : { type:'json',value:{ accepted:true, occurrenceId:occurrence.id, state:occurrence.state, taskId:occurrence.taskId } };
  }
  private json(raw: string): any { try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new WorkspaceError(400,'回调JSON格式无效'); } }
}
