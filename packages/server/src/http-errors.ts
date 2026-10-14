import type { Server } from 'node:http';

/** HTTP 解析器拒绝非法 URL 时，仍返回可供前端读取的 JSON。 */
export function installClientErrorHandler(server: Server): void {
 server.on('clientError',(_error,socket)=>{
  if(!socket.writable)return;
  const body=JSON.stringify({error:'请求格式无效，请对查询参数使用URL编码'});
  socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);
 });
}
