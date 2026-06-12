import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseKindRolledFromTx,
  type ParsedKindRolledV2,
  PROJECT_TAG_GDT0,
  SETTLEMENT_SPEC_VERSION_ON_CHAIN,
  rollKindEntropyBytes,
} from './gift-draw-registry-client.js';
import { ticketKindDrawWeight } from './draw-ticket-weights.js';
import { giftAmountFromMicro, giftAmountToMicro, giftAmountToMicroExact } from './gift-amount-micro.js';
import {
  normalizeTicketOrigin,
  ROLL_ORIGIN_CLAIM,
  ROLL_ORIGIN_PURCHASE,
  TICKET_ORIGIN_CLAIM,
  TICKET_ORIGIN_PURCHASE,
  ticketKindOriginMismatch,
} from './ticket-origin.js';

const CLAIM_PURCHASE_SIG_MISMATCH =
  'claim reference mismatch (prize ticket uses claim:{prizeId}, not a Solana payment tx)';

export const KIND_ROLL_SYNC_ERROR_PREFIX = 'kind_roll:';

/** Errors where sending another roll_kind tx will not fix DB linkage (stop auto-retry). */
export function isNonRetriableKindRollError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('claim reference mismatch') ||
    m.includes('purchase_tx_sig mismatch') ||
    m.includes('gift_amount_micro mismatch') ||
    m.includes('ticket_serial mismatch') ||
    m.includes('buyer wallet mismatch') ||
    m.includes('invalid purchase signature') ||
    m.includes('treasury did not receive') ||
    m.includes('payment transaction not found') ||
    m.includes('payment transaction failed')
  );
}

export function kindRollBlockedSyncError(syncError: string | null | undefined): string | null {
  const s = (syncError || '').trim();
  if (!s.startsWith(KIND_ROLL_SYNC_ERROR_PREFIX)) return null;
  return s;
}

export function formatKindRollSyncError(error: string): string {
  const msg = error.trim();
  return msg.startsWith(KIND_ROLL_SYNC_ERROR_PREFIX) ? msg : `${KIND_ROLL_SYNC_ERROR_PREFIX} ${msg}`;
}
import { verifyPurchaseTxForRoll } from './verify-purchase-tx.js';

/** Normalize legacy `prize:` refs and trim before roll / verify. */
export function canonicalRollPurchaseTxSig(
  purchaseTxSig: string | null | undefined,
  _ticketOrigin?: string | null
): string {
  const s = (purchaseTxSig || '').trim();
  if (s.startsWith('prize:')) return `claim:${s.slice('prize:'.length)}`;
  return s;
}

export type TicketRollRow = {
  id: number;
  owner_wallet: string | null;
  ticket_kind: string | null;
  ticket_origin: string | null;
  ticket_serial: number | null;
  purchase_tx_sig: string | null;
  purchase_amount_gift_equiv: number | null;
  purchase_amount: number | null;
  kind_roll_tx_sig: string | null;
  kind_roll_roll?: number | null;
  kind_roll_verified_at?: string | null;
};

export function expectedGiftMicroFromRow(row: TicketRollRow): bigint {
  const raw =
    row.purchase_amount_gift_equiv != null
      ? row.purchase_amount_gift_equiv
      : row.purchase_amount != null
        ? row.purchase_amount
        : 0;
  const micro = giftAmountToMicroExact(raw);
  return micro < 0n ? 0n : micro;
}

/** Claim entropy candidates for legacy rows (`prize:`, `claim:legacy-*`, etc.). */
export function claimRollEntropyCandidates(row: TicketRollRow): string[] {
  const out: string[] = [];
  const pay = canonicalRollPurchaseTxSig(row.purchase_tx_sig, row.ticket_origin);
  if (pay) out.push(pay);
  const raw = (row.purchase_tx_sig || '').trim();
  if (raw && !out.includes(raw)) out.push(raw);
  if (raw.startsWith('prize:')) {
    const c = `claim:${raw.slice('prize:'.length)}`;
    if (!out.includes(c)) out.push(c);
  }
  const legacy = `claim:legacy-${row.id}`;
  if (!out.includes(legacy)) out.push(legacy);
  return out;
}

