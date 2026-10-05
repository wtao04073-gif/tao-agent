(function(){'use strict';
 function refresh(){fetch('/api/branding').then(function(r){return r.json();}).then(function(b){
  if(b.name){document.title=b.name;document.querySelectorAll('[data-brand-name],.rail-logo b,.auth-card h1').forEach(function(n){n.textContent=b.name;});}
  document.querySelectorAll('[data-brand-logo],.rail-logo .bot,.auth-logo,.brand-icon').forEach(function(n){n.replaceChildren();if(b.logo){var img=document.createElement('img');img.src=b.logo;img.alt=b.name||'';img.width=32;img.height=32;n.appendChild(img);}else n.textContent=b.shortName||'Tao';});
  if(b.logo){var icon=document.querySelector('link[rel="icon"]')||document.createElement('link');icon.rel='icon';icon.href=b.logo;document.head.appendChild(icon);}
  var title=document.querySelector('.landing h1');if(title&&b.welcome)title.textContent=b.welcome;
  var description=document.querySelector('.landing .lead');if(description&&b.description)description.textContent=b.description;
 }).catch(function(){});}
 refresh();window.addEventListener('tao:branding-changed',refresh);
})();
