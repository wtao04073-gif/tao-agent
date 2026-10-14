(function(global){'use strict';
 var doc=global.document;
 function enhanceSelect(select){
  if(select.dataset.uiEnhanced){select._taoSelectSync();return;}if(select.multiple||select.hidden||select.closest('[hidden]'))return;
  select.dataset.uiEnhanced='true';
  var wrap=doc.createElement('div');wrap.className='tao-select'+(select.classList.contains('model-pick')?' tao-model-pill':'');
  select.parentNode.insertBefore(wrap,select);wrap.append(select);select.classList.add('tao-select-native');select.tabIndex=-1;
  var button=doc.createElement('button');button.type='button';button.className='tao-select-trigger';button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
  var list=doc.createElement('div');list.className='tao-select-list';list.id='tao-options-'+(++sequence);list.setAttribute('role','listbox');button.setAttribute('aria-controls',list.id);list.hidden=true;wrap.append(button,list);
  var current=-1;
  function sync(){var selected=select.options[select.selectedIndex],text=(selected?selected.textContent:'请选择')+' ▾';if(button.textContent!==text)button.textContent=text;button.disabled=select.disabled;button.setAttribute('aria-required',String(select.required));button.setAttribute('aria-invalid',String(!select.validity||select.validity.valid===false));button.setAttribute('aria-label',select.getAttribute('aria-label')||(select.labels&&select.labels[0]?select.labels[0].textContent:'选择选项'));if(wrap.hidden!==select.hidden)wrap.hidden=select.hidden;}
  function close(){list.hidden=true;button.setAttribute('aria-expanded','false');}
  function draw(){sync();list.replaceChildren();Array.from(select.options).forEach(function(option,index){var item=doc.createElement('button');item.type='button';item.className='tao-select-option';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.textContent=option.textContent;item.disabled=option.disabled||(option.parentNode.tagName==='OPTGROUP'&&option.parentNode.disabled);item.title=option.dataset.reason||option.title||'';if(option.dataset.icon){var icon=doc.createElement('span');icon.className='tao-option-icon';icon.textContent=option.dataset.icon;item.prepend(icon);}if(option.dataset.subtitle||item.disabled&&item.title){var note=doc.createElement('small');note.textContent=option.dataset.subtitle||'';if(item.disabled&&item.title)note.textContent+=(note.textContent?' · ':'')+item.title;item.append(note);}if(option.dataset.danger==='true')item.classList.add('is-danger');item.onclick=function(){select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();close();button.focus();};item.onkeydown=function(e){if(e.key==='Escape'){e.preventDefault();close();button.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();if(e.key==='Home')current=-1;if(e.key==='End')current=0;move(e.key==='ArrowUp'||e.key==='End'?-1:1);}else if(e.key==='Tab')close();};list.append(item);});current=select.selectedIndex;}
  function move(direction){var items=Array.from(list.children);for(var i=0;i<items.length;i++){current=(current+direction+items.length)%items.length;if(!items[current].disabled){items[current].focus();break;}}}
  function open(){draw();list.hidden=false;button.setAttribute('aria-expanded','true');}
  button.onclick=function(){if(list.hidden)open();else close();};button.onkeydown=function(e){if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();open();if(e.key==='Home')current=-1;if(e.key==='End')current=0;move(e.key==='ArrowUp'||e.key==='End'?-1:1);}else if(e.key==='Escape'){close();}else if(e.key==='Tab')close();};
  select.addEventListener('change',sync);select.addEventListener('invalid',function(e){e.preventDefault();button.setAttribute('aria-invalid','true');button.focus();});
  select.addEventListener('focus',function(){button.focus();});
  wrap.addEventListener('focusout',function(e){if(!wrap.contains(e.relatedTarget))close();});
  // 一个全局外部点击监听，避免每个控件残留独立 document 监听。
  select._taoSelectSync=sync;select._taoSelectClose=close;sync();
  // 保留原生 setter 语义；程序赋值只同步显示，不额外触发业务 change。
  ['value','selectedIndex'].forEach(function(key){var proto=Object.getPrototypeOf(select),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,key);proto=Object.getPrototypeOf(proto);}if(descriptor&&descriptor.get&&descriptor.set)Object.defineProperty(select,key,{configurable:true,get:function(){return descriptor.get.call(this);},set:function(value){descriptor.set.call(this,value);sync();}});});
  if(select.form)select.form.addEventListener('reset',function(){queueMicrotask(sync);});
 }
 var sequence=0;
 function enhance(root){
  root.querySelectorAll('select').forEach(enhanceSelect);
  root.querySelectorAll('input[type="checkbox"]').forEach(function(input){input.classList.add(input.dataset.type==='boolean'||input.closest('.config-boolean')&&!input.closest('.config-clear')?'tao-switch':'tao-checkbox');if(input.classList.contains('tao-switch'))input.setAttribute('role','switch');});
  root.querySelectorAll('input[type="radio"]').forEach(function(input){var label=input.closest('label');if(label)label.classList.add('tao-radio-card');if(input.dataset.uiEnhanced)return;input.dataset.uiEnhanced='true';input.addEventListener('keydown',function(e){if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;var group=input.closest('[role="radiogroup"]');if(!group)return;e.preventDefault();var choices=Array.from(group.querySelectorAll('input[type="radio"]')).filter(function(r){return !r.disabled;});var next=e.key==='Home'?0:e.key==='End'?choices.length-1:(choices.indexOf(input)+(e.key==='ArrowUp'||e.key==='ArrowLeft'?-1:1)+choices.length)%choices.length;choices[next].focus();choices[next].click();});});
  root.querySelectorAll('input[type="date"]').forEach(function(input){input.classList.add('tao-date');input.setAttribute('aria-label',input.getAttribute('aria-label')||(input.labels&&input.labels[0]?input.labels[0].textContent:'选择日期'));});
 }
 function mount(){enhance(doc);var queued=false;new MutationObserver(function(records){if(queued||!records.some(function(r){return r.type==='childList'||['SELECT','OPTION','OPTGROUP'].includes(r.target.tagName)||r.attributeName==='hidden'&&!r.target.classList.contains('tao-select-list');}))return;queued=true;queueMicrotask(function(){queued=false;enhance(doc);});}).observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','disabled','selected','required','aria-label']});
  doc.addEventListener('click',function(e){doc.querySelectorAll('.tao-select-native').forEach(function(select){if(!select.parentNode.contains(e.target))select._taoSelectClose();});});
  doc.addEventListener('focusin',function(){doc.querySelectorAll('.tao-select-native').forEach(function(s){s._taoSelectSync();});});
 }
 global.TaoUI={enhance:enhance,select:enhanceSelect};if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',mount);else mount();
})(window);
