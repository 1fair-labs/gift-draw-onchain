import type { PurchasableTicketKind } from '../ticket-economy';
import {
  TICKET_KIND_PROBABILITIES_PER_100K,
} from '../ticket-economy';

export const KIND_ROLL_SCALE = 100_000;

/** Mirrors BPF `kind_from_roll`. */
export function purchasableKindFromRoll(roll: number): PurchasableTicketKind {
  const thresholdEvent =
    TICKET_KIND_PROBABILITIES_PER_100K.legendary + TICKET_KIND_PROBABILITIES_PER_100K.event;
  const thresholdLegendary = TICKET_KIND_PROBABILITIES_PER_100K.legendary;
  if (roll < thresholdLegendary) return 'legendary';
  if (roll < thresholdEvent) return 'event';
  return 'common';
}

/** On-chain `KindRolled.kind` u8 encoding. */
export function purchasableKindFromKindCode(kindCode: number): PurchasableTicketKind {
  if (kindCode === 2) return 'legendary';
  if (kindCode === 1) return 'event';
  return 'common';
}

export function kindCodeFromPurchasable(kind: PurchasableTicketKind): number {
  if (kind === 'legendary') return 2;
  if (kind === 'event') return 1;
  return 0;
}
