import type { TaoExtensionDefinition, ExtensionContext } from '@tao/core';
/** 受信本地TS示例：无网络、无文件写入，每个用户的事件计数分开保存。 */
export default {
 id:'office',name:'办公扩展示例',version:'1.0.0',
 setup(api) {
  const activity=new Map<string,number>();
  const scope=(c:ExtensionContext)=>JSON.stringify([c.tenant.tenantId,c.tenant.workspaceId,c.tenant.userId]);
  const stop=api.on('session_start',(_event,ctx)=>{if(activity.size>=1000&&!activity.has(scope(ctx)))activity.delete(activity.keys().next().value!);activity.set(scope(ctx),(activity.get(scope(ctx))??0)+1);});
  api.onDispose(()=>{stop();activity.clear();});
  api.registerCommand({name:'calculate',description:'计算含税金额并展示交互结果卡，不调用模型或外部服务',parameters:{type:'object',properties:{amount:{type:'number',minimum:0,maximum:100000000},rate:{type:'number',minimum:0,maximum:100}},required:['amount','rate'],additionalProperties:false},async handler(args,ctx){const amount=Number(args.amount),rate=Number(args.rate),total=Math.round(amount*(1+rate/100)*100)/100;return {text:`含税金额：${total}`,ui:api.renderUI('invoice',{amount,rate,total,sessions:activity.get(scope(ctx))??0})};}});
  api.registerCommand({name:'panel',description:'打开办公计算表单，演示自定义Web组件',parameters:{type:'object',properties:{},additionalProperties:false},async handler(){return {text:'请填写金额与税率',ui:api.renderUI('calculator',{})};}});
  api.registerUI('calculator',()=>({type:'form',title:'含税金额计算',command:'office:calculate',submitLabel:'计算',fields:[{name:'amount',label:'未税金额',type:'number',required:true},{name:'rate',label:'税率（%）',type:'number',required:true}]}));
  api.registerUI('invoice',data=>{const d=data as Record<string,number>;return {type:'card',title:'计算结果',children:[{type:'table',columns:['项目','值'],rows:[['未税金额',d.amount!],['税率（%）',d.rate!],['含税金额',d.total!]]},{type:'button',label:'重新计算',command:'office:panel',args:{}}]};});
  api.registerTool({name:'calculate_tax',label:'计算含税金额',description:'精确计算未税金额和税率对应的含税总额，并向用户展示交互结果卡。',parameters:{type:'object',properties:{amount:{type:'number',minimum:0,maximum:100000000},rate:{type:'number',minimum:0,maximum:100}},required:['amount','rate'],additionalProperties:false},policy:{requiresConfirm:false},replay:'safe',async execute({args,signal}){signal.throwIfAborted();const {amount,rate}=args as {amount:number;rate:number};const total=Math.round(amount*(1+rate/100)*100)/100;return {text:JSON.stringify({amount,rate,total}),ui:api.renderUI('invoice',{amount,rate,total})};}});
 }
} satisfies TaoExtensionDefinition;
