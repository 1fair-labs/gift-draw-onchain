/**
 * The one-click verifier. Every check below is `scripts/lib/checks.ts` — the same functions the
 * `npm run verify-*` scripts call — run in the browser against a public RPC. This file only picks
 * the draw, runs the checks in order and says what each result means.
 */
import './polyfills';
import releaseUrl from '../release/gift_draw_registry.so?url';
import { DEFAULT_RPC_DEVNET, setChainOverrides } from '../scripts/lib/chain';
import {
  checkEntrants,
  checkProgramBinary,
  checkSeed,
  checkSettlement,
  DEFAULT_API,
  fetchSettlementExport,
} from '../scripts/lib/checks';

const REPO = 'https://github.com/1fair-labs/gift-draw-onchain';
const DRAW_ID_RE = /^\d{8}(_\d+)?$/;

/* ------------------------------------------------------------------------------------------------
 * DOM helpers — everything from the network is inserted as text, never as HTML
 * ---------------------------------------------------------------------------------------------- */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Only http(s) targets become links: a `javascript:` site address from a shared URL must not run. */
function link(href: string, text: string): HTMLElement {
  if (!httpUrl(href)) return h('span', {}, text);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** `value` as an http(s) URL, or '' — anything else (javascript:, data:, garbage) is refused. */
function httpUrl(value: string): string {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function kv(rows: Array<[string, string | number | boolean | null | undefined]>): HTMLElement {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    if (v === undefined) continue;
    dl.append(h('dt', {}, k), h('dd', {}, v === null ? '—' : String(v)));
  }
  return dl;
}

const mark = (v: boolean | null | undefined) => (v === true ? '✓' : v === false ? '✗' : '—');

/* ------------------------------------------------------------------------------------------------
 * Settings — URL first (so a link can be shared), then what this browser used last.
 *
 * A custom RPC or site is the one way to make this page lie: a fake RPC can serve a fake chain that
 * "matches" fake results. So a link may carry them, but they are never remembered unless the
 * visitor types them in, and whenever one is in effect the page says so in plain words.
 * ---------------------------------------------------------------------------------------------- */

const params = new URLSearchParams(location.search);

function stored(key: string): string {
  try {
    return localStorage.getItem(`verify:${key}`) || '';
  } catch {
    return '';
  }
}

function store(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(`verify:${key}`, value);
    else localStorage.removeItem(`verify:${key}`);
  } catch {
    /* private mode — settings just are not remembered */
  }
}

const rpcInput = $<HTMLInputElement>('rpc');
const apiInput = $<HTMLInputElement>('api');
const drawSelect = $<HTMLSelectElement>('draw-select');
const drawInput = $<HTMLInputElement>('draw-input');
const runButton = $<HTMLButtonElement>('run');

rpcInput.placeholder = DEFAULT_RPC_DEVNET;
apiInput.placeholder = DEFAULT_API;
rpcInput.value = httpUrl(params.get('rpc') || '') || httpUrl(stored('rpc'));
apiInput.value = httpUrl(params.get('api') || '') || httpUrl(stored('api'));
drawInput.value = params.get('draw') || '';

const rpc = () => rpcInput.value.trim() || DEFAULT_RPC_DEVNET;
const api = () => (apiInput.value.trim() || DEFAULT_API).replace(/\/+$/, '');

/** Remembered only when typed here — never because a visited link carried it. */
for (const [key, input] of [['rpc', rpcInput], ['api', apiInput]] as const) {
  input.addEventListener('change', () => {
    input.setCustomValidity('');
    if (!input.value.trim() || httpUrl(input.value)) store(key, input.value.trim());
    showCustomWarning();
  });
}

function customEndpoints(): string[] {
  const out: string[] = [];
  if (rpcInput.value.trim()) out.push(`Solana RPC ${rpcInput.value.trim()}`);
  if (apiInput.value.trim()) out.push(`site ${apiInput.value.trim()}`);
  return out;
}

function showCustomWarning(): void {
  const box = $('custom-warning');
  const custom = customEndpoints();
  box.hidden = custom.length === 0;
  box.textContent = custom.length
    ? `This check is not using the default sources: ${custom.join(' and ')}. Results are only as honest as those endpoints — a link someone sent you can point to fake ones. Clear the fields in Settings to use the defaults.`
    : '';
}
showCustomWarning();

