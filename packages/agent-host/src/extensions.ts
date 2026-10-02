/** Pi 扩展桥接：只接公开接口，不启用 CLI 的个人配置发现。 */
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseSubagentCapabilityCeiling, intersectSubagentCapabilityCeilings } from "pi-subagents/capability-ceiling";
import type { PlatformTool, Runner, RunnerFactory, RunnerSpec, ToolOutcome } from "@tao/core";
export interface McpServerConfig {
    name: string;
    url: string;
    tools: string[];
    headers?: Record<string, string>;
}
interface RegisteredMcpTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(id: string, args: unknown, signal: AbortSignal): Promise<{
        content: {
            type: string;
            text?: string;
        }[];
        details?: {
            error?: string;
        };
    }>;
}
interface ManagedAdapter {
    ready(): Promise<void>;
    close(): Promise<void>;
    extensionFactory(api: {
        registerTool(tool: RegisteredMcpTool): void;
        events: {
            emit(name: string, request: unknown): void;
        };
    }): void;
}
const jiti = createJiti(import.meta.url, { fsCache: false });
let adapterModule: Promise<{
    createHostManagedMcpAdapter(options: unknown): ManagedAdapter;
}> | undefined;
function transport(server: McpServerConfig) {
    const url = new URL(server.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        throw new Error("MCP 仅支持 HTTPS 或本机 HTTP 服务");
    if (url.username || url.password)
        throw new Error("MCP URL 不得包含凭据");
    return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: server.headers ?? {}, redirect: "error" },
        fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    });
}
export function createMcpToolset(servers: readonly McpServerConfig[]): PlatformTool[] {
    if (!servers.length)
        return [];
    const byName = new Map(servers.map(s => [s.name, s]));
    if (byName.size !== servers.length || servers.some(s => !/^[A-Za-z0-9_-]{1,80}$/.test(s.name) || !Array.isArray(s.tools) || !s.tools.length))
        throw new Error("MCP 服务名称或工具白名单无效");
    const get = (name: unknown) => {
        const server = typeof name === "string" ? byName.get(name) : undefined;
        if (!server)
            throw new Error("MCP 服务未授权");
        return server;
    };
    return [{
            name: "mcp_list_tools", label: "查看外部工具", replay: "safe",
            description: `查询已授权 MCP 服务的工具参数。可用服务：${servers.map(s => s.name).join("、")}`,
            parameters: { type: "object", properties: { server: { type: "string", enum: servers.map(s => s.name) } }, required: ["server"] },
            async execute({ args, signal }) {
                const server = get((args as {
                    server?: unknown;
                }).server);
                const client = new Client({ name: "tao-agent", version: "0.1.0" }, { capabilities: {} });
                const connection = transport(server);
                const abort = () => { void client.close().catch(() => { }); };
                signal.throwIfAborted();
                signal.addEventListener("abort", abort, { once: true });
                try {
                    await client.connect(connection, { signal, timeout: 15000 });
                    const result = await client.listTools(undefined, { signal, timeout: 15000 });
                    return { text: JSON.stringify(result.tools.filter(t => server.tools.includes(t.name)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).slice(0, 30000) };
                }
                catch {
                    return { isError: true, text: "外部工具目录暂不可用，请检查服务配置" };
                }
                finally {
                    signal.removeEventListener("abort", abort);
                    await client.close().catch(() => { });
                }
            },
        }, {
            name: "mcp_call", label: "执行外部工具", replay: "never",
            description: "调用已授权 MCP 工具。请先查询参数；每次调用需用户确认，不自动重试结果未知的请求。",
            parameters: { type: "object", properties: { server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["server", "tool", "arguments"] },
            async execute({ args, signal }) {
                const request = args as {
                    server?: unknown;
                    tool?: unknown;
                    arguments?: unknown;
                };
                const server = get(request.server);
                if (typeof request.tool !== "string" || !server.tools.includes(request.tool))
                    return { isError: true, text: "MCP 工具未授权" };
                if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments))
                    return { isError: true, text: "工具参数必须是对象" };
                adapterModule ??= jiti.import("pi-mcp-adapter/host-managed") as typeof adapterModule & Promise<{
                    createHostManagedMcpAdapter(options: unknown): ManagedAdapter;
                }>;
                const { createHostManagedMcpAdapter } = await adapterModule;
                const adapter = createHostManagedMcpAdapter({
                    servers: { [server.name]: { createTransport: () => transport(server), tools: [request.tool] } },
                    requestTimeoutMs: 30000,
                    onToolCall: async (call: {
                        dispatch(): Promise<unknown>;
                    }) => call.dispatch(),
                });
                const abort = () => { void adapter.close().catch(() => { }); };
                signal.throwIfAborted();
                signal.addEventListener("abort", abort, { once: true });
                try {
                    await adapter.ready();
                    signal.throwIfAborted();
                    const tools: RegisteredMcpTool[] = [];
                    adapter.extensionFactory({ registerTool: tool => { tools.push(tool); }, events: {
                            emit(_name, value) {
                                const approval = value as {
                                    origin?: string;
                                    claim?: (handler: () => Promise<string>) => void;
                                };
                                // 外层 Pi 权限钩子已经消费该 mcp_call 的一次授权；不授权隐式资源读取。
                                approval.claim?.(async () => approval.origin === "direct" ? "allow_once" : "deny");
                            },
                        } });
                    const tool = tools[0];
                    if (!tool || tools.length !== 1)
                        throw new Error("外部工具目录变化");
                    const result = await tool.execute(randomUUID(), request.arguments, signal);
                    return { text: result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n").slice(0, 30000),
                        ...(result.details?.error ? { isError: true } : {}) };
                }
                catch {
                    return { isError: true, text: "外部工具调用失败或结果不确定。请核对执行结果，不要自动重试。" };
                }
                finally {
                    signal.removeEventListener("abort", abort);
                    await adapter.close().catch(() => { });
                }
            },
        }];
}
/** 复用 pi-subagents 的能力上限协议，实际执行仍走平台 Pi Runner 与计量。 */
export function createSubagentTool(options: {
    factory: RunnerFactory;
    allowedTools: readonly string[];
    createSpec(childId: string, tools: readonly string[]): RunnerSpec;
    maxConcurrency?: number;
    timeoutMs?: number;
}): PlatformTool {
    const concurrency = options.maxConcurrency ?? 2, timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
        throw new Error("子任务并发或超时配置无效");
    return {
        name: "delegate_tasks", label: "并行处理子任务", replay: "never",
        description: "将互不依赖的工作交给独立 Pi 子智能体。每次最多5项，子任务继承输入授权，不能继续派生子任务。",
        parameters: { type: "object", properties: { tasks: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: {
                            label: { type: "string" }, prompt: { type: "string" }, tools: { type: "array", items: { type: "string" } },
                        }, required: ["label", "prompt"] } } }, required: ["tasks"] },
        async execute({ args, signal, report }) {
            const tasks = (args as {
                tasks?: unknown;
            }).tasks;
            if (!Array.isArray(tasks) || !tasks.length || tasks.length > 5)
                throw new Error("子任务数量须为1至5");
            const parsed = tasks.map(t => {
                if (!t || typeof t.label !== "string" || !t.label.trim() || typeof t.prompt !== "string" || !t.prompt.trim() || t.prompt.length > 20000 || (t.tools !== undefined && (!Array.isArray(t.tools) || !t.tools.every((v: unknown) => typeof v === "string"))))
                    throw new Error("子任务参数无效");
                return t as {
                    label: string;
                    prompt: string;
                    tools?: string[];
                };
            });
            const parent = parseSubagentCapabilityCeiling({ version: 1, sources: ["tao-host"], allowedTools: options.allowedTools.filter(t => !["delegate_tasks", "mcp_call"].includes(t)), denyExtensions: true });
            let next = 0;
            const results: {
                label: string;
                status: string;
                summary: string;
                artifacts: string[];
            }[] = new Array(parsed.length);
            const worker = async () => {
                while (next < parsed.length) {
                    const index = next++, task = parsed[index]!;
                    if (signal.aborted) {
                        results[index] = { label: task.label, status: "cancelled", summary: "已取消", artifacts: [] };
                        continue;
                    }
                    const requested = task.tools ? parseSubagentCapabilityCeiling({ version: 1, sources: ["tao-host"], allowedTools: task.tools }) : undefined;
                    const ceiling = intersectSubagentCapabilityCeilings(parent, requested)!;
                    const artifacts: string[] = [];
                    let summary = "";
                    let timedOut = false;
                    let runner: Runner | undefined, timer: ReturnType<typeof setTimeout> | undefined;
                    let unsubscribe: (() => void) | undefined;
                    const abort = () => { void runner?.abort("父任务取消或子任务超时").catch(() => { }); };
                    try {
                        const childId = "child-" + randomUUID(), spec = options.createSpec(childId, ceiling.allowedTools ?? []);
                        runner = await options.factory.createRunner(spec);
                        unsubscribe = runner.subscribe(event => { if (event.type === "assistant_message")
                            summary = event.text; if (event.type === "artifact")
                            artifacts.push(event.artifactId); });
                        timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
                        timer.unref();
                        signal.addEventListener("abort", abort, { once: true });
                        signal.throwIfAborted();
                        report(`子任务开始：${task.label}`);
                        await runner.prompt(task.prompt);
                        results[index] = { label: task.label, status: signal.aborted ? "cancelled" : timedOut ? "timed_out" : "succeeded", summary, artifacts };
                    }
                    catch {
                        results[index] = { label: task.label, status: signal.aborted ? "cancelled" : timedOut ? "timed_out" : "failed", summary: "子任务未成功完成", artifacts };
                    }
                    finally {
                        if (timer)
                            clearTimeout(timer);
                        signal.removeEventListener("abort", abort);
                        unsubscribe?.();
                        try {
                            await runner?.close();
                        }
                        catch {
                            results[index] = { label: task.label, status: "failed", summary: "子任务资源释放失败", artifacts };
                        }
                    }
                    report(`子任务完成：${task.label}（${results[index]!.status}）`);
                }
            };
            await Promise.all(Array.from({ length: Math.min(parsed.length, concurrency) }, worker));
            return { text: JSON.stringify(results), details: { outputPaths: results.flatMap(r => r.artifacts), partialFailure: results.some(r => r.status !== "succeeded") } } satisfies ToolOutcome;
        },
    };
}
