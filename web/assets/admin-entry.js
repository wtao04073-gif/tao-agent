(function(){'use strict';
 var card=document.querySelector('.usercard');if(!card)return;
 var menu=document.createElement('div');menu.className='account-menu';menu.hidden=true;card.parentNode.insertBefore(menu,card);
 card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label','账户与管理设置');card.setAttribute('aria-expanded','false');
 function close(){menu.hidden=true;card.setAttribute('aria-expanded','false');}
 function action(label,fn){var b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',async function(){close();try{await fn();}catch(e){await App.Dialog.alert({description:e.message});}});menu.appendChild(b);}
 async function toggle(){if(!menu.hidden){close();return;}var me=await App.api('GET','/api/me');if(!me.ok)return;menu.replaceChildren();
  action('个人设置',async function(){location.href='/profile.html';});
  action(document.documentElement.getAttribute('data-theme')==='dark'?'当前暗色 · 切换为浅色':'当前浅色 · 切换为暗色',async function(){var dark=document.documentElement.getAttribute('data-theme')!=='dark';localStorage.setItem('tao.theme',dark?'dark':'light');location.reload();});
  if(['TENANT_ADMIN','PLATFORM_ADMIN'].includes(me.data.role))action('管理后台',async function(){var r=await App.api('POST','/api/control/session',{});if(!r.ok)throw Error(r.data.error||'无法进入管理后台');location.href='/control/';});
  action('退出登录',async function(){await App.Auth.signOut();});menu.hidden=false;card.setAttribute('aria-expanded','true');
 }
 card.addEventListener('click',function(){toggle().catch(function(){App.Toast.show('账户信息暂不可用','请稍后重试','err');});});card.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();card.click();}});
 document.addEventListener('click',function(e){if(!card.contains(e.target)&&!menu.contains(e.target))close();});document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!menu.hidden&&!e.defaultPrevented){close();card.focus();}});
})();
