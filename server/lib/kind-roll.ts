import { createHash } from 'crypto';
import bs58 from 'bs58';
import type { PurchasableTicketKind } from './gift-draw-registry-client.js';

const PROB_SCALE = 100_000;
const PROB_LEGENDARY = 10;
const PROB_EVENT = 100;

/**
 * Mirrors the registry's `roll_from_inputs`.
 *
 * Spec v22 (`KindRolledV3`): `u32_le(sha256(sig ‖ idx_le ‖ slot_le ‖ purchase_blockhash)[0..4]) % 100000`,
 * where `purchase_blockhash` is the blockhash of the purchase slot (32 zero bytes for claim rolls).
 * Pass `null` for the v19–v21 formula without the blockhash — only to check a `KindRolledV2` event.
 */
export function rollFromPurchaseSig(
  purchaseSigBytes: Uint8Array,
  ticketIndex: number,
  slot: bigint,
  purchaseBlockhash: Uint8Array | null
): number {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(ticketIndex);
  const slotBuf = Buffer.alloc(8);
  slotBuf.writeBigUInt64LE(slot);
  const hash = createHash('sha256').update(purchaseSigBytes).update(idx).update(slotBuf);
  if (purchaseBlockhash) {
    if (purchaseBlockhash.length !== 32) throw new Error('purchase blockhash must be 32 bytes');
    hash.update(purchaseBlockhash);
  }
  return hash.digest().readUInt32LE(0) % PROB_SCALE;
}

export function purchasableKindFromRoll(roll: number): PurchasableTicketKind {
  if (roll < PROB_LEGENDARY) return 'legendary';
  if (roll < PROB_LEGENDARY + PROB_EVENT) return 'event';
  return 'common';
}

export function decodePurchaseSigBase58(signature: string): Uint8Array {
  const decoded = bs58.decode(signature.trim());
  if (decoded.length !== 64) throw new Error('purchase_tx_sig must decode to 64 bytes');
  return decoded;
}
