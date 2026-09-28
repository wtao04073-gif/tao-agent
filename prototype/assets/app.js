/* ==========================================================================
   共享交互逻辑 — 原生 JS，零外部依赖，离线可用
   模块：
     Theme   主题切换（浅色 / 深色 / 跟随系统）
     Toast   轻量通知（任务完成主动提示）
     Modal   模态框开关 + 焦点管理
     Store   跨页面共享的演示数据（localStorage，任务与会话分离的载体）
     Lease   跨标签页执行租约（leaseBy + 版本 + 心跳，Web Locks 互斥区实现）
     Scenes  场景卡定义与引导式要点收集表单（含必填校验）
     Util    杂项
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- Util */
  var Util = {
    $: function (sel, root) { return (root || document).querySelector(sel); },
    $$: function (sel, root) {
      return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    },
    /** 转义 HTML，演示数据虽为内置，仍统一走转义避免拼接出错 */
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    /** 由文件名推断扩展名，用于选择 Office 图标 */
    ext: function (name) {
      var m = /\.([a-z0-9]+)$/i.exec(name || '');
      return m ? m[1].toLowerCase() : 'md';
    },
    /** 渲染原生 Office 文件图标（docx/xlsx/pptx 而非 Markdown 预览） */
    fileIcon: function (name, small) {
      var e = Util.ext(name);
      var label = { docx: 'W', xlsx: 'X', pptx: 'P', pdf: 'PDF', md: 'MD', zip: 'ZIP' }[e] || 'FILE';
      var known = ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'zip'].indexOf(e) >= 0 ? e : 'md';
      return '<span class="fileicon fileicon--' + known + (small ? ' fileicon--sm' : '') +
        '" aria-hidden="true">' + label + '</span>';
    },
    /** 相对时间的简易格式化 */
    ago: function (ts) {
      var d = Math.max(0, Date.now() - ts), m = Math.floor(d / 60000);
      if (m < 1) return '刚刚';
      if (m < 60) return m + ' 分钟前';
      var h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时前';
      return Math.floor(h / 24) + ' 天前';
    },
    clock: function (ts) {
      var d = new Date(ts || Date.now()), p = function (n) { return n < 10 ? '0' + n : '' + n; };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },
    param: function (key) {
      var m = new RegExp('[?&]' + key + '=([^&#]*)').exec(global.location.search);
      return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
    }
  };

  /* --------------------------------------------------------------- Theme */
  var Theme = {
    KEY: 'agentproto.theme',
    init: function () {
      var saved = null;
      try { saved = localStorage.getItem(Theme.KEY); } catch (e) { /* 隐私模式忽略 */ }
      if (saved) document.documentElement.setAttribute('data-theme', saved);
      Util.$$('[data-theme-toggle]').forEach(function (btn) {
        btn.addEventListener('click', Theme.toggle);
        Theme.paint(btn);
      });
    },
    current: function () {
      var attr = document.documentElement.getAttribute('data-theme');
      if (attr) return attr;
      return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light';
    },
    toggle: function () {
      var next = Theme.current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(Theme.KEY, next); } catch (e) { /* ignore */ }
      Util.$$('[data-theme-toggle]').forEach(Theme.paint);
    },
    paint: function (btn) {
      var dark = Theme.current() === 'dark';
      btn.textContent = dark ? '☀' : '☾';
      btn.setAttribute('title', dark ? '切换为浅色主题' : '切换为深色主题');
      btn.setAttribute('aria-label', btn.getAttribute('title'));
    }
  };

  /* --------------------------------------------------------------- Toast */
  var Toast = {
    stack: null,
    ensure: function () {
      if (!Toast.stack) {
        Toast.stack = document.createElement('div');
        Toast.stack.className = 'toast-stack';
        Toast.stack.setAttribute('role', 'status');
        Toast.stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(Toast.stack);
      }
      return Toast.stack;
    },
    show: function (title, desc, kind, ms) {
      var el = document.createElement('div');
      el.className = 'toast' + (kind ? ' toast--' + kind : '');
      el.innerHTML = '<span aria-hidden="true">' +
        (kind === 'err' ? '⚠' : kind === 'ok' ? '✓' : 'ℹ') + '</span><div>' +
        '<strong>' + Util.esc(title) + '</strong>' +
        (desc ? '<span>' + Util.esc(desc) + '</span>' : '') + '</div>';
      Toast.ensure().appendChild(el);
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 250);
      }, ms || 4200);
    }
  };

  /* --------------------------------------------------------------- Modal */
  var Modal = {
    lastFocus: null,
    open: function (id) {
      var bd = document.getElementById(id);
      if (!bd) return;
      Modal.lastFocus = document.activeElement;
      bd.classList.add('open');
      bd.setAttribute('aria-hidden', 'false');
      var f = bd.querySelector('input,select,textarea,button');
      if (f) f.focus();
    },
    close: function (id) {
      var bd = document.getElementById(id);
      if (!bd) return;
      bd.classList.remove('open');
      bd.setAttribute('aria-hidden', 'true');
      if (Modal.lastFocus && Modal.lastFocus.focus) Modal.lastFocus.focus();
    },
    init: function () {
      // 点击遮罩空白处 / data-modal-close 关闭
      document.addEventListener('click', function (e) {
        var closer = e.target.closest ? e.target.closest('[data-modal-close]') : null;
        if (closer) {
          Modal.close(closer.getAttribute('data-modal-close'));
          return;
        }
        if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
          Modal.close(e.target.id);
        }
      });
      // Esc 关闭最上层
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var open = Util.$$('.modal-backdrop.open').pop();
        if (open) Modal.close(open.id);
      });
    }
  };

  /* casCommit 的两个小工具：值比较（null 与 undefined 视为等价）、期望判定
     （允许给函数做条件判断，断言函数还能拿到整库快照做范围判断） */
  function sameVal(a, b) { return (a == null && b == null) || a === b; }
  function expectOk(want, got, t, snap) {
    return typeof want === 'function' ? !!want(got, t, snap) : sameVal(got, want);
  }
  /** 回调可选：所有写入 API 的最后一个参数都按「有就回调、没有就算了」处理 */
  function hand(fn, v) { if (typeof fn === 'function') fn(v); }

  /* ------------------------------------------------ 跨上下文互斥（核心）
     localStorage 没有原生的比较并交换，而「一段连续的同步 JavaScript」并不构成
     跨标签页临界区：每个标签页有各自独立的事件循环（Chromium 下往往还是独立
     进程），完全可以在本页 getItem 与 setItem 之间跑完自己那一整套读改写。
     localStorage 早年规范里的 storage mutex 从未被浏览器真正实现、且已从规范
     移除，所以「本页内不被打断」与「跨页互斥」是两件不同的事，前者不能替代后者。

     这里用 Web Locks（navigator.locks）取得真正的跨上下文互斥：同一个命名锁在
     同源的所有标签页 / iframe / worker 之间同一时刻只有一个持有者，「读取整库
     → 比较期望值 → 写回整库」整段都在锁内完成。代价是 Web Locks 只有异步接口，
     因此 Store / Lease 的写入 API 全部改成回调形态（见各方法的调用范式说明）。

     降级路径（诚实说明，不要误读成「降级后同样原子」）：
       navigator.locks 要求安全上下文，且对不透明源会抛 SecurityError。
       https:// 与 http://localhost 一定可用；file:// 取决于浏览器——Chromium 系
       把 file:// 视为可信来源并给同一个 localStorage 分区，此时可用；把 file://
       当不透明源处理的浏览器则不可用。拿不到 Web Locks 时退到下面 lsAcquire 的
       降级实现：它靠「写入自己的令牌 → 等一个传播窗口 → 回读确认仍是自己」来
       仲裁，属于**基于时序假设**的互斥（假设同源各页对同一个 key 的写入能在
       SPIN_MS 内互相看到），不是可证明的互斥——若某页恰在抢锁窗口内被浏览器
       冻结、又在另一页按超时接手之后恢复，两边仍可能都认为自己持锁。
       这一残留风险只存在于没有 Web Locks 的环境，真实产品形态必须由服务端仲裁
       租约与并发名额，前端互斥只是原型层面的近似。

     调用约定：expect 断言与 patch 计算仍必须是纯同步函数——不 await、不起定时器、
     不调用 Store 的任何读写方法，否则它们会被挪到锁外执行，互斥就失去意义。 */
  var Lock = {
    NAME: 'agentproto.lock.v1',   // Web Locks 的锁名，同时是降级实现的 localStorage 键
    HOLD_MS: 4000,                // 降级实现里认定持锁页已消失、可以接手的时长
    SPIN_MS: 30,                  // 降级实现的写入传播观察窗口与重试节奏
    locksOk: null,                // Web Locks 是否可用，首次使用时判定并缓存
    _chain: null,                 // 本页的 FIFO：同页各临界区串行，杜绝自等待与重入
    _seq: 0,

    /** 当前实际生效的互斥机制，便于诚实地告知与排查 */
    mode: function () { return Lock.supported() ? 'weblocks' : 'fallback'; },

    supported: function () {
      if (Lock.locksOk === null) {
        var nav = global.navigator;
        Lock.locksOk = !!(nav && nav.locks && typeof nav.locks.request === 'function' &&
          global.isSecureContext !== false);
      }
      return Lock.locksOk;
    },

    /** 在跨上下文互斥区内跑一段同步临界区 fn，结束后把返回值交给 done */
    run: function (fn, done) {
      var next = (Lock._chain || Promise.resolve()).then(function () { return Lock.hold(fn); });
      Lock._chain = next.then(null, function () { /* 单次失败不打断本页后续排队 */ });
      next.then(function (out) { hand(done, out); }, function () { hand(done, null); });
      return next;
    },

    hold: function (fn) {
      var ran = false;
      if (Lock.supported()) {
        return global.navigator.locks.request(Lock.NAME, function () {
          ran = true;
          return fn();
        }).then(null, function (e) {
          if (ran) throw e;            // 临界区已经跑过，异常来自业务代码，不重跑
          Lock.locksOk = false;        // 不透明源等原因拿不到 Web Locks：转降级实现
          return Lock.lsHold(fn);
        });
      }
      return Lock.lsHold(fn);
    },

    /** 降级实现：以 localStorage 上的令牌 + 传播窗口回读确认来仲裁（见上方说明） */
    lsHold: function (fn) {
      var token = 'k' + Date.now().toString(36) + '-' + (++Lock._seq) +
        '-' + Math.random().toString(36).slice(2, 7);
      return new Promise(function (resolve, reject) {
        function enter() {
          lsAcquire(token, function (got) {
            if (!got) {
              setTimeout(enter, Lock.SPIN_MS + Math.floor(Math.random() * Lock.SPIN_MS));
              return;
            }
            // 抢到之后再确认一次并刷新持锁时间：本页若在等待窗口里被冻结，
            // 锁可能已被别页按超时接手，此时必须重新排队而不是直接进临界区
            if (!lsRefresh(token)) { enter(); return; }
            var out;
            try { out = fn(); } catch (e) { lsRelease(token); reject(e); return; }
            lsRelease(token);
            resolve(out);
          });
        }
        enter();
      });
    }
  };

  /** 读锁记录；localStorage 不可用时返回 undefined，调用方按「各页不共享」处理 */
  function lsRead() {
    var raw;
    try { raw = localStorage.getItem(Lock.NAME); } catch (e) { return undefined; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /** 尝试占锁：无人持有或持有者已超时才写入自己的令牌，等一个传播窗口后回读确认 */
  function lsAcquire(token, done) {
    var cur = lsRead();
    // 存储不可用（隐私模式）：各标签页本就不共享 localStorage，无需跨页仲裁
    if (cur === undefined) { done(true); return; }
    if (cur && cur.token !== token && Date.now() - (cur.at || 0) < Lock.HOLD_MS) {
      done(false);
      return;
    }
    try {
      localStorage.setItem(Lock.NAME, JSON.stringify({ token: token, at: Date.now() }));
    } catch (e) { done(true); return; }
    setTimeout(function () {
      var back = lsRead();
      done(back === undefined || !!(back && back.token === token));
    }, Lock.SPIN_MS);
  }

  /** 进临界区前复核持锁归属并刷新时间戳；已易主返回 false，由调用方重新排队 */
  function lsRefresh(token) {
    var cur = lsRead();
    if (cur === undefined) return true;
    if (!cur || cur.token !== token) return false;
    try {
      localStorage.setItem(Lock.NAME, JSON.stringify({ token: token, at: Date.now() }));
    } catch (e) { /* 写不进去也继续，最坏情况是被别页按超时接手 */ }
    return true;
  }

  /** 交还降级锁：只清理仍属于自己的那一份，避免抹掉别页刚抢到的锁 */
  function lsRelease(token) {
    var cur = lsRead();
    if (cur === undefined || !cur || cur.token !== token) return;
    try { localStorage.removeItem(Lock.NAME); } catch (e) { /* ignore */ }
  }

  /** localStorage 不可用（隐私模式）或尚无落盘数据时的退路：直接改内存状态。
      此时各标签页并不共享存储，也就不存在需要仲裁的跨页竞争。 */
  function memWrite(id, expect, patch) {
    var cur = Store.task(id), i, k, keys;
    if (!cur) return null;
    keys = expect ? Object.keys(expect) : [];
    for (i = 0; i < keys.length; i++) {
      if (!expectOk(expect[keys[i]], cur[keys[i]], cur, Store.load())) return null;
    }
    var body = typeof patch === 'function' ? patch(cur, Store.load()) : patch;
    if (!body) return null;
    keys = Object.keys(body);
    for (i = 0; i < keys.length; i++) { k = keys[i]; cur[k] = body[k]; }
    cur.updated = Date.now();
    Store.save();
    return body;
  }

  /** 单个任务的读—判—写，全程在互斥区内执行（由 atomicWrite 负责取锁）。
      expect 全部成立才写入，任一不符整体放弃、不产生任何副作用。
      返回实际写入的补丁对象，放弃时返回 null。 */
  function writeInLock(id, expect, patch) {
    var raw = null, avail = true;
    try { raw = localStorage.getItem(Store.KEY); } catch (e) { avail = false; }
    if (!avail || !raw) return memWrite(id, expect, patch);
    var snap = null;
    try { snap = JSON.parse(raw); } catch (e) { snap = null; }
    var list = (snap && snap.tasks) || null;
    if (!list) return memWrite(id, expect, patch);
    var cur = null, i, k, keys;
    for (i = 0; i < list.length; i++) {
      if (list[i].id === id) { cur = list[i]; break; }
    }
    if (!cur) return null;
    keys = expect ? Object.keys(expect) : [];
    for (i = 0; i < keys.length; i++) {
      if (!expectOk(expect[keys[i]], cur[keys[i]], cur, snap)) return null;
    }
    var body = typeof patch === 'function' ? patch(cur, snap) : patch;
    if (!body) return null;
    keys = Object.keys(body);
    for (i = 0; i < keys.length; i++) { k = keys[i]; cur[k] = body[k]; }
    cur.updated = Date.now();
    try { localStorage.setItem(Store.KEY, JSON.stringify(snap)); } catch (e) { return null; }
    return body;
  }

  /** 整库级读—改—写，全程在互斥区内执行（由 atomicState 负责取锁）。用于新增
      任务、待启动标记、意见回写这类不属于单个任务的字段——不用本页缓存整体覆盖，
      否则会把别的标签页刚写入的任务状态与租约一起回滚。 */
  function stateInLock(fn) {
    var raw = null, avail = true;
    try { raw = localStorage.getItem(Store.KEY); } catch (e) { avail = false; }
    var snap = null;
    if (avail && raw) { try { snap = JSON.parse(raw); } catch (e) { snap = null; } }
    if (!snap || !snap.tasks) {
      var mem = Store.load();
      var r0 = fn(mem);
      Store.save();
      return r0;
    }
    var out = fn(snap);
    try { localStorage.setItem(Store.KEY, JSON.stringify(snap)); } catch (e) { /* ignore */ }
    return out;
  }

  /** 单个任务的跨上下文原子读—判—写：整段读—判—写在 Lock 的互斥区内完成。
      done(body) 收结果，放弃时收到 null。 */
  function atomicWrite(id, expect, patch, done) {
    Lock.run(function () { return writeInLock(id, expect, patch); }, done);
  }

  /** 整库级跨上下文原子改写：fn(snapshot) 就地改，返回值经 done 回传 */
  function atomicState(fn, done) {
    Lock.run(function () { return stateInLock(fn); }, done);
  }

  /* --------------------------------------------------------------- Store
     跨页面共享的演示状态。任务是与会话解耦的一等公民（Spec 3.3），
     因此任务列表放在 Store 里，工作台 / 会话页 / 任务中心 / 移动端共享同一份。
     ---------------------------------------------------------------------- */
  var Store = {
    KEY: 'agentproto.state.v1',
    state: null,
    subs: [],

    /** 平台预置的演示任务：覆盖全部状态（排队/执行/待确认/完成/失败/取消） */
    seed: function () {
      var now = Date.now(), MIN = 60000;
      return {
        tasks: [
          {
            id: 'T-20260924-0118', scene: 'edu-audit-report',
            title: '2026年本科教育教学审核评估自评报告', industry: 'edu',
            status: 'running', step: 3, stepTotal: 7,
            now: '核对教务系统与人事系统的师生比口径',
            owner: '刘敏', workspace: '教务处',
            created: now - 12 * MIN, updated: now - 30000,
            tokens: 184200, cost: 2.41, sessionId: 'S-4471',
            artifacts: []
          },
          {
            id: 'T-20260924-0117', scene: 'mfg-8d',
            title: '8D报告-来料尺寸超差（供应商：宏昌精密）', industry: 'mfg',
            status: 'waiting', step: 5, stepTotal: 8,
            now: '等待确认：是否向供应商发送纠正措施要求邮件',
            reason: '高危动作需人工确认：对外发送邮件',
            owner: '陈国栋', workspace: '质量部',
            created: now - 34 * MIN, updated: now - 4 * MIN,
            tokens: 96500, cost: 1.28, sessionId: 'S-4468',
            artifacts: [{ name: '8D报告-来料尺寸超差.docx', size: '182 KB', state: 'draft' }]
          },
          {
            id: 'T-20260924-0116', scene: 'mfg-recon',
            title: '9月供应商对账核查（12 家供应商）', industry: 'mfg',
            status: 'queued', step: 0, stepTotal: 6,
            now: '排队中：当前档位并发 2/2，等待前序任务释放',
            owner: '周雅琴', workspace: '采购部',
            created: now - 3 * MIN, updated: now - 3 * MIN,
            tokens: 0, cost: 0, sessionId: 'S-4472', artifacts: []
          },
          {
            id: 'T-20260923-0104', scene: 'edu-ledger',
            title: '本科教学审核评估整改台账（第 3 轮更新）', industry: 'edu',
            status: 'done', step: 6, stepTotal: 6,
            now: '已完成', owner: '刘敏', workspace: '教务处',
            created: now - 26 * 60 * MIN, updated: now - 25 * 60 * MIN,
            tokens: 212800, cost: 3.06, sessionId: 'S-4455',
            artifacts: [
              { name: '本科教学审核评估整改台账.xlsx', size: '96 KB', state: 'ready' },
              { name: '整改台账更新说明.docx', size: '48 KB', state: 'ready' }
            ]
          },
          {
            id: 'T-20260923-0102', scene: 'mfg-iso-diff',
            title: 'ISO9001:2015 与 IATF16949:2016 体系文件比对', industry: 'mfg',
            status: 'done', step: 5, stepTotal: 5,
            now: '已完成', owner: '陈国栋', workspace: '质量部',
            created: now - 30 * 60 * MIN, updated: now - 29 * 60 * MIN,
            tokens: 268400, cost: 3.88, sessionId: 'S-4451',
            artifacts: [
              { name: '体系文件条款比对与差异清单.xlsx', size: '142 KB', state: 'ready' },
              { name: '不符合项风险提示.docx', size: '62 KB', state: 'ready' }
            ]
          },
          {
            id: 'T-20260923-0099', scene: 'edu-crosscheck',
            title: '科研项目结题数据多系统核对填报', industry: 'edu',
            status: 'failed', step: 2, stepTotal: 6,
            now: '执行失败',
            reason: '数据源解析失败：《科研项目台账-2026Q3.xlsx》第 2 个工作表存在合并单元格，表头无法定位。建议拆分合并单元格后重试。',
            owner: '黄志远', workspace: '科研院',
            created: now - 48 * 60 * MIN, updated: now - 47 * 60 * MIN,
            tokens: 41300, cost: 0.58, sessionId: 'S-4449',
            artifacts: [{ name: '中间产物-已解析字段映射表.xlsx', size: '22 KB', state: 'partial' }]
          },
          {
            id: 'T-20260922-0087', scene: 'edu-notice',
            title: '起草《关于开展2026年秋季学期教学检查的通知》', industry: 'edu',
            status: 'cancelled', step: 1, stepTotal: 4,
            now: '已由创建人取消', owner: '刘敏', workspace: '教务处',
            created: now - 72 * 60 * MIN, updated: now - 71 * 60 * MIN,
            tokens: 8600, cost: 0.11, sessionId: 'S-4440', artifacts: []
          },
          {
            id: 'T-20260922-0085', scene: 'mfg-sop',
            title: '编制《注塑机换模作业指导书》SOP', industry: 'mfg',
            status: 'done', step: 5, stepTotal: 5,
            now: '已完成', owner: '李伟明', workspace: '工艺部',
            created: now - 80 * 60 * MIN, updated: now - 79 * 60 * MIN,
            tokens: 156700, cost: 2.22, sessionId: 'S-4438',
            artifacts: [{ name: '注塑机换模作业指导书.docx', size: '214 KB', state: 'ready' }]
          }
        ],
        /** 待启动的任务：从工作台提交后写入，由会话页读取并开跑 */
        pending: null,
        /** 用户提出的修改意见（回写沉淀，Spec 3.4-3） */
        feedback: []
      };
    },

    load: function () {
      if (Store.state) return Store.state;
      try {
        var raw = localStorage.getItem(Store.KEY);
        if (raw) {
          Store.state = JSON.parse(raw);
          if (Store.state && Store.state.tasks) return Store.state;
        }
      } catch (e) { /* 解析失败则回落到种子数据 */ }
      Store.state = Store.seed();
      Store.save();
      return Store.state;
    },
    save: function () {
      try { localStorage.setItem(Store.KEY, JSON.stringify(Store.state)); } catch (e) { /* ignore */ }
    },
    /** 直读 localStorage 里的最新状态，不经进程内缓存（跨标签页判读用） */
    readRaw: function () {
      try {
        var raw = localStorage.getItem(Store.KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    /** 直读 localStorage 上某个任务的最新快照，不经进程内缓存。
        返回的是临时解析出来的对象，只用于判读，不要拿去改字段 */
    rawTask: function (id) {
      var raw = Store.readRaw();
      var list = (raw && raw.tasks) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return null;
    },
    /** 用 localStorage 的最新值刷新缓存。逐字段合并而非整体替换，保留任务
        对象的引用，避免其它页面已持有的任务引用指向被丢弃的旧对象。
        调用方按需触发（例如收到 storage 事件、或轮询同一任务的进度）。 */
    refresh: function () {
      var fresh = Store.readRaw();
      var cur = Store.load();
      if (!fresh || !fresh.tasks) return cur;
      var byId = {};
      cur.tasks.forEach(function (t) { byId[t.id] = t; });
      cur.tasks.length = 0;
      fresh.tasks.forEach(function (n) {
        var old = byId[n.id];
        if (!old) { cur.tasks.push(n); return; }
        Object.keys(old).forEach(function (k) { if (!(k in n)) delete old[k]; });
        Object.keys(n).forEach(function (k) { old[k] = n[k]; });
        cur.tasks.push(old);
      });
      cur.pending = fresh.pending;
      if (cur.feedback) {
        cur.feedback.length = 0;
        (fresh.feedback || []).forEach(function (f) { cur.feedback.push(f); });
      } else {
        cur.feedback = fresh.feedback || [];
      }
      return cur;
    },
    reset: function () {
      Store.state = Store.seed();
      Store.save();
    },
    tasks: function () { return Store.load().tasks; },
    task: function (id) {
      return Store.tasks().filter(function (t) { return t.id === id; })[0] || null;
    },
    /** 活跃任务：执行中 / 排队中 / 待确认，供全局提示条使用 */
    active: function () {
      return Store.tasks().filter(function (t) {
        return t.status === 'running' || t.status === 'queued' || t.status === 'waiting';
      });
    },
    update: function (id, patch) {
      var t = Store.task(id);
      if (!t) return null;
      Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
      t.updated = Date.now();
      Store.save();
      return t;
    },
    /** 穿透缓存的任务写入：改动在跨上下文互斥区内落到 localStorage 的最新整库
        快照上，再把结果合并回本页缓存，避免用进程内旧缓存整体覆盖其它标签页刚
        写入的改动。需要跨标签页竞争同一字段（如执行租约）的场景用此方法而非
        update。互斥要靠 Web Locks，因此是异步的：
          Store.commit(id, patch, function (t) { … })   // t 为 null 表示放弃
        无需知道结果时可省略回调。 */
    commit: function (id, patch, done) {
      atomicWrite(id, null, patch, function (body) {
        hand(done, body ? Store.localMerge(id, body) : null);
      });
    },
    /** 把已落盘的补丁合并回本页缓存，保持任务对象引用不变（桌面页有
        `t.step = t.step + 1` 这类就地写法依赖同一个引用） */
    localMerge: function (id, body) {
      var t = Store.task(id);
      if (!t) { Store.refresh(); t = Store.task(id); }
      if (!t) return null;
      Object.keys(body).forEach(function (k) { t[k] = body[k]; });
      t.updated = Date.now();
      return t;
    },
    /** 带期望旧值的比较并交换：expect 里每个键都要与 localStorage 上的当前值
        相符才写入，任一不符就整体放弃，不产生任何副作用。读取、校验与写入整段
        都在跨上下文互斥区内完成（见文件上方 Lock 的说明），别的标签页无法插进
        中间做同样的读改写，因此不需要写后回读——旧页面被冻结后恢复，也无法把
        校验结果套用到已经易主的租约上。
        用法（执行租约续期、队列名额抢占等需要跨标签页竞争同一字段的场景）：
          Store.casCommit(id, { leaseBy: 'm1a2b3', leaseVer: 4 },
                              { step: 5, now: '…' },
                              function (t) { if (!t) …期望不符… })
        expect 的值可以是断言函数 fn(currentValue, currentTask, snapshot)，返回真
        即通过，用于「名额未满」这类需要看整库的范围判断。
        patch 也可以是 fn(currentTask, snapshot) 并返回补丁对象，这样补丁能基于
        提交时刻的最新快照计算（例如 step 自增），而不是调用方手里的旧快照；
        返回假值表示放弃本次提交。
        约定：expect 断言与 patch 计算必须是纯同步的，不得在其中调用 Store 的
        读写方法或起异步操作，否则它们会被挪到互斥区外执行。 */
    casCommit: function (id, expect, patch, done) {
      atomicWrite(id, expect || {}, patch, function (body) {
        hand(done, body ? Store.localMerge(id, body) : null);
      });
    },
    /** 注册跨标签页变更回调：其它标签页改写 Store 时触发（storage 事件） */
    onChange: function (fn) {
      if (typeof fn === 'function') Store.subs.push(fn);
    },
    /** 新增任务：写入与 refresh 都在互斥区落定后才回调，done(task) */
    addTask: function (t, done) {
      atomicState(function (s) { s.tasks.unshift(t); }, function () {
        Store.refresh();
        hand(done, t);
      });
    },
    setPending: function (p, done) {
      atomicState(function (s) { s.pending = p; }, function () {
        Store.refresh();
        hand(done, p);
      });
    },
    /** 取走待启动标记：读与清空在同一互斥区内完成，两个页面不会都取到同一个 */
    takePending: function (done) {
      atomicState(function (s) {
        var v = s.pending;
        s.pending = null;
        return v;
      }, function (p) {
        Store.refresh();
        hand(done, p);
      });
    },
    addFeedback: function (fb, done) {
      atomicState(function (s) {
        if (!s.feedback) s.feedback = [];
        s.feedback.push(fb);
      }, function () {
        Store.refresh();
        hand(done, fb);
      });
    }
  };

  /* --------------------------------------------------------------- Lease
     统一的跨页执行租约。桌面会话页、任务中心的后台接管、移动端会话页都用这一套，
     不再各维护一份锁协议——两套并存时桌面页与移动页同开一个任务会双推进。

     任务上的三个字段构成租约：
       leaseBy    持租约的页面身份（Lease.id()），空 / null 表示无人持有
       leaseVer 租约版本号，每次抢占与每次续期都自增，用于识别「本页被冻结期间
                租约已易主又转回同名 leaseBy」这类情形
       leaseAt  最近一次心跳时间；Date.now() - leaseAt >= TTL 即视为租约过期，
                可被其它长驻页面接管（页面被关掉没来得及清理时靠这条兜底）

     规则：
       1. 只有持租约的一方才能写 step / tokens / 产物 / 终态，写入必须走
          Lease.renew —— 它把「校验 leaseBy → 写业务字段 + 续期」放进同一个跨上下文
          互斥区，不匹配就整体放弃，调用方据此立即停止推进。
       2. 页面退出时用 Lease.release 以所有权校验原子清理，任务不会卡在 running。
       3. 接管方必须尊重任务上已有的业务标记（如 dangerAcked / failedStep）。

     调用范式：互斥要靠异步的 Web Locks，因此所有写入方法都以回调收结果，
     回调参数为写入后的任务对象，null 表示校验不通过、本次一个字段都没写：
       Lease.renew(id, patch, function (t) { if (!t) stopTimer(); });
     判读方法（expired / heldByOther / mine / ver / runningCount / staleRunning）
     仍是同步的——它们只读不写，读到过期值的后果由随后的写入校验兜住。
     ---------------------------------------------------------------------- */
  var Lease = {
    TTL: 10000,                 // 心跳超过此时长即视为租约过期，可被接管
    LIMIT: 2,                   // 档位并发上限，桌面 / 移动 / 任务中心同一口径
    _id: null,

    /** 本页身份：同一个标签页内稳定，不同标签页必不相同 */
    id: function () {
      if (!Lease._id) {
        Lease._id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      }
      return Lease._id;
    },

    /** 租约是否已过期（无 leaseBy 也按过期处理，可直接抢占） */
    expired: function (t) {
      if (!t || !t.leaseBy) return true;
      return Date.now() - (t.leaseAt || 0) >= Lease.TTL;
    },
    /** 租约是否由别的页面持有且心跳未过期 */
    heldByOther: function (t) {
      return !!(t && t.leaseBy && t.leaseBy !== Lease.id() && !Lease.expired(t));
    },
    /** 本页是否仍持有该任务的租约（穿透 localStorage 判读） */
    mine: function (id) {
      var t = Store.rawTask(id);
      return !!(t && t.leaseBy === Lease.id() && !Lease.expired(t));
    },
    /** 本页认定的租约版本，用于给下一次提交带期望旧值 */
    ver: function (id) {
      var t = Store.rawTask(id);
      return t ? (t.leaseVer || 0) : 0;
    },

    /** 期望断言：版本号必须仍等于 n（缺字段按 0 计，避免 0 与 undefined 误判）。
        下面的 acquire / renew / release 不再用它——它们的归属判定就在互斥区内按
        当次快照做，再断言「版本与我上次读到的一致」是同义重复。留给调用方在
        「先读一次、隔一段时间才提交」这类场景自行带期望版本用：
          Store.casCommit(id, { leaseVer: Lease.verIs(myVer) }, patch, done) */
    verIs: function (n) {
      return function (v) { return (v || 0) === n; };
    },

    /** 快照上的运行中任务数：判并发名额一律用整库快照，不用本页缓存 */
    runningCount: function (snap) {
      var list = (snap && snap.tasks) || [];
      var n = 0;
      for (var i = 0; i < list.length; i++) if (list[i].status === 'running') n++;
      return n;
    },

    /** 可申领名额的入场状态：这几种都还没占着名额，因此都要过名额校验。
        这里只回答「哪些状态尚未占名额」，不回答「某次操作允许从哪个状态进入」——
        后者由 claimSlot 的 from 参数逐路径声明，两道校验都在互斥区内一起做。
        cancelled 留在表内是因为任务中心支持「重试一个已取消的任务」，那条路径会
        显式把 cancelled 声明进 from；恢复执行（确认 / 跳过 / 会话页重试）一律不带它。 */
    CLAIMABLE: ['queued', 'failed', 'cancelled', 'waiting'],

    /**
     * 抢占租约：只在「无人持有或租约已过期」时成功，成功即 leaseBy 归本页、版本自增。
     * extra 是同笔提交里要写的业务补丁（可为 fn(cur, snap)），与抢占不可分离。
     * 判定与写入都在互斥区内，不存在「判完被别页抢走再写」的窗口。
     *   Lease.acquire(id, extra, function (t) { if (!t) …别页正持有… });
     */
    acquire: function (id, extra, done) {
      Store.casCommit(id, {
        leaseBy: function (v, t) { return !t.leaseBy || t.leaseBy === Lease.id() || Lease.expired(t); }
      }, function (t, snap) {
        var body = typeof extra === 'function' ? extra(t, snap) : (extra || {});
        if (!body) return null;
        body.leaseBy = Lease.id();
        body.leaseVer = (t.leaseVer || 0) + 1;
        body.leaseAt = Date.now();
        return body;
      }, done);
    },

    /**
     * 续期并写业务字段：以「租约仍属本页」为前提在互斥区内原子提交。
     * patch 可以是 fn(cur, snap)，由它基于提交时刻的最新快照算补丁——本页可能
     * 被浏览器冻结过，手里的旧快照算出的 step 可能已经过时。返回假值表示放弃。
     * 回调收到 null 即租约已易主，调用方必须立即停止推进，不得再写任何字段。
     */
    renew: function (id, patch, done) {
      Store.casCommit(id, { leaseBy: Lease.id() }, function (t, snap) {
        var body = typeof patch === 'function' ? patch(t, snap) : (patch || {});
        if (!body) return null;
        if (!('leaseBy' in body)) body.leaseBy = Lease.id();
        // 交还租约时不再递增版本，留给下一个抢占者接着算
        if (body.leaseBy === Lease.id()) {
          body.leaseVer = (t.leaseVer || 0) + 1;
          body.leaseAt = Date.now();
        }
        return body;
      }, done);
    },

    /**
     * 以所有权校验原子交还租约。extra 里可带终态或退回 queued 的补丁；
     * 租约已不属本页则整体不写，避免把别人的推进结果覆盖掉。
     */
    release: function (id, extra, done) {
      Store.casCommit(id, { leaseBy: Lease.id() }, function (t, snap) {
        var body = typeof extra === 'function' ? extra(t, snap) : (extra || {});
        if (!body) body = {};
        body.leaseBy = '';
        body.leaseAt = 0;
        return body;
      }, done);
    },

    /**
     * 本次操作是否允许从 status 这个来源状态入场。
     * from 为字符串或字符串数组，省略 / 空表示不额外限定，只用全局 CLAIMABLE 兜底。
     * 供调用方在申领失败后分辨「来源状态已变」与「名额真满」两种原因用——判定本身
     * 在 claimSlot 的互斥区内已经做过一遍，这里是只读判读，不承担正确性。
     */
    fromAllows: function (from, status) {
      if (Lease.CLAIMABLE.indexOf(status) < 0) return false;
      if (!from) return true;
      if (typeof from === 'string') return from === status;
      return from.indexOf(status) >= 0;
    },

    /**
     * 申领一个并发名额：数名额、状态迁移到 running 与抢租约是同一笔提交，整段
     * 都在跨上下文互斥区内——名额是否已满按当次整库快照判定，两个标签页不可能
     * 同时抢到最后一个名额，也不需要事后仲裁与退回。回调收到任务对象即申领成功。
     * 入场状态限定为 CLAIMABLE（排队 / 失败 / 取消 / 待确认）这几种尚未占用名额的
     * 状态：重试与确认继续同样必须过这道名额校验，不能成为绕过上限的第二条路径。
     *
     * from 声明「本次操作允许从哪个来源状态入场」，与名额校验在同一笔互斥提交内
     * 断言，因此不存在「等锁期间任务被别页改成别的状态、申领却照样成功」的窗口：
     *   - 字符串：只允许这一个状态（确认 / 跳过传 'waiting'，恢复重试传 'failed'）
     *   - 数组：允许其中任一状态（任务中心的重试传 ['failed', 'cancelled']）
     *   - 省略 / 传 null：不额外限定，沿用全局 CLAIMABLE（向后兼容旧调用）
     * 省略 from 时仍可写成三参数形态，第三个参数是回调：
     *   Lease.claimSlot(id, extra, function (t) { … });
     *   Lease.claimSlot(id, extra, 'waiting', function (t) { if (t) startRunner(); else 排队(); });
     */
    claimSlot: function (id, extra, from, done) {
      // 三参数形态（id, extra, done）：把回调挪回 done，本次不限定来源状态
      if (typeof from === 'function' && done === undefined) { done = from; from = null; }
      Store.casCommit(id, {
        status: function (v, t, snap) {
          // 来源状态与名额在同一笔提交内一起断言：任一不成立则一个字段都不写，
          // 期间被别页取消 / 推进的任务不会被旧的恢复请求改回 running
          if (!Lease.fromAllows(from, v)) return false;
          return Lease.runningCount(snap) < Lease.LIMIT;
        },
        leaseBy: function (v, t) { return !t.leaseBy || t.leaseBy === Lease.id() || Lease.expired(t); }
      }, function (t, snap) {
        var body = typeof extra === 'function' ? extra(t, snap) : (extra || {});
        if (!body) return null;
        body.status = 'running';
        body.leaseBy = Lease.id();
        body.leaseVer = (t.leaseVer || 0) + 1;
        body.leaseAt = Date.now();
        return body;
      }, done);
    },

    /**
     * 强制收回租约并落终态：用于「取消」这类由创建人发起、不该受租约归属限制的
     * 动作。版本号在同一笔提交里自增，正在代跑该任务的页面下一拍校验必然失败，
     * 从而停止推进，不会把已落的终态又覆盖回执行中。
     */
    revoke: function (id, extra, done) {
      Store.casCommit(id, {}, function (t, snap) {
        var body = typeof extra === 'function' ? extra(t, snap) : (extra || {});
        if (!body) return null;
        body.leaseBy = '';
        body.leaseAt = 0;
        body.leaseVer = (t.leaseVer || 0) + 1;
        return body;
      }, done);
    },

    /** 租约已过期的运行中任务：长驻页面据此接管，任务不会永久卡在 running */
    staleRunning: function (snap) {
      var raw = snap || Store.readRaw();
      var list = (raw && raw.tasks) || [];
      return list.filter(function (t) {
        return t.status === 'running' && t.leaseBy !== Lease.id() && Lease.expired(t);
      }).sort(function (a, b) { return a.created - b.created; });
    },

    /**
     * 接管一个租约已过期的运行中任务：只换 leaseBy 不改 status，因此不额外占名额
     * （它本来就已经计入 running）。别的页面在此之前续上了心跳则接管失败。
     */
    adopt: function (id, extra, done) {
      Store.casCommit(id, {
        status: 'running',
        leaseBy: function (v, t) { return Lease.expired(t); }
      }, function (t, snap) {
        var body = typeof extra === 'function' ? extra(t, snap) : (extra || {});
        if (!body) return null;
        body.leaseBy = Lease.id();
        body.leaseVer = (t.leaseVer || 0) + 1;
        body.leaseAt = Date.now();
        return body;
      }, done);
    }
  };

  /* -------------------------------------------------------- Status meta */
  var STATUS = {
    queued:    { label: '排队中',   cls: 'tag--info',  pulse: false },
    running:   { label: '执行中',   cls: 'tag--run',   pulse: true },
    waiting:   { label: '等待确认', cls: 'tag--warn',  pulse: true },
    done:      { label: '已完成',   cls: 'tag--ok',    pulse: false },
    failed:    { label: '失败',     cls: 'tag--err',   pulse: false },
    cancelled: { label: '已取消',   cls: '',           pulse: false }
  };
  function statusTag(status) {
    var m = STATUS[status] || { label: status, cls: '' };
    return '<span class="tag ' + m.cls + '"><i class="dot' + (m.pulse ? ' dot--pulse' : '') +
      '" aria-hidden="true"></i>' + m.label + '</span>';
  }

  /* -------------------------------------------------------------- Scenes
     场景卡定义（Spec 3.1 / 4.2）。每个场景声明引导式要点收集的字段，
     required 字段未齐备时阻止提交并明确提示缺什么（验收标准第 3 条）。
     ---------------------------------------------------------------------- */
  var SCENES = [
    /* ---------------- 高校服务机构 ---------------- */
    {
      id: 'edu-audit-report', industry: 'edu', group: '评估与检查',
      icon: '📋', title: '生成审核评估自评报告',
      desc: '按教育部审核评估指标体系，结合校内多系统数据与历史材料，生成自评报告全文。',
      out: 'docx', runs: 42, source: 'platform',
      fields: [
        { key: 'round', label: '评估轮次与名称', type: 'text', required: true,
          placeholder: '如：2026年本科教育教学审核评估（第二类第二种）' },
        { key: 'deadline', label: '材料上报截止日期', type: 'date', required: true },
        { key: 'indicators', label: '需覆盖的一级指标', type: 'checks', required: true,
          options: ['党的教育方针落实', '思政教育', '教师队伍建设', '培养过程', '学生发展', '质量保障'] },
        { key: 'files', label: '数据与材料附件', type: 'files', required: true,
          preset: ['教务系统-课程与学时统计-2025学年.xlsx', '人事处-专任教师结构表.xlsx',
                   '上轮评估专家反馈意见.docx'],
          hint: '支持 xlsx / docx / pdf。系统会解析表头并与本校字段口径对齐。' },
        { key: 'template', label: '套用模板', type: 'select', required: false,
          options: ['本校自评报告模板（2026版）', '教育部参考模板', '不套版' ] },
        { key: 'notes', label: '补充要点（可选）', type: 'textarea', required: false,
          placeholder: '如：师生比按折合在校生数计算，不含在职研究生。' }
      ]
    },
    {
      id: 'edu-ledger', industry: 'edu', group: '评估与检查',
      icon: '🗂', title: '整理评估整改台账',
      desc: '把专家反馈意见拆解为可追踪的整改事项，生成责任部门、时限、进度分列的台账表。',
      out: 'xlsx', runs: 31, source: 'platform',
      fields: [
        { key: 'src', label: '问题来源', type: 'select', required: true,
          options: ['专家进校考察反馈意见', '上级检查通报', '校内自查发现问题', '往轮整改遗留'] },
        { key: 'files', label: '反馈意见原文', type: 'files', required: true,
          preset: ['审核评估专家组反馈意见（2026-09）.docx'] },
        { key: 'depts', label: '涉及责任部门', type: 'checks', required: true,
          options: ['教务处', '人事处', '科研院', '学生工作部', '资产后勤处', '各教学单位'] },
        { key: 'deadline', label: '整改完成时限', type: 'date', required: true },
        { key: 'notes', label: '台账口径说明（可选）', type: 'textarea', required: false }
      ]
    },
    {
      id: 'edu-crosscheck', industry: 'edu', group: '数据填报',
      icon: '🔍', title: '多系统数据核对填报',
      desc: '跨教务、人事、科研、财务多张导出表交叉核对，定位口径冲突并生成填报表。',
      out: 'xlsx', runs: 58, source: 'tenant',
      fields: [
        { key: 'target', label: '目标填报表', type: 'text', required: true,
          placeholder: '如：高等教育质量监测国家数据平台-教师基本情况表' },
        { key: 'files', label: '待核对的导出表（至少 2 份）', type: 'files', required: true,
          preset: ['教务系统-教师授课学时.xlsx', '人事系统-在职教职工名册.xlsx',
                   '科研系统-项目负责人清单.xlsx'] },
        { key: 'keyfield', label: '主键字段', type: 'text', required: true, placeholder: '如：职工号' },
        { key: 'conflict', label: '冲突处理策略', type: 'select', required: true,
          options: ['以人事系统为准', '以教务系统为准', '全部列出人工裁决'] }
      ]
    },
    {
      id: 'edu-notice', industry: 'edu', group: '公文与通知',
      icon: '📄', title: '起草校内通知公文',
      desc: '按本校公文格式规范起草通知、通报、函，自动套用红头版式与发文字号占位。',
      out: 'docx', runs: 96, source: 'platform',
      fields: [
        { key: 'kind', label: '公文种类', type: 'select', required: true,
          options: ['通知', '通报', '函', '会议纪要', '请示'] },
        { key: 'subject', label: '事由', type: 'text', required: true,
          placeholder: '如：开展2026年秋季学期期中教学检查' },
        { key: 'to', label: '主送单位', type: 'text', required: true,
          placeholder: '如：各教学单位、各机关部处' },
        { key: 'points', label: '需写入的要点', type: 'textarea', required: true,
          placeholder: '每行一条，如：\n检查时间为第 9—10 周\n各单位于 10 月 20 日前报送自查表' },
        { key: 'files', label: '参考文件（可选）', type: 'files', required: false,
          preset: ['往年教学检查通知.docx'] }
      ]
    },
    {
      id: 'edu-research', industry: 'edu', group: '科研管理',
      icon: '🔬', title: '汇总科研项目申报材料',
      desc: '按申报指南逐项核验材料齐备性，汇总形成申报书与附件清单，标出缺件。',
      out: 'docx', runs: 27, source: 'platform',
      fields: [
        { key: 'program', label: '申报项目类别', type: 'text', required: true,
          placeholder: '如：2027年度国家自然科学基金面上项目' },
        { key: 'files', label: '申报指南与已有材料', type: 'files', required: true,
          preset: ['申报指南（2027年度）.pdf', '申请人基本情况汇总.xlsx'] },
        { key: 'deadline', label: '校内汇总截止日期', type: 'date', required: true },
        { key: 'checklist', label: '需核验的材料项', type: 'checks', required: true,
          options: ['申请书正文', '伦理审查批件', '合作单位证明', '在研项目清单', '经费预算表'] }
      ]
    },
    /* ---------------- 传统制造业 ---------------- */
    {
      id: 'mfg-8d', industry: 'mfg', group: '质量管理',
      icon: '🛠', title: '生成 8D 质量报告',
      desc: '按 8D 方法论逐步展开：组队、问题描述、临时措施、根本原因、纠正与预防措施。',
      out: 'docx', runs: 73, source: 'platform',
      fields: [
        { key: 'issue', label: '质量问题描述', type: 'text', required: true,
          placeholder: '如：来料外径尺寸超差 0.08mm，导致装配压装不到位' },
        { key: 'part', label: '零件号 / 物料号', type: 'text', required: true, placeholder: '如：PN-44827-B' },
        { key: 'supplier', label: '供应商 / 责任方', type: 'text', required: true, placeholder: '如：宏昌精密' },
        { key: 'found', label: '问题发现日期', type: 'date', required: true },
        { key: 'files', label: '检验与追溯数据', type: 'files', required: true,
          preset: ['来料检验记录-PN44827B.xlsx', '客户投诉单-20260918.pdf',
                   '首件检验报告.xlsx'] },
        { key: 'std', label: '适用体系标准', type: 'checks', required: true,
          options: ['IATF16949:2016', 'ISO9001:2015', '客户特殊要求（CSR）'] },
        { key: 'notes', label: '已采取的临时措施（可选）', type: 'textarea', required: false }
      ]
    },
    {
      id: 'mfg-iso-diff', industry: 'mfg', group: '体系与审核',
      icon: '⚖️', title: 'ISO9001/IATF16949 体系文件比对',
      desc: '同一套事实按不同标准维护多份文件时，逐条比对差异，标出可能被开不符合项的位置。',
      out: 'xlsx', runs: 38, source: 'platform',
      fields: [
        { key: 'files', label: '待比对的体系文件（至少 2 份）', type: 'files', required: true,
          preset: ['质量手册-QM-2026-RevC.docx', '程序文件汇编-QP全套.docx',
                   'IATF16949条款对照表.xlsx'] },
        { key: 'scope', label: '比对范围条款', type: 'checks', required: true,
          options: ['4 组织环境', '6 策划', '7 支持', '8 运行', '9 绩效评价', '10 改进'] },
        { key: 'audit', label: '面向的审核类型', type: 'select', required: true,
          options: ['第三方认证审核', '客户验厂（VDA6.3）', '内部审核', '监督审核'] },
        { key: 'date', label: '审核预计日期', type: 'date', required: false }
      ]
    },
    {
      id: 'mfg-recon', industry: 'mfg', group: '采购与财务',
      icon: '🧾', title: '供应商对账核查',
      desc: '把供应商月结对账单与内部收货、入库、发票数据交叉核对，输出差异明细与原因归类。',
      out: 'xlsx', runs: 64, source: 'tenant',
      fields: [
        { key: 'period', label: '对账期间', type: 'text', required: true, placeholder: '如：2026年9月' },
        { key: 'files', label: '对账单与内部数据（至少 2 份）', type: 'files', required: true,
          preset: ['供应商月结对账单-9月（12家）.xlsx', 'ERP收货明细-202609.xlsx',
                   '发票登记台账-202609.xlsx'] },
        { key: 'tol', label: '金额差异容差（元）', type: 'number', required: true, placeholder: '如：50' },
        { key: 'group', label: '差异归类维度', type: 'checks', required: true,
          options: ['单价差异', '数量差异', '税率差异', '跨期入账', '退货未冲销'] }
      ]
    },
    {
      id: 'mfg-asset', industry: 'mfg', group: '生产与设备',
      icon: '⚙️', title: '设备台账整理',
      desc: '把分散的设备卡片、点检记录、维修单合并为统一台账，补全编号与保养周期字段。',
      out: 'xlsx', runs: 22, source: 'platform',
      fields: [
        { key: 'scope', label: '整理范围', type: 'select', required: true,
          options: ['全厂设备', '注塑车间', '冲压车间', '装配线', '检测与计量器具'] },
        { key: 'files', label: '现有台账与记录', type: 'files', required: true,
          preset: ['设备卡片汇总（手工录入）.xlsx', '2026年点检记录.xlsx', '维修工单导出.xlsx'] },
        { key: 'fields', label: '需补全的字段', type: 'checks', required: true,
          options: ['资产编号', '安装位置', '保养周期', '责任人', '校准有效期'] }
      ]
    },
    {
      id: 'mfg-sop', industry: 'mfg', group: '工艺与作业',
      icon: '📐', title: '编制作业指导书 SOP',
      desc: '把工艺参数与操作步骤转为标准作业指导书，含关键控制点、安全提示与记录表。',
      out: 'docx', runs: 45, source: 'platform',
      fields: [
        { key: 'process', label: '工序名称', type: 'text', required: true, placeholder: '如：注塑机换模' },
        { key: 'line', label: '适用产线 / 设备', type: 'text', required: true, placeholder: '如：注塑车间 1—6 号机' },
        { key: 'files', label: '工艺参数与既有文件', type: 'files', required: true,
          preset: ['注塑工艺参数表.xlsx', '换模作业旧版指导书.docx'] },
        { key: 'ctrl', label: '关键控制点', type: 'checks', required: true,
          options: ['模温', '锁模力', '保压时间', '安全锁定挂牌', '首件确认'] },
        { key: 'notes', label: '安全与环境要求（可选）', type: 'textarea', required: false }
      ]
    },
    /* ---------------- 日常通用办公 ---------------- */
    {
      id: 'gen-report', industry: 'gen', group: '日常办公',
      icon: '📊', title: '数据统计与图表',
      desc: '对上传表格做汇总、透视与趋势分析，产出带公式与图表的工作表。',
      out: 'xlsx', runs: 118, source: 'platform',
      fields: [
        { key: 'goal', label: '统计目标', type: 'text', required: true,
          placeholder: '如：按车间与月份统计不良品率趋势' },
        { key: 'files', label: '数据源表格', type: 'files', required: true,
          preset: ['生产日报汇总-2026Q3.xlsx'] },
        { key: 'chart', label: '需要的图表', type: 'checks', required: false,
          options: ['趋势折线图', '占比饼图', '对比柱状图', '帕累托图'] }
      ]
    },
    {
      id: 'gen-ppt', industry: 'gen', group: '日常办公',
      icon: '🖼', title: '汇报材料成稿（PPT）',
      desc: '把文字素材与数据整理为汇报演示稿，套用本单位版式。',
      out: 'pptx', runs: 61, source: 'platform',
      fields: [
        { key: 'topic', label: '汇报主题', type: 'text', required: true, placeholder: '如：三季度质量月度分析会汇报' },
        { key: 'audience', label: '汇报对象', type: 'select', required: true,
          options: ['公司管理层', '上级主管部门', '客户方审核组', '部门内部'] },
        { key: 'pages', label: '预计页数', type: 'number', required: true, placeholder: '如：18' },
        { key: 'files', label: '素材附件', type: 'files', required: false,
          preset: ['质量月报-9月.docx'] }
      ]
    }
  ];

  var INDUSTRY = {
    edu: { label: '高校服务机构', cls: 'ind--edu' },
    mfg: { label: '传统制造业', cls: 'ind--mfg' },
    gen: { label: '通用办公', cls: 'ind--gen' }
  };

  var Scenes = {
    all: SCENES,
    get: function (id) {
      return SCENES.filter(function (s) { return s.id === id; })[0] || null;
    },
    industryMeta: function (k) { return INDUSTRY[k] || INDUSTRY.gen; },

    /** 渲染一张场景卡（按钮语义，键盘可达） */
    card: function (s) {
      var ind = Scenes.industryMeta(s.industry);
      return '<button type="button" class="scene-card" data-scene="' + s.id + '">' +
        '<span class="scene-card__top">' +
          '<span class="scene-card__icon" aria-hidden="true">' + s.icon + '</span>' +
          '<span class="scene-card__title">' + Util.esc(s.title) + '</span>' +
        '</span>' +
        '<span class="scene-card__desc">' + Util.esc(s.desc) + '</span>' +
        '<span class="scene-card__foot">' +
          '<span class="ind ' + ind.cls + '">' + ind.label + '</span>' +
          (s.source === 'tenant' ? '<span class="tag tag--brand">本单位自建</span>' : '') +
          '<span class="spacer"></span>' +
          '<span class="scene-card__out">' + Util.fileIcon('x.' + s.out, true) + '·' + s.runs + ' 次</span>' +
        '</span>' +
        '</button>';
    },

    /** 生成引导式要点收集表单（替代自由 prompt，Spec 3.1） */
    formHTML: function (s) {
      var html = '';
      s.fields.forEach(function (f) {
        var id = 'f_' + s.id + '_' + f.key;
        var req = f.required ? '<span class="req" aria-hidden="true">*</span>' : '';
        html += '<div class="field" data-field="' + f.key + '" data-required="' + (!!f.required) + '"' +
                ' data-type="' + f.type + '" data-label="' + Util.esc(f.label) + '">';
        html += '<label class="field__label" for="' + id + '">' + Util.esc(f.label) + req + '</label>';

        if (f.type === 'text' || f.type === 'number' || f.type === 'date') {
          html += '<input type="' + f.type + '" id="' + id + '" ' +
                  (f.placeholder ? 'placeholder="' + Util.esc(f.placeholder) + '"' : '') + '>';
        } else if (f.type === 'textarea') {
          html += '<textarea id="' + id + '" ' +
                  (f.placeholder ? 'placeholder="' + Util.esc(f.placeholder) + '"' : '') + '></textarea>';
        } else if (f.type === 'select') {
          html += '<select id="' + id + '"><option value="">请选择…</option>';
          f.options.forEach(function (o) { html += '<option>' + Util.esc(o) + '</option>'; });
          html += '</select>';
        } else if (f.type === 'checks') {
          html += '<div class="check-row" id="' + id + '" role="group" aria-label="' + Util.esc(f.label) + '">';
          f.options.forEach(function (o, i) {
            html += '<label class="check"><input type="checkbox" value="' + Util.esc(o) + '"' +
                    (i === 0 ? '' : '') + '>' + Util.esc(o) + '</label>';
          });
          html += '</div>';
        } else if (f.type === 'files') {
          html += '<div class="dropzone" id="' + id + '" tabindex="0" role="button" ' +
                  'aria-label="添加' + Util.esc(f.label) + '">' +
                  '<strong>点击此处添加材料</strong>从本机选择，或从知识库引用已有文档</div>' +
                  '<ul class="filelist" data-files></ul>';
          if (f.preset && f.preset.length) {
            html += '<p class="hint">演示可一键带入：' +
              f.preset.map(function (p) {
                return '<button type="button" class="btn btn--sm" data-add-file="' + Util.esc(p) + '">+ ' +
                  Util.esc(p) + '</button>';
              }).join(' ') + '</p>';
          }
        }
        if (f.hint) html += '<p class="hint">' + Util.esc(f.hint) + '</p>';
        html += '<p class="error-msg" role="alert"></p></div>';
      });
      return html;
    },

    /** 读取并校验表单；返回 { ok, values, missing[] } */
    collect: function (root) {
      var values = {}, missing = [];
      Util.$$('.field', root).forEach(function (fd) {
        var key = fd.getAttribute('data-field');
        var type = fd.getAttribute('data-type');
        var required = fd.getAttribute('data-required') === 'true';
        var label = fd.getAttribute('data-label');
        var err = Util.$('.error-msg', fd);
        var val;

        if (type === 'checks') {
          val = Util.$$('input[type=checkbox]:checked', fd).map(function (c) { return c.value; });
        } else if (type === 'files') {
          val = Util.$$('.fileitem', fd).map(function (li) {
            return li.getAttribute('data-name');
          });
        } else {
          var input = Util.$('input,select,textarea', fd);
          val = input ? input.value.trim() : '';
        }

        var empty = Array.isArray(val) ? val.length === 0 : !val;
        // files 类型若声明「至少 2 份」则加严校验
        var needTwo = type === 'files' && /至少 2 份/.test(label || '');
        var short = needTwo && Array.isArray(val) && val.length < 2;

        if (required && (empty || short)) {
          missing.push(label + (short ? '（至少需要 2 份）' : ''));
          if (err) {
            err.textContent = short ? '至少需要 2 份文件才能进行交叉比对' : '这是必填项，请补充「' + label + '」';
            err.classList.add('show');
          }
          fd.setAttribute('data-invalid', 'true');
          var ctl = Util.$('input,select,textarea', fd);
          if (ctl && type !== 'checks' && type !== 'files') ctl.setAttribute('aria-invalid', 'true');
        } else {
          if (err) { err.textContent = ''; err.classList.remove('show'); }
          fd.removeAttribute('data-invalid');
          var ok = Util.$('input,select,textarea', fd);
          if (ok) ok.removeAttribute('aria-invalid');
        }
        values[key] = val;
      });
      return { ok: missing.length === 0, values: values, missing: missing };
    },

    /** 在表单容器内挂载文件添加 / 删除行为 */
    bindFiles: function (root) {
      root.addEventListener('click', function (e) {
        var add = e.target.closest('[data-add-file]');
        if (add) {
          var name = add.getAttribute('data-add-file');
          var field = add.closest('.field');
          Scenes.pushFile(field, name);
          add.disabled = true;
          return;
        }
        var del = e.target.closest('[data-del-file]');
        if (del) { del.closest('.fileitem').remove(); return; }
        var dz = e.target.closest('.dropzone');
        if (dz) {
          // 原型中不触发真实文件选择，改为提示走演示按钮带入
          Toast.show('原型说明', '请使用下方「+ 文件名」按钮模拟添加材料', 'info', 3000);
        }
      });
    },
    pushFile: function (field, name) {
      var list = Util.$('[data-files]', field);
      if (!list) return;
      if (Util.$$('.fileitem', list).some(function (li) { return li.getAttribute('data-name') === name; })) return;
      var li = document.createElement('li');
      li.className = 'fileitem';
      li.setAttribute('data-name', name);
      li.innerHTML = Util.fileIcon(name, true) +
        '<span class="spacer"><span class="fileitem__name">' + Util.esc(name) + '</span>' +
        '<span class="fileitem__meta">已上传 · 待解析</span></span>' +
        '<button type="button" class="iconbtn" data-del-file aria-label="移除 ' + Util.esc(name) + '">×</button>';
      list.appendChild(li);
    }
  };

  /* --------------------------------------------------- 全局任务提示条 */
  /** 在任意页面渲染「进行中任务」常驻提示（Spec 4.1 全局交互规则） */
  function renderTaskbar(el) {
    if (!el) return;
    var act = Store.active();
    if (!act.length) {
      el.innerHTML = '<div class="banner"><span aria-hidden="true">✓</span>' +
        '<span class="spacer">当前没有进行中的任务。</span>' +
        '<a href="tasks.html">查看历史任务</a></div>';
      return;
    }
    var running = act.filter(function (t) { return t.status === 'running'; });
    var head = running[0] || act[0];
    el.innerHTML = '<div class="taskbar" role="status">' +
      '<i class="dot dot--pulse" aria-hidden="true"></i>' +
      '<div class="taskbar__list">' +
        '<b>' + act.length + ' 个任务进行中</b>' +
        '<span class="taskbar__item">当前：<b>' + Util.esc(head.title) + '</b> · ' +
          Util.esc(head.now) + '</span>' +
      '</div>' +
      '<a class="btn btn--sm" href="tasks.html">任务中心</a>' +
      '</div>';
  }

  /** 侧边导航「任务中心」的角标数字 */
  function paintNavBadges() {
    var n = Store.active().length;
    Util.$$('[data-task-badge]').forEach(function (b) {
      b.textContent = n;
      b.hidden = n === 0;
    });
  }

  /* --------------------------------------------------------------- Nav
     桌面端侧边导航统一由 JS 渲染，避免五个页面重复维护同一段结构。
     用法：<div data-sidenav="workbench"></div>
     ---------------------------------------------------------------------- */
  var NAV_ITEMS = [
    { key: 'workbench', href: 'workbench.html', label: '场景工作台', icon: 'grid', group: '工作' },
    { key: 'tasks',     href: 'tasks.html',     label: '任务中心',   icon: 'list', group: '工作', badge: true },
    { key: 'knowledge', href: 'knowledge.html', label: '知识资产',   icon: 'book', group: '资产' },
    { key: 'admin',     href: 'admin.html',     label: '管理后台',   icon: 'gear', group: '管理' }
  ];

  var ICONS = {
    grid: '<rect x="2.5" y="2.5" width="5" height="5" rx="1"/><rect x="8.5" y="2.5" width="5" height="5" rx="1"/><rect x="2.5" y="8.5" width="5" height="5" rx="1"/><rect x="8.5" y="8.5" width="5" height="5" rx="1"/>',
    list: '<path d="M3 4h10M3 8h10M3 12h7" stroke-linecap="round"/>',
    book: '<path d="M3 3h4.5a2 2 0 0 1 2 2v8a1.6 1.6 0 0 0-1.6-1.6H3z"/><path d="M13 3H8.5a2 2 0 0 0-2 2v8A1.6 1.6 0 0 1 8.1 11.4H13z"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" stroke-linecap="round"/>',
    chat: '<path d="M13.5 8.5a4.5 4.5 0 0 1-4.5 4.5H5.5L2.5 15v-2.8A4.5 4.5 0 0 1 2.5 8.5v-.5A4.5 4.5 0 0 1 7 3.5h2A4.5 4.5 0 0 1 13.5 8v.5z"/>'
  };
  function svg(name) {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" ' +
      'aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function renderSidenav(host) {
    var current = host.getAttribute('data-sidenav');
    var base = host.getAttribute('data-base') || '';       // 相对 desktop/ 目录的前缀
    var groups = [], seen = {};
    NAV_ITEMS.forEach(function (it) {
      if (!seen[it.group]) { seen[it.group] = []; groups.push(it.group); }
      seen[it.group].push(it);
    });

    var html = '' +
      '<a class="sidenav__brand" href="' + base + '../index.html">' +
        '<span class="sidenav__logo" aria-hidden="true">章</span>' +
        '<span><span class="sidenav__name">办公 Agent 平台</span>' +
        '<span class="sidenav__env">原型演示 · v0.9</span></span>' +
      '</a>' +
      '<button type="button" class="workspace-switch" data-ws-switch>' +
        '<span><strong>教务处</strong><span>江城理工大学 · 租户</span></span>' +
        '<span aria-hidden="true">⇄</span>' +
      '</button>';

    groups.forEach(function (g) {
      html += '<nav class="navgroup" aria-label="' + g + '"><div class="navgroup__title">' + g + '</div>';
      seen[g].forEach(function (it) {
        html += '<a class="navlink" href="' + base + it.href + '"' +
          (it.key === current ? ' aria-current="page"' : '') + '>' +
          svg(it.icon) + '<span>' + it.label + '</span>' +
          (it.badge ? '<span class="badge-count" data-task-badge hidden>0</span>' : '') +
          '</a>';
      });
      html += '</nav>';
    });

    html += '<div class="sidenav__foot"><div class="sidenav__user">' +
      '<span class="avatar" aria-hidden="true">刘</span>' +
      '<span><strong>刘敏</strong><span>工作区管理员</span></span>' +
      '</div></div>';

    host.className = 'sidenav';
    host.innerHTML = html;

    // 工作区切换：演示「切换工作区时会话与资产范围随之切换」的提示
    var sw = Util.$('[data-ws-switch]', host);
    if (sw) {
      var WS = [
        { name: '教务处', tenant: '江城理工大学 · 租户' },
        { name: '科研院', tenant: '江城理工大学 · 租户' },
        { name: '质量部', tenant: '宏元机械制造 · 租户' },
        { name: '工艺部', tenant: '宏元机械制造 · 租户' }
      ];
      var idx = 0;
      sw.addEventListener('click', function () {
        idx = (idx + 1) % WS.length;
        var w = WS[idx];
        sw.querySelector('strong').textContent = w.name;
        sw.querySelector('span span').textContent = w.tenant;
        Toast.show('已切换到工作区「' + w.name + '」',
          '会话、任务与知识资产范围已随之切换（跨租户数据不互通）', 'info');
      });
    }
  }

  /* ------------------------------------------------------------ 启动 */
  function init() {
    Theme.init();
    Modal.init();
    Store.load();
    // 其它标签页改写共享状态时刷新缓存，使本页读到的任务状态不停留在首次载入的快照
    global.addEventListener('storage', function (e) {
      if (e.key && e.key !== Store.KEY) return;
      Store.refresh();
      paintNavBadges();
      Util.$$('[data-taskbar]').forEach(renderTaskbar);
      Store.subs.forEach(function (fn) {
        try { fn(); } catch (err) { /* 单个订阅出错不影响其它订阅 */ }
      });
    });
    Util.$$('[data-sidenav]').forEach(renderSidenav);
    paintNavBadges();
    Util.$$('[data-taskbar]').forEach(renderTaskbar);
    // 演示数据重置入口
    Util.$$('[data-reset-demo]').forEach(function (b) {
      b.addEventListener('click', function () {
        Store.reset();
        Toast.show('演示数据已重置', '页面将重新加载', 'ok', 1500);
        setTimeout(function () { global.location.reload(); }, 800);
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* --------------------------------------------------------- 对外导出 */
  global.App = {
    Util: Util, Theme: Theme, Toast: Toast, Modal: Modal,
    Store: Store, Scenes: Scenes, Lease: Lease, Lock: Lock,
    STATUS: STATUS, statusTag: statusTag,
    INDUSTRY: INDUSTRY,
    svgIcon: svg,
    renderTaskbar: renderTaskbar, paintNavBadges: paintNavBadges
  };
})(window);
