/** GIFT human amount ↔ on-chain u64 (6 decimal places). */
export const GIFT_AMOUNT_MICRO_SCALE = 1_000_000;

export function giftAmountToMicro(human: number): bigint {
  if (!Number.isFinite(human) || human < 0) return 0n;
  return BigInt(Math.round(human * GIFT_AMOUNT_MICRO_SCALE));
}

/** Exact 6-decimal conversion for DB `numeric` strings (avoids float drift on prize peg). */
export function giftAmountToMicroExact(human: number | string | null | undefined): bigint {
  if (human == null) return 0n;
  if (typeof human === 'number') return giftAmountToMicro(human);
  const trimmed = String(human).trim();
  if (!trimmed) return 0n;
  const neg = trimmed.startsWith('-');
  const body = neg ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fracRaw = ''] = body.split('.');
  const whole = wholeRaw.replace(/\D/g, '') || '0';
  const frac6 = (fracRaw.replace(/\D/g, '') + '000000').slice(0, 6);
  const micro = BigInt(whole) * BigInt(GIFT_AMOUNT_MICRO_SCALE) + BigInt(frac6);
  return neg ? -micro : micro;
}

export function giftAmountFromMicro(micro: bigint | number): number {
  const n = typeof micro === 'bigint' ? micro : BigInt(Math.trunc(micro));
  return Number(n) / GIFT_AMOUNT_MICRO_SCALE;
}
