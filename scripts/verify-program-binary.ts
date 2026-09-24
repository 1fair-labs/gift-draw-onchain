/**
 * Check that `release/gift_draw_registry.so` in this repo is the program running on Solana.
 *
 * This is what makes the rest of the repo worth reading: the Rust source and the compiled binary
 * are only evidence if the binary is the one actually executing. The deployed bytecode is public —
 * this pulls it straight from the chain and compares it byte for byte.
 *
 * Usage:
 *   npx tsx scripts/verify-program-binary.ts
 *
 * Equivalent with the Solana CLI:
 *   solana program dump FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed dumped.so --url devnet
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { connection, programId, rpcUrl, solscanAccount } from './lib/chain.js';

const RELEASE_PATH = new URL('../release/gift_draw_registry.so', import.meta.url);

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

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
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
  const local = trimPadding(readFileSync(RELEASE_PATH));

  const onChainHash = sha256(onChain);
  const localHash = sha256(local);
  const ok = onChainHash === localHash;

  console.log(
    JSON.stringify(
      {
        ok,
        programId: pid.toBase58(),
        programDataAddress: programDataAddress.toBase58(),
        rpc: rpcUrl(),
        onChainBytes: onChain.length,
        releaseBytes: local.length,
        onChainSha256: onChainHash,
        releaseSha256: localHash,
        solscan: solscanAccount(pid.toBase58()),
      },
      null,
      2
    )
  );

  console.log(
    ok
      ? '\nrelease/gift_draw_registry.so is the deployed program.'
      : '\nMISMATCH — the binary in this repo is not what is running on-chain.'
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
