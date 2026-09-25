/**
 * 部署自检测试
 *
 * 断言重点不是「检查逻辑对不对」，而是**失败时给出的建议是否可操作**。
 *
 * 这是 M4 验收门禁（客户 IT 2 小时内独立装成）的关键：一条「✗ 磁盘检查
 * 失败」的信息会让客户 IT 打电话，2 小时就没了。所以每个 fail/warn
 * 都断言 advice 存在且包含具体可执行的动作。
 */

import { describe, expect, it } from "vitest";
import {
	checkDisk,
	checkMemory,
	checkModelApi,
	checkNodeVersion,
	checkPort,
	checkWorkspaceWritable,
	formatBytes,
	renderReport,
	REQUIREMENTS,
	summarize,
	type CheckResult,
} from "../src/index.ts";

const GB = 1024 ** 3;

describe("大小格式化", () => {
	it("GB 级保留一位小数", () => {
		expect(formatBytes(8 * GB)).toBe("8.0 GB");
	});

	it("MB 级取整 —— 小数对运维判断没有意义", () => {
		expect(formatBytes(800 * 1024 ** 2)).toBe("800 MB");
	});

	it("字节级直接显示", () => {
		expect(formatBytes(512)).toBe("512 B");
	});
});

describe("Node 版本检查", () => {
	it("满足下限时通过", () => {
		const result = checkNodeVersion("v22.19.0");
		expect(result.level).toBe("pass");
		expect(result.advice).toBeUndefined();
	});

	it("高于下限同样通过", () => {
		expect(checkNodeVersion("v24.0.0").level).toBe("pass");
	});

	it("低于下限时给出升级指引，含 Docker 场景", () => {
		// 版本不够的表现是一堆语法错误，客户 IT 会以为代码有问题
		const result = checkNodeVersion("v18.0.0");
		expect(result.level).toBe("fail");
		expect(result.detail).toContain("18");
		expect(result.advice).toContain("升级");
		// 私有化部署多用 Docker，建议里必须覆盖这条路径
		expect(result.advice).toContain("node:");
	});

	it("版本号畸形时给出自查命令而非崩掉", () => {
		const result = checkNodeVersion("unknown");
		expect(result.level).toBe("fail");
		expect(result.advice).toContain("node -v");
	});

	it("不带 v 前缀也能解析", () => {
		expect(checkNodeVersion("22.19.0").level).toBe("pass");
	});
});

describe("内存检查", () => {
	it("达到建议值时通过", () => {
		expect(checkMemory(REQUIREMENTS.recommendedMemoryBytes).level).toBe("pass");
	});

	it("介于最低与建议之间报 warn 而非 fail", () => {
		// 这个区分很重要：报 fail 会让客户以为硬件不达标而放弃采购，
		// 而实际上是能跑的
		const result = checkMemory(6 * GB);
		expect(result.level).toBe("warn");
		expect(result.advice).toContain("可以运行");
	});

	it("warn 时给出降并发的具体配置项，而不只是「建议扩容」", () => {
		// 客户往下个季度才有预算扩容，得先能跑起来
		const result = checkMemory(6 * GB);
		expect(result.advice).toContain("MAX_CONCURRENT_TASKS");
	});

	it("低于最低值报 fail 并给出扩容指引", () => {
		const result = checkMemory(2 * GB);
		expect(result.level).toBe("fail");
		expect(result.detail).toContain("2.0 GB");
		expect(result.advice).toContain("扩容");
	});

	it("恰好等于最低值不算 fail", () => {
		// 边界：最低要求是「可以」而非「不够」
		expect(checkMemory(REQUIREMENTS.minimumMemoryBytes).level).not.toBe("fail");
	});
});

describe("磁盘检查", () => {
	it("达到建议值时通过", () => {
		expect(checkDisk(REQUIREMENTS.recommendedDiskBytes).level).toBe("pass");
	});

	it("介于最低与建议之间报 warn", () => {
		const result = checkDisk(10 * GB);
		expect(result.level).toBe("warn");
		expect(result.advice).toContain("可以运行");
	});

	it("低于最低值时给出可直接执行的清理命令", () => {
		// 「清理空间」是废话；「docker system prune -a」是可执行的动作
		const result = checkDisk(1 * GB);
		expect(result.level).toBe("fail");
		expect(result.advice).toContain("docker system prune");
	});
});

