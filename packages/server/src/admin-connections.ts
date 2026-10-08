import { createHash } from 'node:crypto';
import { existsSync,readFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson,type Values } from './admin-settings.ts';
export type ConnectionType='model'|'lite'|'evaluation'|'embedding'|'search'|'mcp'|'sandbox';
interface Check { fingerprint:string;ok:boolean;at:number }
const prefixes={model:['MODEL_'],lite:['MODEL_LITE_'],evaluation:['EVAL_MODEL_'],embedding:['EMBEDDING_'],search:['SEARCH_'],mcp:['MCP_'],sandbox:['SANDBOX_']};
function fingerprint(type:ConnectionType,values:Values){return createHash('sha256').update(JSON.stringify(Object.entries(values).filter(([key])=>prefixes[type].some(prefix=>key.startsWith(prefix))||['NETWORK_ALLOWED_CIDRS','ALLOW_OUTBOUND_NETWORK'].includes(key)).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');}
/** 仅记录配置指纹和结果，改动后旧测试不再代表新配置可用。 */
export class ConnectionChecks {
 private path:string;private checks:Partial<Record<ConnectionType,Check>>={};
 constructor(root:string){mkdirSync(join(root,'.admin'),{recursive:true,mode:0o700});this.path=join(root,'.admin','connection-checks.json');if(existsSync(this.path)){try{this.checks=JSON.parse(readFileSync(this.path,'utf8'));}catch{}}}
 record(type:ConnectionType,values:Values,ok:boolean){this.checks[type]={fingerprint:fingerprint(type,values),ok,at:Date.now()};atomicJson(this.path,this.checks);}
 status(values:Values){return (Object.keys(prefixes) as ConnectionType[]).map(type=>{const configured=type==='sandbox'?values.SANDBOX_ENABLED==='true':type==='model'?!!(values.MODEL_NAME&&values.MODEL_BASE_URL&&values.MODEL_API_KEY):type==='lite'?!!(values.MODEL_LITE_NAME&&values.MODEL_LITE_BASE_URL&&values.MODEL_LITE_API_KEY):type==='evaluation'?!!(values.EVAL_MODEL_NAME&&values.EVAL_MODEL_BASE_URL&&values.EVAL_MODEL_API_KEY):type==='embedding'?!!(values.EMBEDDING_ENDPOINT&&values.EMBEDDING_MODEL):type==='search'?values.SEARCH_ENABLED==='true'&&!!values.SEARCH_API_KEY:values.MCP_ENABLED==='true'&&!!values.MCP_URL;const c=this.checks[type],matches=c?.fingerprint===fingerprint(type,values);return {type,status:!configured?'unconfigured':!matches?'unverified':c?.ok?'available':'failed',checkedAt:matches?c!.at:null};});}
}
