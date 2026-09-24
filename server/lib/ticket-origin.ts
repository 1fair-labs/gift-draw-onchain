/** Ticket acquisition channel (DB `ticket_origin`). */
export const TICKET_ORIGIN_PURCHASE = 'purchase';
export const TICKET_ORIGIN_CLAIM = 'claim';
export const TICKET_ORIGIN_FREE = 'free';

export const FREE_TICKET_KINDS = ['promo', 'welcome', 'referral'] as const;
export type FreeTicketKind = (typeof FREE_TICKET_KINDS)[number];

export const PURCHASABLE_TICKET_KINDS = ['common', 'event', 'legendary'] as const;

/** On-chain `KindRolledV2.origin` byte values (gift_draw_registry). */
export const ROLL_ORIGIN_PURCHASE = 0;
export const ROLL_ORIGIN_CLAIM = 1;

const LEGACY_FREE_ORIGINS = new Set<string>(['promo', 'welcome', 'referral']);

export function isLegacyFreeOrigin(origin: string | null | undefined): boolean {
  return LEGACY_FREE_ORIGINS.has(String(origin || '').trim().toLowerCase());
}

export function isFreeOrigin(origin: string | null | undefined): boolean {
  const o = String(origin || '').trim().toLowerCase();
  return o === TICKET_ORIGIN_FREE || isLegacyFreeOrigin(o);
}

export function normalizeTicketOrigin(origin: string | null | undefined): string {
  const o = String(origin || '').trim().toLowerCase();
  if (isLegacyFreeOrigin(o)) return TICKET_ORIGIN_FREE;
  return o;
}

export function ticketKindOriginMismatch(
  ticketKind: string | null | undefined,
  ticketOrigin: string | null | undefined
): string | null {
  const kind = String(ticketKind || '').trim().toLowerCase();
  const origin = normalizeTicketOrigin(ticketOrigin);

  if (origin === TICKET_ORIGIN_FREE) {
    if (!FREE_TICKET_KINDS.includes(kind as FreeTicketKind)) {
      return 'Free origin requires promo, welcome, or referral kind';
    }
    return null;
  }

  if (origin === TICKET_ORIGIN_PURCHASE) {
    if (!PURCHASABLE_TICKET_KINDS.includes(kind as (typeof PURCHASABLE_TICKET_KINDS)[number])) {
      return 'Purchase origin requires common, event, or legendary kind';
    }
    return null;
  }

  if (origin === TICKET_ORIGIN_CLAIM) {
    if (!PURCHASABLE_TICKET_KINDS.includes(kind as (typeof PURCHASABLE_TICKET_KINDS)[number])) {
      return 'Claim origin requires common, event, or legendary kind after roll';
    }
    return null;
  }

  return `Unsupported ticket_origin: ${origin}`;
}

export function rollOriginByte(ticketOrigin: string | null | undefined): number {
  const o = normalizeTicketOrigin(ticketOrigin);
  if (o === TICKET_ORIGIN_CLAIM) return ROLL_ORIGIN_CLAIM;
  return ROLL_ORIGIN_PURCHASE;
}
