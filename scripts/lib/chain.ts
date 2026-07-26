/**
 * Standalone Solana reader for this audit mirror.
 *
 * This file is NOT production code — it is plumbing so the verification scripts run with no
 * credentials and no server dependencies. It only *reads* bytes: PDA addresses come from the
 * published `src/lib/on-chain-gift-draw/pda.ts`, and the account/event layouts are transcribed
 * from `programs/gift_draw_registry/src/lib.rs` and `idl/gift_draw_registry.json`.
 *
 * Everything it returns can be checked by hand on Solscan — the account data and the transaction
 * logs are public. The fairness rules themselves live in the production files this repo mirrors;
 * nothing here computes a rule.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { drawCommitPda, drawSeedPda } from '../../src/lib/on-chain-gift-draw/pda.js';

/**
 * Deployed program address. Override with `--program-id` or GIFT_DRAW_REGISTRY_PROGRAM_ID.
 * The mainnet deployment is published in the README once it exists.
 */
export const DEPLOYED_PROGRAM_ID = 'FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed';

export const DEFAULT_RPC_DEVNET = 'https://api.devnet.solana.com';
export const DEFAULT_RPC_MAINNET = 'https://api.mainnet-beta.solana.com';

function cliArg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
}

/**
 * The airdrop stage settles its draws on devnet, which is the default here. The flag exists so
 * the scripts keep working if the deployment they point at ever moves cluster.
 */
export function cluster(): 'devnet' | 'mainnet-beta' {
  const v = (cliArg('--cluster') || process.env.SOLANA_CLUSTER || 'devnet').toLowerCase();
  return v.startsWith('main') ? 'mainnet-beta' : 'devnet';
}

/** Any RPC works — use your own so you are not trusting an endpoint the operator chose. */
export function rpcUrl(): string {
  const explicit = cliArg('--rpc') || String(process.env.SOLANA_RPC_URL || '').trim();
  if (explicit) return explicit;
  return cluster() === 'devnet' ? DEFAULT_RPC_DEVNET : DEFAULT_RPC_MAINNET;
}

export function programId(): PublicKey {
  const explicit =
    cliArg('--program-id') || String(process.env.GIFT_DRAW_REGISTRY_PROGRAM_ID || '').trim();
  return new PublicKey(explicit || DEPLOYED_PROGRAM_ID);
}

export function connection(): Connection {
  return new Connection(rpcUrl(), 'confirmed');
}

export function solscanAccount(address: string): string {
  const q = cluster() === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/account/${address}${q}`;
}

export function solscanTx(signature: string): string {
  const q = cluster() === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${signature}${q}`;
}

/** Anchor's 8-byte tag: sha256("<namespace>:<Name>")[0..8]. */
function anchorDiscriminator(namespace: 'account' | 'event', name: string): Buffer {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
}

function requireDiscriminator(data: Buffer, namespace: 'account' | 'event', name: string): void {
  const want = anchorDiscriminator(namespace, name);
  if (!data.subarray(0, 8).equals(want)) {
    throw new Error(`not a ${name} ${namespace}: discriminator ${data.subarray(0, 8).toString('hex')}`);
  }
}

export type DrawSeedAccount = {
  pda: string;
  drawId: string;
  seedHex: string;
  merkleRootHex: string;
  specVersion: number;
};

export type DrawCommitAccount = {
  pda: string;
  drawId: string;
  seedHex: string;
  merkleRootHex: string;
  settlementHashHex: string;
  specVersion: number;
  winnerCount: number;
};

/** `DrawSeed`: draw_id_len u8 | draw_id [u8;32] | seed [u8;32] | merkle_root [u8;32] | spec u16 | bump u8 */
export async function fetchDrawSeed(drawId: string): Promise<DrawSeedAccount | null> {
  const pda = drawSeedPda(drawId, programId());
  const info = await connection().getAccountInfo(pda);
  if (!info) return null;
  const d = Buffer.from(info.data);
  requireDiscriminator(d, 'account', 'DrawSeed');
  const idLen = d.readUInt8(8);
  return {
    pda: pda.toBase58(),
    drawId: d.subarray(9, 9 + idLen).toString('utf8'),
    seedHex: d.subarray(41, 73).toString('hex'),
    merkleRootHex: d.subarray(73, 105).toString('hex'),
    specVersion: d.readUInt16LE(105),
  };
}

