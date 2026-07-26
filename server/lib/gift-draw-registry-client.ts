import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionSignature,
} from '@solana/web3.js';
import {
  checkSignatureLanded,
  confirmSignature,
  isRetriableSolanaSendError,
  solanaSendRetryDelayMs,
} from './solana-send-retry.js';
import bs58 from 'bs58';
import { getServerPaymentRpc, parseTreasuryPubkey } from './solana-payment-env.js';
import { buildHeliusRpcUrl, resolveSolanaPublicRpcUrl } from './solana-rpc-url.js';
import { loadCnftMintWeb3Keypair } from './sponsor-web3-keypair.js';
import { scheduleProjectSolSpend } from './project-sol-ledger.js';
import { maybeAutoTopUpSponsorSol } from './sponsor-sol-topup.js';

export type PurchasableTicketKind = 'common' | 'event' | 'legendary';

export const SETTLEMENT_SPEC_VERSION_ON_CHAIN = 20;
export const PROJECT_TAG_GDT0 = 0x4754_4430;
/** Claim-origin rolls use fixed slot 0 in roll hash (no Solana payment tx). */
export const CLAIM_ROLL_PURCHASE_SLOT = 0;

const __dirname = dirname(fileURLToPath(import.meta.url));

export type GiftDrawRegistryIdl = {
  address: string;
  instructions: unknown[];
  accounts: unknown[];
  events: unknown[];
  types: unknown[];
  errors: unknown[];
};

let cachedIdl: GiftDrawRegistryIdl | null = null;

