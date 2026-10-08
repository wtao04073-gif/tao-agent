(function(global){
 'use strict';
 function text(tag,value){var el=document.createElement(tag);el.textContent=value;return el;}
 function inline(parent,source){
  var pattern=/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g,last=0,match;
  while((match=pattern.exec(source))){parent.append(document.createTextNode(source.slice(last,match.index)));var token=match[0],node;
   if(token[0]==='`')node=text('code',token.slice(1,-1));
   else if(token.startsWith('**'))node=text('strong',token.slice(2,-2));
   else {var parts=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);node=text('a',parts[1]);node.href=parts[2];node.target='_blank';node.rel='noopener noreferrer';}
   parent.append(node);last=pattern.lastIndex;
  }parent.append(document.createTextNode(source.slice(last)));
 }
 function markdown(source){
  var root=document.createElement('div');root.className='rendered-markdown';var lines=String(source||'').split('\n'),list=null;
  for(var i=0;i<lines.length;i++){
   var line=lines[i];if(line.startsWith('```')){var code=[];while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);var box=document.createElement('div');box.className='code-block';var button=text('button','复制代码');button.type='button';button.addEventListener('click',(function(value,b){return function(){copy(value,b);};})(code.join('\n'),button));var pre=document.createElement('pre');pre.append(text('code',code.join('\n')));box.append(button,pre);root.append(box);list=null;continue;}
   if(!line.trim()){list=null;continue;}
   var heading=/^(#{1,4})\s+(.+)$/.exec(line),item=/^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line),el;
   if(heading){el=document.createElement('h'+(heading[1].length+1));inline(el,heading[2]);list=null;}
   else if(item){if(!list){list=document.createElement('ul');root.append(list);}el=document.createElement('li');inline(el,item[1]);list.append(el);continue;}
   else{el=document.createElement(line.startsWith('> ')?'blockquote':'p');inline(el,line.replace(/^> /,''));list=null;}root.append(el);
  }return root;
 }
 function copy(value,button){navigator.clipboard.writeText(value).then(function(){var old=button.textContent;button.textContent='已复制';setTimeout(function(){button.textContent=old;},1500);}).catch(function(){button.textContent='复制失败，请手动选择';});}
 function renderAnswer(element,value){element.textContent='';element.append(markdown(value));element.dataset.raw=value;var bar=document.createElement('div');bar.className='message-actions';var button=text('button','复制回答');button.type='button';button.addEventListener('click',function(){copy(value,button);});bar.append(button);element.append(bar);}
 function errorMessage(reason){
  var message=String(reason||'');
  if(/ModelAccountTpmRateLimitExceeded|Tokens Per Minute|\bTPM\b/i.test(message))return '模型的每分钟 Token 限额已用尽，本次未能完成。请稍后重新发送；若持续出现，请管理员检查方舟模型配额。';
  if(/\b429\b|TooManyRequests|RateLimitExceeded/i.test(message))return '模型服务暂时限流，本次未能完成。请稍后重新发送，避免连续点击。';
  if(/assistant_error|内核运行失败|\"error\"\s*:|\"code\"\s*:/.test(message))return '模型服务暂时无法完成请求，请稍后重试；若持续失败，请联系管理员查看任务记录。';
  return message||'任务未能完成，请稍后重试。';
 }
 var previewId=0,objectURL=null;
 function clearPreview(){previewId++;if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}var host=document.getElementById('artifactPreview');if(host)host.remove();}
 function preview(taskId,name){
  clearPreview();var generation=previewId;
  var body=document.getElementById('deliverBody');var host=document.createElement('section');host.id='artifactPreview';host.className='artifact-preview';host.setAttribute('aria-live','polite');host.append(text('h3',name),text('p','正在加载预览…'));body.prepend(host);
  fetch(taskId?'/api/tasks/'+encodeURIComponent(taskId)+'/artifacts/'+encodeURIComponent(name)+'/preview':'/api/files/'+encodeURIComponent(name)+'/preview', {headers:global.App.Auth.token?{Authorization:'Bearer '+global.App.Auth.token}:{}}).then(async function(response){
   var ct=response.headers.get('content-type')||'';
   if(ct.includes('application/json'))return {ok:response.ok,data:await response.json()};
   if(!response.ok)return {ok:false,data:{error:'无法预览该文件'}};
   return {ok:true,data:{kind:'blob',mime:ct.split(';')[0],blob:await response.blob()}};
  }).then(function(r){
   if(generation!==previewId)return;host.textContent='';host.append(text('h3',name));if(!r.ok){host.append(text('p',r.data.error||'预览加载失败'));return;}
   var data=r.data;
   if(data.kind==='slides'){host.append(text('p','幻灯片文本预览；图表、图片和版式请下载查看。'));(data.slides||data.units||[]).forEach(function(slide,i){var card=document.createElement('article');card.className='wb-card';card.append(text('h4','第 '+(i+1)+' 页'),text('pre',typeof slide==='string'?slide:slide.text||slide.title||''));host.append(card);});}
   else if(data.kind==='text'){if(/\.(html?|svg|xml)$/i.test(name))host.append(text('pre',data.text));else host.append(markdown(data.text));}
   else if(data.kind==='sheet'){var wrap=document.createElement('div');wrap.className='preview-table';var table=document.createElement('table'),header=document.createElement('tr');(data.columns||[]).forEach(function(c){header.append(text('th',c));});table.append(header);(data.rows||[]).forEach(function(row){var tr=document.createElement('tr');(data.columns||[]).forEach(function(c,index){tr.append(text('td',Array.isArray(row)?row[index]:row[c]));});table.append(tr);});wrap.append(table);host.append(wrap);}
   else if(data.kind==='blob'&&['application/pdf','image/png','image/jpeg','image/webp'].includes(data.mime)){
    objectURL=URL.createObjectURL(data.blob);
    var el=document.createElement(data.mime==='application/pdf'?'iframe':'img');el.src=objectURL;el.title=name;el.alt=name;if(el.tagName==='IFRAME')el.setAttribute('sandbox','');host.append(el);
   }else host.append(text('p',data.message||'此格式暂不支持在线预览，可以下载查看。'));
   if(data.truncated)host.append(text('p','内容较长，仅展示部分预览，请下载完整文件。'));
  }).catch(function(){if(generation===previewId)host.append(text('p','网络异常，请重新点击预览'));});
 }
 global.ChatUI={markdown:markdown,renderAnswer:renderAnswer,errorMessage:errorMessage,preview:preview,clearPreview:clearPreview};
})(window);
