/**
 * Node's `crypto.createHash('sha256')` for the browser build — the only piece of `crypto` the
 * verification code uses. Aliased in `web/vite.config.ts`, so the production files this repo mirrors
 * (`server/lib/draw-settlement-seed.ts` and friends) run in the page unedited.
 *
 * SHA-256 itself comes from `@noble/hashes`, an audited implementation that `@solana/web3.js`
 * already depends on. Synchronous on purpose: WebCrypto's digest is async and the mirrored code is
 * not.
 */
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';

type Input = string | Uint8Array;
type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'latin1' | 'binary';

class Sha256Hash {
  private readonly inner = sha256.create();

  update(data: Input, encoding?: Encoding): this {
    this.inner.update(typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : data);
    return this;
  }

  digest(): Buffer;
  digest(encoding: 'hex' | 'base64'): string;
  digest(encoding?: 'hex' | 'base64'): Buffer | string {
    const out = Buffer.from(this.inner.digest());
    return encoding ? out.toString(encoding) : out;
  }
}

export function createHash(algorithm: string): Sha256Hash {
  if (algorithm.toLowerCase() !== 'sha256') {
    throw new Error(`crypto shim: only sha256 is available in the browser, not ${algorithm}`);
  }
  return new Sha256Hash();
}

export default { createHash };