export function ticketSerialFromDb(value: number | string | null | undefined): number {
  if (value == null) return NaN;
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

export function purchaseSigMatchesEntropy(
  purchaseTxSig: string,
  entropyFromEvent: Uint8Array | number[]
): boolean {
  const expected = rollKindEntropyBytes(purchaseTxSig);
  const got =
    entropyFromEvent instanceof Uint8Array ? entropyFromEvent : Uint8Array.from(entropyFromEvent);
  if (expected.length !== got.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== got[i]) return false;
  }
  return true;
}

export function buyerBase58FromParsed(parsed: ParsedKindRolledV2): string {
  const b = parsed.buyer;
  if (b instanceof PublicKey) return b.toBase58();
  if (typeof b === 'string') return b.trim();
  try {
    return new PublicKey(b as Uint8Array | number[]).toBase58();
  } catch {
    return '';
  }
}

/** Compare DB row to parsed KindRolledV2. */
export function ticketMatchesKindRolledV2(row: TicketRollRow, parsed: ParsedKindRolledV2): string | null {
  if (Number(row.id) !== parsed.ticketId) {
    return `ticket_id mismatch (db ${row.id}, chain ${parsed.ticketId})`;
  }
  const serial = ticketSerialFromDb(row.ticket_serial);
  if (!Number.isFinite(serial) || serial !== Math.trunc(parsed.ticketSerial)) {
    return `ticket_serial mismatch`;
  }
  const wallet = (row.owner_wallet || '').trim();
  const buyer = buyerBase58FromParsed(parsed);
  if (!wallet || !buyer || wallet !== buyer) {
    return 'buyer wallet mismatch';
  }
  const origin = normalizeTicketOrigin(row.ticket_origin);
  const expectedOriginByte = origin === TICKET_ORIGIN_CLAIM ? ROLL_ORIGIN_CLAIM : ROLL_ORIGIN_PURCHASE;
  if (parsed.origin !== expectedOriginByte) {
    return 'origin byte mismatch';
  }
  const pay = canonicalRollPurchaseTxSig(row.purchase_tx_sig, row.ticket_origin);
  const entropyOk =
    claimRollEntropyCandidates(row).some((c) => purchaseSigMatchesEntropy(c, parsed.purchaseTxSig)) ||
    (!!pay && purchaseSigMatchesEntropy(pay, parsed.purchaseTxSig));
  if (!entropyOk) {
    return origin === TICKET_ORIGIN_CLAIM
      ? CLAIM_PURCHASE_SIG_MISMATCH
      : 'purchase_tx_sig mismatch';
  }
  const kind = String(row.ticket_kind || '').trim().toLowerCase();
  const rolledAlready = !!(row.kind_roll_tx_sig || '').trim();
  if (rolledAlready && kind !== parsed.kind) {
    return `ticket_kind mismatch (db ${kind}, chain ${parsed.kind})`;
  }
  const expectedMicro = expectedGiftMicroFromRow(row);
  if (parsed.giftAmountMicro !== expectedMicro) {
    return `gift_amount_micro mismatch (db ${expectedMicro}, chain ${parsed.giftAmountMicro})`;
  }
  const okRegistry =
    parsed.registryVersion === SETTLEMENT_SPEC_VERSION_ON_CHAIN ||
    parsed.registryVersion === SETTLEMENT_SPEC_VERSION_ON_CHAIN - 1;
  if (!okRegistry) {
    return 'registry_version mismatch';
  }
  if (parsed.projectTag !== PROJECT_TAG_GDT0) {
    return 'project_tag mismatch';
  }
  const mismatch = ticketKindOriginMismatch(row.ticket_kind, row.ticket_origin);
  if (mismatch) return mismatch;
  return null;
}

