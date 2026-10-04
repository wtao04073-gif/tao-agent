import * as XLSX from "xlsx";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Role, type TenantContext } from "@tao/core";
import { createWorkspaceServices, previewFile, workspaceFile, MAX_PREVIEW_BYTES } from "../src/workspace-services.ts";
import { createWorkspaceHandler } from "../src/workspace-api.ts";
import { BlockType, writeDocx } from "@tao/office";
import ExcelJS from "exceljs";

const tenant: TenantContext = { tenantId: "school", workspaceId: "office", userId: "alice" };
const roots: string[] = [];
const servers: Server[] = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "tao-workspace-"));
	roots.push(root);
	const dir = join(root, tenant.tenantId, tenant.workspaceId);
	mkdirSync(dir, { recursive: true });
	return { root, dir, services: createWorkspaceServices({ workspaceRoot: root }) };
}
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("持久工作区知识库", () => {
	it("重建服务后仍可检索，且跨工作区与跨租户不可见", async () => {
		const { root, services } = setup();
		await services.ingestKnowledge(tenant, { name: "实验室制度", text: "# 安全要求\n实验室应每日开展安全巡检。" });
		const restarted = createWorkspaceServices({ workspaceRoot: root });
		expect(restarted.listKnowledge(tenant)).toHaveLength(1);
		expect(await restarted.searchKnowledge(tenant, "安全巡检")).toHaveLength(1);
		for (const other of [{ ...tenant, workspaceId: "other" }, { ...tenant, tenantId: "other" }]) {
			expect(restarted.listKnowledge(other)).toEqual([]);
			expect(await restarted.searchKnowledge(other, "安全巡检")).toEqual([]);
		}
	});
	it("检索工具实时看到新入库内容且不信任模型提供的租户", async () => {
		const { services } = setup();
		const tool = services.createKnowledgeTool(tenant);
		const input = { args: { query: "巡检", tenantId: "other" }, tenant: { ...tenant, tenantId: "other" }, taskId: "task-test", report: () => {}, signal: new AbortController().signal };
		expect((await tool.execute(input)).text).toContain("未找到");
		await services.ingestKnowledge(tenant, { name: "巡检要求", text: "巡检应每日完成" });
		expect((await tool.execute(input)).text).toContain("巡检应每日完成");
	});
	it("入库来自上传文件；重复入库更新旧文档，删除只影响本工作区", async () => {
		const { dir, services } = setup();
		writeFileSync(join(dir, "制度.md"), "安全巡检制度");
		const first = await services.ingestKnowledge(tenant, { fileName: "制度.md" });
		writeFileSync(join(dir, "制度.md"), "设备维护制度");
		const updated = await services.ingestKnowledge(tenant, { fileName: "制度.md" });
		expect(updated.documentId).toBe(first.documentId);
		expect(services.listKnowledge(tenant)).toHaveLength(1);
		expect(services.deleteKnowledge({ ...tenant, workspaceId: "other" }, first.documentId)).toBe(false);
		expect(() => services.deleteKnowledge({ ...tenant, userId: "bob" }, first.documentId)).toThrow("只有创建者");
		expect(services.deleteKnowledge(tenant, first.documentId)).toBe(true);
		expect(await services.searchKnowledge(tenant, "设备")).toEqual([]);
	});
	it("拒绝路径穿越、资料符号链接和工作区符号链接", async () => {
		const { root, dir, services } = setup();
		writeFileSync(join(root, "secret.txt"), "不可读取");
		symlinkSync(join(root, "secret.txt"), join(dir, "linked.txt"));
		expect(() => workspaceFile(root, tenant, "../secret.txt")).toThrow();
		expect(() => workspaceFile(root, tenant, "linked.txt")).toThrow();
		await expect(services.ingestKnowledge(tenant, { fileName: "linked.txt" })).rejects.toThrow();
		symlinkSync(dir, join(root, "school", "linked"));
		expect(() => services.listKnowledge({ ...tenant, workspaceId: "linked" })).toThrow();
	});
});

