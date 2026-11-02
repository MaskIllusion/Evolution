// src/meta/archon.js
//
// The archon is the being's outside. It holds the source chain,
// enforces the static and dynamic checks, and swaps the worker
// to a new head when a rewrite passes. The being cannot edit
// the archon. The archon edits the being.
//
// Step 4 adds:
//   - Signature computation for antibodies (depth-4 skeleton).
//   - Antibody persistence on reject; short-circuit on >=3 hits.
//   - Cache relay: chain, antibodies, dialog → meta worker.
//   - Answer ring writer: archon writes answers into the SAB.
//   - attachSim: archon obtains a view of the SAB to write the
//     answer ring. The meta worker reads it.

import * as acorn from 'acorn';
import {
  openRegistry, loadHead, saveLink, loadChain,
  saveAntibody, loadAntibodies, clearAntibodies,
  saveDialog, loadDialog,
} from './registry.js';
import { runStaticChecks }  from './static.js';
import { runDynamicChecks } from './dynamic.js';
import {
  IMMORTAL_IO_SIZE,
  IIO_ANSWER_RING_BASE,
  IIO_ANSWER_HEAD_OFF,
} from '../sim/shared-buffer.js';

export const ARCHON_VERSION = 'archon-2026-09-30-a1';

const MAX_PROPOSAL_BYTES = 64 * 1024;

// Answer ring layout. Sourced from shared-buffer.js so all three
// modules agree. The ring occupies immortalIO[288..375]; the head
// and read cursors are at 376 and 377.
const ANSWER_RING_BASE   = IIO_ANSWER_RING_BASE;
const ANSWER_RING_SLOTS  = 11;
const ANSWER_HEAD_OFF    = IIO_ANSWER_HEAD_OFF;

