import { createServer } from 'node:http';
import { connect } from 'node:net';
import { expect, it } from 'vitest';
import { installClientErrorHandler } from '../src/http-errors.ts';

it('HTTP解析阶段拒绝裸中文时仍返回JSON 400与完整长度',async()=>{
 const server=createServer((_req,res)=>res.end('{}'));installClientErrorHandler(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const response=await new Promise<string>((resolve,reject)=>{const socket=connect((server.address() as {port:number}).port,'127.0.0.1',()=>socket.write('GET /?q=查询 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));let data='';socket.setEncoding('utf8');socket.on('data',chunk=>data+=chunk);socket.on('end',()=>resolve(data));socket.on('error',reject);socket.setTimeout(3000,()=>{socket.destroy();reject(Error('timeout'));});});const [headers,body]=response.split('\r\n\r\n');expect(headers).toContain('400 Bad Request');expect(headers).toContain('application/json');expect(headers).toContain('Content-Length: '+Buffer.byteLength(body!));expect(JSON.parse(body!)).toHaveProperty('error');}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
