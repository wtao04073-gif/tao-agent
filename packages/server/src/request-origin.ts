import type { IncomingMessage } from 'node:http';

/** 精确公开来源白名单；不信任可由客户端伪造的转发头。 */
export function createOriginPolicy(configured = ''): (req: IncomingMessage) => boolean {
 const allowed = new Set<string>();
 for (const value of configured.split(',').map(s=>s.trim()).filter(Boolean)) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('TAO_PUBLIC_ORIGINS 必须为逗号分隔的 HTTP(S) 来源，不含路径、凭据或通配符');
  allowed.add(url.origin);
 }
 return req => {
  const value = req.headers.origin;
  // 非浏览器调用仍由令牌鉴权；Cookie 写请求另外校验 CSRF。
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  try {
   const url = new URL(value);
   if (!['http:','https:'].includes(url.protocol) || value !== url.origin) return false;
   if (allowed.has(url.origin)) return true;
   const protocol = (req.socket as {encrypted?:boolean}).encrypted ? 'https:' : 'http:';
   return url.origin === new URL(protocol+'//'+req.headers.host).origin;
  } catch { return false; }
 };
}