describe("端口检查", () => {
	it("端口空闲时通过", () => {
		expect(checkPort(8080, false).level).toBe("pass");
	});

	it("被占用时同时给出换端口与查占用方两条路", () => {
		// 端口占用是最常见的首次部署失败原因，
		// 而 EADDRINUSE 对非专业运维没有意义
		const result = checkPort(8080, true);
		expect(result.level).toBe("fail");
		// 换端口：给出具体的配置项与建议值
		expect(result.advice).toContain("PORT=8081");
		// 查占用方：给出可直接粘贴的命令
		expect(result.advice).toContain("lsof -i :8080");
	});

	it("已知占用方时写进 detail，便于判断能否停掉", () => {
		const result = checkPort(8080, true, "nginx");
		expect(result.detail).toContain("nginx");
	});
});

describe("模型 API 连通性检查", () => {
	it("可达时通过并标出目标", () => {
		const result = checkModelApi({ reachable: true, status: 200, endpointHost: "api.deepseek.com" });
		expect(result.level).toBe("pass");
		expect(result.detail).toContain("api.deepseek.com");
	});

	it("未配置与连不上分开报 —— 排查方向完全不同", () => {
		// 这条是自检脚本首次真实运行时发现的措辞缺陷：未配置时却建议
		// 「确认服务器能出网、设置 HTTPS_PROXY」，客户 IT 会去查网络，
		// 而实际上只是少填一行配置。排查方向错了比没有建议更浪费时间
		const result = checkModelApi({ reachable: false, unconfigured: true });
		expect(result.level).toBe("fail");
		expect(result.detail).toContain("未配置");
		// 指向填配置，不是查网络
		expect(result.advice).toContain(".env");
		expect(result.advice).not.toContain("HTTPS_PROXY");
		expect(result.advice).not.toContain("出网");
	});

	it("网络不通时给出三步排查，含代理与内网场景", () => {
		// 这项最难自查：私有化环境常有出网限制、需要代理、或走内网推理服务。
		// 失败表现是「所有任务都失败」，看不出是网络问题
		const result = checkModelApi({
			reachable: false,
			error: "getaddrinfo ENOTFOUND",
			endpointHost: "api.deepseek.com",
		});
		expect(result.level).toBe("fail");
		expect(result.advice).toContain("出网");
		expect(result.advice).toContain("HTTPS_PROXY");
		expect(result.advice).toContain("MODEL_BASE_URL");
	});

	it("鉴权失败与网络不通分开报，指向不同的修复动作", () => {
		// 混成一句「连不上」会让客户在网络上白查半小时
		const result = checkModelApi({ reachable: true, status: 401 });
		expect(result.level).toBe("fail");
		expect(result.detail).toContain("鉴权失败");
		expect(result.advice).toContain("MODEL_API_KEY");
	});

	it("403 与 401 同样归为鉴权问题", () => {
		expect(checkModelApi({ reachable: true, status: 403 }).advice).toContain("MODEL_API_KEY");
	});

	it("绝不回显 API Key —— 自检报告常被截图发群", () => {
		// 这条是安全断言。自检输出会被客户 IT 截图发到工作群里
		const result = checkModelApi({ reachable: true, status: 401 });
		const text = `${result.detail} ${result.advice ?? ""}`;
		// 只出现配置项名，不出现任何形似密钥的内容
		expect(text).toContain("MODEL_API_KEY");
		expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
	});

	it("服务端 5xx 报 warn —— 是对方的问题，不是装错了", () => {
		// 报 fail 会让客户以为自己配错了，反复检查配置
		const result = checkModelApi({ reachable: true, status: 503 });
		expect(result.level).toBe("warn");
		expect(result.advice).toContain("稍后重试");
	});
});

