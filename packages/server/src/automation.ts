import { createHash, createHmac, randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { TenantContext } from '@tao/core';
import type { AppDeps } from './app.ts';
import { WorkspaceError } from './workspace-services.ts';
import { outboundFetch } from './admin-network.ts';
import { AutomationStore } from './automation-store.ts';
import { NativeConnectorSender, NativeDeliveryUncertainError, isNativeDelivery, type NativeConnectorDelivery } from './connector-outbound.ts';

export type AutomationInput = Parameters<AppDeps['submitTask']>[1];
export type AutomationSchedule = { kind: 'once'; at: string } | { kind: 'interval'; everySeconds: number } | { kind: 'cron'; expression: string; timezone: string };
export interface AutomationDelivery { url: string; secret: string }
export type AutomationResultDelivery = AutomationDelivery | NativeConnectorDelivery;
export interface Automation { id: string; tenant: TenantContext; name: string; input: AutomationInput; schedule: AutomationSchedule; enabled: boolean; nextRunAt: number | null; createdAt: number; delivery?: AutomationDelivery }
export interface AutomationOccurrence { id: string; tenant: TenantContext; sourceId: string; scheduledAt: number; input: AutomationInput; state: 'pending' | 'submitting' | 'submitted' | 'completed' | 'failed' | 'uncertain' | 'cancelled'; taskId?: string; conversationId?: string; taskStatus?: string; error?: string; createdAt: number; delivery?: AutomationResultDelivery }
export interface AutomationOutbox { id: string; tenant: TenantContext; occurrenceId: string; target: AutomationResultDelivery; body: string; state: 'pending' | 'sending' | 'delivered' | 'failed' | 'cancelled'; attempts: number; nextAttemptAt: number; lastStatus?: number; error?: string }
export interface AutomationDeps {
  dir: string;
  /** 必须经过 ExecutionRegistry、权限门、配额与原有任务队列。 */
  submitTask: AppDeps['submitTask']; cancelTask: AppDeps['cancelTask']; getTask: AppDeps['getTask'];
  /** 仅返回用户任务的最终文本与产物名称，不返回凭据、内部事件或宿主路径。 */
  getResult?: (tenant: TenantContext, taskId: string) => { text?: string; artifacts?: string[] };
  now?: () => number; fetch?: typeof fetch;
}
export const automationOwned = (a: TenantContext, b: TenantContext) => a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.userId === b.userId;
export const automationDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export function nextAutomationTime(schedule: AutomationSchedule, after: number): number | null {
  if (!schedule || typeof schedule !== 'object') throw new WorkspaceError(400, '缺少调度配置');
  if (schedule.kind === 'once') { const at = Date.parse(schedule.at); if (!Number.isFinite(at)) throw new WorkspaceError(400, '一次性运行时间无效'); return at > after ? at : null; }
  if (schedule.kind === 'interval') { if (!Number.isInteger(schedule.everySeconds) || schedule.everySeconds < 60 || schedule.everySeconds > 31536000) throw new WorkspaceError(400, '间隔须为60至31536000秒'); return after + schedule.everySeconds * 1000; }
  if (schedule.kind === 'cron') {
    try {
      if (typeof schedule.expression !== 'string' || schedule.expression.trim().split(/\s+/).length !== 5 || typeof schedule.timezone !== 'string') throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
      return CronExpressionParser.parse(schedule.expression, { currentDate: after, tz: schedule.timezone }).next().getTime();
    } catch { throw new WorkspaceError(400, '请填写有效的5段cron与IANA时区'); }
  }
  throw new WorkspaceError(400, '不支持的调度类型');
}
export function validateAutomationDelivery(value: unknown): AutomationDelivery | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as AutomationDelivery;
  try { const url = new URL(v.url); if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || typeof v.secret !== 'string' || v.secret.length < 32 || v.secret.length > 256) throw new Error(); }
  catch { throw new WorkspaceError(400, '结果回调须使用HTTPS标准端口及至少32字符的签名密钥'); }
  return { url: v.url, secret: v.secret };
}
export function validateAutomationInput(value: unknown): AutomationInput {
  const input = value as AutomationInput;
  if (!input || typeof input.scenarioId !== 'string' || !input.scenarioId || !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields) || JSON.stringify(input.fields).length > 64000) throw new WorkspaceError(400, '任务场景与字段无效');
  if (input.tier !== undefined && input.tier !== 'lite' && input.tier !== 'flagship') throw new WorkspaceError(400, '模型档位无效');
  for (const key of ['modelId','skillPackageId','skillId','agentId'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key]!.trim() || input[key]!.length > 256)) throw new WorkspaceError(400,'模型或技能标识无效');
  return { scenarioId: input.scenarioId, fields: structuredClone(input.fields), ...(input.tier ? { tier: input.tier } : {}), ...(input.modelId ? { modelId:input.modelId } : {}), ...(input.skillPackageId ? { skillPackageId:input.skillPackageId } : {}), ...(input.skillId ? { skillId: input.skillId } : {}), ...(input.agentId ? { agentId: input.agentId } : {}) };
}