/** Map KindRolledV2 entropy bytes → DB `purchase_tx_sig` (claim ref or verified payment tx). */
export async function resolvePurchaseTxSigForParsedEntropy(
  supabase: SupabaseClient | undefined,
  row: TicketRollRow,
  parsed: ParsedKindRolledV2
): Promise<string | null> {
  for (const candidate of claimRollEntropyCandidates(row)) {
    if (purchaseSigMatchesEntropy(candidate, parsed.purchaseTxSig)) return candidate;
  }
  if (supabase) {
    const fromPrize = await resolveClaimPurchaseSigFromEntropy(
      supabase,
      row.id,
      parsed.purchaseTxSig
    );
    if (fromPrize) return fromPrize;
  }
  const wallet = (row.owner_wallet || '').trim();
  if (!wallet) return null;
  try {
    const chainSig = bs58.encode(Buffer.from(parsed.purchaseTxSig));
    const verified = await verifyPurchaseTxForRoll(chainSig, wallet);
    if (verified.ok) return chainSig;
  } catch {
    /* not a base58 payment sig */
  }
  return null;
}

/** Resolve `claim:{draw_ticket_prizes.id}` from on-chain entropy for a prize child ticket. */
export async function resolveClaimPurchaseSigFromEntropy(
  supabase: SupabaseClient,
  ticketId: number,
  entropyFromEvent: Uint8Array
): Promise<string | null> {
  const { data: prizes, error } = await supabase
    .from('draw_ticket_prizes')
    .select('id')
    .eq('mint_child_ticket_id', ticketId);
  if (error) {
    console.warn('resolveClaimPurchaseSigFromEntropy:', error.message);
    return null;
  }
  for (const p of prizes ?? []) {
    const ref = `claim:${String(p.id)}`;
    if (purchaseSigMatchesEntropy(ref, entropyFromEvent)) return ref;
  }
  const legacy = `claim:legacy-${ticketId}`;
  if (purchaseSigMatchesEntropy(legacy, entropyFromEvent)) return legacy;
  return null;
}

/** Ensure claim prize rows use `claim:{prizeId}` (never a parent payment sig). */
export async function ensureClaimPurchaseTxSig(
  supabase: SupabaseClient,
  ticketId: number,
  row: TicketRollRow
): Promise<string> {
  if (normalizeTicketOrigin(row.ticket_origin) !== TICKET_ORIGIN_CLAIM) {
    return canonicalRollPurchaseTxSig(row.purchase_tx_sig, row.ticket_origin);
  }
  const { data: prize } = await supabase
    .from('draw_ticket_prizes')
    .select('id')
    .eq('mint_child_ticket_id', ticketId)
    .maybeSingle();
  if (!prize?.id) {
    return canonicalRollPurchaseTxSig(row.purchase_tx_sig, row.ticket_origin);
  }
  const expected = `claim:${String(prize.id)}`;
  const current = canonicalRollPurchaseTxSig(row.purchase_tx_sig, row.ticket_origin);
  if (current === expected) return expected;
  await supabase.from('tickets').update({ purchase_tx_sig: expected }).eq('id', ticketId);
  return expected;
}

/**
 * Patch legacy DB fields from a parsed KindRolledV2 (payment sig on chain, GIFT peg, claim ref).
 */