export function createArchon() {
  let head            = null;
  let workerRef       = null;
  let simRef          = null;
  let immortalIO      = null;
  let answerWriteHead = 0;
  let ledger          = [];
  let pendingQuestions = new Map();

  // Serialises expansions. A second proposal while a swap is in
  // flight is rejected immediately rather than queued — the being
  // paid for the first one, so the second one has no claim.
  let swapInFlight = false;

  // Active bounds of the live SAB. ...
  let currentBounds = { beings: 8000, food: 6000, corpse: 3000, struct: 6000, grid: 256 };

  const EXPANSION_LIMITS = Object.freeze({
    beingsMax: 24000,
    foodMax:   18000,
    gridMax:   512,
  });

  async function boot() {
    await openRegistry();
    const stored = await loadHead();
    if (stored) {
      head = { hash: stored.hash, source: stored.source, url: makeBlobUrl(stored.source) };
    } else {
      const seedSrc = await fetch('./src/meta/self.genesis.js').then(r => r.text());
      const hash = await sha256(seedSrc);
      head = { hash, source: seedSrc, url: makeBlobUrl(seedSrc) };
      await saveLink({ hash, source: seedSrc, parentHash: null, ts: Date.now() });
    }
    return head;
  }

  function getHead() { return head; }
  function getVersion() { return ARCHON_VERSION; }

  function attachWorker(w) {
    workerRef = w;
    w.addEventListener('message', onWorkerMessage);
    refreshCaches();
  }

  function attachSim(sim) {
    simRef = sim;
    immortalIO = new Float32Array(sim.sab, sim.offsets.immortalIO,
                                  IMMORTAL_IO_SIZE);
    answerWriteHead = immortalIO[ANSWER_HEAD_OFF] | 0;
    // Snapshot the current bounds from the sim's typed-array
    // lengths. These are the active counts, not the module
    // constants — if the sim ever swaps to a larger SAB, the
    // lengths reflect the new size.
    currentBounds = {
      beings: sim.beings.length / 12,
      food:   sim.food.length   / 6,
      corpse: sim.corpse.length / 5,
      struct: sim.struct.length / 10,
      grid:   Math.round(Math.sqrt(sim.fieldF.length)),
    };
    // Rebinding the view in a single method. When a swap happens,
    // the archon calls this again with the same simRef (whose
    // fields _rebind has already replaced) so the answer-ring
    // writes land in the new SAB. Without this, after the first
    // swap, the archon would write to the old SAB while the meta
    // worker reads from the new one.
  }

  function onWorkerMessage(e) {
    const m = e.data;
    if (!m || typeof m !== 'object') return;

    if (m.type === 'ask-user') {
      handleAskUser(m);
      return;
    }

    if (m.type === 'propose-expansion') {
      handleExpansion(m.plan)
        .then(r => {
          console.log('[archon] expansion result:', r);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('archon:expansion-result', { detail: r }));
          }
        })
        .catch(err =>
          console.warn('[archon] expansion threw:', err));
      return;
    }
  }

  /* ── Signature ────────────────────────────────────────────── */

  async function signatureOf(ast) {
    const skeleton = canonicalSkeleton(ast, 4);
    const hex = await sha256(skeleton);
    return hex.slice(0, 16);
  }

  function canonicalSkeleton(node, depth) {
    if (depth <= 0) return '';
    if (!node || typeof node !== 'object') return '';
    const t = node.type || '?';
    const children = [];
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' ||
          key === 'raw'  || key === '__parent' || key === 'parent') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === 'object' && c.type) children.push(c);
      } else if (v && typeof v === 'object' && v.type) {
        children.push(v);
      }
    }
    let s = t;
    for (const c of children) s += '|' + canonicalSkeleton(c, depth - 1);
    return s;
  }

  function fallbackSignature(source, reason) {
    const s = (reason || '') + '|' + source.slice(0, 500);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'F' + (h >>> 0).toString(16).padStart(8, '0');
  }

  /* ── Proposal ─────────────────────────────────────────────── */

  async function receiveProposal(proposal) {
    if (!proposal || typeof proposal.source !== 'string') {
      return rejectOnly('malformed');
    }
    if (proposal.source.length > MAX_PROPOSAL_BYTES) {
      return rejectOnly('oversize');
    }
    if (proposal.parentHash !== head.hash) {
      return rejectOnly('chain mismatch');
    }

    let ast = null;
    let parseError = null;
    try {
      ast = acorn.parse(proposal.source, {
        ecmaVersion: 2022, sourceType: 'module', locations: false,
      });
    } catch (e) {
      parseError = e.message;
    }

    const signature = ast
      ? await signatureOf(ast)
      : fallbackSignature(proposal.source, 'parse: ' + parseError);

    // Antibody short-circuit. The stored reason is preserved
    // unchanged across hits — it is the original diagnosis. Only
    // the hit counter grows.
    const antibodies = await loadAntibodies();
    const known = antibodies.find(a => a.signature === signature);
    if (known && (known.hits || 1) >= 3) {
      await saveAntibody({ signature, reason: known.reason });
      await refreshCaches();
      return rejectOnly('antibody: ' + known.reason);
    }

    if (parseError) {
      await saveAntibody({ signature, reason: 'parse: ' + parseError });
      await refreshCaches();
      return rejectOnly('parse: ' + parseError);
    }

    const staticResult = runStaticChecks(ast, proposal.source);
    if (!staticResult.pass) {
      await saveAntibody({ signature, reason: 'static: ' + staticResult.reason });
      await refreshCaches();
      return rejectOnly('static: ' + staticResult.reason);
    }

    let shadowModule;
    const shadowUrl = makeBlobUrl(proposal.source);
    try {
      shadowModule = await import(/* @vite-ignore */ shadowUrl);
    } catch (e) {
      URL.revokeObjectURL(shadowUrl);
      await saveAntibody({ signature, reason: 'load: ' + e.message });
      await refreshCaches();
      return rejectOnly('load: ' + e.message);
    }

    let dynamicResult;
    try {
      dynamicResult = await runDynamicChecks({
        oldModule: await import(/* @vite-ignore */ head.url),
        newModule: shadowModule,
        oldSource: head.source,
        newSource: proposal.source,
      });
    } catch (e) {
      URL.revokeObjectURL(shadowUrl);
      await saveAntibody({ signature, reason: 'dynamic-throw: ' + e.message });
      await refreshCaches();
      return rejectOnly('dynamic-throw: ' + e.message);
    }
    if (!dynamicResult.pass) {
      URL.revokeObjectURL(shadowUrl);
      await saveAntibody({ signature, reason: 'dynamic: ' + dynamicResult.reason });
      await refreshCaches();
      return rejectOnly('dynamic: ' + dynamicResult.reason);
    }

    const newHash = await sha256(proposal.source);
    const prevUrl = head.url;
    head = { hash: newHash, source: proposal.source, url: shadowUrl };

    await saveLink({
      hash: newHash,
      source: proposal.source,
      parentHash: proposal.parentHash,
      ts: Date.now(),
      rationale: proposal.rationale || '',
      staticResult,
      dynamicResult,
    });

    URL.revokeObjectURL(prevUrl);

    if (workerRef) {
      workerRef.postMessage({
        type: 'swap-module',
        hash: newHash,
        url: shadowUrl,
      });
    }

    ledger.push({
      ts: Date.now(),
      from: proposal.parentHash,
      to: newHash,
      rationale: proposal.rationale || '',
      verdict: 'commit',
    });

    await refreshCaches();
    return { status: 'commit', hash: newHash };
  }

  function rejectOnly(reason) {
    ledger.push({ ts: Date.now(), reason, verdict: 'reject' });
    return { status: 'reject', reason };
  }

  /* ── Cache relay ──────────────────────────────────────────── */

  async function refreshCaches() {
    if (!workerRef) return;
    try {
      const [chain, antibodies, dialog] = await Promise.all([
        loadChain(),
        loadAntibodies(),
        loadDialog(8),
      ]);
      workerRef.postMessage({ type: 'chain',      entries: chain });
      workerRef.postMessage({ type: 'antibodies', entries: antibodies });
      workerRef.postMessage({ type: 'dialog',     entries: dialog });
    } catch (e) {
      console.warn('[archon] refreshCaches failed:', e);
    }
  }

  /* ── Answer ring ──────────────────────────────────────────── */

  function writeAnswer({ id, type, value }) {
    if (!immortalIO) {
      console.warn('[archon] writeAnswer: no SAB attached');
      return false;
    }
    const slot = answerWriteHead % ANSWER_RING_SLOTS;
    const base = ANSWER_RING_BASE + slot * 8;
    immortalIO[base + 0] = id | 0;
    immortalIO[base + 1] = type | 0;
    immortalIO[base + 2] = typeof value === 'number' ? value : 0;
    answerWriteHead = (answerWriteHead + 1) & 0xFFFF;
    immortalIO[ANSWER_HEAD_OFF] = answerWriteHead;
    return true;
  }

  /* ── Question handling ────────────────────────────────────── */

  function handleAskUser(m) {
    const id       = m.id | 0;
    const topic    = m.topic | 0;
    const urgency  = Math.max(0, Math.min(1, Number(m.urgency) || 0.5));
    const context  = Array.isArray(m.context) ? m.context.slice(0, 8).map(Number) : [];
    const options  = Array.isArray(m.options) ? m.options.slice(0, 4).map(String) : [];
    const freeform = !!m.freeform;

    const question = {
      questionId: id, topic, urgency, context, options, freeform, ts: Date.now(),
    };

    // Register the resolver synchronously. Any await before this
    // point would open a race with the main-thread caller of
    // resolveQuestion().
    const promise = new Promise((resolve) => {
      pendingQuestions.set(id, { resolve, question });
    });

    // Side effects fire-and-forget. Do not block registration.
    (async () => {
      try {
        await saveDialog({ role: 'question', question });
        await refreshCaches();
      } catch (e) {
        console.warn('[archon] handleAskUser persistence failed:', e);
      }
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(
            new CustomEvent('archon:question', { detail: question }));
        } catch (e) {
          console.warn('[archon] handleAskUser dispatch failed:', e);
        }
      }
    })();

    return promise;
  }

  function resolveQuestion(id, value) {
    const p = pendingQuestions.get(id | 0);
    if (!p) return false;
    pendingQuestions.delete(id | 0);
    const isNumeric = typeof value === 'number';
    writeAnswer({ id: id | 0, type: isNumeric ? 0 : 1, value });
    // The dialog store uses an auto-incrementing key named `id`.
    // Writing a top-level `id` here would collide with the store's
    // own key path and raise ConstraintError. The correlation
    // field is `questionId`, not `id`.
    saveDialog({ role: 'answer', questionId: id | 0, value })
      .then(refreshCaches)
      .catch(e => console.warn('[archon] answer persist failed:', e));
    p.resolve(value);
    return true;
  }

  /* ── Expansion handling ─────────────────────────────────────
   *
   * The being proposes a world expansion. This handler:
   *   1. Validates the plan against EXPANSION_LIMITS.
   *   2. Computes the target bounds and the delta.
   *   3. Computes the drain cost in energy units.
   *   4. Asks the sim worker to drain the top percentile.
   *   5. Reports the outcome.
   *
   * Until the SAB swap protocol lands (Step 6c-3), the drain is
   * the terminal action. The being pays for what it asked for.
   * Whether it receives the space is a separate question, decided
   * by whether the swap protocol is wired.
   *
   * Cost model:
   *   cost = 0.5 * (Δbeings + Δfood + Δgrid_cells / 4)
   *
   * Grid cells count for 1/4 because a grid doubling is a large
   * array change but does not multiply being energy demand. This
   * weight is an operator choice, not a physical constant.
   */
  async function handleExpansion(plan) {
    console.log('[archon] expansion proposed:', plan);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('archon:expansion',
                                           { detail: plan }));
    }

    if (swapInFlight) {
      return { status: 'rejected', reason: 'swap already in flight' };
    }
    swapInFlight = true;

    try {
      return await _expand(plan);
    } finally {
      swapInFlight = false;
    }
  }

  async function _expand(plan) {
    if (!simRef) {
      return { status: 'rejected', reason: 'no sim attached' };
    }

    const wantBeings = Math.min(
      EXPANSION_LIMITS.beingsMax,
      currentBounds.beings + Math.max(0, plan.beings | 0));
    const wantFood = Math.min(
      EXPANSION_LIMITS.foodMax,
      currentBounds.food + Math.max(0, plan.food | 0));
    const wantGrid = plan.grid === 512
      ? Math.max(currentBounds.grid, 512)
      : currentBounds.grid;

    const dBeings = wantBeings - currentBounds.beings;
    const dFood   = wantFood   - currentBounds.food;
    const dGrid   = wantGrid   - currentBounds.grid;

    if (dBeings === 0 && dFood === 0 && dGrid === 0) {
      return { status: 'noop', reason: 'already at limit' };
    }

    const dGridCells = 3 * (wantGrid * wantGrid - currentBounds.grid * currentBounds.grid);
    const cost = 0.5 * (dBeings + dFood + dGridCells / 4);

    let drain;
    try {
      drain = await simRef.query('drainTopPercentile', {
        amount: cost,
        fraction: 0.01,
      });
    } catch (e) {
      return { status: 'rejected', reason: 'drain threw: ' + e.message };
    }
    if (!drain || drain.error) {
      return {
        status: 'rejected',
        reason: 'drain error: ' + (drain ? drain.error : 'no result'),
      };
    }

    await refreshCaches();

    if (drain.shortfall > 0.5) {
      // The population could not pay. Drain already happened for
      // whatever was available. The being paid partially and gets
      // nothing. This is a deliberate asymmetry — asking costs.
      return {
        status:    'underfunded',
        reason:    'population could not pay full cost',
        cost:      +cost.toFixed(2),
        drained:   drain.drained,
        shortfall: drain.shortfall,
        poolSize:  drain.poolSize,
        topN:      drain.topN,
      };
    }

    // ── Paid in full. Perform the swap.
    //
    // In Part B, we allocate a same-size SAB. Part C will pass the
    // target bounds to allocate() to actually grow.
    const newCfg = {
      beings: wantBeings,
      food:   wantFood,
      grid:   wantGrid,
      corpse: currentBounds.corpse,
      struct: currentBounds.struct,
    };

    let alloc;
    try {
      alloc = await import('../sim/shared-buffer.js')
        .then(mod => mod.allocate(newCfg));
    } catch (e) {
      return { status: 'rejected', reason: 'allocate failed: ' + e.message };
    }

    const { sab: newSab, offsets: newOffsets, cfg: confirmedCfg } = alloc;

    // 1. Sim worker first — source of truth.
    const simAck = await new Promise((resolve) => {
      const handler = (e) => {
        if (e.data && e.data.type === 'swap-sab-ack') {
          simRef.worker.removeEventListener('message', handler);
          resolve({ ok: true, cfg: e.data.cfg });
        } else if (e.data && e.data.type === 'swap-sab-err') {
          simRef.worker.removeEventListener('message', handler);
          resolve({ ok: false, error: e.data.error });
        }
      };
      simRef.worker.addEventListener('message', handler);
      simRef.worker.postMessage({
        type: 'swap-sab', sab: newSab, offsets: newOffsets, cfg: confirmedCfg,
      });
      setTimeout(() => {
        simRef.worker.removeEventListener('message', handler);
        resolve({ ok: false, error: 'sim swap timeout' });
      }, 5000);
    });

    if (!simAck.ok) {
      return { status: 'swap-failed', phase: 'sim', reason: simAck.error };
    }

    // 2. Update the main-thread sim reference.
    try {
      simRef._rebind(newSab, newOffsets, confirmedCfg);
    } catch (e) {
      return { status: 'swap-failed', phase: 'rebind', reason: e.message };
    }

    // 2b. Reattach the archon's view to the new SAB. simRef's
    //     fields (sab, offsets, immortalIO) have all been
    //     replaced by _rebind; attachSim picks up the new values.
    //     Without this call, the archon keeps writing answer-ring
    //     entries into the old SAB, and the meta worker never
    //     sees them.
    attachSim(simRef);

    // 3. Meta worker.
    const metaAck = await new Promise((resolve) => {
      if (!workerRef) return resolve({ ok: true, skipped: true });
      const handler = (e) => {
        if (e.data && e.data.type === 'swap-sab-ack') {
          workerRef.removeEventListener('message', handler);
          resolve({ ok: true });
        } else if (e.data && e.data.type === 'swap-sab-err') {
          workerRef.removeEventListener('message', handler);
          resolve({ ok: false, error: e.data.error });
        }
      };
      workerRef.addEventListener('message', handler);
      workerRef.postMessage({
        type: 'swap-sab', sab: newSab, offsets: newOffsets,
      });
      setTimeout(() => {
        workerRef.removeEventListener('message', handler);
        resolve({ ok: false, error: 'meta swap timeout' });
      }, 5000);
    });

    if (!metaAck.ok) {
      return { status: 'swap-failed', phase: 'meta', reason: metaAck.error };
    }

    // 4. Update currentBounds.
    currentBounds = {
      beings: confirmedCfg.beings,
      food:   confirmedCfg.food,
      grid:   confirmedCfg.grid,
      corpse: confirmedCfg.corpse,
      struct: confirmedCfg.struct,
    };

    return {
      status:    'swapped',
      cost:      +cost.toFixed(2),
      drained:   drain.drained,
      count:     drain.count,
      poolSize:  drain.poolSize,
      topN:      drain.topN,
      fromCfg:   { beings: drain.poolSize /* dummy */ },
      newCfg:    confirmedCfg,
    };
  }

  /* ── Maintenance ──────────────────────────────────────────── */

  async function resetAntibodies() {
    await clearAntibodies();
    await refreshCaches();
    return true;
  }

  /* ── Hashing ──────────────────────────────────────────────── */

  async function sha256(s) {
    const buf = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  function makeBlobUrl(source) {
    const blob = new Blob([source], { type: 'text/javascript' });
    return URL.createObjectURL(blob);
  }

  /* ── resetHeadToGenesis ─────────────────────────────────────
   *
   * Re-seeds the head from ./src/meta/self.genesis.js. Used when
   * the genesis file is edited and the operator wants the new
   * version to become the chain head without clearing the whole
   * registry (which would also discard antibodies and dialog).
   *
   * This does NOT go through receiveProposal. It writes directly.
   * The current head's source is not checked. The new source is
   * not verified by static or dynamic checks.
   *
   * That is deliberate: genesis is the root of trust. If the
   * operator cannot bootstrap genesis, they cannot bootstrap
   * anything. ReceiveProposal is for the being's own rewrites.
   * resetHeadToGenesis is for the operator's.
   */
  async function resetHeadToGenesis() {
    const src = await fetch('./src/meta/self.genesis.js?v='
                          + Date.now()).then(r => r.text());
    const newHash = await sha256(src);
    const prevHash = head ? head.hash : null;
    const prevUrl  = head ? head.url  : null;
    const newUrl   = makeBlobUrl(src);

    head = { hash: newHash, source: src, url: newUrl };

    await saveLink({
      hash: newHash,
      source: src,
      parentHash: prevHash,
      ts: Date.now(),
      rationale: 'operator reset to genesis',
    });

    if (workerRef) {
      workerRef.postMessage({
        type: 'swap-module',
        hash: newHash,
        url: newUrl,
      });
    }
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    await refreshCaches();

    return {
      oldHash: prevHash,
      newHash,
      sourceLength: src.length,
      hasCandidates:  src.includes('export function candidates'),
      hasFormEffects: src.includes('export const FORM_EFFECTS'),
    };
  }

  return {
    boot,
    getHead,
    getVersion,
    attachWorker,
    attachSim,
    receiveProposal,
    resolveQuestion,
    writeAnswer,
    refreshCaches,
    resetAntibodies,
    resetHeadToGenesis,
    ledger,
  };
}