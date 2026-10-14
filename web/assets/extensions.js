/* 扩展命令与组件：仅构建安全 DOM，执行始终经过服务端的一次性确认。 */
(function (global) {
  'use strict';

  function create(options) {
    var doc = options.document || global.document;
    var catalog = { extensions: [], commands: [], components: [] };
    var loading = null, busy = false, mounts = [], instances = new Map();
    function el(tag, text, cls) {
      var node = doc.createElement(tag);
      if (text !== undefined) node.textContent = String(text == null ? '' : text);
      if (cls) node.className = cls;
      return node;
    }
    function button(label, action) {
      var node = el('button', label); node.type = 'button';
      node.addEventListener('click', action); return node;
    }
    function status(host, message, error) {
      host.textContent = message; host.className = 'extension-status' + (error ? ' is-error' : '');
      host.setAttribute('role', error ? 'alert' : 'status');
    }
    function context() { return options.context ? options.context() : null; }
    function current(snapshot) { return !options.isCurrent || options.isCurrent(snapshot); }
    async function api(method, path, body) {
      var response = await (options.api || global.App.api)(method, path, body);
      if (!response.ok) throw new Error(response.data && response.data.error || '扩展请求失败，请稍后重试');
      return response.data || {};
    }
    async function load() {
      if (!loading) loading = api('GET', '/api/extensions').then(function (data) {
        catalog = {
          extensions: Array.isArray(data.extensions) ? data.extensions : [],
          commands: Array.isArray(data.commands) ? data.commands : (data.extensions || []).filter(function (entry) { return entry.enabled; }).flatMap(function (entry) { return entry.commands || []; }),
          components: Array.isArray(data.components) ? data.components : (data.extensions || []).filter(function (entry) { return entry.enabled; }).flatMap(function (entry) { return entry.components || entry.ui || []; })
        };
        return catalog;
      }).finally(function () { loading = null; });
      return loading;
    }
    function argsObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('命令参数必须是 JSON 对象');
      return value;
    }
    async function execute(command, args, host, afterSuccess) {
      if (busy) { status(host, '已有扩展命令正在等待确认或执行，请完成后再试'); return; }
      var snapshot = context(); busy = true;
      status(host, '正在准备命令确认…');
      try {
        // 固定参数快照；确认期间的表单编辑不会改变已授权的请求。
        var payload = { command: command, args: argsObject(JSON.parse(JSON.stringify(args))) };
        var pending = await api('POST', '/api/extensions/commands', payload);
        if (!current(snapshot)) return;
        if (typeof pending.confirmationId !== 'string' || !pending.confirmationId) throw new Error('服务未返回有效的命令确认，请刷新后重试');
        var confirmed = await (options.confirm || global.App.Dialog.confirm.bind(global.App.Dialog))({
          title: '执行扩展命令 /' + command + '？',
          description: String(pending.reason || pending.description || '此命令将执行扩展操作。') + '\n\n参数：\n' + JSON.stringify(payload.args, null, 2),
          confirmText: '确认执行', cancelText: '取消'
        });
        if (!current(snapshot)) return;
        if (!confirmed) { status(host, '已取消，命令未执行'); return; }
        status(host, '命令执行中…');
        var result = await api('POST', '/api/extensions/commands', Object.assign({}, payload, { confirmationId: pending.confirmationId }));
        if (!current(snapshot)) return;
        if (result.confirmationId) throw new Error('确认已失效，请重新发起命令');
        host.replaceChildren(); host.className = 'extension-result'; host.setAttribute('role', 'status');
        if (typeof result.text === 'string') host.append(el('p', result.text, 'extension-text'));
        if (result.ui) renderUI(result.ui, host, 'command');
        if (!result.text && !result.ui) host.append(el('p', '命令已完成'));
        if (afterSuccess) afterSuccess();
        if (typeof result.prompt === 'string' && result.prompt && options.fillPrompt) {
          options.fillPrompt(result.prompt, snapshot);
          host.append(el('p', '已将建议内容填入输入框，请检查后发送。', 'extension-help'));
        }
      } catch (error) {
        if (current(snapshot)) status(host, error.message || '网络异常，执行结果未确认。请先核对结果再重试。', true);
      } finally { busy = false; }
    }
    function renderNode(view, depth) {
      if (!view || depth > 12) return el('p', '组件内容无效');
      var node;
      switch (view.type) {
        case 'text': return el('p', view.text, 'extension-text');
        case 'card':
          node = el('section', undefined, 'extension-card'); node.append(el('h4', view.title));
          (Array.isArray(view.children) ? view.children : []).slice(0, 100).forEach(function (child) { node.append(renderNode(child, depth + 1)); });
          return node;
        case 'table': {
          node = el('div', undefined, 'extension-table');
          var table = el('table'), head = el('thead'), header = el('tr'), body = el('tbody');
          var columns = Array.isArray(view.columns) ? view.columns.slice(0, 30) : [];
          columns.forEach(function (column) { var th = el('th', column); th.scope = 'col'; header.append(th); });
          head.append(header); table.append(head, body);
          (Array.isArray(view.rows) ? view.rows : []).slice(0, 500).forEach(function (row) {
            var tr = el('tr'); columns.forEach(function (_, index) { tr.append(el('td', Array.isArray(row) ? row[index] : '')); }); body.append(tr);
          });
          node.append(table); return node;
        }
        case 'progress': {
          node = el('label', undefined, 'extension-progress');
          var max = Number.isFinite(view.max) && view.max > 0 ? view.max : 100;
          var value = Number.isFinite(view.value) ? Math.min(max, Math.max(0, view.value)) : 0;
          var progress = el('progress'); progress.max = max; progress.value = value;
          progress.setAttribute('aria-label', String(view.label || '进度'));
          node.append(el('span', String(view.label || '进度') + ' · ' + value + ' / ' + max), progress); return node;
        }
        case 'form': {
          node = el('form', undefined, 'extension-form'); node.append(el('h4', view.title));
          var fields = [];
          (Array.isArray(view.fields) ? view.fields : []).slice(0, 50).forEach(function (field) {
            if (!field || typeof field.name !== 'string' || !['text', 'number', 'select'].includes(field.type)) return;
            var label = el('label', field.label || field.name), input = el(field.type === 'select' ? 'select' : 'input');
            input.name = field.name; input.required = field.required === true;
            if (field.type === 'select') {
              var placeholder = el('option', '请选择'); placeholder.value = ''; input.append(placeholder);
              (Array.isArray(field.options) ? field.options : []).forEach(function (option) { var opt = el('option', option); opt.value = String(option); input.append(opt); });
            } else { input.type = field.type; if (field.type === 'number') input.step = 'any'; }
            label.append(input); node.append(label); fields.push({ field: field, input: input });
          });
          var submit = el('button', view.submitLabel || '提交'); submit.type = 'submit';
          var output = el('div'); node.append(submit, output);
          node.addEventListener('submit', async function (event) {
            event.preventDefault(); if (submit.disabled || !node.reportValidity()) return;
            var args = Object.create(null);
            fields.forEach(function (item) { if (item.input.value !== '') args[item.field.name] = item.field.type === 'number' ? Number(item.input.value) : item.input.value; });
            submit.disabled = true;
            try { await execute(view.command, args, output); } finally { submit.disabled = false; }
          });
          return node;
        }
        case 'button': {
          node = el('div', undefined, 'extension-action'); var result = el('div');
          var action = button(view.label, async function () {
            if (action.disabled) return; action.disabled = true;
            try { await execute(view.command, view.args || {}, result); } finally { action.disabled = false; }
          }); node.append(action, result); return node;
        }
        default: return el('p', '当前版本不支持此组件');
      }
    }
    function renderUI(ui, host, scope) {
      if (!ui || typeof ui.extensionId !== 'string' || typeof ui.component !== 'string' || typeof ui.instanceId !== 'string') return false;
      var key = JSON.stringify([scope || '', ui.extensionId, ui.component, ui.instanceId]);
      var wrapper = instances.get(key);
      if (!wrapper || !host.contains(wrapper)) {
        wrapper = el('section', undefined, 'extension-ui');
        wrapper.dataset.extensionId = ui.extensionId; wrapper.dataset.instanceId = ui.instanceId;
        host.append(wrapper); instances.set(key, wrapper);
      }
      wrapper.replaceChildren(el('small', ui.extensionId + ' · ' + ui.component, 'extension-source'), renderNode(ui.view, 0));
      return true;
    }
    function consume(event, host) {
      if (!event || event.type !== 'extension_ui') return false;
      return renderUI(event.ui, host, event.taskId);
    }
    function editor(command, mount) {
      mount.editor.replaceChildren(); mount.output.replaceChildren();
      var form = el('form', undefined, 'extension-form'), fields = [];
      form.append(el('h4', '/' + command.name), el('p', command.description || '', 'extension-help'));
      var schema = command.parameters || {}, properties = schema.properties || {};
      Object.keys(properties).slice(0, 50).forEach(function (name) {
        var spec = properties[name] || {}, choices = spec.enum || (Object.hasOwn(spec, 'const') ? [spec.const] : spec.type === 'boolean' ? [true, false] : spec.type === 'null' ? [null] : null);
        var complex = spec.type === 'object' || spec.type === 'array';
        var label = el('label', spec.title || name), input = el(choices ? 'select' : complex ? 'textarea' : 'input');
        input.name = name; input.required = Array.isArray(schema.required) && schema.required.includes(name);
        if (choices) {
          var empty = el('option', '请选择'); empty.value = ''; input.append(empty);
          choices.forEach(function (choice, index) { var opt = el('option', String(choice)); opt.value = String(index); input.append(opt); });
        } else if (!complex) { input.type = ['number', 'integer'].includes(spec.type) ? 'number' : 'text'; if (input.type === 'number') input.step = spec.type === 'integer' ? '1' : 'any'; }
        if (spec.default !== undefined) {
          if (choices) { var selected = choices.findIndex(function (choice) { return JSON.stringify(choice) === JSON.stringify(spec.default); }); if (selected >= 0) input.value = String(selected); }
          else input.value = complex ? JSON.stringify(spec.default) : String(spec.default);
        }
        if (typeof spec.minimum === 'number') input.min = String(spec.minimum);
        if (typeof spec.maximum === 'number') input.max = String(spec.maximum);
        if (typeof spec.minLength === 'number') input.minLength = spec.minLength;
        if (typeof spec.maxLength === 'number') input.maxLength = spec.maxLength;
        if (spec.description) label.append(el('small', spec.description));
        if (complex) input.placeholder = spec.type === 'array' ? '[]' : '{}';
        label.append(input); form.append(label); fields.push({ name: name, input: input, spec: spec, choices: choices, complex: complex });
      });
      var extra = null;
      if (!Object.keys(properties).length && schema.additionalProperties !== false) {
        var label = el('label', '命令参数（可选 JSON 对象）'); extra = el('textarea'); extra.value = '{}'; label.append(extra); form.append(label);
      }
      var submit = el('button', '执行命令'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', async function (event) {
        event.preventDefault(); if (submit.disabled || !form.reportValidity()) return;
        try {
          var args = extra ? argsObject(JSON.parse(extra.value || '{}')) : Object.create(null);
          fields.forEach(function (field) {
            if (field.input.value === '') return;
            args[field.name] = field.choices ? field.choices[Number(field.input.value)] : field.complex ? JSON.parse(field.input.value) : ['number', 'integer'].includes(field.spec.type) ? Number(field.input.value) : field.input.value;
          });
          var source = mount.input.value;
          submit.disabled = true; await execute(command.name, args, mount.output, function () { if (mount.input.value === source) clearSlash(mount.input); });
        } catch (error) { status(mount.output, '参数格式不正确：' + error.message, true); }
        finally { submit.disabled = false; }
      });
      mount.editor.append(form);
    }
    function clearSlash(input) {
      if (input.value.trim().startsWith('/')) { input.value = ''; input.dispatchEvent(new global.Event('input', { bubbles: true })); }
    }
    function renderCatalog(mount) {
      var filter = mount.search.value.trim().toLowerCase(); mount.list.replaceChildren();
      var commands = catalog.commands.filter(function (command) { return typeof command.name === 'string' && (command.name + ' ' + (command.description || '')).toLowerCase().includes(filter); });
      commands.forEach(function (command) {
        var pick = button('/' + command.name + ' — ' + (command.description || '扩展命令'), function () { editor(command, mount); });
        mount.list.append(pick);
      });
      if (!commands.length) mount.list.append(el('p', filter ? '没有匹配的扩展命令' : '暂无已启用的扩展命令'));
      status(mount.status, catalog.extensions.length + ' 个扩展 · ' + catalog.commands.length + ' 个命令 · ' + catalog.components.length + ' 个组件');
    }
    async function show(mount, filter) {
      mount.panel.hidden = false; mount.toggle.setAttribute('aria-expanded', 'true');
      if (filter !== undefined) mount.search.value = filter;
      status(mount.status, '正在加载扩展…');
      try { await load(); renderCatalog(mount); return true; } catch (error) { status(mount.status, error.message, true); return false; }
    }
    function hide(mount) { mount.panel.hidden = true; mount.toggle.setAttribute('aria-expanded', 'false'); }
    function mount(input, toolbar) {
      var panel = el('section', undefined, 'extension-picker'); panel.hidden = true; panel.id = input.id + '-extensions';
      var heading = el('div', undefined, 'extension-picker-heading'); heading.append(el('h3', '扩展命令与技能'));
      var item = { input: input, panel: panel, search: el('input'), list: el('div', undefined, 'extension-command-list'), editor: el('div'), output: el('div'), status: el('p') };
      item.toggle = button('扩展命令', function () { if (panel.hidden) show(item); else hide(item); });
      item.toggle.className = 'extension-toggle'; item.toggle.setAttribute('aria-controls', panel.id); item.toggle.setAttribute('aria-expanded', 'false');
      heading.append(button('刷新', function () { show(item); }), button('关闭', function () { hide(item); input.focus(); }));
      item.search.type = 'search'; item.search.placeholder = '搜索命令'; item.search.setAttribute('aria-label', '搜索扩展命令');
      item.search.addEventListener('input', function () { renderCatalog(item); });
      panel.append(heading, el('p', '选择命令填写参数，或输入 /命令 {"参数":"值"}。执行前会显示确认。', 'extension-help'),
        button('选择技能', function () { clearSlash(input); hide(item); options.openSkills(); }), item.search, item.status, item.list, item.editor, item.output);
      input.closest('.inputcard').prepend(panel); if (toolbar) toolbar.append(item.toggle); mounts.push(item);
      input.addEventListener('input', function () {
        var value = input.value.trim();
        if (/^\/\S*$/.test(value)) show(item, value.slice(1));
      });
      input.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide(item); });
      return item;
    }
    function dispatchSlash(text, input) {
      if (!text.startsWith('/')) return false;
      var item = mounts.find(function (m) { return m.input === input; });
      if (!item) return false;
      var snapshot = context(), match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      show(item, match ? match[1] : '').then(async function (loaded) {
        if (!loaded || !current(snapshot)) return;
        if (!match) return;
        if (match[1] === 'skill' || match[1] === '技能') { clearSlash(input); hide(item); options.openSkills(); return; }
        var command = catalog.commands.find(function (entry) { return entry.name === match[1]; });
        if (!command) { status(item.output, '没有找到该扩展命令。请选择上方命令或技能；此内容未发送给模型。', true); return; }
        if (!match[2]) { editor(command, item); return; }
        try { await execute(command.name, argsObject(JSON.parse(match[2])), item.output, function () { if (input.value.trim() === text) clearSlash(input); }); }
        catch (error) { status(item.output, '参数格式不正确，请提供 JSON 对象或使用上方命令表单。', true); }
      });
      return true;
    }
    return { mount: mount, dispatchSlash: dispatchSlash, execute: execute, renderUI: renderUI, consume: consume,
      open: function (input) { var item = mounts.find(function (m) { return m.input === input; }); if (item) show(item); },
      reset: function () { instances.clear(); mounts.forEach(function (item) { hide(item); item.editor.replaceChildren(); item.output.replaceChildren(); }); }, load: load };
  }
  global.TaoExtensions = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
