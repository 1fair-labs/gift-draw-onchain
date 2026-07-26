/**
 * MTT-style top-heavy payout fractions (sum = 1) for `paidPlaces` finishing positions.
 *
 * Small fields: common home-tournament charts (homepokergames / pokereagles):
 * - 2 paid: 70% / 30%
 * - 3 paid: 50% / 30% / 20%
 * - 5 paid: 45% / 25% / 15% / 10% / 5%
 *
 * Larger fields: extend with rank^-1.35 weights (~15% paid MTT top-heavy; 1st ≈ 2× 2nd at small G).
 */

const ROUND = 1e8;

const STANDARD_TABLES: Record<number, number[]> = {
  1: [1],
  2: [0.7, 0.3],
  3: [0.5, 0.3, 0.2],
  4: [0.43, 0.27, 0.17, 0.13],
  5: [0.45, 0.25, 0.15, 0.1, 0.05],
  6: [0.4, 0.24, 0.16, 0.1, 0.06, 0.04],
  7: [0.38, 0.22, 0.14, 0.1, 0.07, 0.05, 0.04],
  8: [0.36, 0.21, 0.14, 0.1, 0.07, 0.05, 0.04, 0.03],
  9: [0.35, 0.2, 0.13, 0.1, 0.07, 0.05, 0.04, 0.03, 0.03],
  10: [0.34, 0.19, 0.13, 0.09, 0.07, 0.05, 0.04, 0.03, 0.03, 0.03],
};

function powerLawFractions(paidPlaces: number): number[] {
  const weights: number[] = [];
  for (let rank = 1; rank <= paidPlaces; rank++) weights.push(1 / Math.pow(rank, 1.35));
  const sumW = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / sumW);
}

/** Fraction of a pool for places 1..paidPlaces (length = paidPlaces, sum ≈ 1). */
export function pokerPayoutFractions(paidPlaces: number): number[] {
  const n = Math.max(1, Math.floor(paidPlaces));
  if (STANDARD_TABLES[n]) return [...STANDARD_TABLES[n]];
  return powerLawFractions(n);
}

/** Split `total` by fractional weights; remainder of rounding goes to 1st place. */
export function splitPoolByFractions(total: number, fractions: number[]): number[] {
  if (fractions.length === 0 || total <= 0) return [];
  const sumF = fractions.reduce((a, b) => a + b, 0);
  if (sumF <= 0) return [];

  const raw = fractions.map((f) => (total * f) / sumF);
  const floors = raw.map((x) => Math.floor(x * ROUND) / ROUND);
  let sum = floors.reduce((a, b) => a + b, 0);
  const rem = Math.round((total - sum) * ROUND) / ROUND;
  const out = [...floors];
  if (rem > 0 && out.length > 0) out[0] = Math.round((out[0] + rem) * ROUND) / ROUND;
  return out;
}

export type MainGiftAllocationInput = {
  winnerPool: number;
  /** All main winners W (paid + sampled free). */
  mainWinnerCount: number;
  /** Subset receiving GIFT cash (ceil(W/2)). */
  giftWinnerCount: number;
  /** Mean paid ticket GIFT equiv: prize_pool / paid_count. */
  avgGift: number;
};

export type MainGiftAllocationResult = {
  /** Cash GIFT per gift winner (rank 1..G); each >= effectiveBase. */
  giftCashAmounts: number[];
  /** Base credited to every winner slot (avg or scaled). */
  effectiveBase: number;
  /** Pool left after W × base (0 if scaled). */
  remainder: number;
};

/**
 * Two-phase winner pool (spec v2):
 * 1) Each of W winners absorbs `effectiveBase` (ticket prizes imputed at base; not mint-only).
 * 2) Remainder split MTT-style among G gift winners; each cash prize = base + bonus.
 */
export function allocateMainGiftPrizes(input: MainGiftAllocationInput): MainGiftAllocationResult {
  const pool = Math.max(0, input.winnerPool);
  const W = Math.max(1, Math.floor(input.mainWinnerCount));
  const G = Math.max(0, Math.floor(input.giftWinnerCount));
  const avg = Math.max(0, input.avgGift);

  const baseTotal = W * avg;
  let effectiveBase = avg;
  let remainder = 0;

  if (baseTotal > pool + 1e-12) {
    effectiveBase = pool / W;
    remainder = 0;
  } else {
    remainder = Math.round((pool - baseTotal) * ROUND) / ROUND;
  }

  if (G === 0) {
    return { giftCashAmounts: [], effectiveBase, remainder };
  }

  const bonuses =
    remainder > 0 ? splitPoolByFractions(remainder, pokerPayoutFractions(G)) : Array(G).fill(0);
  const giftCashAmounts = bonuses.map((bonus) =>
    Math.round((effectiveBase + bonus) * ROUND) / ROUND
  );

  return { giftCashAmounts, effectiveBase, remainder };
}
