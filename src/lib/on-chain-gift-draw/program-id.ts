/** Default devnet/local program id — replace after `anchor deploy` via env. */
export const DEFAULT_GIFT_DRAW_REGISTRY_PROGRAM_ID =
  'GftDrwRgstryw4vK7nQm8pL2xR9tY3zF6bN1cH5jP8qT';

export const SETTLEMENT_SPEC_VERSION_ON_CHAIN = 20;

export function getGiftDrawRegistryProgramId(): string {
  const fromEnv =
    (typeof import.meta !== 'undefined' &&
      (import.meta.env?.VITE_GIFT_DRAW_REGISTRY_PROGRAM_ID as string | undefined)) ||
    '';
  const trimmed = fromEnv.trim();
  return trimmed || DEFAULT_GIFT_DRAW_REGISTRY_PROGRAM_ID;
}

export function getGiftDrawRegistryProgramIdServer(): string {
  const trimmed = (process.env.GIFT_DRAW_REGISTRY_PROGRAM_ID || '').trim();
  return trimmed || DEFAULT_GIFT_DRAW_REGISTRY_PROGRAM_ID;
}

/** Matches server: always on-chain in production builds. */
export function isOnChainRegistryEnabled(): boolean {
  if (import.meta.env.PROD) return true;
  const env =
    (typeof import.meta !== 'undefined' &&
      (import.meta.env?.VITE_GIFT_DRAW_REGISTRY_ENABLED as string | undefined)) ||
    '';
  return (env.trim() || '1') !== '0';
}

export function solscanTxUrl(cluster: 'devnet' | 'mainnet-beta', signature: string): string {
  const base = cluster === 'devnet' ? 'https://solscan.io/tx' : 'https://solscan.io/tx';
  const q = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `${base}/${signature}${q}`;
}

export function solscanAccountUrl(cluster: 'devnet' | 'mainnet-beta', address: string): string {
  const base = 'https://solscan.io/account';
  const q = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `${base}/${address}${q}`;
}
