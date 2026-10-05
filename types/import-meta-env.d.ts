/**
 * `src/lib/**` is mirrored verbatim from the product, where Vite builds it and `vite/client` types
 * `import.meta.env`. This repo has no bundler, so the same shape is declared here rather than
 * editing the mirrored file.
 *
 * Outside a Vite build `import.meta.env` is undefined at runtime. The verification scripts only
 * reach `getGiftDrawRegistryProgramId()`, which guards with `?.` and falls back to the default —
 * and `scripts/lib/chain.ts` passes an explicit program id anyway.
 */
interface ImportMeta {
  readonly env: Record<string, string | boolean | undefined>;
}
