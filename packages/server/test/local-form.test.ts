import {it,expect} from 'vitest';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
it('本机表单分区保留全部字段且刷新筛选不依赖被移除网格',()=>{
 const {document}=parseHTML('<html><head></head><body><section id="configuration"><section class="settings-group"><div class="settings-grid"></div></section></section><button id="applyConfig"></button><button id="saveConfig"></button></body></html>');
 const section=document.querySelector('.settings-group')!,grid=section.querySelector('.settings-grid')!;
 const keys=['ENABLED','SINGLE_USER_ACK','LEVEL','ROOTS','NETWORK','ALLOW_INSTALL','ALLOW_DELETE','ALLOW_WRITE_OUTSIDE','CONFIRM_MODE','SESSION_GRANT_TTL_MIN','TIMEOUT_SEC','MAX_OUTPUT_KB','MODE','TRUSTED_AUTO_RUN','TRUSTED_AUTO_RUN_ACK','ALLOW_PATTERNS','DENY_PATTERNS','DANGER_ACK','FULL_DISCLAIMER'];
 const bools=['ENABLED','SINGLE_USER_ACK','NETWORK','ALLOW_INSTALL','ALLOW_DELETE','ALLOW_WRITE_OUTSIDE','TRUSTED_AUTO_RUN','TRUSTED_AUTO_RUN_ACK','DANGER_ACK'];
 for(const key of keys){const field=document.createElement('div');field.className='config-field'+(bools.includes(key)?' config-boolean':'');const label=document.createElement('label');label.textContent=key;const input=document.createElement(['LEVEL','CONFIRM_MODE','MODE'].includes(key)?'select':'input');input.name='LOCAL_CONTROL_'+key;input.type=bools.includes(key)?'checkbox':'text';if(input.tagName==='SELECT'){for(const value of key==='LEVEL'?['off','readonly','workspace','extended','full']:key==='MODE'?['auto','seatbelt','bwrap']:['always','risk','session','never']){const option=document.createElement('option');option.value=value;option.textContent=value;input.append(option);}}else input.value=key==='ROOTS'?'/allowed':key==='SESSION_GRANT_TTL_MIN'?'30':'';field.append(label,input);grid.append(field);}
 const code=readFileSync(new URL('../../../web/control/settings.js',import.meta.url),'utf8');
 const fn=code.slice(code.indexOf('function mountLocalControl('),code.indexOf("document.getElementById('configSearch')",code.indexOf('function mountLocalControl(')));
 const context=vm.createContext({document,fields:[],App:{Dialog:{confirm:async()=>true}},setDirty:()=>{},api:async()=>({ok:true}),button:(text:string,callback:()=>void)=>{const b=document.createElement('button');b.textContent=text;b.addEventListener('click',callback);return b;},el:(tag:string,text?:string)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;}});
 vm.runInContext(fn,context);context.mountLocalControl(section);
 expect(section.querySelectorAll('.local-block').length).toBe(5);expect(section.querySelectorAll('[name]').length).toBe(keys.length);expect(section.querySelector('.settings-grid')).not.toBeNull();expect(section.querySelector('.local-operation')!.textContent).toContain('预检');
});
