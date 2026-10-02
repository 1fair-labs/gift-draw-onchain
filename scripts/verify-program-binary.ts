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
import { checkProgramBinary } from './lib/checks.js';

const RELEASE_PATH = new URL('../release/gift_draw_registry.so', import.meta.url);

async function main() {
  const result = await checkProgramBinary(readFileSync(RELEASE_PATH));
  console.log(JSON.stringify(result, null, 2));
  console.log(
    result.ok
      ? '\nrelease/gift_draw_registry.so is the deployed program.'
      : '\nMISMATCH — the binary in this repo is not what is running on-chain.'
  );
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
