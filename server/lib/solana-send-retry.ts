import type { Connection, TransactionSignature } from '@solana/web3.js';

const RETRIABLE_SEND =
  /blockhash not found|block height exceeded|expired|timeout|timed out|node is behind|simulation failed|was not confirmed|429|503|502|ECONNRESET|ETIMEDOUT/i;

export function isRetriableSolanaSendError(message: string): boolean {
  return RETRIABLE_SEND.test(message);
}

export function solanaSendRetryDelayMs(attempt: number): number {
  return Math.min(250 * (attempt + 1), 1500);
}

export async function confirmSignature(
  connection: Connection,
  signature: TransactionSignature,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<void> {
  const conf = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  if (conf.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
  }
}
