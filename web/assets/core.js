/* =============================================================================
 * 办公 Agent 平台 · Web 前端共享核心
 *
 * 与 prototype/ 的区别：这里不存任何演示数据，所有数据都来自同源后端 API。
 * 本文件只提供跨页面复用的基础设施：
 *   - 登录态（token / 身份）
 *   - API 封装（自动带 Bearer、统一错误、401 跳登录）
 *   - SSE 订阅（EventSource 无法自定义头，用 query token）
 *   - 领域映射（核心枚举 → 中文标签 / 样式类）
 *   - 主题、侧栏导航、Toast、Modal、DOM 工具
 *
 * 纯原生 JS、零外部依赖、零构建 —— 由 server 同源托管（见 M5-3）。
 * ========================================================================== */
(function (global) {
	"use strict";

	/* --------------------------------------------------------------- 常量 */

	var TOKEN_KEY = "tao.token";

	// 核心 TaskStatus 枚举（与 @tao/core task-status.ts 对应）→ 展示标签/配色。
	// 原型用的是小写自造状态；这里直接用后端真实枚举，避免再做一层易错的翻译。
	var STATUS = {
		QUEUED:        { label: "排队中",   cls: "tag--info", pulse: false },
		RUNNING:       { label: "执行中",   cls: "tag--run",  pulse: true },
		AWAIT_CONFIRM: { label: "等待确认", cls: "tag--warn", pulse: true },
		SUCCEEDED:     { label: "已完成",   cls: "tag--ok",   pulse: false },
		FAILED:        { label: "失败",     cls: "tag--err",  pulse: false },
		CANCELLED:     { label: "已取消",   cls: "",          pulse: false },
		EXCEEDED:       { label: "待确认是否继续", cls: "tag--warn", pulse: true },
		INTERRUPTED:   { label: "已中断（重启）", cls: "tag--err",  pulse: false },
	};

	// 后端场景卡 industry（university/manufacturing/general）→ 原型筛选器/徽标。
	var INDUSTRY = {
		university:   { key: "edu", label: "高校服务机构", cls: "ind--edu" },
		manufacturing:{ key: "mfg", label: "传统制造业",   cls: "ind--mfg" },
		general:      { key: "gen", label: "通用办公",     cls: "ind--gen" },
	};

	/* ------------------------------------------------------------- 登录态 */

	var Auth = {
		get token() { return localStorage.getItem(TOKEN_KEY) || ""; },
		set token(v) {
			if (v) localStorage.setItem(TOKEN_KEY, v);
			else localStorage.removeItem(TOKEN_KEY);
		},
		get signedIn() { return this.token !== ""; },
		signOut: function () {
			this.token = "";
			global.location.href = App._r("login.html");
		},
	};

	/* -------------------------------------------------------------- 工具 */

	function $(sel, root) { return (root || document).querySelector(sel); }
	function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
	function esc(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	}
	function ago(ts) {
		if (!ts) return "";
		var d = Date.now() - ts;
		if (d < 0) d = 0;
		var m = Math.floor(d / 60000);
		if (m < 1) return "刚刚";
		if (m < 60) return m + " 分钟前";
		var h = Math.floor(m / 60);
		if (h < 24) return h + " 小时前";
		var day = Math.floor(h / 24);
		if (day < 30) return day + " 天前";
		return new Date(ts).toLocaleDateString("zh-CN");
	}
	function fmtBytes(n) {
		if (n == null || isNaN(n)) return "";
		if (n < 1024) return n + " B";
		if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
		return (n / 1024 / 1024).toFixed(1) + " MB";
	}
	function fileIcon(name, small) {
		var ext = String(name).split(".").pop().toLowerCase();
		var map = { xlsx: "📊", xls: "📊", csv: "📊", docx: "📄", doc: "📄", pdf: "📕", pptx: "📽", txt: "📃" };
		var emoji = map[ext] || "📎";
		return '<span class="file-ic" aria-hidden="true">' + emoji + "</span>";
	}

	function statusTag(status) {
		var m = STATUS[status] || { label: status, cls: "" };
		return '<span class="tag ' + m.cls + '"><i class="dot' + (m.pulse ? " dot--pulse" : "") +
			'" aria-hidden="true"></i>' + esc(m.label) + "</span>";
	}
	function industryMeta(key) {
		return INDUSTRY[key] || { key: "gen", label: "通用办公", cls: "ind--gen" };
	}

	/* ----------------------------------------------------------- 路由基址 */
	// 页面分布在 /、/desktop/、/mobile/，资源与跳转用绝对路径最稳妥（同源托管）。
	var PATHS = {
		login: "/login.html",
		chat: "/chat.html",
		workbench: "/desktop/workbench.html",
		tasks: "/desktop/tasks.html",
		session: "/desktop/session.html",
		knowledge: "/desktop/knowledge.html",
		admin: "/desktop/admin.html",
		mobileTasks: "/mobile/tasks.html",
		mobileSession: "/mobile/session.html",
	};
	function route(name) { return PATHS[name] || name; }

	/* ---------------------------------------------------------------- API */

	/**
	 * 统一 fetch 封装。
	 * @returns {Promise<{ok:boolean,status:number,data:any}>}
	 * 401 时清 token 并跳登录页（除登录页自身调用外）。
	 */
	function api(method, path, body) {
		var init = {
			method: method,
			headers: { Accept: "application/json" },
		};
		if (Auth.token) init.headers.Authorization = "Bearer " + Auth.token;
		if (body !== undefined) {
			init.headers["Content-Type"] = "application/json; charset=utf-8";
			init.body = JSON.stringify(body);
		}
		return fetch(path, init).then(function (res) {
			var ct = res.headers.get("content-type") || "";
			var asJson = ct.indexOf("application/json") >= 0 ? res.json().catch(function () { return {}; }) : Promise.resolve({});
			return asJson.then(function (data) {
				if (res.status === 401 && !/login\.html$/.test(global.location.pathname)) {
					Auth.token = "";
					var next = encodeURIComponent(global.location.pathname + global.location.search);
					global.location.href = route("login") + "?next=" + next;
					return { ok: false, status: 401, data: data };
				}
				return { ok: res.ok, status: res.status, data: data };
			});
		});
	}

	/** multipart 文件上传；返回 {ok,status,data}。 */
	function upload(path, file, fieldName) {
		var fd = new FormData();
		fd.append(fieldName || "file", file);
		return fetch(path, {
			method: "POST",
			headers: Auth.token ? { Authorization: "Bearer " + Auth.token } : {},
			body: fd,
		}).then(function (res) {
			return res.json().catch(function () { return {}; }).then(function (data) {
				return { ok: res.ok, status: res.status, data: data };
			});
		});
	}

	/**
	 * 订阅任务事件（SSE）。
	 *
	 * EventSource 不能自定义 Authorization 头，但长期 Bearer 令牌绝不能放进 URL
	 * （会进访问日志 / 历史 / Referer）。因此先带 Bearer 调 POST /api/events/ticket
	 * 换一张短时、一次性的票据，再用 ?ticket= 建立 EventSource。
	 *
	 * 票据只在「建立连接那一下」被服务端消耗；连接建立后靠心跳保活。断线或
	 * 401 后 EventSource 不会再用旧票（旧票已作废），这里关闭它、重新换票再连。
	 * 返回带 close() 的句柄。onEvent 收解析后的事件对象；onOpen/onError 可选。
	 */
	// 轮询兜底间隔。SSE 直连可用时近乎实时；反代/隧道缓冲 SSE 时由轮询保证必达。
	var EVENT_POLL_MS = 2000;

	function subscribe(taskId, handlers) {
		var es = null;
		var closed = false;
		var retryTimer = null;
		var pollTimer = null;
		// 事件按 seq 单调，中心去重：SSE 与轮询可能投递同一条，对外只发一次。
		var seenSeq = Object.create(null);
		var lastSeq = 0;

		function ticketEndpoint() {
			return "/api/events/ticket" + (taskId ? "?taskId=" + encodeURIComponent(taskId) : "");
		}

		// 两个来源（SSE / 轮询）统一经此下发，按 seq 去重并推进水位。
		function deliver(data) {
			// 瞬时流式帧 seq=0：不参与去重/水位，直接透传给打字机渲染。
			if (data && data.type === "assistant_delta") {
				if (handlers.onEvent) handlers.onEvent(data, undefined);
				return;
			}
			if (data && typeof data.seq === "number") {
				if (seenSeq[data.seq]) return;
				seenSeq[data.seq] = true;
				if (data.seq > lastSeq) lastSeq = data.seq;
			}
			if (handlers.onEvent) handlers.onEvent(data, data && data.seq != null ? String(data.seq) : undefined);
		}

		/**
		 * 轮询兜底：GET 事件历史是普通 JSON 响应，任何反代/隧道都不会缓冲它。
		 * 当 SSE 被 CDN/隧道缓冲（表现为长时间无帧）时，进度与结果仍由轮询送达。
		 * 仅在订阅具体任务时可用（全工作区订阅无对应 REST 端点）。
		 */
		function pollOnce() {
			if (closed || !taskId) return;
			api("GET", "/api/tasks/" + encodeURIComponent(taskId) + "/events?afterSeq=" + lastSeq)
				.then(function (r) {
					if (closed || !r.ok || !r.data || !Array.isArray(r.data.events)) return;
					r.data.events.forEach(deliver);
					if (r.data.events.length && handlers.onOpen) handlers.onOpen();
				})
				.catch(function () { /* 静默，下一轮继续；401 已由 api() 统一处理 */ })
				.finally(function () {
					if (!closed && taskId) pollTimer = setTimeout(pollOnce, EVENT_POLL_MS);
				});
		}

		function connect() {
			if (closed) return;
			api("POST", ticketEndpoint(), {}).then(function (r) {
				if (closed) return;
				if (!r.ok || !r.data || !r.data.ticket) {
					// 换票失败（多半是登录过期，api 已处理 401 跳转）：退避后再试
					if (handlers.onError) handlers.onError();
					scheduleReconnect();
					return;
				}
				var q = "?ticket=" + encodeURIComponent(r.data.ticket);
				if (taskId) q += "&taskId=" + encodeURIComponent(taskId);
				es = new EventSource("/api/events" + q, { withCredentials: false });
				var types = ["status", "step", "tool_decision", "artifact",
					"assistant_message", "assistant_delta", "user_message", "usage"];
				types.forEach(function (t) {
					es.addEventListener(t, function (ev) {
						var data;
						try { data = JSON.parse(ev.data); } catch (e) { return; }
						deliver(data);
					});
				});
				es.onopen = function () { if (handlers.onOpen) handlers.onOpen(); };
				es.onerror = function (e) {
					// 连接断开后旧票已一次性作废，浏览器持旧 URL 重连只会 401。
					// 主动关闭并由我们重新换票、重建连接。
					if (handlers.onError) handlers.onError(e);
					if (es) { try { es.close(); } catch (ignored) {} es = null; }
					scheduleReconnect();
				};
			});
		}

		function scheduleReconnect() {
			if (closed || retryTimer !== null) return;
			retryTimer = setTimeout(function () {
				retryTimer = null;
				connect();
			}, 2000);
		}

		connect();
		// 订阅具体任务时立即开始轮询兜底（也负责打开历史任务时拉回全量 backlog）。
		if (taskId) pollOnce();
		return {
			close: function () {
				closed = true;
				if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
				if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
				if (es) { try { es.close(); } catch (e) {} es = null; }
			},
		};
	}

	/**
	 * 先带 Bearer 换一次性下载票据，再用票据触发浏览器下载。
	 * 长期令牌不出现在 URL 上；票据服务端校验用途 / 资源且用后即废。
	 *
	 * @param ticketPath 换票接口（POST，Bearer 鉴权）
	 * @param downloadPath 实际下载 GET 路径（不含 query）
	 */
	function ticketedDownload(ticketPath, downloadPath) {
		return api("POST", ticketPath, {}).then(function (r) {
			if (!r.ok || !r.data || !r.data.ticket) {
				Toast.show("下载失败", (r.data && r.data.error) || "请稍后重试", "err");
				return;
			}
			var sep = downloadPath.indexOf("?") >= 0 ? "&" : "?";
			// 用隐藏的临时链接触发导航下载，避免当前页留下带票据的地址
			var a = document.createElement("a");
			a.href = downloadPath + sep + "ticket=" + encodeURIComponent(r.data.ticket);
			a.rel = "noopener";
			document.body.appendChild(a);
			a.click();
			a.remove();
		});
	}

	/** 下载某任务的产物（点击触发，先换票再下载）。 */
	function downloadArtifact(taskId, name) {
		var base = "/api/tasks/" + encodeURIComponent(taskId) +
			"/artifacts/" + encodeURIComponent(name);
		return ticketedDownload(base + "/ticket", base);
	}

	/** 下载资料库文件（点击触发，先换票再下载）。 */
	function downloadFile(name) {
		var base = "/api/files/" + encodeURIComponent(name);
		return ticketedDownload(base + "/ticket", base);
	}

	/* --------------------------------------------------------------- 主题 */

	var Theme = {
		KEY: "tao.theme",
		init: function () {
			var saved = localStorage.getItem(this.KEY);
			var dark = saved ? saved === "dark" : global.matchMedia &&
				global.matchMedia("(prefers-color-scheme: dark)").matches;
			this.apply(dark);
			$$("[data-theme-toggle]").forEach(function (b) {
				b.addEventListener("click", function () { Theme.toggle(); });
			});
		},
		apply: function (dark) {
			document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
			$$("[data-theme-toggle]").forEach(function (b) { b.textContent = dark ? "☀" : "☾"; });
		},
		toggle: function () {
			var dark = document.documentElement.getAttribute("data-theme") !== "dark";
			this.apply(dark);
			localStorage.setItem(this.KEY, dark ? "dark" : "light");
		},
	};

	/* --------------------------------------------------------------- Toast */

	var Toast = {
		timers: {},
		show: function (title, body, kind, ttl) {
			var host = $("#toastHost");
			if (!host) {
				host = document.createElement("div");
				host.id = "toastHost";
				host.className = "toast-host";
				document.body.appendChild(host);
			}
			var el = document.createElement("div");
			el.className = "toast toast--" + (kind || "info");
			el.innerHTML = '<div class="toast__t">' + esc(title) + "</div>" +
				(body ? '<div class="toast__b">' + esc(body) + "</div>" : "");
			host.appendChild(el);
			setTimeout(function () {
				el.classList.add("toast--out");
				setTimeout(function () { el.remove(); }, 300);
			}, ttl || 3500);
		},
	};

	/* --------------------------------------------------------------- Modal */

	var Modal = {
		init: function () {
			$$("[data-modal-close]").forEach(function (b) {
				b.addEventListener("click", function () { Modal.close(b.closest(".modal-mask")); });
			});
		},
		open: function (id) {
			var m = document.getElementById(id);
			if (m) m.hidden = false;
		},
		close: function (m) {
			if (m) m.hidden = true;
			else $$(".modal-mask").forEach(function (x) { x.hidden = true; });
		},
	};

	/* ----------------------------------------------------------- 侧栏导航 */

	var NAV_ITEMS = [
		{ key: "chat", href: PATHS.chat, label: "对话", icon: "chat", group: "工作" },
		{ key: "workbench", href: PATHS.workbench, label: "场景工作台", icon: "grid", group: "工作" },
		{ key: "tasks", href: PATHS.tasks, label: "任务中心", icon: "list", group: "工作", badge: true },
		{ key: "knowledge", href: PATHS.knowledge, label: "知识资产", icon: "book", group: "资产" },
		{ key: "admin", href: PATHS.admin, label: "管理后台", icon: "gear", group: "管理", admin: true },
	];
	var ICONS = {
		chat: '<path d="M2.8 5.5A1.7 1.7 0 0 1 4.5 3.8h7a1.7 1.7 0 0 1 1.7 1.7v4.2a1.7 1.7 0 0 1-1.7 1.7H7l-2.7 2v-2H4.5a1.7 1.7 0 0 1-1.7-1.7z"/>',
		grid: '<rect x="2.5" y="2.5" width="5" height="5" rx="1"/><rect x="8.5" y="2.5" width="5" height="5" rx="1"/><rect x="2.5" y="8.5" width="5" height="5" rx="1"/><rect x="8.5" y="8.5" width="5" height="5" rx="1"/>',
		list: '<path d="M3 4h10M3 8h10M3 12h7" stroke-linecap="round"/>',
		book: '<path d="M3 3h4.5a2 2 0 0 1 2 2v8a1.6 1.6 0 0 0-1.6-1.6H3z"/><path d="M13 3H8.5a2 2 0 0 0-2 2v8A1.6 1.6 0 0 1 8.1 11.4H13z"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" stroke-linecap="round"/>',
	};
	function svg(name) {
		return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" ' +
			'aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
	}

	/**
	 * 渲染侧栏。me 为身份信息 {name, roleLabel, tenantName, workspaceName}，
	 * 非管理员隐藏「管理后台」入口（后端仍会 403，这里只是不展示）。
	 */
	function renderSidenav(currentKey, me) {
		me = me || {};
		var isAdmin = me.role === "TENANT_ADMIN" || me.role === "PLATFORM_ADMIN";
		var host = $('[data-sidenav="' + currentKey + '"]');
		if (!host) return;
		var groups = [], seen = {};
		NAV_ITEMS.forEach(function (it) {
			if (it.admin && !isAdmin) return;
			if (!seen[it.group]) { seen[it.group] = []; groups.push(it.group); }
			seen[it.group].push(it);
		});

		var html = '<a class="sidenav__brand" href="' + PATHS.chat + '">' +
			'<span class="sidenav__logo" aria-hidden="true">章</span>' +
			'<span><span class="sidenav__name">办公 Agent 平台</span>' +
			'<span class="sidenav__env">私有化部署</span></span></a>';

		groups.forEach(function (g) {
			html += '<nav class="navgroup" aria-label="' + g + '"><div class="navgroup__title">' + g + "</div>";
			seen[g].forEach(function (it) {
				html += '<a class="navlink" href="' + it.href + '"' +
					(it.key === currentKey ? ' aria-current="page"' : "") + ">" +
					svg(it.icon) + "<span>" + it.label + "</span>" +
					(it.badge ? '<span class="badge-count" data-task-badge hidden>0</span>' : "") + "</a>";
			});
			html += "</nav>";
		});

		var initial = (me.name || me.userId || "用").slice(0, 1);
		html += '<div class="sidenav__foot"><div class="sidenav__user">' +
			'<span class="avatar" aria-hidden="true">' + esc(initial) + "</span>" +
			"<span><strong>" + esc(me.name || me.userId || "用户") + "</strong>" +
			"<span>" + esc(me.roleLabel || (isAdmin ? "租户管理员" : "成员")) + " · " +
			esc(me.workspaceName || me.workspaceId || "") + "</span></span>" +
			'<button class="iconbtn" id="signOutBtn" type="button" title="退出登录">⎋</button></div></div>';

		host.className = "sidenav";
		host.innerHTML = html;
		var out = $("#signOutBtn", host);
		if (out) out.addEventListener("click", function () { Auth.signOut(); });
	}

	/* ----------------------------------------------------------- 通用引导 */

	/** 所有需要登录的页面启动时调用：未登录跳登录页，返回身份信息。 */
	function bootstrap(currentKey) {
		if (!Auth.signedIn) {
			var next = encodeURIComponent(global.location.pathname + global.location.search);
			global.location.href = route("login") + "?next=" + next;
			return Promise.resolve(null);
		}
		Theme.init();
		Modal.init();
		return api("GET", "/api/me").then(function (r) {
			var me = r.ok ? r.data : null;
			renderSidenav(currentKey, me || {});
			return me;
		});
	}

	/* ----------------------------------------------------- 下载点击代理 */
	// 页面只渲染带 data-ticket-download 的锚点（不在 href 里暴露任何令牌），
	// 点击时才去换票并触发下载。统一在 document 上委托一次，列表重渲染无需重绑。
	function bindTicketDownloadClicks() {
		document.addEventListener("click", function (e) {
			var node = e.target;
			if (!node || typeof node.closest !== "function") return;
			var el = node.closest("[data-ticket-download]");
			if (!el) return;
			e.preventDefault();
			var kind = el.getAttribute("data-ticket-download");
			var name = el.getAttribute("data-name") || "";
			if (kind === "artifact") {
				downloadArtifact(el.getAttribute("data-task") || "", name);
			} else if (kind === "file") {
				downloadFile(name);
			}
		});
	}
	bindTicketDownloadClicks();

	/* --------------------------------------------------------------- 导出 */

	global.App = {
		_r: route,
		Auth: Auth,
		api: api,
		upload: upload,
		subscribe: subscribe,
		ticketedDownload: ticketedDownload,
		downloadArtifact: downloadArtifact,
		downloadFile: downloadFile,
		Theme: Theme,
		Toast: Toast,
		Modal: Modal,
		STATUS: STATUS,
		INDUSTRY: INDUSTRY,
		statusTag: statusTag,
		industryMeta: industryMeta,
		renderSidenav: renderSidenav,
		bootstrap: bootstrap,
		$: $, $$: $$, esc: esc, ago: ago, fmtBytes: fmtBytes, fileIcon: fileIcon, svgIcon: svg,
	};
})(window);
