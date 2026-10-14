import {describe,it,expect} from 'vitest';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
describe('步骤展示聚合',()=>{
 it('同类调用只形成一个分组和三个阶段，失败自动展开',()=>{
  const {document}=parseHTML('<html><body><div id="root"><div id="head"><span class="summary"></span></div><div id="body"></div></div></body></html>');
  const context=vm.createContext({document});vm.runInContext(readFileSync(new URL('../../../web/assets/steps-display.js',import.meta.url),'utf8'),context);
  const display=context.TaoStepsDisplay,view={root:document.querySelector('#root'),head:document.querySelector('#head'),body:document.querySelector('#body'),rows:{},order:[]};
  const model=display.ensure(view,{step:1,phase:'finished'});model.dataset.phase='finished';
  for(let i=0;i<5;i++){const row=display.ensure(view,{step:i+2,toolName:'local_shell',toolCallId:'c'+i,phase:'started',at:1000});row.dataset.phase=i===2?'failed':'finished';display.ensure(view,{step:i+2,toolName:'local_shell',toolCallId:'c'+i,phase:row.dataset.phase,at:2000});}
  display.ensure(view,{step:8,phase:'started'}).dataset.phase='started';display.update(view);
  expect(view.body.children.length).toBe(3);expect(document.querySelectorAll('.run-tool-group').length).toBe(1);expect(document.querySelector('.run-group-title')!.textContent).toContain('共 5 条 · 失败 1');expect(document.querySelector('.run-tool-group')!.open).toBe(true);expect(document.querySelector('.step-time')!.textContent).toContain('耗时');
 });
});
