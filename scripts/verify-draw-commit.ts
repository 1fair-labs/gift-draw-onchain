/**
 * Verify on-chain DrawCommit matches off-chain settlement export.
 *
 * Usage:
 *   npx tsx scripts/verify-draw-commit.ts --drawId 20260528
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchDrawCommit } from '../server/lib/gift-draw-registry-client.js';
import {
  buildPrizeCommitRowsFromDb,
  SETTLEMENT_SPEC_VERSION_PRIZES,
  settlementCommitHashHex,
} from '../server/lib/settlement-commit-hash.js';
import { SETTLEMENT_SPEC_VERSION } from '../server/lib/draw-settlement.js';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`);
  return process.argv[i + 1].trim();
}

async function main() {
  const drawId = arg('--drawId');
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data: settlement, error } = await supabase
    .from('draw_settlements')
    .select('random_seed_hex,merkle_root_hex,spec_version')
    .eq('draw_id', drawId)
    .eq('status', 'completed')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!settlement) throw new Error('No completed settlement for draw');

  const specVersion = Number(settlement.spec_version) || SETTLEMENT_SPEC_VERSION;
  const seedHex = String(settlement.random_seed_hex);
  const merkleHex = String(settlement.merkle_root_hex);

  const { data: prizes } = await supabase
    .from('draw_ticket_prizes')
    .select('ticket_id,prize_bucket,rank,gift_amount')
    .eq('draw_id', drawId);

  const prizeRows = buildPrizeCommitRowsFromDb(prizes || []);
  const winnerTicketIds = [
    ...new Set(
      (prizes || [])
        .map((p) => Number((p as { ticket_id?: number }).ticket_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];

  const expected =
    specVersion >= SETTLEMENT_SPEC_VERSION_PRIZES
      ? settlementCommitHashHex(drawId, specVersion, seedHex, merkleHex, { prizeCommitRows: prizeRows })
      : settlementCommitHashHex(drawId, specVersion, seedHex, merkleHex, { winnerTicketIds });

  const commit = await fetchDrawCommit(drawId);
  if (!commit) throw new Error('DrawCommit account not found on-chain');

  const onChain = Buffer.from(commit.settlementHash).toString('hex');
  const ok = onChain === expected;
  console.log(
    JSON.stringify(
      {
        drawId,
        specVersion,
        ok,
        onChain,
        expected,
        prizeSlotCount: prizeRows.length,
        distinctWinnerTickets: winnerTicketIds.length,
      },
      null,
      2
    )
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