/* ------------------------------------------------------------------------------------------------
 * Steps
 * ---------------------------------------------------------------------------------------------- */

type State = 'idle' | 'running' | 'ok' | 'bad' | 'na';

type Step = {
  root: HTMLElement;
  set(state: State, outcome: string, extra?: { links?: HTMLElement[]; tech?: HTMLElement }): void;
};

function makeStep(n: number, title: string, why: string): Step {
  const badge = h('div', { class: 'badge', 'aria-hidden': 'true' }, String(n));
  const outcome = h('p', { class: 'outcome', role: 'status' }, 'Waiting');
  const body = h('div', {}, h('h2', {}, title), h('p', { class: 'why' }, why), outcome);
  const root = h('section', { class: 'card step', 'data-state': 'idle' }, badge, body);
  let extras: HTMLElement[] = [];
  return {
    root,
    set(state, text, extra) {
      root.dataset.state = state;
      badge.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'running' ? '' : state === 'na' ? '–' : String(n);
      outcome.textContent = text;
      for (const e of extras) e.remove();
      extras = [];
      if (extra?.links?.length) extras.push(h('div', { class: 'links' }, ...extra.links));
      if (extra?.tech) extras.push(h('details', { class: 'tech' }, h('summary', {}, 'Technical details'), extra.tech));
      body.append(...extras);
    },
  };
}

const steps = {
  program: makeStep(
    1,
    'The program is the published one',
    'Everything else rests on this: the rules in this repository only matter if they are the code actually running on Solana. Your browser downloads the program from the chain and compares it byte for byte with the binary published here.'
  ),
  entrants: makeStep(
    2,
    'The ticket list is the one sealed before the draw',
    'Before a draw closes, a fingerprint (hash) of its full ticket list is written to Solana, where nobody can change it. Your browser fetches the published list, fingerprints it itself and compares.'
  ),
  seed: makeStep(
    3,
    'Nobody could know the random number in advance',
    'The winners are picked from a random seed. It mixes the sealed list with the hash of a Solana block produced after the list was sealed — so when the list was fixed, the seed did not exist yet, for us or anyone.'
  ),
  settlement: makeStep(
    4,
    'The winners and prizes are the committed ones',
    'When the draw settles, a fingerprint of every result — each winning ticket, its place and its prize — is written to Solana. Your browser recomputes it from the published results. Change one amount or one winner and it no longer matches.'
  ),
};

$('steps').append(...Object.values(steps).map((s) => s.root));

function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|too many requests/i.test(msg)) {
    return `The Solana RPC is rate-limiting this browser (${msg}). Wait a minute and press Check again, or put another devnet RPC in Settings.`;
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return `Could not reach the network (${msg}). Check your connection, the RPC and the site address in Settings.`;
  }
  return msg;
}

/** Errors that mean "not there yet", not "something is wrong". */
const notYet = (e: unknown) =>
  /No DrawSeed|No DrawCommit|no completed settlement|Could not find the draw_randomness/i.test(
    e instanceof Error ? e.message : String(e)
  );

/* ---------------------------------------------------------------------------------------------- */

async function runProgram(): Promise<State> {
  const s = steps.program;
  s.set('running', 'Downloading the program from Solana…');
  try {
    const release = new Uint8Array(await (await fetch(releaseUrl)).arrayBuffer());
    const r = await checkProgramBinary(release);
    const links = [
      link(r.solscan, 'Program on Solscan'),
      link(`${REPO}/tree/main/programs/gift_draw_registry`, 'Source code'),
      link(`${REPO}/blob/main/release/gift_draw_registry.so`, 'Published binary'),
    ];
    const tech = kv([
      ['Program id', r.programId],
      ['Program data account', r.programDataAddress],
      ['Bytes on chain', r.onChainBytes],
      ['Bytes published', r.releaseBytes],
      ['SHA-256 on chain', r.onChainSha256],
      ['SHA-256 published', r.releaseSha256],
      ['RPC', r.rpc],
    ]);
    if (r.ok) {
      s.set('ok', `The program on Solana is exactly the one published here (${r.onChainBytes.toLocaleString('en')} bytes, identical fingerprint).`, { links, tech });
      return 'ok';
    }
    s.set('bad', 'The program on Solana differs from the binary published here. Nothing below can be relied on until this matches.', { links, tech });
    return 'bad';
  } catch (e) {
    s.set('bad', explainError(e));
    return 'bad';
  }
}