function dedupeIdlNamed<T extends { name?: string; discriminator?: number[] }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const name = (item.name || '').trim();
    const disc = item.discriminator?.join(',') ?? '';
    const key = disc ? `${name}|${disc}` : name;
    if (!name) {
      out.push(item);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Anchor 0.30 needs a type entry for every event name; incomplete IDL breaks `new Program()`. */
function normalizeRegistryIdl(raw: GiftDrawRegistryIdl): GiftDrawRegistryIdl {
  const base = {
    ...raw,
    events: dedupeIdlNamed((raw.events || []) as { name?: string; discriminator?: number[] }[]),
    accounts: dedupeIdlNamed((raw.accounts || []) as { name?: string; discriminator?: number[] }[]),
    types: dedupeIdlNamed((raw.types || []) as { name?: string; discriminator?: number[] }[]),
  };
  const types = [...(base.types || [])];
  const names = new Set(types.map((t) => (t as { name?: string }).name));
  const ensure = (name: string, fields: unknown[]) => {
    if (!names.has(name)) {
      types.push({ name, type: { kind: 'struct', fields } });
      names.add(name);
    }
  };
  ensure('DrawSeedCommitted', [
    { name: 'draw_id', type: 'string' },
    { name: 'seed', type: { array: ['u8', 32] } },
    { name: 'merkle_root', type: { array: ['u8', 32] } },
    { name: 'spec_version', type: 'u16' },
  ]);
  ensure('DrawResultCommitted', [
    { name: 'draw_id', type: 'string' },
    { name: 'seed', type: { array: ['u8', 32] } },
    { name: 'merkle_root', type: { array: ['u8', 32] } },
    { name: 'settlement_hash', type: { array: ['u8', 32] } },
    { name: 'spec_version', type: 'u16' },
    { name: 'winner_count', type: 'u32' },
  ]);
  ensure('KindRolledV2', [
    { name: 'ticket_id', type: 'u64' },
    { name: 'ticket_serial', type: 'u64' },
    { name: 'purchase_tx_sig', type: { array: ['u8', 64] } },
    { name: 'buyer', type: 'pubkey' },
    { name: 'ticket_index', type: 'u16' },
    { name: 'origin', type: 'u8' },
    { name: 'gift_amount_micro', type: 'u64' },
    { name: 'roll', type: 'u32' },
    { name: 'kind', type: 'u8' },
    { name: 'slot', type: 'u64' },
    { name: 'registry_version', type: 'u16' },
    { name: 'project_tag', type: 'u32' },
  ]);
  return { ...base, types };
}

export function loadGiftDrawRegistryIdl(): GiftDrawRegistryIdl {
  if (cachedIdl) return cachedIdl;
  const bundledIdl = join(__dirname, 'gift-draw-registry.idl.json');
  const repoIdl = join(__dirname, '../../target/idl/gift_draw_registry.json');
  let raw: GiftDrawRegistryIdl;
  try {
    raw = JSON.parse(readFileSync(bundledIdl, 'utf8')) as GiftDrawRegistryIdl;
  } catch {
    raw = JSON.parse(readFileSync(repoIdl, 'utf8')) as GiftDrawRegistryIdl;
  }
  cachedIdl = normalizeRegistryIdl(raw);
  return cachedIdl;
}

export function getRegistryProgramId(): PublicKey {
  const idl = loadGiftDrawRegistryIdl();
  const fromEnv = (process.env.GIFT_DRAW_REGISTRY_PROGRAM_ID || '').trim();
  return new PublicKey(fromEnv || idl.address);
}

/** On-chain registry is mandatory in production; dev may opt out with ALLOW_REGISTRY_OFF=1. */
export function isRegistryEnabled(): boolean {
  const isProd =
    process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (isProd) return true;
  if ((process.env.ALLOW_REGISTRY_OFF || '').trim() === '1') {
    return (process.env.GIFT_DRAW_REGISTRY_ENABLED || '').trim() !== '0';
  }
  return (process.env.GIFT_DRAW_REGISTRY_ENABLED || '1').trim() !== '0';
}

/** 64-byte roll input: real payment sig (base58) or deterministic hash for `claim:{id}`. */
export function rollKindEntropyBytes(purchaseOrClaimSig: string): Uint8Array {
  const s = purchaseOrClaimSig.trim();
  if (s.startsWith('claim:')) {
    return Uint8Array.from(createHash('sha256').update(s, 'utf8').digest());
  }
  return signatureToBytes64(s);
}

let readOnlyRegistryProgram: Program | null = null;

/** IDL event decode / fetch tx — no sponsor keypair required. */
export function createRegistryProgramReadOnly(): Program {
  if (readOnlyRegistryProgram) return readOnlyRegistryProgram;
  const rpc = getServerPaymentRpc() || 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = loadGiftDrawRegistryIdl();
  const programId = getRegistryProgramId();
  const idlWithAddress = { ...idl, address: programId.toBase58() };
  readOnlyRegistryProgram = new Program(idlWithAddress as never, provider);
  return readOnlyRegistryProgram;
}

export function createRegistryProgram(): Program {
  const connection = new Connection(getServerPaymentRpc(), 'confirmed');
  const sponsor = loadCnftMintWeb3Keypair();
  const wallet = new Wallet(sponsor);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = loadGiftDrawRegistryIdl();
  const programId = getRegistryProgramId();
  // Anchor 0.30: Program(idl, provider) — program id comes from idl.address only.
  const idlWithAddress = { ...idl, address: programId.toBase58() };
  return new Program(idlWithAddress as never, provider);
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
}

export function drawSeedPda(drawId: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('draw_seed'), Buffer.from(drawId, 'utf8')],
    programId
  )[0];
}

export function drawCommitPda(drawId: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('draw_commit'), Buffer.from(drawId, 'utf8')],
    programId
  )[0];
}

export function signatureToBytes64(signatureBase58: string): Uint8Array {
  const decoded = bs58.decode(signatureBase58.trim());
  if (decoded.length !== 64) {
    throw new Error('purchase_tx_sig must decode to 64 bytes');
  }
  return decoded;
}

export function purchasableKindFromCode(kindCode: number): PurchasableTicketKind {
  if (kindCode === 2) return 'legendary';
  if (kindCode === 1) return 'event';
  return 'common';
}

const ROLL_KIND_SEND_ATTEMPTS = 5;

