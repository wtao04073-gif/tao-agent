import { localCapabilities, sessionEligible } from './policy.ts';
import type { CommandRisk, LocalCapability, LocalControlConfig } from './types.ts';

/** Memory-only grants, scoped to a task and exact effective policy. */
export class LocalSessionGrants {
  private readonly grants = new Map<string, Map<LocalCapability, number>>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private key(taskId: string, cfg: LocalControlConfig): string {
    return JSON.stringify([taskId, cfg.policyHash]);
  }

  grant(taskId: string, cfg: LocalControlConfig, risk: CommandRisk, ttlMinutes = cfg.sessionGrantTtlMin): number {
    if (!taskId || cfg.confirmMode !== 'session' || risk.kind === 'block' || risk.highRisk || !sessionEligible(risk.capabilities))
      throw new Error('此命令不允许会话授权');
    const allowed = localCapabilities(cfg);
    if (risk.capabilities.some(c => !allowed[c])) throw new Error('会话授权不能越过管理员能力边界');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('会话授权有效期无效');
    const expiresAt = this.now() + Math.min(ttlMinutes, cfg.sessionGrantTtlMin) * 60000;
    const key = this.key(taskId, cfg);
    const entries = this.grants.get(key) ?? new Map<LocalCapability, number>();
    for (const capability of risk.capabilities) entries.set(capability, expiresAt);
    this.grants.set(key, entries);
    return expiresAt;
  }

  allows(taskId: string, cfg: LocalControlConfig, risk: CommandRisk): boolean {
    if (!taskId || cfg.confirmMode !== 'session' || risk.kind === 'block' || risk.highRisk || !sessionEligible(risk.capabilities)) return false;
    const allowed = localCapabilities(cfg);
    const entries = this.grants.get(this.key(taskId, cfg));
    const now = this.now();
    if (!entries) return false;
    for (const [capability, expiresAt] of entries) if (expiresAt <= now) entries.delete(capability);
    if (!entries.size) this.grants.delete(this.key(taskId, cfg));
    return risk.capabilities.every(c => allowed[c] && (entries.get(c) ?? 0) > now);
  }

  clearTask(taskId: string): void {
    for (const key of this.grants.keys()) if (JSON.parse(key)[0] === taskId) this.grants.delete(key);
  }
  clear(): void { this.grants.clear(); }
}