async function runEntrants(drawId: string): Promise<State> {
  const s = steps.entrants;
  s.set('running', 'Fetching the published ticket list and the sealed fingerprint…');
  try {
    const r = await checkEntrants(drawId, api(), {
      onProgress: (n) =>
        s.set('running', `Reading the published ticket list… (${n.toLocaleString('en')} tickets)`),
    });
    const links = [
      ...(r.solscan ? [link(r.solscan, 'Sealed fingerprint on Solscan (DrawSeed)')] : []),
      link(r.entrantsUrl, 'Published ticket list (JSON)'),
    ];
    const tech = kv([
      ['Tickets in the draw', r.entrantCount],
      ['Excluded tickets', r.excludedCount],
      ['Fingerprint, recomputed here', r.recomputedRoot],
      ['Fingerprint, published by the site', r.publishedRoot],
      ['Fingerprint, sealed on Solana', r.onChainRoot],
      ['List matches its own fingerprint', mark(r.listHashOk)],
      ['Matches Solana', mark(r.onChainOk)],
      ['Entry rule re-applied, same list', mark(r.filterOk)],
    ]);
    if (r.result === 'match') {
      const rule = r.filterOk ? ' Re-applying the entry rule to the raw ticket data gives the same list.' : '';
      s.set('ok', `All ${r.entrantCount.toLocaleString('en')} tickets are exactly the list sealed on Solana before the draw closed.${rule}`, { links, tech });
      return 'ok';
    }
    if (r.result === 'not-committed') {
      s.set('na', 'Nothing is sealed on Solana for this draw yet — it is probably still open. Try an earlier draw.', { links, tech });
      return 'na';
    }
    if (r.result === 'entrant-list-not-published') {
      s.set('na', 'The fingerprint is on Solana, but the site no longer publishes this draw’s ticket list, so there is nothing to compare it with. That is neither a match nor a mismatch — try a recent draw.', { links, tech });
      return 'na';
    }
    const why =
      r.listHashOk && r.onChainOk === false
        ? 'The published list does not match the fingerprint sealed on Solana. (If you changed the RPC or site in Settings, check they are the same deployment.)'
        : r.filterOk === false
          ? 'The entry rule, re-applied to the raw ticket data, gives a different list than the one published.'
          : 'The published list does not match its own fingerprint.';
    s.set('bad', why, { links, tech });
    return 'bad';
  } catch (e) {
    s.set(notYet(e) ? 'na' : 'bad', explainError(e));
    return notYet(e) ? 'na' : 'bad';
  }
}

async function runSeed(drawId: string): Promise<State> {
  const s = steps.seed;
  s.set('running', 'Looking for the transaction that sealed the list…');
  try {
    const r = await checkSeed(drawId, (n) =>
      s.set('running', `Looking for the transaction that sealed the list… (${n} read)`)
    );
    const e = r.entropy;
    const links = [
      link(r.sealTx, 'Sealing transaction'),
      link(r.drawSeedSolscan, 'DrawSeed'),
      ...(e ? [link(e.solscan, 'DrawEntropy (the block hash used)')] : []),
      ...(r.drawCommitSolscan ? [link(r.drawCommitSolscan, 'DrawCommit (seed the draw used)')] : []),
    ];
    const tech = kv([
      ['Settlement spec', r.specVersion],
      ['Draw period ended', r.periodEndIso],
      ['List sealed in slot', r.sealSlot],
      ['Target slot (sealed + 2)', e?.targetSlot],
      ['Slot whose hash was used', e?.slot],
      ['That slot’s hash', e?.slotHash],
      ['Re-armed', e ? e.rearmCount : undefined],
      ['Base seed = SHA256(id | period end | list fingerprint)', r.baseSeed],
      ['Final seed = SHA256(base ‖ slot ‖ slot hash)', r.finalSeed],
      ['Seed the draw was settled with', r.committedSeed],
      ['Base seed recomputed', mark(r.baseSeedOk)],
      ['Block-hash mix recomputed', mark(r.entropyOk)],
      ['Target slot is sealed + 2', mark(r.targetSlotOk)],
      ['Draw used this seed', mark(r.commitOk)],
    ]);
    if (r.specVersion >= 21 && !e?.revealed) {
      s.set('na', 'The list is sealed, but the random part is not revealed yet — the draw is still running.', { links, tech });
      return 'na';
    }
    if (r.ok && r.commitOk === null) {
      s.set('na', 'The seed checks out, but the result is not committed to Solana yet — the draw is still settling.', { links, tech });
      return 'na';
    }
    if (r.ok) {
      const text =
        r.specVersion >= 21 && e
          ? `The seed was computed from the sealed list and the hash of block ${e.slot} — produced after the list was sealed in block ${r.sealSlot}. The draw was settled with exactly this seed.` +
            (e.rearmCount > 0 ? ` (The target block was moved ${e.rearmCount} time(s) because nobody revealed in time; see "Missed window" in the spec.)` : '')
          : 'The seed was recomputed from the sealed list, and the draw was settled with exactly this seed. (This draw predates the block-hash mix, spec 21.)';
      s.set('ok', text, { links, tech });
      return 'ok';
    }
    s.set('bad', 'The seed recomputed here differs from the one on Solana — see the ✗ lines in the technical details.', { links, tech });
    return 'bad';
  } catch (e) {
    s.set(notYet(e) ? 'na' : 'bad', explainError(e));
    return notYet(e) ? 'na' : 'bad';
  }
}