export class AutomationManager {
  private readonly automations: AutomationStore<Automation>;
  private readonly occurrences: AutomationStore<AutomationOccurrence>;
  private readonly outbox: AutomationStore<AutomationOutbox>;
  private readonly deps: AutomationDeps;
  private readonly now: () => number;
  private readonly nativeSender: NativeConnectorSender;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly submissions = new Map<string, Promise<AutomationOccurrence>>();
  private readonly deliveries = new Map<string, AbortController>();
  private lastError: string | undefined;
  constructor(deps: AutomationDeps) {
    this.deps = deps; this.now = deps.now ?? Date.now;
    this.nativeSender = new NativeConnectorSender({ ...(deps.fetch ? {fetch:deps.fetch} : {}), now:this.now });
    this.automations = new AutomationStore(deps.dir, 'automations'); this.occurrences = new AutomationStore(deps.dir, 'automation-occurrences'); this.outbox = new AutomationStore(deps.dir, 'automation-outbox');
  }
  start() { if (this.timer) return; this.timer = setInterval(() => { void this.tick().catch(() => { this.lastError = '调度恢复失败，请检查持久数据与任务服务'; }); }, 1000); this.timer.unref(); void this.tick().catch(() => { this.lastError = '调度恢复失败，请检查持久数据与任务服务'; }); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const controller of this.deliveries.values()) controller.abort(); this.nativeSender.clear(); }
  health() { return { mode: 'single-instance', running: !!this.timer, lastError: this.lastError ?? null, catchUp: 'coalesce-one', distributed: false }; }
  list(tenant: TenantContext) { return this.automations.listByTenant(tenant.tenantId, tenant.workspaceId).filter(a => automationOwned(a.tenant, tenant)).map(({ delivery, ...a }) => ({ ...a, delivery: delivery ? { url: delivery.url, configured: true } : null })); }
  private owned(tenant: TenantContext, id: string) { const a = this.automations.get(id); if (!a || !automationOwned(a.tenant, tenant)) throw new WorkspaceError(404, '自动化不存在'); return a; }
  create(tenant: TenantContext, value: unknown) {
    const v = value as Record<string, unknown>;
    if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120) throw new WorkspaceError(400, '名称须为1至120字符');
    if (this.list(tenant).length >= 100) throw new WorkspaceError(409, '每账号最多100个自动化');
    const schedule = structuredClone(v.schedule) as AutomationSchedule; const nextRunAt = nextAutomationTime(schedule, this.now());
    if (nextRunAt === null) throw new WorkspaceError(400, '一次性运行时间必须晚于当前时间');
    const delivery = validateAutomationDelivery(v.delivery);
    const a: Automation = { id: randomUUID(), tenant, name: v.name.trim(), input: validateAutomationInput(v.input), schedule, enabled: v.enabled !== false, nextRunAt, createdAt: this.now(), ...(delivery ? { delivery } : {}) };
    this.automations.put(a); return this.list(tenant).find(item => item.id === a.id)!;
  }
  setEnabled(tenant: TenantContext, id: string, enabled: boolean) { const a = this.owned(tenant, id); const nextRunAt = enabled ? nextAutomationTime(a.schedule, this.now()) : a.nextRunAt; if (enabled && nextRunAt === null) throw new WorkspaceError(409, '一次性计划已到期，请新建计划'); this.automations.put({ ...a, enabled, nextRunAt }); }
  remove(tenant: TenantContext, id: string) { this.owned(tenant, id); this.automations.remove(id); }
  history(tenant: TenantContext) { return this.occurrences.listByTenant(tenant.tenantId, tenant.workspaceId).filter(o => automationOwned(o.tenant, tenant)).sort((a,b) => b.createdAt - a.createdAt).slice(0,200).map(({ input: _input, delivery: _delivery, ...o }) => o); }
  deliveriesFor(tenant: TenantContext) { return this.outbox.listByTenant(tenant.tenantId, tenant.workspaceId).filter(o => automationOwned(o.tenant, tenant)).slice(-200).map(({ target, body: _body, ...o }) => ({ ...o, channel:isNativeDelivery(target)?target.kind:'webhook', url:isNativeDelivery(target)?(target.kind==='feishu'?'飞书私聊：':'企微私聊：')+target.recipient:target.url })); }
  async runNow(tenant: TenantContext, id: string) { const a = this.owned(tenant, id); return this.submitOccurrence(tenant, a.id, randomUUID(), a.input, a.delivery); }
  async submitOccurrence(tenant: TenantContext, sourceId: string, slot: string, input: AutomationInput, delivery?: AutomationResultDelivery, scheduledAt = this.now()) {
    const id = automationDigest(JSON.stringify([tenant.tenantId, tenant.workspaceId, tenant.userId, sourceId, slot]));
    let item = this.occurrences.get(id);
    if (!item) { item = { id, tenant, sourceId, scheduledAt, input: { ...input, idempotencyKey: 'automation:' + id }, state: 'pending', createdAt: this.now(), ...(delivery ? { delivery } : {}) }; if (!this.occurrences.create(item)) throw new WorkspaceError(409, '触发记录不可读取，须人工核对'); }
    return this.dispatch(item);
  }
  private async dispatch(item: AutomationOccurrence): Promise<AutomationOccurrence> {
    const active = this.submissions.get(item.id); if (active) return active;
    if (!['pending','submitting'].includes(item.state)) return item;
    const promise = (async () => {
      this.occurrences.put({ ...item, state: 'submitting' });
      try { const result = await this.deps.submitTask(item.tenant, item.input); const current = this.occurrences.get(item.id); if (current?.state === 'cancelled') { await this.deps.cancelTask(item.tenant, result.taskId, '用户取消自动化触发'); item = { ...current, ...result }; } else item = { ...item, ...result, state: 'submitted' }; }
      catch { item = { ...item, state: 'uncertain', error: '提交失败或结果不确定，请核对任务后手动重试，系统不会重复提交' }; }
      this.occurrences.put(item); return item;
    })().finally(() => this.submissions.delete(item.id));
    this.submissions.set(item.id, promise); return promise;
  }
  async cancelOccurrence(tenant: TenantContext, id: string) { const item = this.occurrences.get(id); if (!item || !automationOwned(item.tenant, tenant)) throw new WorkspaceError(404, '触发记录不存在'); if (item.taskId) await this.deps.cancelTask(tenant, item.taskId, '用户取消自动化触发'); this.occurrences.put({ ...item, state: 'cancelled' }); }
  deliveryAction(tenant: TenantContext, id: string, action: 'retry' | 'cancel') {
    const item = this.outbox.get(id); if (!item || !automationOwned(item.tenant, tenant)) throw new WorkspaceError(404, '投递记录不存在');
    if (item.state === 'delivered') throw new WorkspaceError(409, '已成功投递');
    if (action === 'retry' && item.state === 'sending') throw new WorkspaceError(409, '投递进行中');
    this.deliveries.get(id)?.abort(); this.outbox.put({ ...item, state: action === 'cancel' ? 'cancelled' : 'pending', attempts: action === 'retry' ? 0 : item.attempts, nextAttemptAt: this.now() });
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      for (const a of this.automations.all()) {
        if (!a.enabled || a.nextRunAt === null || a.nextRunAt > this.now()) continue;
        // 补跑最早漏掉的一次，随后跳到当前之后，避免停机后风暴。
        await this.submitOccurrence(a.tenant, a.id, String(a.nextRunAt), a.input, a.delivery, a.nextRunAt);
        const current = this.automations.get(a.id); if (current) { const nextRunAt = nextAutomationTime(a.schedule, this.now()); this.automations.put({ ...current, nextRunAt, enabled: nextRunAt !== null && current.enabled }); }
      }
      for (let item of this.occurrences.all()) {
        if (item.state === 'pending' || item.state === 'submitting') item = await this.dispatch(item);
        if (item.state !== 'submitted' || !item.taskId) continue;
        const task = this.deps.getTask(item.tenant, item.taskId) as { status?: string } | undefined;
        if (!task) { this.occurrences.put({ ...item, state: 'uncertain', error: '已提交任务暂不可读取，请核对任务存储' }); continue; }
        if (!['SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(task.status ?? '')) continue;
        const final = { ...item, state: task.status === 'SUCCEEDED' ? 'completed' as const : task.status === 'CANCELLED' ? 'cancelled' as const : 'failed' as const, taskStatus: task.status! };
        if (item.delivery) {
          const result = this.deps.getResult?.(item.tenant,item.taskId);
          this.outbox.create({ id: item.id, tenant: item.tenant, occurrenceId: item.id, target: item.delivery, body: JSON.stringify({ eventId: item.id, type: 'task.completed', taskId: item.taskId, status: task.status, ...(result ? { result: { ...(result.text ? { text:result.text.slice(0,32000) } : {}), artifacts:(result.artifacts ?? []).slice(0,100) } } : {}) }), state: 'pending', attempts: 0, nextAttemptAt: this.now() });
        }
        this.occurrences.put(final);
      }
      for (const item of this.outbox.all()) {
        if (item.state === 'sending' && isNativeDelivery(item.target)) { this.outbox.put({...item,state:'failed',error:'原生消息发送期间进程中断，接收结果不确定；请核对后手动重试'}); continue; }
        if ((item.state === 'pending' || item.state === 'sending') && item.nextAttemptAt <= this.now()) await this.deliver(item);
      }
      this.lastError = undefined;
    } finally { this.busy = false; }
  }
  private async deliver(item: AutomationOutbox) {
    const controller = new AbortController(); this.deliveries.set(item.id, controller); const timeout = setTimeout(() => controller.abort(), 10000);
    const attempts = item.attempts + 1; this.outbox.put({ ...item, state: 'sending', attempts });
    try {
      let response:Response;
      if (isNativeDelivery(item.target)) response = await this.nativeSender.send(item.target,item.body,item.id,controller.signal);
      else {
        const timestamp = String(Math.floor(this.now()/1000));
        const signature = createHmac('sha256', item.target.secret).update(timestamp + '.' + item.body).digest('hex');
        response = await (this.deps.fetch ?? outboundFetch('', 65536))(item.target.url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-tao-event-id': item.id, 'x-tao-timestamp': timestamp, 'x-tao-signature': signature }, body: item.body });
      }
      await response.body?.cancel();
      if (this.outbox.get(item.id)?.state === 'cancelled') return;
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = response.headers.get('retry-after'); const seconds = retryAfter ? Number(retryAfter) : NaN;
      const retryDelay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - this.now() : 0;
      const {error:_previousError,...cleanItem}=item;
      this.outbox.put({ ...cleanItem, attempts, lastStatus: response.status, state: response.ok ? 'delivered' : retryable && attempts < 5 ? 'pending' : 'failed', nextAttemptAt: this.now() + Math.min(86400000, Math.max(1000 * 2 ** attempts, retryDelay || 0)), ...(response.ok ? {} : { error: '接收方返回非成功状态' }) });
    } catch (error) {
      if (this.outbox.get(item.id)?.state !== 'cancelled') this.outbox.put({ ...item, attempts, state: error instanceof NativeDeliveryUncertainError ? 'failed' : attempts < 5 ? 'pending' : 'failed', nextAttemptAt: this.now() + 1000 * 2 ** attempts, error: error instanceof NativeDeliveryUncertainError ? error.message : '投递失败、超时或出网策略拒绝' });
    } finally { clearTimeout(timeout); this.deliveries.delete(item.id); }
  }
}
