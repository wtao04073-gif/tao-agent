(function () {
  'use strict';
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => value ? new Date(value).toLocaleString() : '无后续计划';
  const labels = {pending:'等待执行',submitting:'提交中',submitted:'已提交',completed:'完成',failed:'失败',uncertain:'待核对',cancelled:'已取消',sending:'投递中',delivered:'已投递',configured:'已配置',unconfigured:'未配置'};
  window.TaoAutomation = { async mount(host, options) {
    let active = true;
    const api = options.api;
    const request = (path, method, body) => api(path,{method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
    const notice = message => { const box = host.querySelector('[data-notice]'); if (box) { box.textContent = message; box.hidden = false; } };
    async function refresh() {
      try {
        const [plans, history, outbox] = await Promise.all([api('/api/automations'),api('/api/automations/history'),api('/api/automations/deliveries')]);
        if (!active || !host.isConnected) return;
        host.innerHTML = `<section class="automation-panel"><p>关闭页面后仍按服务端计划运行。高风险操作继续等待人工确认。当前支持单实例持久运行。</p><p role="status" data-notice hidden></p>
        ${plans.health && plans.health.lastError ? '<p role="alert">'+escape(plans.health.lastError)+'</p>' : ''}
        <details><summary>新建定时任务</summary><form data-plan><p><label>名称 <input name="name" required maxlength="120"></label></p><p><label>任务内容 <textarea name="query" required maxlength="16000"></textarea></label></p><p><label>计划类型 <select name="kind"><option value="interval">固定间隔</option><option value="cron">Cron</option><option value="once">一次性</option></select></label></p><p><label>间隔秒数 <input name="everySeconds" type="number" value="3600" min="60"></label></p><p><label>5段 Cron <input name="expression" value="0 9 * * 1-5"></label> <label>时区 <input name="timezone" value="Asia/Shanghai"></label></p><p><label>一次性时间 <input name="at" type="datetime-local"></label>（按当前设备时区输入）</p><details><summary>结果回调（可选）</summary><p><label>HTTPS地址 <input name="url" type="url"></label></p><p><label>签名密钥 <input name="secret" type="password" autocomplete="new-password" minlength="32"></label></p></details><button type="submit">创建计划</button></form></details>
        <h3>我的计划</h3>${plans.automations.length ? plans.automations.map(p=>`<article><strong>${escape(p.name)}</strong> · ${p.enabled?'已启用':'已暂停'}<p>${escape(p.schedule.kind==='cron'?p.schedule.expression+' · '+p.schedule.timezone:p.schedule.kind==='interval'?'每 '+p.schedule.everySeconds+' 秒':'一次性')} · 下次：${escape(date(p.nextRunAt))}</p><button data-run="${escape(p.id)}">立即运行</button> <button data-enable="${escape(p.id)}" data-value="${!p.enabled}">${p.enabled?'暂停':'启用'}</button> <button data-delete="${escape(p.id)}">删除计划</button></article>`).join(''):'<p>暂无计划。</p>'}
        <h3>运行历史</h3>${history.occurrences.length?history.occurrences.map(o=>`<article>${escape(date(o.createdAt))} · ${escape(labels[o.state]||o.state)} ${o.taskStatus?' · '+escape(o.taskStatus):''}${o.error?'<p>'+escape(o.error)+'</p>':''} ${o.taskId?'<button data-task="'+escape(o.taskId)+'">查看任务</button>':''} ${['pending','submitting','submitted'].includes(o.state)?'<button data-cancel="'+escape(o.id)+'">取消运行</button>':''}</article>`).join(''):'<p>暂无运行记录。</p>'}
        <h3>结果投递</h3>${outbox.deliveries.length?outbox.deliveries.map(d=>`<article>${escape(d.url)} · ${escape(labels[d.state]||d.state)} · ${d.attempts}次${d.error?'<p>'+escape(d.error)+'</p>':''}${['failed','cancelled'].includes(d.state)?'<button data-retry-delivery="'+escape(d.id)+'">重新投递</button>':''}${['pending','sending'].includes(d.state)?'<button data-cancel-delivery="'+escape(d.id)+'">取消投递</button>':''}</article>`).join(''):'<p>暂无投递。</p>'}
        <p class="ws-meta">办公连接器由管理员在管控平台的“组织与连接器”中统一配置。</p><button data-refresh>刷新状态</button></section>`;
        var planForm=host.querySelector('[data-plan]');function scheduleFields(){var kind=planForm.elements.kind.value;['everySeconds','expression','at'].forEach(function(name,index){planForm.elements[name].closest('p').hidden=kind!==['interval','cron','once'][index];});}planForm.elements.kind.addEventListener('change',scheduleFields);scheduleFields();
        host.querySelector('[data-plan]').onsubmit = async event => {
          event.preventDefault(); const form = event.target; const values = Object.fromEntries(new FormData(form));
          try { const schedule = values.kind === 'cron' ? {kind:'cron',expression:values.expression,timezone:values.timezone} : values.kind === 'once' ? {kind:'once',at:new Date(values.at).toISOString()} : {kind:'interval',everySeconds:Number(values.everySeconds)};
            await request('/api/automations','POST',{name:values.name,input:{scenarioId:'general.free-task',fields:{query:values.query}},schedule,...(values.url?{delivery:{url:values.url,secret:values.secret}}:{})}); await refresh(); notice('计划已创建');
          } catch(error) { notice(error.message || '创建失败'); }
        };
      } catch(error) { if (active) host.textContent = error.message || '无法读取自动化状态'; }
    }
    host.onclick = async event => {
      const button = event.target.closest('button'); if (!button || button.type === 'submit' && button.closest('form')) return;
      try {
        if (button.dataset.task) { options.openTask?.(button.dataset.task); return; }
        button.disabled = true;
        if (button.dataset.run) await request('/api/automations/'+button.dataset.run+'/run','POST',{});
        else if (button.dataset.enable) await request('/api/automations/'+button.dataset.enable,'PATCH',{enabled:button.dataset.value==='true'});
        else if (button.dataset.delete) { if (!await App.Dialog.confirm({title:'删除计划？',description:'已有执行记录会保留。',danger:true})) return; await request('/api/automations/'+button.dataset.delete,'DELETE'); }
        else if (button.dataset.cancel) await request('/api/automations/occurrences/'+button.dataset.cancel+'/cancel','POST',{});
        else if (button.dataset.retryDelivery) await request('/api/automations/deliveries/'+button.dataset.retryDelivery+'/retry','POST',{});
        else if (button.dataset.cancelDelivery) await request('/api/automations/deliveries/'+button.dataset.cancelDelivery+'/cancel','POST',{});
        else if (!button.hasAttribute('data-refresh')) return;
        await refresh();
      } catch(error) { notice(error.message || '操作失败'); } finally { button.disabled = false; }
    };
    await refresh();
    return () => { active = false; host.onclick = null; };
  }};
})();
