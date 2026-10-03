import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { HttpEmbeddings } from "../src/embeddings.ts";
const servers:Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
async function mock(reply:(body:any)=>unknown) {
 const calls:any[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(reply(body)));});
 servers.push(server);await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));return {calls,endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/embeddings`};
}
it("真实HTTP分批嵌入、乱序返回排序、规范化及模型前缀",async()=>{
 const {calls,endpoint}=await mock(b=>({data:b.input.map((_v:unknown,i:number)=>({index:i,embedding:[3,4]})).reverse()}));
 const provider=new HttpEmbeddings({endpoint,model:"embedding-model",documentPrefix:"passage: ",queryPrefix:"query: "});
 expect(await provider.embed(Array.from({length:17},()=>"汽车"),"document")).toEqual(Array.from({length:17},()=>[0.6,0.8]));
 expect(calls.map(b=>b.input.length)).toEqual([16,1]);expect(calls[0].input[0]).toBe("passage: 汽车");
 await provider.embed(["交通工具"],"query");expect(calls[2].input[0]).toBe("query: 交通工具");
 expect(new HttpEmbeddings({endpoint,model:"embedding-model",revision:"2"}).space).not.toBe(provider.space);
});
it.each([
 {data:[{index:0,embedding:[0,0]}]},
 {data:[{index:0,embedding:[1,0,0]}]},
 {data:[{index:1,embedding:[1,0]}]},
 {data:[]},
])("拒绝异常向量响应 %j",async body=>{
 const {endpoint}=await mock(()=>body);await expect(new HttpEmbeddings({endpoint,model:"test",dimensions:2}).embed(["文本"],"document")).rejects.toThrow();
});
it("取消不会发出请求，URL不能内嵌凭据",async()=>{
 const {endpoint,calls}=await mock(()=>({data:[]}));
 await expect(new HttpEmbeddings({endpoint,model:"test"}).embed(["文本"],"query",AbortSignal.abort())).rejects.toThrow();expect(calls).toHaveLength(0);
 expect(()=>new HttpEmbeddings({endpoint:"https://name:password@example.com/embed",model:"test"})).toThrow("不含凭据");
});
