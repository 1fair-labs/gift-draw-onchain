/**
 * The verification code is written for Node and reaches for the global `Buffer`. Imported first by
 * `main.ts`, before anything that uses it.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
