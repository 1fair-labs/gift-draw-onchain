/**
 * Recompute a draw's `settlement_hash` from its published results and compare it to the value
 * committed on-chain.
 *
 * The on-chain hash covers every prize row — ticket id, bucket, rank and GIFT amount. Change one
 * number in the results and the hash you compute here stops matching the one already written to
 * Solana. The payout path performs this same check before releasing a prize.
 *
 * Usage:
 *   npx tsx scripts/verify-settlement.ts --file settlement-20260720.json
 *   npx tsx scripts/verify-settlement.ts --drawId 20260720        (export read from the site)
 *   npx tsx scripts/verify-settlement.ts --drawId 20260720 --api https://www.giftdraw.today
 *
 * Expected file shape (see docs/SETTLEMENT-EXPORT.md):
 *   {
 *     "drawId": "20260720",
 *     "specVersion": 19,
 *     "seedHex": "…",            // draw_settlements.random_seed_hex
 *     "merkleRootHex": "…",      // draw_settlements.merkle_root_hex (entrant list hash)
 *     "prizes": [ { "ticket_id": 1, "prize_bucket": "main_gift", "rank": 1, "gift_amount": 12.5 } ]
 *   }
 */
import { readFileSync } from 'fs';
import { checkSettlement, DEFAULT_API, fetchSettlementExport, type SettlementExport } from './lib/checks.js';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || '').trim() : '';
}

async function main() {
  const file = arg('--file');
  const drawId = arg('--drawId');
  if (!file && !drawId) throw new Error('Missing --file or --drawId');
  // A file is checked as it stands; with --drawId the site's own export is the claim under test.
  const data: SettlementExport = file
    ? (JSON.parse(readFileSync(file, 'utf8')) as SettlementExport)
    : await fetchSettlementExport(drawId, arg('--api') || DEFAULT_API);

  const result = await checkSettlement(data);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
