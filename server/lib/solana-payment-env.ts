import { PublicKey } from '@solana/web3.js';
import { isSolanaDevnet } from './solana-rpc-url.js';
import {
  refreshSolanaRpcCache,
  resolveSolanaPaymentRpcSync,
  resolveSolanaReadRpcSync,
} from './solana-rpc-store.js';

export type PoolMode = 'real' | 'virtual';

export const getPoolMode = (): PoolMode => {
  const raw = (process.env.POOL_MODE || process.env.VITE_POOL_MODE || 'real').trim().toLowerCase();
  return raw === 'virtual' ? 'virtual' : 'real';
};

export const isVirtualPoolMode = (): boolean => getPoolMode() === 'virtual';

export const getVirtualGiftUsdcPrice = (): number | null => {
  const raw = process.env.VIRTUAL_GIFT_USDC_PRICE || process.env.VITE_VIRTUAL_GIFT_USDC_PRICE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const parsePositive = (raw: string | undefined): number | null => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

export const getVirtualPoolGiftReserve = (): number | null =>
  parsePositive(process.env.VIRTUAL_POOL_GIFT_RESERVE || process.env.VITE_VIRTUAL_POOL_GIFT_RESERVE);

export const getVirtualPoolUsdcReserve = (): number | null =>
  parsePositive(process.env.VIRTUAL_POOL_USDC_RESERVE || process.env.VITE_VIRTUAL_POOL_USDC_RESERVE);

export const isServerDevnet = isSolanaDevnet;

export const getServerPaymentRpc = (): string => resolveSolanaPaymentRpcSync();

/** getMint / getAccount reads — public RPC (saves Helius GET_ACCOUNT_INFO credits). */
export const getServerReadRpc = (): string => resolveSolanaReadRpcSync();

export { refreshSolanaRpcCache };

const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_DEFAULT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

export const getServerUsdcMint = (): string => {
  if (isServerDevnet()) {
    return (process.env.VITE_DEVNET_USDC_MINT || '').trim() || DEVNET_USDC_DEFAULT;
  }
  return MAINNET_USDC;
};

export const getServerGiftMint = (): string => (process.env.VITE_GIFT_MINT_ADDRESS || '').trim();

export const getServerTreasury = (): string =>
  (process.env.VITE_PROJECT_TREASURY_WALLET_ADDRESS || '').trim() ||
  (process.env.VITE_LOTTERY_WALLET_ADDRESS || '').trim() ||
  (process.env.PROJECT_TREASURY_WALLET_ADDRESS || '').trim();

export const parseTreasuryPubkey = (): PublicKey => {
  const s = getServerTreasury();
  if (!s) throw new Error('Treasury wallet is not configured (VITE_PROJECT_TREASURY_WALLET_ADDRESS)');
  return new PublicKey(s);
};

/** Jupiter Swap API v2 base (no trailing slash). Keyless tier on api.jup.ag; optional lite-api. */
export const getJupiterSwapApiBase = (): string => {
  const raw = (process.env.JUPITER_SWAP_API_BASE || '').trim();
  if (raw) return raw.replace(/\/$/, '');
  return 'https://api.jup.ag/swap/v2';
};

export const getJupiterApiKey = (): string | undefined => {
  const k = (process.env.JUPITER_API_KEY || '').trim();
  return k || undefined;
};

export const getJupiterSlippageBps = (): number => {
  const n = Number(process.env.JUPITER_SLIPPAGE_BPS);
  if (Number.isFinite(n) && n >= 0 && n <= 5000) return Math.floor(n);
  return 100;
};

/** Raydium GIFT/USDC CPMM pool (devnet pool quote + optional env for server). */
export const getServerGiftUsdcPoolAddress = (): string =>
  (process.env.VITE_GIFT_USDC_POOL_ADDRESS || process.env.GIFT_USDC_CPMM_POOL_ID || '').trim();
