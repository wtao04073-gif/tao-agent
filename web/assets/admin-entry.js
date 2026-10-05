(function(){'use strict';
 var card=document.querySelector('.usercard');if(!card)return;
 var menu=document.createElement('div');menu.className='account-menu';menu.hidden=true;card.parentNode.insertBefore(menu,card);
 card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label','账户与管理设置');card.setAttribute('aria-expanded','false');
 function close(){menu.hidden=true;card.setAttribute('aria-expanded','false');}
 function action(label,fn){var b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',async function(){close();try{await fn();}catch(e){await App.Dialog.alert({description:e.message});}});menu.appendChild(b);}
 async function toggle(){if(!menu.hidden){close();return;}var me=await App.api('GET','/api/me');if(!me.ok){location.href='/admin-login.html';return;}menu.replaceChildren();
  action('个人设置',async function(){await App.Dialog.alert({title:'个人设置',description:'姓名：'+(me.data.name||'成员')+'；角色：'+(App.ROLE_LABELS&&App.ROLE_LABELS[me.data.role]||me.data.role)+'。账号及工作区由管理员维护。可在对话输入区选择是否显示思考与流式输出。'});});
  action('切换明暗主题',async function(){var dark=document.documentElement.getAttribute('data-theme')!=='dark';localStorage.setItem('tao.theme',dark?'dark':'light');location.reload();});
  if(['TENANT_ADMIN','PLATFORM_ADMIN'].includes(me.data.role))action('管理后台',async function(){var r=await App.api('POST','/api/control/session',{});if(!r.ok)throw Error(r.data.error||'无法进入管理后台');location.href='/control/';});
  action('退出登录',async function(){await App.Auth.signOut();});menu.hidden=false;card.setAttribute('aria-expanded','true');
 }
 card.addEventListener('click',function(){toggle().catch(function(){location.href='/admin-login.html';});});card.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();card.click();}});
 document.addEventListener('click',function(e){if(!card.contains(e.target)&&!menu.contains(e.target))close();});document.addEventListener('keydown',function(e){if(e.key==='Escape'){close();card.focus();}});
})();
