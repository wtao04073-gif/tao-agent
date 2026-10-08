import { existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { AdminError, type Values } from "../admin-settings.ts";
import { checkEndpoint } from "../admin-integrations.ts";
export interface SandboxConfig {
  enabled: boolean;
  provider: "cube" | "bubblewrap";
  apiUrl: string;
  apiKey: string;
  template: string;
  proxyIP: string;
  proxyPort: number;
  proxyScheme: "http" | "https";
  domain: string;
  runtimeDir: string;
  browsersDir: string;
  rootfs: string;
  uid: number;
  network: boolean;
  domains: string[];
  ttl: number;
  timeout: number;
  maxConcurrent: number;
  memoryMB: number;
  diskMB: number;
  requireConfirm: boolean;
}
export function sandboxConfig(v: Values): SandboxConfig {
  const provider = v.SANDBOX_PROVIDER ?? "cube";
  if (!["cube", "bubblewrap"].includes(provider))
    throw new AdminError(400, "沙箱运行方式无效");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const x = Number(v[key] ?? fallback);
    if (!Number.isSafeInteger(x) || x < min || x > max)
      throw new AdminError(400, key + "超出范围");
    return x;
  };
  const domains = (v.SANDBOX_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (
    domains.some(
      (d) =>
        !/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(d) ||
        d.includes("..") ||
        isIP(d),
    )
  )
    throw new AdminError(400, "沙箱域名白名单格式无效");
  const c: SandboxConfig = {
    enabled: v.SANDBOX_ENABLED === "true",
    provider: provider as SandboxConfig["provider"],
    apiUrl: v.SANDBOX_API_URL ?? "",
    apiKey: v.SANDBOX_API_KEY ?? "",
    template: v.SANDBOX_TEMPLATE ?? "",
    proxyIP: v.SANDBOX_PROXY_IP ?? "",
    proxyPort: integer("SANDBOX_PROXY_PORT", 443, 1, 65535),
    proxyScheme: v.SANDBOX_PROXY_SCHEME === "http" ? "http" : "https",
    domain: v.SANDBOX_DOMAIN ?? "cube.app",
    runtimeDir: v.SANDBOX_LOCAL_RUNTIME ?? "",
    browsersDir: v.SANDBOX_LOCAL_BROWSERS ?? "",
    rootfs: v.SANDBOX_LOCAL_ROOTFS ?? "/usr",
    uid: integer("SANDBOX_LOCAL_UID", 62000, 10000, 2000000000),
    network: v.SANDBOX_NETWORK_ENABLED === "true",
    domains,
    ttl: integer("SANDBOX_TTL_SECONDS", 600, 60, 3600),
    timeout: integer("SANDBOX_EXEC_TIMEOUT_SECONDS", 60, 1, 120),
    maxConcurrent: integer("SANDBOX_MAX_CONCURRENT", 2, 1, 5),
    memoryMB: integer("SANDBOX_MEMORY_MB", 1536, 256, 4096),
    diskMB: integer("SANDBOX_DISK_MB", 128, 32, 1024),
    requireConfirm: v.SANDBOX_REQUIRE_CONFIRM !== "false",
  };
  if (c.enabled) {
    if (c.provider === "cube") {
      if (
        c.network &&
        c.domains.length &&
        v.SANDBOX_CUBE_EGRESS_GUARD !== "true"
      )
        throw new AdminError(
          400,
          "Cube 域名白名单需部署独立出口防火墙并设置 SANDBOX_CUBE_EGRESS_GUARD，防止 DNS 学习规则覆盖私网拒绝规则",
        );
      if (!c.apiUrl || !c.template || !c.apiKey)
        throw new AdminError(400, "请填写CubeSandbox地址、模板与密钥");
      checkEndpoint(c.apiUrl);
      if (
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(c.template) ||
        !/^[a-z0-9][a-z0-9.-]+$/.test(c.domain)
      )
        throw new AdminError(400, "沙箱模板或域名无效");
      if (c.proxyIP && !isIP(c.proxyIP))
        throw new AdminError(400, "CubeProxy须填写IP地址");
      if (c.proxyScheme === "http" && !["127.0.0.1", "::1"].includes(c.proxyIP))
        throw new AdminError(400, "远程CubeProxy必须使用HTTPS");
    } else {
      for (const path of [c.runtimeDir, c.browsersDir])
        if (
          !isAbsolute(path) ||
          !existsSync(path) ||
          !statSync(path).isDirectory()
        )
          throw new AdminError(400, "本地沙箱运行时或浏览器目录尚未安装");
      if (!existsSync("/usr/bin/bwrap"))
        throw new AdminError(400, "本机未安装Bubblewrap");
      if (c.rootfs !== "/usr")
        throw new AdminError(400, "本地运行时系统目录固定为/usr");
    }
  }
  return c;
}
