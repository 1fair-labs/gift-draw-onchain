import { Keypair } from '@solana/web3.js';

/** Same secret as Bubblegum delegate — pays network fees for sponsored payment txs. */
export const loadCnftMintWeb3Keypair = (): Keypair => {
  const keyRaw = (process.env.CNFT_MINT_SECRET_KEY || '').trim();
  if (!keyRaw) {
    throw new Error('CNFT_MINT_SECRET_KEY is not configured');
  }
  const secretArray = JSON.parse(keyRaw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretArray));
};
