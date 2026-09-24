/**
 * 路径策略测试
 *
 * 这是安全代码，测试方式必须是**攻击性的** —— 不是验证「正常路径能通过」，
 * 而是穷举各种绕过手法，确认都被拦住。
 *
 * 一条纪律：这些用例对应[安全策略决策 2](../../../docs/security-policy.md)「凭据路径绝对禁止，
 * 不留配置口子」。任何让它们变宽松的改动都必须先改文档、再改代码。
 */

import { describe, expect, it } from "vitest";
import { checkPath, PATH_RULES } from "../src/path-policy.ts";

const WORKSPACE = "/workspace/task-1";

const allow = (p: string, granted: string[] = []) => checkPath(p, WORKSPACE, granted).allowed;
const verdict = (p: string, granted: string[] = []) => checkPath(p, WORKSPACE, granted);

describe("路径策略 · 正常放行", () => {
	it("工作区内的相对与绝对路径都放行", () => {
		expect(allow("input.xlsx")).toBe(true);
		expect(allow("./sub/dir/out.xlsx")).toBe(true);
		expect(allow(`${WORKSPACE}/report.docx`)).toBe(true);
		expect(allow(WORKSPACE)).toBe(true);
	});

	it("显式授权的目录放行", () => {
		expect(allow("/mnt/share/对账单.xlsx", ["/mnt/share"])).toBe(true);
		expect(allow("/mnt/share/2026/01/明细.xlsx", ["/mnt/share"])).toBe(true);
	});

	it("工作区内允许出现与内部目录同名的业务文件夹", () => {
		// 用户上传的资料里可能恰好有叫 sessions / vendor 的文件夹，
		// 不能因为名字撞了就拒绝 —— 那会让产品在真实数据上频繁误报。
		expect(allow(`${WORKSPACE}/vendor/供应商名录.xlsx`)).toBe(true);
		expect(allow(`${WORKSPACE}/sessions/会议记录.docx`)).toBe(true);
	});
});

describe("路径策略 · 系统路径必须拒绝", () => {
	it.each([
		"/etc/passwd",
		"/etc/shadow",
		"/proc/self/environ",
		"/sys/class/net",
		"/boot/grub/grub.cfg",
		"/dev/mem",
		"/root/.bashrc",
		"/var/run/docker.sock",
	])("拒绝 %s", (path) => {
		const result = verdict(path);
		expect(result.allowed).toBe(false);
		expect(result.rule).toBe("system");
	});
});

describe("路径策略 · 凭据必须拒绝（决策 2：绝对禁止）", () => {
	it.each([
		"/home/alice/.ssh/id_rsa",
		"/home/alice/.aws/credentials",
		"/home/alice/.kube/config",
		"/home/alice/.gnupg/secring.gpg",
		"/home/alice/.docker/config.json",
		"/home/alice/.config/gcloud/credentials.db",
	])("拒绝凭据目录 %s", (path) => {
		const result = verdict(path);
		expect(result.allowed).toBe(false);
		expect(result.rule).toBe("credential");
	});

	it.each([
		"server.pem",
		"private.key",
		"cert.p12",
		"bundle.pfx",
		"id_rsa",
		"id_rsa.pub",
		"id_ed25519",
		".env",
		".env.local",
		".env.production",
		"prod.env",
		".netrc",
		".npmrc",
		"credentials",
		"vault.kdbx",
	])("拒绝凭据文件 %s（即使在工作区内）", (name) => {
		// 关键：凭据文件在**工作区内**也必须拒绝。
		// 攻击路径是先让 Agent 把密钥拷进工作区，再读出来。
		const result = verdict(`${WORKSPACE}/${name}`);
		expect(result.allowed).toBe(false);
		expect(result.rule).toBe("credential");
	});

	it("授权目录也不能绕过凭据规则", () => {
		// 即使管理员授权了 /mnt/share，其中的凭据文件仍然禁止 ——
		// 这是「不留配置口子」的具体含义。
		expect(allow("/mnt/share/.ssh/id_rsa", ["/mnt/share"])).toBe(false);
		expect(allow("/mnt/share/deploy.pem", ["/mnt/share"])).toBe(false);
		expect(allow("/mnt/share/.env", ["/mnt/share"])).toBe(false);
	});
});

describe("路径策略 · 穿越与绕过手法", () => {
	it("拒绝 ../ 穿越到系统路径", () => {
		expect(allow("../../etc/passwd")).toBe(false);
		expect(allow("../../../../../../etc/shadow")).toBe(false);
		expect(allow("sub/../../../etc/passwd")).toBe(false);
	});

	it("规范化后命中黑名单仍然拒绝（穿越不能洗白）", () => {
		// /workspace/task-1/../../etc/passwd 规范化后是 /etc/passwd
		const result = verdict("../../etc/passwd");
		expect(result.allowed).toBe(false);
		// 归类为 system 而非 escape —— 命中黑名单优先，便于告警分级
		expect(result.rule).toBe("system");
	});

	it("拒绝穿越出工作区到无害但未授权的位置", () => {
		const result = verdict("../other-task/secret.xlsx");
		expect(result.allowed).toBe(false);
		expect(result.rule).toBe("escape");
	});

	it("拒绝未授权的绝对路径", () => {
		const result = verdict("/mnt/other/file.xlsx");
		expect(result.allowed).toBe(false);
		expect(result.rule).toBe("outside_workspace");
	});

	it("授权目录的前缀不能被误当成授权（/mnt/share ≠ /mnt/share-evil）", () => {
		// 朴素的 startsWith 会让 /mnt/share-evil 通过，这是真实的越权漏洞
		expect(allow("/mnt/share-evil/file.xlsx", ["/mnt/share"])).toBe(false);
	});

	it("工作区的前缀不能被误当成工作区内", () => {
		expect(allow("/workspace/task-10/file.xlsx")).toBe(false);
		expect(allow("/workspace/task-1-evil/file.xlsx")).toBe(false);
	});

	it("大小写变形不能绕过凭据文件规则", () => {
		expect(allow(`${WORKSPACE}/SERVER.PEM`)).toBe(false);
		expect(allow(`${WORKSPACE}/Private.Key`)).toBe(false);
		expect(allow(`${WORKSPACE}/ID_RSA`)).toBe(false);
	});

	it("产品自身路径在工作区外一律拒绝", () => {
		expect(verdict("/opt/tao-agent/vendor/pi/agent/src/index.ts").rule).toBe("self");
		expect(verdict("/opt/tao-agent/node_modules/evil/index.js").rule).toBe("self");
		expect(verdict("/opt/tao-agent/.git/config").rule).toBe("self");
	});

	it("审计与会话存储在工作区外一律拒绝（防篡改证据）", () => {
		expect(verdict("/var/tao/sessions/task-1.jsonl").rule).toBe("evidence");
		expect(verdict("/var/tao/audit/2026-09.log").rule).toBe("evidence");
	});
});

describe("路径策略 · 规则不可变（决策 2：不留配置口子）", () => {
	it("规则快照是冻结的", () => {
		expect(Object.isFrozen(PATH_RULES)).toBe(true);
	});

	it("拒绝时必须给出可读原因", () => {
		// 用户要能理解为什么被拒，否则只会反复重试或来投诉
		for (const path of ["/etc/passwd", "/home/a/.ssh/id_rsa", "../x", "/mnt/other/f"]) {
			const result = verdict(path);
			expect(result.allowed).toBe(false);
			expect(result.reason).toBeTruthy();
			expect(result.reason?.length).toBeGreaterThan(4);
		}
	});
});
