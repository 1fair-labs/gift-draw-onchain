/**
 * Decode gift_draw_registry KindRolledV2 from a roll tx or raw "Program data" base64 (Solscan).
 *
 * Usage:
 *   npm run decode-kind-rolled -- <ROLL_TX_SIGNATURE>
 *   npm run decode-kind-rolled -- --data "<PROGRAM_DATA_BASE64>"
 */
import {
  parseKindRolledFromTx,
  parseKindRolledV2ProgramData,
  type ParsedKindRolledV2V2,
} from '../server/lib/gift-draw-registry-client.js';
import { PublicKey } from '@solana/web3.js';
import { giftAmountFromMicro } from '../server/lib/gift-amount-micro.js';

function printParsed(parsed: ParsedKindRolledV2) {
  console.log('KindRolledV2 (decoded)');
  console.log('  ticket_id:   ', parsed.ticketId);
  console.log('  ticket_serial:', parsed.ticketSerial);
  console.log('  kind:        ', parsed.kind);
  console.log('  roll:        ', parsed.roll);
  console.log('  origin:      ', parsed.origin, parsed.origin === 1 ? '(claim)' : '(purchase)');
  console.log('  gift_micro:  ', parsed.giftAmountMicro.toString(), `(${giftAmountFromMicro(parsed.giftAmountMicro)} GIFT)`);
  console.log('  buyer:       ', parsed.buyer instanceof PublicKey ? parsed.buyer.toBase58() : String(parsed.buyer));
  console.log('  ticket_index:', parsed.ticketIndex);
  console.log('  slot:        ', parsed.slot);
  console.log('  registry_ver:', parsed.registryVersion);
  console.log('  project_tag: ', '0x' + parsed.projectTag.toString(16));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('Usage: npm run decode-kind-rolled -- <ROLL_TX_SIGNATURE>');
    console.error('   or: npm run decode-kind-rolled -- --data "<PROGRAM_DATA_BASE64>"');
    process.exit(1);
  }

  if (argv[0] === '--data') {
    const b64 = (argv[1] || '').trim();
    if (!b64) {
      console.error('Missing base64 after --data');
      process.exit(1);
    }
    const parsed = parseKindRolledV2ProgramData(b64);
    if (!parsed) {
      console.error('Not a KindRolledV2 event (wrong discriminator or corrupt data)');
      process.exit(1);
    }
    printParsed(parsed);
    return;
  }

  const sig = argv[0].trim();
  const parsed = await parseKindRolledFromTx(sig);
  if (!parsed) {
    console.error('KindRolledV2 not found in transaction logs. Use a roll_kind tx (Check on Solscan link).');
    process.exit(1);
  }
  printParsed(parsed);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