export async function reconcileRowForParsedKindRoll(
  row: TicketRollRow,
  parsed: ParsedKindRolledV2,
  supabase?: SupabaseClient
): Promise<{ row: TicketRollRow; fields: Record<string, unknown> } | null> {
  const fields: Record<string, unknown> = {};
  let patched: TicketRollRow = { ...row };
  const payCanonical = canonicalRollPurchaseTxSig(row.purchase_tx_sig, row.ticket_origin);

  if (!payCanonical || !purchaseSigMatchesEntropy(payCanonical, parsed.purchaseTxSig)) {
    if (parsed.origin === ROLL_ORIGIN_PURCHASE) {
      let chainSig: string;
      try {
        chainSig = bs58.encode(Buffer.from(parsed.purchaseTxSig));
      } catch {
        return null;
      }
      const wallet = (row.owner_wallet || '').trim();
      if (!wallet) return null;
      const v = await verifyPurchaseTxForRoll(chainSig, wallet);
      if (!v.ok) return null;
      patched = { ...patched, purchase_tx_sig: chainSig };
      fields.purchase_tx_sig = chainSig;
    } else if (parsed.origin === ROLL_ORIGIN_CLAIM) {
      const match = await resolvePurchaseTxSigForParsedEntropy(supabase, row, parsed);
      if (!match) return null;
      patched = { ...patched, purchase_tx_sig: match };
      fields.purchase_tx_sig = match;
    } else {
      return null;
    }
  }

  if (expectedGiftMicroFromRow(patched) !== parsed.giftAmountMicro) {
    const gift = giftAmountFromMicro(parsed.giftAmountMicro);
    patched = { ...patched, purchase_amount_gift_equiv: gift, purchase_amount: gift };
    fields.purchase_amount_gift_equiv = gift;
    fields.purchase_amount = gift;
  }

  const matchErr = ticketMatchesKindRolledV2(patched, parsed);
  if (matchErr) return null;
  return { row: patched, fields };
}

/** Prefer payment sig bytes from a sibling that already rolled successfully. */
export async function resolveRollPurchaseTxSig(
  supabase: SupabaseClient,
  ticketId: number,
  purchaseTxSigRaw: string | null,
  ticketOrigin: string | null,
  buyerWallet: string
): Promise<string> {
  const canonical = canonicalRollPurchaseTxSig(purchaseTxSigRaw, ticketOrigin);
  const raw = (purchaseTxSigRaw || '').trim();

  if (normalizeTicketOrigin(ticketOrigin) === TICKET_ORIGIN_CLAIM) {
    const expected = await ensureClaimPurchaseTxSig(supabase, ticketId, {
      id: ticketId,
      purchase_tx_sig: purchaseTxSigRaw,
      ticket_origin: ticketOrigin,
    } as TicketRollRow);
    return expected;
  }

  const lookupSigs = raw === canonical || !raw ? [canonical] : [raw, canonical];

  for (const qSig of lookupSigs) {
    const { data: rolled } = await supabase
      .from('tickets')
      .select('kind_roll_tx_sig')
      .eq('purchase_tx_sig', qSig)
      .not('kind_roll_tx_sig', 'is', null)
      .neq('id', ticketId)
      .limit(1)
      .maybeSingle();
    const rollSig = (rolled?.kind_roll_tx_sig || '').trim();
    if (!rollSig) continue;
    const parsed = await parseKindRolledFromTx(rollSig);
    if (!parsed || parsed.origin !== ROLL_ORIGIN_PURCHASE) continue;
    let chainSig: string;
    try {
      chainSig = bs58.encode(Buffer.from(parsed.purchaseTxSig));
    } catch {
      continue;
    }
    if (chainSig === canonical) continue;
    const v = await verifyPurchaseTxForRoll(chainSig, buyerWallet);
    if (!v.ok) continue;
    await supabase.from('tickets').update({ purchase_tx_sig: chainSig }).eq('id', ticketId);
    return chainSig;
  }

  if (canonical !== raw && raw) {
    await supabase.from('tickets').update({ purchase_tx_sig: canonical }).eq('id', ticketId);
  }
  return canonical;
}

/** Prize child ticket: roll tx is for this ticket_id + owner; claim ref comes from draw_ticket_prizes. */
export async function isClaimChildKindRollValid(
  supabase: SupabaseClient,
  row: TicketRollRow,
  parsed: ParsedKindRolledV2
): Promise<boolean> {
  if (normalizeTicketOrigin(row.ticket_origin) !== TICKET_ORIGIN_CLAIM) return false;
  if (Math.trunc(row.id) !== Math.trunc(parsed.ticketId)) return false;
  if (parsed.origin !== ROLL_ORIGIN_CLAIM) return false;
  const wallet = (row.owner_wallet || '').trim();
  const buyer = buyerBase58FromParsed(parsed);
  if (!wallet || !buyer || wallet !== buyer) return false;
  const { data: prize, error } = await supabase
    .from('draw_ticket_prizes')
    .select('id')
    .eq('mint_child_ticket_id', row.id)
    .maybeSingle();
  if (error) {
    console.warn('isClaimChildKindRollValid:', error.message);
    return false;
  }
  return !!prize?.id;
}

