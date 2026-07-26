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
import {
  buildPrizeCommitRowsFromDb,
  SETTLEMENT_SPEC_VERSION_PRIZES,
  settlementCommitHashHex,
} from '../server/lib/settlement-commit-hash.js';
import { fetchDrawCommit, solscanAccount } from './lib/chain.js';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? (process.argv[i + 1] || '').trim() : '';
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

type SettlementExport = {
  drawId: string;
  specVersion: number;
  seedHex: string;
  merkleRootHex: string;
  prizes: Array<{
    ticket_id: number;
    prize_bucket: string;
    rank: number | null;
    gift_amount: number | string | null;
  }>;
};

async function main() {
  const file = arg('--file');
  const data = JSON.parse(readFileSync(file, 'utf8')) as SettlementExport;

  const drawId = String(data.drawId || '').trim();
  const specVersion = Number(data.specVersion);
  const seedHex = String(data.seedHex || '').trim();
  const merkleRootHex = String(data.merkleRootHex || '').trim();
  const prizes = data.prizes || [];
  if (!drawId || !specVersion || !seedHex || !merkleRootHex || !prizes.length) {
    throw new Error('export must contain drawId, specVersion, seedHex, merkleRootHex and prizes');
  }

  const prizeCommitRows = buildPrizeCommitRowsFromDb(prizes);
  const winnerTicketIds = [
    ...new Set(prizes.map((p) => Number(p.ticket_id)).filter((id) => Number.isFinite(id) && id > 0)),
  ];

  const expected =
    specVersion >= SETTLEMENT_SPEC_VERSION_PRIZES
      ? settlementCommitHashHex(drawId, specVersion, seedHex, merkleRootHex, { prizeCommitRows })
      : settlementCommitHashHex(drawId, specVersion, seedHex, merkleRootHex, { winnerTicketIds });

  const commit = await fetchDrawCommit(drawId);
  if (!commit) throw new Error(`No DrawCommit account on-chain for draw ${drawId}`);

  const hashOk = commit.settlementHashHex === expected;
  const winnerCountOk = commit.winnerCount === winnerTicketIds.length;
  const seedOk = commit.seedHex === seedHex;
  const merkleOk = commit.merkleRootHex === merkleRootHex;
  const specOk = commit.specVersion === specVersion;
  const ok = hashOk && winnerCountOk && seedOk && merkleOk && specOk;

  console.log(
    JSON.stringify(
      {
        drawId,
        ok,
        hashOk,
        winnerCountOk,
        seedOk,
        merkleOk,
        specOk,
        specVersion,
        onChainSpecVersion: commit.specVersion,
        distinctWinnerTickets: winnerTicketIds.length,
        onChainWinnerCount: commit.winnerCount,
        prizeRowCount: prizeCommitRows.length,
        recomputedHash: expected,
        onChainHash: commit.settlementHashHex,
        drawCommitPda: commit.pda,
        solscan: solscanAccount(commit.pda),
      },
      null,
      2
    )
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
