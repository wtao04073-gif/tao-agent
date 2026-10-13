import type { LocalCapability, LocalControlConfig } from './types.ts';

export const HIGH_RISK_CAPABILITIES: readonly LocalCapability[] = ['network', 'install_pkg', 'write_outside', 'system_maintenance'];

/** Administrator capability boundary; user confirmations can only narrow it. */
export function localCapabilities(cfg: LocalControlConfig): Record<LocalCapability, boolean> {
  const on = cfg.enabled && cfg.singleUser && cfg.level !== 'off' && cfg.confined;
  const write = on && cfg.level !== 'readonly';
  const extended = write && (cfg.level === 'extended' || cfg.level === 'full');
  return {
    read: on, write_in_root: write, delete: write && cfg.allowDelete,
    execute_local: write, network: extended && cfg.network,
    install_pkg: extended && cfg.allowInstall,
    write_outside: extended && cfg.level === 'full' && cfg.allowWriteOutside,
    system_maintenance: extended && cfg.level === 'full',
  };
}

export function sessionEligible(capabilities: readonly LocalCapability[]): boolean {
  return capabilities.length > 0 && capabilities.every(c => !HIGH_RISK_CAPABILITIES.includes(c));
}
