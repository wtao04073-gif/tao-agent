import { afterEach, expect, it, vi } from "vitest";
import { Sandbox } from "@cubesandbox/sdk";
import { CubeRuntime } from "../src/sandbox/runtime.ts";
import { sandboxConfig } from "../src/sandbox/config.ts";
afterEach(() => vi.restoreAllMocks());
it("官方 SDK 接入使用隔离生命周期、明确网络规则和流式回调，不传模型凭据", async () => {
  const calls: any[] = [];
  const close = vi.fn(),
    kill = vi.fn(async () => {});
  const fake = {
    sandboxId: "sandbox-example",
    files: { makeDir: vi.fn(async () => {}), write: vi.fn(async () => {}) },
    kill,
    close,
    commands: {
      run: vi.fn(async (command: string, options: any) => {
        calls.push({ command, options });
        if (command.startsWith("nohup"))
          return { stdout: "", stderr: "", exitCode: 0 };
        const payload = JSON.parse(
          Buffer.from(command.split(" ").at(-1)!, "base64").toString(),
        );
        const stdout =
          JSON.stringify({ event: "output", text: "实时进度" }) +
          "\n" +
          JSON.stringify({
            id: payload.id,
            result: {
              python: true,
              browser: true,
              exitCode: 0,
              stdout: "done",
            },
          }) +
          "\n";
        options.onStdout?.(stdout.slice(0, 10));
        options.onStdout?.(stdout.slice(10));
        return { stdout, stderr: "", exitCode: 0 };
      }),
    },
  };
  const create = vi
    .spyOn(Sandbox, "create")
    .mockResolvedValue(fake as unknown as Sandbox);
  const config = sandboxConfig({
    SANDBOX_ENABLED: "true",
    SANDBOX_PROVIDER: "cube",
    SANDBOX_API_URL: "https://cube.example.com",
    SANDBOX_API_KEY: "control-placeholder",
    SANDBOX_TEMPLATE: "template",
    SANDBOX_NETWORK_ENABLED: "true",
    SANDBOX_ALLOWED_DOMAINS: "example.com",
    SANDBOX_CUBE_EGRESS_GUARD: "true",
    MODEL_API_KEY: "model-placeholder",
  });
  const runtime = await CubeRuntime.create(config);
  const progress = vi.fn();
  try {
    const result = await runtime.call(
      { op: "execute", code: "print(1)" },
      AbortSignal.timeout(1000),
      progress,
    );
    expect(result.stdout).toBe("done");
    expect(progress).toHaveBeenCalledExactlyOnceWith("实时进度");
    const options = create.mock.calls[0]![0]!;
    expect(options.allowInternetAccess).toBe(false);
    expect(options.lifecycle).toEqual({ onTimeout: "kill", autoResume: false });
    expect(options.network?.allowPublicTraffic).toBe(false);
    expect(options.network?.denyOut).toContain("169.254.0.0/16");
    expect(JSON.stringify(options.envVars)).not.toMatch(/placeholder/);
    expect(options.config).toMatchObject({ apiKey: "control-placeholder" });
    expect(calls.at(-1).options.signal).toBeInstanceOf(AbortSignal);
    expect(calls.at(-1).options.maxOutputBytes).toBeLessThan(16 * 1024 * 1024);
  } finally {
    await runtime.close();
  }
  expect(kill).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it("Cube 域名白名单未部署独立出口保护时拒绝开启，防止学习规则覆盖私网拒绝", () => {
  expect(() =>
    sandboxConfig({
      SANDBOX_ENABLED: "true",
      SANDBOX_PROVIDER: "cube",
      SANDBOX_API_URL: "https://cube.example.com",
      SANDBOX_API_KEY: "placeholder",
      SANDBOX_TEMPLATE: "template",
      SANDBOX_NETWORK_ENABLED: "true",
      SANDBOX_ALLOWED_DOMAINS: "example.com",
    }),
  ).toThrow("出口防火墙");
});
