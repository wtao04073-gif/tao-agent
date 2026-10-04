(function () {
	"use strict";
    // 管控端会话独立于普通成员前台，不覆盖前台登录身份。
    App.api = async function(method,path){
        var token=sessionStorage.getItem('tao.control.token')||'';
        var response=await fetch(path,{method:method,headers:token?{Authorization:'Bearer '+token}:{}});
        var data=await response.json().catch(function(){return {};});
        return {ok:response.ok,status:response.status,data:data};
    };
	var $ = function (id) { return document.getElementById(id); };
	var generation = 0;
	var denied = false;
	var dateText = function (date) {
		return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
	};
	var number = function (value) { return Number(value || 0).toLocaleString("zh-CN"); };
	var yuan = function (value) { return (Number(value || 0) / 1000000).toFixed(2); };

	function notice(id, message) {
		$(id).textContent = message || "";
		$(id).hidden = !message;
	}
	function deny(message) {
		denied = true;
		$("panel").hidden = true;
		notice("accessError", message);
	}
	function preset() {
		var end = new Date();
		var start = new Date(end.getFullYear(), end.getMonth(), 1);
		if ($("range").value === "week") {
			start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
		}
		if ($("range").value !== "custom") {
			$("from").value = dateText(start);
			$("to").value = dateText(end);
		}
	}
	function windowQuery() {
		var from = new Date($("from").value + "T00:00:00");
		var to = new Date($("to").value + "T00:00:00");
		if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
			throw new Error("请选择有效日期，开始日期不能晚于结束日期。");
		}
		// 接口采用左闭右开区间，包含结束日期的完整本地自然日。
		to.setDate(to.getDate() + 1);
		return "?" + new URLSearchParams({ from: String(from.getTime()), to: String(to.getTime()) }).toString();
	}
	function cell(row, text) {
		var td = document.createElement("td");
		td.textContent = text == null ? "" : String(text);
		row.appendChild(td);
		return td;
	}
	function emptyRow(host, span, text) {
		var row = document.createElement("tr");
		var td = cell(row, text);
		td.colSpan = span;
		td.className = "empty";
		host.appendChild(row);
	}
	function breakdown(id, rows, share) {
		var host = $(id);
		host.replaceChildren();
		if (!rows || !rows.length) { emptyRow(host, share ? 5 : 4, "所选时段暂无用量记录"); return; }
		rows.forEach(function (entry) {
			var row = document.createElement("tr");
			cell(row, entry.label || entry.key);
			cell(row, number(entry.totalTokens));
			cell(row, number(entry.taskCount));
			cell(row, yuan(entry.costMicroYuan));
			if (share) cell(row, Math.round(Number(entry.share || 0) * 100) + "%");
			host.appendChild(row);
		});
	}
	function usage(data) {
		var totals = data.totals || {};
		$("totalTokens").textContent = number(totals.totalTokens);
		$("taskCount").textContent = number(totals.taskCount);
		$("cost").textContent = "¥ " + yuan(data.costMicroYuan);
		$("tokenSplit").textContent = "输入 " + number(totals.inputTokens) + " / 输出 " + number(totals.outputTokens);
		$("period").textContent = data.period ? new Date(data.period.from).toLocaleDateString("zh-CN") + " — " + new Date(data.period.to - 1).toLocaleDateString("zh-CN") : "";
		notice("unpriced", (data.unpricedModels || []).length ? "以下模型尚未配置单价，费用未计入估算：" + data.unpricedModels.join("、") + "。当前金额统计不完整。" : "");
		var quota = $("quota");
		quota.replaceChildren();
		var limits = data.quota && data.quota.limits || [];
		if (!limits.length) {
			var text = document.createElement("p");
			text.className = "muted";
			text.textContent = "当前未配置配额上限。";
			quota.appendChild(text);
		}
		limits.forEach(function (limit) {
			var item = document.createElement("div");
			item.className = "quota-item" + (limit.ratio >= 1 ? " over" : "");
			var label = document.createElement("span");
			label.textContent = limit.label;
			var detail = document.createElement("span");
			detail.textContent = limit.usedText + " / " + limit.limitText;
			var bar = document.createElement("progress");
			bar.max = 1;
			bar.value = Math.max(0, Math.min(1, Number(limit.ratio) || 0));
			bar.setAttribute("aria-label", limit.label + "：" + detail.textContent);
			item.append(label, detail, bar);
			quota.appendChild(item);
		});
		breakdown("byUser", data.byUser, true);
		breakdown("byModel", data.byModel, false);
		$("usageData").hidden = false;
	}
	function audit(data) {
		var entries = (data.entries || []).slice().sort(function (a, b) { return b.at - a.at; });
		var host = $("auditRows");
		host.replaceChildren();
		$("auditCount").textContent = "共 " + number(entries.length) + " 条记录";
		if (!entries.length) emptyRow(host, 5, "所选时段暂无审计记录");
		var labels = { allowed: "允许", blocked: "已拦截", await_confirm: "待确认" };
		entries.forEach(function (entry) {
			var row = document.createElement("tr");
			cell(row, new Date(entry.at).toLocaleString("zh-CN"));
			cell(row, entry.userId);
			cell(row, entry.tool);
			var badge = document.createElement("span");
			badge.className = "decision" + (Object.prototype.hasOwnProperty.call(labels, entry.decision) ? " " + entry.decision : "");
			badge.textContent = labels[entry.decision] || entry.decision || "未知";
			cell(row, "").appendChild(badge);
			cell(row, entry.reason || "—");
			host.appendChild(row);
		});
		$("auditData").hidden = false;
	}
	async function refresh(event) {
		if (event) event.preventDefault();
		if (denied) return;
		var query;
		try { query = windowQuery(); } catch (error) { notice("filterError", error.message); return; }
		notice("filterError", "");
		var current = ++generation;
		$("refresh").disabled = true;
		$("updated").textContent = "正在加载…";
		$("usageData").hidden = true;
		$("auditData").hidden = true;
		$("period").textContent = "";
		$("auditCount").textContent = "";
		var successes = 0;
		await Promise.all([ ["usage", usage], ["audit", audit] ].map(async function (item) {
			var key = item[0];
			notice(key + "Error", "");
			try {
				var response = await App.api("GET", "/api/admin/" + key + query);
				if (current !== generation || denied) return;
				if (response.status === 401) { deny("登录已过期，请重新登录管理员账号。"); return; }
				if (response.status === 403) { deny("当前账号没有管控权限。请使用租户管理员或平台管理员账号登录。"); return; }
				if (!response.ok) {
					throw new Error(response.status === 501 ? "当前部署尚未启用此功能。" : response.data && response.data.error || "加载失败，请稍后重试。");
				}
				item[1](response.data);
				successes++;
			} catch (error) {
				if (current === generation && !denied) notice(key + "Error", error.message || "网络异常，请稍后刷新。");
			}
		}));
		if (current === generation) {
			$("refresh").disabled = false;
			$("updated").textContent = successes === 2 ? "已更新于 " + new Date().toLocaleTimeString("zh-CN") : successes ? "部分数据加载失败，可再次刷新" : "数据加载失败，可再次刷新";
		}
	}

	$("signOut").addEventListener("click", async function () { await fetch('/control/logout',{method:'POST'});sessionStorage.removeItem('tao.control.token');location.href='/control-login.html'; });
	$("filters").addEventListener("submit", refresh);
	$("range").addEventListener("change", preset);
	["from", "to"].forEach(function (id) { $(id).addEventListener("change", function () { $("range").value = "custom"; }); });
	document.querySelectorAll(".nav-link").forEach(function (link) {
		link.addEventListener("click", function () {
			document.querySelectorAll(".nav-link").forEach(function (item) { item.removeAttribute("aria-current"); });
			link.setAttribute("aria-current", "page");
		});
	});
	preset();
	App.api("GET", "/api/me").then(function (response) {
		if (!response.ok) { deny(response.status === 401 ? "请先登录管理员账号。" : "无法获取登录身份，请重新加载页面。"); return; }
		var me = response.data;
		var admin = me.role === "TENANT_ADMIN" || me.role === "PLATFORM_ADMIN";
		$("identity").textContent = (me.name || me.userId || "当前账号") + " · " + (me.role === "PLATFORM_ADMIN" ? "平台管理员" : admin ? "租户管理员" : "成员");
		if (!admin) { deny("当前账号没有管控权限。请联系租户管理员或平台管理员。"); return; }
		$("panel").hidden = false;
		refresh();
	}).catch(function () { deny("网络异常，暂时无法验证身份，请重新加载页面。"); });
})();
