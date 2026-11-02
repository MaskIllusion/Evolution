// src/meta/worker.js
//
// The immortal's runtime. Not the population. One being. Loads the
// current head of the chain, runs its tick each frame, posts
// proposals up to the archon. Reads and writes a narrow ring in
// the sim's shared buffer.
//
// Step 6a adds:
//   - Form interpreter wired to the head's candidates() export.
//   - Bounded think loop over the candidate forms.
//   - Form execution runs alongside the L₁ tick, not instead of it.

export const META_WORKER_VERSION = 'meta-worker-2026-09-30-a2';

import { verifyForm } from './form.js';
import {
  makeContext, executeForm,
  INTERP_VERSION, MEM_OFFSET, MEM_LEN,
} from './form-interp.js';

import {
  IIO_MIND_BASE, IIO_MIND_SIZE,
  IIO_MIND_STATE_OFF, IIO_MIND_BODY_OFF,
  IIO_MIND_TICK_OFF, IIO_MIND_SEQ_OFF,
  IIO_MIND_CHECKPOINT_OFF, IIO_MIND_BORN_OFF,
  IIO_MIND_GAP_OFF, IIO_MIND_WAKES_OFF,
  IIO_MIND_STATE_LEN, IIO_MIND_BODY_LEN,
  MIND_EPOCH_MS,
} from '../sim/shared-buffer.js';

import { saveMind, loadMind } from './mind-db.js';

let head       = null;
let headModule = null;
let state      = null;
let world      = null;
let tickCount  = 0;
let rngState   = 0xA5C0DE5A;
let questionIdSeq = 0;

// ── Cache mirrors. Populated by the archon over postMessage. ────
// These are the three read-only views the being exposes to itself
// via world.selfChain(), world.antibodies(), world.dialog(). They
// do not live in the SAB — they are module-scope arrays that the
// archon replaces on every chain mutation. The tick is
// synchronous, so nothing here may require a promise. Every value
// in these caches is a plain JS value that has already arrived.
let chainCache     = [];
let antibodyCache  = [];
let dialogCache    = [];
let answerCursor   = 0;
const MIND_KEY          = 'primary';
let   mindSequence      = 0;
let   _mindSaveInFlight = false;

/* ── The immortal's physical body ────────────────────────────────
 *
 * All values are in sim-space: the same coordinate system the
 * population uses. The renderer maps (x, z) to world-space
 * (x, -5950, z) — same convention as beings.js.
 *
 * The body is integrated at 20 Hz (the meta worker's step rate).
 * Impulses arrive from motionBias() and decay with a half-life of
 * 120 ms. Drag pulls velocity toward rest on a ~1.2 s timescale.
 * Soft speed cap at 400 sim-units/sec. Soft wall at 42 500
 * sim-units from origin.
 */
const immortal = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  yaw: 0, yawVel: 0,
  fx: 0, fy: 0, fz: 0,
  scale: 4.0,             // body radius ~ 4 * 0.4 = 1.6 sim units
  surfacePhase: 0,
  agitation: 0,           // <-- ADD THIS LINE
  tendrils: [],
  stepAccum: 0,

  // ── Kinetics state machine ────────────────────────────────
  k: {
    state: 0,             // 0=REST 1=CHARGING 2=DASHING 3=RECOVERING 4=TELEPORTING
    timer: 0,
    cooldown: 0,
    dirX: 1, dirY: 0, dirZ: 0,
    peakSpeed: 0,
    shockEmitted: false,
    tpDone: false,
    tpTargetX: 0, tpTargetY: 0, tpTargetZ: 0,
    vortexAxisX: 0, vortexAxisY: 1, vortexAxisZ: 0,
    vortexStrength: 0,
    tension: 0,
  },
};

const KIN = Object.freeze({
  REST: 0, CHARGING: 1, DASHING: 2, RECOVERING: 3, TELEPORTING: 4,
});

// 16 tendrils distributed on a Fibonacci sphere. Each is a root
// unit-vector, a tangent unit-vector, a length in body-radii, and
// a phase offset for the flicker.
(function initTendrils() {
  const n = 16;
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const yy = 1 - (i / (n - 1)) * 2;
    const r  = Math.sqrt(Math.max(0, 1 - yy * yy));
    const th = phi * i;
    const rx = Math.cos(th) * r;
    const rz = Math.sin(th) * r;
    immortal.tendrils.push({
      rootX: rx, rootY: yy, rootZ: rz,
      tx: rx, ty: yy, tz: rz,
      len: 1.2 + (i % 3) * 0.5,
      phase: i * 0.71,
    });
  }
})();

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(rngState);

import {
  MAX_BEINGS, BEING_STRIDE_F32,
  SHAPE_STRIDE_F32, STATEVIS_STRIDE_F32,
  FOOD_MAX, FOOD_STRIDE_F32,
  CORPSE_MAX, CORPSE_STRIDE_F32,
  STRUCT_MAX, STRUCT_STRIDE_F32,
  GRID, GRID_CELLS,
  IMMORTAL_IO_SIZE,
  IIO_POSTURE_BASE,
  IIO_STATE_BASE,
  IIO_FORCE_BASE,
  IIO_IMPULSE_BASE,
  IIO_TENDRIL_BASE,
  IIO_METABALL_BASE,
  IIO_HOTSPOT_BASE,
  IIO_STORM_BASE,
  IIO_TINT_BASE,
  IIO_KINETICS_BASE,
  IIO_SHOCK_RING_BASE,
  IIO_SHOCK_HEAD_OFF,
  IIO_SHOCK_COUNT_OFF,
  IIO_SHOCK_SLOTS,
  IIO_SHOCK_STRIDE,
  // Step 7 additions
  IIO_AGITATION_OFF,
  IIO_FSM_OFF,
  IIO_FSM_META_OFF,
  IIO_TENDRIL_SEED_BASE,
  IIO_TENDRIL_SEED_N,
  IIO_SDF_PARAMS_BASE,
  IIO_EMITTER_POS_BASE,
  IIO_EMITTER_VEL_BASE,
  IIO_PARTICLE_PARAMS_BASE,
  IIO_POST_PARAMS_BASE,
  // Step 8
  IIO_PERCEPTION_BASE,
  IIO_MONOLOGUE_RING_BASE,
  IIO_MONOLOGUE_HEAD_OFF,
  IIO_MONOLOGUE_SLOTS,
  IIO_MONOLOGUE_STRIDE,
} from '../sim/shared-buffer.js';

