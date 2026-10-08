import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AutomationManager,type AutomationDeps} from '../src/automation.ts';

const directories:string[]=[];const managers:AutomationManager[]=[];
afterEach(()=>{for(const manager of managers.splice(0))manager.stop();for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
async function until(condition:()=>boolean){const deadline=Date.now()+5000;while(!condition()){if(Date.now()>deadline)throw new Error('真实调度未在期限内触发');await new Promise(resolve=>setTimeout(resolve,20));}}

it('真实start计时一次性调度、暂停、取消及重启恢复，无外部投递',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tao-real-clock-'));directories.push(dir);const tenant={tenantId:'real-clock',workspaceId:'workspace',userId:'owner'};const submitted:{taskId:string;query:string;at:number;idempotencyKey?:string}[]=[];const statuses=new Map<string,string>();const startedAt=Date.now();let outbound=0;
  const deps:AutomationDeps={dir,submitTask:async(_tenant,input)=>{const taskId='task-'+(submitted.length+1);submitted.push({taskId,query:String(input.fields.query),at:Date.now(),...(input.idempotencyKey?{idempotencyKey:input.idempotencyKey}:{})});statuses.set(taskId,'RUNNING');return{taskId,conversationId:taskId};},cancelTask:async(_tenant,id)=>{statuses.set(id,'CANCELLED');},getTask:(_tenant,id)=>statuses.has(id)?{status:statuses.get(id)}:undefined,fetch:async()=>{outbound++;throw new Error('本用例禁止任何出网');}};
  const first=new AutomationManager(deps);managers.push(first);
  const create=(name:string,delay:number)=>first.create(tenant,{name,input:{scenarioId:'general.free-task',fields:{query:name}},schedule:{kind:'once',at:new Date(startedAt+delay).toISOString()}});
  create('第一次真实触发',400);const paused=create('暂停后不得触发',400);first.setEnabled(tenant,paused.id,false);
  first.start();await until(()=>first.history(tenant).some(item=>item.taskId==='task-1'));expect(submitted).toHaveLength(1);expect(submitted[0]!.at).toBeGreaterThanOrEqual(startedAt+400);expect(submitted[0]!.query).toBe('第一次真实触发');
  const secondDueAt=Date.now()+400;create('重启后真实触发',secondDueAt-startedAt);
  await first.cancelOccurrence(tenant,first.history(tenant)[0]!.id);expect(statuses.get('task-1')).toBe('CANCELLED');first.stop();expect(first.health().running).toBe(false);
  const recovered=new AutomationManager(deps);managers.push(recovered);expect(recovered.history(tenant)[0]!.state).toBe('cancelled');expect(recovered.list(tenant).find(item=>item.id===paused.id)?.enabled).toBe(false);recovered.start();await until(()=>recovered.history(tenant).some(item=>item.taskId==='task-2'));recovered.stop();
  expect(submitted).toHaveLength(2);expect(submitted[1]!.query).toBe('重启后真实触发');expect(submitted[1]!.at).toBeGreaterThanOrEqual(secondDueAt);expect(new Set(submitted.map(item=>item.idempotencyKey)).size).toBe(2);expect(recovered.list(tenant).every(item=>!item.enabled)).toBe(true);
  const secondRecovery=new AutomationManager(deps);managers.push(secondRecovery);secondRecovery.start();await new Promise(resolve=>setTimeout(resolve,40));secondRecovery.stop();expect(submitted).toHaveLength(2);expect(outbound).toBe(0);
  console.info(JSON.stringify({clock:'real',firstTriggerAfterMs:submitted[0]!.at-startedAt,restartedTriggerAfterMs:submitted[1]!.at-startedAt,submissions:submitted.length,cancelledTask:statuses.get('task-1'),pausedPlanTriggered:false,restartDuplicateSubmissions:0,outboundRequests:outbound}));
},10000);
