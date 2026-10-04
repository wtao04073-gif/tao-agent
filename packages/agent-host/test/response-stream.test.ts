import { expect, it, vi } from "vitest";
import { ResponseStream } from "../src/response-stream.ts";
it("首个增量立即保存快照，批次更新可恢复且文本和思考隔离",async()=>{
 const delta=vi.fn(),snapshot=vi.fn(),s=new ResponseStream({delta,snapshot,intervalMs:5});const id=s.begin("run");
 s.append("run","answer","你");s.append("run","answer","好");s.append("run","thinking","公开思考");
 expect(delta.mock.calls.slice(0,2)).toEqual([["answer",id,"你",0],["answer",id,"好",1]]);
 expect(snapshot).toHaveBeenCalledWith("answer",id,"你",false);
 await vi.waitFor(()=>expect(snapshot).toHaveBeenCalledWith("answer",id,"你好",false));
 s.end("run");expect(snapshot).toHaveBeenCalledWith("thinking",id,"公开思考",true);
 const count=snapshot.mock.calls.length;s.close();expect(snapshot).toHaveBeenCalledTimes(count);
 expect(s.begin("run")).not.toBe(id);
});
it("执行中断也保存最新部分结果并清理计时器",()=>{
 const snapshot=vi.fn(),s=new ResponseStream({delta:()=>{},snapshot});s.append("run","answer","部分回答");s.close();
 expect(snapshot).toHaveBeenLastCalledWith("answer",expect.any(String),"部分回答",true);
});
