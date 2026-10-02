/**
 * Decode the roll events in a roll transaction — and recompute each roll from scratch.
 *
 * Reading the event only tells you what the program said. This also re-derives the roll with the
 * same SHA-256 the program uses, from inputs it takes from the cluster itself, so you can see that
 * the ticket kind follows from the payment transaction and nothing else:
 *
 *   - `KindRolledV3` (spec v22): payment signature, ticket index, the slot the payment landed in and
 *     that block's blockhash. The slot and blockhash are fetched from your RPC and must equal what
 *     the event carries. The buyer signs before that block exists, so grinding the signature cannot
 *     pick the kind.
 *   - `KindRolledV2` (spec v19–v21, before the blockhash was added): signature, index and slot.
 *   - Claim rolls (prize tickets, origin 1) have no payment: slot 0 and a zero blockhash.
 *
 * Usage:
 *   npx tsx scripts/decode-kind-rolled.ts <ROLL_TX_SIGNATURE>
 *   npx tsx scripts/decode-kind-rolled.ts --data "<PROGRAM_DATA_BASE64>"   # copied from Solscan
 */
import bs58 from 'bs58';
import { purchasableKindFromRoll, purchasableKindFromKindCode } from '../src/lib/on-chain-gift-draw/kind.js';
import { giftAmountFromMicro } from '../server/lib/gift-amount-micro.js';
import {
  decodeKindRolled,
  fetchPurchaseRollInputs,
  fetchRollEvents,
  rollFromInputs,
  rpcUrl,
  solscanTx,
  type KindRolled,
} from './lib/chain.js';

const CLAIM_ORIGIN = 1;
const ZERO_BLOCKHASH = Buffer.alloc(32);

const mark = (ok: boolean) => (ok ? '✓ matches' : '✗ MISMATCH');

/** Slot and blockhash the roll must have used, per the cluster (or the fixed claim values). */
async function expectedInputs(ev: KindRolled): Promise<{ slot: bigint; blockhash: Buffer | null } | { error: string }> {
  if (ev.origin === CLAIM_ORIGIN) return { slot: 0n, blockhash: ev.version === 3 ? ZERO_BLOCKHASH : null };
  const res = await fetchPurchaseRollInputs(bs58.encode(ev.purchaseTxSig));
  if ('error' in res) return res;
  return { slot: res.slot, blockhash: ev.version === 3 ? res.blockhash : null };
}

async function report(ev: KindRolled, index: number, total: number): Promise<boolean> {
  const kindFromRoll = purchasableKindFromRoll(ev.roll);
  const kindFromCode = purchasableKindFromKindCode(ev.kind);
  const kindOk = kindFromRoll === kindFromCode;

  if (total > 1) console.log(`\n--- event ${index + 1} of ${total} ---`);
  console.log(ev.version === 3 ? 'KindRolledV3' : 'KindRolledV2 (spec v21 or earlier — no blockhash in the roll)');
  console.log('  ticket_id:     ', ev.ticketId.toString());
  console.log('  ticket_serial: ', ev.ticketSerial.toString());
  console.log('  kind:          ', kindFromCode, `(code ${ev.kind})`);
  console.log('  roll:          ', ev.roll, '/ 100000');
  console.log('  origin:        ', ev.origin, ev.origin === CLAIM_ORIGIN ? '(claim)' : '(purchase)');
  console.log('  gift_micro:    ', ev.giftAmountMicro.toString(), `(${giftAmountFromMicro(ev.giftAmountMicro)} GIFT)`);
  console.log('  buyer:         ', ev.buyer);
  console.log('  ticket_index:  ', ev.ticketIndex);
  console.log('  slot:          ', ev.slot.toString());
  if (ev.purchaseBlockhash) console.log('  blockhash:     ', bs58.encode(ev.purchaseBlockhash));
  console.log('  registry_ver:  ', ev.registryVersion);
  console.log('  project_tag:   ', '0x' + ev.projectTag.toString(16));
  console.log('  purchase_tx:   ', ev.origin === CLAIM_ORIGIN ? '(claim reference hash)' : bs58.encode(ev.purchaseTxSig));
  console.log('');

  const versionOk = ev.version === 3 ? ev.registryVersion >= 22 : ev.registryVersion < 22;
  if (!versionOk) console.log(`  registry_ver:   ✗ ${ev.registryVersion} does not belong to this event version`);

  const expected = await expectedInputs(ev);
  if ('error' in expected) {
    console.log(`  purchase:       ✗ ${expected.error}`);
    return false;
  }
  const slotOk = expected.slot === ev.slot;
  const source = ev.origin === CLAIM_ORIGIN ? 'claim rolls use 0' : `payment landed in slot ${expected.slot} (${rpcUrl()})`;
  console.log('  slot:           ', mark(slotOk), `— ${source}`);
  let blockhashOk = true;
  if (ev.version === 3 && ev.purchaseBlockhash && expected.blockhash) {
    blockhashOk = ev.purchaseBlockhash.equals(expected.blockhash);
    const what =
      ev.origin === CLAIM_ORIGIN
        ? 'claim rolls use 32 zero bytes'
        : `getBlock(${expected.slot}).blockhash = ${bs58.encode(expected.blockhash)}`;
    console.log('  blockhash:      ', mark(blockhashOk), `— ${what}`);
  }

  // Recompute from the cluster's inputs, not the event's: a matching roll then proves both.
  const recomputedRoll = rollFromInputs(ev.purchaseTxSig, ev.ticketIndex, expected.slot, expected.blockhash);
  const rollOk = recomputedRoll === ev.roll;
  console.log('  recomputed roll:', recomputedRoll, mark(rollOk));
  console.log('  kind from roll: ', kindFromRoll, mark(kindOk));

  return versionOk && slotOk && blockhashOk && rollOk && kindOk;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('Usage: npx tsx scripts/decode-kind-rolled.ts <ROLL_TX_SIGNATURE>');
    console.error('   or: npx tsx scripts/decode-kind-rolled.ts --data "<PROGRAM_DATA_BASE64>"');
    process.exit(1);
  }

  if (argv[0] === '--data') {
    const b64 = (argv[1] || '').trim();
    if (!b64) throw new Error('Missing base64 after --data');
    const ev = decodeKindRolled(b64);
    if (!ev) throw new Error('Not a KindRolledV3 / KindRolledV2 event (wrong discriminator or corrupt data)');
    process.exit((await report(ev, 0, 1)) ? 0 : 1);
  }

  const sig = argv[0].trim();
  const events = await fetchRollEvents(sig);
  if (events.length === 0) {
    throw new Error(`No roll event in ${solscanTx(sig)} — is this a roll_kind transaction?`);
  }
  let allOk = true;
  for (let i = 0; i < events.length; i++) {
    if (!(await report(events[i], i, events.length))) allOk = false;
  }
  if (events.length > 1) {
    console.log(`\n${events.length} tickets rolled in this transaction (batched roll).`);
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
