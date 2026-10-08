import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Sandbox, Config } from "@cubesandbox/sdk";
import type { SandboxConfig } from "./config.ts";
import { SandboxEgress, SANDBOX_DENY_CIDRS } from "./egress.ts";
export type Payload = Record<string, unknown>;
export interface Runtime {
  readonly id: string;
  call(
    payload: Payload,
    signal: AbortSignal,
    progress?: (text: string) => void,
  ): Promise<Payload>;
  write(path: string, data: Buffer, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
const MAX_PROTOCOL = 15 * 1024 * 1024;
export const workerPath = resolve(
  new URL("../../../../sandbox/runtime/worker.py", import.meta.url).pathname,
);
// src/sandbox 与 dist/sandbox 深度相同；只引用仓库内受控脚本。
function processBytes(pid: number, seen = new Set<number>()): number {
  if (seen.has(pid)) return 0;
  seen.add(pid);
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    let bytes = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
    const children = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      "utf8",
    ).trim();
    for (const child of children.split(/\s+/).filter(Boolean))
      bytes += processBytes(Number(child), seen);
    return bytes;
  } catch {
    return 0;
  }
}
function diskBytes(path: string, state = { count: 0 }): number {
  let total = 0;
  for (const name of readdirSync(path)) {
    if (++state.count > 10000) throw new Error("沙箱文件数超过限制");
    const f = join(path, name),
      s = lstatSync(f);
    if (s.isSymbolicLink()) continue;
    total += s.isDirectory() ? diskBytes(f, state) : s.size;
  }
  return total;
}
export class BubblewrapRuntime implements Runtime {
  readonly id = randomUUID();
  private child!: ChildProcessWithoutNullStreams;
  private dir = "";
  private workspace = "";
  private reservedUID: number | undefined;
  private static readonly uids = new Set<number>();
  private egress?: SandboxEgress;
  private timer?: ReturnType<typeof setInterval>;
  private pending:
    | undefined
    | {
        id: string;
        resolve: (x: Payload) => void;
        reject: (e: Error) => void;
        progress?: (text: string) => void;
      };
  private buffer = "";
  private closed = false;
  private failure = "沙箱进程已结束";
  static async create(c: SandboxConfig): Promise<BubblewrapRuntime> {
    const r = new BubblewrapRuntime();
    r.dir = mkdtempSync(join(tmpdir(), "tao-isolated-"));
    r.workspace = join(r.dir, "workspace");
    mkdirSync(r.workspace, { mode: 0o700 });
    let uid = process.getuid?.() === 0 ? c.uid : process.getuid!();
    if (process.getuid?.() === 0) {
      while (this.uids.has(uid)) uid++;
      this.uids.add(uid);
      r.reservedUID = uid;
    }
    try {
      if (process.getuid?.() === 0) {
        chownSync(r.dir, uid, uid);
        chownSync(r.workspace, uid, uid);
      }
      chmodSync(r.dir, 0o700);
      for (const name of ["tmp", "shm"]) {
        const path = join(r.dir, name);
        mkdirSync(path, { mode: 0o700 });
        if (process.getuid?.() === 0) chownSync(path, uid, uid);
      }
      const script = join(r.dir, "worker.py");
      const ocrSource=join(dirname(workerPath),"ocr.py"),ocrScript=join(r.dir,"ocr.py");if(existsSync(ocrSource))writeFileSync(ocrScript,readFileSync(ocrSource),{mode:0o644});
      writeFileSync(script, readFileSync(workerPath), { mode: 0o644 });
      const args = [
        "--unshare-all",
        "--hostname",
        "tao-sandbox",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--ro-bind",
        "/bin",
        "/bin",
        "--dev",
        "/dev",
        "--bind",
        join(r.dir, "tmp"),
        "/tmp",
        "--bind",
        join(r.dir, "shm"),
        "/dev/shm",
        "--dir",
        "/etc",
        "--ro-bind",
        c.runtimeDir,
        "/opt/venv",
        "--ro-bind",
        c.browsersDir,
        "/opt/browsers",
        "--ro-bind",
        script,
        "/opt/tao/worker.py",
        "--ro-bind",
        process.execPath,
        "/opt/node/bin/node",
        "--ro-bind",
        dirname(dirname(process.execPath)),
        "/opt/node-runtime",
        "--bind",
        r.workspace,
        "/workspace",
        "--chdir",
        "/workspace",
        "--clearenv",
      ];
      if(existsSync(ocrScript))args.push("--ro-bind",ocrScript,"/opt/tao/ocr.py");
      const pythonRoot = dirname(
        dirname(realpathSync(join(c.runtimeDir, "bin/python"))),
      );
      if (!pythonRoot.startsWith("/usr/"))
        args.push("--ro-bind", pythonRoot, pythonRoot);
      for (const path of ["/etc/ssl/certs", "/etc/fonts", "/usr/share/fonts"])
        if (existsSync(path)) args.push("--ro-bind", path, path);
      if (c.network) {
        const socket = join(r.dir, "egress.sock");
        r.egress = new SandboxEgress(c.domains);
        await r.egress.listen(socket);
        if (process.getuid?.() === 0) chownSync(socket, uid, uid);
        chmodSync(socket, 0o600);
        args.push("--ro-bind", socket, "/egress.sock");
      }
      const env: Record<string, string> = {
        PATH: "/opt/venv/bin:/opt/node/bin:/opt/node-runtime/bin:/usr/bin:/bin",
        NODE_USE_ENV_PROXY: "1",
        PYTHONPATH: "/workspace/packages",
        HOME: "/workspace",
        LANG: "C.UTF-8",
        TMPDIR: "/tmp",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers",
        OPENBLAS_NUM_THREADS: "1",
        OMP_NUM_THREADS: "1",
        OMP_THREAD_LIMIT:"1",
        MPLBACKEND: "Agg",
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        TAO_BROWSER_ENGINE: "chromium",
      };
      if (process.argv.includes("--sandbox-diagnostic"))
        env.DEBUG = "pw:browser";
      if (existsSync(join(c.runtimeDir, "libproc-exe-compat.so")))
        env.LD_PRELOAD = "/opt/venv/libproc-exe-compat.so";
      if (c.network)
        Object.assign(env, {
          HTTP_PROXY: "http://127.0.0.1:3128",
          HTTPS_PROXY: "http://127.0.0.1:3128",
          http_proxy: "http://127.0.0.1:3128",
          https_proxy: "http://127.0.0.1:3128",
          NO_PROXY: "",
          no_proxy: "",
        });
      for (const [key, value] of Object.entries(env))
        args.push("--setenv", key, value);
      args.push(
        "--remount-ro",
        "/",
        "/opt/venv/bin/python",
        "/opt/tao/worker.py",
      );
      r.child = spawn("/usr/bin/bwrap", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
        ...(process.getuid?.() === 0 ? { uid, gid: uid } : {}),
        detached: true,
      });
      r.child.stdout.setEncoding("utf8");
      r.child.stdout.on("data", (text: string) => r.receive(text));
      r.child.stderr.on("data", (chunk: Buffer) => {
        if (process.argv.includes("--sandbox-diagnostic"))
          process.stderr.write(chunk);
      });
      r.child.on("error", () =>
        r.fail("无法启动隔离进程，请检查运行时安装和命名空间权限"),
      );
      r.child.on("exit", () => {
        r.fail(r.failure);
        void r.close().catch(() => {});
      });
      const started = Date.now();
      r.timer = setInterval(() => {
        try {
          if (
            Date.now() - started > c.ttl * 1000 ||
            processBytes(r.child.pid ?? 0) > c.memoryMB * 1024 * 1024 ||
            diskBytes(r.dir) > c.diskMB * 1024 * 1024
          ) {
            r.failure = "沙箱达到时间、内存或磁盘限制，已终止";
            void r.close().catch(() => {});
          }
        } catch {
          r.failure = "沙箱文件数或存储检查失败，已终止";
          void r.close().catch(() => {});
        }
      }, 200);
      r.timer.unref();
      await r.call({ op: "health" }, AbortSignal.timeout(15000));
      return r;
    } catch (error) {
      await r.close();
      throw error;
    }
  }
  private fail(message: string) {
    this.failure = message;
    this.pending?.reject(new Error(message));
    this.pending = undefined;
  }
  private receive(text: string) {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > MAX_PROTOCOL) {
      this.failure = "沙箱输出超过限制";
      void this.close().catch(() => {});
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let frame: Payload;
      try {
        frame = JSON.parse(line);
      } catch {
        this.fail("沙箱输出协议无效");
        void this.close().catch(() => {});
        return;
      }
      if (frame.event === "output") {
        this.pending?.progress?.(String(frame.text ?? "").slice(0, 2048));
        continue;
      }
      if (frame.id !== this.pending?.id) continue;
      const pending = this.pending;
      this.pending = undefined;
      if (frame.error) pending?.reject(new Error(String(frame.error)));
      else pending?.resolve(frame.result as Payload);
    }
  }
  async call(
    payload: Payload,
    signal: AbortSignal,
    progress?: (text: string) => void,
  ): Promise<Payload> {
    signal.throwIfAborted();
    if (this.closed) throw new Error(this.failure);
    if (this.pending) throw new Error("沙箱已有操作执行中");
    const id = randomUUID();
    const stop = () => {
      this.failure = "沙箱操作已取消或超时";
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      return await new Promise<Payload>((resolve, reject) => {
        this.pending = {
          id,
          resolve,
          reject,
          ...(progress ? { progress } : {}),
        };
        this.child.stdin.write(
          JSON.stringify({ ...payload, id }) + "\n",
          (e) => {
            if (e) this.fail("沙箱输入通道已关闭");
          },
        );
      });
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async write(path: string, data: Buffer, signal: AbortSignal) {
    await this.call(
      { op: "write", path, data: data.toString("base64") },
      signal,
    );
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.fail(this.failure);
    if (
      this.child?.pid &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
          return resolve();
        this.child.once("exit", () => resolve());
        setTimeout(resolve, 2000).unref();
      });
    }
    await this.egress?.close();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    if (this.reservedUID !== undefined)
      BubblewrapRuntime.uids.delete(this.reservedUID);
  }
}
export class CubeRuntime implements Runtime {
  readonly id: string;
  private closed = false;
  private readonly sandbox: Sandbox;
  private constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    this.id = sandbox.sandboxId;
  }
  static connection(c: SandboxConfig) {
    return new Config({
      apiUrl: c.apiUrl,
      apiKey: c.apiKey,
      templateId: c.template,
      proxyNodeIp: c.proxyIP,
      proxyPort: c.proxyPort,
      proxyScheme: c.proxyScheme,
      sandboxDomain: c.domain,
      timeout: c.ttl,
      requestTimeoutMs: 20000,
    });
  }
  static async create(c: SandboxConfig): Promise<CubeRuntime> {
    const sb = await Sandbox.create({
      config: this.connection(c),
      template: c.template,
      timeout: c.ttl,
      lifecycle: { onTimeout: "kill", autoResume: false },
      allowInternetAccess: c.network && !c.domains.length,
      network: {
        allowPublicTraffic: false,
        denyOut: SANDBOX_DENY_CIDRS,
        ...(c.domains.length
          ? {
              rules: [
                ...c.domains.map((domain, index) => ({
                  name: "allow-" + index,
                  match: { host: domain },
                  action: { allow: true },
                })),
                { name: "default-deny", match: {}, action: { allow: false } },
              ],
            }
          : {}),
      },
      envVars: {
        HOME: "/workspace",
        OPENBLAS_NUM_THREADS: "1",
        OMP_NUM_THREADS: "1",
        OMP_THREAD_LIMIT:"1",
        MPLBACKEND: "Agg",
      },
    });
    const runtime = new CubeRuntime(sb);
    try {
      await sb.files.makeDir("/workspace");
      await sb.files.makeDir("/opt/tao");
      await sb.files.write("/opt/tao/worker.py", readFileSync(workerPath));
      const ocrSource=join(dirname(workerPath),"ocr.py");if(existsSync(ocrSource))await sb.files.write("/opt/tao/ocr.py",readFileSync(ocrSource));
      // 模板提供Python/Playwright。脱离本次RPC保留沙箱内浏览器状态；生命周期由VM管理。
      const command =
        "nohup python3 /opt/tao/worker.py --serve >/tmp/tao-runtime.log 2>&1 </dev/null &";
      await sb.commands.run(command, { timeoutMs: 10000 });
      for (let i = 0; i < 20; i++) {
        try {
          await runtime.call({ op: "health" }, AbortSignal.timeout(10000));
          return runtime;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error("CubeSandbox模板运行时未就绪");
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  async call(
    payload: Payload,
    signal: AbortSignal,
    progress?: (text: string) => void,
  ) {
    signal.throwIfAborted();
    if (this.closed) throw new Error("沙箱已释放");
    const stop = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const encoded = Buffer.from(
        JSON.stringify({ ...payload, id: randomUUID() }),
      ).toString("base64");
      let buffered = "";
      const onStdout = (chunk: string) => {
        buffered += chunk;
        let index: number;
        while ((index = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.event === "output")
              progress?.(String(frame.text ?? "").slice(0, 2048));
          } catch {}
        }
      };
      const result = await this.sandbox.commands.run(
        "python3 /opt/tao/worker.py --client " + encoded,
        { timeoutMs: 130000, signal, maxOutputBytes: MAX_PROTOCOL, onStdout },
      );
      signal.throwIfAborted();
      if (Buffer.byteLength(result.stdout) > MAX_PROTOCOL)
        throw new Error("沙箱输出超过限制");
      let reply: Payload | undefined;
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const frame = JSON.parse(line) as Payload;
        if (frame.event !== "output") reply = frame;
      }
      if (!reply) throw new Error("沙箱未返回有效结果");
      if (reply.error) throw new Error(String(reply.error));
      return reply.result as Payload;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async write(path: string, data: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.sandbox.files.write(path, data);
    signal.throwIfAborted();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.sandbox.kill();
    } finally {
      this.sandbox.close();
    }
  }
}
