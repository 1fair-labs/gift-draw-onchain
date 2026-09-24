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
import { entropySeedHex, settlementSeedHexFromListHash } from '../server/lib/draw-settlement-seed.js';
import {
  fetchDrawCommit,
  fetchDrawEntropy,
  fetchDrawSeed,
  fetchSealTransaction,
  solscanAccount,
  solscanTx,
} from './lib/chain.js';

/** Program constant `ENTROPY_DELAY_SLOTS`. */
const ENTROPY_DELAY_SLOTS = 2n;

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? (process.argv[i + 1] || '').trim() : '';
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function main() {
  const drawId = arg('--drawId');

  const seed = await fetchDrawSeed(drawId);
  if (!seed) throw new Error(`No DrawSeed account on-chain for draw ${drawId} — nothing was sealed (yet).`);
  const seal = await fetchSealTransaction(drawId);
  if (!seal) throw new Error(`Could not find the draw_randomness transaction for draw ${drawId}.`);

  const baseSeedHex = settlementSeedHexFromListHash(drawId, seal.periodEndIso, seal.merkleRootHex);
  const baseSeedOk = baseSeedHex === seed.seedHex && seal.merkleRootHex === seed.merkleRootHex;

  let finalSeedHex = seed.seedHex;
  let entropy: Awaited<ReturnType<typeof fetchDrawEntropy>> = null;
  let entropyOk: boolean | null = null;
  let targetSlotOk: boolean | null = null;
  if (seed.specVersion >= 21) {
    entropy = await fetchDrawEntropy(drawId);
    if (entropy?.revealed) {
      const recomputed = entropySeedHex(seed.seedHex, entropy.slot, entropy.slotHashHex);
      entropyOk = recomputed === entropy.seedHex && entropy.slot >= entropy.targetSlot;
      targetSlotOk =
        entropy.rearmCount > 0 ? null : entropy.targetSlot === BigInt(seal.slot) + ENTROPY_DELAY_SLOTS;
      finalSeedHex = entropy.seedHex;
    } else {
      entropyOk = false;
    }
  }

  const commit = await fetchDrawCommit(drawId);
  const commitOk = commit ? commit.seedHex === finalSeedHex && commit.specVersion === seed.specVersion : null;

  const ok = baseSeedOk && entropyOk !== false && targetSlotOk !== false && commitOk !== false;

  console.log(
    JSON.stringify(
      {
        drawId,
        ok,
        specVersion: seed.specVersion,
        baseSeedOk,
        entropyOk,
        targetSlotOk,
        commitOk,
        periodEndIso: seal.periodEndIso,
        entrantListHash: seal.merkleRootHex,
        sealSlot: seal.slot,
        sealTx: solscanTx(seal.signature),
        baseSeed: baseSeedHex,
        entropy: entropy
          ? {
              targetSlot: entropy.targetSlot.toString(),
              slot: entropy.slot.toString(),
              slotHash: entropy.slotHashHex,
              seed: entropy.seedHex,
              revealed: entropy.revealed,
              rearmCount: entropy.rearmCount,
              solscan: solscanAccount(entropy.pda),
            }
          : null,
        finalSeed: finalSeedHex,
        committedSeed: commit?.seedHex ?? null,
      },
      null,
      2
    )
  );

  if (seed.specVersion >= 21 && !entropy?.revealed) {
    console.error('\nThe entrant list is sealed but the slot entropy is not revealed yet — the draw is still running.');
  } else if (entropy && entropy.rearmCount > 0) {
    console.error(
      `\nThis draw was re-armed ${entropy.rearmCount} time(s): nobody revealed within the ~512-slot window,\n` +
        'so the target slot was moved. The seed still checks out, but the target is no longer pinned to\n' +
        'the sealing transaction — see "Missed window" in docs/SETTLEMENT-SPEC.md.'
    );
  }
  if (!commit) console.error('\nNo DrawCommit yet — the result has not been committed.');
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
