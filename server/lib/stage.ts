/**
 * Stage = which version of the product this deployment IS.
 *
 * The free (airdrop) and paid versions are two Vercel projects built from this one repo, sharing
 * ONE database. They run in parallel: the paid version is piloted/developed while the free one is
 * live. Every row of game state (tickets, draws, jackpot, pool, cNFT trees, SOL ledger) carries a
 * `stage` column, and every query must be scoped to STAGE — see database_stage_split.sql.
 *
 * Shared across stages (never scoped): users, referral links, the unlock ledger.
 */
import { isSolanaDevnet } from './solana-rpc-url.js';
import { isAirdropMode } from './airdrop-mode.js';

export type Stage = 'airdrop' | 'paid';
export type SolanaNetwork = 'devnet' | 'mainnet';

/** The stage this deployment writes to and reads from. Never compute it any other way. */
export const STAGE: Stage = isAirdropMode() ? 'airdrop' : 'paid';

export const IS_PAID_STAGE = STAGE === 'paid';
export const IS_AIRDROP_STAGE = STAGE === 'airdrop';

/** Cluster this deployment settles on. Stamped onto every ticket it creates. */
export const NETWORK: SolanaNetwork = isSolanaDevnet() ? 'devnet' : 'mainnet';

/**
 * Does this deployment own the on-chain draw commitments of its cluster?
 *
 * `DrawSeed` / `DrawCommit` are PDAs seeded by draw id alone (`["draw_seed", "20260720"]`) — there
 * is no stage in the seeds, so one cluster holds exactly one stage's draw accounts. The airdrop
 * stage anchors on devnet and the paid stage on mainnet; a paid deployment piloting on devnet must
 * therefore NOT read those accounts as its own, they belong to the live airdrop stage. Reading them
 * anyway makes the public verification endpoint report a mismatch against a commitment for a draw
 * it never ran, which reads exactly like the operator tampering with results.
 *
 * Ticket rolls are unaffected: `KindRolledV2` is an event in the purchase transaction, not a PDA,
 * so both stages roll on-chain on whatever cluster they run on.
 */
export const STAGE_ANCHORS_DRAWS_ON_CHAIN = IS_PAID_STAGE === (NETWORK === 'mainnet');

/**
 * Namespace a runtime-config key to this stage.
 *
 * `admin_runtime_config` is a flat key/value table shared by both deployments. Without a
 * namespace the paid version would overwrite the free version's pool mode, RPC mode and draw
 * schedule. Airdrop keys keep their bare names (they are already in production); paid keys are
 * prefixed.
 */
export const cfgKey = (key: string): string => (IS_PAID_STAGE ? `paid:${key}` : key);

/** Same, for reading another stage's key explicitly (admin/reporting views). */
export const cfgKeyFor = (stage: Stage, key: string): string =>
  stage === 'paid' ? `paid:${key}` : key;

/**
 * Stages whose settled draws belong in the history the paid app shows.
 *
 * The free stage ran once and is over; it does not come back. Its draws carry the settlement seeds
 * and merkle roots that make those payouts checkable, so hiding them in the paid app would quietly
 * make the whole airdrop unverifiable after the fact — and players who won there go looking for
 * their wins.
 *
 * READ-ONLY history and results only. Anything that writes, or that asks "which draw is running
 * now", must stay on `STAGE` exactly: the two deployments each keep their own active draw for the
 * same period, and widening those would match two rows.
 */
export const HISTORY_STAGES: readonly Stage[] = IS_PAID_STAGE ? ['airdrop', 'paid'] : [STAGE];

/**
 * Guard for endpoints that only exist in one stage — Play Dollar faucet, streaks and levels are
 * airdrop-only; wallet payments and cNFT export are paid-only. Returning an explicit error beats
 * hiding the button in the UI: a stale client or a direct API call must fail loudly, not silently
 * write a row into the wrong stage.
 */
export class WrongStageError extends Error {
  readonly status = 400;
  constructor(feature: string, requiredStage: Stage) {
    super(`${feature} is only available in the ${requiredStage} version (this deployment is ${STAGE})`);
    this.name = 'WrongStageError';
  }
}

export function assertAirdropStage(feature: string): void {
  if (!IS_AIRDROP_STAGE) throw new WrongStageError(feature, 'airdrop');
}

export function assertPaidStage(feature: string): void {
  if (!IS_PAID_STAGE) throw new WrongStageError(feature, 'paid');
}
