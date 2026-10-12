(function (global) {
  'use strict';
  function el(tag, text, cls) { var node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; }
  async function request(method, body) {
    var token = sessionStorage.getItem('tao.control.token') || '';
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var response = await fetch('/api/control/extensions', { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || '无法读取或更新扩展，请确认管理身份后重试');
    return data;
  }
  function mount(host) {
    if (!host || host.dataset.extensionsMounted) return;
    host.dataset.extensionsMounted = 'true'; host.classList.add('extension-admin');
    var heading = el('div', undefined, 'extension-admin-heading'), refresh = el('button', '刷新扩展'); refresh.type = 'button';
    heading.append(el('h2', '扩展管理'), refresh);
    var status = el('p'), list = el('div', undefined, 'extension-admin-list'); status.setAttribute('role', 'status');
    host.append(heading, el('p', '查看已部署扩展的命令、工具和界面组件，并控制其启用状态。'), status, list);
    var loading = false, changing = false;
    async function load() {
      if (loading) return; loading = true; refresh.disabled = true; status.textContent = '正在加载扩展…';
      try {
        var data = await request('GET'); list.replaceChildren();
        var extensions = Array.isArray(data.extensions) ? data.extensions : [];
        extensions.forEach(function (extension) {
          var row = el('article', undefined, 'extension-admin-item');
          row.append(el('h3', extension.name || extension.id), el('p', extension.id + ' · ' + (extension.version || '') + ' · ' + (extension.enabled ? '已启用' : '已停用'), 'extension-admin-meta'));
          if (extension.error) row.append(el('p', extension.error, 'extension-status is-error'));
          [['commands', '命令'], ['tools', '工具'], ['components', '界面组件']].forEach(function (pair) {
            var local = pair[0] === 'components' ? extension.components || extension.ui : extension[pair[0]];
            var entries = Array.isArray(local) ? local : (Array.isArray(data[pair[0]]) ? data[pair[0]] : []).filter(function (item) { return item.extensionId === extension.id; });
            row.append(el('p', pair[1] + '：' + (entries.length ? entries.map(function (entry) { return typeof entry === 'string' ? entry : entry.name || entry.component || ''; }).join('、') : '暂无')));
          });
          var toggle = el('button', extension.enabled ? '停用扩展' : '启用扩展'); toggle.type = 'button';
          toggle.addEventListener('click', async function () {
            if (toggle.disabled || loading || changing) return; toggle.disabled = true; changing = true;
            try {
              var yes = await global.App.Dialog.confirm({ title: (extension.enabled ? '停用' : '启用') + '扩展「' + (extension.name || extension.id) + '」？', description: '变更后将按服务端策略应用到扩展命令与任务。', confirmText: extension.enabled ? '停用' : '启用' });
              if (!yes) return;
              await request('PATCH', { id: extension.id, enabled: !extension.enabled });
              await load();
            } catch (error) { status.textContent = error.message; status.setAttribute('role', 'alert'); }
            finally { toggle.disabled = false; changing = false; }
          });
          row.append(toggle); list.append(row);
        });
        status.textContent = extensions.length ? '已加载 ' + extensions.length + ' 个扩展' : '尚未部署扩展'; status.setAttribute('role', 'status');
      } catch (error) { status.textContent = error.message; status.setAttribute('role', 'alert'); }
      finally { loading = false; refresh.disabled = false; }
    }
    refresh.addEventListener('click', load); load();
  }
  global.TaoControlExtensions = { mount: mount };
  function start() { mount(document.getElementById('extensionsAdmin')); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})(window);
