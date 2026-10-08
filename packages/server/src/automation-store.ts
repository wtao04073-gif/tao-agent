import { FileJsonStore } from '@tao/knowledge';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';

interface TenantScoped { tenant: { tenantId: string; workspaceId: string } }
interface Envelope { id:string;tenant:TenantScoped['tenant'];$taoEncrypted:1;iv:string;tag:string;ciphertext:string }
export const AUTOMATION_KEY_FILE = '.automation-store.key';
const managedCollection = /^(automations$|automation-|connector-|enterprise-)/;

/** 原子文件存储上的透明AES-256-GCM；索引以AAD绑定，敏感正文不以明文落盘。 */
export class AutomationStore<T extends TenantScoped & { id: string }> extends FileJsonStore<T> {
  private readonly directory:string;
  private readonly key:Buffer;
  constructor(dir:string,collection:string){
    super({dir,collection,idOf:item=>item.id});this.directory=join(dir,collection);
    const keyPath=join(dir,AUTOMATION_KEY_FILE);
    if(!existsSync(keyPath)){
      // 有密文而密钥消失时禁止重新生成。旧明文数据可在首次读取时迁移。
      for(const entry of readdirSync(dir,{withFileTypes:true})){
        if(!entry.isDirectory()||(entry.name!==collection&&!managedCollection.test(entry.name)))continue;
        for(const file of readdirSync(join(dir,entry.name))){
          if(!file.endsWith('.json'))continue;
          let value:unknown;try{value=JSON.parse(readFileSync(join(dir,entry.name,file),'utf8'));}catch{throw new Error('持久记录损坏，不能创建新的加密密钥');}
          if(value&&typeof value==='object'&&'$taoEncrypted' in value)throw new Error('加密密钥缺失，请恢复原密钥与数据备份');
        }
      }
      writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx',flush:true});
    }
    this.key=readFileSync(keyPath);if(this.key.length!==32)throw new Error('加密密钥损坏，请恢复原密钥');chmodSync(keyPath,0o600);
  }
  private seal(item:T):T{
    const index={id:item.id,tenant:item.tenant};const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(JSON.stringify(index)));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(item),'utf8'),cipher.final()]);
    return{...index,$taoEncrypted:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')} as unknown as T;
  }
  override put(item:T):void{super.put(this.seal(item));}
  override create(item:T):boolean{return super.create(this.seal(item));}
  override get(id:string):T|undefined{
    if(!/^[A-Za-z0-9_-]+$/.test(id))return undefined;
    const value=super.get(id);if(value===undefined){if(existsSync(join(this.directory,id+'.json')))throw new Error('持久记录损坏，请恢复备份');return undefined;}
    if(!value||typeof value!=='object'||value.id!==id||!value.tenant||typeof value.tenant.tenantId!=='string'||typeof value.tenant.workspaceId!=='string')throw new Error('持久记录索引损坏');
    if(!('$taoEncrypted' in value)){this.put(value);return value;}
    try{
      const envelope=value as unknown as Envelope;if(envelope.$taoEncrypted!==1||typeof envelope.iv!=='string'||typeof envelope.tag!=='string'||typeof envelope.ciphertext!=='string')throw new Error();
      const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');if(iv.length!==12||tag.length!==16)throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAAD(Buffer.from(JSON.stringify({id:envelope.id,tenant:envelope.tenant})));decipher.setAuthTag(tag);
      const item=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8')) as T;
      if(!item||item.id!==id||JSON.stringify(item.tenant)!==JSON.stringify(envelope.tenant))throw new Error();return item;
    }catch{throw new Error('密文校验失败或密钥不匹配，请恢复有效备份');}
  }
  override listByTenant(tenantId:string,workspaceId:string):readonly T[]{return this.all().filter(item=>item.tenant.tenantId===tenantId&&item.tenant.workspaceId===workspaceId);}
  all():T[]{return readdirSync(this.directory).filter(name=>name.endsWith('.json')).map(name=>{const item=this.get(name.slice(0,-5));if(!item)throw new Error('持久记录损坏，请恢复备份');return item;});}
}
