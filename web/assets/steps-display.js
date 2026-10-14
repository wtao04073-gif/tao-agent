(function(global){'use strict';
 function element(tag,className,text){var node=document.createElement(tag);node.className=className||'';if(text!==undefined)node.textContent=text;return node;}
 function stage(view,index){
  view.stages=view.stages||{};if(view.stages[index])return view.stages[index];
  var box=element('details','run-stage'),head=element('summary','run-stage-title',index+'. '+['理解任务','执行','生成回答'][index-1]),body=element('div','run-stage-body');
  box.dataset.stage=String(index);box.append(head,body);view.stages[index]={root:box,head:head,body:body};
  var following=Array.from(view.body.children).find(function(n){return Number(n.dataset.stage)>index;});view.body.insertBefore(box,following||null);return view.stages[index];
 }
 function ensure(view,ev){
  var tool=ev.toolName,group=tool==='local_shell'||tool==='stage_to_local'||tool==='collect_from_local'?'local':tool&&/document|table|sheet|file|pdf|presentation|template/.test(tool)?'files':tool?'other':null;
  var index=tool?2:(view.hasTools?3:1),section=stage(view,index);if(tool)view.hasTools=true;
  view.groups=view.groups||{};var parent=section.body;
  if(group){
   if(!view.groups[group]){var box=element('details','run-tool-group'),head=element('summary','run-group-title'),body=element('div','run-group-body');box.append(head,body);section.body.append(box);view.groups[group]={root:box,head:head,body:body,name:group==='local'?'本机操作':group==='files'?'读取与生成文件':'其他工具'};}
   parent=view.groups[group].body;
  }
  var key=tool?(ev.toolCallId||'step-'+ev.step):'model-'+index,row=view.rows[key];
  if(!row){row=element('div','step wait');row.innerHTML='<div class="sic"><span class="k">◷</span></div><div class="sact"><div class="t"></div><div class="d"></div><small class="step-time"></small></div><div class="sst"></div>';parent.append(row);view.rows[key]=row;view.order.push(key);}
  row.dataset.stage=String(index);if(group)row.dataset.group=group;
  if(ev.phase==='started')row.dataset.startedAt=String(ev.at||Date.now());
  if(ev.phase==='finished'||ev.phase==='failed'){var elapsed=Math.max(0,(ev.at||Date.now())-Number(row.dataset.startedAt||ev.at||Date.now()));row.querySelector('.step-time').textContent='耗时 '+(elapsed/1000).toFixed(1)+' 秒';}
  row.dataset.action=ev.action||'执行操作';return row;
 }
 function update(view,terminal){
  var rows=Object.values(view.rows);Object.values(view.groups||{}).forEach(function(group){
   var children=Array.from(group.body.children),failed=children.filter(function(r){return r.dataset.phase==='failed';}).length,active=children.some(function(r){return ['started','progress'].includes(r.dataset.phase);});
   group.head.textContent=group.name+'（共 '+children.length+' 条'+(failed?' · 失败 '+failed:'')+'） · '+(active?'进行中':failed?'有失败':'已完成');
   group.root.classList.toggle('has-failure',failed>0);if(failed){group.root.open=true;view.root.classList.remove('collapsed');}
  });
  Object.entries(view.stages||{}).forEach(function(pair){var id=Number(pair[0]),s=pair[1],children=rows.filter(function(r){return Number(r.dataset.stage)===id;}),failed=children.some(function(r){return r.dataset.phase==='failed';}),active=children.some(function(r){return ['started','progress'].includes(r.dataset.phase);});
   s.head.textContent=id+'. '+['理解任务','执行','生成回答'][id-1]+' · '+(failed?'有失败':active?'进行中':'已完成');
   if(failed||active)s.root.open=true;if(terminal&&!failed)s.root.open=false;
  });
  var tools=rows.filter(function(r){return r.dataset.group;}),done=tools.filter(function(r){return r.dataset.phase==='finished';}).length,fail=tools.filter(function(r){return r.dataset.phase==='failed';}).length;
  view.head.querySelector('.summary').textContent=(terminal?'本轮已结束':'任务进展')+(tools.length?' · 已执行 '+done+' / '+tools.length+' 项操作':'')+(fail?' · '+fail+' 项失败':'');
  if(fail)view.root.classList.remove('collapsed');
 }
 global.TaoStepsDisplay={ensure:ensure,update:update};
})(typeof window!=='undefined'?window:globalThis);
