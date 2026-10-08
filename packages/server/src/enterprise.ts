import { BlockList, isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Role, type TenantContext } from '@tao/core';
import type { Principal } from './app.ts';
import { AutomationStore } from './automation-store.ts';
import { automationDigest } from './automation.ts';
import { WorkspaceError } from './workspace-services.ts';

export interface EnterpriseAccount { id: string; tenantId: string; userId: string; enabled: boolean }
export interface EnterpriseDepartment { id: string; name: string; parentId: string | null; accountIds: string[] }
export interface EnterprisePolicy { id: string; tenant: TenantContext; name: string; seatLimit: number | null; allowedCidrs: string[]; departments: EnterpriseDepartment[] }
export function requireEnterpriseAdmin(principal: Principal, tenantId = principal.tenant.tenantId) {
  if (principal.role !== Role.PlatformAdmin && (principal.role !== Role.TenantAdmin || principal.tenant.tenantId !== tenantId)) throw new WorkspaceError(403,'需要目标组织管理员权限');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tenantId) || tenantId === '.' || tenantId === '..') throw new WorkspaceError(400,'组织标识无效');
}
export function enterpriseCidrList(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string')) throw new WorkspaceError(400,'IP白名单须为最多100个IP或CIDR');
  const result = [...new Set(values.map(value => value.trim()))];
  for (const value of result) {
    const parts = value.split('/'); const family = isIP(parts[0]!);
    if (!family || parts.length > 2 || (parts[1] !== undefined && (!/^\d+$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128)))) throw new WorkspaceError(400,'IP或CIDR格式无效');
  }
  return result;
}
function matcher(values: readonly string[]) {
  const list = new BlockList();
  for (const value of values) { const [ip,prefix] = value.split('/'); const type = isIP(ip!) === 4 ? 'ipv4' : 'ipv6'; if (prefix === undefined) list.addAddress(ip!,type); else list.addSubnet(ip!,Number(prefix),type); }
  return (ip: string) => !!isIP(ip) && list.check(ip,isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}
/** 仅socket对端匹配部署级可信代理时使用XFF；从右向左跳过可信链。 */
export function enterpriseClientIp(req: Pick<IncomingMessage,'socket'|'headers'>, trustedProxies: readonly string[] = []): string {
  const remote = req.socket.remoteAddress ?? ''; const trusted = matcher(trustedProxies);
  if (!trusted(remote)) return remote;
  const forwarded = req.headers['x-forwarded-for']; if (!forwarded) return remote;
  if (typeof forwarded !== 'string') throw new WorkspaceError(403,'代理地址链无效');
  const chain = forwarded.split(',').map(value=>value.trim());
  if (chain.length > 16 || chain.some(value=>!isIP(value))) throw new WorkspaceError(403,'代理地址链无效');
  let current = remote;
  for (let i=chain.length-1; i>=0 && trusted(current); i--) current = chain[i]!;
  return current;
}

export class EnterpriseManager {
  private readonly policies: AutomationStore<EnterprisePolicy>;
  private readonly accounts: () => readonly EnterpriseAccount[];
  private readonly proxies: string[];
  private readonly reservations = new Map<string,number>();
  constructor(options: { dir: string; listAccounts: () => readonly EnterpriseAccount[]; trustedProxies?: string[] }) {
    this.policies = new AutomationStore(options.dir,'enterprise-policies'); this.accounts = options.listAccounts; this.proxies = enterpriseCidrList(options.trustedProxies ?? []);
  }
  private policy(tenantId: string): EnterprisePolicy { return this.policies.get(automationDigest(tenantId)) ?? { id:automationDigest(tenantId),tenant:{tenantId,workspaceId:'organization',userId:'system'},name:tenantId,seatLimit:null,allowedCidrs:[],departments:[] }; }
  view(principal: Principal, tenantId = principal.tenant.tenantId) { requireEnterpriseAdmin(principal,tenantId); const policy = this.policy(tenantId); return {...policy, seatsUsed:this.accounts().filter(a=>a.tenantId===tenantId&&a.enabled).length, trustedProxyConfigured:this.proxies.length>0}; }
  update(principal: Principal, input: unknown, tenantId = principal.tenant.tenantId) {
    requireEnterpriseAdmin(principal,tenantId); const value = input as Record<string,unknown>; if (!value || typeof value !== 'object') throw new WorkspaceError(400,'组织参数无效');
    const current = this.policy(tenantId); const updated = {...current};
    if (value.name !== undefined) { if (typeof value.name !== 'string' || !value.name.trim() || value.name.length>120) throw new WorkspaceError(400,'组织名称无效'); updated.name=value.name.trim(); }
    if (value.allowedCidrs !== undefined) updated.allowedCidrs = enterpriseCidrList(value.allowedCidrs);
    if (value.seatLimit !== undefined) {
      if (value.seatLimit !== null && (!Number.isInteger(value.seatLimit) || Number(value.seatLimit)<1 || Number(value.seatLimit)>1000000)) throw new WorkspaceError(400,'席位上限须为空或正整数');
      const used = this.accounts().filter(a=>a.tenantId===tenantId&&a.enabled).length + (this.reservations.get(tenantId)??0);
      if (value.seatLimit !== null && Number(value.seatLimit)<used) throw new WorkspaceError(409,'席位上限不能少于已启用账号及正在创建的席位'); updated.seatLimit=value.seatLimit as number|null;
    }
    this.policies.put(updated); return this.view(principal,tenantId);
  }
  upsertDepartment(principal: Principal, input: unknown, tenantId = principal.tenant.tenantId) {
    requireEnterpriseAdmin(principal,tenantId); const value=input as Record<string,unknown>; const p=this.policy(tenantId);
    if (!value || typeof value.name!=='string' || !value.name.trim() || value.name.length>120 || (value.id!==undefined && typeof value.id!=='string') || (value.parentId!==undefined&&value.parentId!==null&&typeof value.parentId!=='string')) throw new WorkspaceError(400,'部门名称或父部门无效');
    const id=typeof value.id==='string'?value.id:randomUUID(); const old=p.departments.find(d=>d.id===id);
    if(value.id!==undefined&&!old)throw new WorkspaceError(404,'部门不存在'); if(!old&&p.departments.length>=200)throw new WorkspaceError(409,'最多200个部门');
    const parentId=value.parentId===undefined?(old?.parentId??null):value.parentId as string|null;
    if(parentId!==null&&!p.departments.some(d=>d.id===parentId))throw new WorkspaceError(404,'父部门不存在');
    let parent=parentId;const visited=new Set([id]);while(parent!==null){if(visited.has(parent))throw new WorkspaceError(409,'部门不能循环引用');visited.add(parent);parent=p.departments.find(d=>d.id===parent)?.parentId??null;}
    const accountIds=value.accountIds===undefined?(old?.accountIds??[]):value.accountIds;
    if(!Array.isArray(accountIds)||accountIds.length>10000||accountIds.some(v=>typeof v!=='string'||!this.accounts().some(a=>a.id===v&&a.tenantId===tenantId)))throw new WorkspaceError(400,'部门成员须为本组织现有账号');
    const department={id,name:value.name.trim(),parentId,accountIds:[...new Set(accountIds as string[])]};p.departments=p.departments.filter(d=>d.id!==id).concat(department);this.policies.put(p);return department;
  }
  removeDepartment(principal: Principal,id:string,tenantId=principal.tenant.tenantId){requireEnterpriseAdmin(principal,tenantId);const p=this.policy(tenantId);if(!p.departments.some(d=>d.id===id))throw new WorkspaceError(404,'部门不存在');if(p.departments.some(d=>d.parentId===id))throw new WorkspaceError(409,'请先移动或删除子部门');p.departments=p.departments.filter(d=>d.id!==id);this.policies.put(p);}
  assertRequest(tenantId:string,req:Pick<IncomingMessage,'socket'|'headers'>){const allowed=this.policy(tenantId).allowedCidrs;if(allowed.length&&!matcher(allowed)(enterpriseClientIp(req,this.proxies)))throw new WorkspaceError(403,'当前来源IP不在组织白名单');}
  assertSeatAvailable(tenantId:string,accountId?:string){const limit=this.policy(tenantId).seatLimit;if(limit===null)return;const accounts=this.accounts().filter(a=>a.tenantId===tenantId&&a.enabled);if(accountId&&accounts.some(a=>a.id===accountId))return;if(accounts.length+(this.reservations.get(tenantId)??0)>=limit)throw new WorkspaceError(409,'组织席位已满，请停用账号或调整上限');}
  async withSeat<T>(tenantId:string,accountId:string|undefined,operation:()=>Promise<T>|T):Promise<T>{this.assertSeatAvailable(tenantId,accountId);const existing=accountId&&this.accounts().some(a=>a.id===accountId&&a.enabled&&a.tenantId===tenantId);if(existing)return operation();this.reservations.set(tenantId,(this.reservations.get(tenantId)??0)+1);try{return await operation();}finally{this.reservations.set(tenantId,Math.max(0,(this.reservations.get(tenantId)??1)-1));}}
}
