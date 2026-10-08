// 不缓存会话、API 或产物：退出后不保留工作区内容。
self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(event){event.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(event){if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(function(){return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>网络不可用</title><p>请恢复网络连接后重新打开 Tao Agent。</p></html>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});}));});
