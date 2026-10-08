import { WorkspaceError } from "./workspace-services.ts";
export function pageOptions(params: URLSearchParams, defaultLimit=50) {
 const limit=Number(params.get("limit")??defaultLimit),offset=Number(params.get("offset")??params.get("cursor")??0);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new WorkspaceError(400,"分页参数无效，limit 须为1至100，offset 须为非负整数");
 return {limit,offset};
}
export function paginate<T>(rows: readonly T[], params: URLSearchParams) {
 const {limit,offset}=pageOptions(params),q=(params.get("q")??"").trim().toLowerCase();
 const sorted=[...rows].sort((a,b)=>{const x=a as Record<string,unknown>,y=b as Record<string,unknown>;const time=(v:unknown)=>typeof v==="number"?v:typeof v==="string"?Date.parse(v)||0:0;return time(y.updatedAt??y.createdAt??y.at)-time(x.updatedAt??x.createdAt??x.at);});
 const filtered=q?sorted.filter(row=>{const r=row as Record<string,unknown>;return [r.title,r.name,r.description,r.taskId,r.toolName,r.action,r.reason].join(" ").toLowerCase().includes(q);}):sorted;
 return {items:filtered.slice(offset,offset+limit),total:filtered.length,limit,offset,nextCursor:offset+limit<filtered.length?String(offset+limit):null};
}
