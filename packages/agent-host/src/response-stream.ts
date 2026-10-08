/** 模型输出的增量和可恢复快照。只接收 provider 已返回的文本，不生成思考内容。 */
export class ResponseStream {
 private counter=0;
 private readonly current=new Map<string,string>();
 private readonly buffers=new Map<string,{messageId:string;channel:"answer"|"thinking";text:string;timer?:ReturnType<typeof setTimeout>|undefined}>();
 constructor(privateOptions:{delta:(kind:"answer"|"thinking",id:string,delta:string,offset:number)=>void;snapshot:(kind:"answer"|"thinking",id:string,text:string,complete:boolean)=>void;intervalMs?:number}) {this.options=privateOptions;}
 private readonly options:{delta:(kind:"answer"|"thinking",id:string,delta:string,offset:number)=>void;snapshot:(kind:"answer"|"thinking",id:string,text:string,complete:boolean)=>void;intervalMs?:number};
 begin(runId="run"):string {const id=`${runId}:message-${++this.counter}`;this.current.set(runId,id);return id;}
 id(runId="run"):string {return this.current.get(runId)??this.begin(runId);}
 append(runId:string|undefined,channel:"answer"|"thinking",delta:string):void {
  const messageId=this.id(runId),key=messageId+":"+channel;
  let buffer=this.buffers.get(key);
  if(!buffer){buffer={messageId,channel,text:""};this.buffers.set(key,buffer);}
  const offset=buffer.text.length;buffer.text+=delta;
  this.options.delta(channel,messageId,delta,offset);
  if(offset===0)this.options.snapshot(channel,messageId,buffer.text,false);
  if(!buffer.timer){buffer.timer=setTimeout(()=>{buffer!.timer=undefined;this.options.snapshot(channel,messageId,buffer!.text,false);},this.options.intervalMs??1000);buffer.timer.unref();}
 }
 end(runId?:string):string {const id=this.id(runId);for(const [key,buffer] of this.buffers)if(buffer.messageId===id){this.flush(buffer,true);this.buffers.delete(key);}return id;}
 close():void {for(const buffer of this.buffers.values())this.flush(buffer,true);this.buffers.clear();}
 private flush(buffer:{messageId:string;channel:"answer"|"thinking";text:string;timer?:ReturnType<typeof setTimeout>|undefined},complete:boolean):void {
  if(buffer.timer)clearTimeout(buffer.timer);buffer.timer=undefined;
  this.options.snapshot(buffer.channel,buffer.messageId,buffer.text,complete);
 }
}
