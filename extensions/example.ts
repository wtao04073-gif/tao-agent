/** 受信部署示例。只使用可擦除 TS 语法，无外部操作。 */
import type { TaoExtensionDefinition } from '@tao/core';
const extension: TaoExtensionDefinition = {
  id: 'example', name: '算数与界面示例', version: '1.0.0',
  setup(api) {
    const counts=new Map<string,number>();
    const parameters={type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b'],additionalProperties:false};
    api.registerUI('result', data => {
      const {a,b,total}=data as {a:number;b:number;total:number};
      return {type:'card',title:'加法结果',children:[
        {type:'table',columns:['第一项','第二项','结果'],rows:[[a,b,total]]},
        {type:'form',title:'再算一次',command:'example:add',fields:[{name:'a',label:'第一项',type:'number',required:true},{name:'b',label:'第二项',type:'number',required:true}],submitLabel:'计算'},
      ]};
    });
    api.registerCommand({name:'add',description:'计算两个数的和，并显示结果表格',parameters,async handler(args){const a=args.a as number,b=args.b as number,total=a+b;return {text:`${a} + ${b} = ${total}`,ui:api.renderUI('result',{a,b,total})};}});
    api.registerTool({name:'add',label:'计算加法',description:'计算两个数的和',parameters,replay:'safe',async execute({args}){const {a,b}=args as {a:number;b:number};return {text:String(a+b),ui:api.renderUI('result',{a,b,total:a+b})};}});
    api.on('session_start',(_event,context)=>{const key=JSON.stringify([context.tenant.tenantId,context.tenant.workspaceId,context.tenant.userId,context.taskId]);counts.set(key,0);});
    api.on('after_prompt',(_event,context)=>{const key=JSON.stringify([context.tenant.tenantId,context.tenant.workspaceId,context.tenant.userId,context.taskId]);counts.set(key,(counts.get(key)??0)+1);});
    api.on('session_end',(_event,context)=>{counts.delete(JSON.stringify([context.tenant.tenantId,context.tenant.workspaceId,context.tenant.userId,context.taskId]));});
    api.onDispose(()=>counts.clear());
  },
};
export default extension;
