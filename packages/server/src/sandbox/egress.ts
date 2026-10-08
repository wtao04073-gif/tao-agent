/** 独立网络命名空间的唯一出网通道；固定DNS结果后拨号，拒绝私网/元数据。 */
import { createServer, request, type Server } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { chmodSync } from "node:fs";
import { networkPolicy } from "../admin-network.ts";

export const SANDBOX_DENY_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/0",
];
const checkIP = networkPolicy("");
export async function publicTarget(
  host: string,
  allowedDomains: readonly string[] = [],
): Promise<{ address: string; family: number }> {
  host = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  )
    throw new Error("沙箱禁止访问本机、内网与元数据");
  if (
    allowedDomains.length &&
    !allowedDomains.some(
      (domain) =>
        host === domain ||
        (domain.startsWith("*.") && host.endsWith(domain.slice(1))),
    )
  )
    throw new Error("目标域名未在沙箱出网白名单中");
  const entries = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!entries.length) throw new Error("目标域名无法解析");
  for (const entry of entries) {
    checkIP(entry.address);
    if (
      entry.address.startsWith("198.18.") ||
      entry.address.startsWith("198.19.")
    )
      throw new Error("目标地址被出网策略拒绝");
  }
  const target = entries.find((e) => e.family === 4);
  if (!target) throw new Error("沙箱出网当前仅支持 IPv4 公网目标");
  return target;
}
export class SandboxEgress {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private connections = 0;
  private readonly domains: readonly string[];
  private readonly maxBytes: number;
  private transferred = 0;
  private closed = false;
  constructor(domains: readonly string[], maxBytes = 64 * 1024 * 1024) {
    this.domains = domains;
    this.maxBytes = maxBytes;
    this.server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "");
        if (
          url.protocol !== "http:" ||
          url.username ||
          url.password ||
          Number(url.port || 80) !== 80
        )
          throw new Error("仅允许HTTP(S)标准端口");
        const target = await publicTarget(url.hostname, this.domains);
        if (this.closed || this.transferred >= this.maxBytes)
          throw new Error("出网通道已关闭或流量额度已用完");
        const headers: Record<string, string | string[] | undefined> = {
          ...req.headers,
          host: url.host,
        };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        delete headers.connection;
        const upstream = request(
          {
            host: target.address,
            port: 80,
            path: url.pathname + url.search,
            method: req.method,
            headers,
            agent: false,
            timeout: 30000,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.on("data", (chunk) => {
              this.transferred += chunk.length;
              if (this.transferred > this.maxBytes) {
                upstream.destroy();
                res.destroy();
              }
            });
            response.pipe(res);
          },
        );
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end("沙箱出网失败");
        });
        upstream.on("timeout", () => upstream.destroy());
        req.on("aborted", () => upstream.destroy());
        res.on("close", () => upstream.destroy());
        req.on("data", (chunk) => {
          this.transferred += chunk.length;
          if (this.transferred > this.maxBytes) {
            upstream.destroy();
            req.destroy();
          }
        });
        req.pipe(upstream);
      })().catch(() => {
        res.writeHead(403);
        res.end("沙箱出网策略拒绝该目标");
      });
    });
    this.server.on("connect", (req, stream, head) => {
      const client = stream as Socket;
      void (async () => {
        const url = new URL("https://" + req.url);
        if (url.username || url.password || Number(url.port || 443) !== 443)
          throw new Error("端口无效");
        const target = await publicTarget(url.hostname, this.domains);
        if (this.closed || this.transferred >= this.maxBytes)
          throw new Error("出网通道已关闭或流量额度已用完");
        const upstream = connect({ host: target.address, port: 443 });
        this.sockets.add(upstream);
        const count = (data: Buffer) => {
          this.transferred += data.length;
          if (this.transferred > this.maxBytes) {
            client.destroy();
            upstream.destroy();
          }
        };
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) {
            this.transferred += head.length;
            upstream.write(head);
          }
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.setTimeout(60000, () => upstream.destroy());
        client.setTimeout(60000, () => client.destroy());
        upstream.on("data", count);
        client.on("data", count);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => {
          this.sockets.delete(upstream);
          client.destroy();
        });
      })().catch(() => {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      });
    });
    this.server.on("connection", (socket) => {
      this.connections++;
      this.sockets.add(socket);
      if (this.connections > 32) socket.destroy();
      socket.setTimeout(60000, () => socket.destroy());
      socket.on("close", () => {
        this.connections--;
        this.sockets.delete(socket);
      });
    });
    this.server.maxHeadersCount = 40;
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 60000;
  }
  async listen(path: string) {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    chmodSync(path, 0o666);
  }
  async close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
