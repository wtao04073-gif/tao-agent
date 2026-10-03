import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
class Element {
 children:Element[]=[];hidden=false;checked=false;className="";textContent="";type="";title="";
 handlers:Record<string,()=>void>={};constructor(readonly tag:string){}
 appendChild(node:Element){this.children.push(node);return node;}
 setAttribute(){}
 addEventListener(name:string,handler:()=>void){this.handlers[name]=handler;}
 querySelector(tag:string):Element|undefined{return this.children.find(n=>n.tag===tag);}
}
function setup(){
 const root=new Element("div"),answer=new Element("p");root.appendChild(answer);
 const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k),setItem:(k:string,v:string)=>data.set(k,v)};
 const context:any={module:{exports:{}},globalThis:{}};runInNewContext(readFileSync(new URL("../../../web/assets/run-display.js",import.meta.url),"utf8"),context);
 const create=context.module.exports.create,options={document:{createElement:(tag:string)=>new Element(tag)},storage,answerNode:()=>answer,currentBubble:()=>root,renderAnswer:(node:Element,text:string)=>{node.textContent=text;}};
 return {root,answer,create,options,display:create(options),data};
}
const event=(type:string,patch:any={})=>({type,taskId:"task",messageId:"m",...patch});
it("开关同步且持久化，关闭流式不显示片段但最终答案仍可见",()=>{
 const {display,root,answer,create,options}=setup();display.mount(root);display.mount(root);
 display.set("stream",false);display.consume(event("assistant_delta",{offset:0,delta:"片段"}));expect(answer.textContent).toBe("");
 display.consume(event("assistant_message",{text:"最终回答"}));expect(answer.textContent).toBe("最终回答");expect(create(options).preferences.stream).toBe(false);
 display.set("stream",true);expect(answer.textContent).toBe("最终回答");
});
it("快照补齐晚连接缺口，重复或延迟事件不重复追加、不覆盖定稿",()=>{
 const {display,answer}=setup();display.consume(event("assistant_delta",{offset:5,delta:"世界"}));expect(answer.textContent).toBe("");
 display.consume(event("message_progress",{channel:"answer",text:"你好世界",complete:false}));
 display.consume(event("assistant_delta",{offset:2,delta:"世界"}));expect(answer.textContent).toBe("你好世界");
 display.consume(event("assistant_delta",{offset:4,delta:"！"}));expect(answer.textContent).toBe("你好世界！");
 display.consume(event("assistant_message",{text:"完整回答"}));display.consume(event("message_progress",{channel:"answer",text:"旧快照",complete:true}));expect(answer.textContent).toBe("完整回答");
});
it("思考默认隐藏，开启后安全展示接口原文，正文不混入思考",()=>{
 const {display,root,answer}=setup();display.begin(root);
 display.consume(event("thinking_delta",{delta:"<script>思考原文</script>",offset:0}));
 const panel=root.children.find(n=>n.tag==="details")!;expect(panel.hidden).toBe(true);expect(answer.textContent).toBe("");
 display.set("thinking",true);expect(panel.hidden).toBe(false);expect(panel.children[1]?.textContent).toBe("<script>思考原文</script>");
 display.set("thinking",false);expect(panel.hidden).toBe(true);
});
it("历史可恢复当前片段和思考，继续流式不会丢前文",()=>{
 const {display,root,answer}=setup();display.history(root,[event("message_progress",{channel:"answer",text:"历史片段",complete:false}),event("message_progress",{channel:"thinking",text:"思考",complete:true})]);
 display.consume(event("assistant_delta",{offset:4,delta:"后续"}));expect(answer.textContent).toBe("历史片段后续");
 display.set("thinking",true);expect(root.children.find(n=>n.tag==="details")?.hidden).toBe(false);
});
