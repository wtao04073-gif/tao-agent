import {createOriginPolicy} from './request-origin.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseMultipartFile, sendJson, sendError, type Principal } from './app.ts';
export function logoHandler(root:string,authenticate:(req:IncomingMessage)=>Promise<Principal|undefined>,originAllowed=createOriginPolicy()){const dir=join(root,'.admin','logos');mkdirSync(dir,{recursive:true});return async(req:IncomingMessage,res:ServerResponse)=>{const path=new URL(req.url||'/','http://local').pathname;
 if(path==='/api/control/branding/logo'&&req.method==='POST'){const p=await authenticate(req);if(!p||!['PLATFORM_ADMIN','TENANT_ADMIN'].includes(p.role)){sendError(res,403,'需要管理员');return true;}if(!originAllowed(req)){sendError(res,403,'来源无效');return true;}const parsed=await parseMultipartFile(req,512000);if(!parsed.ok){sendError(res,400,parsed.reason);return true;}const b=parsed.value.bytes;const ext=imageExtension(b);if(!ext){sendError(res,400,'仅支持512KB以内、2048×2048以内的PNG、JPEG或WebP图像');return true;}const name=createHash('sha256').update(b).digest('hex')+'.'+ext;writeFileSync(join(dir,name),b,{mode:0o600});sendJson(res,201,{url:'/api/branding/logo/'+name});return true;}
 const match=/^\/api\/branding\/logo\/([a-f0-9]{64}\.(png|jpg|webp))$/.exec(path);if(match&&req.method==='GET'){if(!existsSync(join(dir,match[1]!))){sendError(res,404,'图标不存在');return true;}res.writeHead(200,{'Content-Type':'image/'+(match[2]==='jpg'?'jpeg':match[2]),'X-Content-Type-Options':'nosniff','Cache-Control':'public,max-age=86400'});res.end(readFileSync(join(dir,match[1]!)));return true;}return false;};}

/** 先检查容器与尺寸，不接收可执行 SVG 或仅改后缀的内容。 */
export function imageExtension(b:Buffer):string {
 const size=(w:number,h:number)=>w>0&&h>0&&w<=2048&&h<=2048;
 if(b.length>512000)return '';
 if(b.length>=45&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&b.toString('ascii',12,16)==='IHDR'&&b.readUInt32BE(8)===13&&b.toString('ascii',b.length-8,b.length-4)==='IEND')return size(b.readUInt32BE(16),b.readUInt32BE(20))?'png':'';
 if(b.length>=12&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217){
  for(let i=2;i+4<b.length;){if(b[i]!==255)return '';const marker=b[i+1]!;if(marker===218||marker===217)break;if(marker===255){i++;continue;}const n=b.readUInt16BE(i+2);if(n<2||i+2+n>b.length)return '';if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(n<8)return '';return size(b.readUInt16BE(i+7),b.readUInt16BE(i+5))?'jpg':'';}i+=2+n;}
 }
 if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'&&b.readUInt32LE(4)+8===b.length){
  const kind=b.toString('ascii',12,16),length=b.readUInt32LE(16);if(length+20>b.length)return '';
  if(kind==='VP8X'&&length>=10)return size(1+b.readUIntLE(24,3),1+b.readUIntLE(27,3))?'webp':'';
  if(kind==='VP8L'&&length>=5&&b[20]===47){const bits=b.readUInt32LE(21);return size((bits&16383)+1,((bits>>>14)&16383)+1)?'webp':'';}
  if(kind==='VP8 '&&length>=10&&b[23]===157&&b[24]===1&&b[25]===42)return size(b.readUInt16LE(26)&16383,b.readUInt16LE(28)&16383)?'webp':'';
 }
 return '';
}