/**
 * Persist claim prize roll when strict entropy check fails but tx is clearly for this child ticket.
 * Keeps canonical `claim:{prizeId}` in DB (from draw_ticket_prizes).
 */
export async function persistClaimChildKindRoll(
  supabase: SupabaseClient,
  ticketId: number,
  parsed: ParsedKindRolledV2,
  rollTxSig: string
): Promise<boolean> {
  const { data: row, error: rowErr } = await supabase
    .from('tickets')
    .select(
      'id,owner_wallet,ticket_kind,ticket_origin,ticket_serial,purchase_tx_sig,purchase_amount_gift_equiv,purchase_amount,kind_roll_tx_sig'
    )
    .eq('id', ticketId)
    .maybeSingle();
  if (rowErr || !row) return false;
  if (!(await isClaimChildKindRollValid(supabase, row as TicketRollRow, parsed))) return false;

  const { data: prize } = await supabase
    .from('draw_ticket_prizes')
    .select('id')
    .eq('mint_child_ticket_id', ticketId)
    .maybeSingle();
  if (!prize?.id) return false;

  const claimRef = `claim:${String(prize.id)}`;
  const gift = giftAmountFromMicro(parsed.giftAmountMicro);
  const { error: patchErr } = await supabase
    .from('tickets')
    .update({
      purchase_tx_sig: claimRef,
      ticket_serial: parsed.ticketSerial,
      ticket_origin: TICKET_ORIGIN_CLAIM,
      purchase_amount: gift,
      purchase_amount_gift_equiv: gift,
      ticket_kind: parsed.kind,
      sync_error: null,
    })
    .eq('id', ticketId);
  if (patchErr) {
    console.error('persistClaimChildKindRoll patch:', patchErr);
    return false;
  }

  await persistKindRollAudit(supabase, ticketId, parsed, rollTxSig);
  return true;
}

export async function verifyTicketKindRollOnChain(
  row: TicketRollRow,
  supabase?: SupabaseClient
): Promise<{
  ok: true;
  parsed: ParsedKindRolledV2;
} | { ok: false; error: string }> {
  const sig = (row.kind_roll_tx_sig || '').trim();
  if (!sig) return { ok: false, error: 'No kind_roll_tx_sig' };

  const parsed = await parseKindRolledFromTx(sig, { expectedTicketId: Number(row.id) });
  if (!parsed) return { ok: false, error: 'KindRolledV2 not found in roll transaction' };

  const err = ticketMatchesKindRolledV2(row, parsed);
  if (!err) return { ok: true, parsed };
  if (
    supabase &&
    err === CLAIM_PURCHASE_SIG_MISMATCH &&
    (await isClaimChildKindRollValid(supabase, row, parsed))
  ) {
    return { ok: true, parsed };
  }
  return { ok: false, error: err };
}

/**
 * Claim/prize recovery: align DB row with a confirmed on-chain KindRolledV2 and persist audit.
 * Used when strict ticketMatches failed but the roll tx is valid for this ticket_id.
 */