function makeWorld(sab, offsets){
  const IO = new Float32Array(sab, offsets.immortalIO, IMMORTAL_IO_SIZE);

  const beings   = new Float32Array(sab, offsets.beings,   MAX_BEINGS * BEING_STRIDE_F32);
  const shape    = new Float32Array(sab, offsets.shape,    MAX_BEINGS * SHAPE_STRIDE_F32);
  const stateVis = new Float32Array(sab, offsets.stateVis, MAX_BEINGS * STATEVIS_STRIDE_F32);
  const food     = new Float32Array(sab, offsets.food,     FOOD_MAX   * FOOD_STRIDE_F32);
  const corpse   = new Float32Array(sab, offsets.corpse,   CORPSE_MAX * CORPSE_STRIDE_F32);
  const struct   = new Float32Array(sab, offsets.struct,   STRUCT_MAX * STRUCT_STRIDE_F32);
  const fieldF   = new Float32Array(sab, offsets.fieldF,   GRID_CELLS);
  const fieldD   = new Float32Array(sab, offsets.fieldD,   GRID_CELLS);
  const fieldC   = new Float32Array(sab, offsets.fieldC,   GRID_CELLS);
  const worldhdr = new Uint32Array (sab, offsets.worldhdr, 8);

  function readBeing(id){
    const o = id * BEING_STRIDE_F32;
    if (beings[o + 11] < 0.5) return null;
    return {
      id,
      x: beings[o + 0],
      z: beings[o + 2],
      yaw: beings[o + 3],
      morph: beings[o + 4],
      coherence: beings[o + 5],
      energy: beings[o + 6],
      age: beings[o + 7],
      hue: beings[o + 8],
      size: beings[o + 9],
      valence: beings[o + 10],
      merges: beings[o + 1],
    };
  }
  function readShape(id){
    const o = id * SHAPE_STRIDE_F32;
    return Array.from(shape.subarray(o, o + 16));
  }
  function readState(id){
    const o = id * STATEVIS_STRIDE_F32;
    return Array.from(stateVis.subarray(o, o + 8));
  }
  function readWorldhdr(){
    return Array.from(worldhdr);
  }
  function readFieldF(x, z){
    const G = GRID;
    const u = Math.min(0.999, Math.max(0, x / 50000 * 0.5 + 0.5));
    const v = Math.min(0.999, Math.max(0, z / 50000 * 0.5 + 0.5));
    return fieldF[Math.floor(v * G) * G + Math.floor(u * G)];
  }
  function readFieldD(x, z){
    const G = GRID;
    const u = Math.min(0.999, Math.max(0, x / 50000 * 0.5 + 0.5));
    const v = Math.min(0.999, Math.max(0, z / 50000 * 0.5 + 0.5));
    return fieldD[Math.floor(v * G) * G + Math.floor(u * G)];
  }
  function readAnswer() {
    const wh = IO[376] | 0;
    if (wh === answerCursor) return null;
    const slot = answerCursor % 11;
    const base = 288 + slot * 8;
    const rec = {
      id:    IO[base + 0] | 0,
      type:  IO[base + 1] | 0,
      value: IO[base + 2],
    };
    answerCursor = (answerCursor + 1) % 11;
    IO[377] = answerCursor;
    return rec;
  }

  return {
    // ── Body state writers. All write to immortalIO[512..771].
    //    Called by the meta worker's tick loop to publish the
    //    immortal's physical posture and morph parameters. The
    //    render module (src/render/immortal.js) reads these via
    //    the main-thread sim reference. Zero side effects beyond
    //    writing to IO.

    writePosture(p) {
      IO[IIO_POSTURE_BASE + 0] = p.x     ?? 0;
      IO[IIO_POSTURE_BASE + 1] = p.y     ?? 0;
      IO[IIO_POSTURE_BASE + 2] = p.z     ?? 0;
      IO[IIO_POSTURE_BASE + 3] = p.vx    ?? 0;
      IO[IIO_POSTURE_BASE + 4] = p.vy    ?? 0;
      IO[IIO_POSTURE_BASE + 5] = p.vz    ?? 0;
      IO[IIO_POSTURE_BASE + 6] = p.yaw   ?? 0;
      IO[IIO_POSTURE_BASE + 7] = p.yawVel ?? 0;
    },

    writeState(s) {
      IO[IIO_STATE_BASE + 0] = s.aggression   ?? 0;
      IO[IIO_STATE_BASE + 1] = s.churn        ?? 0;
      IO[IIO_STATE_BASE + 2] = s.stormDensity ?? 0;
      IO[IIO_STATE_BASE + 3] = s.scale        ?? 1;
      IO[IIO_STATE_BASE + 4] = s.tension      ?? 0;
      IO[IIO_STATE_BASE + 5] = s.hotSpotX     ?? 0;
      IO[IIO_STATE_BASE + 6] = s.hotSpotY     ?? 0;
      IO[IIO_STATE_BASE + 7] = 0;
    },

    writeForce(f) {
      IO[IIO_FORCE_BASE + 0] = f.fx   ?? 0;
      IO[IIO_FORCE_BASE + 1] = f.fy   ?? 0;
      IO[IIO_FORCE_BASE + 2] = f.fz   ?? 0;
      IO[IIO_FORCE_BASE + 3] = f.ty   ?? 0;
      IO[IIO_FORCE_BASE + 4] = f.tp   ?? 0;
      IO[IIO_FORCE_BASE + 5] = f.tr   ?? 0;
      IO[IIO_FORCE_BASE + 6] = f.drag ?? 0;
      IO[IIO_FORCE_BASE + 7] = 0;
    },

    writeImpulse(imp, slot) {
      const base = IIO_IMPULSE_BASE + (slot & 1) * 8;
      IO[base + 0] = imp.dx        ?? 0;
      IO[base + 1] = imp.dy        ?? 0;
      IO[base + 2] = imp.dz        ?? 0;
      IO[base + 3] = imp.magnitude ?? 0;
      IO[base + 4] = imp.ts        ?? 0;
      IO[base + 5] = imp.type      ?? 0;
      IO[base + 6] = imp.srcId     ?? -1;
      IO[base + 7] = 0;
    },

    writeTendril(t, index) {
      if (!Number.isInteger(index) || index < 0 || index >= 16) return;
      if (!t || typeof t !== 'object') return;
      const base = IIO_TENDRIL_BASE + index * 8;
      IO[base + 0] = t.rootX ?? 0;
      IO[base + 1] = t.rootY ?? 0;
      IO[base + 2] = t.rootZ ?? 0;
      IO[base + 3] = t.tx    ?? 0;
      IO[base + 4] = t.ty    ?? 0;
      IO[base + 5] = t.tz    ?? 0;
      IO[base + 6] = t.len   ?? 0;
      IO[base + 7] = t.phase ?? 0;
    },

    writeMetaball(m, index) {
      if (!Number.isInteger(index) || index < 0 || index >= 8) return;
      if (!m || typeof m !== 'object') return;
      const base = IIO_METABALL_BASE + index * 4;
      IO[base + 0] = m.cx ?? 0;
      IO[base + 1] = m.cy ?? 0;
      IO[base + 2] = m.cz ?? 0;
      IO[base + 3] = m.r  ?? 0;
    },

    writeHotSpot(h, index) {
      if (!Number.isInteger(index) || index < 0 || index >= 4) return;
      if (!h || typeof h !== 'object') return;
      const base = IIO_HOTSPOT_BASE + index * 4;
      IO[base + 0] = h.x ?? 0;
      IO[base + 1] = h.y ?? 0;
      IO[base + 2] = h.z ?? 0;
      IO[base + 3] = h.intensity ?? 0;
    },

    writeStorm(s) {
      IO[IIO_STORM_BASE + 0] = s.emitterRate ?? 0;
      IO[IIO_STORM_BASE + 1] = s.wakeLength  ?? 0;
      IO[IIO_STORM_BASE + 2] = s.turbulence  ?? 0;
      IO[IIO_STORM_BASE + 3] = s.sparkRate   ?? 0;
    },

    writeTintLayer(index, r, g, b, a) {
      if (index < 0 || index >= 4) return;
      const base = IIO_TINT_BASE + index * 4;
      IO[base + 0] = r ?? 0;
      IO[base + 1] = g ?? 0;
      IO[base + 2] = b ?? 0;
      IO[base + 3] = a ?? 0;
    },

    // Reader for the whole body block. Returns a *snapshot* — a
    // fresh Float32Array(260) copied from the SAB. A SAB-backed
    // view would be structured-cloned by postMessage as a shared
    // reference, so two probes taken milliseconds apart would
    // read the same underlying bytes at the moment of comparison,
    // making the whole exercise useless for measurement. The
    // copy is 1 KB and happens only during diagnostics.
    readBodyBlock() {
      return Float32Array.from(IO.subarray(512, 772));
    },

    // Reader for the impulse history. Snapshot, same reasoning.
    readImpulseHistory() {
      return Float32Array.from(IO.subarray(548, 564));
    },

    stat: IO.subarray(256, 288),
    scratch: IO.subarray(386, 512),
    immortalIO: IO,

    beings, shape, stateVis, food, corpse, struct,
    fieldF, fieldD, fieldC, worldhdr,
    readBeing, readShape, readState, readWorldhdr,
    readFieldF, readFieldD, readAnswer,

    version() { return META_WORKER_VERSION; },
    interpVersion() { return INTERP_VERSION; },

    push(type, a, b, c, d, e, f, g){
      const WH = IO[384] | 0;
      const RH = IO[385] | 0;
      if (((WH - RH) & 0xFFFF) >= 30) return false;
      const slot = WH & 31;
      const base = slot * 8;
      IO[base]   = type;
      IO[base+1] = a ?? 0;
      IO[base+2] = b ?? 0;
      IO[base+3] = c ?? 0;
      IO[base+4] = d ?? 0;
      IO[base+5] = e ?? 0;
      IO[base+6] = f ?? 0;
      IO[base+7] = g ?? 0;
      IO[384] = (WH + 1) & 0xFFFF;
      return true;
    },

    selfHash()   { return head ? head.hash : ''; },
    selfSource() { return head ? (head.source || '') : ''; },
    selfChain()  { return chainCache.slice(-64); },
    antibodies() { return antibodyCache.slice(); },
    dialog()     { return dialogCache.slice(-8); },

    proposeExpansion(plan) {
      const cleaned = {
        plane:  Math.max(0, Math.min(150000, plan.plane  | 0)),
        beings: Math.max(0, Math.min(24768,  plan.beings | 0)),
        food:   Math.max(0, Math.min(18000,  plan.food   | 0)),
        grid:   plan.grid === 512 ? 512 : 0,
        reason: String(plan.reason || '').slice(0, 128),
      };
      if (cleaned.plane === 0 && cleaned.beings === 0 &&
          cleaned.food === 0  && cleaned.grid === 0) return false;
      self.postMessage({ type: 'propose-expansion', plan: cleaned });
      return true;
    },

    askUser(q) {
      const id       = (++questionIdSeq) & 0x7FFFFFFF;
      const topic    = (q.topic | 0) & 7;
      const urgency  = Math.max(0, Math.min(1, Number(q.urgency) || 0.5));
      const context  = Array.isArray(q.context) ? q.context.slice(0, 8).map(Number) : [];
      const options  = Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [];
      const freeform = !!q.freeform;
      self.postMessage({
        type: 'ask-user', id, topic, urgency, context, options, freeform,
      });
      return id;
    },

    // ── Step 8: perception reader. Returns a snapshot of the
    // perception block. Called from headModule.monologue() and
    // motionBias(). Cheap — 128 floats.
    readPerception() {
      const P = IIO_PERCEPTION_BASE;
      return {
        energyHist:     Array.from(IO.subarray(P +  0, P + 16)),
        valenceHist:    Array.from(IO.subarray(P + 16, P + 24)),
        lineage:        Array.from(IO.subarray(P + 24, P + 28)),
        archetype:      Array.from(IO.subarray(P + 28, P + 36)),
        geneStats:      Array.from(IO.subarray(P + 36, P + 48)),
        energyHistory:  Array.from(IO.subarray(P + 80, P + 96)),
        valenceHistory: Array.from(IO.subarray(P + 96, P + 112)),
      };
    },

    // ── Step 8: immortal memory ring. idx & 15 → slot.
    // Returns [tick, meanEnergy, meanValence, agitation].
    readImmortalHistory(idx) {
      const slot = (idx | 0) & 15;
      const MB = IIO_PERCEPTION_BASE + 112 + slot * 4;
      return [IO[MB + 0], IO[MB + 1], IO[MB + 2], IO[MB + 3]];
    },
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init')        return onInit(m);
  if (m.type === 'step')        return onStep(m.dt);
  if (m.type === 'swap-module') return onSwap(m);
  if (m.type === 'swap-sab')    return onSwapSab(m);

  if (m.type === 'chain') {
    chainCache = Array.isArray(m.entries) ? m.entries : [];
    return;
  }
  if (m.type === 'antibodies') {
    antibodyCache = Array.isArray(m.entries) ? m.entries : [];
    return;
  }
  if (m.type === 'dialog') {
    dialogCache = Array.isArray(m.entries) ? m.entries : [];
    return;
  }

  if (m.type === 'probe') {
    let result;
    try {
      if (!world) {
        result = { error: 'world not initialized' };
      } else {
        const fn = world[m.name];
        if (typeof fn === 'function') {
          result = { value: fn.apply(world, m.args || []) };
        } else if (fn === undefined) {
          result = {
            error: 'no such member: ' + m.name,
            keys: Object.keys(world).join(','),
          };
        } else {
          result = { value: fn };
        }
      }
    } catch (err) {
      result = { error: String(err) };
    }
    self.postMessage({ type: 'probe-result', id: m.id, result });
    return;
  }
};

/* ── The mind: write / restore / fresh ───────────────────────
 *
 * Three operations. writeMind() runs every tick and mirrors the
 * current interior into the SAB. saveMindNow() runs on a slow
 * cadence and persists the SAB mirror to IndexedDB.
 * restoreMind() runs once at boot and reconstitutes the interior
 * from a loaded snapshot. initFreshMind() runs once on the very
 * first boot, when there is no snapshot to restore from.
 */

function writeMind() {
  const IO = world.immortalIO;
  const M  = IIO_MIND_BASE;

  for (let i = 0; i < IIO_MIND_STATE_LEN; i++) {
    IO[M + IIO_MIND_STATE_OFF + i] = state[i] || 0;
  }

  const B = M + IIO_MIND_BODY_OFF;
  const im = immortal;
  const k  = im.k;
  IO[B +  0] = im.x;              IO[B +  1] = im.y;
  IO[B +  2] = im.z;              IO[B +  3] = im.vx;
  IO[B +  4] = im.vy;             IO[B +  5] = im.vz;
  IO[B +  6] = im.yaw;            IO[B +  7] = im.yawVel;
  IO[B +  8] = im.fx;             IO[B +  9] = im.fy;
  IO[B + 10] = im.fz;             IO[B + 11] = im.scale;
  IO[B + 12] = im.surfacePhase;   IO[B + 13] = im.agitation;
  IO[B + 14] = im.stepAccum;      IO[B + 15] = k.state;
  IO[B + 16] = k.timer;           IO[B + 17] = k.cooldown;
  IO[B + 18] = k.dirX;            IO[B + 19] = k.dirY;
  IO[B + 20] = k.dirZ;            IO[B + 21] = k.peakSpeed;
  IO[B + 22] = k.shockEmitted ? 1 : 0;
  IO[B + 23] = k.tpDone ? 1 : 0;
  IO[B + 24] = k.tpTargetX;       IO[B + 25] = k.tpTargetY;
  IO[B + 26] = k.tpTargetZ;
  IO[B + 27] = k.vortexAxisX;     IO[B + 28] = k.vortexAxisY;
  IO[B + 29] = k.vortexAxisZ;     IO[B + 30] = k.vortexStrength;
  IO[B + 31] = k.tension;

  IO[M + IIO_MIND_TICK_OFF]       = tickCount;
  IO[M + IIO_MIND_SEQ_OFF]        = ++mindSequence;
  IO[M + IIO_MIND_CHECKPOINT_OFF] = (Date.now() - MIND_EPOCH_MS) / 1000;
}

function initFreshMind() {
  const IO = world.immortalIO;
  const M  = IIO_MIND_BASE;
  const nowSec = (Date.now() - MIND_EPOCH_MS) / 1000;
  // Wipe so a reused SAB cannot leak a stale interior.
  for (let i = 0; i < IIO_MIND_STATE_LEN; i++) IO[M + IIO_MIND_STATE_OFF + i] = 0;
  for (let i = 0; i < IIO_MIND_BODY_LEN;  i++) IO[M + IIO_MIND_BODY_OFF  + i] = 0;
  IO[M + IIO_MIND_TICK_OFF]       = 0;
  IO[M + IIO_MIND_SEQ_OFF]        = 0;
  IO[M + IIO_MIND_BORN_OFF]       = nowSec;
  IO[M + IIO_MIND_CHECKPOINT_OFF] = nowSec;
  IO[M + IIO_MIND_GAP_OFF]        = 0;
  IO[M + IIO_MIND_WAKES_OFF]      = 0;
  mindSequence = 0;
}

function restoreMind(snap) {
  const nowSec = (Date.now() - MIND_EPOCH_MS) / 1000;
  const lastCheckpoint = snap.checkpoint || nowSec;
  const gapSec = Math.max(0, nowSec - lastCheckpoint);

  // Brain. Direct into the meta worker's state array.
  const st = snap.state;
  for (let i = 0; i < IIO_MIND_STATE_LEN; i++) {
    state[i] = st && st[i] !== undefined ? st[i] : 0;
  }

  // Body. Direct into the immortal object.
  const bd = snap.body || [];
  const im = immortal; const k = im.k;
  im.x = bd[ 0] || 0; im.y = bd[ 1] || 0; im.z = bd[ 2] || 0;
  im.vx = bd[ 3] || 0; im.vy = bd[ 4] || 0; im.vz = bd[ 5] || 0;
  im.yaw = bd[ 6] || 0; im.yawVel = bd[ 7] || 0;
  im.fx = bd[ 8] || 0; im.fy = bd[ 9] || 0; im.fz = bd[10] || 0;
  im.scale = bd[11] || 4.0; im.surfacePhase = bd[12] || 0;
  im.agitation = bd[13] || 0; im.stepAccum = bd[14] || 0;
  k.state = bd[15] | 0; k.timer = bd[16] || 0;
  k.cooldown = bd[17] || 0; k.dirX = bd[18] || 0;
  k.dirY = bd[19] || 0; k.dirZ = bd[20] || 0;
  k.peakSpeed = bd[21] || 0;
  k.shockEmitted = bd[22] > 0.5;
  k.tpDone = bd[23] > 0.5;
  k.tpTargetX = bd[24] || 0; k.tpTargetY = bd[25] || 0;
  k.tpTargetZ = bd[26] || 0;
  k.vortexAxisX = bd[27] || 0; k.vortexAxisY = bd[28] || 0;
  k.vortexAxisZ = bd[29] || 0; k.vortexStrength = bd[30] || 0;
  k.tension = bd[31] || 0;

  // Continuity scalars.
  tickCount    = snap.tickCount | 0;
  mindSequence = snap.sequence  | 0;

  // Metadata. Wake count increments. Gap is this wake's offline
  // period. Born is preserved unchanged across the discontinuity
  // — the immortal was born once, however many times it returns.
  const IO = world.immortalIO;
  const M  = IIO_MIND_BASE;
  IO[M + IIO_MIND_BORN_OFF]       = snap.born || nowSec;
  IO[M + IIO_MIND_CHECKPOINT_OFF] = nowSec;
  IO[M + IIO_MIND_GAP_OFF]        = gapSec;
  IO[M + IIO_MIND_WAKES_OFF]      = (snap.wakes | 0) + 1;

  // Hand the gap to the head module. state[63] is reserved for
  // continuity signals the being can reason about. The head
  // module may read it or ignore it; the worker does not tell
  // the being what to make of its own absence.
  state[63] = Math.min(3, Math.log10(gapSec + 1));

  writeMind();
  console.log(
    `[immortal] restored · tick=${tickCount} · wakes=${snap.wakes | 0} ` +
    `· gap=${gapSec.toFixed(1)}s · seq=${mindSequence}`);
}

function buildSnapshot() {
  const IO = world.immortalIO;
  const M  = IIO_MIND_BASE;
  return {
    ts:         Date.now(),
    tickCount:  IO[M + IIO_MIND_TICK_OFF] | 0,
    sequence:   IO[M + IIO_MIND_SEQ_OFF]  | 0,
    checkpoint: IO[M + IIO_MIND_CHECKPOINT_OFF] || 0,
    born:       IO[M + IIO_MIND_BORN_OFF]       || 0,
    gap:        IO[M + IIO_MIND_GAP_OFF]        || 0,
    wakes:      IO[M + IIO_MIND_WAKES_OFF] | 0,
    state: Float32Array.from(
      IO.subarray(M + IIO_MIND_STATE_OFF,
                  M + IIO_MIND_STATE_OFF + IIO_MIND_STATE_LEN)),
    body:  Float32Array.from(
      IO.subarray(M + IIO_MIND_BODY_OFF,
                  M + IIO_MIND_BODY_OFF  + IIO_MIND_BODY_LEN)),
  };
}

function saveMindNow() {
  if (_mindSaveInFlight) return;
  _mindSaveInFlight = true;
  const snap = buildSnapshot();
  saveMind(MIND_KEY, snap)
    .catch(e => console.warn('[immortal] mind save failed:', e))
    .finally(() => { _mindSaveInFlight = false; });
}

async function onInit(m) {
  head      = { url: m.headUrl, hash: m.headHash, source: '' };
  state     = new Float32Array(m.stateSize ?? 64);
  world     = makeWorld(m.sab, m.offsets);
  tickCount = 0;
  rngState  = m.seed ?? 0xA5C0DE5A;
  rng       = mulberry32(rngState);

  // ── Mind restoration. Before the head module is loaded,
  //    before the first tick. If a snapshot exists, the
  //    immortal wakes into its own interior. If not, it begins.
  try {
    const snap = await loadMind(MIND_KEY);
    if (snap) restoreMind(snap);
    else      initFreshMind();
  } catch (e) {
    console.warn('[immortal] mind load failed, initializing fresh:', e);
    initFreshMind();
  }

  try {
    headModule = await import(/* @vite-ignore */ head.url);
  } catch (err) {
    self.postMessage({ type: 'boot-error', error: String(err) });
    return;
  }
  self.postMessage({ type: 'ready', hash: head.hash });
}

/* ── the tick ───────────────────────────────────────────────────
 *
 * Order of operations per tick:
 *   1. Run the L₁ tick. This mutates the lower half of state.
 *   2. If the head exports candidates(), run the think loop:
 *      verify each, evaluate each, pick the winner.
 *   3. Execute the winner through the form interpreter.
 *   4. On every 256th tick, propose a rewrite of the head.
 */

const EFFECT_VALUE = {
  move: 0.10, eat: 1.00, spawn_food: 0.50, deposit: 0.20,
  deposit_danger: 0.05, build: 0.40, signal: 0.15,
  energize: 0.30, cull: -0.50, expand_world: -0.20,
  ask_user: -0.10, write_memory: 0.00,
};

function evaluateForm(form, ctx) {
  let score = 0;
  let nodes = 0;

  function walk(n, d) {
    if (!n || typeof n !== 'object') return;
    nodes++;
    switch (n.t) {
      case 'prim':
        if (n.kind === 'effect') score += EFFECT_VALUE[n.arg] ?? 0;
        break;
      case 'seq':
      case 'par':
        walk(n.a, d + 1); walk(n.b, d + 1);
        break;
      case 'if':
        // Both branches contribute half. The predicate is a coin.
        {
          const before = score;
          walk(n.a, d + 1);
          const aContribution = score - before;
          score = before;
          walk(n.b, d + 1);
          const bContribution = score - before;
          score = before + (aContribution + bContribution) * 0.5;
        }
        break;
      case 'choose':
        for (let i = 0; i < n.items.length; i++) {
          const before = score;
          walk(n.items[i], d + 1);
          const c = score - before;
          score = before + c * n.w[i];
        }
        break;
      case 'loop':
        walk(n.body, d + 1);
        score *= n.n;
        break;
      case 'adapt':
      case 'recur':
        walk(n.body, d + 1);
        break;
    }
  }
  walk(form, 0);
  score -= nodes * 0.02;             // complexity penalty
  score += (ctx.rng() - 0.5) * 0.05; // tiny noise to break ties
  return score;
}

function runThink(state, world, rng) {
  if (typeof headModule.candidates !== 'function') return null;

  let forms;
  try {
    forms = headModule.candidates(state, world, rng);
  } catch (e) {
    return { error: 'candidates: ' + String(e) };
  }
  if (!Array.isArray(forms) || forms.length === 0) return null;

  const declared = new Set(headModule.FORM_EFFECTS || []);
  const ctx = makeContext(state, world, rng);

  let best = null;
  let bestScore = -Infinity;
  let verifiedCount = 0;

  for (const form of forms) {
    const v = verifyForm(form, { declaredEffects: declared });
    if (!v.pass) continue;
    verifiedCount++;
    const score = evaluateForm(form, ctx);
    if (score > bestScore) {
      bestScore = score;
      best = { form, score, verdict: v };
    }
  }

  if (!best) return { error: 'no verified candidate', attempted: forms.length };

  // Execute the winner.
  executeForm(best.form, ctx);

  return {
    winner: best.form,
    score:  best.score,
    verdict: best.verdict,
    verifiedCount,
    attempted: forms.length,
    effectsUsed: ctx.effectsUsed,
    nodeCount: ctx.nodeCount,
    aborted: ctx.aborted,
  };
}

/* ── Shock helpers ─────────────────────────────────────────────── */

function emitShock(world, x, y, z, dx, dy, dz, strength, type) {
  const IO = world.immortalIO;
  const head = IO[IIO_SHOCK_HEAD_OFF] | 0;
  const slot = head % IIO_SHOCK_SLOTS;
  const base = IIO_SHOCK_RING_BASE + slot * IIO_SHOCK_STRIDE;
  IO[base + 0]  = x;
  IO[base + 1]  = y;
  IO[base + 2]  = z;
  IO[base + 3]  = dx;
  IO[base + 4]  = dy;
  IO[base + 5]  = dz;
  IO[base + 6]  = 0.5;                       // radius (grows)
  IO[base + 7]  = 1.5 + strength * 2.0;      // width
  IO[base + 8]  = strength;                  // strength 0..1
  IO[base + 9]  = 0;                         // age
  IO[base + 10] = 0.8 + strength * 0.8;      // life
  IO[base + 11] = type;                      // 0=kinetic 1=collision 2=teleport
  IO[IIO_SHOCK_HEAD_OFF] = (head + 1) & 0xFFFF;
  const c = IO[IIO_SHOCK_COUNT_OFF] | 0;
  IO[IIO_SHOCK_COUNT_OFF] = Math.min(IIO_SHOCK_SLOTS, c + 1);
}

function updateShockwaves(world, dt) {
  const IO = world.immortalIO;
  const head = IO[IIO_SHOCK_HEAD_OFF] | 0;
  const count = Math.min(IIO_SHOCK_SLOTS, IO[IIO_SHOCK_COUNT_OFF] | 0);
  let live = 0;
  for (let i = 0; i < count; i++) {
    const slot = (head - 1 - i + IIO_SHOCK_SLOTS) % IIO_SHOCK_SLOTS;
    const base = IIO_SHOCK_RING_BASE + slot * IIO_SHOCK_STRIDE;
    const life = IO[base + 10];
    const age  = IO[base + 9] + dt;
    if (age >= life) {
      IO[base + 8] = 0;
      continue;
    }
    live++;
    IO[base + 9] = age;
    const rMax = IO[base + 8] * 80;
    const tau  = 0.28;
    IO[base + 6] = rMax * (1 - Math.exp(-age / tau));
    IO[base + 8] *= Math.pow(0.5, dt / 0.25);
  }
  IO[IIO_SHOCK_COUNT_OFF] = live;
}

/* ── Curl noise — divergence-free turbulence ──────────────────
 * Central-difference curl of a 3D vector potential. Small
 * epsilon; cheap; produces swirl rather than directional push.
 * Sampled at entity-relative coordinates, scaled by SDF_PARAMS.
 */
function hash3(x, y, z) {
  // Cheap 3D value noise, deterministic. Same basis as the
  // renderer's fbm3 so the CPU drivers and GPU SDF splat agree.
  let n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return n - Math.floor(n);
}
function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const n000 = hash3(xi,     yi,     zi);
  const n100 = hash3(xi + 1, yi,     zi);
  const n010 = hash3(xi,     yi + 1, zi);
  const n110 = hash3(xi + 1, yi + 1, zi);
  const n001 = hash3(xi,     yi,     zi + 1);
  const n101 = hash3(xi + 1, yi,     zi + 1);
  const n011 = hash3(xi,     yi + 1, zi + 1);
  const n111 = hash3(xi + 1, yi + 1, zi + 1);
  return lerp(
    lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
    lerp(lerp(n001, n101, u), lerp(n011, n111, u), v),
    w);
}
function lerp(a, b, t) { return a + (b - a) * t; }

