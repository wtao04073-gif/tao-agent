/* =============================================================================
 * 场景卡动态表单
 *
 * 表单字段完全由后端 ScenarioCard.fields 描述驱动（text/textarea/number/select/
 * multiselect/file/filelist/date/boolean），前端不硬编码任何场景字段。
 * 文件字段先上传换工作区绝对路径，再把路径作为字段值提交 —— 工具消费的是路径。
 * ========================================================================== */
(function (global) {
	"use strict";
	var $ = function (s, r) { return (r || document).querySelector(s); };

	function fieldElId(name) { return "fld-" + name; }

	/** 渲染单个字段为 HTML 字符串。 */
	function renderField(f) {
		var id = fieldElId(f.name);
		var label =
			'<label for="' + id + '">' + App.esc(f.label) +
			(f.required ? ' <span style="color:var(--err-fg)">*</span>' : "") + "</label>";
		var hint = f.hint ? '<p class="hint" style="margin:2px 0 0;font-size:var(--fs-12)">' + App.esc(f.hint) + "</p>" : "";
		var ctrl;
		var attrs = 'id="' + id + '" data-name="' + App.esc(f.name) + '" data-type="' + f.type + '"' +
			(f.required ? " required" : "") +
			(f.accept && f.accept.length ? ' accept="' + f.accept.map(encodeURIComponent).join(",") + '"' : "");

		switch (f.type) {
			case "textarea":
				ctrl = '<textarea ' + attrs + ' rows="3" placeholder="' + App.esc(f.hint || "") + '"></textarea>';
				break;
			case "number":
				ctrl = '<input type="number" ' + attrs +
					(f.min !== undefined ? ' min="' + f.min + '"' : "") +
					(f.max !== undefined ? ' max="' + f.max + '"' : "") + ">";
				break;
			case "select":
				ctrl = '<select ' + attrs + "><option value=''>请选择…</option>" +
					(f.options || []).map(function (o) {
						return '<option value="' + App.esc(o.value) + '">' + App.esc(o.label) + "</option>";
					}).join("") + "</select>";
				break;
			case "multiselect":
				ctrl = '<div class="check" data-type="multiselect" data-name="' + App.esc(f.name) + '">' +
					(f.options || []).map(function (o) {
						return '<label style="display:flex;gap:6px;align-items:center;margin:2px 0">' +
							'<input type="checkbox" value="' + App.esc(o.value) + '"> ' + App.esc(o.label) + "</label>";
					}).join("") + "</div>";
				break;
			case "boolean":
				ctrl = '<label style="display:flex;gap:8px;align-items:center">' +
					'<input type="checkbox" id="' + id + '" data-name="' + App.esc(f.name) + '" data-type="boolean"> ' +
					"是</label>";
				return '<div class="field">' + ctrl + hint + "</div>";
			case "file":
			case "filelist": {
				var multi = f.type === "filelist";
				ctrl =
					'<div class="file-field" data-name="' + App.esc(f.name) + '" data-multi="' + multi + '">' +
					'<input type="file" ' + attrs + (multi ? " multiple" : "") + ">" +
					'<div class="file-field__list" style="margin-top:6px;display:grid;gap:4px"></div></div>';
				break;
			}
			case "date":
				ctrl = '<input type="date" ' + attrs + ">";
				break;
			default:
				ctrl = '<input type="text" ' + attrs + ">";
		}
		return '<div class="field">' + label + ctrl + hint + "</div>";
	}

	/** 绑定上传：文件选中即上传，成功后保存路径、显示文件名与状态。 */
	function bindUploads(root) {
		$$(".file-field", root).forEach(function (box) {
			var name = box.getAttribute("data-name");
			var multi = box.getAttribute("data-multi") === "true";
			var input = $("input[type=file]", box);
			var list = $(".file-field__list", box);
			var paths = [];
			// 单调递增的「选择版本号」：仅单文件字段使用 —— 重选时令在途旧结果过期，
			// 防止旧上传晚于新选择 resolve 时把旧路径回写进 paths
			// （单文件重选会出现界面是新文件、提交却是旧路径）。
			// filelist 的语义是跨选择累加，各批次结果独立回写，绝不按序号丢弃。
			var chooseSeq = 0;

			input.addEventListener("change", async function () {
				var files = Array.prototype.slice.call(input.files || []);
				if (!files.length) return;
				// 序号仅用于单文件「替换」语义；filelist 是跨批次累加，不占版本号。
				var mySeq = multi ? 0 : ++chooseSeq;
				// 单文件原地清空（paths.length = 0），不可重绑 paths = []，
				// 否则 box._paths 仍指向旧数组、collect 会读到上一次的路径。
				if (!multi) { paths.length = 0; list.innerHTML = ""; }
				for (const file of files) {
					const row = document.createElement("div");
					row.className = "artifact-row";
					row.innerHTML = App.fileIcon(file.name) +
						'<span class="artifact-row__name">' + App.esc(file.name) + "</span>" +
						'<span class="artifact-row__size">上传中…</span>';
					list.appendChild(row);
					const r = await App.upload("/api/files", file, "file");
					// 仅单文件：已被更新的选择取代时丢弃迟到结果，不写 paths、移除 UI 行。
					// filelist 各批次独立累加，旧批次迟到结果仍须正常回写，避免丢文件与孤儿上传。
					if (!multi && mySeq !== chooseSeq) { row.remove(); continue; }
					const status = $(".artifact-row__size", row);
					if (r.ok) {
						paths.push(r.data.path);
						status.textContent = App.fmtBytes(r.data.sizeBytes) + " ✓";
						status.style.color = "var(--ok-fg)";
					} else {
						status.textContent = "上传失败";
						status.style.color = "var(--err-fg)";
						App.Toast.show("上传失败", r.data.error || file.name, "err");
						row.remove();
					}
				}
				// 单文件仅最新一批选择结束后复位 input；filelist 每批结束即可复位以便继续选择
				if (multi || mySeq === chooseSeq) input.value = "";
			});

			box._paths = paths;
		});
	}

	function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

	/**
	 * 收集表单值并做必填校验。
	 * @returns {{ok:true, values:Record<string,unknown>} | {ok:false, errors:string[]}}
	 */
	function collect(root) {
		var values = {};
		var errors = [];
		// 非空但无法解析为数字的字段名集合（遍历阶段判定，定义循环里统一报错）
		var badNumber = {};

		$$("[data-name]", root).forEach(function (el) {
			var name = el.getAttribute("data-name");
			var type = el.getAttribute("data-type");

			if (type === "multiselect") {
				var picked = $$("input[type=checkbox]:checked", el).map(function (c) { return c.value; });
				if (picked.length) values[name] = picked;
				return;
			}
			if (type === "boolean") {
				values[name] = !!el.checked;
				return;
			}
			if (type === "file" || type === "filelist") {
				var ps = el._paths || [];
				if (ps.length) values[name] = type === "filelist" ? ps : ps[0];
				return;
			}
			var v = el.value;
			if (type === "number") {
				// type=number 遇到无法表示的文本时，DOM value 会回退为空字符串，
				// 真实状态由 validity.badInput 标识；必须先看 badInput，
				// 否则非法输入会被当成可选空值静默提交、绕过必填与范围校验。
				if (el.validity && el.validity.badInput) {
					badNumber[name] = true;
				} else if (v.trim() !== "") {
					// 仅 trim 后真正为空（且非 badInput）才按未填处理；
					// 非空但解析失败记为格式错误，不能静默丢弃。
					var n = Number(v);
					if (Number.isFinite(n)) values[name] = n;
					else badNumber[name] = true;
				}
				return;
			}
			if (v.trim() !== "") values[name] = v.trim();
		});

		// 必填与数字范围校验由卡片字段定义驱动
		(root._fields || []).forEach(function (f) {
			var v = values[f.name];
			var filled = v !== undefined && v !== "" && (!Array.isArray(v) || v.length > 0);
			var invalid = false;
			if (f.type === "number" && badNumber[f.name]) {
				// 非法数字只报格式错误，不再叠加必填缺失
				errors.push("「" + f.label + "」请填写有效数字");
				invalid = true;
			} else if (f.required && !filled) {
				errors.push("请填写「" + f.label + "」");
				invalid = true;
			} else if (f.type === "number" && filled) {
				// 数字范围校验：仅对已解析出的合法数字做，留空不校验范围
				if (f.min !== undefined && v < f.min) {
					errors.push("「" + f.label + "」不能小于 " + f.min);
					invalid = true;
				} else if (f.max !== undefined && v > f.max) {
					errors.push("「" + f.label + "」不能大于 " + f.max);
					invalid = true;
				}
			}
			if (f.required || f.type === "number") {
				var el = document.getElementById(fieldElId(f.name));
				if (el) el.setAttribute("aria-invalid", invalid ? "true" : "false");
			}
		});

		return errors.length ? { ok: false, errors: errors } : { ok: true, values: values };
	}

	global.ScenarioForms = { renderField: renderField, bindUploads: bindUploads, collect: collect };
})(window);