/** `DrawCommit`: ...as DrawSeed, plus settlement_hash [u8;32] | spec u16 | winner_count u32 | bump u8 */
export async function fetchDrawCommit(drawId: string): Promise<DrawCommitAccount | null> {
  const pda = drawCommitPda(drawId, programId());
  const info = await connection().getAccountInfo(pda);
  if (!info) return null;
  const d = Buffer.from(info.data);
  requireDiscriminator(d, 'account', 'DrawCommit');
  const idLen = d.readUInt8(8);
  return {
    pda: pda.toBase58(),
    drawId: d.subarray(9, 9 + idLen).toString('utf8'),
    seedHex: d.subarray(41, 73).toString('hex'),
    merkleRootHex: d.subarray(73, 105).toString('hex'),
    settlementHashHex: d.subarray(105, 137).toString('hex'),
    specVersion: d.readUInt16LE(137),
    winnerCount: d.readUInt32LE(139),
  };
}

export type KindRolledV2 = {
  ticketId: bigint;
  ticketSerial: bigint;
  purchaseTxSig: Buffer;
  buyer: string;
  ticketIndex: number;
  origin: number;
  giftAmountMicro: bigint;
  roll: number;
  kind: number;
  slot: bigint;
  registryVersion: number;
  projectTag: number;
};

/**
 * Decode one `KindRolledV2` from the base64 that follows `Program data:` in the tx log.
 * Layout from the `#[event]` struct — all little-endian, no padding.
 */
export function decodeKindRolledV2(base64: string): KindRolledV2 | null {
  const d = Buffer.from(base64, 'base64');
  if (d.length < 8) return null;
  if (!d.subarray(0, 8).equals(anchorDiscriminator('event', 'KindRolledV2'))) return null;
  return {
    ticketId: d.readBigUInt64LE(8),
    ticketSerial: d.readBigUInt64LE(16),
    purchaseTxSig: d.subarray(24, 88),
    buyer: new PublicKey(d.subarray(88, 120)).toBase58(),
    ticketIndex: d.readUInt16LE(120),
    origin: d.readUInt8(122),
    giftAmountMicro: d.readBigUInt64LE(123),
    roll: d.readUInt32LE(131),
    kind: d.readUInt8(135),
    slot: d.readBigUInt64LE(136),
    registryVersion: d.readUInt16LE(144),
    projectTag: d.readUInt32LE(146),
  };
}

/** Every `KindRolledV2` emitted by a transaction, in log order. */
export async function fetchRollEvents(signature: string): Promise<KindRolledV2[]> {
  const tx = await connection().getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`transaction not found on ${rpcUrl()} — wrong cluster?`);
  const logs = tx.meta?.logMessages || [];
  const events: KindRolledV2[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line.trim());
    if (!m) continue;
    const parsed = decodeKindRolledV2(m[1].trim());
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * Independent re-implementation of the program's `roll_from_inputs`, straight from
 * `programs/gift_draw_registry/src/lib.rs`:
 *
 *   hashv(purchase_tx_sig || ticket_index.to_le_bytes() || slot.to_le_bytes())
 *   u32::from_le_bytes(digest[0..4]) % 100_000
 *
 * Recomputing it here is the point: it proves the emitted `roll` really is the hash of the
 * payment signature, not a number the operator picked.
 */
export function rollFromInputs(purchaseTxSig: Buffer, ticketIndex: number, slot: bigint): number {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(ticketIndex);
  const slotBytes = Buffer.alloc(8);
  slotBytes.writeBigUInt64LE(slot);
  const digest = createHash('sha256')
    .update(purchaseTxSig)
    .update(idx)
    .update(slotBytes)
    .digest();
  return digest.readUInt32LE(0) % 100_000;
}
