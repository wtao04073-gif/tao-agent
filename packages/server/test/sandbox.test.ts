import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "../src/sandbox/manager.ts";
import { sandboxConfig } from "../src/sandbox/config.ts";
import { publicTarget } from "../src/sandbox/egress.ts";
import { AdminSettings } from "../src/admin-settings.ts";
import { ConnectionChecks } from "../src/admin-connections.ts";
import type { Runtime } from "../src/sandbox/runtime.ts";
const tenant = { tenantId: "one", workspaceId: "office", userId: "user" };
const values = {
  SANDBOX_ENABLED: "true",
  SANDBOX_PROVIDER: "cube",
  SANDBOX_API_URL: "https://cube.example.com",
  SANDBOX_API_KEY: "test-placeholder",
  SANDBOX_TEMPLATE: "tao-template",
};
const roots: string[] = [];
const managers: SandboxManager[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), "tao-sandbox-test-"));
  roots.push(p);
  return p;
};
function runtime(): Runtime {
  return {
    id: "example",
    call: vi.fn(async (p) =>
      p.op === "export"
        ? {
            data: Buffer.from("delivered").toString("base64"),
            name: "result.txt",
          }
        : { python: true, browser: true, stdout: "4\n", exitCode: 0 },
    ),
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
function manager(v = values, r = runtime()) {
  const m = new SandboxManager(
    () => v,
    async () => r,
  );
  managers.push(m);
  return { m, r };
}
function call(
  m: SandboxManager,
  name: string,
  args: Record<string, unknown>,
  task = "t1",
  dir = root(),
  owner = tenant,
  signal = new AbortController().signal,
) {
  return m
    .tools(owner, task, dir)
    .find((t) => t.name === name)!
    .execute({ args, taskId: task, tenant: owner, signal, report: () => {} });
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
describe("沙箱租约与工具边界", () => {
  it("默认关闭，未配置不注入执行工具", () => {
    const { m } = manager({ ...values, SANDBOX_ENABLED: "false" });
    expect(m.tools(tenant, "t", root())).toEqual([]);
    expect(sandboxConfig({}).enabled).toBe(false);
  });
  it("代码执行和网页修改默认需要确认，文件操作不授权宿主路径", () => {
    const { m } = manager();
    expect(
      m.policies().find((p) => p.tool === "sandbox_execute")?.requiresConfirm,
    ).toBe(true);
    expect(
      m.policies().find((p) => p.tool === "sandbox_browser_action")
        ?.requiresConfirm,
    ).toBe(true);
    expect(m.policies().every((p) => !("pathParams" in p))).toBe(true);
  });
  it("同一任务复用沙箱，任务结束释放", async () => {
    const { m, r } = manager();
    await call(m, "sandbox_execute", { language: "python", code: "print(4)" });
    await call(m, "sandbox_files", { action: "list", path: "." });
    expect(m.activeCount).toBe(1);
    await m.release("t1");
    expect(r.close).toHaveBeenCalledOnce();
    expect(m.activeCount).toBe(0);
  });
  it("跨租户和用户不能复用任务沙箱", async () => {
    const { m } = manager();
    await call(m, "sandbox_files", { action: "list", path: "." });
    await expect(
      call(m, "sandbox_files", { action: "list", path: "." }, "t1", root(), {
        ...tenant,
        userId: "other",
      }),
    ).rejects.toThrow("归属");
    expect(m.list({ ...tenant, tenantId: "other" })).toEqual([]);
  });
  it("异步创建前预留并发席位", async () => {
    let resolve!: (r: Runtime) => void;
    const m = new SandboxManager(
      () => ({ ...values, SANDBOX_MAX_CONCURRENT: "1" }),
      () => new Promise((r) => (resolve = r)),
    );
    managers.push(m);
    const first = call(m, "sandbox_files", { action: "list", path: "." });
    await vi.waitFor(() => expect(m.activeCount).toBe(1));
    await expect(
      call(m, "sandbox_files", { action: "list", path: "." }, "t2"),
    ).rejects.toThrow("并发");
    resolve(runtime());
    await first;
  });
  it("同一沙箱自动排队，文件导出完成后再执行下一操作", async () => {
    const { m, r } = manager();
    let unblock!: (v: any) => void;
    vi.mocked(r.call).mockImplementation(async (p) =>
      p.op === "export"
        ? await new Promise((resolve) => (unblock = resolve))
        : {},
    );
    const first = call(m, "sandbox_export", { path: "output/file.txt" });
    await vi.waitFor(() => expect(unblock).toBeTypeOf("function"));
    const second = call(m, "sandbox_files", { action: "list", path: "." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.call).toHaveBeenCalledTimes(2);
    unblock({ data: Buffer.from("safe").toString("base64"), name: "file.txt" });
    await Promise.all([first, second]);
    expect(r.call).toHaveBeenCalledTimes(3);
  });
  it("输入只来自本任务引用，交付真实字节并防止覆盖", async () => {
    const { m, r } = manager(),
      dir = root();
    mkdirSync(join(dir, ".inputs"));
    writeFileSync(join(dir, ".inputs", "input.csv"), "a,b");
    writeFileSync(join(dir, "unreferenced.txt"), "private");
    const out = await call(
      m,
      "sandbox_export",
      { path: "output/file.txt" },
      "t1",
      dir,
    );
    expect(r.write).toHaveBeenCalledExactlyOnceWith(
      "/workspace/inputs/input.csv",
      Buffer.from("a,b"),
      expect.any(AbortSignal),
    );
    expect(readFileSync(String(out.details?.outputPath), "utf8")).toBe(
      "delivered",
    );
  });
  it("创建失败会释放席位", async () => {
    const m = new SandboxManager(
      () => values,
      async () => {
        throw Error("internal");
      },
    );
    managers.push(m);
    await expect(
      call(m, "sandbox_files", { action: "list", path: "." }),
    ).rejects.toThrow("沙箱创建失败");
    expect(m.activeCount).toBe(0);
  });
  it("超大代码和关闭出网时拒绝执行", async () => {
    const { m, r } = manager();
    await expect(
      call(m, "sandbox_execute", { code: "a".repeat(64001) }),
    ).rejects.toThrow("64KB");
    await expect(
      call(m, "sandbox_browser", {
        action: "navigate",
        url: "https://example.com",
      }),
    ).rejects.toThrow("未开启");
    expect(r.call).not.toHaveBeenCalled();
  });
  it("连接测试也计入并发，失败仍释放", async () => {
    const { m, r } = manager();
    vi.mocked(r.call).mockRejectedValue(Error("unavailable"));
    await expect(m.check(values)).rejects.toThrow();
    expect(r.close).toHaveBeenCalledOnce();
    expect(m.activeCount).toBe(0);
  });
});
describe("沙箱配置与出网", () => {
  it.each([
    "http://169.254.169.254",
    "http://10.0.0.1",
    "http://127.0.0.1",
    "http://[::ffff:127.0.0.1]",
    "http://198.18.0.1",
  ])("阻止内网和元数据地址 %s", async (url) => {
    await expect(publicTarget(new URL(url).hostname)).rejects.toThrow();
  });
  it("域名白名单不允许后缀混淆", async () => {
    await expect(
      publicTarget("example.com.evil.com", ["*.example.com"]),
    ).rejects.toThrow("白名单");
    await expect(
      publicTarget("example.com", ["*.example.com"]),
    ).rejects.toThrow("白名单");
  });
  it("配置校验、密钥加密、部署路径禁止在线修改", () => {
    expect(() =>
      sandboxConfig({ ...values, SANDBOX_TTL_SECONDS: "-1" }),
    ).toThrow();
    const dir = root(),
      s = new AdminSettings({ directory: dir, env: values });
    expect(JSON.stringify(s.public("global"))).not.toContain(
      values.SANDBOX_API_KEY,
    );
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain(
      values.SANDBOX_API_KEY,
    );
    expect(() =>
      s.saveDraft("global", {
        expectedRevision: 0,
        actor: "a",
        values: { SANDBOX_LOCAL_RUNTIME: "/root" },
      }),
    ).toThrow("不能在线修改");
  });
  it("修改沙箱配置会使旧连接验证失效", () => {
    const checks = new ConnectionChecks(root());
    checks.record("sandbox", values, true);
    expect(
      checks.status(values).find((s) => s.type === "sandbox")?.status,
    ).toBe("available");
    expect(
      checks
        .status({ ...values, SANDBOX_TEMPLATE: "new" })
        .find((s) => s.type === "sandbox")?.status,
    ).toBe("unverified");
  });
});
