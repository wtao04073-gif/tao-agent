import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

function setup(body:string){
 const {window,document}=parseHTML('<html><head></head><body>'+body+'</body></html>');
 // linkedom缺少部分原生表单属性，补齐后测试真实控件事件。
 document.querySelectorAll('option,optgroup').forEach(option=>Object.defineProperty(option,'disabled',{get(){return this.hasAttribute('disabled');}}));
 document.querySelectorAll('select').forEach(select=>{
  const proto=Object.create(Object.getPrototypeOf(select));
  Object.defineProperty(proto,'value',{configurable:true,get(){return Array.from(this.options).find((o:any)=>o.hasAttribute('selected'))?.value;},set(value:string){Array.from(this.options).forEach((o:any)=>{if(o.value===value)o.setAttribute('selected','');else o.removeAttribute('selected');});}});
  Object.defineProperty(proto,'selectedIndex',{configurable:true,get(){return Array.from(this.options).findIndex((o:any)=>o.value===this.value);},set(index:number){this.value=this.options[index]?.value;}});
  Object.setPrototypeOf(select,proto);
 });
 const context=vm.createContext({window,document,Event:window.Event,MutationObserver:window.MutationObserver,queueMicrotask});
 vm.runInContext(readFileSync(new URL('../../../web/assets/ui-controls.js',import.meta.url),'utf8'),context);
 return {window,document};
}
it('自定义选择保留表单值和change事件，禁用项不能选择且显示原因',()=>{
 const {window,document}=setup('<label>模型<select name="model"><option value="one" selected>一个</option><option value="off" disabled data-reason="尚未配置" data-subtitle="图片理解">停用</option><option value="two">另一个</option></select></label>');
 const select=document.querySelector('select')!,trigger=document.querySelector('.tao-select-trigger')!;let changes=0;select.addEventListener('change',()=>changes++);trigger.dispatchEvent(new window.Event('click'));
 const items=document.querySelectorAll('.tao-select-option');expect(items[1].disabled).toBe(true);expect(items[1].textContent).toContain('尚未配置');items[2].dispatchEvent(new window.Event('click'));expect(select.value).toBe('two');expect(changes).toBe(1);expect(trigger.textContent).toContain('另一个');expect(trigger.getAttribute('aria-expanded')).toBe('false');
 select.value='one';expect(trigger.textContent).toContain('一个');expect(changes).toBe(1);
});
it('键盘导航跳过禁用项，Escape关闭，动态显示页面增强控件',async()=>{
 const {window,document}=setup('<section hidden><select><option selected>默认</option></select></section><select id="active"><option selected>首项</option><option disabled>禁用</option><option>末项</option></select>');
 const trigger=document.querySelector('.tao-select-trigger')!;function key(value:string){const e=new window.Event('keydown',{cancelable:true});Object.defineProperty(e,'key',{value});trigger.dispatchEvent(e);}
 key('ArrowDown');expect(trigger.getAttribute('aria-expanded')).toBe('true');key('Escape');expect(trigger.getAttribute('aria-expanded')).toBe('false');
 document.querySelector('section')!.hidden=false;await new Promise(r=>setTimeout(r,0));expect(document.querySelectorAll('.tao-select-trigger')).toHaveLength(2);
 const select=document.querySelector('#active')!;select.disabled=true;await new Promise(r=>setTimeout(r,0));expect(trigger.disabled).toBe(true);
});
it('开关、勾选、单选卡和日期采用共同组件且不丢字段',()=>{
 const {document}=setup('<div class="config-boolean"><input type="checkbox" name="enabled"><label class="config-clear"><input type="checkbox" name="clear"></label></div><label><input type="radio" name="level">只读</label><input type="date" name="date">');
 expect(document.querySelector('[name="enabled"]')!.getAttribute('role')).toBe('switch');expect(document.querySelector('[name="clear"]')!.classList.contains('tao-checkbox')).toBe(true);expect(document.querySelector('label:has(input[type="radio"])')!.classList.contains('tao-radio-card')).toBe(true);expect(document.querySelector('[name="date"]')!.classList.contains('tao-date')).toBe(true);expect(document.querySelectorAll('[name]')).toHaveLength(4);
});
it('发送偏好涵盖Enter、组合键、换行与中文输入法',()=>{
 const html=readFileSync(new URL('../../../web/chat.html',import.meta.url),'utf8'),fn=html.slice(html.indexOf('function sendByShortcut('),html.indexOf('function shortcutHints('));let preference='enter';const c=vm.createContext({localStorage:{getItem:()=>preference}});vm.runInContext(fn,c);
 const event={key:'Enter',shiftKey:false,metaKey:false,ctrlKey:false,isComposing:false};expect(c.sendByShortcut(event)).toBe(true);expect(c.sendByShortcut({...event,isComposing:true})).toBe(false);expect(c.sendByShortcut({...event,shiftKey:true})).toBe(false);
 preference='mod-enter';expect(c.sendByShortcut(event)).toBe(false);expect(c.sendByShortcut({...event,metaKey:true})).toBe(true);expect(c.sendByShortcut({...event,ctrlKey:true})).toBe(true);
});
it('批量弹层一次收集全部名称，提交期间禁用编辑，校验失败保留内容',async()=>{
 const {window,document}=parseHTML('<html><head></head><body></body></html>');
 const proto=window.HTMLElement.prototype;
 proto.showModal=function(){this.open=true;};proto.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
 const globalWindow:any={fetch:globalThis.fetch,document,addEventListener:()=>{},removeEventListener:()=>{},Event:window.Event};
 const location={href:'http://localhost/chat.html',origin:'http://localhost',pathname:'/chat.html',search:'',hash:''},storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
 const c=vm.createContext({window:globalWindow,document,location,localStorage:storage,sessionStorage:storage,Headers,URL,Response,crypto:globalThis.crypto,setTimeout,clearTimeout});
 vm.runInContext(readFileSync(new URL('../../../web/assets/core.js',import.meta.url),'utf8'),c);
 const controls:any[]=[];let attempts=0,received:string[]=[];
 const result=globalWindow.App.Dialog.open({title:'批量改名',render(form:any){for(const name of ['a.txt','b.txt']){const input=document.createElement('input');input.value=name;form.append(input);controls.push(input);}return controls;},collect(){return controls.map(i=>i.value);},async onSubmit(values:string[]){attempts++;received=values;expect(controls.every(i=>i.disabled)).toBe(true);if(attempts===1)throw Error('目标重名');return true;}});
 await new Promise(r=>setTimeout(r,0));const form=document.querySelector('form')!;form.dispatchEvent(new window.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));expect(document.querySelector('.app-dialog-error')!.textContent).toBe('目标重名');expect(controls.every(i=>!i.disabled)).toBe(true);controls[0].value='new.txt';form.dispatchEvent(new window.Event('submit',{cancelable:true}));await expect(result).resolves.toBe(true);expect(received).toEqual(['new.txt','b.txt']);expect(document.querySelectorAll('dialog')).toHaveLength(0);
});
