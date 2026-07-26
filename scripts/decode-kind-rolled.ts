/**
 * Decode the `KindRolledV2` events in a roll transaction — and recompute each roll from scratch.
 *
 * Reading the event only tells you what the program said. This also re-derives the roll from the
 * payment signature, ticket index and slot with the same SHA-256 the program uses, so you can see
 * that the ticket kind follows from the payment transaction and nothing else. `rollOk: true` means
 * the emitted number is the hash — it was not chosen.
 *
 * Usage:
 *   npx tsx scripts/decode-kind-rolled.ts <ROLL_TX_SIGNATURE>
 *   npx tsx scripts/decode-kind-rolled.ts --data "<PROGRAM_DATA_BASE64>"   # copied from Solscan
 */
import bs58 from 'bs58';
import { purchasableKindFromRoll, purchasableKindFromKindCode } from '../src/lib/on-chain-gift-draw/kind.js';
import { giftAmountFromMicro } from '../server/lib/gift-amount-micro.js';
import {
  decodeKindRolledV2,
  fetchRollEvents,
  rollFromInputs,
  solscanTx,
  type KindRolledV2,
} from './lib/chain.js';

/** `slot = 0` marks a claim roll: there is no purchase transaction to bind it to. */
const CLAIM_ORIGIN = 1;

function report(ev: KindRolledV2, index: number, total: number) {
  const recomputedRoll = rollFromInputs(ev.purchaseTxSig, ev.ticketIndex, ev.slot);
  const rollOk = recomputedRoll === ev.roll;
  const kindFromRoll = purchasableKindFromRoll(ev.roll);
  const kindFromCode = purchasableKindFromKindCode(ev.kind);
  const kindOk = kindFromRoll === kindFromCode;

  if (total > 1) console.log(`\n--- event ${index + 1} of ${total} ---`);
  console.log('KindRolledV2');
  console.log('  ticket_id:     ', ev.ticketId.toString());
  console.log('  ticket_serial: ', ev.ticketSerial.toString());
  console.log('  kind:          ', kindFromCode, `(code ${ev.kind})`);
  console.log('  roll:          ', ev.roll, '/ 100000');
  console.log('  origin:        ', ev.origin, ev.origin === CLAIM_ORIGIN ? '(claim)' : '(purchase)');
  console.log('  gift_micro:    ', ev.giftAmountMicro.toString(), `(${giftAmountFromMicro(ev.giftAmountMicro)} GIFT)`);
  console.log('  buyer:         ', ev.buyer);
  console.log('  ticket_index:  ', ev.ticketIndex);
  console.log('  slot:          ', ev.slot.toString());
  console.log('  registry_ver:  ', ev.registryVersion);
  console.log('  project_tag:   ', '0x' + ev.projectTag.toString(16));
  console.log('  purchase_tx:   ', bs58.encode(ev.purchaseTxSig));
  console.log('');
  console.log('  recomputed roll:', recomputedRoll, rollOk ? '✓ matches' : '✗ MISMATCH');
  console.log('  kind from roll: ', kindFromRoll, kindOk ? '✓ matches' : '✗ MISMATCH');

  return rollOk && kindOk;
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
    const ev = decodeKindRolledV2(b64);
    if (!ev) throw new Error('Not a KindRolledV2 event (wrong discriminator or corrupt data)');
    process.exit(report(ev, 0, 1) ? 0 : 1);
  }

  const sig = argv[0].trim();
  const events = await fetchRollEvents(sig);
  if (events.length === 0) {
    throw new Error(`No KindRolledV2 in ${solscanTx(sig)} — is this a roll_kind transaction?`);
  }
  let allOk = true;
  events.forEach((ev, i) => {
    if (!report(ev, i, events.length)) allOk = false;
  });
  if (events.length > 1) {
    console.log(`\n${events.length} tickets rolled in this transaction (batched roll).`);
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