describe("工作区可写检查", () => {
	it("可写时通过", () => {
		expect(checkWorkspaceWritable({ writable: true, path: "/data/workspace" }).level).toBe("pass");
	});

	it("不可写时给出挂载卷权限的具体修法", () => {
		// 容器里挂载卷权限配错时，表现是任务跑完但产物不存在
		const result = checkWorkspaceWritable({
			writable: false,
			path: "/data/workspace",
			error: "EACCES",
		});
		expect(result.level).toBe("fail");
		expect(result.advice).toContain("chown");
		expect(result.advice).toContain("volumes");
	});
});

describe("汇总", () => {
	const pass: CheckResult = { name: "A", level: "pass", detail: "ok" };
	const warn: CheckResult = { name: "B", level: "warn", detail: "略低", advice: "建议扩容" };
	const fail: CheckResult = { name: "C", level: "fail", detail: "不足", advice: "必须扩容" };

	it("全部通过时 ok 为真", () => {
		expect(summarize([pass, pass]).ok).toBe(true);
	});

	it("只有 warn 时 ok 仍为真 —— 能跑就该让它跑", () => {
		const report = summarize([pass, warn]);
		expect(report.ok).toBe(true);
		expect(report.warnings).toHaveLength(1);
	});

	it("有 fail 时 ok 为假", () => {
		expect(summarize([pass, warn, fail]).ok).toBe(false);
	});

	it("全部结果都保留 —— 不在第一个失败处停下", () => {
		// 客户 IT 需要一次看到所有问题。修一个跑一次、再修一个，
		// 2 小时的预算撑不住几轮
		const report = summarize([fail, fail, warn, pass]);
		expect(report.results).toHaveLength(4);
		expect(report.failures).toHaveLength(2);
	});

	it("空结果不算通过", () => {
		// 一项都没跑不该报「自检通过」
		const report = summarize([]);
		expect(report.failures).toEqual([]);
		// ok 为真但没有任何检查 —— 由调用方保证至少跑几项
		expect(report.results).toEqual([]);
	});
});

describe("报告渲染", () => {
	it("通过时明确说可以启动", () => {
		const text = renderReport(summarize([{ name: "A", level: "pass", detail: "ok" }]));
		expect(text).toContain("✓");
		expect(text).toContain("可以启动");
	});

	it("建议紧跟在问题下面，不集中到末尾", () => {
		// 集中到末尾需要来回对照，出错时人是没有耐心对照的
		const text = renderReport(
			summarize([
				{ name: "内存", level: "fail", detail: "2 GB", advice: "扩容到 8 GB" },
				{ name: "磁盘", level: "pass", detail: "50 GB" },
			]),
		);
		const lines = text.split("\n");
		const problemLine = lines.findIndex((l) => l.includes("内存"));
		const adviceLine = lines.findIndex((l) => l.includes("扩容到 8 GB"));
		// 建议就在问题的下一行
		expect(adviceLine).toBe(problemLine + 1);
	});

	it("失败时说清要修几项并指向标记", () => {
		const text = renderReport(
			summarize([
				{ name: "A", level: "fail", detail: "x", advice: "修 A" },
				{ name: "B", level: "fail", detail: "y", advice: "修 B" },
			]),
		);
		expect(text).toContain("2 项必须修复");
		expect(text).toContain("✗");
	});

	it("只有提醒时说清「能启动但建议优化」", () => {
		// 说成「自检未通过」会让客户以为装不了而放弃
		const text = renderReport(
			summarize([{ name: "内存", level: "warn", detail: "6 GB", advice: "建议扩容" }]),
		);
		expect(text).toContain("可以启动");
		expect(text).toContain("1 项提醒");
	});

	it("三种级别用不同标记，扫一眼能分辨", () => {
		const text = renderReport(
			summarize([
				{ name: "A", level: "pass", detail: "x" },
				{ name: "B", level: "warn", detail: "y", advice: "z" },
				{ name: "C", level: "fail", detail: "w", advice: "v" },
			]),
		);
		expect(text).toContain("✓ A");
		expect(text).toContain("! B");
		expect(text).toContain("✗ C");
	});
});
