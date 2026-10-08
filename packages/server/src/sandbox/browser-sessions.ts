import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson} from '../admin-settings.ts';
import type {TenantContext} from '@tao/core';
/** 用户显式确认的浏览器登录态；密文落盘，不经模型消息或产物接口。 */
export class BrowserSessions {
 private root:string;private key:Buffer;
 constructor(root:string){this.root=join(root,'.browser-sessions');mkdirSync(this.root,{recursive:true,mode:0o700});const path=join(this.root,'key');if(!existsSync(path))writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});this.key=readFileSync(path);}
 private dir(t:TenantContext){const dir=join(this.root,createHash('sha256').update(JSON.stringify([t.tenantId,t.workspaceId,t.userId])).digest('hex'));mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
 private path(t:TenantContext,name:string){if(!/^[a-zA-Z0-9_-]{1,64}$/.test(name))throw Error('浏览器会话名称只允许字母数字下划线');return join(this.dir(t),name+'.json');}
 list(t:TenantContext){return readdirSync(this.dir(t)).filter(n=>n.endsWith('.json')).flatMap(n=>{try{const d=JSON.parse(readFileSync(join(this.dir(t),n),'utf8'));if(d.expiresAt<Date.now()){unlinkSync(join(this.dir(t),n));return [];}return [{name:n.slice(0,-5),expiresAt:d.expiresAt}];}catch{return [];}});}
 save(t:TenantContext,name:string,state:unknown){const text=JSON.stringify(state);if(text.length>2*1024*1024)throw Error('浏览器登录态超过2MB');const path=this.path(t,name);if(!existsSync(path)&&this.list(t).length>=20)throw Error('最多保存20个浏览器会话');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(path));const data=Buffer.concat([cipher.update(text),cipher.final()]);atomicJson(path,{expiresAt:Date.now()+8*3600000,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});}
 load(t:TenantContext,name:string){const path=this.path(t,name);if(!existsSync(path))throw Error('浏览器会话不存在');const d=JSON.parse(readFileSync(path,'utf8'));if(d.expiresAt<Date.now())throw Error('浏览器会话已过期，请重新登录');const dec=createDecipheriv('aes-256-gcm',this.key,Buffer.from(d.iv,'base64'));dec.setAAD(Buffer.from(path));dec.setAuthTag(Buffer.from(d.tag,'base64'));return JSON.parse(Buffer.concat([dec.update(Buffer.from(d.data,'base64')),dec.final()]).toString());}
 remove(t:TenantContext,name:string){const path=this.path(t,name);if(existsSync(path))unlinkSync(path);}
}
