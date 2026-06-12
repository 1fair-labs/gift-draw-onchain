import { randomBytes } from 'crypto';

/**
 * Staging / local jackpot testing — never enabled on Vercel production.
 * Set LOTTERY_JACKPOT_DEV_TOOLS=1 in preview or .env (not production).
 */
export function isLotteryJackpotDevEnabled(): boolean {
  if (process.env.LOTTERY_JACKPOT_DEV_TOOLS !== '1') return false;
  const vercelEnv = (process.env.VERCEL_ENV || '').trim().toLowerCase();
  if (vercelEnv === 'production') return false;
  if (!vercelEnv && process.env.NODE_ENV === 'production') return false;
  return true;
}

/** Admin request flag or LOTTERY_FORCE_JACKPOT_HIT=1 (still requires dev tools gate). */
export function shouldForceJackpotHit(requestFlag?: boolean): boolean {
  if (!isLotteryJackpotDevEnabled()) return false;
  if (requestFlag === true) return true;
  return process.env.LOTTERY_FORCE_JACKPOT_HIT === '1';
}

export function assertForceJackpotAllowed(requestFlag?: boolean): void {
  if (requestFlag !== true) return;
  if (!isLotteryJackpotDevEnabled()) {
    throw new Error(
      'Force jackpot is disabled. Set LOTTERY_JACKPOT_DEV_TOOLS=1 on a non-production environment.'
    );
  }
}

/** Recalc-only: new shuffle salt (not used for cron / normal Settle). */
export function assertFreshShuffleAllowed(requestFlag?: boolean): void {
  if (requestFlag !== true) return;
  if (!isLotteryJackpotDevEnabled()) {
    throw new Error(
      'Fresh shuffle is disabled. Set LOTTERY_JACKPOT_DEV_TOOLS=1 on a non-production environment.'
    );
  }
}

export function newFreshShuffleNonce(): string {
  return `${Date.now()}-${randomBytes(8).toString('hex')}`;
}
