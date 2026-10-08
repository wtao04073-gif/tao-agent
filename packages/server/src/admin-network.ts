import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { AdminError } from './admin-settings.ts';

const forbidden = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) forbidden.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['fe80::', 10], ['ff00::', 8]] as const) forbidden.addSubnet(address, prefix, 'ipv6');
const privateRanges = new BlockList();
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['127.0.0.0', 8]] as const) privateRanges.addSubnet(address, prefix, 'ipv4');
privateRanges.addSubnet('fc00::', 7, 'ipv6');privateRanges.addAddress('::1', 'ipv6');

export function networkPolicy(cidrs = '') {
 const allowed = new BlockList();
 for (const item of cidrs.split(',').map(s => s.trim()).filter(Boolean)) {
  const [address, prefix] = item.split('/');const family = isIP(address!);
  if (!family || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) throw new AdminError(400, '允许网段须为逗号分隔的 IP 或 CIDR');
  if (prefix === undefined) allowed.addAddress(address!, family === 4 ? 'ipv4' : 'ipv6');
  else allowed.addSubnet(address!, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
 }
 return (address: string) => {
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  // BlockList 同时识别 IPv4-mapped IPv6，避免绕过私网和元数据策略。
  if (forbidden.check(address, family) || (privateRanges.check(address, family) && !allowed.check(address, family))) throw new AdminError(400, '目标地址被出网策略拒绝，请部署管理员检查允许网段');
 };
}

/** DNS 只解析一次，连接固定已检查的 IP；Host 与 TLS servername 保持原主机。 */
export function outboundFetch(cidrs = '', maxBytes = 8 * 1024 * 1024, allowRedirectResponses=false): typeof fetch {
 const check = networkPolicy(cidrs);
 return async (input, init) => {
  const request = new Request(input, init);const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new AdminError(400, '服务地址无效');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{address: hostname, family: isIP(hostname)}] : await lookup(hostname, {all: true});
  request.signal.throwIfAborted();if (!addresses.length) throw new AdminError(400, '服务地址无法解析');
  for (const item of addresses) check(item.address);
  const target = addresses.find(item=>item.family===4) ?? addresses[0]!;
  const headers = Object.fromEntries(request.headers);headers['accept-encoding'] = 'identity';
  delete headers.host;delete headers.connection;delete headers['content-length'];
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body && body.length > 8 * 1024 * 1024) throw new AdminError(400, '请求内容过大');
  return await new Promise<Response>((resolve, reject) => {
   const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
   const req = transport(url, {method: request.method, headers, agent: false, family:target.family, signal: request.signal,
    lookup: (_host, _options, callback) => callback(null, target.address, target.family)}, res => {
    const status = res.statusCode || 502;
    if (!allowRedirectResponses && status >= 300 && status < 400) {res.destroy();reject(new AdminError(502, '服务不允许重定向'));return;}
    const responseHeaders = new Headers();for (const [key,value] of Object.entries(res.headers)) if(value!==undefined) responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);
    if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {res.destroy();reject(new AdminError(502, '服务未遵守响应编码要求'));return;}
    if (request.method === 'HEAD' || [204,205,304].includes(status)) {res.resume();resolve(new Response(null,{status,headers:responseHeaders}));return;}
    let bytes = 0;const source = Readable.toWeb(res) as ReadableStream<Uint8Array>;
    const bounded = source.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>maxBytes){controller.error(new AdminError(502,'服务响应超过大小限制'));res.destroy();}else controller.enqueue(chunk);}}));
    resolve(new Response(bounded,{status,headers:responseHeaders}));
   });
   req.on('error', () => reject(new AdminError(502,'服务连接失败、取消或超时')));req.end(body);
  });
 };
}