async function runSettlement(drawId: string): Promise<State> {
  const s = steps.settlement;
  s.set('running', 'Fetching the results and the committed fingerprint…');
  const exportUrl = `${api()}/api/draws?action=settlement-export&drawId=${encodeURIComponent(drawId)}`;
  try {
    const data = await fetchSettlementExport(drawId, api());
    const r = await checkSettlement(data);
    const links = [link(r.solscan, 'Committed fingerprint on Solscan (DrawCommit)'), link(exportUrl, 'Published results (JSON)')];
    const prizeLines = [...data.prizes]
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.ticket_id - b.ticket_id)
      .map((p) => {
        const what = p.gift_amount === null ? 'free ticket' : `${Number(p.gift_amount).toLocaleString('en', { maximumFractionDigits: 8 })} GIFT`;
        const kind = p.prize_bucket === 'jackpot_gift' ? 'Grand Prize share' : p.rank ? `place ${p.rank}` : p.prize_bucket;
        return h('li', {}, `Ticket #${p.ticket_id} — ${kind} — ${what}`);
      });
    const tech = h(
      'div',
      {},
      kv([
        ['Prize rows', r.prizeRowCount],
        ['Winning tickets', r.distinctWinnerTickets],
        ['Winners on Solana', r.onChainWinnerCount],
        ['Fingerprint, recomputed here', r.recomputedHash],
        ['Fingerprint, committed on Solana', r.onChainHash],
        ['Fingerprint matches', mark(r.hashOk)],
        ['Winner count matches', mark(r.winnerCountOk)],
        ['Seed matches', mark(r.seedOk)],
        ['Ticket list fingerprint matches', mark(r.merkleOk)],
        ['Spec version matches', mark(r.specOk)],
      ]),
      h('details', {}, h('summary', {}, `All ${prizeLines.length} prize rows`), h('ul', {}, ...prizeLines))
    );
    if (r.ok) {
      s.set('ok', `All ${r.prizeRowCount.toLocaleString('en')} prizes for ${r.distinctWinnerTickets.toLocaleString('en')} winning tickets match the fingerprint committed on Solana.`, { links, tech });
      return 'ok';
    }
    s.set('bad', 'The published results do not match the fingerprint committed on Solana — see the ✗ lines in the technical details.', { links, tech });
    return 'bad';
  } catch (e) {
    if (notYet(e)) {
      s.set('na', 'This draw has not settled yet — no results to check.');
      return 'na';
    }
    if (/unknown action/i.test(e instanceof Error ? e.message : String(e))) {
      // A site from before the export endpoint: nothing to check here, but nothing wrong either.
      s.set('na', 'This site does not publish its results in the export format yet. The check still runs from a terminal with a results file — see "Prize amounts and ranks" in the README.', {
        links: [link(`${REPO}#5-prize-amounts-and-ranks-are-the-committed-ones`, 'README: checking prizes')],
      });
      return 'na';
    }
    s.set('bad', explainError(e), { links: [link(exportUrl, 'Published results (JSON)')] });
    return 'bad';
  }
}

