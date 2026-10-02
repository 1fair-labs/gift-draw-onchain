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
import { checkEntrants, DEFAULT_API } from './lib/checks.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? (process.argv[i + 1] || '').trim() : '';
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
}

async function main() {
  const { entrantsUrl: _url, ...result } = await checkEntrants(arg('--drawId'), arg('--api', DEFAULT_API));
  console.log(JSON.stringify(result, null, 2));

  if (result.result === 'not-committed') {
    console.error('\nNo DrawSeed account on-chain for this draw id — nothing was committed (yet).');
  } else if (result.result === 'entrant-list-not-published') {
    console.error(
      '\nThis draw has a commitment on-chain, but no entrant list is published for it, so there\n' +
        'is nothing to check the commitment against. That is not evidence of a mismatch — and not\n' +
        'evidence of a match either. Try a recent completed draw.'
    );
  } else if (result.listHashOk && result.onChainOk === false) {
    // Most likely cause by far, and it looks alarming if you do not know to check for it.
    console.error(
      '\nThe published list is internally consistent but does not match the on-chain root.\n' +
        'Check you are on the right cluster for this site: draw commitments are addressed by draw\n' +
        'id alone, so a cluster holds one deployment\'s draws. Reading one cluster\'s commitment\n' +
        'while asking a site that settles elsewhere for its entrants produces exactly this result.'
    );
  }
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
