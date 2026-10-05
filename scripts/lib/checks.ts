/**
 * The checks themselves, with no printing and no file system — shared by the CLI scripts and the
 * one-click page in `web/`. Both run exactly this code; only how the result is shown differs.
 *
 * Every rule these checks apply comes from the production files this repo mirrors
 * (`server/lib/draw-settlement-seed.ts`, `server/lib/draw-entrant-rules.ts`,
 * `server/lib/settlement-commit-hash.ts`); every on-chain value comes from `./chain.ts`.
 */
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import {
  entrantListHashStreaming,
  entropySeedHex,
  settlementSeedHexFromListHash,
} from '../../server/lib/draw-settlement-seed.js';
import { isCommittedDrawEntrant } from '../../server/lib/draw-entrant-rules.js';
import {
  buildPrizeCommitRowsFromDb,
  SETTLEMENT_SPEC_VERSION_PRIZES,
  settlementCommitHashHex,
} from '../../server/lib/settlement-commit-hash.js';
import {
  connection,
  fetchDrawCommit,
  fetchDrawEntropy,
  fetchDrawSeed,
  fetchSealTransaction,
  programId,
  rpcUrl,
  solscanAccount,
  solscanTx,
} from './chain.js';

export const DEFAULT_API = 'https://www.giftdraw.today';

/* ------------------------------------------------------------------------------------------------
 * 1. The published binary is the deployed program
 * ---------------------------------------------------------------------------------------------- */

/** BPF loader-upgradeable `Program`: u32 tag (2) + programdata address. */
const PROGRAM_ACCOUNT_HEADER = 4;
/** BPF loader-upgradeable `ProgramData`: u32 tag (3) + u64 slot + Option<Pubkey> authority. */
const PROGRAM_DATA_HEADER = 45;

/** Deploy pads the buffer with zeroes to leave room for a larger upgrade — not part of the ELF. */
function trimPadding(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}

const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** `release` is the bytes of `release/gift_draw_registry.so`, however the caller loaded them. */
export async function checkProgramBinary(release: Uint8Array) {
  const conn = connection();
  const pid = programId();

  const programAccount = await conn.getAccountInfo(pid);
  if (!programAccount) throw new Error(`program ${pid.toBase58()} not found on ${rpcUrl()}`);

  const programDataAddress = new PublicKey(
    programAccount.data.subarray(PROGRAM_ACCOUNT_HEADER, PROGRAM_ACCOUNT_HEADER + 32)
  );
  const programData = await conn.getAccountInfo(programDataAddress);
  if (!programData) throw new Error(`programdata ${programDataAddress.toBase58()} not found`);

  const onChain = trimPadding(Buffer.from(programData.data.subarray(PROGRAM_DATA_HEADER)));
  const local = trimPadding(Buffer.from(release));

  const onChainHash = sha256Hex(onChain);
  const localHash = sha256Hex(local);

  return {
    ok: onChainHash === localHash,
    programId: pid.toBase58(),
    programDataAddress: programDataAddress.toBase58(),
    rpc: rpcUrl(),
    onChainBytes: onChain.length,
    releaseBytes: local.length,
    onChainSha256: onChainHash,
    releaseSha256: localHash,
    solscan: solscanAccount(pid.toBase58()),
  };
}

/* ------------------------------------------------------------------------------------------------
 * 2. The entrant list is the one the draw ran on
 * ---------------------------------------------------------------------------------------------- */

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
  entrantCount?: number;
  excludedCount?: number;
  entrantDataAvailable?: boolean;
  sortedTicketIds: number[];
  allTickets?: PublishedTicket[];
  merkleRootHex?: string | null;
  /** Present on a paged answer (`&after=`): the cursor for the next page, null on the last. */
  nextAfter?: number | null;
};

export type EntrantsResult = 'match' | 'mismatch' | 'entrant-list-not-published' | 'not-committed';

export type EntrantsOptions = {
  /** Called after each page with the number of tickets read so far. */
  onProgress?: (ticketsRead: number) => void;
  /** Tickets per page; the site caps it. Only worth setting to exercise paging on a small draw. */
  pageSize?: number;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !body || body.ok === false) throw new Error(body?.error || `${url} → HTTP ${res.status}`);
  return body;
}

/**
 * The published entrant list, however large: pages of up to 10 000 tickets (`&after=<last id>`)
 * joined in id order. A site from before paging ignores `after` and answers with the whole list in
 * one piece — recognised by the missing `nextAfter`, and used as it is.
 */