/* ---------------------------------------------------------------------------------------------- */

function drawLabel(drawId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:_(\d+))?$/.exec(drawId);
  if (!m) return drawId;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return m[4] ? `${date}, draw ${m[4]}` : date;
}

function showVerdict(drawId: string, states: State[]): void {
  const box = $('verdict');
  const bad = states.filter((x) => x === 'bad').length;
  const ok = states.filter((x) => x === 'ok').length;
  box.hidden = false;
  box.replaceChildren();
  const share = new URL(location.href);
  share.search = '';
  share.searchParams.set('draw', drawId);
  if (rpcInput.value.trim()) share.searchParams.set('rpc', rpcInput.value.trim());
  if (apiInput.value.trim()) share.searchParams.set('api', apiInput.value.trim());
  const text =
    bad > 0
      ? `${bad} of ${states.length} checks failed for the draw of ${drawLabel(drawId)}.`
      : ok === states.length
        ? `All ${states.length} checks passed for the draw of ${drawLabel(drawId)}.`
        : `${ok} of ${states.length} checks passed for the draw of ${drawLabel(drawId)}; the rest cannot run yet.`;
  const custom = customEndpoints();
  box.append(
    h('p', { class: `verdict ${bad > 0 ? 'bad' : ok === states.length ? 'ok' : ''}` }, text),
    ...(custom.length ? [h('p', { class: 'warn' }, `Checked against ${custom.join(' and ')}, not the defaults.`)] : []),
    h('p', { class: 'hint' }, 'Link to this check: ', link(share.toString(), share.toString()))
  );
}

async function run(): Promise<void> {
  const drawId = (drawInput.value.trim() || drawSelect.value).trim();
  if (!DRAW_ID_RE.test(drawId)) {
    drawInput.focus();
    drawInput.setCustomValidity('A draw id looks like 20260925 or 20260925_2');
    drawInput.reportValidity();
    return;
  }
  drawInput.setCustomValidity('');
  for (const input of [rpcInput, apiInput]) {
    if (input.value.trim() && !httpUrl(input.value)) {
      input.closest('details')?.setAttribute('open', '');
      input.setCustomValidity('An http(s) address, or empty for the default');
      input.reportValidity();
      return;
    }
  }
  showCustomWarning();
  setChainOverrides({ cluster: 'devnet', rpc: rpc() });

  const url = new URL(location.href);
  url.searchParams.set('draw', drawId);
  history.replaceState(null, '', url);

  runButton.disabled = true;
  $('verdict').hidden = true;
  for (const s of Object.values(steps)) s.set('idle', 'Waiting');
  try {
    // One after another: the public RPC rate-limits bursts, and each step reads on its own.
    const states: State[] = [];
    states.push(await runProgram());
    states.push(await runEntrants(drawId));
    states.push(await runSeed(drawId));
    states.push(await runSettlement(drawId));
    showVerdict(drawId, states);
  } finally {
    runButton.disabled = false;
  }
}

async function loadDraws(): Promise<void> {
  try {
    const res = await fetch(`${api()}/api/draws?action=drawchain`);
    const body = (await res.json()) as { ok?: boolean; chain?: Array<{ drawId: string; entrantCount: number }> };
    const todayUtc = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const draws = (body.chain || [])
      .filter((d) => d.entrantCount > 0 && DRAW_ID_RE.test(d.drawId))
      .reverse();
    drawSelect.replaceChildren(
      ...draws.map((d) => {
        const open = d.drawId.slice(0, 8) >= todayUtc ? ' · still open' : '';
        return h('option', { value: d.drawId }, `${drawLabel(d.drawId)} · ${d.entrantCount.toLocaleString('en')} tickets${open}`);
      })
    );
    if (!draws.length) drawSelect.append(h('option', { value: '' }, 'No draws yet — type an id'));
    const firstClosed = draws.find((d) => d.drawId.slice(0, 8) < todayUtc);
    if (firstClosed) drawSelect.value = firstClosed.drawId;
  } catch {
    drawSelect.replaceChildren(h('option', { value: '' }, 'Could not load the list — type an id'));
  }
}

drawSelect.addEventListener('change', () => {
  drawInput.value = '';
});
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  void run();
});

// A draw in the address starts at once: the check does not need the list, and a slow list must not
// hold it up.
void loadDraws();
if (params.get('draw')) void run();

