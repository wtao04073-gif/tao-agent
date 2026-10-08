(function (global) {
  'use strict';

  function element(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function field(form, name, label, options) {
    options = options || {};
    var wrap = element('label', label, 'enterprise-field');
    var input = element(options.multiline ? 'textarea' : options.choices ? 'select' : 'input');
    input.name = name;
    input.setAttribute('aria-label', label);
    if (options.choices) options.choices.forEach(function (choice) {
      var option = element('option', choice[1]); option.value = choice[0]; input.append(option);
    });
    else if (!options.multiline) input.type = options.type || 'text';
    if (options.type === 'password') { input.autocomplete = 'new-password'; input.spellcheck = false; }
    if (options.required) input.required = true;
    if (options.max) input.maxLength = options.max;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.value !== undefined) input.value = options.value;
    if (options.type === 'checkbox') { input.checked = options.checked === true; wrap.classList.add('enterprise-check'); }
    if (options.multiple) { input.multiple = true; Array.from(input.options).forEach(function (o) { o.selected = false; }); }
    if (options.min !== undefined) input.min = options.min;
    wrap.append(input);
    if (options.help) wrap.append(element('small', options.help));
    form.append(wrap);
    return input;
  }
  function message(host, text, error) {
    host.textContent = text || '';
    host.hidden = !text;
    host.className = 'enterprise-notice' + (error ? ' is-error' : '');
    host.setAttribute('role', error ? 'alert' : 'status');
  }
  function button(label, action, status, danger) {
    var node = element('button', label, danger ? 'enterprise-danger' : ''); node.type = 'button';
    node.addEventListener('click', async function () {
      node.disabled = true;
      try { await action(); } catch (error) { message(status, error.message || '操作失败，请重试', true); }
      finally { node.disabled = false; }
    });
    return node;
  }
  function submit(form, label, action, status) {
    var node = element('button', label, 'enterprise-primary'); node.type = 'submit'; form.append(node);
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); if (node.disabled || !form.reportValidity()) return;
      node.disabled = true; message(status, '正在保存…');
      try { await action(); } catch (error) { message(status, error.message || '保存失败，请重试', true); }
      finally { node.disabled = false; }
    });
  }
  async function confirmChange(title, description) {
    if (global.App && App.Dialog) return App.Dialog.confirm({ title: title, description: description, danger: true });
    return global.confirm(title + '\n' + description);
  }
  function listText(value) { return value.replaceAll('，', ',').split(/[,\r\n]+/).map(function (s) { return s.trim(); }).filter(Boolean); }

  async function mount(host) {
    if (!host || host.dataset.enterpriseMounted) return;
    host.dataset.enterpriseMounted = 'true'; host.classList.add('enterprise-settings');
    var principal, accounts = [], targetTenant = '', generation = 0, connectorGeneration = 0;
    var globalStatus = element('p'); globalStatus.hidden = true;
    var scope = element('div', undefined, 'enterprise-scope');
    var organizationHost = element('section', undefined, 'enterprise-card');
    var oidcHost = element('section', undefined, 'enterprise-card');
    var connectorsHost = element('section', undefined, 'enterprise-card');
    host.append(element('h2', '组织、单点登录与连接器'), globalStatus, scope, organizationHost, oidcHost, connectorsHost);

    async function api(method, path, body) {
      var token = sessionStorage.getItem('tao.control.token') || '';
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      else if (!['GET', 'HEAD'].includes(method)) {
        var sessionResponse = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
        var session = await sessionResponse.json().catch(function () { return {}; });
        if (!sessionResponse.ok || !session.csrf) throw new Error('管理会话已失效，请重新登录后重试');
        headers['X-CSRF-Token'] = session.csrf;
      }
      var response = await fetch(path, {
        method: method, credentials: 'same-origin', cache: 'no-store', headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || ({401:'请先登录管理账号',403:'当前账号无权执行此操作',404:'接口或对象不存在',429:'请求过于频繁，请稍后重试'}[response.status] || '请求失败（' + response.status + '）'));
      return data;
    }
    function endpoint(path, tenant) { return '/api/admin/enterprise' + (path || '') + '?tenantId=' + encodeURIComponent(tenant); }
    function accountChoices(enabledOnly) {
      return accounts.filter(function (a) { return a.tenantId === targetTenant && (!enabledOnly || a.enabled); }).map(function (a) {
        return [a.id, a.name + ' · ' + a.username + (a.enabled ? '' : '（已停用）')];
      });
    }
    function section(host, title, description) {
      host.replaceChildren(element('h3', title), element('p', description, 'enterprise-help'));
      var status = element('p'); status.hidden = true; host.append(status); return status;
    }
    async function refreshOrganization() {
      var version = generation, tenant = targetTenant;
      var status = section(organizationHost, '组织与访问范围', '组织配置立即生效。IP 白名单会限制该组织的登录与业务请求。');
      try {
        var data = await api('GET', endpoint('', tenant)); if (version !== generation) return;
        var org = data.organization;
        var form = element('form', undefined, 'enterprise-form');
        var name = field(form, 'name', '组织名称', {required:true,max:120,value:org.name});
        var seats = field(form, 'seatLimit', '席位上限', {type:'number',min:1,value:org.seatLimit === null ? '' : org.seatLimit,help:'留空表示不限制；不能少于已启用账号数。当前已用 ' + org.seatsUsed + ' 个席位。'}); seats.max = '1000000'; seats.step = '1';
        var cidrs = field(form, 'allowedCidrs', '允许的 IP / CIDR', {multiline:true,value:(org.allowedCidrs || []).join('\n'),help:'每行一个地址或 CIDR，留空不限制。请包含管理员实际来源，否则保存后可能无法继续访问。'});
        form.append(element('p', org.trustedProxyConfigured ? '服务端已配置可信代理，按可信转发链识别来源。' : '服务端未配置可信代理，按连接对端地址识别来源。', 'enterprise-help'));
        submit(form, '保存组织设置', async function () {
          var allowed = listText(cidrs.value);
          if (JSON.stringify(allowed) !== JSON.stringify(org.allowedCidrs || []) && !await confirmChange('更新 IP 访问范围？', '新规则立即生效。请确认规则包含当前管理员来源；错误配置可能阻断后续访问。')) { message(status, '已取消，组织配置未保存'); return; }
          await api('PATCH', endpoint('', tenant), {name:name.value.trim(),seatLimit:seats.value.trim() ? Number(seats.value) : null,allowedCidrs:allowed});
          if (version !== generation) return; await refreshOrganization(); message(globalStatus, '组织配置已保存');
        }, status);
        organizationHost.append(form); renderDepartments(org, version, tenant);
      } catch (error) { if (version === generation) message(status, error.message, true); }
    }
    function renderDepartments(org, version, tenant) {
      var box = element('div', undefined, 'enterprise-subsection'), list = element('div'), form = element('form', undefined, 'enterprise-form'), status = element('p'); status.hidden = true;
      var title = element('h4', '新增部门'), editingId = null;
      box.append(element('h4', '部门树'), list, title, status, form); organizationHost.append(box);
      var departmentName = field(form, 'name', '部门名称', {required:true,max:120});
      var parent = field(form, 'parentId', '上级部门', {choices:[['','无（根部门）']].concat(org.departments.map(function (d) { return [d.id,d.name]; }))});
      var members = field(form, 'accountIds', '部门成员', {choices:accountChoices(false),multiple:true,help:'可选择多个本组织账号；部门划分不会自动改变账号角色。'}); members.size = Math.min(8, Math.max(3, members.options.length));
      function reset() { editingId = null; title.textContent = '新增部门'; departmentName.value = ''; parent.value = ''; Array.from(parent.options).forEach(function (o) { o.disabled = false; }); Array.from(members.options).forEach(function (o) { o.selected = false; }); }
      function edit(department) {
        editingId = department.id; title.textContent = '编辑部门：' + department.name; departmentName.value = department.name; parent.value = department.parentId || '';
        Array.from(parent.options).forEach(function (o) { o.disabled = o.value === department.id; });
        Array.from(members.options).forEach(function (o) { o.selected = department.accountIds.includes(o.value); }); departmentName.focus();
      }
      var seen = new Set();
      function tree(parentId, target) {
        org.departments.filter(function (d) { return d.parentId === parentId; }).forEach(function (department) {
          if (seen.has(department.id)) return; seen.add(department.id);
          var item = element('li'), actions = element('div', undefined, 'enterprise-actions');
          item.append(element('strong', department.name), element('span', ' · ' + department.accountIds.length + ' 位成员'));
          actions.append(button('编辑', function () { edit(department); }, status), button('删除', async function () {
            if (!await confirmChange('删除部门？', '删除「' + department.name + '」，账号本身保留。有子部门时需先调整子部门。')) return;
            await api('DELETE', endpoint('/departments/' + encodeURIComponent(department.id), tenant)); if (version === generation) { await refreshOrganization(); message(globalStatus, '部门已删除'); }
          }, status, true)); item.append(actions); var nested = element('ul'); tree(department.id, nested); if (nested.children.length) item.append(nested); target.append(item);
        });
      }
      var root = element('ul', undefined, 'enterprise-tree'); tree(null, root); list.append(root);
      if (!org.departments.length) list.append(element('p', '暂无部门。'));
      submit(form, '保存部门', async function () {
        await api('POST', endpoint('/departments', tenant), Object.assign({name:departmentName.value.trim(),parentId:parent.value || null,accountIds:Array.from(members.selectedOptions).map(function (o) { return o.value; })}, editingId ? {id:editingId} : {}));
        if (version === generation) { await refreshOrganization(); message(globalStatus, '部门已保存'); }
      }, status); form.append(button('清空并新增', reset, status));
    }
    async function refreshOidc() {
      var version = generation, tenant = targetTenant;
      var status = section(oidcHost, 'OIDC 单点登录', '配置授权码与 PKCE 登录。必须显式绑定外部 subject（sub）与已启用内部账号，不按邮箱自动映射。保存配置不会访问身份提供商。');
      try {
        var results = await Promise.all([api('GET', endpoint('/oidc/providers', tenant)), api('GET', endpoint('/oidc/bindings', tenant))]); if (version !== generation) return;
        var providers = results[0].providers, bindings = results[1].bindings;
        var list = element('div', undefined, 'enterprise-list'), form = element('form', undefined, 'enterprise-form'), title = element('h4', '新增身份提供商'), editingId = null;
        oidcHost.append(list, title, form);
        var name = field(form, 'name', '提供商名称', {required:true,max:120});
        var issuer = field(form, 'issuer', 'Issuer', {required:true,type:'url',placeholder:'https://identity.example.com',help:'必须是 HTTPS 地址，不含查询参数。'});
        var clientId = field(form, 'clientId', 'Client ID', {required:true,max:256});
        var clientSecret = field(form, 'clientSecret', 'Client Secret', {type:'password',max:4096,placeholder:'新配置按认证方式填写；编辑时留空保持'});
        var redirect = field(form, 'redirectUri', '回调地址', {required:true,type:'url',value:location.protocol === 'https:' ? location.origin + '/api/auth/oidc/callback' : '',placeholder:'https://你的站点/api/auth/oidc/callback',help:'须与身份提供商登记的 HTTPS 回调地址完全一致。'});
        var auth = field(form, 'tokenAuthMethod', '令牌端点认证方式', {choices:[['client_secret_basic','客户端密钥（Basic）'],['client_secret_post','客户端密钥（POST）'],['none','公共客户端（无密钥）']]});
        var enabled = field(form, 'enabled', '启用此提供商登录', {type:'checkbox'});
        function populate(provider) {
          editingId = provider.id || null; title.textContent = editingId ? '编辑身份提供商：' + provider.name : '新增身份提供商';
          name.value = provider.name || ''; issuer.value = provider.issuer || ''; clientId.value = provider.clientId || ''; clientSecret.value = '';
          clientSecret.placeholder = provider.hasClientSecret ? '密钥已配置；留空保持原值' : '尚未配置密钥'; redirect.value = provider.redirectUri || (location.protocol === 'https:' ? location.origin + '/api/auth/oidc/callback' : ''); auth.value = provider.tokenAuthMethod || 'client_secret_basic'; enabled.checked = provider.enabled === true; name.focus();
        }
        function providerBody(provider, nextEnabled) { return {id:provider.id,name:provider.name,issuer:provider.issuer,clientId:provider.clientId,redirectUri:provider.redirectUri,tokenAuthMethod:provider.tokenAuthMethod,enabled:nextEnabled}; }
        providers.forEach(function (provider) {
          var row = element('article', undefined, 'enterprise-row'), actions = element('div', undefined, 'enterprise-actions');
          row.append(element('h4', provider.name), element('p', (provider.enabled ? '登录已启用' : '登录已停用') + ' · ' + (provider.hasClientSecret ? '已保存客户端密钥' : '未保存客户端密钥')), element('p', provider.issuer, 'enterprise-url'));
          row.append(element('p', '保存状态不代表已通过身份提供商联通验证。', 'enterprise-help'));
          actions.append(button('编辑', function () { populate(provider); }, status), button(provider.enabled ? '停用登录' : '启用登录', async function () {
            await api('POST', endpoint('/oidc/providers', tenant), providerBody(provider, !provider.enabled)); if (version === generation) { await refreshOidc(); message(globalStatus, 'OIDC 登录状态已更新'); }
          }, status), button('删除提供商', async function () {
            if (!await confirmChange('删除身份提供商？', '删除配置与其全部 sub 绑定；现有内部账号保留。')) return;
            await api('DELETE', endpoint('/oidc/providers/' + encodeURIComponent(provider.id), tenant)); if (version === generation) { await refreshOidc(); message(globalStatus, '提供商已删除'); }
          }, status, true)); row.append(actions); list.append(row);
        });
        if (!providers.length) list.append(element('p', '尚未配置身份提供商，当前不能使用 OIDC 登录。'));
        submit(form, '保存身份提供商', async function () {
          var value = {name:name.value.trim(),issuer:issuer.value.trim(),clientId:clientId.value.trim(),redirectUri:redirect.value.trim(),tokenAuthMethod:auth.value,enabled:enabled.checked};
          if (editingId) value.id = editingId;
          if (clientSecret.value !== '') value.clientSecret = clientSecret.value;
          await api('POST', endpoint('/oidc/providers', tenant), value); clientSecret.value = '';
          if (version === generation) { await refreshOidc(); message(globalStatus, 'OIDC 配置已保存，未发起外部登录或联通请求'); }
        }, status); form.append(button('清空并新增', function () { populate({}); }, status));
        var bindBox = element('div', undefined, 'enterprise-subsection'), bindForm = element('form', undefined, 'enterprise-form'); bindBox.append(element('h4', '外部 sub 与内部账号绑定'), bindForm); oidcHost.append(bindBox);
        var providerPick = field(bindForm, 'providerId', '身份提供商', {required:true,choices:[['','请选择']].concat(providers.map(function (p) { return [p.id,p.name]; }))});
        var subject = field(bindForm, 'subject', '外部 subject（sub）', {required:true,max:512,help:'填写身份提供商返回的精确 sub，同一提供商和 sub 再次保存会更新对应账号。'});
        var account = field(bindForm, 'accountId', '绑定的内部账号', {required:true,choices:[['','请选择已启用账号']].concat(accountChoices(true))});
        submit(bindForm, '保存账号绑定', async function () {
          var prior = bindings.find(function (b) { return b.providerId === providerPick.value && b.subject === subject.value; });
          if (prior && prior.accountId !== account.value && !await confirmChange('更新已有身份绑定？', '此 sub 后续登录将进入新选择的内部账号。')) { message(status, '已取消，账号绑定未保存'); return; }
          await api('POST', endpoint('/oidc/bindings', tenant), {providerId:providerPick.value,subject:subject.value,accountId:account.value}); if (version === generation) { await refreshOidc(); message(globalStatus, '账号绑定已保存'); }
        }, status);
        bindings.forEach(function (binding) {
          var row = element('article', undefined, 'enterprise-row'), provider = providers.find(function (p) { return p.id === binding.providerId; }), internal = accounts.find(function (a) { return a.id === binding.accountId; });
          row.append(element('p', (provider ? provider.name : '已移除的提供商') + ' · sub：' + binding.subject), element('p', '内部账号：' + (internal ? internal.name + ' · ' + internal.username : binding.accountId)));
          row.append(button('解除绑定', async function () {
            if (!await confirmChange('解除此账号绑定？', '该外部 sub 将无法通过此绑定登录，内部账号保留。')) return;
            await api('DELETE', endpoint('/oidc/bindings/' + encodeURIComponent(binding.id), tenant)); if (version === generation) { await refreshOidc(); message(globalStatus, '账号绑定已解除'); }
          }, status, true)); bindBox.append(row);
        });
      } catch (error) { if (version === generation) message(status, error.message, true); }
    }
    async function refreshConnectors() {
      var request = ++connectorGeneration;
      var status = section(connectorsHost, '当前管理账号的连接器', '连接器归属于当前登录账号及其工作区，不随上方组织选择切换。仅保存配置与启停；此面板不发送消息、验证回调或触发任务。');
      try {
        var data = await api('GET', '/api/connectors');
        if (request !== connectorGeneration) return;
        connectorsHost.append(element('p', '归属：' + principal.tenant.tenantId + ' / ' + principal.tenant.workspaceId + ' / ' + principal.tenant.userId, 'enterprise-help'));
        var list = element('div', undefined, 'enterprise-list'), form = element('form', undefined, 'enterprise-form'); connectorsHost.append(list, element('h4', '新增连接器绑定'), form);
        var name = field(form, 'name', '连接器名称', {required:true,max:120});
        var kind = field(form, 'kind', '连接器类型', {choices:[['signed-webhook','签名 Webhook'],['feishu','飞书应用机器人'],['wecom','企业微信应用回调']]});
        var externalUser = field(form, 'externalUserId', '绑定的外部账号', {required:true,max:256});
        var kindHint = element('p', '', 'enterprise-help'), credentials = element('div', undefined, 'enterprise-credentials'), signature = element('details'), sigText = element('p'); signature.append(element('summary', '入站验签参数说明'), sigText); form.append(kindHint, credentials, signature);
        var enabled = field(form, 'enabled', '保存后启用接收', {type:'checkbox',help:'未填写完整凭据时，即使启用也不会接收事件；建议完成配置后再启用。'});
        var credentialFields = {};
        function credentialForm() {
          credentials.replaceChildren(); credentialFields = {};
          if (kind.value === 'signed-webhook') {
            kindHint.textContent = '填写发送端的 senderId。仅匹配此账号的签名事件可创建任务。';
            credentialFields.secret = field(credentials, 'secret', 'HMAC 签名密钥', {type:'password',max:512,help:'至少 32 字符。留空可先保存为未配置状态。'}); credentialFields.secret.minLength = 32;
            sigText.textContent = 'POST JSON 字段：eventId、senderId、text；请求头 X-Tao-Timestamp 为 10 位秒级时间，X-Tao-Signature 为 HMAC-SHA256(secret, timestamp + "." + 原始请求体) 的十六进制结果。时间偏差不超过 5 分钟。';
          } else if (kind.value === 'feishu') {
            kindHint.textContent = '填写飞书发送者 open_id。仅接收文本消息 im.message.receive_v1。';
            credentialFields.verificationToken = field(credentials, 'verificationToken', 'Verification Token', {type:'password',max:512});
            credentialFields.encryptKey = field(credentials, 'encryptKey', 'Encrypt Key', {type:'password',max:512});
            credentialFields.appId = field(credentials, 'appId', 'App ID（原生私聊回发，可选）', {max:512});
            credentialFields.appSecret = field(credentials, 'appSecret', 'App Secret（可选）', {type:'password',max:512,help:'完整应用凭据允许把后续任务结果发给绑定的 open_id；保存本身不会发消息。'});
            sigText.textContent = '使用飞书事件订阅的请求时间戳、nonce 与签名；服务端验证 SHA256(timestamp + nonce + Encrypt Key + 原始请求体)、Verification Token，并解密加密事件。支持 URL 验证回调。';
          } else {
            kindHint.textContent = '填写企业微信成员 UserID。仅接收文本回调并校验所属 CorpID。';
            credentialFields.token = field(credentials, 'token', '回调 Token', {type:'password',max:512});
            credentialFields.encodingAESKey = field(credentials, 'encodingAESKey', 'EncodingAESKey', {type:'password',max:43,help:'43 位 Base64 字符，不含末尾等号。'}); credentialFields.encodingAESKey.pattern = '[A-Za-z0-9+/]{43}';
            credentialFields.corpId = field(credentials, 'corpId', 'CorpID', {max:512});
            credentialFields.agentId = field(credentials, 'agentId', 'AgentID（原生私聊回发，可选）', {max:512});
            credentialFields.corpSecret = field(credentials, 'corpSecret', 'CorpSecret（可选）', {type:'password',max:512,help:'完整应用凭据允许把后续任务结果发给绑定的成员 UserID；保存本身不会发消息。'});
            sigText.textContent = '使用企业微信 msg_signature、timestamp、nonce 和 Encrypt / echostr 验签；服务端按 EncodingAESKey 解密并检查 CorpID。GET 用于 URL 验证，POST 用于文本消息。';
          }
        }
        kind.addEventListener('change', credentialForm); credentialForm();
        submit(form, '保存连接器绑定', async function () {
          var values = {}; Object.keys(credentialFields).forEach(function (key) { var v = credentialFields[key].value; if (v !== '') values[key] = v; });
          await api('POST', '/api/connectors', {name:name.value.trim(),kind:kind.value,externalUserId:externalUser.value.trim(),credentials:values,enabled:enabled.checked});
          Object.values(credentialFields).forEach(function (input) { input.value = ''; }); await refreshConnectors(); message(globalStatus, '连接器已保存，未发送外部消息；请在发送端配置返回的回调地址');
        }, status);
        data.connectors.forEach(function (connector) {
          var row = element('article', undefined, 'enterprise-row'), actions = element('div', undefined, 'enterprise-actions');
          var names = {'signed-webhook':'签名 Webhook',feishu:'飞书',wecom:'企业微信'};
          row.append(element('h4', connector.name), element('p', names[connector.kind] + ' · ' + (connector.enabled ? '接收已启用' : '接收已关闭') + ' · ' + (connector.status === 'configured' ? '凭据已配置' : '凭据不完整')), element('p', '外部账号：' + connector.externalUserId));
          var callback = element('input'); callback.readOnly = true; callback.value = new URL(connector.callbackPath, location.origin).href; callback.setAttribute('aria-label', connector.name + ' 的回调地址'); row.append(callback);
          row.append(element('p', '配置状态不代表发送端已接通。此接口不支持原地修改凭据；可新建替代绑定，更新发送端回调地址后停用旧绑定。', 'enterprise-help'));
          row.append(element('p', '原生结果回发：' + (connector.nativeDeliveryStatus === 'configured' ? '凭据已配置，尚未验证投递' : connector.kind === 'signed-webhook' ? '使用显式投递配置' : '需要补充应用凭据'), 'enterprise-help'));
          if (connector.delivery) row.append(element('p', '已有结果投递配置：' + connector.delivery.url));
          actions.append(button(connector.enabled ? '关闭接收' : '启用接收', async function () {
            await api('PATCH', '/api/connectors/' + encodeURIComponent(connector.id), {enabled:!connector.enabled}); await refreshConnectors(); message(globalStatus, '连接器接收状态已更新');
          }, status), button('新建替代绑定', function () {
            name.value = connector.name + '（替代）'; kind.value = connector.kind; externalUser.value = connector.externalUserId; enabled.checked = false; credentialForm(); name.focus(); message(status, '请重新填写完整凭据。保存后会生成新的回调地址，旧绑定保持原状态。');
          }, status), button('删除绑定', async function () {
            if (!await confirmChange('删除连接器绑定？', '旧回调地址将失效，已创建的任务与记录保留。')) return;
            await api('DELETE', '/api/connectors/' + encodeURIComponent(connector.id)); await refreshConnectors(); message(globalStatus, '连接器绑定已删除');
          }, status, true)); row.append(actions); list.append(row);
        });
        if (!data.connectors.length) list.append(element('p', '暂无连接器。可以先保存不完整配置，实际接通需完成外部平台登记。'));
      } catch (error) { if (request === connectorGeneration) message(status, error.message, true); }
    }
    async function initialize() {
      message(globalStatus, '正在读取管理身份与组织配置…');
      try {
        principal = await api('GET', '/api/auth/me');
        if (!['TENANT_ADMIN','PLATFORM_ADMIN'].includes(principal.role)) throw new Error('需要组织管理员或平台管理员权限');
        var data = await api('GET', '/api/control/accounts'); accounts = data.accounts || []; targetTenant = principal.tenant.tenantId; generation++;
        scope.replaceChildren();
        if (principal.role === 'PLATFORM_ADMIN') {
          var scopeForm = element('form', undefined, 'enterprise-scope-form'); var tenant = field(scopeForm, 'tenantId', '目标组织标识', {required:true,max:128,value:targetTenant});
          tenant.pattern = '[A-Za-z0-9_.-]{1,128}';
          submit(scopeForm, '读取组织', async function () { targetTenant = tenant.value.trim(); generation++; await Promise.all([refreshOrganization(),refreshOidc()]); message(globalStatus, '已读取目标组织'); }, globalStatus); scope.append(scopeForm);
        } else scope.append(element('p', '当前组织：' + targetTenant));
        scope.append(button('刷新组织与连接器', async function () {
          var data = await api('GET', '/api/control/accounts'); accounts = data.accounts || []; generation++; await Promise.all([refreshOrganization(),refreshOidc(),refreshConnectors()]);
        }, globalStatus));
        await Promise.all([refreshOrganization(),refreshOidc(),refreshConnectors()]); message(globalStatus, '已读取配置；各区域展示各自的保存或访问状态');
      } catch (error) { message(globalStatus, error.message, true); scope.replaceChildren(button('重新加载', initialize, globalStatus)); }
    }
    await initialize();
  }
  global.TaoEnterprise = { mount: mount };
  function start() { var host = document.getElementById('enterpriseSettings'); if (host) mount(host); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start();
})(window);
