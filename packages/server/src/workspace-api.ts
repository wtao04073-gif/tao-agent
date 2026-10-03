/** 附加工作区路由。未命中时交回原有应用处理器。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TenantContext } from "@tao/core";
import { readJsonBody, sendError, sendJson, type Principal } from "./app.ts";
import { createWorkspaceServices, isSafeFileName, previewFile, WorkspaceError, workspaceDirectory, workspaceFile, type WorkspaceServices } from "./workspace-services.ts";

export interface WorkspaceDeps {
	readonly authenticate: (req: IncomingMessage) => Promise<Principal | undefined>;
	/** 部署级根目录，服务内部追加 tenantId / workspaceId。 */
	readonly workspaceRoot: string;
	readonly getTask: (tenant: TenantContext, taskId: string) => unknown | undefined;
	/** 必须返回该任务登记的产物完整路径，内部校验租户和工作区。 */
	readonly artifactPath: (tenant: TenantContext, taskId: string, name: string) => string | undefined;
	readonly services?: WorkspaceServices;
}

export function createWorkspaceHandler(deps: WorkspaceDeps) {
	const services = deps.services ?? createWorkspaceServices({ workspaceRoot: deps.workspaceRoot });
	return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const raw = url.pathname.split("/").filter(Boolean);
		const knowledge = raw[0] === "api" && raw[1] === "knowledge";
		const filePreview = raw.length === 4 && raw[0] === "api" && raw[1] === "files" && raw[3] === "preview";
		const artifactPreview = raw.length === 6 && raw[0] === "api" && raw[1] === "tasks" && raw[3] === "artifacts" && raw[5] === "preview";
		if (!knowledge && !filePreview && !artifactPreview) return false;
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
		try {
			const principal = await deps.authenticate(req);
			if (principal === undefined) { sendError(res, 401, "请先登录"); return true; }
			const { tenant } = principal;
			let path: string[];
			try { path = raw.map(decodeURIComponent); } catch { throw new WorkspaceError(400, "请求路径无效"); }
			const method = req.method ?? "GET";
			if (knowledge) {
				if(method === "GET" && path.length === 3 && path[2] === "status") {
                    sendJson(res,200,{rag:services.ragStatus(tenant)});
                }else if(method === "POST" && path.length === 3 && path[2] === "search") {
                    const body=await readJsonBody(req);if(!body.ok)throw new WorkspaceError(400,body.reason);
                    const input=body.value as {query?:unknown;mode?:unknown;limit?:unknown};
                    if(typeof input.query!=="string"||!input.query.trim()||(input.mode!==undefined&&input.mode!=="semantic"&&input.mode!=="hybrid")||(input.limit!==undefined&&(!Number.isInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>100)))throw new WorkspaceError(400,"检索参数无效");
                    const hits=await services.searchKnowledge(tenant,input.query,{...(input.mode?{mode:input.mode as "semantic"|"hybrid"}:{}),...(input.limit?{limit:Number(input.limit)}:{})});
                    sendJson(res,200,{hits,mode:input.mode??services.ragStatus(tenant).mode});
                }else if (method === "GET" && path.length === 2) {
					const query = url.searchParams.get("q")?.trim();
					const documents = services.listKnowledge(tenant);
					sendJson(res, 200, { documents, ...(query ? { hits: await services.searchKnowledge(tenant, query) } : {}) });
				} else if (method === "GET" && path.length === 5 && path[3] === "versions") {
                    sendJson(res,200,services.knowledgeVersion(tenant,path[2]!,Number(path[4])));
                } else if (method === "POST" && path.length === 2) {
					const body = await readJsonBody(req);
					if (!body.ok) throw new WorkspaceError(400, body.reason);
					if (body.value === null || typeof body.value !== "object" || Array.isArray(body.value)) throw new WorkspaceError(400, "文档参数无效");
					const value = body.value as Record<string, unknown>;
					for (const key of ["name", "fileName", "text"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new WorkspaceError(400, "文档参数必须为文本");
					if (value.fileName !== undefined && value.text !== undefined) throw new WorkspaceError(400, "请选择文件入库或文本入库");
					const document = await services.ingestKnowledge(tenant, {
						...(typeof value.name === "string" ? { name: value.name } : {}),
						...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
						...(typeof value.text === "string" ? { text: value.text } : {}),
					});
					sendJson(res, 201, { document });
				} else if (method === "DELETE" && path.length === 3 && path[2] !== undefined) {
					if (!services.deleteKnowledge(tenant, path[2], principal.role)) throw new WorkspaceError(404, "知识文档不存在");
					sendJson(res, 200, { deleted: true });
				} else throw new WorkspaceError(405, "不支持的知识库操作");
				return true;
			}
			if (method !== "GET") throw new WorkspaceError(405, "预览仅支持读取");
			const name = path[artifactPreview ? 4 : 2];
			if (name === undefined || !isSafeFileName(name)) throw new WorkspaceError(404, "文件不存在或无权访问");
			const root = workspaceDirectory(deps.workspaceRoot, tenant);
			let filePath: string | undefined;
			if (artifactPreview) {
				const taskId = path[2];
				if (taskId === undefined || !/^[A-Za-z0-9_-]+$/.test(taskId) || deps.getTask(tenant, taskId) === undefined) throw new WorkspaceError(404, "任务不存在或无权访问");
				filePath = deps.artifactPath(tenant, taskId, name);
			} else filePath = workspaceFile(deps.workspaceRoot, tenant, name);
			if (filePath === undefined) throw new WorkspaceError(404, "文件不存在或无权访问");
			const preview = await previewFile(root, filePath, name);
			if (preview.kind === "binary") {
				res.writeHead(200, { "Content-Type": preview.mime, "Content-Length": preview.bytes.length, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}` });
				res.end(preview.bytes);
			} else sendJson(res, 200, preview);
		} catch (error) {
			if (!res.headersSent) sendError(res, error instanceof WorkspaceError ? error.status : 500, error instanceof WorkspaceError ? error.message : "文档处理失败，请检查文件格式后重试");
		}
		return true;
	};
}
