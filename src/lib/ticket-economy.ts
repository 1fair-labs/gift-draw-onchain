export type PaymentMethod = 'gift' | 'usdc';
/** All ticket kinds stored in DB / UI. Free: welcome, referral, promo. */
export type TicketKind = 'common' | 'event' | 'legendary' | 'welcome' | 'referral' | 'promo';
/** Kinds assigned randomly on paid purchase. */
export type PurchasableTicketKind = 'common' | 'event' | 'legendary';

const FREE_TICKET_LABELS = new Set<string>(['welcome', 'referral', 'promo']);

/** Welcome, referral, and promo tickets (by kind or origin). */
export function isFreeTicket(ticket: {
  ticket_kind?: string | null;
  ticket_origin?: string | null;
}): boolean {
  const kind = String(ticket.ticket_kind ?? '').trim().toLowerCase();
  const origin = String(ticket.ticket_origin ?? '').trim().toLowerCase();
  return FREE_TICKET_LABELS.has(kind) || FREE_TICKET_LABELS.has(origin);
}

export const PROJECT_NAMESPACE = 'gift_draw_today';

export const TICKET_KIND_WEIGHTS: Record<TicketKind, number> = {
  common: 1.0,
  event: 50,
  legendary: 500,
  welcome: 0.3,
  referral: 0.4,
  promo: 0.2,
};

/** Persisted `tickets.weight` — mirrors draw shuffle weights. */
export function weightForTicketKind(kind: string | null | undefined): number {
  const k = String(kind ?? '').trim().toLowerCase();
  const w = TICKET_KIND_WEIGHTS[k as TicketKind];
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : TICKET_KIND_WEIGHTS.common;
}

// Strict probabilities selected for v1: Event 1/1000, Legendary 1/10000.
// Uses per-100_000 scale to represent 0.01% exactly.
export const TICKET_KIND_PROBABILITIES_PER_100K: Record<PurchasableTicketKind, number> = {
  common: 99890,
  event: 100,
  legendary: 10,
};

export const TICKET_PRICE_USDC = 1;

export function isRarePurchasableTicketKind(
  kind: TicketKind
): kind is Extract<PurchasableTicketKind, 'event' | 'legendary'> {
  return kind === 'event' || kind === 'legendary';
}

/** Map sequential roll-kind API results to rare mint celebration entries. */
export function rareMintedFromRollResults(
  results: Array<{ kind: string }>,
  ticketIds: number[]
): Array<{ id: number; kind: 'event' | 'legendary' }> {
  const out: Array<{ id: number; kind: 'event' | 'legendary' }> = [];
  const n = Math.min(results.length, ticketIds.length);
  for (let i = 0; i < n; i++) {
    const kind = results[i].kind as TicketKind;
    const id = ticketIds[i];
    if (id != null && isRarePurchasableTicketKind(kind)) {
      out.push({ id, kind });
    }
  }
  return out;
}

export function purchasableTicketKindDisplayName(kind: 'event' | 'legendary'): string {
  return kind === 'legendary' ? 'Legendary' : 'Event';
}

export function pickRandomTicketKind(randomValue = Math.random()): PurchasableTicketKind {
  const thresholdEvent = TICKET_KIND_PROBABILITIES_PER_100K.legendary + TICKET_KIND_PROBABILITIES_PER_100K.event;
  const thresholdLegendary = TICKET_KIND_PROBABILITIES_PER_100K.legendary;
  const scaled = Math.floor(randomValue * 100000);

  if (scaled < thresholdLegendary) return 'legendary';
  if (scaled < thresholdEvent) return 'event';
  return 'common';
}

export function getTicketUnitPrice(
  method: PaymentMethod,
  giftUsdcSpotPrice: number | null
): number | null {
  if (method === 'usdc') return TICKET_PRICE_USDC;
  if (!giftUsdcSpotPrice || giftUsdcSpotPrice <= 0) return null;
  return TICKET_PRICE_USDC / giftUsdcSpotPrice;
}

/**
 * GIFT amount equivalent to USDC paid, using spot as USDC per 1 GIFT (e.g. Raydium CPMM reserves).
 * Persisted as `purchase_amount_gift_equiv` when `purchase_currency` is `usdc`.
 */
export function usdcPaidAmountToGiftEquiv(
  totalUsdcPaid: number,
  giftUsdcSpotPrice: number | null
): number | null {
  if (
    !Number.isFinite(totalUsdcPaid) ||
    totalUsdcPaid <= 0 ||
    giftUsdcSpotPrice == null ||
    !Number.isFinite(giftUsdcSpotPrice) ||
    giftUsdcSpotPrice <= 0
  ) {
    return null;
  }
  const gift = totalUsdcPaid / giftUsdcSpotPrice;
  return Number.isFinite(gift) ? gift : null;
}