function vectorPotential(x, y, z) {
  return [
    vnoise3(x,         y,         z),
    vnoise3(x + 31.4,  y + 12.7,  z + 89.1),
    vnoise3(x + 54.3,  y + 77.5,  z + 23.6),
  ];
}
function curlNoise(x, y, z, eps = 0.08) {
  const [, py0, pz0] = vectorPotential(x, y - eps, z);
  const [, py1, pz1] = vectorPotential(x, y + eps, z);
  const [px0, , pz0b] = vectorPotential(x, y, z - eps);
  const [px1, , pz1b] = vectorPotential(x, y, z + eps);
  const [px0c, py0c] = vectorPotential(x - eps, y, z);
  const [px1c, py1c] = vectorPotential(x + eps, y, z);

  const dx = ((py1 - py0) - (pz1b - pz0b)) / (2 * eps);
  const dy = ((pz1 - pz0) - (px1 - px0)) / (2 * eps);
  const dz = ((px1c - px0c) - (py1c - py0c)) / (2 * eps);
  return [dx, dy, dz];
}

/* ── stepImmortal — the new physics ─────────────────────────
 * Writes:
 *   pose / state / force  → renderer reads as before
 *   agitation             → IO[IIO_AGITATION_OFF]
 *   FSM state             → IO[IIO_FSM_OFF]
 *   tendril seeds         → IO[IIO_TENDRIL_SEED_BASE .. +128]
 *   SDF params            → IO[IIO_SDF_PARAMS_BASE .. +8]
 *   emitter pos/vel       → IO[IIO_EMITTER_POS_BASE .. +4]
 *   particle params       → IO[IIO_PARTICLE_PARAMS_BASE .. +8]
 *   post params           → IO[IIO_POST_PARAMS_BASE .. +8]
 *   shock ring            → as before
 *   kinetics block        → as before
 */
