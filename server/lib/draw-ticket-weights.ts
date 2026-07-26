import { createHash } from 'crypto';

/**
 * Draw shuffle weights — keep in sync with `src/lib/ticket-economy.ts` TICKET_KIND_WEIGHTS.
 */

const MIN_WEIGHT = 1e-6;

/** Settlement spec v17 — free pool quota 1:20..1:10 (seed) + global winner rank shuffle. */
export const TICKET_KIND_WEIGHTS: Record<string, number> = {
  common: 1.0,
  event: 50,
  legendary: 500,
  welcome: 0.3,
  referral: 0.4,
  promo: 0.2,
};

export const SETTLEMENT_SHUFFLE_SPEC = 'v17';

/** Deterministic shuffle salt: spec + draw + stage (auditable per step). */
export function settlementShuffleSalt(drawId: string, stage: string): string {
  return `${SETTLEMENT_SHUFFLE_SPEC}|${String(drawId).trim()}|${stage}`;
}

/**
 * Deterministic Efraimidis–Spirakis key for one ticket (admin list / audit).
 * Lower key → heavier ticket → earlier in weighted order.
 */
export function weightedDrawSortKey(
  seedHex: string,
  drawId: string,
  ticketId: number,
  ticketKind: string,
  stage: string
): number {
  const seedBuf = Buffer.from(String(seedHex).trim(), 'hex');
  if (seedBuf.length === 0) return ticketId;
  const w = Math.max(MIN_WEIGHT, ticketKindDrawWeight(ticketKind));
  const h = createHash('sha256')
    .update(seedBuf)
    .update('|draw-key|', 'utf8')
    .update(settlementShuffleSalt(drawId, stage), 'utf8')
    .update('|', 'utf8')
    .update(String(ticketId), 'utf8')
    .digest();
  const u = (h.readUInt32BE(0) + 1) / 4294967296;
  return -Math.log(u) / w;
}

const DEFAULT_WEIGHT = 1.0;

export type TicketWeightInput = {
  ticket_kind?: string | null;
};

export function ticketKindDrawWeight(kind: unknown): number {
  const k = String(kind ?? '').trim().toLowerCase();
  const w = TICKET_KIND_WEIGHTS[k];
  return typeof w === 'number' && w > 0 ? w : DEFAULT_WEIGHT;
}

export function ticketDrawWeight(ticket: TicketWeightInput): number {
  return ticketKindDrawWeight(ticket.ticket_kind);
}

const RARE_PURCHASABLE_KINDS = new Set(['event', 'legendary']);

export function isRarePurchasableKind(kind: unknown): kind is 'event' | 'legendary' {
  return RARE_PURCHASABLE_KINDS.has(String(kind ?? '').trim().toLowerCase());
}

export function isRarePurchasableTicket(ticket: TicketWeightInput): boolean {
  return isRarePurchasableKind(ticket.ticket_kind);
}

export type WeightedShuffleRng = {
  /** Uniform in (0, 1] — used for Efraimidis–Spirakis keys. */
  nextOpenUnit: (salt: string) => number;
};

/**
 * Weighted random order (Efraimidis–Spirakis A): key = -ln(U)/w, sort ascending (smaller key → heavier item first).
 * Equivalent to u^(1/w) sorted descending.
 */
export function weightedShuffle<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  rng: WeightedShuffleRng,
  shuffleSalt: string
): T[] {
  if (items.length <= 1) return [...items];

  const keyed = items.map((item, idx) => {
    const w = Math.max(MIN_WEIGHT, weightOf(item));
    const u = rng.nextOpenUnit(`${shuffleSalt}|${idx}`);
    const key = -Math.log(u) / w;
    return { item, key, idx };
  });

  keyed.sort((a, b) => a.key - b.key || a.idx - b.idx);
  return keyed.map((k) => k.item);
}
