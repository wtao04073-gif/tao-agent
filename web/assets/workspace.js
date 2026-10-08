/* Front-office views share the chat shell and its active conversation. */
(function (global) {
  "use strict";
  var hooks, page, content, route = "chat", revision = 0, initialized = false;
  var knowledgeJobs = [], knowledgeJobKey = '', knowledgeNotify = function () {}, routeCleanup = function () {};
  function knowledgeChanged(refreshDocuments) {
    if (knowledgeJobKey) {
      try { sessionStorage.setItem(knowledgeJobKey, JSON.stringify(knowledgeJobs.filter(function (e) {
        return e.job.status !== 'ready';
      }).map(function (e) { return { name: e.name, jobId: e.job.jobId, status:e.job.status, error:e.job.error }; }))); } catch (e) { /* 存储不可用时继续使用内存。 */ }
    }
    knowledgeNotify(refreshDocuments);
  }
  var titles = { tasks: "任务中心", scenarios: "场景", knowledge: "知识库" };
  var statusNames = { QUEUED: "排队中", RUNNING: "执行中", AWAIT_CONFIRM: "等待确认", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消", EXCEEDED: "已达执行限额", INTERRUPTED: "已中断", active: "进行中", done: "已完成", archived: "已归档" };
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function button(text, action, cls) {
    var n = node("button", cls || "ws-button", text); n.type = "button";
    n.addEventListener("click", action); return n;
  }
  function input(label, placeholder) {
    var n = node("input", "ws-search"); n.type = "search"; n.placeholder = placeholder || label;
    n.setAttribute("aria-label", label); return n;
  }
  function message(host, text, error) {
    host.replaceChildren(node("p", "ws-state" + (error ? " ws-error" : ""), text));
    host.setAttribute("role", error ? "alert" : "status");
  }
  function notice(host, text) { host.textContent = text; }
  function valid(version) { return version === revision && route !== "chat"; }
  async function api(method, path, body) {
    var result = await App.api(method, path, body);
    if (!result.ok) throw new Error(result.data && result.data.error || "请求失败，请稍后重试");
    return result.data || {};
  }
  function date(value) { var d = new Date(value); return value && !isNaN(d.getTime()) ? d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; }
  function badge(status) { return node("span", "ws-badge ws-status-" + String(status || "").toLowerCase().replace(/[^a-z_]/g, ""), statusNames[status] || status || "待开始"); }
  function go(next) {
    if (location.hash === "#" + next) renderRoute();
    else location.hash = next;
  }
  function restoreChat() {
    page.hidden = true;
    document.body.classList.remove("workspace-active");
    if (hooks.showChat) hooks.showChat();
  }
  function openChat(action) {
    routeCleanup(); routeCleanup = function () {};
    // Render synchronously so shell callbacks can reveal a session immediately.
    if (location.hash !== "#chat") location.hash = "chat";
    route = "chat"; revision++; restoreChat();
    if (action) action();
  }
  function heading(title, description, action) {
    var head = node("header", "ws-heading"), text = node("div");
    text.append(node("p", "ws-eyebrow", "工作空间"), node("h1", "", title), node("p", "ws-description", description));
    head.append(text); if (action) head.append(action); content.append(head);
  }
  function renderRoute() {
    routeCleanup(); routeCleanup = function () {};
    var next = location.hash.replace(/^#\/?/, "").split("?")[0];
    route = titles[next] ? next : "chat";
    revision++;
    document.querySelectorAll("#navTasks, #navWorkbench, #navKnowledge").forEach(function (n) {
      var selected = n.dataset.workspaceRoute === route;
      n.classList.toggle("active", selected);
      if (selected) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current");
    });
    if (route === "chat") { restoreChat(); return; }
    var chatNav=document.getElementById("navChat");if(chatNav)chatNav.classList.remove("active");
    page.hidden = false; document.body.classList.add("workspace-active");
    ["landing", "session"].forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.add("hidden"); });
    content.replaceChildren(); page.scrollTop = 0;
    var current = revision;
    if (route === "tasks") tasks(current);
    if (route === "scenarios") scenarios(current);
    if (route === "knowledge") knowledge(current);
  }
  function filters(host, options, onChange) {
    var group = node("div", "ws-filters"); group.setAttribute("aria-label", "筛选");
    options.forEach(function (option, index) {
      var b = button(option[1], function () {
        group.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        onChange(option[0]);
      }, "ws-filter");
      b.setAttribute("aria-pressed", String(index === 0)); group.append(b);
    }); host.append(group); return group;
  }
  async function tasks(version) {
    heading("让每一项工作，持续向前", "在这里查看执行进展，回到对话继续协作。", button("＋ 新建长期任务", function () { if (hooks.newJob) hooks.newJob(); }, "ws-button ws-primary"));
    var toolbar = node("div", "ws-toolbar"), search = input("搜索任务", "搜索任务名称或目标…");
    toolbar.append(search, button("刷新", function () { renderRoute(); })); content.append(toolbar);
    var kind = "all", state = "all", all = [], jobs = [], scenarioNames = {},taskCursor=null,jobCursor=null,searchVersion=0;
    filters(content, [["all", "全部"], ["tasks", "对话任务"], ["jobs", "长期任务"]], function (value) { kind = value; draw(); });
    var select = node("select", "ws-select"); select.setAttribute("aria-label", "按任务状态筛选");
    [["all", "全部状态"], ["running", "进行中"], ["waiting", "等待确认"], ["done", "已完成"], ["failed", "失败 / 中断"], ["cancelled", "已取消 / 归档"]].forEach(function (pair) { var o = node("option", "", pair[1]); o.value = pair[0]; select.append(o); });
    toolbar.append(select); select.addEventListener("change", function () { state = select.value; draw(); });
    var list = node("div", "ws-list"), error = node("p", "ws-inline-error"); error.setAttribute("role", "alert"); content.append(error, list); message(list, "正在加载任务…");
    var searchTimer;search.addEventListener("input",function(){clearTimeout(searchTimer);searchTimer=setTimeout(function(){reload(false);},200);});
    function matches(s) {
      if (state === "all") return true;
      var groups = { running: ["QUEUED", "RUNNING", "active"], waiting: ["AWAIT_CONFIRM", "EXCEEDED"], done: ["SUCCEEDED", "done"], failed: ["FAILED", "INTERRUPTED"], cancelled: ["CANCELLED", "archived"] };
      return (groups[state] || []).indexOf(s) >= 0;
    }
    function draw() {
      if (!valid(version)) return;
      list.replaceChildren();
      var q = search.value.trim().toLowerCase();
      var entries = all.map(function (t) { return { value: t, job: false }; }).concat(jobs.map(function (j) { return { value: j, job: true }; }));
      entries = entries.filter(function (entry) {
        var t = entry.value;
        return (kind === "all" || (kind === "jobs") === entry.job) && matches(t.status) && (!q || [t.title, t.goal, t.taskId, t.scenarioTitle, scenarioNames[t.scenarioId]].join(" ").toLowerCase().indexOf(q) >= 0);
      }).sort(function (a, b) { return new Date(b.value.updatedAt || b.value.createdAt || 0) - new Date(a.value.updatedAt || a.value.createdAt || 0); });
      if (!entries.length) { message(list, "还没有匹配的任务。发起一次对话，或从场景开始。" ); return; }
      entries.forEach(function (entry) {
        var t = entry.value, row = node("article", "ws-task-row"), info = node("div", "ws-row-main");
        var title = t.title || t.scenarioTitle || scenarioNames[t.scenarioId] || (entry.job ? "长期任务" : "未命名任务");
        var open = function () { openChat(function () { if (entry.job) hooks.openJob(t.jobId); else hooks.openTask(t.taskId); }); };
        info.append(button(title, open, "ws-title-button"), node("p", "ws-meta", (entry.job ? "长期任务" : "对话任务") + " · " + date(t.updatedAt || t.createdAt) + (entry.job ? " · " + (t.conversationIds || []).length + " 次会话" : " · " + (t.artifacts || []).length + " 份产物")));
        if (entry.job && t.goal) info.append(node("p", "ws-row-summary", t.goal));
        if (t.reason) info.append(node("p", "ws-row-summary", t.reason));
        var actions = node("div", "ws-actions"); actions.append(badge(t.status), button("打开", open));
        if (!entry.job && ["QUEUED", "RUNNING", "AWAIT_CONFIRM", "EXCEEDED"].indexOf(t.status) >= 0) {
          var cancel = button("取消", async function () {
            cancel.disabled = true; notice(error, "");
            try { await api("POST", "/api/tasks/" + encodeURIComponent(t.taskId) + "/cancel", { reason: "用户取消" }); if (valid(version)) { t.status = "CANCELLED"; draw(); } }
            catch (e) { if (valid(version)) { notice(error, e.message); cancel.disabled = false; } }
          }, "ws-button ws-danger"); actions.append(cancel);
        }
        actions.append(button('重命名',async function(){var name=await App.Dialog.prompt({title:'重命名',label:'名称',value:title});if(name===null)return;try{await api('PATCH','/api/'+(entry.job?'jobs/':'tasks/')+encodeURIComponent(entry.job?t.jobId:t.taskId),{title:name});t.title=name;draw();}catch(e){notice(error,e.message);}}));
        if(entry.job&&t.status==='active')actions.append(button('停止长期任务',async function(){try{await api('PATCH','/api/jobs/'+encodeURIComponent(t.jobId),{status:'cancelled'});t.status='archived';draw();}catch(e){notice(error,e.message);}}));
        if(!entry.job&&['SUCCEEDED','FAILED','CANCELLED','INTERRUPTED','EXCEEDED'].includes(t.status))actions.append(button('删除',async function(){
          var yes=await App.Dialog.confirm({title:'删除对话？',description:'该对话将从列表移除，审计记录和已有产物保留。',danger:true});if(!yes)return;
          try{await api('DELETE','/api/conversations/'+encodeURIComponent(t.conversationId||t.taskId));all=all.filter(function(item){return (item.conversationId||item.taskId)!==(t.conversationId||t.taskId);});draw();}catch(e){notice(error,e.message);}
        },'ws-button ws-danger'));
        row.append(node("span", "ws-row-icon", entry.job ? "◈" : "◷"), info, actions); list.append(row);
      });
    if(taskCursor||jobCursor)list.append(button('加载更多',function(){reload(true);}));
    }
    async function reload(more){
    var sequence=++searchVersion,q=encodeURIComponent(search.value.trim());
    var results = await Promise.allSettled([more&&!taskCursor?Promise.resolve({tasks:[]}):api("GET", "/api/tasks?limit=50&cursor="+(more?taskCursor:'0')+'&q='+q), more&&!jobCursor?Promise.resolve({jobs:[]}):api("GET", "/api/jobs?limit=50&cursor="+(more?jobCursor:'0')+'&q='+q), api("GET", "/api/scenarios")]);
    if (!valid(version)||sequence!==searchVersion) return;
    if (results[0].status === "fulfilled") {all = (more?all:[]).concat(results[0].value.tasks || []);taskCursor=results[0].value.nextCursor;}
    if (results[1].status === "fulfilled") {jobs = (more?jobs:[]).concat(results[1].value.jobs || []);jobCursor=results[1].value.nextCursor;}
    if (results[2].status === "fulfilled") (results[2].value.scenarios || []).forEach(function (c) { scenarioNames[c.id] = c.title; });
    var errors = results.slice(0, 2).filter(function (r) { return r.status === "rejected"; });
    if (errors.length) notice(error, "部分任务加载失败：" + errors.map(function (r) { return r.reason.message; }).join("；"));
    draw();
    }
    await reload(false);
  }
  async function scenarios(version) {
    heading("从一个好场景开始", "选择适合的工作方式，补充材料，让智能体帮你完成。" );
    var search = input("搜索场景", "搜索场景、用途或关键词…"), controls = node("div", "ws-toolbar"), categories = node("div"), grid = node("div", "ws-scenario-grid");
    controls.append(search); content.append(controls, categories, grid); message(grid, "正在加载场景…");
    var cards = [], category = "all";
    function draw() {
      grid.replaceChildren(); var q = search.value.trim().toLowerCase();
      var visible = cards.filter(function (c) { return (category === "all" || c.industry === category) && (!q || [c.title, c.summary, c.category].join(" ").toLowerCase().indexOf(q) >= 0); });
      if (!visible.length) { message(grid, "暂无匹配场景，试试其他关键词。" ); return; }
      visible.forEach(function (c) {
        var card = button("", function () { scenarioForm(c, version); }, "ws-scenario-card");
        card.append(node("span", "ws-scene-icon", { university: "▥", manufacturing: "▦", general: "✧" }[c.industry] || "✧"), node("h2", "", c.title), node("p", "", c.summary || "填写需求，开始这项工作。"));
        var foot = node("div", "ws-card-foot"); foot.append(node("span", "ws-badge", c.category || "办公场景"), node("span", "ws-card-link", "开始使用 →")); card.append(foot); grid.append(card);
      });
    }
    search.addEventListener("input", draw);
    try {
      var result = await api("GET", "/api/scenarios"); if (!valid(version)) return;
      cards = result.scenarios || [];
      var industries = [["all", "全部场景"]], names = { general: "通用办公", university: "高校服务", manufacturing: "制造业" };
      Array.from(new Set(cards.map(function (c) { return c.industry; }).filter(Boolean))).forEach(function (k) { industries.push([k, names[k] || k]); });
      filters(categories, industries, function (k) { category = k; draw(); }); draw();
    } catch (e) { if (valid(version)) { message(grid, e.message, true); grid.append(button("重新加载", renderRoute)); } }
  }
  function scenarioForm(card, version) {
    content.replaceChildren();
    content.append(button("← 返回场景", renderRoute, "ws-back"));
    heading(card.title, card.summary || "补充以下信息，即可开始任务。");
    var form = node("form", "ws-form"), error = node("p", "ws-inline-error"), actions = node("div", "ws-form-actions");
    error.setAttribute("role", "alert");
    var pending = 0, submitting = false, submit = node("button", "ws-button ws-primary", "开始任务"); submit.type = "submit";
    var fields = Array.isArray(card.fields) ? card.fields : []; form._fields = fields;
    var Forms = App.Forms || global.ScenarioForms;
    fields.forEach(function (f, index) {
      var wrap = node("div", "ws-field"), id = "fld-" + f.name, label = node("label", "", f.label + (f.required ? " *" : "")); label.htmlFor = id;
      var control;
      if (f.type === "file" || f.type === "filelist") {
        var box = node("div", "ws-upload-field"), picker = node("input"), rows = node("div", "ws-upload-list"), sequence = 0;
        box.dataset.name = f.name; box.dataset.type = f.type; box._paths = [];
        picker.type = "file"; picker.id = id; picker.multiple = f.type === "filelist";
        if (f.accept) picker.accept = Array.isArray(f.accept) ? f.accept.join(",") : f.accept;
        picker.addEventListener("change", async function () {
          var files = Array.from(picker.files || []); if (!files.length) return;
          var current = ++sequence, multi = f.type === "filelist";
          if (!multi) { box._paths.length = 0; rows.replaceChildren(); }
          pending++; submit.disabled = true;
          try {
            for (var file of files) {
              var row = node("p", "ws-upload-item", file.name + " · 上传中…"); rows.append(row);
              try {
                var r = await App.upload("/api/files", file, "file");
                if (!multi && current !== sequence) { row.remove(); continue; }
                if (!r.ok || !r.data.path) throw new Error(r.data && r.data.error || "上传失败");
                box._paths.push(r.data.path); row.textContent = file.name + " · 已就绪";
              } catch (e) { row.textContent = file.name + " · " + e.message; row.classList.add("ws-error"); }
            }
          } finally { pending--; submit.disabled = pending > 0; if (multi || current === sequence) picker.value = ""; }
        });
        box.append(picker, rows); control = box;
      } else if (f.type === "multiselect") {
        control = node("div", "ws-checkboxes"); control.id = id; control.setAttribute("role", "group"); control.setAttribute("aria-label", f.label); control.dataset.name = f.name; control.dataset.type = f.type;
        (f.options || []).forEach(function (o) { var l = node("label"), cb = node("input"); cb.type = "checkbox"; cb.value = o.value; l.append(cb, node("span", "", o.label)); control.append(l); });
      } else {
        control = node(f.type === "textarea" ? "textarea" : f.type === "select" ? "select" : "input");
        if (control.tagName === "INPUT") control.type = f.type === "boolean" ? "checkbox" : ["number", "date"].indexOf(f.type) >= 0 ? f.type : "text";
        if (f.type === "select") { var empty = node("option", "", "请选择…"); empty.value = ""; control.append(empty); (f.options || []).forEach(function (o) { var opt = node("option", "", o.label); opt.value = o.value; control.append(opt); }); }
        control.id = id; control.dataset.name = f.name; control.dataset.type = f.type || "text";
        if (f.type === "textarea") control.rows = 4;
        if (f.min !== undefined) control.min = f.min;
        if (f.max !== undefined) control.max = f.max;
        if (f.required && f.type !== "boolean") control.required = true;
      }
      if(f.defaultValue!==undefined){if(f.type==='boolean')control.checked=!!f.defaultValue;else if(f.type==='multiselect')control.querySelectorAll('input').forEach(function(cb){cb.checked=Array.isArray(f.defaultValue)&&f.defaultValue.includes(cb.value);});else if(f.type!=='file'&&f.type!=='filelist')control.value=String(f.defaultValue);}
      if (f.hint) { var hint = node("p", "ws-field-hint", f.hint); hint.id = "ws-hint-" + index; control.setAttribute("aria-describedby", hint.id); wrap.append(label, control, hint); }
      else wrap.append(label, control);
      form.append(wrap);
    });
    if (!fields.length) form.append(node("p", "ws-description", "这个场景已经准备就绪，点击下方按钮开始。"));
    actions.append(submit, button("返回场景", renderRoute)); form.append(error, actions); content.append(form);
    form.addEventListener("submit", async function (event) {
      event.preventDefault(); if (submitting) return; if (pending) { notice(error, "请等待附件上传完成。" ); return; }
      if (!Forms) { notice(error, "表单组件加载失败，请刷新页面重试。" ); return; }
      var got = Forms.collect(form); if (!got.ok) { notice(error, got.errors.join("；")); return; }
      var payload = { scenarioId: card.id, fields: got.values }; submitting = true; submit.disabled = true; submit.textContent = "正在创建任务…"; notice(error, "");
      try {
        var result = await api("POST", "/api/tasks", payload);
        if (!valid(version)) return;
        if (!result.taskId) throw new Error("任务已提交，但未返回任务编号，请到任务中心查看。" );
        if (hooks.submitScenario) hooks.submitScenario(payload, result);
        openChat(function () { hooks.openTask(result.taskId); });
      } catch (e) { if (valid(version)) notice(error, e.message); }
      finally { submitting = false; submit.disabled = false; submit.textContent = "开始任务"; }
    });
    var first = form.querySelector("input, textarea, select"); if (first) first.focus();
  }
  async function knowledge(version) {
    // 仅保存解析任务编号，按服务端确认的用户和工作区隔离；重载后重新查询真实状态。
    if (!knowledgeJobKey) {
      try {
        var me = await api('GET', '/api/me');
        if (!valid(version) || route !== 'knowledge') return;
        if (me.tenantId && me.workspaceId && me.userId) {
          knowledgeJobKey = 'tao.knowledge.jobs:' + JSON.stringify([me.tenantId, me.workspaceId, me.userId]);
          var saved = JSON.parse(sessionStorage.getItem(knowledgeJobKey) || '[]');
          if (Array.isArray(saved)) saved.forEach(function (e) {
            if (e && typeof e.name === 'string' && !knowledgeJobs.some(function (x) { return e.jobId ? x.job.jobId === e.jobId : !x.job.jobId && x.name === e.name; }))
              knowledgeJobs.push({ name: e.name, job: { jobId: e.jobId, status: !e.jobId ? 'upload_failed' : e.status==='failed'?'failed':'queued',error:e.error||(!e.jobId?'上传未完成，请重新选择文件':undefined) } });
          });
        }
      } catch (e) { /* 不因浏览器存储不可用阻断知识库。 */ }
    }
    if (!valid(version) || route !== 'knowledge') return;
    var picker = node('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
    picker.accept = '.txt,.md,.csv,.tsv,.docx,.xls,.xlsx';
    var upload = button('＋ 上传资料', function () { picker.click(); }, 'ws-button ws-primary');
    heading('让你的知识，成为协作的底气', '上传资料，自动解析切片，检索内容并引用到对话。', upload);
    var retrievalHint = node('p', 'ws-knowledge-hint', '支持 TXT、Markdown、CSV/TSV、DOCX、XLS/XLSX。扫描件和图片暂不支持文字识别。');
    content.append(retrievalHint);
    api('GET', '/api/capabilities').then(function (data) {
      if (!valid(version) || route !== 'knowledge') return;
      var k = data.knowledge || {}, modes = { keyword: '关键词检索', semantic: '语义检索', hybrid: '语义与关键词混合检索' };
      if (modes[k.retrieval]) retrievalHint.textContent += ' 当前使用' + modes[k.retrieval] + '。';
      if (k.rag && k.rag.pendingDocuments > 0) retrievalHint.textContent += ' 部分资料的向量索引待更新。';
    }).catch(function () { /* 能力提示不可用时仍允许检索。 */ });
    var uploadsPanel=node('details','ws-uploaded-files'),uploadsTitle=node('summary','','管理上传原文件'),uploadsList=node('div','ws-list'),uploadsCursor=null,uploadsRequest=0;
    uploadsPanel.append(uploadsTitle,uploadsList);content.append(uploadsPanel);
    async function loadUploads(more){
      var seq=++uploadsRequest;
      try{var data=await api('GET','/api/files?limit=20&cursor='+(more&&uploadsCursor?uploadsCursor:'0'));if(!valid(version)||seq!==uploadsRequest)return;
        if(!more)uploadsList.replaceChildren();var previous=uploadsList.querySelector('.uploads-more');if(previous)previous.remove();
        (data.files||[]).forEach(function(file){var row=node('div','ws-document-row'),name=node('span','ws-row-main',file.name+' · '+App.fmtBytes(file.sizeBytes));
          row.append(name,button('删除原文件',async function(){var yes=await App.Dialog.confirm({title:'删除原文件？',description:'将删除「'+file.name+'」。已有知识索引和任务产物保留；共享原文件需管理员操作。',danger:true});if(!yes)return;try{await api('DELETE','/api/files/'+encodeURIComponent(file.name));row.remove();}catch(e){App.Toast.show('删除失败',e.message,'err');}},'ws-button ws-danger'));uploadsList.append(row);});
        uploadsCursor=data.nextCursor;if(uploadsCursor){var moreButton=button('加载更多原文件',function(){loadUploads(true);});moreButton.classList.add('uploads-more');uploadsList.append(moreButton);}
      }catch(e){if(valid(version))message(uploadsList,e.message,true);}
    }
    uploadsPanel.addEventListener('toggle',function(){if(uploadsPanel.open)loadUploads(false);});
    var search = input('检索知识切片', '输入问题或关键词，查找相关片段…');
    var toolbar = node('form', 'ws-toolbar'), searchButton = node('button', 'ws-button', '检索切片'); searchButton.type = 'submit';
    toolbar.append(search, searchButton, button('全部资料', function () { search.value = ''; load(); }));
    var progress = node('p', 'ws-upload-progress'), error = node('p', 'ws-inline-error');
    var jobsList = node('section', 'ws-jobs'), resultTitle = node('h2', 'ws-section-title', '我的资料'), list = node('div', 'ws-list');
    var detail = node('section', 'ws-chunk-detail'); detail.hidden = true; detail.setAttribute('aria-label', '文档切片');
    progress.setAttribute('role', 'status'); error.setAttribute('role', 'alert'); jobsList.setAttribute('aria-label', '解析任务');
    content.append(picker, toolbar, progress, error, jobsList, resultTitle, list, detail);
    var documents = [],documentCursor=null, request = 0, loadRequest = 0, detailRequest = 0, timer, pollTimer, polling = false, uploading = false;
    var jobs = knowledgeJobs;
    routeCleanup = function () { clearTimeout(timer); clearTimeout(pollTimer); knowledgeNotify = function () {}; };
    function current() { return valid(version) && route === 'knowledge'; }
    function actionsFor(doc) {
      var actions = node('div', 'ws-actions');
      if (doc.documentId) actions.append(button('查看切片', function () { showChunks(doc); }));
      if (doc.fileName) actions.append(button('预览原文', function () { if (hooks.openPreview) hooks.openPreview({ kind: 'file', name: doc.fileName }); }));
      var cite = button('引用到对话', async function () {
        cite.disabled = true;
        try {
          var file = await api('POST', '/api/workspace/files/reference', { name: doc.fileName });
          if (!current()) return;
          var attached = hooks.attachFile(file); if (attached !== false) openChat();
        } catch (e) { if (current()) notice(error, e.message); }
        finally { cite.disabled = !doc.fileName || !hooks.attachFile; }
      });
      cite.disabled = !doc.fileName || !hooks.attachFile; actions.append(cite); return actions;
    }
    function chunkCard(chunk, index) {
      var card = node('article', 'ws-search-hit');
      card.append(node('h3', '', '切片 ' + (index + 1)), node('p', 'ws-meta', '起始段落 ' + chunk.position + ' · ' + (chunk.text || '').length + ' 字符' + (chunk.documentVersion ? ' · 版本 ' + chunk.documentVersion : '')));
      card.append(node('p', 'ws-hit-text', chunk.text || '')); return card;
    }
    async function showChunks(doc) {
      var seq = ++detailRequest, selectedVersion = doc.version || 1;
      detail.hidden = false; detail.replaceChildren();
      var title = node('h2', 'ws-section-title', doc.name + ' · 文档切片'); title.tabIndex = -1;
      var controls = node('div', 'ws-toolbar'), select = node('select', 'ws-select'); select.setAttribute('aria-label', '文档版本');
      for (var v = selectedVersion; v >= 1; v--) { var o = node('option', '', '版本 ' + v); o.value = String(v); select.append(o); }
      var query = input('筛选当前文档切片', '在当前版本切片中查找…');
      controls.append(select, query, button('关闭切片', function () { detailRequest++; detail.hidden = true; }));
      var meta = node('p', 'ws-description'), body = node('div', 'ws-list'), pagination = node('div', 'ws-pagination');
      detail.append(title, controls, meta, body, pagination); title.focus(); detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
      var chunks = [], pageIndex = 0, versionRequest = 0;
      function draw() {
        var q = query.value.trim().toLowerCase();
        var filtered = chunks.map(function (c, i) { return { chunk: c, index: i }; }).filter(function (item) { return !q || item.chunk.text.toLowerCase().includes(q); });
        var pages = Math.max(1, Math.ceil(filtered.length / 12)); pageIndex = Math.min(pageIndex, pages - 1);
        body.replaceChildren(); pagination.replaceChildren();
        meta.textContent = '共 ' + chunks.length + ' 个切片' + (q ? ' · 匹配 ' + filtered.length + ' 个' : '') + ' · 可供智能体检索引用';
        filtered.slice(pageIndex * 12, (pageIndex + 1) * 12).forEach(function (item) { body.append(chunkCard(item.chunk, item.index)); });
        if (!filtered.length) message(body, '当前条件下没有切片。');
        if (pages > 1) {
          var prev = button('上一页', function () { pageIndex--; draw(); }), next = button('下一页', function () { pageIndex++; draw(); });
          prev.disabled = pageIndex === 0; next.disabled = pageIndex + 1 === pages;
          pagination.append(prev, node('span', 'ws-meta', (pageIndex + 1) + ' / ' + pages), next);
        }
      }
      async function readVersion() {
        var req = ++versionRequest; message(body, '正在读取真实切片…'); pagination.replaceChildren(); meta.textContent = ''; query.disabled = true;
        try {
          var result = await api('GET', '/api/knowledge/' + encodeURIComponent(doc.documentId) + '/versions/' + encodeURIComponent(select.value));
          if (!current() || seq !== detailRequest || req !== versionRequest) return;
          chunks = result.chunks || []; pageIndex = 0; query.disabled = false; draw();
        } catch (e) { if (current() && seq === detailRequest && req === versionRequest) { message(body, e.message, true); body.append(button('重新读取', readVersion)); } }
      }
      query.addEventListener('input', function () { pageIndex = 0; draw(); }); select.addEventListener('change', readVersion); await readVersion();
    }
    function drawDocs() {
      if (!current()) return;
      list.replaceChildren(); resultTitle.textContent = '我的资料 · ' + documents.length;
      if (!documents.length) { message(list, '还没有已解析的资料。上传文件后，可在这里查看切片与检索结果。'); return; }
      documents.forEach(function (doc) {
        var row = node('article', 'ws-document-row'), info = node('div', 'ws-row-main');
        info.append(node('h3', '', doc.name), node('p', 'ws-meta', '解析完成 · ' + doc.chunks + ' 个切片 · 版本 ' + (doc.version || 1) + ' · ' + date(doc.updatedAt)));
        var actions = actionsFor(doc), remove = button('移除', async function () {
          var removed = await App.Dialog.confirm({ title: '移除知识资料？', danger: true,
            description: '将从知识库移除「' + doc.name + '」及其检索索引，原始文件会保留。',
            confirmText: '移除资料', cancelText: '保留资料', busyText: '正在移除…',
            onSubmit: async function () { await api('DELETE', '/api/knowledge/' + encodeURIComponent(doc.documentId)); return true; }
          });
          if (removed && current()) { detailRequest++; detail.hidden = true; load(); }
        }, 'ws-button ws-danger');
        if(doc.fileName)actions.append(button('删除原文件',async function(){var yes=await App.Dialog.confirm({title:'删除上传原文件？',description:'知识索引会保留；后续无法重新解析该原文件。',danger:true});if(!yes)return;try{await api('DELETE','/api/files/'+encodeURIComponent(doc.fileName));notice(error,'原文件已删除');}catch(e){notice(error,e.message);}}));
        actions.append(remove); row.append(node('span', 'ws-row-icon', '▤'), info, actions); list.append(row);
      });
    }
    async function load(more) {
      more=more===true;if (!current()) return;
      var seq = ++loadRequest; request++; message(list, '正在加载资料…');
      try {
        var data = await api('GET', '/api/knowledge?limit=50&cursor='+(more&&documentCursor?documentCursor:'0')); if (!current() || seq !== loadRequest) return;
        documents = (more?documents:[]).concat(data.documents || []);documentCursor=data.nextCursor;if (search.value.trim()) find(); else drawDocs();
        if(documentCursor)list.append(button("加载更多资料",function(){load(true);}));
      } catch (e) { if (current() && seq === loadRequest) { message(list, e.message, true); list.append(button('重新加载', load)); } }
    }
    async function find() {
      clearTimeout(timer); var q = search.value.trim(), seq = ++request;
      if (!q) { drawDocs(); return; }
      message(list, '正在检索相关切片…');
      try {
        var data = await api('GET', '/api/knowledge?q=' + encodeURIComponent(q)); if (!current() || seq !== request) return;
        list.replaceChildren(); var hits = data.hits || []; resultTitle.textContent = '切片命中 · ' + hits.length;
        if (!hits.length) { message(list, '没有找到匹配切片，请尝试资料中的关键词。'); return; }
        hits.forEach(function (hit) {
          var c = hit.chunk, doc = (data.documents || documents).find(function (d) { return d.documentId === c.documentId; }) || { name: c.documentName };
          var row = node('article', 'ws-search-hit');
          row.append(node('h3', '', c.documentName), node('p', 'ws-meta', '起始段落 ' + c.position + (c.documentVersion ? ' · 版本 ' + c.documentVersion : '') + (Number.isFinite(hit.score) ? ' · 匹配得分 ' + hit.score.toFixed(2) : '')), node('p', 'ws-hit-text', c.text || ''), actionsFor(doc)); list.append(row);
        });
      } catch (e) { if (current() && seq === request) message(list, e.message, true); }
    }
    function drawJobs() {
      if (!current()) return;
      jobsList.replaceChildren();
      if (!jobs.length) return;
      jobsList.append(node('h2', 'ws-section-title', '上传与解析'));
      jobs.forEach(function (entry) {
        var j = entry.job, row = node('article', 'ws-ingest-row'), info = node('div', 'ws-row-main');
        var names = { uploading: '上传中', queued: '等待解析', processing: '正在解析并生成切片', ready: '解析完成，可检索', failed: '解析失败', upload_failed: '上传或入库提交失败' };
        info.append(node('h3', '', entry.name), node('p', 'ws-meta', names[j.status] || '等待更新'));
        if (j.document) info.append(node('p', 'ws-meta', j.document.chunks + ' 个切片 · 版本 ' + (j.document.version || 1)));
        if (j.error || entry.pollError) info.append(node('p', 'ws-inline-error', j.error || entry.pollError));
        row.append(info);
        if(j.status==='upload_failed')row.append(button('重新选择文件',function(){picker.click();}));
        if (j.status === 'failed' && j.jobId) row.append(button('重试解析', async function (event) {
          event.currentTarget.disabled = true;
          try { var result = await api('POST', '/api/knowledge/jobs/' + encodeURIComponent(j.jobId) + '/retry', {}); entry.job = result.job; entry.pollError = ''; }
          catch (e) { entry.pollError = e.message; }
          knowledgeChanged();
        }));
        if (j.status === 'ready' && j.document) row.append(button('查看切片', function () { showChunks(j.document); }));
        if (entry.pollError && ['queued','processing'].includes(j.status)) row.append(button('刷新状态', function () { entry.pollError = ''; schedulePoll(); }));
        jobsList.append(row);
      });
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (current() && !polling && jobs.some(function (e) { return ['queued','processing'].includes(e.job.status) && !e.pollError; })) pollTimer = setTimeout(pollJobs, 1200);
    }
    async function pollJobs() {
      if (!current() || polling) return;
      polling = true; var changed = false;
      for (var entry of jobs.filter(function (e) { return ['queued','processing'].includes(e.job.status) && !e.pollError; })) {
        if (!current()) break;
        try {
          var data = await api('GET', '/api/knowledge/jobs/' + encodeURIComponent(entry.job.jobId));
          entry.job = data.job; if (data.job.status === 'ready') changed = true;
        } catch (e) { entry.pollError = '状态暂不可用：' + e.message; }
      }
      polling = false;
      knowledgeChanged(changed);
    }
    toolbar.addEventListener('submit', function (e) { e.preventDefault(); find(); });
    search.addEventListener('input', function () { clearTimeout(timer); request++; timer = setTimeout(function () { if (current()) find(); }, 300); });
    picker.addEventListener('change', async function () {
      var files = Array.from(picker.files || []); if (!files.length || uploading) return;
      uploading = true; picker.disabled = upload.disabled = true; notice(error, '');
      for (var file of files) {
        var entry = { name: file.name, job: { status: 'uploading' } }; jobs.push(entry); drawJobs();
        try {
          var uploaded = await App.upload('/api/files', file, 'file');
          if (!uploaded.ok) throw new Error(uploaded.data && uploaded.data.error || '上传失败');
          var name = uploaded.data.name || (uploaded.data.path && uploaded.data.path.replace(/\\/g, '/').split('/').pop()) || file.name;
          var result = await api('POST', '/api/knowledge?async=true', { name: name, fileName: name });
          if (!result.job || !result.job.jobId) throw new Error('未收到解析任务，请刷新资料列表确认状态后再上传。');
          entry.job = result.job;
        } catch (e) { entry.job = { status: 'upload_failed', error: e.message }; }
        knowledgeChanged();
      }
      uploading = false; picker.disabled = upload.disabled = false; picker.value = '';
      if (current()) notice(progress, '上传提交结束，解析状态将在下方持续更新。');
    });
    knowledgeNotify = function (refreshDocuments) { drawJobs(); schedulePoll(); if (refreshDocuments && current()) load(); };
    knowledgeNotify(); await load();
  }
  global.TaoWorkspace = {
    init: function (options) {
      hooks = options || {};
      if (initialized) return;
      initialized = true;
      page = node("main", "workspace-page"); page.id = "workspacePage"; page.hidden = true; page.setAttribute("aria-label", "工作空间");
      content = node("div", "ws-content"); page.append(content); document.body.append(page);
      [["navTasks", "tasks"], ["navWorkbench", "scenarios"], ["navKnowledge", "knowledge"]].forEach(function (pair) {
        var nav = document.getElementById(pair[0]); if (!nav) return;
        nav.dataset.workspaceRoute = pair[1]; nav.addEventListener("click", function (e) { e.preventDefault(); go(pair[1]); });
      });
      global.addEventListener("hashchange", renderRoute); renderRoute();
    },
    navigate: go,
    showChat: function () { openChat(); }
  };
})(window);
