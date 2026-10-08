(async function(){
 'use strict';var host=document.getElementById('share');
 function text(tag,value){var n=document.createElement(tag);n.textContent=value;host.append(n);return n;}
 try{
  var id=new URLSearchParams(location.search).get('id');if(!id)throw new Error('分享链接无效');
  var r=await fetch('/api/workbench/shares/'+encodeURIComponent(id),{headers:App.Auth.token?{Authorization:'Bearer '+App.Auth.token}:{}}),data=await r.json();if(!r.ok)throw new Error(data.error||'无法读取分享');
  data.files=Array.isArray(data.files)?data.files:[];host.replaceChildren();text('h2',data.snapshot.title);text('p','状态：'+data.snapshot.status);text('p','有效期至 '+new Date(data.expiresAt).toLocaleString());
  text('p',data.files.length?'以下是创建分享时固定的文件版本。下载会再次校验授权、有效期和文件完整性。':'创建者未开启文件下载，此链接仅分享摘要。');
  (data.files||[]).forEach(function(file){
   var row=document.createElement('article'),label=document.createElement('span'),button=document.createElement('button'),status=document.createElement('p');status.setAttribute('role','status');
   label.textContent=file.name+' · '+App.fmtBytes(file.sizeBytes)+' ';button.type='button';button.textContent='下载文件';
   button.onclick=async function(){button.disabled=true;status.textContent='正在校验并下载…';try{
    var response=await fetch('/api/workbench/shares/'+encodeURIComponent(id)+'/files/'+encodeURIComponent(file.artifactId)+'/'+encodeURIComponent(file.versionId),{headers:App.Auth.token?{Authorization:'Bearer '+App.Auth.token}:{}});
    if(!response.ok){var error=await response.json().catch(function(){return {};});throw new Error(error.error||'下载失败');}
    var blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(function(){URL.revokeObjectURL(url);},30000);status.textContent='文件已下载';
   }catch(e){status.textContent=e.message;}finally{button.disabled=false;}};
   row.append(label,button,status);host.append(row);
  });
  if(!data.files.length)(data.snapshot.artifacts||[]).forEach(function(a){a.versions.forEach(function(v){text('p',v.name);});});
 }catch(e){host.textContent=e.message;}
})();
