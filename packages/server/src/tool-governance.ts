/** 仅收紧现有权限门。返回 undefined 表示没有附加限制，绝不代表授权。 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PermissionGate, ToolDecision } from '@tao/core';
import { AdminError, type Values } from './admin-settings.ts';

export interface ToolGovernanceRule {
 readonly tool:string;
 readonly decision:'deny'|'confirm';
 /** 任务产物目录或沙箱 /workspace 下的逻辑相对路径。 */
 readonly pathPrefix?:string;
 /** 命令起始 token 的匹配，仅能拒绝或提高确认，不是 shell 授权规则。 */
 readonly commandPrefix?:string;
}
export interface ToolGovernancePolicy {
 readonly rules:readonly ToolGovernanceRule[];
 readonly disabledTools:readonly string[];
 readonly confirmWrites:boolean;
 readonly sensitiveInputMode:'warn'|'block'|'off';
}
export type GovernanceRequest=Parameters<PermissionGate>[0];
const toolName=/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const control=/[\x00-\x1f\x7f]/;
const pathKey=/^(?:path|paths|cwd|file|files|fileName|outputName|inputFiles|outputFiles|[A-Za-z]+Paths?)$/;
const writeTools=new Set(['write_document','write_docx','write_spreadsheet','write_table','write_presentation','edit_document','edit_spreadsheet','reconcile_tables','fill_document_template','merge_pdf','generate_image','export_artifact','sandbox_export','sandbox_execute','run_skill_script']);

