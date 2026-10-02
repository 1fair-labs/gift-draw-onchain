/**
 * Recompute a draw's settlement seed from on-chain data alone and compare it to the committed one.
 *
 * 1. The base seed: SHA256(drawId | periodEndIso | entrant_list_hash), from the arguments of the
 *    `draw_randomness` transaction that sealed the entrant list — must equal `DrawSeed.seed`.
 * 2. Spec 21 and later: the slot entropy. `DrawEntropy` names the slot whose hash was mixed in; the
 *    seed must be SHA256(base_seed ‖ slot u64 LE ‖ slot_hash), the target slot must be two slots
 *    after the sealing transaction (unless the draw was visibly re-armed), and the slot used must
 *    not come before the target. Nobody could know that slot's hash when the list was sealed.
 * 3. The seed the draw was settled with (`DrawCommit.seed`) must be that final seed.
 *
 * `slot_hash` is the value the program itself read from the SlotHashes sysvar in the reveal
 * transaction; `verify-program-binary` is what ties that program to the published source.
 *
 * Usage:
 *   npx tsx scripts/verify-seed.ts --drawId 20260925
 */
import { checkSeed } from './lib/checks.js';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? (process.argv[i + 1] || '').trim() : '';
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function main() {
  const { drawSeedSolscan: _seed, drawCommitSolscan: _commit, ...result } = await checkSeed(arg('--drawId'));
  console.log(JSON.stringify(result, null, 2));

  if (result.specVersion >= 21 && !result.entropy?.revealed) {
    console.error('\nThe entrant list is sealed but the slot entropy is not revealed yet — the draw is still running.');
  } else if (result.entropy && result.entropy.rearmCount > 0) {
    console.error(
      `\nThis draw was re-armed ${result.entropy.rearmCount} time(s): nobody revealed within the ~512-slot window,\n` +
        'so the target slot was moved. The seed still checks out, but the target is no longer pinned to\n' +
        'the sealing transaction — see "Missed window" in docs/SETTLEMENT-SPEC.md.'
    );
  }
  if (!result.committedSeed) console.error('\nNo DrawCommit yet — the result has not been committed.');
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
