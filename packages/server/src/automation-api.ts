import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson, type AppDeps } from './app.ts';
import { WorkspaceError } from './workspace-services.ts';
import { AutomationManager } from './automation.ts';
import { ConnectorManager } from './connector-inbound.ts';
import { CONNECTOR_CATALOG, EXPERT_TEMPLATES } from './connector-catalog.ts';

/** 复用宿主 authenticate（包括 Cookie CSRF 与账号停用检查），入站回调独立验签。 */
export function createAutomationHandler(deps: { authenticate: AppDeps['authenticate']; automation: AutomationManager; connectors: ConnectorManager; assertInbound?: (tenantId: string, req: IncomingMessage) => void }) {
  const windows = new Map<string, { count: number; until: number }>();
  const limit = (key: string, max: number) => {
    const now = Date.now();
    if (windows.size > 10000) for (const [key,value] of windows) if (value.until <= now) windows.delete(key);
    let slot = windows.get(key); if (!slot || slot.until <= now) { slot = { count:0, until:now+60000 }; windows.set(key,slot); }
    if (++slot.count > max) throw new WorkspaceError(429,'请求过于频繁，请稍后重试');
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost'); const p = url.pathname.split('/').filter(Boolean);
    if (p[0] !== 'api' || !['automations','connectors'].includes(p[1] ?? '')) return false;
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    try {
      const method = req.method ?? 'GET';
      if (p[1] === 'connectors' && p[2] === 'inbound' && p.length === 4) {
        limit('ip:' + req.socket.remoteAddress,120); limit('connector:' + p[3],60);
        deps.assertInbound?.(deps.connectors.tenantForInbound(p[3]!),req);
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const value of req) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); bytes += chunk.length; if (bytes > 65536) throw new WorkspaceError(413,'事件请求体超过64KB'); chunks.push(chunk); }
        const headers = Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
        const result = await deps.connectors.receive(p[3]!,Buffer.concat(chunks).toString('utf8'),headers,url.searchParams,method);
        if (result.type === 'json') sendJson(res,200,result.value); else { res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}); res.end(String(result.value)); }
        return true;
      }
      const principal = await deps.authenticate(req); if (!principal) throw new WorkspaceError(401,'请先登录'); const tenant = principal.tenant;
      limit('user:' + JSON.stringify(tenant),120);
      let body: Record<string,unknown> = {};
      if (method === 'POST' || method === 'PATCH') { const parsed = await readJsonBody(req); if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) throw new WorkspaceError(400,'请求参数须为JSON对象'); body = parsed.value as Record<string,unknown>; }
      if (p[1] === 'automations') {
        if (method === 'GET' && p.length === 2) sendJson(res,200,{ automations:deps.automation.list(tenant), health:deps.automation.health() });
        else if (method === 'POST' && p.length === 2) sendJson(res,201,{ automation:deps.automation.create(tenant,body) });
        else if (method === 'GET' && p[2] === 'history' && p.length === 3) sendJson(res,200,{ occurrences:deps.automation.history(tenant) });
        else if (method === 'GET' && p[2] === 'deliveries' && p.length === 3) sendJson(res,200,{ deliveries:deps.automation.deliveriesFor(tenant) });
        else if (method === 'POST' && p[2] === 'deliveries' && p.length === 5 && ['retry','cancel'].includes(p[4]!)) { deps.automation.deliveryAction(tenant,p[3]!,p[4] as 'retry'|'cancel'); sendJson(res,200,{ok:true}); }
        else if (method === 'POST' && p[2] === 'occurrences' && p.length === 5 && p[4] === 'cancel') { await deps.automation.cancelOccurrence(tenant,p[3]!); sendJson(res,200,{ok:true}); }
        else if (method === 'POST' && p.length === 4 && p[3] === 'run') { const { input:_input,delivery:_delivery,...occurrence } = await deps.automation.runNow(tenant,p[2]!); sendJson(res,202,{occurrence}); }
        else if (method === 'PATCH' && p.length === 3 && typeof body.enabled === 'boolean') { deps.automation.setEnabled(tenant,p[2]!,body.enabled); sendJson(res,200,{ok:true}); }
        else if (method === 'DELETE' && p.length === 3) { deps.automation.remove(tenant,p[2]!); sendJson(res,200,{ok:true}); }
        else throw new WorkspaceError(404,'自动化接口不存在');
      } else {
        if (method === 'GET' && p.length === 2) sendJson(res,200,{ connectors:deps.connectors.list(tenant) });
        else if (method === 'GET' && p[2] === 'catalog' && p.length === 3) sendJson(res,200,{ connectors:CONNECTOR_CATALOG, experts:EXPERT_TEMPLATES });
        else if (method === 'POST' && p.length === 2) sendJson(res,201,{ connector:deps.connectors.create(tenant,body) });
        else if (method === 'PATCH' && p.length === 3 && typeof body.enabled === 'boolean') { deps.connectors.setEnabled(tenant,p[2]!,body.enabled); sendJson(res,200,{ok:true}); }
        else if (method === 'DELETE' && p.length === 3) { deps.connectors.remove(tenant,p[2]!); sendJson(res,200,{ok:true}); }
        else throw new WorkspaceError(404,'连接器接口不存在');
      }
    } catch (error) { const status = error instanceof WorkspaceError ? error.status : 500; if (status === 429) res.setHeader('Retry-After','60'); if (!res.headersSent) sendJson(res,status,{ error:error instanceof WorkspaceError ? error.message : '自动化服务暂不可用', code:status === 429 ? 'RATE_LIMITED' : status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST' }); }
    return true;
  };
}