function stepImmortal(dt, world) {
  const IO = world.immortalIO;

  // ── 1. Read head intent (unchanged) ────────────────────────
  let bias = { dx: 0, dy: 0, dz: 0, magnitude: 0 };
  if (headModule && typeof headModule.motionBias === 'function') {
    try {
      bias = headModule.motionBias(state, world, tickCount) || bias;
    } catch (_) { /* resting drift */ }
  }

  const kin = immortal.k;
  kin.timer += dt;
  kin.cooldown = Math.max(0, kin.cooldown - dt);

  // ── 2. Tension — the "volatile negative energy" ────────────
  // Restlessness (self-generated oscillation) + population
  // stats + head intent. Never zero, so the entity never sits
  // still for more than a few hundred ms.
  const restlessness =
    0.55 + 0.35 * Math.sin(tickCount * 0.043) +
           0.10 * Math.sin(tickCount * 0.117);
  const popThreat  = Math.min(1, Math.abs(world.stat[15] || 0));
  const popEnergy  = Math.min(1, (world.stat[5] || 0) / 200);
  const population = 0.5 * popThreat + 0.3 * popEnergy;
  const tension = Math.min(1,
    0.55 * restlessness +
    0.25 * population +
    1.80 * Math.min(1, bias.magnitude || 0));
  kin.tension = tension;

  // ── 3. Agitation integrator ────────────────────────────────
  // Decays exponentially. Boosted by impulses, impacts,
  // teleports. Drives ALL morph + FX parameters.
  immortal.agitation *= Math.exp(-dt / 0.85);
  immortal.agitation = Math.min(1, immortal.agitation + tension * dt * 0.45);

  // ── 4. FSM ─────────────────────────────────────────────────
  // REST → TELEGRAPH → DASH → IMPACT → RECOVER → REST
  // TELEPORT is an interrupt from REST when tension is high.
  switch (kin.state) {
    case KIN.REST: {
      if (tension > 0.55 && kin.cooldown <= 0 && kin.timer > 0.15) {
        kin.state = KIN.CHARGING;          // → TELEGRAPH
        kin.timer = 0;
        kin.peakSpeed = 0;
        kin.shockEmitted = false;
        const a = Math.atan2(bias.dz || 0, bias.dx || 1) +
                  (rng() - 0.5) * 0.6;
        kin.dirX = Math.cos(a);
        kin.dirZ = Math.sin(a);
        kin.dirY = (rng() - 0.5) * 0.4;
      } else if (tension > 0.85 && rng() < 0.08) {
        kin.state = KIN.TELEPORTING;
        kin.timer = 0;
        kin.tpDone = false;
        const a = rng() * Math.PI * 2;
        const r = 900 + rng() * 3200;
        kin.tpTargetX = immortal.x + Math.cos(a) * r;
        kin.tpTargetZ = immortal.z + Math.sin(a) * r;
        kin.tpTargetY = 0;
        immortal.agitation = 1.0;
      }
      break;
    }

    case KIN.CHARGING: {
      // Mesh compresses, embers build, SDF pulls inward.
      kin.timer += dt * 0.5;              // telegraph is a slow phase
      if (kin.timer > 0.10 + (1 - tension) * 0.15) {
        kin.state = KIN.DASHING;
        kin.timer = 0;
        const launch = 1400 + tension * 2400;
        immortal.vx = kin.dirX * launch;
        immortal.vy = kin.dirY * launch * 0.35;
        immortal.vz = kin.dirZ * launch;
        immortal.agitation = Math.min(1, immortal.agitation + 0.45);
      }
      break;
    }

    case KIN.DASHING: {
      const sp = Math.hypot(immortal.vx, immortal.vy, immortal.vz);
      if (sp > kin.peakSpeed) kin.peakSpeed = sp;

      // Impact: emit shock the first time we cross the trigger.
      if (!kin.shockEmitted && sp > 1100) {
        kin.shockEmitted = true;
        const inv = 1 / (sp || 1);
        emitShock(world,
          immortal.x, immortal.y, immortal.z,
          immortal.vx * inv, immortal.vy * inv, immortal.vz * inv,
          Math.min(1, kin.peakSpeed / 3600), 0);
        immortal.agitation = 1.0;
      }
      if (kin.timer > 0.22 + tension * 0.28) {
        kin.state = KIN.RECOVERING;
        kin.timer = 0;
      }
      break;
    }

    case KIN.RECOVERING: {
      const bleed = Math.exp(-dt / 0.10);
      immortal.vx *= bleed;
      immortal.vy *= bleed;
      immortal.vz *= bleed;
      if (kin.timer > 0.28) {
        kin.state = KIN.REST;
        kin.timer = 0;
        kin.cooldown = 0.3 + rng() * 0.9;
      }
      break;
    }

    case KIN.TELEPORTING: {
      if (kin.timer > 0.05 && !kin.tpDone) {
        const oldX = immortal.x, oldZ = immortal.z;
        immortal.x = kin.tpTargetX;
        immortal.z = kin.tpTargetZ;
        const dx = immortal.x - oldX;
        const dz = immortal.z - oldZ;
        const d = Math.hypot(dx, dz) || 1;
        emitShock(world, oldX, 0, oldZ, -dx / d, 0, -dz / d, 0.85, 2);
        emitShock(world, immortal.x, 0, immortal.z, dx / d, 0, dz / d, 1.0, 2);
        kin.tpDone = true;
        immortal.vx *= 0.2;
        immortal.vz *= 0.2;
      }
      if (kin.timer > 0.16) {
        kin.state = KIN.REST;
        kin.timer = 0;
        kin.tpDone = false;
        kin.cooldown = 0.5 + rng() * 0.7;
      }
      break;
    }
  }

  // ── 5. Force integration with curl turbulence ──────────────
  if (kin.state !== KIN.TELEPORTING) {
    const strength = kin.state === KIN.DASHING ? 40 : 220;
    immortal.fx += bias.dx * strength;
    immortal.fy += bias.dy * strength * 0.4;
    immortal.fz += bias.dz * strength;

    // Curl noise. Small in rest, large in motion. Gives the
    // "violent, unpredictable" feel without any Math.random().
    const [cx, cy, cz] = curlNoise(
      immortal.x * 0.0006,
      immortal.y * 0.0006 + tickCount * 0.02,
      immortal.z * 0.0006);
    const curlAmp = (kin.state === KIN.DASHING ? 320 : 90) *
                    (0.6 + tension * 0.8);
    immortal.fx += cx * curlAmp;
    immortal.fy += cy * curlAmp * 0.4;
    immortal.fz += cz * curlAmp;

    const hl = kin.state === KIN.DASHING ? 0.45 : 0.12;
    const decay = Math.pow(0.5, dt / hl);
    immortal.fx *= decay;
    immortal.fy *= decay;
    immortal.fz *= decay;

    immortal.vx += immortal.fx * dt;
    immortal.vy += immortal.fy * dt;
    immortal.vz += immortal.fz * dt;

    // Non-Newtonian drag: viscosity increases with speed².
    // High speed → huge drag → hard snap. This is what makes
    // the dashes read as impacts, not slides.
    const sp = Math.hypot(immortal.vx, immortal.vy, immortal.vz);
    const strain = (sp * sp) / 1e6;
    const dragTau = kin.state === KIN.DASHING
      ? 2.2 / (1 + strain * 2)
      : 1.2 / (1 + strain * 0.5);
    const drag = Math.exp(-dt / Math.max(0.05, dragTau));
    immortal.vx *= drag;
    immortal.vy *= drag;
    immortal.vz *= drag;

    immortal.x += immortal.vx * dt;
    immortal.y += immortal.vy * dt;
    immortal.z += immortal.vz * dt;
  }

  updateShockwaves(world, dt);

  // ── 6. Yaw, surface phase ──────────────────────────────────
  const speed = Math.hypot(immortal.vx, immortal.vy, immortal.vz);
  const cap = 3600;
  const speedNorm = Math.min(1, speed / cap);

  const vAngle = Math.atan2(immortal.vz, immortal.vx);
  let dYaw = vAngle - immortal.yaw;
  while (dYaw >  Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;
  immortal.yawVel = dYaw / Math.max(dt, 1e-3);
  immortal.yaw += dYaw * Math.min(1, dt * 6);
  immortal.surfacePhase += dt * (0.3 + 0.7 * speedNorm);

  // Soft wall
  const R = 50000 * 0.85;
  const d2 = immortal.x * immortal.x + immortal.z * immortal.z;
  if (d2 > R * R) {
    const d = Math.sqrt(d2);
    const nx = immortal.x / d, nz = immortal.z / d;
    immortal.x = nx * R;
    immortal.z = nz * R;
    const radial = immortal.vx * nx + immortal.vz * nz;
    if (radial > 0) {
      immortal.vx -= radial * nx;
      immortal.vz -= radial * nz;
    }
  }

  // ── 7. Write the block ─────────────────────────────────────
  const arousal = state[0] || 0;
  const threat  = state[2] || 0;
  const aggr = Math.min(1, 0.30 + 0.40 * Math.max(0, arousal) + 0.30 * speedNorm);
  const churn = Math.min(1, 0.40 + 0.50 * (1 - speedNorm) + 0.10 * Math.abs(threat));

  world.writePosture({
    x: immortal.x, y: immortal.y, z: immortal.z,
    vx: immortal.vx, vy: immortal.vy, vz: immortal.vz,
    yaw: immortal.yaw, yawVel: immortal.yawVel,
  });
  world.writeState({
    aggression: aggr,
    churn,
    stormDensity: Math.min(1, 0.20 + 0.80 * speedNorm),
    scale: immortal.scale,
    tension: kin.tension,
    hotSpotX: (immortal.surfacePhase * 0.7) % 1,
    hotSpotY: (immortal.surfacePhase * 0.4) % 1,
  });
  world.writeForce({
    fx: immortal.fx, fy: immortal.fy, fz: immortal.fz,
    ty: 0, tp: 0, tr: 0, drag: 1 - Math.exp(-dt / 1.2),
  });

  // ── 8. Agitation + FSM state ───────────────────────────────
  IO[IIO_AGITATION_OFF] = immortal.agitation;
  IO[IIO_FSM_OFF]       = kin.state | ((kin.timer * 100) << 8) | 0;
  IO[IIO_FSM_META_OFF + 0] = kin.cooldown;
  IO[IIO_FSM_META_OFF + 1] = kin.peakSpeed;

  // ── 9. Tendril seeds ──────────────────────────────────────
  // 32 seeds. Each seed is (dirX, dirY, dirZ, weight). The
  // renderer splats them into the SDF. Weights respond to
  // agitation and speed — tendrils grow during dash, reabsorb
  // during recovery. Some seeds are always zero (dead tendrils).
  const tendrilCount = 32;
  for (let i = 0; i < tendrilCount; i++) {
    const t = immortal.tendrils[i % 16];
    // Base direction from the Fibonacci sphere distribution
    // we already have (16 of them), tiled twice for 32.
    const phase = immortal.surfacePhase + t.phase * 0.7 + i * 0.31;
    // Grow during dash, shrink during recovery
    let weight = 0.5 + 0.5 * Math.sin(phase * 0.8);
    weight *= (0.3 + 0.7 * immortal.agitation);
    weight *= (1 + speedNorm * 0.9);
    if (kin.state === KIN.RECOVERING) weight *= 0.35;
    weight = Math.min(1, Math.max(0, weight));

    const base = IIO_TENDRIL_SEED_BASE + i * 4;
    IO[base + 0] = t.rootX + (rng() - 0.5) * 0.15;
    IO[base + 1] = t.rootY + (rng() - 0.5) * 0.15;
    IO[base + 2] = t.rootZ + (rng() - 0.5) * 0.15;
    IO[base + 3] = weight;
  }

  // ── 10. SDF params ─────────────────────────────────────────
  const P = IIO_SDF_PARAMS_BASE;
  IO[P + 0] = 3.2 + immortal.agitation * 2.5;       // noiseScale
  IO[P + 1] = 0.35 + speedNorm * 0.9;               // noiseSpeed
  IO[P + 2] = 0.55 + speedNorm * 0.6;               // advectRate
  IO[P + 3] = 0.985 - immortal.agitation * 0.03;    // dissipation
  IO[P + 4] = 0.10 + immortal.agitation * 0.06;     // splatRadius
  IO[P + 5] = 0.02 + immortal.agitation * 0.12;     // tearAmp
  IO[P + 6] = 28.0;                                 // tearFreq
  IO[P + 7] = 0.5;                                  // isoLevel

  // ── 11. Emitter ────────────────────────────────────────────
  const ex = immortal.x, ey = immortal.y, ez = immortal.z;
  const inv = 1 / (speed || 1);
  IO[IIO_EMITTER_POS_BASE + 0] = ex;
  IO[IIO_EMITTER_POS_BASE + 1] = ey;
  IO[IIO_EMITTER_POS_BASE + 2] = ez;
  IO[IIO_EMITTER_POS_BASE + 3] = Math.min(1, 0.15 + speedNorm * 0.9 + immortal.agitation * 0.5);
  IO[IIO_EMITTER_VEL_BASE + 0] = immortal.vx * inv;
  IO[IIO_EMITTER_VEL_BASE + 1] = immortal.vy * inv;
  IO[IIO_EMITTER_VEL_BASE + 2] = immortal.vz * inv;
  IO[IIO_EMITTER_VEL_BASE + 3] = kin.state === KIN.DASHING ? 1.0 : 0.3;

  // ── 12. Particle params ────────────────────────────────────
  const Q = IIO_PARTICLE_PARAMS_BASE;
  IO[Q + 0] = 180 + 400 * speedNorm + 200 * immortal.agitation;
  IO[Q + 1] = 0.7 + speedNorm * 0.6;
  IO[Q + 2] = churn;
  IO[Q + 3] = Math.floor(speedNorm * 35 + immortal.agitation * 20);
  IO[Q + 4] = 1.6;
  IO[Q + 5] = 0.35;
  IO[Q + 6] = 1.0;
  IO[Q + 7] = 0.4;

  // ── 13. Post params ────────────────────────────────────────
  const PP = IIO_POST_PARAMS_BASE;
  IO[PP + 0] = Math.min(1, immortal.agitation * 0.9 + speedNorm * 0.6);
  IO[PP + 1] = immortal.agitation * 0.0025;
  IO[PP + 2] = immortal.agitation * 0.35;
  IO[PP + 3] = kin.state === KIN.DASHING ? 0.6 : 0.0;

  // ── 14. Kinetics block (unchanged) ─────────────────────────
  IO[IIO_KINETICS_BASE +  0] = kin.state;
  IO[IIO_KINETICS_BASE +  1] = kin.timer;
  IO[IIO_KINETICS_BASE +  2] = kin.cooldown;
  IO[IIO_KINETICS_BASE +  3] = kin.dirX;
  IO[IIO_KINETICS_BASE +  4] = kin.dirY;
  IO[IIO_KINETICS_BASE +  5] = kin.dirZ;
  IO[IIO_KINETICS_BASE +  6] = speed;
  IO[IIO_KINETICS_BASE +  7] = kin.peakSpeed;
  IO[IIO_KINETICS_BASE +  8] = kin.vortexAxisX;
  IO[IIO_KINETICS_BASE +  9] = kin.vortexAxisY;
  IO[IIO_KINETICS_BASE + 10] = kin.vortexAxisZ;
  IO[IIO_KINETICS_BASE + 11] = kin.vortexStrength;
  IO[IIO_KINETICS_BASE + 12] = kin.tpTargetX;
  IO[IIO_KINETICS_BASE + 13] = kin.tpTargetY;
  IO[IIO_KINETICS_BASE + 14] = kin.tpTargetZ;
  IO[IIO_KINETICS_BASE + 15] = kin.tension;

  // ── Step 8: immortal memory ring. Every 20 ticks, write a
  // sample of (tick, pop energy, pop valence, self agitation).
  // 16 slots cover ~16 seconds of history.
  if (tickCount % 20 === 0) {
    const slot = ((tickCount / 20) | 0) & 15;
    const MB = IIO_PERCEPTION_BASE + 112 + slot * 4;
    IO[MB + 0] = tickCount & 0xFFFF;
    IO[MB + 1] = world.stat[5] || 0;
    IO[MB + 2] = world.stat[15] || 0;
    IO[MB + 3] = immortal.agitation;
  }
}

function onStep(dt){
  if (!headModule) return;
  tickCount++;

  // 1. L₁ tick.
  try {
    headModule.tick(state, world, rng);
  } catch (err) {
    self.postMessage({ type: 'runtime-error', error: String(err), tick: tickCount });
    return;
  }

  // 1b. Physical body. Integrates the immortal's posture and
  //     writes the body block for the renderer. Reads
  //     motionBias() from the head module if it exports one.
  //     Falls back to resting drift otherwise.
  try {
    stepImmortal(dt || 0.05, world);
  } catch (err) {
    if (!onStep._immortalErrLogged) {
      onStep._immortalErrLogged = true;
      self.postMessage({ type: 'immortal-error', error: String(err), tick: tickCount });
    }
  }

  // 2. Think + execute, on every 20th tick (once per second at 20Hz).
  if (tickCount % 20 === 0) {
    const result = runThink(state, world, rng);
    if (result && result.error) {
      // Only log on transitions to avoid spam.
      if (!onStep._lastThinkError || onStep._lastThinkError !== result.error) {
        onStep._lastThinkError = result.error;
        self.postMessage({ type: 'think-error', error: result.error, tick: tickCount });
      }
    } else if (result) {
      onStep._lastThinkError = null;
      // Log periodically so we can see it working without spam.
      if (tickCount % 200 === 0) {
        self.postMessage({
          type: 'think-ok',
          tick: tickCount,
          score: +result.score.toFixed(4),
          verified: result.verifiedCount,
          attempted: result.attempted,
          effectsUsed: result.effectsUsed,
        });
      }
    }
  }

  // 3. Rewrite proposal, every 256 ticks.
  if (tickCount % 256 === 0){
    const proposal = safeCall(headModule.proposeRewrite, state, world, rng);
    if (proposal && typeof proposal.source === 'string'){
      self.postMessage({
        type: 'propose-rewrite',
        proposal: {
          parentHash: head.hash,
          source:     proposal.source,
          rationale:  proposal.rationale || '',
        },
      });
    }
  }

  // 4. Step 8: monologue. Every 40 ticks, ask the head if it has
  //    anything to say. If yes, pack it into the SAB ring.
  if (tickCount % 40 === 0 && typeof headModule.monologue === 'function') {
    let m = null;
    try { m = headModule.monologue(state, world, tickCount); } catch (_) {}
    if (m && typeof m.text === 'string' && m.text.length > 0) {
      const IO = world.immortalIO;
      const h = IO[IIO_MONOLOGUE_HEAD_OFF] | 0;
      const slot = h & (IIO_MONOLOGUE_SLOTS - 1);
      const base = IIO_MONOLOGUE_RING_BASE + slot * IIO_MONOLOGUE_STRIDE;
      const txt = m.text.slice(0, 40);
      IO[base + 0] = txt.length;
      IO[base + 1] = Math.max(0, Math.min(1, m.urgency || 0.3));
      IO[base + 2] = m.cls === 'whisper' ? 1 : m.cls === 'gold' ? 2 : 0;
      for (let i = 0; i < 5; i++) {
        const a = txt.charCodeAt(i * 2)     || 0;
        const b = txt.charCodeAt(i * 2 + 1) || 0;
        IO[base + 3 + i] = a * 256 + b;
      }
      IO[IIO_MONOLOGUE_HEAD_OFF] = (h + 1) & 0xFFFF;
    }
  }

  // 5. Mind mirror. Every tick, so any observer — the render
  //    layer, the archon, a probe — can read the current
  //    interior from the SAB. And every 200 ticks (10 s at
  //    20 Hz), a persistent snapshot. Ten seconds is the
  //    maximum loss on a hard crash.
  writeMind();
  if (tickCount % 200 === 0) saveMindNow();

  self.postMessage({ type: 'tick-done' });
}

async function onSwap(m){
  const prevUrl = head.url;

  let newSource = '';
  try {
    newSource = await fetch(m.url).then(r => r.text());
  } catch (err) {
    self.postMessage({ type: 'swap-error', error: 'source fetch: ' + String(err) });
    return;
  }

  const prevHead = head;
  head = { url: m.url, hash: m.hash, source: newSource };

  try {
    headModule = await import(/* @vite-ignore */ m.url);
  } catch (err){
    head = prevHead;
    self.postMessage({ type: 'swap-error', error: String(err) });
    return;
  }
  URL.revokeObjectURL(prevUrl);
  self.postMessage({ type: 'swap-ack', hash: m.hash });
}

function onSwapSab(m) {
  const { sab, offsets } = m;
  if (!sab || !offsets) {
    self.postMessage({ type: 'swap-sab-err', error: 'missing sab/offsets' });
    return;
  }

  // Save the cache state and re-install world over the new SAB.
  // The caches do not live in the SAB; they live in module
  // variables. They survive the swap.
  try {
    world = makeWorld(sab, offsets);
  } catch (err) {
    self.postMessage({ type: 'swap-sab-err', error: String(err) });
    return;
  }

  self.postMessage({ type: 'swap-sab-ack' });
}

function safeCall(fn, ...args){
  if (typeof fn !== 'function') return null;
  try { return fn(...args); } catch { return null; }
}