function relativePrefix(value:unknown):string {
 if(typeof value!=='string'||value.length>512||control.test(value)||value.includes('\\')||isAbsolute(value)||/^[A-Za-z]:/.test(value)||value.includes(':'))throw new AdminError(400,'工具规则 pathPrefix 必须是工作区内的相对路径');
 const parts=value.split('/').filter(v=>v!==''&&v!=='.');if(parts.includes('..'))throw new AdminError(400,'工具规则 pathPrefix 不允许上级目录');return parts.join('/');
}
/** 配置保存与执行时均调用；错误不回显配置内容。 */
export function validateToolPolicy(values:Values):ToolGovernancePolicy {
 const source=values.SECURITY_TOOL_RULES_JSON??'[]';if(source.length>65536)throw new AdminError(400,'工具规则配置超过大小限制');
 let input:unknown;try{input=JSON.parse(source);}catch{throw new AdminError(400,'工具规则必须是 JSON 数组');}
 if(!Array.isArray(input)||input.length>200)throw new AdminError(400,'工具规则必须是至多 200 项的数组');
 const rules=input.map((raw):ToolGovernanceRule=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AdminError(400,'工具规则格式无效');
  const r=raw as Record<string,unknown>;if(Object.keys(r).some(k=>!['tool','decision','pathPrefix','commandPrefix'].includes(k)))throw new AdminError(400,'工具规则含有不支持的字段');
  if(typeof r.tool!=='string'||!(toolName.test(r.tool)||r.tool==='*')||!['deny','confirm'].includes(String(r.decision)))throw new AdminError(400,'工具规则只允许 deny 或 confirm 决策');
  const pathPrefix=r.pathPrefix===undefined?undefined:relativePrefix(r.pathPrefix);
  if(r.commandPrefix!==undefined&&(typeof r.commandPrefix!=='string'||!r.commandPrefix.trim()||r.commandPrefix.length>512||control.test(r.commandPrefix)||/[;&|`$<>]/.test(r.commandPrefix)))throw new AdminError(400,'commandPrefix 须为不含 shell 操作符的命令 token 前缀');
  return {tool:r.tool,decision:r.decision as 'deny'|'confirm',...(pathPrefix!==undefined?{pathPrefix}:{}),...(typeof r.commandPrefix==='string'?{commandPrefix:r.commandPrefix.trim()}: {})};
 });
 const disabledTools=(values.SECURITY_DISABLED_TOOLS??'').split(',').map(s=>s.trim()).filter(Boolean);
 if(disabledTools.length>200||disabledTools.some(v=>!toolName.test(v)))throw new AdminError(400,'禁用工具名单格式无效');
 if(values.SECURITY_CONFIRM_WRITES!==undefined&&!['true','false'].includes(values.SECURITY_CONFIRM_WRITES))throw new AdminError(400,'写操作确认开关必须为 true 或 false');
 const mode=values.SECURITY_SENSITIVE_INPUT_MODE??'warn';if(!['warn','block','off'].includes(mode))throw new AdminError(400,'敏感输入策略须为 warn、block 或 off');
 return {rules,disabledTools:[...new Set(disabledTools)],confirmWrites:values.SECURITY_CONFIRM_WRITES==='true',sensitiveInputMode:mode as ToolGovernancePolicy['sensitiveInputMode']};
}

/** 只隐藏无条件禁用工具；条件规则仍须在执行门逐次判定。 */
export function filterTools<T extends {readonly name:string}>(tools:readonly T[],values:Values):T[]{
 const p=validateToolPolicy(values);return tools.filter(t=>!p.disabledTools.includes(t.name)&&!p.rules.some(r=>(r.tool==='*'||r.tool===t.name)&&r.decision==='deny'&&r.pathPrefix===undefined&&r.commandPrefix===undefined));
}
function walkStrings(input:unknown,visit:(value:string,key:string,location:string)=>void):void{
 const seen=new WeakSet<object>();let nodes=0;
 function walk(value:unknown,key:string,location:string,depth:number){if(++nodes>10000||depth>20)return;if(typeof value==='string'){visit(value,key,location);return;}if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
  if(Array.isArray(value))value.forEach((v,i)=>walk(v,key,location+'['+i+']',depth+1));
  else Object.entries(value).forEach(([k,v],i)=>walk(v,k,location+(safeLocationKeys.has(k)?'.'+k:'[field:'+i+']'),depth+1));
 }walk(input,'','$',0);
}
const safeLocationKeys=new Set(['args','query','text','content','code','command','cmd','password','token','apiKey','api_key','authorization','cookie','headers','body','files','path','cwd','secret']);
/** 定位只含已知字段名或数字索引；不返回匹配值、任意用户键名或凭据片段。 */
export interface SensitiveInputFinding {readonly type:'private-key'|'access-token'|'credential-field'|'authorization'|'cookie';readonly location:string;readonly offset:number}
export function detectSensitiveInput(input:unknown):SensitiveInputFinding[]{
 const findings:SensitiveInputFinding[]=[];
 walkStrings(input,(value,key,location)=>{
  if(findings.length>=50||value.length>1048576)return;
  const patterns:[SensitiveInputFinding['type'],RegExp][]=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],['access-token',/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],['authorization',/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{16,}/i],['cookie',/\b(?:Cookie|Set-Cookie)\s*:\s*[^;\r\n=]{1,60}=[^;\s]{8,}/i]];
  for(const [type,pattern]of patterns){const match=pattern.exec(value);if(match)findings.push({type,location,offset:match.index});}
  if(/^(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization|cookie)$/i.test(key)&&value.trim().length>=8&&!/^(?:<[^>]+>|\$\{[^}]+\}|\*+|REDACTED|process\.env\.[A-Z_]+|os\.environ\[.+\])$/i.test(value.trim()))findings.push({type:'credential-field',location,offset:0});
 });return findings.slice(0,50);
}
function logicalPath(value:string,artifactDir:string,sandbox:boolean):string|undefined {
 if(!value||control.test(value)||value.includes('\\')||/^[A-Za-z]:/.test(value)||/^[a-z][a-z0-9+.-]*:/i.test(value))return undefined;
 let raw=value;
 if(sandbox&&raw.startsWith('/workspace')){if(raw!=='/workspace'&&!raw.startsWith('/workspace/'))return undefined;raw=raw.slice('/workspace'.length).replace(/^\//,'');}
 const root=resolve(artifactDir),absolute=isAbsolute(raw)?resolve(raw):resolve(root,raw);
 const rel=relative(root,absolute);if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))return undefined;
 // 已有文件和父目录都验证真实路径，包含还未创建的输出文件，拒绝符号链接穿越。
 if(existsSync(root)){
  const realRoot=realpathSync(root);let existing=absolute;
  const present=(path:string)=>{try{lstatSync(path);return true;}catch{return false;}};
  while(!present(existing)&&existing!==dirname(existing))existing=dirname(existing);
  let realExisting:string;try{realExisting=realpathSync(existing);}catch{return undefined;}const realRel=relative(realRoot,realExisting);
  if(realRel==='..'||realRel.startsWith('..'+sep)||isAbsolute(realRel))return undefined;
 }
 return rel.split(sep).join('/');
}
function commandMatches(source:string,prefix:string):boolean {
 // Token 边界防止 rm 命中 rmdir；分段是保守提示匹配，不解析、执行或授权 shell。
 const split=(s:string)=>s.trim().match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g)?.map(t=>t.replace(/^(['"])(.*)\1$/,'$2'))??[];
 const wanted=split(prefix);return source.split(/\r?\n|&&|\|\||[;|]/).some(segment=>{const actual=split(segment);return wanted.every((token,i)=>actual[i]===token);});
}
function writeRequest(request:GovernanceRequest):boolean {
 if(writeTools.has(request.toolName)||/^(?:write|edit|delete|remove|send|publish|upload|create|update|execute)_/.test(request.toolName))return true;
 const args=request.args as Record<string,unknown>|null;
 return (request.toolName==='sandbox_files'&&args?.action==='write')||request.toolName==='sandbox_browser_action';
}
/** 必须与原门按 block > confirm > allow 合并；不要用本函数替代原门。 */
export function governToolRequest(request:GovernanceRequest,values:Values,artifactDir:string):ToolDecision|undefined {
 let p:ToolGovernancePolicy;try{p=validateToolPolicy(values);}catch{return {kind:'block',reason:'工具安全策略配置无效，请管理员检查'};}
 if(p.disabledTools.includes(request.toolName))return {kind:'block',reason:'此工具已被管理员禁用'};
 const rules=p.rules.filter(r=>r.tool==='*'||r.tool===request.toolName),paths:string[]=[],commands:string[]=[];
 const sandbox=request.toolName.startsWith('sandbox_');
 walkStrings(request.args,(value,key)=>{
  if(pathKey.test(key)){const path=logicalPath(value,artifactDir,sandbox);if(path!==undefined)paths.push(path);}
  if(key==='command'||key==='cmd'||key==='code'&&typeof request.args==='object'&&request.args!==null&&['bash','shell'].includes(String((request.args as Record<string,unknown>).language)))commands.push(value);
 });
 // 路径授权只由主门负责：已授权的外部单文件不能被默认附加规则再次拒绝。
 // 无法映射为任务逻辑路径的参数不匹配 pathPrefix；本函数绝不返回 allow。
 if(p.sensitiveInputMode==='block'&&detectSensitiveInput(request.args).length)return {kind:'block',reason:'输入可能包含敏感凭据，请移除后重试'};
 let confirm=false;
 for(const r of rules){
  if(r.pathPrefix!==undefined&&!paths.some(path=>r.pathPrefix===''||path===r.pathPrefix||path.startsWith(r.pathPrefix+'/')))continue;
  if(r.commandPrefix!==undefined&&!commands.some(command=>commandMatches(command,r.commandPrefix!)))continue;
  if(r.decision==='deny')return {kind:'block',reason:'此调用被工作区工具规则禁止'};confirm=true;
 }
 if(confirm)return {kind:'confirm',reason:'此调用命中额外确认规则，请检查目标与参数'};
 if(p.confirmWrites&&writeRequest(request))return {kind:'confirm',reason:'工作区要求执行写入或外部操作前确认'};
 return undefined;
}
/** 可选组合器确保主门拒绝不会被附加确认覆盖。 */
export function withToolGovernance(baseGate:PermissionGate,values:()=>Values,artifactDir:string):PermissionGate {
 return async request=>{const base=await baseGate(request);if(base.kind==='block')return base;const extra=governToolRequest(request,values(),artifactDir);if(extra?.kind==='block')return extra;if(base.kind==='confirm')return base;return extra??base;};
}