export async function sendRollKindTx(params: {
  purchaseTxSig: string;
  buyerWallet: string;
  ticketIndex: number;
  ticketId: number;
  ticketSerial: number;
  origin: number;
  giftAmountMicro: bigint;
  purchaseSlot: number;
}): Promise<{ signature: TransactionSignature }> {
  const program = createRegistryProgram();
  const connection = program.provider.connection as Connection;
  const sponsor = loadCnftMintWeb3Keypair();
  await maybeAutoTopUpSponsorSol(connection);
  const sigBytes = Array.from(rollKindEntropyBytes(params.purchaseTxSig));
  const buyer = new PublicKey(params.buyerWallet.trim());

  const builder = program.methods
    .rollKind(
      sigBytes,
      params.ticketIndex,
      new BN(params.ticketId),
      new BN(params.ticketSerial),
      params.origin,
      new BN(params.giftAmountMicro.toString()),
      new BN(params.purchaseSlot)
    )
    .accounts({
      authority: sponsor.publicKey,
      buyer,
    });

  const recordSpend = (signature: string) =>
    scheduleProjectSolSpend({ connection, signature, category: 'roll_kind', ticketId: params.ticketId });

  let lastErr: unknown;
  for (let attempt = 0; attempt < ROLL_KIND_SEND_ATTEMPTS; attempt++) {
    let signature: string | undefined;
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = await builder.transaction();
      tx.feePayer = sponsor.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(sponsor);

      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: attempt >= 2,
        maxRetries: 2,
        preflightCommitment: 'confirmed',
      });

      await confirmSignature(connection, signature, blockhash, lastValidBlockHeight);
      recordSpend(signature);
      return { signature };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Idempotency: don't re-send if the tx we already sent actually landed (confirm just timed
      // out) — a duplicate roll_kind fails "already rolled" and wastes a fee.
      if (signature) {
        const landed = await checkSignatureLanded(connection, signature);
        if (landed === 'confirmed') {
          recordSpend(signature);
          return { signature };
        }
        if (landed === 'failed') throw e;
      }
      if (attempt < ROLL_KIND_SEND_ATTEMPTS - 1 && isRetriableSolanaSendError(msg)) {
        await new Promise((r) => setTimeout(r, solanaSendRetryDelayMs(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('sendRollKindTx failed');
}

export async function sendDrawRandomnessTx(params: {
  drawId: string;
  periodEndIso: string;
  merkleRootHex: string;
  /** Unix timestamp (seconds) of draw period end — enforced on-chain to prevent early seed commit. */
  periodEndUnix: number;
}): Promise<{ signature: TransactionSignature }> {
  const program = createRegistryProgram();
  const connection = program.provider.connection as Connection;
  await maybeAutoTopUpSponsorSol(connection);
  const programId = getRegistryProgramId();
  const sponsor = loadCnftMintWeb3Keypair();
  const tx = await program.methods
    .drawRandomness(params.drawId, params.periodEndIso, params.merkleRootHex, new BN(params.periodEndUnix))
    .accounts({
      authority: sponsor.publicKey,
      drawSeed: drawSeedPda(params.drawId, programId),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  scheduleProjectSolSpend({
    connection,
    signature: tx,
    category: 'draw_randomness',
    drawId: params.drawId,
  });
  return { signature: tx };
}

export async function sendCommitDrawResultTx(params: {
  drawId: string;
  settlementHash: Buffer;
  winnerCount: number;
}): Promise<{ signature: TransactionSignature }> {
  const program = createRegistryProgram();
  const connection = program.provider.connection as Connection;
  await maybeAutoTopUpSponsorSol(connection);
  const programId = getRegistryProgramId();
  const sponsor = loadCnftMintWeb3Keypair();
  const hashArr = Array.from(params.settlementHash);
  const tx = await program.methods
    .commitDrawResult(params.drawId, hashArr, new BN(params.winnerCount))
    .accounts({
      authority: sponsor.publicKey,
      drawSeed: drawSeedPda(params.drawId, programId),
      drawCommit: drawCommitPda(params.drawId, programId),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  scheduleProjectSolSpend({
    connection,
    signature: tx,
    category: 'draw_commit',
    drawId: params.drawId,
  });
  return { signature: tx };
}

export async function sendInitializeRegistryTx(): Promise<{ signature: TransactionSignature }> {
  const program = createRegistryProgram();
  const connection = program.provider.connection as Connection;
  await maybeAutoTopUpSponsorSol(connection);
  const programId = getRegistryProgramId();
  const sponsor = loadCnftMintWeb3Keypair();
  const treasury = parseTreasuryPubkey();
  const tx = await program.methods
    .initialize(treasury)
    .accounts({
      authority: sponsor.publicKey,
      config: configPda(programId),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  scheduleProjectSolSpend({
    connection,
    signature: tx,
    category: 'registry_init',
  });
  return { signature: tx };
}

export type ParsedKindRolledV2 = {
  ticketId: number;
  ticketSerial: number;
  purchaseTxSig: Uint8Array;
  buyer: PublicKey;
  ticketIndex: number;
  origin: number;
  giftAmountMicro: bigint;
  roll: number;
  kind: PurchasableTicketKind;
  slot: number;
  registryVersion: number;
  projectTag: number;
};

function bnToBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (v != null && typeof v === 'object' && 'toString' in (v as object)) {
    return BigInt(String((v as { toString: () => string }).toString()));
  }
  return BigInt(Number(v));
}

function isKindRolledV2EventName(name: string): boolean {
  const n = (name || '').trim();
  return n === 'kindRolledV2' || n === 'KindRolledV2';
}

function fieldFromDecoded(d: Record<string, unknown>, camel: string, snake: string): unknown {
  return d[camel] ?? d[snake];
}

function parsedKindRolledV2FromDecoded(decoded: {
  name: string;
  data: Record<string, unknown>;
}): ParsedKindRolledV2 | null {
  const d = decoded.data;
  const hasShape =
    fieldFromDecoded(d, 'ticketId', 'ticket_id') != null &&
    fieldFromDecoded(d, 'ticketSerial', 'ticket_serial') != null;
  if (!isKindRolledV2EventName(decoded.name) && !hasShape) return null;

  const kindCode = Number(fieldFromDecoded(d, 'kind', 'kind'));
  const purchaseRaw = fieldFromDecoded(d, 'purchaseTxSig', 'purchase_tx_sig');
  const purchaseArr = Array.isArray(purchaseRaw) ? purchaseRaw : null;
  if (!purchaseArr || purchaseArr.length !== 64) return null;

  return {
    ticketId: Number(bnToBigInt(fieldFromDecoded(d, 'ticketId', 'ticket_id'))),
    ticketSerial: Number(bnToBigInt(fieldFromDecoded(d, 'ticketSerial', 'ticket_serial'))),
    purchaseTxSig: Uint8Array.from(purchaseArr as number[]),
    buyer: fieldFromDecoded(d, 'buyer', 'buyer') as PublicKey,
    ticketIndex: Number(fieldFromDecoded(d, 'ticketIndex', 'ticket_index')),
    origin: Number(fieldFromDecoded(d, 'origin', 'origin')),
    giftAmountMicro: bnToBigInt(fieldFromDecoded(d, 'giftAmountMicro', 'gift_amount_micro')),
    roll: Number(fieldFromDecoded(d, 'roll', 'roll')),
    kind: purchasableKindFromCode(kindCode),
    slot: Number(bnToBigInt(fieldFromDecoded(d, 'slot', 'slot'))),
    registryVersion: Number(fieldFromDecoded(d, 'registryVersion', 'registry_version')),
    projectTag: Number(fieldFromDecoded(d, 'projectTag', 'project_tag')),
  };
}

/** Decode Solscan "Program data:" base64 (KindRolledV2). */
export function parseKindRolledV2ProgramData(base64: string): ParsedKindRolledV2 | null {
  const b64 = base64.trim();
  if (!b64) return null;
  const program = createRegistryProgramReadOnly();
  try {
    const decoded = program.coder.events.decode(Buffer.from(b64, 'base64')) as {
      name: string;
      data: Record<string, unknown>;
    } | null;
    if (!decoded) return null;
    return parsedKindRolledV2FromDecoded(decoded);
  } catch {
    return null;
  }
}

/** Decode every KindRolledV2 event in a tx (a batch tx carries one per ticket). */
/** RPC read-back is the fragile step: the roll tx is already sent, but fetching it to decode the
 * KindRolledV2 event races confirmation/indexing lag and transient gateway timeouts. Rotate across
 * [payment(helius) → helius → public] and retry with backoff so a single 504 no longer strands the
 * roll (and forces a duplicate re-send). Any RPC returns the same tx logs, so this is safe. */
const PARSE_TX_RPC_ATTEMPTS = 8;
const PARSE_TX_RPC_DELAY_MS = 600;

function rollParseRpcUrls(): string[] {
  const urls = [getServerPaymentRpc(), buildHeliusRpcUrl(), resolveSolanaPublicRpcUrl()].filter(
    (u): u is string => Boolean(u && u.trim())
  );
  const deduped = Array.from(new Set(urls));
  return deduped.length > 0 ? deduped : ['https://api.devnet.solana.com'];
}

function isTransientRpcError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504') ||
    m.includes('bad gateway') ||
    m.includes('service unavailable') ||
    m.includes('fetch failed') ||
    m.includes('failed to fetch') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('non-whitespace') ||
    m.includes('not valid json')
  );
}

/** Fetch a confirmed tx's log messages, rotating RPCs and retrying on lag / transient errors. */
async function fetchTxLogMessages(signature: string): Promise<string[] | null> {
  const urls = rollParseRpcUrls();
  for (let attempt = 0; attempt < PARSE_TX_RPC_ATTEMPTS; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      const connection = new Connection(url, 'confirmed');
      let tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.logMessages?.length) {
        tx = await connection.getTransaction(signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
      }
      if (tx?.meta?.logMessages?.length) return tx.meta.logMessages;
      // Tx not indexed yet (confirmation lag) — fall through to backoff and retry.
    } catch (err) {
      if (!isTransientRpcError(err)) {
        console.warn('parseAllKindRolledFromTx: non-transient RPC error', {
          signature,
          url: url.replace(/api-key=[^&]+/i, 'api-key=***'),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (attempt < PARSE_TX_RPC_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, PARSE_TX_RPC_DELAY_MS * (1 + attempt * 0.5)));
    }
  }
  return null;
}

export async function parseAllKindRolledFromTx(
  signature: string
): Promise<ParsedKindRolledV2[]> {
  const program = createRegistryProgramReadOnly();
  const logMessages = await fetchTxLogMessages(signature);
  if (!logMessages) return [];
  const tx = { meta: { logMessages } };
  const parser = program.coder.events;
  const parsedEvents: ParsedKindRolledV2[] = [];
  let lastDecodeName: string | null = null;
  for (const line of tx.meta.logMessages) {
    const prefix = 'Program data: ';
    const idx = line.indexOf(prefix);
    if (idx < 0) continue;
    const b64 = line.slice(idx + prefix.length).trim();
    try {
      const data = Buffer.from(b64, 'base64');
      const decoded = parser.decode(data) as { name: string; data: Record<string, unknown> } | null;
      if (!decoded) continue;
      lastDecodeName = decoded.name;
      const parsed = parsedKindRolledV2FromDecoded(decoded);
      if (parsed) parsedEvents.push(parsed);
    } catch {
      /* try next log line */
    }
  }
  if (parsedEvents.length === 0 && lastDecodeName) {
    console.warn('parseAllKindRolledFromTx: decoded event not mapped', {
      signature,
      eventName: lastDecodeName,
    });
  }
  return parsedEvents;
}

export async function parseKindRolledFromTx(
  signature: string,
  opts?: { expectedTicketId?: number }
): Promise<ParsedKindRolledV2 | null> {
  const parsedEvents = await parseAllKindRolledFromTx(signature);
  if (parsedEvents.length === 0) return null;
  const wantId = opts?.expectedTicketId;
  if (wantId != null && Number.isFinite(wantId)) {
    const match = parsedEvents.find((p) => p.ticketId === wantId);
    if (match) return match;
  }
  return parsedEvents[parsedEvents.length - 1] ?? null;
}

export type DrawSeedAccount = {
  seed: Uint8Array;
  merkleRoot: Uint8Array;
  specVersion: number;
};

export type DrawCommitAccount = {
  seed: Uint8Array;
  merkleRoot: Uint8Array;
  settlementHash: Uint8Array;
  specVersion: number;
  winnerCount: number;
};

export type DrawAnchorApiPayload = {
  drawId: string | null;
  drawSeed: {
    accountType: 'DrawSeed';
    pda: string;
    seedHex: string;
    merkleRootHex: string;
    specVersion: number;
  } | null;
  drawCommit: {
    accountType: 'DrawCommit';
    pda: string;
    seedHex: string;
    merkleRootHex: string;
    settlementHashHex: string;
    specVersion: number;
    winnerCount: number;
  } | null;
  notice?: string;
};

export function formatDrawAnchorForApi(
  drawId: string,
  seed: DrawSeedAccount | null,
  commit: DrawCommitAccount | null,
  programId: PublicKey
): DrawAnchorApiPayload {
  return {
    drawId,
    drawSeed: seed
      ? {
          accountType: 'DrawSeed',
          pda: drawSeedPda(drawId, programId).toBase58(),
          seedHex: Buffer.from(seed.seed).toString('hex'),
          merkleRootHex: Buffer.from(seed.merkleRoot).toString('hex'),
          specVersion: seed.specVersion,
        }
      : null,
    drawCommit: commit
      ? {
          accountType: 'DrawCommit',
          pda: drawCommitPda(drawId, programId).toBase58(),
          seedHex: Buffer.from(commit.seed).toString('hex'),
          merkleRootHex: Buffer.from(commit.merkleRoot).toString('hex'),
          settlementHashHex: Buffer.from(commit.settlementHash).toString('hex'),
          specVersion: commit.specVersion,
          winnerCount: commit.winnerCount,
        }
      : null,
  };
}

export async function fetchDrawSeed(drawId: string): Promise<DrawSeedAccount | null> {
  const program = createRegistryProgram();
  const programId = getRegistryProgramId();
  const pda = drawSeedPda(drawId, programId);
  try {
    const acct = (await program.account.drawSeed.fetch(pda)) as {
      seed: number[];
      merkleRoot: number[];
      specVersion: number;
    };
    return {
      seed: Uint8Array.from(acct.seed),
      merkleRoot: Uint8Array.from(acct.merkleRoot),
      specVersion: Number(acct.specVersion),
    };
  } catch {
    return null;
  }
}

export async function fetchDrawCommit(drawId: string): Promise<DrawCommitAccount | null> {
  const program = createRegistryProgram();
  const programId = getRegistryProgramId();
  const pda = drawCommitPda(drawId, programId);
  try {
    const acct = (await program.account.drawCommit.fetch(pda)) as {
      seed: number[];
      merkleRoot: number[];
      settlementHash: number[];
      specVersion: number;
      winnerCount: number;
    };
    return {
      seed: Uint8Array.from(acct.seed),
      merkleRoot: Uint8Array.from(acct.merkleRoot),
      settlementHash: Uint8Array.from(acct.settlementHash),
      specVersion: Number(acct.specVersion),
      winnerCount: Number(acct.winnerCount),
    };
  } catch {
    return null;
  }
}

export async function fetchDrawSeedHex(drawId: string): Promise<string | null> {
  const acct = await fetchDrawSeed(drawId);
  return acct ? Buffer.from(acct.seed).toString('hex') : null;
}

export async function fetchDrawAnchorForApi(drawId: string): Promise<DrawAnchorApiPayload> {
  const id = drawId.trim();
  if (!id) {
    return { drawId: null, drawSeed: null, drawCommit: null, notice: 'No draw_id' };
  }
  const programId = getRegistryProgramId();
  const [seed, commit] = await Promise.all([fetchDrawSeed(id), fetchDrawCommit(id)]);
  return formatDrawAnchorForApi(id, seed, commit, programId);
}