async function fetchPublishedEntrants(drawId: string, base: string, opts: EntrantsOptions) {
  const url = (after: number) =>
    `${base}/api/draws?action=entrants&drawId=${encodeURIComponent(drawId)}&after=${after}` +
    (opts.pageSize ? `&limit=${opts.pageSize}` : '');
  const first = await getJson<EntrantsResponse>(url(0));
  if (!('nextAfter' in first)) {
    opts.onProgress?.(first.allTickets?.length ?? first.sortedTicketIds.length);
    return {
      url: url(0),
      sortedTicketIds: (first.sortedTicketIds || []).map(Number),
      allTickets: first.allTickets,
      publishedRoot: first.merkleRootHex ?? null,
      entrantDataAvailable: first.entrantDataAvailable,
      excludedCount: first.excludedCount ?? null,
    };
  }
  const sortedTicketIds: number[] = [];
  const allTickets: PublishedTicket[] = [];
  let page: EntrantsResponse = first;
  let lastId = 0;
  for (;;) {
    for (const t of page.allTickets ?? []) {
      // Pages must continue the id order — anything else is not the list the pages claim to be.
      if (!(Number(t.id) > lastId)) throw new Error(`entrants pages overlap or go backwards at ticket ${t.id}`);
      lastId = Number(t.id);
      allTickets.push(t);
    }
    for (const id of page.sortedTicketIds ?? []) sortedTicketIds.push(Number(id));
    opts.onProgress?.(allTickets.length);
    if (page.nextAfter == null) break;
    if (!(page.nextAfter >= lastId)) throw new Error('entrants pages: cursor went backwards');
    page = await getJson<EntrantsResponse>(url(page.nextAfter));
  }
  return {
    url: url(0),
    sortedTicketIds,
    allTickets,
    publishedRoot: first.merkleRootHex ?? null,
    entrantDataAvailable: allTickets.length > 0,
    excludedCount: allTickets.length - sortedTicketIds.length,
  };
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function checkEntrants(drawId: string, api: string = DEFAULT_API, opts: EntrantsOptions = {}) {
  const base = api.replace(/\/+$/, '');
  const published = await fetchPublishedEntrants(drawId, base, opts);
  const url = published.url;

  const publishedIds = [...published.sortedTicketIds].sort((a, b) => a - b);

  // 1. The published list must hash to the root the site recorded — recomputed here with the
  //    settlement's own function (server/lib/draw-settlement-seed.ts, verbatim; the streaming form
  //    hashes the same bytes without building one huge string). A paged site names the root its
  //    settlement recorded, and none for a draw not settled yet: then there is nothing to compare.
  const recomputedHex = entrantListHashStreaming(publishedIds);
  const listHashOk = published.publishedRoot ? recomputedHex === published.publishedRoot : null;

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
    filterOk = sameIds(rederived, publishedIds);
  }

  // A draw whose entrant list is not published cannot be checked either way. Calling that a
  // mismatch would be reporting the operator as caught out on the strength of absent data.
  const entrantDataAvailable =
    published.entrantDataAvailable ?? (published.allTickets?.length ?? publishedIds.length) > 0;
  const listGone = seed !== null && !entrantDataAvailable && onChainOk === false;

  const result: EntrantsResult = !seed
    ? 'not-committed'
    : listGone
      ? 'entrant-list-not-published'
      : onChainOk === true && listHashOk !== false && filterOk !== false
        ? 'match'
        : 'mismatch';

  return {
    drawId,
    ok: result === 'match',
    result,
    listHashOk,
    onChainOk,
    filterOk,
    entrantCount: publishedIds.length,
    excludedCount: published.excludedCount,
    rederivedEntrantCount: rederivedCount,
    recomputedRoot: recomputedHex,
    publishedRoot: published.publishedRoot,
    onChainRoot: seed?.merkleRootHex ?? null,
    drawSeedPda: seed?.pda ?? null,
    solscan: seed ? solscanAccount(seed.pda) : null,
    entrantsUrl: url,
  };
}

/* ------------------------------------------------------------------------------------------------
 * 3. The seed could not be known when the entrant list was sealed
 * ---------------------------------------------------------------------------------------------- */

/** Program constant `ENTROPY_DELAY_SLOTS`. */
const ENTROPY_DELAY_SLOTS = 2n;

export async function checkSeed(drawId: string, onProgress?: (transactionsRead: number) => void) {
  const seed = await fetchDrawSeed(drawId);
  if (!seed) throw new Error(`No DrawSeed account on-chain for draw ${drawId} — nothing was sealed (yet).`);
  const seal = await fetchSealTransaction(drawId, onProgress);
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

  return {
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
    drawSeedSolscan: solscanAccount(seed.pda),
    drawCommitSolscan: commit ? solscanAccount(commit.pda) : null,
  };
}

/* ------------------------------------------------------------------------------------------------
 * 4. Prize amounts and ranks are the committed ones
 * ---------------------------------------------------------------------------------------------- */

/** The export format — docs/SETTLEMENT-EXPORT.md. */
export type SettlementExport = {
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

export async function checkSettlement(data: SettlementExport) {
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

  return {
    drawId,
    ok: hashOk && winnerCountOk && seedOk && merkleOk && specOk,
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
  };
}

type SettlementExportPage = SettlementExport & { page?: number; pageCount?: number; totalRows?: number };

/**
 * The export for a draw, straight from the site (`?action=settlement-export`), however large: pages
 * of up to 10 000 prize rows (`&page=N`) joined into one export. A site from before paging ignores
 * `page` and answers in one piece (no `pageCount`). It is only the claim: `checkSettlement`
 * recomputes the hash from it and compares against the chain.
 */
export async function fetchSettlementExport(
  drawId: string,
  api: string = DEFAULT_API,
  opts: { pageSize?: number } = {}
): Promise<SettlementExport> {
  const base = api.replace(/\/+$/, '');
  const url = (page: number) =>
    `${base}/api/draws?action=settlement-export&drawId=${encodeURIComponent(drawId)}&page=${page}` +
    (opts.pageSize ? `&limit=${opts.pageSize}` : '');
  const first = await getJson<SettlementExportPage>(url(0));
  if (first.pageCount == null) return first;

  const prizes = [...first.prizes];
  for (let page = 1; page < first.pageCount; page++) {
    const next = await getJson<SettlementExportPage>(url(page));
    // Every page must describe the same settlement; mixing two would be checking neither.
    if (next.seedHex !== first.seedHex || next.merkleRootHex !== first.merkleRootHex || next.specVersion !== first.specVersion) {
      throw new Error(`settlement export page ${page} describes a different settlement`);
    }
    prizes.push(...next.prizes);
  }
  if (first.totalRows != null && prizes.length !== first.totalRows) {
    throw new Error(`settlement export: ${prizes.length} rows read, the site announced ${first.totalRows}`);
  }
  return {
    drawId: first.drawId,
    specVersion: first.specVersion,
    seedHex: first.seedHex,
    merkleRootHex: first.merkleRootHex,
    prizes,
  };
}
