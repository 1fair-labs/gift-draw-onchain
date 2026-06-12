import type { SupabaseClient } from '@supabase/supabase-js';
import type { DrawScheduleMode } from './draw-schedule.js';
import {
  prepareVerifiedDrawEntrantIds,
  settleDrawById,
  SETTLEMENT_SPEC_VERSION,
  type SettleDrawOptions,
  type SettleDrawResult,
} from './draw-settlement.js';
import { merkleRootFromTicketIds, settlementSeedHex } from './lottery-settlement-seed.js';
import { resolvePeriodBoundsForDrawId } from './draw-period-bounds-resolve.js';
import { settlementCommitHashBytes } from './settlement-commit-hash.js';
import {
  fetchDrawSeedHex,
  isRegistryEnabled,
  sendCommitDrawResultTx,
  sendDrawRandomnessTx,
} from './gift-draw-registry-client.js';

/**
 * Anchored settlement: verify entrants → draw_randomness → settle v17 with chain seed → commit_draw_result.
 */
export async function settleDrawByIdAnchored(
  supabase: SupabaseClient,
  drawId: string,
  mode: DrawScheduleMode,
  options?: SettleDrawOptions
): Promise<SettleDrawResult> {
  if (!isRegistryEnabled()) {
    return {
      ok: false,
      error: 'On-chain gift_draw_registry is required for settlement',
    };
  }

  const bounds = await resolvePeriodBoundsForDrawId(supabase, drawId, mode);
  if (!bounds) return { ok: false, error: 'Invalid draw_id for schedule mode' };
  const periodEndIso = bounds.periodEnd.toISOString();

  const includeUsed = options?.includeUsedTickets === true;
  const { sortedIds } = await prepareVerifiedDrawEntrantIds(supabase, drawId, includeUsed);
  if (!sortedIds.length) {
    return settleDrawById(supabase, drawId, mode, options);
  }
  const merkleRootHex = merkleRootFromTicketIds([...sortedIds]);

  try {
    await sendDrawRandomnessTx({
      drawId,
      periodEndIso,
      merkleRootHex,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'draw_randomness failed';
    if (!/already in use|AccountDiscriminator|0x0/i.test(msg)) {
      return { ok: false, error: msg };
    }
  }

  const chainSeedHex = await fetchDrawSeedHex(drawId);
  const expectedSeed = settlementSeedHex(drawId, periodEndIso, sortedIds, {
    rerollNonce: options?.freshShuffleNonce ?? null,
  });
  const seedHex = chainSeedHex || expectedSeed;
  if (chainSeedHex && chainSeedHex !== expectedSeed && !options?.freshShuffleNonce) {
    return { ok: false, error: 'On-chain draw seed does not match settlement formula' };
  }

  const result = await settleDrawById(supabase, drawId, mode, {
    ...options,
    seedHexOverride: seedHex,
  });

  if (!result.ok || result.skipped) return result;
  if (!result.winnerTicketIds?.length) return result;

  try {
    const specVersion = SETTLEMENT_SPEC_VERSION;
    const hash = settlementCommitHashBytes(drawId, specVersion, result.seedHex || seedHex, result.merkleRootHex || merkleRootHex, {
      winnerTicketIds: result.winnerTicketIds,
      prizeCommitRows: result.prizeCommitRows,
    });
    await sendCommitDrawResultTx({
      drawId,
      settlementHash: hash,
      winnerCount: result.winnerTicketIds.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'commit_draw_result failed';
    console.error('commit_draw_result:', msg);
    return { ok: false, error: msg };
  }

  return result;
}