describe("文件预览", () => {
    it("旧版XLS预览和多工作表知识入库保留第二张表", async () => {
        const { dir, services } = setup();
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["评估项", "结果"], ["权限管理", "通过"]]), "评估");
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["要求"], ["保密审计追踪必须留存"]]), "补充要求");
        writeFileSync(join(dir,"评估.xls"), XLSX.write(book, {type:"buffer",bookType:"biff8"}));
        expect(await previewFile(dir,join(dir,"评估.xls"),"评估.xls")).toMatchObject({kind:"sheet",rows:[{"评估项":"权限管理","结果":"通过"}]});
        await services.ingestKnowledge(tenant,{fileName:"评估.xls"});
        expect((await services.searchKnowledge(tenant,"保密审计追踪")).length).toBeGreaterThan(0);
    });
	it("DOCX 抽取正文，XLSX 抽取表格，均可入库检索", async () => {
		const { dir, services } = setup();
		await writeDocx({ title: "设备制度", blocks: [{ type: BlockType.Paragraph, text: "设备维护应每周执行" }] }, { workspace: dir, outputName: "制度.docx" });
		const doc = await previewFile(dir, join(dir, "制度.docx"), "制度.docx");
		expect(doc).toMatchObject({ kind: "text" });
		if (doc.kind === "text") expect(doc.text).toContain("设备维护");
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet("台账");
		sheet.addRow(["设备", "状态"]);
		sheet.addRow(["冲压机", "待维护"]);
		await workbook.xlsx.writeFile(join(dir, "台账.xlsx"));
		expect(await previewFile(dir, join(dir, "台账.xlsx"), "台账.xlsx")).toMatchObject({ kind: "sheet", columns: ["设备", "状态"], rows: [{ "设备": "冲压机", "状态": "待维护" }] });
		await services.ingestKnowledge(tenant, { fileName: "制度.docx" });
		await services.ingestKnowledge(tenant, { fileName: "台账.xlsx" });
		expect(await services.searchKnowledge(tenant, "维护")).toHaveLength(2);
	});
	it("HTML 与 SVG 只返回文本，未知格式拒绝", async () => {
		const { dir } = setup();
		for (const name of ["page.html", "image.svg"]) {
			writeFileSync(join(dir, name), '<script>alert("x")</script>');
			expect(await previewFile(dir, join(dir, name), name)).toMatchObject({ kind: "text", text: '<script>alert("x")</script>' });
		}
		writeFileSync(join(dir, "program.exe"), "unknown");
		await expect(previewFile(dir, join(dir, "program.exe"), "program.exe")).rejects.toMatchObject({ status: 415 });
	});
	it("PDF 返回正确 MIME；大文件拒绝，文本预览截断", async () => {
		const { dir } = setup();
		writeFileSync(join(dir, "result.pdf"), "%PDF-1.7");
		expect(await previewFile(dir, join(dir, "result.pdf"), "result.pdf")).toMatchObject({ kind: "binary", mime: "application/pdf" });
		writeFileSync(join(dir, "long.txt"), "a".repeat(100_001));
		expect(await previewFile(dir, join(dir, "long.txt"), "long.txt")).toMatchObject({ kind: "text", truncated: true });
		writeFileSync(join(dir, "large.txt"), Buffer.alloc(MAX_PREVIEW_BYTES + 1));
		await expect(previewFile(dir, join(dir, "large.txt"), "large.txt")).rejects.toMatchObject({ status: 413 });
	});
});

async function serve() {
	const context = setup();
	writeFileSync(join(context.dir, "note.html"), "<script>unsafe()</script>");
	const artifact = join(context.dir, "artifacts", "task-one", "result.pdf");
	mkdirSync(join(context.dir, "artifacts", "task-one"), { recursive: true });
	writeFileSync(artifact, "%PDF-1.7");
	const handler = createWorkspaceHandler({
		workspaceRoot: context.root,
		authenticate: async (req) => req.headers.authorization === "Bearer test" ? { tenant, role: Role.Member } : undefined,
		getTask: (_tenant, id) => id === "task-one" ? { id } : undefined,
		artifactPath: (_tenant, id, name) => id === "task-one" && name === "result.pdf" ? artifact : undefined,
	});
	const server = createServer((req, res) => void handler(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("测试服务未启动");
	const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { Authorization: "Bearer test", ...init.headers } });
	return { call };
}

describe("工作区 HTTP 接口", () => {
	it("鉴权必需，原接口交回主路由", async () => {
		const { call } = await serve();
		for (const path of ["/api/knowledge", "/api/files/note.html/preview", "/api/tasks/task-one/artifacts/result.pdf/preview"]) expect((await call(path, { headers: { Authorization: "" } })).status).toBe(401);
		expect((await call("/api/tasks")).status).toBe(404);
	});
	it("入库、检索和删除闭环，正文不能伪造身份", async () => {
		const { call } = await serve();
		const saved = await call("/api/knowledge", { method: "POST", body: JSON.stringify({ name: "制度", text: "设备维护须每周执行", tenantId: "victim" }) });
		expect(saved.status).toBe(201);
		const { document } = await saved.json();
		const searched = await (await call("/api/knowledge?q=设备维护")).json();
		expect(searched.documents).toHaveLength(1);
		expect(searched.hits[0].chunk.tenantId).toBe("school");
		expect((await call(`/api/knowledge/${document.documentId}`, { method: "DELETE" })).status).toBe(200);
		expect((await (await call("/api/knowledge")).json()).documents).toEqual([]);
	});
	it("预览 MIME、安全响应头与任务归属", async () => {
		const { call } = await serve();
		const html = await call("/api/files/note.html/preview");
		expect(html.headers.get("content-type")).toContain("application/json");
		expect(html.headers.get("content-security-policy")).toContain("sandbox");
		expect((await html.json()).kind).toBe("text");
		const pdf = await call("/api/tasks/task-one/artifacts/result.pdf/preview");
		expect(pdf.headers.get("content-type")).toBe("application/pdf");
		expect(await pdf.text()).toBe("%PDF-1.7");
		expect((await call("/api/tasks/task-two/artifacts/result.pdf/preview")).status).toBe(404);
		expect((await call("/api/files/%2E%2E%2Fsecret.txt/preview")).status).toBe(404);
		expect((await call("/api/knowledge", { method: "POST", body: "{broken" })).status).toBe(400);
	});
});
