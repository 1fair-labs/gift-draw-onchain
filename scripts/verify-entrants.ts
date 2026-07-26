/**
 * Check the published entrant list of a draw against the seed committed on-chain.
 *
 * Needs nothing but a network connection: the entrant list comes from the site's public API,
 * the commitment comes from Solana. If the operator ever publishes a list that differs from the
 * one the draw actually ran on, the hashes stop matching — and the on-chain one was written
 * before the draw closed, so it is the list that cannot be edited afterwards.
 *
 * Usage:
 *   npx tsx scripts/verify-entrants.ts --drawId 20260720
 *   npx tsx scripts/verify-entrants.ts --drawId 20260720 --api https://www.giftdraw.today
 */
import { merkleRootFromTicketIds } from '../server/lib/draw-settlement-seed.js';
import { isCommittedDrawEntrant } from '../server/lib/draw-entrant-rules.js';
import { fetchDrawSeed, solscanAccount } from './lib/chain.js';

const DEFAULT_API = 'https://www.giftdraw.today';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? (process.argv[i + 1] || '').trim() : '';
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
}

type PublishedTicket = {
  id: number;
  ticket_kind: string | null;
  ticket_origin: string | null;
  has_purchase_tx: boolean;
  has_kind_roll: boolean;
  kind_roll_verified: boolean;
  excluded_reason: string | null;
};

type EntrantsResponse = {
  ok?: boolean;
  error?: string;
  drawId: string;
  entrantCount: number;
  excludedCount?: number;
  entrantDataAvailable?: boolean;
  sortedTicketIds: number[];
  allTickets?: PublishedTicket[];
  merkleRootHex: string;
};

async function main() {
  const drawId = arg('--drawId');
  const api = arg('--api', DEFAULT_API).replace(/\/+$/, '');

  const url = `${api}/api/draws?action=entrants&drawId=${encodeURIComponent(drawId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const published = (await res.json()) as EntrantsResponse;
  if (published.ok === false) throw new Error(published.error || 'entrants request failed');

  const publishedIds = (published.sortedTicketIds || []).map(Number).sort((a, b) => a - b);

  // 1. The published list must hash to the published root — recomputed here with the same
  //    function the settlement uses (server/lib/draw-settlement-seed.ts, verbatim).
  const recomputedHex = merkleRootFromTicketIds(publishedIds);
  const listHashOk = recomputedHex === published.merkleRootHex;

  // 2. That root must equal the one committed on-chain before the draw closed.
  const seed = await fetchDrawSeed(drawId);
  const onChainOk = seed ? seed.merkleRootHex === recomputedHex : null;

  // 3. Re-apply the entrant rule to the raw ticket rows: the endpoint's own filtering is not
  //    taken on trust. Skipped if the API did not return `allTickets`.
  let filterOk: boolean | null = null;
  let rederivedCount: number | null = null;
  if (Array.isArray(published.allTickets)) {
    const rederived = published.allTickets
      .filter((t) =>
        isCommittedDrawEntrant({
          ticket_kind: t.ticket_kind,
          ticket_origin: t.ticket_origin,
          // The API publishes presence, not the values themselves: a signature would identify
          // the payer. Presence is all the rule reads.
          purchase_tx_sig: t.has_purchase_tx ? 'present' : null,
          kind_roll_tx_sig: t.has_kind_roll ? 'present' : null,
          kind_roll_verified_at: t.kind_roll_verified ? 'present' : null,
          sync_error: t.excluded_reason,
        })
      )
      .map((t) => Number(t.id))
      .sort((a, b) => a - b);
    rederivedCount = rederived.length;
    filterOk = rederived.join(',') === publishedIds.join(',');
  }

  // A draw whose entrant list is not published cannot be checked either way. Calling that a
  // mismatch would be reporting the operator as caught out on the strength of absent data.
  const entrantDataAvailable =
    published.entrantDataAvailable ?? (published.allTickets?.length ?? publishedIds.length) > 0;
  const listGone = seed !== null && !entrantDataAvailable && onChainOk === false;

  const result: 'match' | 'mismatch' | 'entrant-list-not-published' | 'not-committed' = !seed
    ? 'not-committed'
    : listGone
      ? 'entrant-list-not-published'
      : onChainOk === true && listHashOk && filterOk !== false
        ? 'match'
        : 'mismatch';
  const ok = result === 'match';

  console.log(
    JSON.stringify(
      {
        drawId,
        ok,
        result,
        listHashOk,
        onChainOk,
        filterOk,
        entrantCount: publishedIds.length,
        excludedCount: published.excludedCount ?? null,
        rederivedEntrantCount: rederivedCount,
        recomputedRoot: recomputedHex,
        publishedRoot: published.merkleRootHex,
        onChainRoot: seed?.merkleRootHex ?? null,
        drawSeedPda: seed?.pda ?? null,
        solscan: seed ? solscanAccount(seed.pda) : null,
      },
      null,
      2
    )
  );

  if (!seed) {
    console.error('\nNo DrawSeed account on-chain for this draw id — nothing was committed (yet).');
  } else if (listGone) {
    console.error(
      '\nThis draw has a commitment on-chain, but no entrant list is published for it, so there\n' +
        'is nothing to check the commitment against. That is not evidence of a mismatch — and not\n' +
        'evidence of a match either. Try a recent completed draw.'
    );
  } else if (listHashOk && onChainOk === false) {
    // Most likely cause by far, and it looks alarming if you do not know to check for it.
    console.error(
      '\nThe published list is internally consistent but does not match the on-chain root.\n' +
        'Check you are on the right cluster for this site: draw commitments are addressed by draw\n' +
        'id alone, so a cluster holds one deployment\'s draws. Reading one cluster\'s commitment\n' +
        'while asking a site that settles elsewhere for its entrants produces exactly this result.'
    );
  }
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