export async function forcePersistKindRollFromParsed(
  supabase: SupabaseClient,
  ticketId: number,
  parsed: ParsedKindRolledV2,
  rollTxSig: string,
  opts?: { purchaseTxSigHint?: string }
): Promise<boolean> {
  if (Math.trunc(ticketId) !== Math.trunc(parsed.ticketId)) return false;

  const { data: row } = await supabase
    .from('tickets')
    .select(
      'id,owner_wallet,ticket_kind,ticket_origin,ticket_serial,purchase_tx_sig,purchase_amount_gift_equiv,purchase_amount,kind_roll_tx_sig'
    )
    .eq('id', ticketId)
    .maybeSingle();
  if (!row) return false;

  let purchaseTxSig = (opts?.purchaseTxSigHint || '').trim();
  if (!purchaseTxSig || !purchaseSigMatchesEntropy(purchaseTxSig, parsed.purchaseTxSig)) {
    purchaseTxSig =
      (await resolvePurchaseTxSigForParsedEntropy(supabase, row as TicketRollRow, parsed)) || '';
  }
  if (!purchaseTxSig) return false;

  const gift = giftAmountFromMicro(parsed.giftAmountMicro);
  const ticketOrigin =
    parsed.origin === ROLL_ORIGIN_CLAIM ? TICKET_ORIGIN_CLAIM : TICKET_ORIGIN_PURCHASE;
  const { error: patchErr } = await supabase
    .from('tickets')
    .update({
      purchase_tx_sig: purchaseTxSig,
      ticket_serial: parsed.ticketSerial,
      ticket_origin: ticketOrigin,
      purchase_amount: gift,
      purchase_amount_gift_equiv: gift,
      ticket_kind: parsed.kind,
      sync_error: null,
    })
    .eq('id', ticketId);
  if (patchErr) {
    console.error('forcePersistKindRollFromParsed patch:', patchErr);
    return false;
  }

  const patchedRow: TicketRollRow = {
    id: ticketId,
    owner_wallet: buyerBase58FromParsed(parsed),
    ticket_kind: parsed.kind,
    ticket_origin: ticketOrigin,
    ticket_serial: parsed.ticketSerial,
    purchase_tx_sig: purchaseTxSig,
    purchase_amount: gift,
    purchase_amount_gift_equiv: gift,
    kind_roll_tx_sig: null,
  };
  let err = ticketMatchesKindRolledV2(patchedRow, parsed);
  if (err && (await isClaimChildKindRollValid(supabase, patchedRow, parsed))) {
    await persistKindRollAudit(supabase, ticketId, parsed, rollTxSig);
    return true;
  }
  if (err) {
    console.warn('forcePersistKindRollFromParsed: still mismatch after patch', err);
    return false;
  }

  await persistKindRollAudit(supabase, ticketId, parsed, rollTxSig);
  return true;
}

export async function persistKindRollAudit(
  supabase: SupabaseClient,
  ticketId: number,
  parsed: ParsedKindRolledV2,
  rollTxSig: string
): Promise<void> {
  const { error } = await supabase
    .from('tickets')
    .update({
      ticket_kind: parsed.kind,
      kind_roll_tx_sig: rollTxSig,
      kind_roll_roll: parsed.roll,
      kind_roll_slot: parsed.slot,
      kind_roll_gift_micro: parsed.giftAmountMicro.toString(),
      kind_roll_origin: parsed.origin,
      kind_roll_verified_at: new Date().toISOString(),
      weight: ticketKindDrawWeight(parsed.kind),
    })
    .eq('id', ticketId);
  if (error) throw new Error(error.message);
}

export function formatKindRolledForApi(parsed: ParsedKindRolledV2, rollTxSig: string) {
  return {
    ticketId: parsed.ticketId,
    ticketSerial: parsed.ticketSerial,
    kind: parsed.kind,
    roll: parsed.roll,
    slot: parsed.slot,
    origin: parsed.origin,
    giftAmountGift: giftAmountFromMicro(parsed.giftAmountMicro),
    giftAmountMicro: parsed.giftAmountMicro.toString(),
    buyer: parsed.buyer.toBase58(),
    purchaseTxSigBase58:
      parsed.origin === ROLL_ORIGIN_CLAIM
        ? null
        : bs58.encode(Buffer.from(parsed.purchaseTxSig)),
    registryVersion: parsed.registryVersion,
    projectTag: parsed.projectTag,
    kindRollTxSig: rollTxSig,
  };
}
