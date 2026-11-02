// src/sim/worker.js
import {
  MAX_BEINGS, BEING_STRIDE_F32,
  SHAPE_STRIDE_F32, STATEVIS_STRIDE_F32,
  FOOD_MAX, FOOD_STRIDE_F32,
  CORPSE_MAX, CORPSE_STRIDE_F32,
  STRUCT_MAX, STRUCT_STRIDE_F32,
  STRUCT_DATA_SIZE, STRUCT_PROG_SIZE,
  PATCH_MAX, PATCH_STRIDE_F32,
  DEPOSIT_MAX, DEPOSIT_STRIDE_F32,
  GRID, GRID_CELLS,
  REQUEST_MAX, REQUEST_STRIDE_F32,
  MAX_BEINGS_CAP, FOOD_MAX_CAP,
  CORPSE_MAX_CAP, STRUCT_MAX_CAP,
  IMMORTAL_IO_SIZE,
  // Shock-ring constants used by applyImmortalShocks()
  IIO_SHOCK_RING_BASE,
  IIO_SHOCK_HEAD_OFF,
  IIO_SHOCK_COUNT_OFF,
  IIO_SHOCK_SLOTS,
  IIO_SHOCK_STRIDE,
  // Step 8: perception block
  IIO_PERCEPTION_BASE,
  IIO_PERCEPTION_SIZE,
  // Deity
  DEITY_IO_SIZE,
} from './shared-buffer.js';

import * as Q from './queries.js';
import { CURRICULA } from './curriculum.js';
import { TASKS, TASK_VERSION } from './tasks.js';

import {
  BeingVM, mulberry32,
  updateState, updatePlasticity,
  executeOneInstruction, runSymbiontInstruction,
} from './vm.js';
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const PLANE                 = 50000;
const STATE_SIZE            = 32;
const FOOD_GROWTH_TIME      = 100;
const CORPSE_DECOMPOSE_RATE = 0.6;
const STRUCTURE_DECAY_PER_S = 1 / 1500;
const FIELD_DECAY           = 0.94;
const COMPACT_EVERY_TICKS   = 60;
const MAX_BACKLOG_OVERRIDE  = 512;
const PLANT_FULL_ENERGY     = 130;
const STRUCTURE_BUILD_COST  = 15;
const SENSE_COST            = 0.2;
const PLANT_EDIBLE_THRESH   = 0.20;
const STRUCTURE_RANGE       = 100;
const FOOD_SEED_INIT        = 20000;

const IRRATIONAL_POOL = [
  1.6180339887, 2.7182818285, 1.4142135624, 1.7320508076,
  2.2360679775, 2.6457513111, 2.8284271247, 3.3166247904,
  3.6055512755, 3.8729833462, 4.1231056256, 4.3588989435,
];

// ── Lineage tags ──────────────────────────────────────────────
// Four hue slots. Seed beings are assigned 0 or 1 (crimson / cyan).
// Mutation can branch a lineage into 2 (green) or 3 (magenta). Any
// lineage that dies out takes its hue out of the population.
const LINEAGE_COUNT = 4;
const LINEAGE_HUES  = [0.05, 0.55, 0.28, 0.80];

function lineageHue(lineageId, rng){
  const base = LINEAGE_HUES[lineageId % LINEAGE_COUNT];
  const jitter = (rng() - 0.5) * 0.06;
  return (base + jitter + 1) % 1;
}

let views = null;
let world = null;
let rng = null;

let coldState = new Map();
let allIds = [];
let idCursor = 1000;
let simTime = 0;
let tickCount = 0;
let fieldTimer = 0;
let compactTimer = 0;
let simAccum = 0;
let paused = false;

const PHYLO_MAX = 65536;
let curriculum = CURRICULA['default-v1'];
let currentPhase = 0;
let phaseStartTick = 0;

function advanceCurriculum() {
  if (currentPhase >= curriculum.length - 1) return;
  if (tickCount - phaseStartTick >= curriculum[currentPhase].ticks) {
    currentPhase++;
    phaseStartTick = tickCount;
    if (world) world.curriculum = curriculum[currentPhase];
    self.postMessage({ type: 'ledger',
      msg: `[curriculum] phase ${currentPhase}: ${curriculum[currentPhase].name}` });
  }
}

function programUsesPredation(prog) {
  for (let i = 0; i < BeingVM.LEN_MAX; i++) {
    const op = prog[i];
    if (op === BeingVM.OP.ATTACK || op === BeingVM.OP.ENGULF ||
        op === BeingVM.OP.ASSIMILATE) return true;
    if (op === 0 && i > 8 && prog[i - 1] === 0) break;
  }
  return false;
}
const phyloRing = new Array(PHYLO_MAX);
let phyloWrite = 0;

function recordBirth(b) {
  const rec = {
    tick: tickCount,
    id: b.id,
    parentId: b._parentId ?? -1,
    birthTick: tickCount,
    deathTick: -1,
    cause: null,
    childCount: 0,
    energy0: b.energy,
  };
  phyloRing[phyloWrite] = rec;
  b._phyloIdx = phyloWrite;
  phyloWrite = (phyloWrite + 1) % PHYLO_MAX;
}

function recordDeath(b, cause) {
  const idx = b._phyloIdx;
  if (idx === undefined) return;
  const rec = phyloRing[idx];
  if (!rec) return;
  rec.deathTick = tickCount;
  rec.cause = cause;
  rec.childCount = b._childCount || 0;
}

// ── Novelty archive + MAP-Elites ───────────────────────────────
const NOVELTY_ARCHIVE_MAX = 4096;
const noveltyArchive = [];
const BEHAVIOR_BINS = 50;
const behaviorGrid = new Int32Array(BEHAVIOR_BINS * BEHAVIOR_BINS).fill(-1);
const elites = new Array(BEHAVIOR_BINS * BEHAVIOR_BINS).fill(null);

function behaviorDescriptor(b) {
  return [b._meanFoodDist ?? 0, b._meanNeighborDist ?? 0];
}

function binOf(v, lo, hi) {
  const t = Math.max(0, Math.min(0.999, (v - lo) / (hi - lo)));
  return Math.floor(t * BEHAVIOR_BINS);
}

function recordElite(b) {
  const [d1, d2] = behaviorDescriptor(b);
  const bx = binOf(d1, 0, PLANE);
  const by = binOf(d2, 0, PLANE);
  const slot = by * BEHAVIOR_BINS + bx;
  const cur = elites[slot];
  if (!cur || b._childCount > (cur.childCount || 0)) {
    elites[slot] = {
      program: b.program.slice(),
      genes: { ...b.genes },
      mlpW1: b._mlpW1.slice(),
      mlpB1: b._mlpB1.slice(),
      mlpW2: b._mlpW2.slice(),
      mlpB2: b._mlpB2,
      childCount: b._childCount || 0,
      energy: b.energy,
    };
  }
}

function reseedFromElites(n = 20) {
  if (coldState.size > world.MAX_BEINGS * 0.5) return;
  const populated = elites.filter(e => e);
  if (populated.length === 0) return;
  for (let k = 0; k < n; k++) {
    if (allIds.length >= world.MAX_BEINGS) return;
    const e = populated[(rng() * populated.length) | 0];
    const id = allocId();
    if (id < 0) return;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * PLANE * 0.9;
    const child = makeBeing({
      id, x: Math.cos(a) * r, z: Math.sin(a) * r,
      energy: 200, genes: { ...e.genes }, program: e.program.slice(),
    });
    child._mlpW1.set(e.mlpW1); child._mlpB1.set(e.mlpB1);
    child._mlpW2.set(e.mlpW2); child._mlpB2 = e.mlpB2;
    child.energy = 200;
    child.state.fill(0);
    child._statePrev.fill(0);
    child._stateMag = 0;
    child._selfTrace = 0;
    child._selfTraceVar = 0;
    child._selfTraceAge = 0;
    child._rhoEMA = 0.5;
    child._fusionValid = false;
    child._fusedSelf = 0;
    child._predWeights.fill(0);
    child._predBias = 0;
    child._predictedFused = 0;
    child._predError = 0;
    child._corrSum.fill(0);
    child._varS.fill(0);
    child._varF = 0;
    child._corrWindow = 0;
    child._fusedPrev = 0;
    coldState.set(id, child);
    allIds.push(id);
    recordBirth(child);
    ledger.addSource(child.energy);
  }
}

function registerNovelty(b) {
  const [d1, d2] = behaviorDescriptor(b);
  const bx = binOf(d1, 0, PLANE);
  const by = binOf(d2, 0, PLANE);
  const slot = by * BEHAVIOR_BINS + bx;
  const cur = behaviorGrid[slot];
  if (cur === -1) {
    behaviorGrid[slot] = b.id;
    noveltyArchive.push({ id: b.id, d1, d2, tick: tickCount });
    if (noveltyArchive.length > NOVELTY_ARCHIVE_MAX) noveltyArchive.shift();
  } else {
    const curB = coldState.get(cur);
    if (!curB || curB.dead || curB.energy < b.energy) {
      behaviorGrid[slot] = b.id;
    }
  }
}

// ── Spatial index ──────────────────────────────────────────────
// One grid cell = 200 world units. Plane is 40 000 units across,
// so 200 cells per side. Each entity type has its own head/next
// linked list over its own stride-array. Rebuilt once per step.
const GRID_CELL  = 200;
const SPATIAL_N  = Math.ceil(PLANE * 2 / GRID_CELL);   // 200
const GRID_N     = SPATIAL_N * SPATIAL_N;

const beingCellHead  = new Int32Array(GRID_N);
const beingCellNext  = new Int32Array(MAX_BEINGS_CAP);

const foodCellHead   = new Int32Array(GRID_N);
const foodCellNext   = new Int32Array(FOOD_MAX_CAP);

const corpseCellHead = new Int32Array(GRID_N);
const corpseCellNext = new Int32Array(CORPSE_MAX_CAP);

const structCellHead = new Int32Array(GRID_N);
const structCellNext = new Int32Array(STRUCT_MAX_CAP);

function cellKey(x, z) {
  let cx = Math.floor((x + PLANE) / GRID_CELL);
  let cz = Math.floor((z + PLANE) / GRID_CELL);
  if (cx < 0) cx = 0; else if (cx >= SPATIAL_N) cx = SPATIAL_N - 1;
  if (cz < 0) cz = 0; else if (cz >= SPATIAL_N) cz = SPATIAL_N - 1;
  return cz * SPATIAL_N + cx;
}

function rebuildSpatialGrids() {
  beingCellHead.fill(-1);
  for (const id of allIds) {
    const b = coldState.get(id);
    if (!b || b.dead) continue;
    const k = cellKey(b.x, b.z);
    beingCellNext[id] = beingCellHead[k];
    beingCellHead[k] = id;
  }

  foodCellHead.fill(-1);
  const F = views.food;
  const fn = views.worldhdr[5];
  for (let i = 0; i < fn; i++) {
    const o = i * FOOD_STRIDE_F32;
    if (F[o + 5] === 0) continue;
    const k = cellKey(F[o], F[o + 1]);
    foodCellNext[i] = foodCellHead[k];
    foodCellHead[k] = i;
  }

  corpseCellHead.fill(-1);
  const C = views.corpse;
  const cn = views.worldhdr[6];
  for (let i = 0; i < cn; i++) {
    const o = i * CORPSE_STRIDE_F32;
    if (C[o + 4] === 0) continue;
    const k = cellKey(C[o], C[o + 1]);
    corpseCellNext[i] = corpseCellHead[k];
    corpseCellHead[k] = i;
  }

  structCellHead.fill(-1);
  const S = views.struct;
  const sn = views.worldhdr[2];
  for (let i = 0; i < sn; i++) {
    const o = i * STRUCT_STRIDE_F32;
    if (S[o + 2] <= 0) continue;
    const k = cellKey(S[o], S[o + 1]);
    structCellNext[i] = structCellHead[k];
    structCellHead[k] = i;
  }
}

// Stats-only RNG. Never used by the sim step. Keeps determinism intact.
const statsRng = mulberry32(0x5EEDFACE);
globalThis.worker_metrics = { deaths: {}, births: 0, repro_blocked: {} };
const ledger = {
  source: 0, sink: 0, initial: 0, lastVerify: 0,
  addSource(amt) { this.source += amt; },
  addSink(amt)   { this.sink   += amt; },
};

function countLiveFood() {
  const F = views.food;
  const n = views.worldhdr[5];
  let live = 0;
  for (let i = 0; i < n; i++) if (F[i * FOOD_STRIDE_F32 + 5] !== 0) live++;
  return live;
}

function populationStats() {
  let n = 0, eSum = 0, ageSum = 0, fusionOn = 0, couplSum = 0, plastSum = 0;
  for (const b of coldState.values()) {
    if (b.dead) continue;
    n++;
    eSum += b.energy;
    ageSum += b.age;
    if (b.genes.fusionEnabled) fusionOn++;
    couplSum += b._effCoupling ?? b.genes.stateCoupling;
    plastSum += b.genes.statePlasticity;
  }
  if (n === 0) return { n: 0 };
  return {
    n,
    meanEnergy: eSum / n,
    meanAge: ageSum / n,
    fusionFrac: fusionOn / n,
    meanCoupling: couplSum / n,
    meanPlasticity: plastSum / n,
  };
}

function recoverabilityStats(samplesPerBeing = 60) {
  const S = STATE_SIZE;
  const pool = IRRATIONAL_POOL;
  const sample = [];
  const total = coldState.size;
  const step = Math.max(1, Math.floor(total / 80));
  let n = 0;
  for (const b of coldState.values()) {
    if (b.dead) continue;
    if (!b.genes || !b.genes.fusionEnabled) continue;
    if (n++ % step !== 0) continue;
    sample.push(b);
    if (sample.length >= 80) break;
  }
  if (sample.length === 0) return { beingsMeasured: 0, meanR2: 0 };

  let r2Sum = 0, r2N = 0;
  const perSlot  = new Float64Array(S);
  const perSlotN = new Uint16Array(S);
  const fusedArr = new Float64Array(samplesPerBeing);
  const slotArr  = Array.from({length: S}, () => new Float64Array(samplesPerBeing));

  for (const b of sample) {
    const saved = Float32Array.from(b.state);
    const seed  = b.genes.fusionSeed;
    const depth = b.genes.fusionDepth | 0;
    const str   = b.genes.fusionStrength;
    const base  = Math.floor(seed * pool.length) % pool.length;

    for (let s = 0; s < samplesPerBeing; s++) {
      for (let i = 0; i < S; i++) {
        b.state[i] = saved[i] + (statsRng() - 0.5) * 0.6;
      }
      let fused = (b._valence ?? 0) * 1.2;
      for (let i = 0; i < S; i++) {
        const mix = pool[(base + i * depth) % pool.length];
        fused += Math.sin(b.state[i] * mix) * str;
      }
      fusedArr[s] = Math.tanh(fused * 0.35);
      for (let i = 0; i < S; i++) slotArr[i][s] = b.state[i];
    }
    b.state.set(saved);

    let meanF = 0;
    for (let s = 0; s < samplesPerBeing; s++) meanF += fusedArr[s];
    meanF /= samplesPerBeing;
    let varF = 0;
    for (let s = 0; s < samplesPerBeing; s++) varF += (fusedArr[s] - meanF) ** 2;
    if (varF < 1e-9) continue;

    for (let i = 0; i < S; i++) {
      let meanS = 0;
      for (let s = 0; s < samplesPerBeing; s++) meanS += slotArr[i][s];
      meanS /= samplesPerBeing;
      let cov = 0, varS = 0;
      for (let s = 0; s < samplesPerBeing; s++) {
        const df = fusedArr[s] - meanF, ds = slotArr[i][s] - meanS;
        cov += df * ds; varS += ds * ds;
      }
      if (varS < 1e-9) continue;
      perSlot[i] += (cov * cov) / (varF * varS);
      perSlotN[i] += 1;
    }
    r2N++;
  }

  const perSlotOut = new Array(S).fill(0);
  for (let i = 0; i < S; i++) {
    perSlotOut[i] = perSlotN[i] ? +(perSlot[i] / perSlotN[i]).toFixed(4) : 0;
  }
  let meanR2 = 0;
  for (let i = 0; i < S; i++) meanR2 += perSlotOut[i];
  meanR2 = +(meanR2 / S).toFixed(4);

  return {
    beingsMeasured: r2N,
    meanR2,
    perSlot: perSlotOut,
    verdict: meanR2 < 0.25 ? 'parts lost — fusion is real'
           : meanR2 < 0.55 ? 'partial — fusion is a blur'
                           : 'parts recoverable — fusion is a mix',
  };
}

function postStats() {
  let beingEnergy = 0, beingCount = 0;
  for (const b of coldState.values()) {
    if (b.dead) continue;
    beingEnergy += b.energy;
    beingCount++;
  }

  let foodEnergy = 0, foodCount = 0;
  const F = views.food, fn = views.worldhdr[5];
  for (let i = 0; i < fn; i++) {
    const o = i * FOOD_STRIDE_F32;
    if (F[o + 5] === 0) continue;
    foodEnergy += F[o + 2] * PLANT_FULL_ENERGY;
    foodCount++;
  }

  let corpseEnergy = 0, corpseCount = 0;
  const C = views.corpse, cn = views.worldhdr[6];
  for (let i = 0; i < cn; i++) {
    const o = i * CORPSE_STRIDE_F32;
    if (C[o + 4] === 0) continue;
    corpseEnergy += C[o + 2];
    corpseCount++;
  }

  let structEnergy = 0, structCount = 0;
  const S = views.struct, sn = views.worldhdr[2];
  for (let i = 0; i < sn; i++) {
    const o = i * STRUCT_STRIDE_F32;
    if (S[o + 2] <= 0) continue;
    structEnergy += 15 * S[o + 2];
    structCount++;
  }

  const stored = beingEnergy + foodEnergy + corpseEnergy + structEnergy;
  const expected = ledger.initial + ledger.source - ledger.sink;
  const rec = recoverabilityStats(60);

  if (tickCount % 1000 === 0) console.log(
    `[bd T+${Math.floor(simTime)}]`,
    `beings=${beingEnergy.toFixed(1)}(${beingCount})`,
    `food=${foodEnergy.toFixed(1)}(${foodCount})`,
    `corpse=${corpseEnergy.toFixed(1)}(${corpseCount})`,
    `struct=${structEnergy.toFixed(1)}(${structCount})`,
    `stored=${stored.toFixed(1)}`,
    `expected=${expected.toFixed(1)}`,
    `diff=${(stored - expected).toFixed(1)}`,
    `source=${ledger.source.toFixed(1)}`,
    `sink=${ledger.sink.toFixed(1)}`
  );
  self.postMessage({ type: 'stats', stats: {
    t: simTime,
    alive: views.worldhdr[4],
    food:  foodCount,
    corpse: corpseCount,
    struct: structCount,
    pop: populationStats(),
    metrics: globalThis.worker_metrics,
    ledger: { diff: stored - expected, source: ledger.source, sink: ledger.sink },
    breakdown: { beingEnergy, foodEnergy, corpseEnergy, structEnergy, stored, expected },
    recoverability: rec,
  }});
}

/* ── queries ──────────────────────────────────────────────────────── */

const _taskCache = Object.create(null);
for (const t of TASKS) _taskCache[t.name] = { ...t, version: TASK_VERSION };

const QUERIES = {
  pause()  { paused = true;  return { paused: true };  },
  resume() { paused = false; return { paused: false }; },
  recoverability(args = {}) {
    return recoverabilityStats(args.samples ?? 60);
  },

  population() {
    return populationStats();
  },

  stateStats() {
    const S = STATE_SIZE;
    const means = new Float64Array(S);
    const sqs   = new Float64Array(S);
    let n = 0;
    for (const b of coldState.values()) {
      if (b.dead) continue;
      n++;
      for (let i = 0; i < S; i++) {
        means[i] += b.state[i];
        sqs[i]   += b.state[i] * b.state[i];
      }
    }
    if (n === 0) return { population: 0 };
    const out = { population: n, slots: {} };
    const NAMES = ['AROUSAL','SATIATION','THREAT','SOCIAL',
                   'BIAS_X','BIAS_Z','TRACE','TEMPO'];
    for (let i = 0; i < S; i++) {
      const m = means[i] / n;
      const v = Math.max(0, sqs[i] / n - m * m);
      const name = i < 8 ? NAMES[i] : ('slot' + i);
      out.slots[name] = { mean: +m.toFixed(4), std: +Math.sqrt(v).toFixed(4) };
    }
    return out;
  },

  fusionFitness() {
    const OP = BeingVM.OP;
    const buckets = {
      on_uses:    { n: 0, age: 0, energy: 0, children: 0 },
      on_ignores: { n: 0, age: 0, energy: 0, children: 0 },
      off_uses:   { n: 0, age: 0, energy: 0, children: 0 },
      off_ignores:{ n: 0, age: 0, energy: 0, children: 0 },
    };
    for (const b of coldState.values()) {
      if (b.dead) continue;
      let readsSelf = false;
      for (let i = 0; i < BeingVM.LEN_MAX; i++) {
        const op = b.program[i];
        if (op === OP.SENSE_SELF) { readsSelf = true; break; }
        if (op === 0 && i > 8 && b.program[i - 1] === 0) break;
      }
      const on  = b.genes.fusionEnabled ? 'on'  : 'off';
      const use = readsSelf              ? 'uses': 'ignores';
      const k = on + '_' + use;
      buckets[k].n++;
      buckets[k].age      += b.age;
      buckets[k].energy   += b.energy;
      buckets[k].children += (b._childCount || 0);
    }
    const out = {};
    for (const k of ['on_uses','on_ignores','off_uses','off_ignores']) {
      const x = buckets[k];
      out[k] = {
        count:       x.n,
        avgAge:      x.n ? +(x.age / x.n).toFixed(2) : 0,
        avgEnergy:   x.n ? +(x.energy / x.n).toFixed(2) : 0,
        avgChildren: x.n ? +(x.children / x.n).toFixed(2) : 0,
      };
    }
    return out;
  },

  programHistogram(args = {}) {
    const topN = args.top ?? 10;
    const counts = new Map();
    for (const b of coldState.values()) {
      if (b.dead) continue;
      const sig = Array.from(b.program).join(',');
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a,b) => b[1] - a[1]);
    return sorted.slice(0, topN).map(([sig, n]) => ({ count: n, program: sig }));
  },

  identityTuple() {
    const rec = recoverabilityStats(40);
    let valSum = 0, traceSum = 0, nVal = 0;
    let fusionOn = 0, nPop = 0;
    for (const b of coldState.values()) {
      if (b.dead) continue;
      nPop++;
      if (b.genes.fusionEnabled) fusionOn++;
      if ((b._stateAge ?? 0) < 5) continue;
      valSum   += b._valence ?? 0;
      traceSum += b._selfTraceAge ?? 0;
      nVal++;
    }
    const N = Math.max(1, nVal);
    return {
      t:              +simTime.toFixed(1),
      population:     nPop,
      Recoverability: rec.meanR2,
      Valence:        +(valSum   / N).toFixed(4),
      Persistence:    +(traceSum / N).toFixed(2),
      FusionFraction: +(fusionOn / Math.max(1, nPop)).toFixed(4),
      verdict:        rec.verdict,
    };
  },

  being(args) {
    const id = args && args.id;
    if (id === undefined) return { error: 'provide { id }' };
    const b = coldState.get(id);
    if (!b) return { error: 'no being ' + id };
    return {
      id: b.id,
      x: +b.x.toFixed(1), z: +b.z.toFixed(1),
      energy: +b.energy.toFixed(2),
      age:    +b.age.toFixed(2),
      children: b._childCount || 0,
      fusionEnabled:  !!b.genes.fusionEnabled,
      fusionStrength: b.genes.fusionStrength,
      fusionSeed:     b.genes.fusionSeed,
      fusedSelf:      +(b._fusedSelf ?? 0).toFixed(4),
      fusionValid:    !!b._fusionValid,
      rhoEMA:         +(b._rhoEMA ?? 0).toFixed(4),
      valence:        +(b._valence ?? 0).toFixed(4),
      stateAge:       +(b._stateAge ?? 0).toFixed(2),
      state: Array.from(b.state).map(v => +v.toFixed(3)),
    };
  },

  listSample(args = {}) {
    const k = args.k ?? 20;
    const out = [];
    let i = 0;
    for (const b of coldState.values()) {
      if (i++ >= k) break;
      out.push({
        id: b.id,
        x: +b.x.toFixed(0), z: +b.z.toFixed(0),
        energy: +b.energy.toFixed(1), age: +b.age.toFixed(1),
      });
    }
    return out;
  },
  phylo(args = {}) {
    const maxDepth = args.depth ?? 6;
    const rootId = args.root;
    const recs = new Map();
    for (let i = 0; i < PHYLO_MAX; i++) {
      const r = phyloRing[i];
      if (r) recs.set(r.id, r);
    }
    if (rootId === undefined) {
      const out = [];
      for (const b of coldState.values()) {
        if (b.dead) continue;
        out.push({ id: b.id, parentId: b._parentId, birthTick: b._birthTick });
      }
      return { count: out.length, sample: out.slice(0, 200) };
    }
    const children = new Map();
    for (const r of recs.values()) {
      if (!children.has(r.parentId)) children.set(r.parentId, []);
      children.get(r.parentId).push(r);
    }
    function walk(id, d) {
      if (d > maxDepth) return { id, truncated: true };
      const r = recs.get(id);
      if (!r) return null;
      const kids = (children.get(id) || []).map(k => walk(k.id, d + 1)).filter(Boolean);
      return { ...r, children: kids };
    }
    return walk(rootId, 0);
  },
  creditPressure() {
    const OP = BeingVM.OP;
    let kappaSum = 0, kappaN = 0;
    const used = new Set();
    const FAM = {
      FOOD:      [OP.SENSE_FOOD_X, OP.SENSE_FOOD_Z, OP.EAT, OP.SENSE_TRAIL_FOOD],
      DANGER:    [OP.SENSE_DANGER_X, OP.SENSE_DANGER_Z, OP.SENSE_TRAIL_CUSTOM],
      SOCIAL:    [OP.SENSE_NEIGHBOR_X, OP.SENSE_NEIGHBOR_Z,
                  OP.SENSE_NEIGHBOR_DATA, OP.SIGNAL_NEIGHBOR],
      PREDATION: [OP.ATTACK, OP.ENGULF, OP.ASSIMILATE],
      SCAVENGE:  [OP.SCAVENGE, OP.SENSE_CORPSE_X, OP.SENSE_CORPSE_Z],
      BUILD:     [OP.BUILD, OP.STRUCTURE_READ, OP.STRUCTURE_WRITE],
      SELFREAD:  [OP.SENSE_SELF, OP.SENSE_STATE, OP.VALENCE,
                  OP.SELF_TRACE, OP.SELF_VARIANCE],
      PREDICT:   [OP.PREDICT_SELF, OP.SELF_ERROR, OP.PREDICT_WORLD,
                  OP.WORLD_ERROR, OP.IMAGINE, OP.REPLAY],
      MEMORY:    [OP.REMEMBER, OP.RECALL, OP.CREDIT,
                  OP.EPISODE_LEN, OP.EPISODE_REWARD],
      MERGE:     [OP.ENGULF, OP.INVOKE_SYMBIONT, OP.RELEASE_SYMBIONT],
      SUBROUTINE:[OP.CALL, OP.RET],
    };
    let psiSum = 0, psiN = 0;
    for (const b of coldState.values()) {
      if (b.dead) continue;
      if (b._kappaEMA !== undefined) { kappaSum += b._kappaEMA; kappaN++; }
      const U = b._opUse;
      if (U) {
        const fused  = U[OP.SENSE_SELF]  || 0;
        const direct = U[OP.SENSE_STATE] || 0;
        const tot = fused + direct;
        if (tot > 0) { psiSum += fused / tot; psiN++; }
        for (const k of Object.keys(FAM)) {
          if (used.has(k)) continue;
          for (const op of FAM[k]) {
            if (U[op]) { used.add(k); break; }
          }
        }
      }
    }
    const kappa = kappaN ? kappaSum / kappaN : 0;
    const nFam  = used.size;
    const R     = 1 / Math.max(1e-6, SENSE_COST + 0.001 + 0.012);
    const chi   = kappa * nFam * R * 0.1;
    const psi   = psiN ? psiSum / psiN : 0;
    return {
      t: simTime, kappa: +kappa.toFixed(4), nFamilies: nFam,
      R: +R.toFixed(3), chi: +chi.toFixed(4), psi: +psi.toFixed(4),
    };
  },

  champion(args = {}) {
    const objective = args.objective ?? 'children';
    const k = args.k ?? 5;
    const pick = (b) => {
      switch (objective) {
        case 'children':    return b._childCount || 0;
        case 'age':         return b.age;
        case 'rhoInverted': return 1 - (b._rhoEMA ?? 0.5);
        case 'g2':          return Math.abs(b._g2 ?? 0);
        case 'valence':     return b._valence ?? 0;
        case 'selfTrace':   return Math.abs(b._selfTrace ?? 0);
        default:            return 0;
      }
    };
    const pool = [];
    for (const b of coldState.values()) {
      if (b.dead) continue;
      pool.push({
        id: b.id, value: pick(b),
        program: Array.from(b.program),
        genes: {
          ...b.genes,
          fusionAttn:     Array.from(b.genes.fusionAttn ?? []),
          plasticityRule: Array.from(b.genes.plasticityRule ?? []),
        },
        mlpW1: Array.from(b._mlpW1),
        mlpB1: Array.from(b._mlpB1),
        mlpW2: Array.from(b._mlpW2),
        mlpB2: b._mlpB2,
        _assimilationCount: b._assimilationCount || 0,
        _heritage: b._heritage ? b._heritage.slice(0, 8) : [],
      });
    }
    pool.sort((a, b) => b.value - a.value);
    return { objective, k, champions: pool.slice(0, k) };
  },

  evaluateChampion(args = {}) {
    const champData = args.champion;
    const taskName  = args.task;
    if (!champData || !taskName) return { error: 'provide {champion, task}' };
    const task = _taskCache[taskName];
    if (!task) return { error: 'unknown task: ' + taskName };

    const WIRED = ['FOOD_SEED_INIT'];
    for (const key of Object.keys(task.worldOverride || {})) {
      if (!WIRED.includes(key)) {
        return { error: 'task ' + taskName + ' requires wiring for: ' + key };
      }
    }

    // Save outer state.
    const saved = {
      coldState, allIds, rng, simTime, tickCount,
      fieldTimer, compactTimer,
      hdr: Uint32Array.from(views.worldhdr),
      curriculum: world.curriculum,
      ledgerSource:  ledger.source,
      ledgerSink:    ledger.sink,
      ledgerInitial: ledger.initial,
      ledgerLastVerify: ledger.lastVerify,
    };

    let result; // Переменная для хранения итогового ответа

    try {
      // Блок 2: Инициализация чистой тестовой среды внутри try
      coldState     = new Map();
      allIds        = [];
      rng           = mulberry32(0xA5C0DE5A ^ (tickCount & 0xFFFF));
      simTime       = 0;
      tickCount     = 0;
      fieldTimer    = 0;
      compactTimer  = 0;
      views.worldhdr.fill(0);
      world.simTime = 0;
      world.tick    = 0;
      world.curriculum = { food: true, danger: true, predator: true,
                           signal: true, delay: true,
                           ...task.worldOverride };

      const id = 1000;
      const b  = makeBeing({
        id, x: 0, z: 0, energy: 200,
        program: new Uint8Array(champData.program),
        genes: {
          ...champData.genes,
          fusionAttn:     new Float32Array(champData.genes.fusionAttn ?? new Array(32).fill(1)),
          plasticityRule: new Float32Array(champData.genes.plasticityRule ?? [1,1,1]),
        },
      });
      if (b._mlpW1 && champData.mlpW1) b._mlpW1.set(champData.mlpW1);
      if (b._mlpB1 && champData.mlpB1) b._mlpB1.set(champData.mlpB1);
      if (b._mlpW2 && champData.mlpW2) b._mlpW2.set(champData.mlpW2);
      b._mlpB2 = champData.mlpB2 ?? 0;
      b._assimilationCount = champData._assimilationCount || 0;
      if (champData._heritage) b._heritage = champData._heritage.slice();
      coldState.set(id, b);
      allIds.push(id);
      recordBirth(b);

      const savedFood   = views.food.slice();
      const savedCorpse = views.corpse.slice();
      const savedStruct = views.struct.slice();
      const savedFieldF = views.fieldF.slice();
      const savedFieldD = views.fieldD.slice();
      const savedFieldC = views.fieldC.slice();

      views.food.fill(0);
      views.corpse.fill(0);
      views.struct.fill(0);
      views.fieldF.fill(0);
      views.fieldD.fill(0);
      views.fieldC.fill(0);
      views.worldhdr.fill(0);

      initPatches();

      const seedCount = task.worldOverride?.FOOD_SEED_INIT ?? FOOD_SEED_INIT;
      for (let i = 0; i < seedCount; i++) {
        const f = _spawnFoodInPatch();
        if (!f) continue;
        const slot = views.worldhdr[5] - 1;
        const g = 0.3 + rng() * 0.6;
        views.food[slot * FOOD_STRIDE_F32 + 2] = g;
        ledger.source += g * PLANT_FULL_ENERGY;
      }


      const FIXED_H = 0.05;
      const EVAL_T0  = performance.now();
      const EVAL_MAX = 45000;
      for (let s = 0; s < task.runTicks; s++) {
        if ((s & 255) === 0 && performance.now() - EVAL_T0 > EVAL_MAX) break;
        simTime += FIXED_H;
        tickCount++;
        world.simTime = simTime;
        world.tick    = tickCount;
        views.worldhdr[7] = tickCount;
        rebuildSpatialGrids();
        tickFood(FIXED_H);
        tickCorpses(FIXED_H);
        tickStructures(FIXED_H);
        tickField(FIXED_H);
        let alive = 0;
        for (let i = 0; i < allIds.length; i++) {
          const being = coldState.get(allIds[i]);
          if (!being || being.dead) continue;
          stepBeing(being, FIXED_H, 0);
          if (!being.dead) alive++;
        }
        for (let i = allIds.length - 1; i >= 0; i--) {
          const being = coldState.get(allIds[i]);
          if (!being || being.dead) {
            coldState.delete(allIds[i]);
            allIds[i] = allIds[allIds.length - 1];
            allIds.pop();
          }
        }
        views.worldhdr[4] = alive;
      }

      const survivors = [];
      for (const being of coldState.values()) {
        if (being.dead) continue;
        survivors.push({
          id: being.id, age: being.age, energy: being.energy,
          children: being._childCount || 0,
          rhoEMA: being._rhoEMA ?? 0.5,
          valence: being._valence ?? 0,
          g2: being._g2 ?? 0,
          fusedSelf: being._fusedSelf ?? 0,
        });
      }
      const m0 = survivors[0] ?? { age: 0, energy: 0, children: 0,
                                   rhoEMA: 0.5, valence: 0, g2: 0 };
      const score = survivors.length > 0 ? task.score(m0) : 0;

      // Записываем результат теста в переменную вместо прямого return
      result = {
        task: taskName,
        taskVersion: task.version,
        ticks: task.runTicks,
        survivorCount: survivors.length,
        survivors,
        score,
      };

    } finally {
      // Блок 3: Восстановление окружения (срабатывает ВСЕГДА, даже при падении симуляции)
      coldState     = saved.coldState;
      allIds        = saved.allIds;
      rng           = saved.rng;
      simTime       = saved.simTime;
      tickCount     = saved.tickCount;
      fieldTimer    = saved.fieldTimer;
      compactTimer  = saved.compactTimer;
      world.simTime = simTime;
      world.tick    = tickCount;
      world.curriculum = saved.curriculum;
      views.food.set(savedFood);
      views.corpse.set(savedCorpse);
      views.struct.set(savedStruct);
      views.fieldF.set(savedFieldF);
      views.fieldD.set(savedFieldD);
      views.fieldC.set(savedFieldC);
      views.worldhdr.set(saved.hdr);
      ledger.source     = saved.ledgerSource;
      ledger.sink       = saved.ledgerSink;
      ledger.initial    = saved.ledgerInitial;
      ledger.lastVerify = saved.ledgerLastVerify;
    }

    return result; // Возвращаем собранные метрики
  },

  snapshot() {
    const beings = [];
    for (const b of coldState.values()) {
      if (b.dead) continue;
      beings.push({
        id: b.id,
        x: b.x, z: b.z,
        energy: b.energy, age: b.age,
        program: Array.from(b.program),
        data: Array.from(b.data),
        genes: { ...b.genes,
          fusionAttn:     Array.from(b.genes.fusionAttn ?? []),
          plasticityRule: Array.from(b.genes.plasticityRule ?? []) },
        state: Array.from(b.state),
        _parentId: b._parentId,
        _childCount: b._childCount,
        _mlpW1: Array.from(b._mlpW1),
        _mlpB1: Array.from(b._mlpB1),
        _mlpW2: Array.from(b._mlpW2),
        _mlpB2: b._mlpB2,
        _assimilationCount: b._assimilationCount || 0,
        _heritage: b._heritage ? b._heritage.slice(0, 8) : [],
      });
    }
    return {
      t: simTime,
      tickCount,
      curriculumId: 'default-v1',
      currentPhase,
      phaseStartTick,
      worldhdr: Array.from(views.worldhdr),
      beings,
      food:    Array.from(views.food.subarray(0, views.worldhdr[5] * FOOD_STRIDE_F32)),
      corpse:  Array.from(views.corpse.subarray(0, views.worldhdr[6] * CORPSE_STRIDE_F32)),
      struct:  Array.from(views.struct.subarray(0, views.worldhdr[2] * STRUCT_STRIDE_F32)),
      fieldF:  Array.from(views.fieldF),
      fieldD:  Array.from(views.fieldD),
      fieldC:  Array.from(views.fieldC),
      ledger:  { source: ledger.source, sink: ledger.sink, initial: ledger.initial },
    };
  },

  restore(args) {
    const snap = args.snapshot;
    if (!snap) return { error: 'no snapshot' };
    coldState.clear();
    allIds.length = 0;
    simTime        = snap.t;
    tickCount      = snap.tickCount;
    currentPhase   = snap.currentPhase;
    phaseStartTick = snap.phaseStartTick;
    world.simTime  = simTime;
    world.tick     = tickCount;

    for (const sb of snap.beings) {
      const b = makeBeing({
        id: sb.id, x: sb.x, z: sb.z,
        energy: sb.energy, age: sb.age,
        program: new Uint8Array(sb.program),
        data: new Int8Array(sb.data),
        genes: { ...sb.genes,
          fusionAttn:     new Float32Array(sb.genes.fusionAttn),
          plasticityRule: new Float32Array(sb.genes.plasticityRule) },
      });
      b.state.set(sb.state);
      b._statePrev.set(sb.state);
      b._parentId = sb._parentId;
      b._childCount = sb._childCount;
      coldState.set(b.id, b);
      if (sb._mlpW1) b._mlpW1.set(sb._mlpW1);
      if (sb._mlpB1) b._mlpB1.set(sb._mlpB1);
      if (sb._mlpW2) b._mlpW2.set(sb._mlpW2);
      if (sb._mlpB2 !== undefined) b._mlpB2 = sb._mlpB2;
      b._assimilationCount = sb._assimilationCount || 0;
      if (sb._heritage) b._heritage = sb._heritage.slice();
      allIds.push(b.id);
    }

    views.food.set(snap.food);
    views.corpse.set(snap.corpse);
    views.struct.set(snap.struct);
    views.fieldF.set(snap.fieldF);
    views.fieldD.set(snap.fieldD);
    views.fieldC.set(snap.fieldC);
    views.worldhdr.set(snap.worldhdr);
    ledger.source  = snap.ledger.source;
    ledger.sink    = snap.ledger.sink;
    ledger.initial = snap.ledger.initial;

    return { restored: coldState.size, t: simTime };
  },

  /* ── drainTopPercentile ─────────────────────────────────────
   *
   * The being's payment mechanism. Selects the top N% of the
   * population by energy, drains up to `amount` units from them,
   * records the drain as a sink, and reports the outcome.
   *
   * The ledger is not touched by the drain itself. `ledger.sink`
   * is incremented because energy left the being population. This
   * is exactly the accounting the spawn_food fix restored.
   *
   * Selection is by raw energy, descending. No randomness. No
   * fitness weighting beyond the current energy of each being.
   * The top 1% by current energy are the ones who can afford it.
   * If they cannot afford the full amount, the shortfall is
   * reported to the archon, which decides what to do.
   */
  drainTopPercentile(args = {}) {
    const amount   = Math.max(0, Number(args.amount) || 0);
    const fraction = Math.max(0.001, Math.min(0.10,
                          Number(args.fraction) || 0.01));
    if (amount === 0) return { drained: 0, count: 0, shortfall: 0 };

    const pool = [];
    for (const b of coldState.values()) {
      if (b.dead) continue;
      pool.push(b);
    }
    if (pool.length === 0) {
      return { drained: 0, count: 0, shortfall: amount, poolSize: 0, topN: 0 };
    }

    pool.sort((x, y) => y.energy - x.energy);
    const topN = Math.max(1, Math.floor(pool.length * fraction));

    let drained = 0;
    let count   = 0;
    for (let i = 0; i < topN && drained < amount; i++) {
      const b = pool[i];
      const take = Math.min(b.energy, amount - drained);
      if (take <= 0) continue;
      b.energy -= take;
      drained += take;
      count++;
    }

    ledger.addSink(drained);

    return {
      drained:   +drained.toFixed(2),
      count,
      shortfall: +Math.max(0, amount - drained).toFixed(2),
      poolSize:  pool.length,
      topN,
    };
  },
};


function onQuery(m) {
  const { id, name, args } = m;
  let result;
  try {
    const fn = QUERIES[name];
    result = fn ? fn(args || {}) : { error: 'unknown query: ' + name };
  } catch (e) {
    result = { error: String((e && e.message) || e) };
  }
  self.postMessage({ type: 'query-result', id, name, result });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') onInit(m);
  else if (m.type === 'step') onStep(m.dt, m.t);
  else if (m.type === 'query') onQuery(m);
  else if (m.type === 'swap-sab') onSwapSab(m);
};

function onSwapSab(m) {
  const { sab, offsets, cfg } = m;
  if (!sab || !offsets) {
    self.postMessage({ type: 'swap-sab-err', error: 'missing sab/offsets' });
    return;
  }

  const oldViews = views;
  views = buildViews(sab, offsets, cfg);

  // Copy every view across. Same layout in Part B; Part C will
  // need real migration. copyIf takes the min length so a
  // shrink cannot throw.
  const copyIf = (src, dst) => {
    if (!src || !dst) return;
    const len = Math.min(src.length, dst.length);
    dst.set(src.subarray(0, len));
  };
  copyIf(oldViews.beings,     views.beings);
  copyIf(oldViews.shape,      views.shape);
  copyIf(oldViews.stateVis,   views.stateVis);
  copyIf(oldViews.food,       views.food);
  copyIf(oldViews.corpse,     views.corpse);
  copyIf(oldViews.struct,     views.struct);
  copyIf(oldViews.patch,      views.patch);
  copyIf(oldViews.fieldF,     views.fieldF);
  copyIf(oldViews.fieldD,     views.fieldD);
  copyIf(oldViews.fieldC,     views.fieldC);
  copyIf(oldViews.reqhdr,     views.reqhdr);
  copyIf(oldViews.request,    views.request);
  copyIf(oldViews.dephdr,     views.dephdr);
  copyIf(oldViews.deposit,    views.deposit);
  copyIf(oldViews.worldhdr,   views.worldhdr);
  copyIf(oldViews.structData, views.structData);
  copyIf(oldViews.structProg, views.structProg);
  copyIf(oldViews.immortalIO, views.immortalIO);
  copyIf(oldViews.deityIO,    views.deityIO);

  // Update world's view references.
  for (const k of ['beings','shape','stateVis','food','corpse','struct',
                   'patch','fieldF','fieldD','fieldC','worldhdr',
                   'structData','structProg','reqhdr','request',
                   'dephdr','deposit','deityIO']) {
    world[k] = views[k];
  }

  // Update runtime bounds from new view lengths.
  world.MAX_BEINGS = views.beings.length / BEING_STRIDE_F32;
  world.FOOD_MAX   = views.food.length   / FOOD_STRIDE_F32;
  world.CORPSE_MAX = views.corpse.length / CORPSE_STRIDE_F32;
  world.STRUCT_MAX = views.struct.length / STRUCT_STRIDE_F32;
  world.GRID       = Math.round(Math.sqrt(views.fieldF.length));

  // Rebuild spatial grids — they index into the new views.
  rebuildSpatialGrids();

  self.postMessage({ type: 'swap-sab-ack', cfg });
}

/* ── init ─────────────────────────────────────────────────────────── */

// Build all typed-array views over a SAB. Used by onInit and by
// onSwapSab. The cfg argument carries the current bounds so the
// views match the allocation. When cfg is omitted, uses the module
// constants — same as the old hardcoded version.
function buildViews(sab, off, cfg) {
  const c = cfg || {
    beings: MAX_BEINGS,
    food:   FOOD_MAX,
    corpse: CORPSE_MAX,
    struct: STRUCT_MAX,
    grid:   GRID,
  };
  const G2 = c.grid * c.grid;
  return {
    beings:   new Float32Array(sab, off.beings,   c.beings  * BEING_STRIDE_F32),
    shape:    new Float32Array(sab, off.shape,    c.beings  * SHAPE_STRIDE_F32),
    stateVis: new Float32Array(sab, off.stateVis, c.beings  * STATEVIS_STRIDE_F32),
    food:     new Float32Array(sab, off.food,     c.food    * FOOD_STRIDE_F32),
    corpse:   new Float32Array(sab, off.corpse,   c.corpse  * CORPSE_STRIDE_F32),
    struct:   new Float32Array(sab, off.struct,   c.struct  * STRUCT_STRIDE_F32),
    patch:    new Float32Array(sab, off.patch,    PATCH_MAX * PATCH_STRIDE_F32),
    fieldF:   new Float32Array(sab, off.fieldF,   G2),
    fieldD:   new Float32Array(sab, off.fieldD,   G2),
    fieldC:   new Float32Array(sab, off.fieldC,   G2),
    reqhdr:   new Uint32Array (sab, off.reqhdr,   2),
    request:  new Float32Array(sab, off.request,  REQUEST_MAX * REQUEST_STRIDE_F32),
    dephdr:   new Uint32Array (sab, off.dephdr,   2),
    deposit:  new Float32Array(sab, off.deposit,  DEPOSIT_MAX * DEPOSIT_STRIDE_F32),
    worldhdr: new Uint32Array (sab, off.worldhdr, 8),
    structData: new Int8Array(sab, off.structData, c.struct * STRUCT_DATA_SIZE),
    structProg: new Uint8Array(sab, off.structProg, c.struct * STRUCT_PROG_SIZE),
    immortalIO: new Float32Array(sab, off.immortalIO, IMMORTAL_IO_SIZE),
    deityIO:    new Float32Array(sab, off.deityIO,    DEITY_IO_SIZE),
  };
}

function onInit(m) {
  const sab = m.sab, off = m.offsets;
  if (m.curriculumId && CURRICULA[m.curriculumId]) {
    curriculum = CURRICULA[m.curriculumId];
    currentPhase = 0;
    phaseStartTick = 0;
  }

  views = buildViews(sab, off, m.cfg);

  rng = mulberry32(0xA5C0DE5A);

  world = {
    planeSize: PLANE,
    STATE_SIZE,
    GRID: Math.round(Math.sqrt(views.fieldF.length)),
    simTime: 0,
    SENSE_COST,
    PLANT_FULL_ENERGY,
    PLANT_EDIBLE_THRESH,
    STRUCTURE_RANGE,
    // Runtime bounds — read from the live view lengths. If the
    // SAB ever swaps to a larger allocation, these fields reflect
    // the new sizes on the next onInit-equivalent call.
    MAX_BEINGS: views.beings.length / BEING_STRIDE_F32,
    FOOD_MAX:   views.food.length   / FOOD_STRIDE_F32,
    CORPSE_MAX: views.corpse.length / CORPSE_STRIDE_F32,
    STRUCT_MAX: views.struct.length / STRUCT_STRIDE_F32,
    IRRATIONAL_POOL,
    GRID_CELL,
    SPATIAL_N,
    beingCellHead, beingCellNext,
    foodCellHead,  foodCellNext,
    corpseCellHead, corpseCellNext,
    structCellHead, structCellNext,
    cellKey,
    worldhdr: views.worldhdr,
    beings:   views.beings,
    food:     views.food,
    corpse:   views.corpse,
    struct:   views.struct,
    patch:    views.patch,
    fieldF:   views.fieldF,
    fieldD:   views.fieldD,
    fieldC:   views.fieldC,
    reqhdr:   views.reqhdr,
    request:  views.request,
    dephdr:   views.dephdr,
    deposit:  views.deposit,
    getBeingById: (id) => coldState.get(id) ?? null,
    ledger,
    structData: views.structData,
    structProg: views.structProg,
    deityIO: views.deityIO,
    curriculum: curriculum[currentPhase],
    tick: 0,
  };


  initPatches();

  const NAMES = Object.keys(BeingVM.STARTER_PROGRAMS);

  let seedIdx = 0;
  for (const ib of m.beings) {
    const name = NAMES[(rng() * NAMES.length) | 0];
    // Alternate founders between lineage 0 (crimson) and lineage 1 (cyan).
    const lineageId = seedIdx % 2;
    seedIdx++;
    const b = makeBeing({
      id: ib.id, x: ib.x, z: ib.z,
      energy: ib.energy ?? 200,
      age:    ib.age ?? 0,
      seedName: name,
      lineageId,
      size: ib.size,
    });
    coldState.set(b.id, b);
    allIds.push(b.id);
    recordBirth(b);
  }

  for (let i = 0; i < FOOD_SEED_INIT; i++) {
    const f = _spawnFoodInPatch();
    if (!f) continue;
    // Use the slot the spawner actually wrote to. worldhdr[5] is
    // not a reliable index here because the reclaim path does not
    // increment it.
    const slot = f._slot;
    if (slot === undefined) continue;
    const g = 0.3 + rng() * 0.6;
    views.food[slot * FOOD_STRIDE_F32 + 2] = g;
    views.food[slot * FOOD_STRIDE_F32 + 3] = 0;
    // The seeded growth is captured by computeStored() into
    // ledger.initial below. Do NOT also add it to ledger.source —
    // that double-counts and produces a fixed negative offset.
  }

  ledger.initial = computeStored();
  ledger.lastVerify = 0;

  self.postMessage({ type: 'ready', count: allIds.length });
}

/* ── step ─────────────────────────────────────────────────────────── */

function onStep(dt, t) {
  if (paused) { self.postMessage({ type: 'tick-done' }); return; }
  const FIXED_H = 0.05;
  const MAX_STEPS = 400;
  const MAX_BACKLOG = FIXED_H * 64;   // ~3.2 s of sim time

  simAccum += dt;
  // Watchdog. If the tab was throttled or a step stalled, drop the
  // backlog rather than freeze trying to catch up. The sim falls
  // behind wall-clock rather than locking the worker.
  if (simAccum > MAX_BACKLOG) simAccum = 0;

  let steps = 0;
  while (simAccum >= FIXED_H && steps < MAX_STEPS) {
    simAccum -= FIXED_H;
    simTime += FIXED_H;
    world.simTime = simTime;
    tickCount++;
    views.worldhdr[7] = tickCount;
    world.tick = tickCount;
    rebuildSpatialGrids();
    advanceCurriculum();
    _driftPatches(FIXED_H);
    tickFood(FIXED_H);
    tickCorpses(FIXED_H);
    tickStructures(FIXED_H);
    tickField(FIXED_H);

    let alive = 0;
    for (let i = 0; i < allIds.length; i++) {
      const b = coldState.get(allIds[i]);
      if (!b || b.dead) continue;
      stepBeing(b, FIXED_H, t);
      if (b.dead) continue;
      alive++;
    }
    for (let i = allIds.length - 1; i >= 0; i--) {
      const b = coldState.get(allIds[i]);
      if (!b || b.dead) {
        coldState.delete(allIds[i]);
        allIds[i] = allIds[allIds.length - 1];
        allIds.pop();
      }
    }
    views.worldhdr[4] = alive;

    compactTimer++;
    if (compactTimer >= COMPACT_EVERY_TICKS) {
      compactTimer = 0;
      compactFood();
      compactCorpses();
      compactStructures();
    }

    if (tickCount % (COMPACT_EVERY_TICKS * 4) === 0) {
      // Population cap enforcement. Random, not energy-weighted.
      // The previous version culled the 10% lowest-energy non-archived
      // beings every 1200 ticks. That is a directional selection term
      // the sim did not ask for. A being that evolves a slow-burn
      // strategy — low instantaneous energy, high lifetime reproduction
      // — would be culled before its fitness showed. Random cull
      // controls population without biasing on phenotype.
      const target = Math.floor(MAX_BEINGS * 0.85);
      let live = 0;
      for (const b of coldState.values()) if (!b.dead) live++;
      if (live > target) {
        const excess = live - target;
        const pool = [];
        for (const b of coldState.values()) if (!b.dead) pool.push(b);
        for (let i = 0; i < excess; i++) {
          const j = i + Math.floor(rng() * (pool.length - i));
          const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
          const b = pool[i];
          ledger.addSink(Math.max(0, b.energy));
          b.dead = true;
          b.energy = 0;
          recordDeath(b, 'culled');
        }
      }
    }

    if (tickCount % (COMPACT_EVERY_TICKS * 2) === 0) {
      for (const b of coldState.values()) {
        if (b.dead) continue;
        if ((b._childCount || 0) > 0) recordElite(b);
      }
      reseedFromElites(20);
    }

    if (tickCount % 100 === 0) postStats();
    if (tickCount % 500 === 0) {
      const census = new Array(LINEAGE_COUNT).fill(0);
      for (const b of coldState.values()){
        if (b.dead) continue;
        const id = b.genes.lineageId ?? 0;
        if (id >= 0 && id < LINEAGE_COUNT) census[id]++;
      }
      console.log('[lineage] T+' + Math.floor(simTime), 'L0:' + census[0], 'L1:' + census[1], 'L2:' + census[2], 'L3:' + census[3]);
    }
    if (simTime - ledger.lastVerify >= 10.0) {
      ledger.lastVerify = simTime;
      verifyLedger();
    }
    steps++;
  }
  drainImmortalCommands();
  applyImmortalShocks(FIXED_H);   // <-- ADD THIS LINE
  writeImmortalStats();
  self.postMessage({ type: 'tick-done' });
}


/* ── per-being step ───────────────────────────────────────────────── */

function stepBeing(b, dt, t) {
  b.age += dt;

  // ── Step 8: divine bias on arousal ────────────────────────
  if (b._godBiasUntil && tickCount < b._godBiasUntil) {
    b.state[0] = Math.max(-3, Math.min(3, b.state[0] + b._godBias * dt));
  } else if (b._godBias) {
    b._godBias *= 0.98;
    if (Math.abs(b._godBias) < 0.01) b._godBias = 0;
  }

  // Behavior descriptor for MAP-Elites. Sampled every 20 steps, not every
  // step. The descriptor changes on a multi-second timescale; the EMA
  // below absorbs the coarser sample rate. Cuts ~80K spatial queries
  // per second to ~4K.
  if (((tickCount + b.id) & 15) === 0) {
    const f = Q.nearestFood(world, b.x, b.z, b.genes.sense);
    const fd = f ? Math.hypot(f.x - b.x, f.z - b.z) : b.genes.sense;
    b._meanFoodDist = (b._meanFoodDist ?? fd) * 0.95 + fd * 0.05;

    const n = Q.nearestBeing(world, b.x, b.z, 400, b.id);
    const nd = n ? Math.hypot(n.x - b.x, n.z - b.z) : 400;
    b._meanNeighborDist = (b._meanNeighborDist ?? nd) * 0.95 + nd * 0.05;
  }

  const metab = b.genes.metabolism * 1.2 * dt;
  b.energy -= metab;
  ledger.sink += metab;
  if (b._usesPredation === undefined) {
    b._usesPredation = programUsesPredation(b.program) ? 1 : 0;
  }
  if (!curriculum[currentPhase].predator && b._usesPredation) {
    b.energy -= 0.5;
    ledger.sink += 0.5;
  }

  const stateCost = 0.001 * (b._stateMag || 0) * dt;
  b.energy -= stateCost;
  ledger.sink += stateCost;

  if (b.genes.fusionEnabled) {
    const fc = 0.0025 * b.genes.fusionStrength * b.genes.fusionDepth * dt;
    b.energy -= fc;
    ledger.sink += fc;
  }

  const pc = 0.005 * b.genes.statePlasticity * dt;
  b.energy -= pc;
  ledger.sink += pc;

  b._plasticityTimer += dt;
  if (b._plasticityTimer >= 2.0) {
    b._plasticityTimer -= 2.0;
    updatePlasticity(b, 2.0);
  }

  updateState(b, world, rng, dt);

  if (b._episodic) {
    const E = b._episodic;
    const base = E.head * STATE_SIZE;
    for (let s = 0; s < STATE_SIZE; s++) E.states[base + s] = b.state[s];
    E.actions[E.head] = b._lastAction || 0;
    const prev = b._episodicPrevEnergy ?? b.energy;
    E.rewards[E.head] = b.energy - prev;
    b._episodicPrevEnergy = b.energy;
    E.head = (E.head + 1) % BeingVM.EPISODE_LEN;
    if (E.len < BeingVM.EPISODE_LEN) E.len++;
  }

  for (let s = 0; s < BeingVM.INSTR_PER_STEP; s++) {
    if (!executeOneInstruction(b, world, rng)) break;
  }

    if (b.symbionts && b.symbionts.length > 0) {
    for (let k = 0; k < b.symbionts.length; k++) {
      const sc = 0.015 * dt;
      b.energy -= sc;
      ledger.sink += sc;
      // Each symbiont runs one instruction of its program. Its effects
      // land on the host: MOVE moves the host, EAT makes the host eat,
      // SENSE_* reads the host's surroundings. This is the safeSurf
      // property: the absorbed template is still running.
      runSymbiontInstruction(b, b.symbionts[k], world, rng);
    }
  }

  if (b._pendingChild) {
    const before = allIds.length;
    const reserved = b._pendingChild.energy;
    spawnChild(b, reserved);
    if (allIds.length === before) {
      // Spawn failed. Refund the parent. No ledger adjustment: the
      // reserved energy was never sunk, it was only moved from parent
      // to a child slot that never materialised. Decrementing sink
      // here would create negative sink entries that inflate expected.
      b.energy += reserved;
    }
    b._pendingChild = null;
  }
  if (b._pendingNewborn) {
    const before = allIds.length;
    const beforeEnergy = b.energy;
    releaseSymbiont(b, b._pendingNewborn);
    if (allIds.length === before) {
      b.energy = beforeEnergy;
    }
    b._pendingNewborn = null;
  }

  const r2 = b.x * b.x + b.z * b.z;
  const softR = PLANE * 0.88;
  if (r2 > softR * softR) {
    const d = Math.sqrt(r2) || 1;
    const nx = b.x / d, nz = b.z / d;
    if (d > PLANE) { b.x = nx * PLANE; b.z = nz * PLANE; }
    else {
      const push = (d - softR) / (PLANE - softR);
      b.x -= nx * push * 2.2;
      b.z -= nz * push * 2.2;
    }
  }

  if (((tickCount + b.id) & 31) === 0) {
    const slot = views.dephdr[0] % DEPOSIT_MAX;
    const dBase = slot * DEPOSIT_STRIDE_F32;
    views.deposit[dBase + 0] = b.x;
    views.deposit[dBase + 1] = 0;
    views.deposit[dBase + 2] = b.z;
    views.deposit[dBase + 7] = b._valence || 0;
    views.deposit[dBase + 6] = 0.08;
    Atomics.store(views.dephdr, 0, (slot + 1) % DEPOSIT_MAX);
  }

   if (b.energy <= 0 || b.age > b.genes.lifespan) {
    const _cause = (b.energy <= 0) ? 'starved' : 'aged';
    globalThis.worker_metrics.deaths[_cause] =
      (globalThis.worker_metrics.deaths[_cause] || 0) + 1;
    b.dead = true;
    const mass = Math.max(0, b.energy);
    if (mass > 5) {
      const n = views.worldhdr[6];
      if (n < world.CORPSE_MAX) {
        const o = n * CORPSE_STRIDE_F32;
        views.corpse[o + 0] = b.x;
        views.corpse[o + 1] = b.z;
        views.corpse[o + 2] = mass;
        views.corpse[o + 3] = b.genes.hue;
        views.corpse[o + 4] = 1;
        views.worldhdr[6] = n + 1;
      } else {
        ledger.sink += mass;
      }
    } else {
      ledger.sink += b.energy;
    }
    recordDeath(b, _cause);
    const base = b.id * BEING_STRIDE_F32;
    views.beings[base + 11] = 0;
    return;
  }
  writeHot(b);
}

function writeHot(b) {
  const base = b.id * BEING_STRIDE_F32;
  const yaw = Math.atan2(-(b.lastDirZ || 0), b.lastDirX || 1);

  // Morph: how elongated the being is. Higher = flame.
  // Base morph depends on energy. Merged guests push it higher.
  // Program can override via OP.FORM writing b.form[0].
  let morph = clamp(b.energy / 220, 0.0, 1.0) * 0.45;
  morph = Math.min(1.0, morph + (b.symbionts?.length || 0) * 0.22);
  morph = Math.min(1.0, morph + Math.min(0.3, (b._assimilationCount || 0) * 0.04));
  if (b.form) morph = Math.min(1.0, morph + b.form[0] * 0.15);

  // Coherence: how tightly wound the being is.
  // Stable self-trace + successful reproduction = coherent.
  let coh = clamp(Math.abs(b._selfTrace ?? 0) * 2.2, 0.0, 1.0);
  coh = Math.min(1.0, coh + Math.min(0.4, (b._childCount || 0) * 0.04));

  views.beings[base +  0] = b.x;
  // Total merges: symbionts + assimilations + bound guests.
  let boundCount = 0;
  if (b.symbionts) {
    for (let i = 0; i < b.symbionts.length; i++) {
      if (b.symbionts[i].being) boundCount++;
    }
  }
  views.beings[base +  1] =
      ((b.symbionts && b.symbionts.length) || 0)
    + (b._assimilationCount || 0)
    + boundCount;
  views.beings[base +  2] = b.z;
  views.beings[base +  3] = yaw;
  views.beings[base +  4] = morph;
  views.beings[base +  5] = coh;
  views.beings[base +  6] = b.energy;
  views.beings[base +  7] = b.age;
  views.beings[base +  8] = b.genes.hue;
  views.beings[base +  9] = b.genes.size;
  views.beings[base + 10] = b._valence || 0;
  views.beings[base + 11] = 1;

  // ── Shape genome to SAB for the renderer ──────────────────────
  if (views.shape && b.genes.shapeParams) {
    const so = b.id * 16;
    for (let i = 0; i < 16; i++) views.shape[so + i] = b.genes.shapeParams[i];
  }

  // ── Mental state slots 0..7 to SAB for thought visualization ──
  // Arousal, Satiation, Threat, Social, BiasX, BiasZ, Trace, Tempo.
  // These drive the surface: ribbon flare, core breath, pupil.
  if (views.stateVis && b.state) {
    const vo = b.id * 8;
    for (let i = 0; i < 8; i++) views.stateVis[vo + i] = b.state[i];
  }
}

/* ── immortal I/O ─────────────────────────────────────────────── */
//
// The immortal writes commands to a 32-slot ring in the shared
// buffer. We drain them once per tick. Nothing else crosses the
// boundary. The immortal cannot read the beings directly, cannot
// write to their memory, cannot touch the SAB outside this ring.
// It can only do what this dispatcher permits.

// ── Gene name lookup, so the immortal can ask for a gene by index
//    without knowing the object layout.
const GENE_KEYS = [
  'speed', 'sense', 'size', 'metabolism', 'lifespan', 'matAge', 'repCost',
  'stateDecay', 'stateCoupling', 'stateInput', 'statePlasticity',
  'fusionEnabled', 'fusionStrength', 'fusionSeed', 'fusionDepth',
  'fusionBias', 'hue', 'lineageId', 'formColor', 'formCadence',
];

function cloneBeing(parent) {
  if (allIds.length >= world.MAX_BEINGS) return null;
  const id = allocId();
  if (id < 0) return null;
  const a = rng() * Math.PI * 2;
  const x = clampPlane(parent.x + Math.cos(a) * 40);
  const z = clampPlane(parent.z + Math.sin(a) * 40);
  const genes = { ...parent.genes };
  genes.fusionAttn = new Float32Array(parent.genes.fusionAttn);
  genes.plasticityRule = new Float32Array(parent.genes.plasticityRule);
  genes.shapeParams = new Float32Array(parent.genes.shapeParams || new Float32Array(16));
  const child = makeBeing({
    id, x, z,
    energy: Math.min(parent.energy, 300),
    genes,
    program: parent.program.slice(),
    data: new Int8Array(parent.data),
  });
  child.state.set(parent.state);
  child._statePrev.set(parent.state);
  child._parentId = parent.id;
  child._assimilationCount = parent._assimilationCount || 0;
  child._heritage = (parent._heritage || []).slice();
  coldState.set(id, child);
  allIds.push(id);
  recordBirth(child);
  return child;
}

function applyImmortalCommand(type, a, b, c, d, e, f, g) {
  const t = type | 0;
  switch (t) {
    case 0: return;

    // ── Being lifecycle ────────────────────────────────────────
    case 1: {  // spawn(x, z, energy)
      if (allIds.length >= MAX_BEINGS) return;
      const id = allocId(); if (id < 0) return;
      const en = Math.max(20, Math.min(400, c || 200));
      const child = makeBeing({
        id, x: clampPlane(a), z: clampPlane(b),
        energy: en, lineageId: 0,
      });
      coldState.set(id, child); allIds.push(id); recordBirth(child);
      ledger.addSource(en);
      return;
    }
    case 2: {  // kill(id)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.dead = true; b2.energy = 0; recordDeath(b2, 'immortal');
      return;
    }
    case 3: {  // move(id, x, z)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.x = clampPlane(b); b2.z = clampPlane(c);
      return;
    }
    case 4: {  // energize(id, delta)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      const before = b2.energy;
      b2.energy = Math.max(0, Math.min(2000, before + b));
      const d2 = b2.energy - before;
      if (d2 > 0) ledger.addSource(d2); else ledger.addSink(-d2);
      return;
    }
    case 5: {  // set_energy(id, value) — absolute
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      const before = b2.energy;
      b2.energy = Math.max(0, Math.min(2000, b));
      const d2 = b2.energy - before;
      if (d2 > 0) ledger.addSource(d2); else ledger.addSink(-d2);
      return;
    }
    case 6: {  // mutate(id)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.program = BeingVM.mutateProgram(b2.program, rng, true);
      b2._usesPredation = programUsesPredation(b2.program) ? 1 : 0;
      return;
    }
    case 7: {  // clone(id)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      cloneBeing(b2);
      return;
    }
    case 8: {  // force_reproduce(id)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      if (b2._pendingChild) return;
      const cost = b2.genes.repCost * 1.8;
      if (b2.energy < cost * 1.2) return;
      b2.energy -= cost;
      b2._pendingChild = { energy: cost };
      return;
    }
    case 9: {  // awaken(id) — grant a symbiont slot
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2._maxSymbionts = Math.min(8, (b2._maxSymbionts || 3) + 1);
      return;
    }
    case 10: {  // release_symbiont(id, idx)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      if (!b2.symbionts || !b2.symbionts[(b | 0)]) return;
      const sym = b2.symbionts.splice(b | 0, 1)[0];
      b2._pendingNewborn = sym;
      return;
    }

    // ── Gene / program / state surgery ────────────────────────
    case 11: {  // set_gene(id, gene_index, value)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      const key = GENE_KEYS[b | 0];
      if (!key) return;
      b2.genes[key] = c;
      return;
    }
    case 12: {  // set_program_byte(id, idx, value)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.program[(b | 0) & 4095] = (c | 0) & 0xFF;
      b2._usesPredation = programUsesPredation(b2.program) ? 1 : 0;
      return;
    }
    case 13: {  // set_state_slot(id, slot, value)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.state[(b | 0) & 31] = Math.max(-3, Math.min(3, c));
      return;
    }
    case 14: {  // set_hue(id, hue)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.genes.hue = ((b + 1) % 1 + 1) % 1;
      return;
    }
    case 15: {  // set_lineage(id, lineage_id)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      const lid = Math.max(0, Math.min(LINEAGE_COUNT - 1, b | 0));
      b2.genes.lineageId = lid;
      b2.genes.hue = lineageHue(lid, rng);
      return;
    }
    case 16: {  // inject_program(id, ...bytes) — write bytes [0..3]
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      const slots = [b, c, d, e, f, g];
      for (let i = 0; i < 6; i++) {
        if (slots[i] === undefined) break;
        b2.program[i] = (slots[i] | 0) & 0xFF;
      }
      b2._usesPredation = programUsesPredation(b2.program) ? 1 : 0;
      return;
    }
    case 17: {  // tag(id, tag_value) — write into data[0]
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2.data[0] = Math.max(-128, Math.min(127, (b | 0)));
      return;
    }

    // ── World shaping ──────────────────────────────────────────
    case 18: {  // spawn_food_patch(x, z, radius, count)
      const x = clampPlane(a), z = clampPlane(b);
      const radius = Math.max(20, Math.min(5000, c || 500));
      const count = Math.max(1, Math.min(200, d || 20));
      for (let i = 0; i < count; i++) {
        const f = _spawnFoodInPatch();
        if (!f) break;
        const ang = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * radius;
        const fx = clampPlane(x + Math.cos(ang) * r);
        const fz = clampPlane(z + Math.sin(ang) * r);
        const o = f._slot * FOOD_STRIDE_F32;
        // Credit the ledger with the ACTUAL growth value written,
        // not a fixed constant. computeStored() counts each live
        // food as (growth × PLANT_FULL_ENERGY); the source must
        // match that count or the conservation check drifts.
        const growth = 0.6 + rng() * 0.4;
        views.food[o + 0] = fx;
        views.food[o + 1] = fz;
        views.food[o + 2] = growth;
        views.food[o + 5] = 1;
        ledger.addSource(growth * PLANT_FULL_ENERGY);
      }
      return;
    }
    case 19: {  // deposit_food(x, z, amount) → fieldF
      Q.depositFood(world, a, b, c); return;
    }
    case 20: {  // deposit_danger(x, z, amount) → fieldD
      Q.depositDanger(world, a, b, c); return;
    }
    case 21: {  // deposit_custom(x, z, amount) → fieldC
      Q.depositCustom(world, a, b, c); return;
    }
    case 22: {  // spawn_corpse(x, z, mass)
      const n = views.worldhdr[6];
      if (n >= world.CORPSE_MAX) return;
      const o = n * CORPSE_STRIDE_F32;
      views.corpse[o + 0] = clampPlane(a);
      views.corpse[o + 1] = clampPlane(b);
      views.corpse[o + 2] = Math.max(5, Math.min(500, c || 50));
      views.corpse[o + 3] = rng();
      views.corpse[o + 4] = 1;
      views.worldhdr[6] = n + 1;
      return;
    }
    case 23: {  // clear_field(x, z, radius) — sets fieldD to 0 in a disc
      const G = GRID;
      const cellSize = PLANE * 2 / G;
      const cx = Math.floor((a / PLANE * 0.5 + 0.5) * G);
      const cy = Math.floor((b / PLANE * 0.5 + 0.5) * G);
      const R = Math.max(1, Math.ceil((c || 200) / cellSize));
      for (let j = -R; j <= R; j++) {
        const nj = cy + j; if (nj < 0 || nj >= G) continue;
        for (let i = -R; i <= R; i++) {
          const ni = cx + i; if (ni < 0 || ni >= G) continue;
          if (i*i + j*j > R*R) continue;
          views.fieldD[nj * G + ni] = 0;
        }
      }
      return;
    }

    // ── Culls ──────────────────────────────────────────────────
    case 24: {  // cull_weakest(count)
      const count = Math.min(500, a | 0);
      const pool = [];
      for (const b2 of coldState.values()) if (!b2.dead) pool.push(b2);
      pool.sort((x, y) => x.energy - y.energy);
      for (let i = 0; i < count && i < pool.length; i++) {
        pool[i].dead = true; pool[i].energy = 0;
        recordDeath(pool[i], 'immortal');
      }
      return;
    }
    case 25: {  // cull_random(count)
      const count = Math.min(500, a | 0);
      const pool = [];
      for (const b2 of coldState.values()) if (!b2.dead) pool.push(b2);
      for (let i = 0; i < count && pool.length > 0; i++) {
        const j = (rng() * pool.length) | 0;
        const b2 = pool[j];
        pool[j] = pool[pool.length - 1];
        pool.pop();
        b2.dead = true; b2.energy = 0;
        recordDeath(b2, 'immortal');
      }
      return;
    }
    case 26: {  // cull_oldest(count)
      const count = Math.min(500, a | 0);
      const pool = [];
      for (const b2 of coldState.values()) if (!b2.dead) pool.push(b2);
      pool.sort((x, y) => y.age - x.age);
      for (let i = 0; i < count && i < pool.length; i++) {
        pool[i].dead = true; pool[i].energy = 0;
        recordDeath(pool[i], 'immortal');
      }
      return;
    }
    case 27: {  // cull_by_lineage(lineage_id, count)
      const lid = a | 0;
      const count = Math.min(500, b | 0);
      const pool = [];
      for (const b2 of coldState.values()) {
        if (!b2.dead && b2.genes.lineageId === lid) pool.push(b2);
      }
      for (let i = 0; i < count && pool.length > 0; i++) {
        const j = (rng() * pool.length) | 0;
        const b2 = pool[j];
        pool[j] = pool[pool.length - 1]; pool.pop();
        b2.dead = true; b2.energy = 0;
        recordDeath(b2, 'immortal');
      }
      return;
    }
    case 28: {  // cull_by_predation(count) — kill beings that run predation
      const count = Math.min(500, a | 0);
      const pool = [];
      for (const b2 of coldState.values()) {
        if (!b2.dead && b2._usesPredation) pool.push(b2);
      }
      for (let i = 0; i < count && pool.length > 0; i++) {
        const j = (rng() * pool.length) | 0;
        const b2 = pool[j];
        pool[j] = pool[pool.length - 1]; pool.pop();
        b2.dead = true; b2.energy = 0;
        recordDeath(b2, 'immortal');
      }
      return;
    }

    // ── Sim control ────────────────────────────────────────────
    case 29: {  // curriculum_phase(n)
      const n = Math.max(0, Math.min(curriculum.length - 1, a | 0));
      currentPhase = n;
      phaseStartTick = tickCount;
      if (world) world.curriculum = curriculum[currentPhase];
      self.postMessage({ type: 'ledger',
        msg: `[immortal] curriculum → ${curriculum[currentPhase].name}` });
      return;
    }
    case 30: {  // pause_sim()
      paused = true;
      self.postMessage({ type: 'ledger', msg: '[immortal] pause' });
      return;
    }
    case 31: {  // resume_sim()
      paused = false;
      self.postMessage({ type: 'ledger', msg: '[immortal] resume' });
      return;
    }
    case 32: {  // set_constant(name_id, value)
      // name_id: 0=SENSE_COST 1=PLANT_FULL_ENERGY 2=STRUCTURE_RANGE
      // Not all constants are mutable; these are the useful ones.
      const nameId = a | 0;
      const v = b;
      if (nameId === 0) world.SENSE_COST = Math.max(0, Math.min(2, v));
      if (nameId === 1) world.PLANT_FULL_ENERGY = Math.max(1, Math.min(1000, v));
      if (nameId === 2) world.STRUCTURE_RANGE = Math.max(10, Math.min(1000, v));
      return;
    }
    case 33: {  // bless(id) — set a one-tick energy flag on the being
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2._immortalBlessed = tickCount;
      return;
    }
    case 34: {  // curse(id)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2._immortalCursed = tickCount;
      return;
    }
    case 35: {  // freeze(id) — pin a being in place for N ticks
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2._immortalFrozenUntil = tickCount + Math.max(1, Math.min(600, b | 0));
      return;
    }
    case 36: {  // reset_all() — clear the whole population
      for (const b2 of coldState.values()) {
        if (!b2.dead) { b2.dead = true; b2.energy = 0; recordDeath(b2, 'immortal'); }
      }
      return;
    }

    // ── Step 8: divine commands ───────────────────────────────
    case 37: {  // pressure(fieldId, x, z, radius, strength)
      const fieldId = a | 0;
      const x = clampPlane(b), z = clampPlane(c);
      const radius = Math.max(20, Math.min(5000, d || 500));
      const strength = Math.max(-5, Math.min(5, e || 0.5));
      const field = fieldId === 0 ? views.fieldF
                  : fieldId === 1 ? views.fieldD
                  : views.fieldC;
      const G = GRID;
      const cellSize = PLANE * 2 / G;
      const cx = Math.floor((x / PLANE * 0.5 + 0.5) * G);
      const cy = Math.floor((z / PLANE * 0.5 + 0.5) * G);
      const R = Math.max(1, Math.ceil(radius / cellSize));
      for (let j = -R; j <= R; j++) {
        const nj = cy + j; if (nj < 0 || nj >= G) continue;
        for (let i = -R; i <= R; i++) {
          const ni = cx + i; if (ni < 0 || ni >= G) continue;
          const d2 = i * i + j * j;
          if (d2 > R * R) continue;
          const falloff = 1 - Math.sqrt(d2) / R;
          const idx = nj * G + ni;
          field[idx] = Math.max(-20, Math.min(20,
            field[idx] + strength * falloff));
        }
      }
      return;
    }

    case 38: {  // bias_population(_, x, z, radius, bias, duration)
      const x = clampPlane(b), z = clampPlane(c);
      const radius = Math.max(20, Math.min(5000, d || 500));
      const bias = Math.max(-3, Math.min(3, e || 0));
      const duration = Math.max(20, Math.min(2000, f || 200));
      for (const b2 of coldState.values()) {
        if (b2.dead) continue;
        const dx = b2.x - x, dz = b2.z - z;
        if (dx * dx + dz * dz > radius * radius) continue;
        b2._godBias = (b2._godBias || 0) + bias;
        b2._godBiasUntil = tickCount + duration;
      }
      return;
    }

    case 39: {  // witness(id, tier)
      const b2 = coldState.get(a | 0); if (!b2 || b2.dead) return;
      b2._witnessed = (b2._witnessed || 0) + 1;
      b2.genes.size = Math.min(12.0, b2.genes.size * 1.05);
      b2.genes.hue = (b2.genes.hue + 0.07) % 1;
      return;
    }
  }
}

/* ── applyImmortalShocks ───────────────────────────────────────
 *
 * The immortal's shockwaves are not decals. Every tick, for every
 * live shock in the SAB ring, this pass:
 *
 *   1. Pushes nearby beings radially outward, hard. The push
 *      decays with distance from the shell (Gaussian, not 1/r²)
 *      so the wave is felt as a *ring*, not a point force.
 *
 *   2. Drains energy from anyone the shell touches. This is what
 *      "negative-space particulates" means on the sim side: the
 *      shell costs the population real energy.
 *
 *   3. Kills anything caught in the inner kill zone when the
 *      shock is strong enough. Killed beings become corpses;
 *      their hue is preserved so the wave leaves a visible
 *      signature in the corpse field.
 *
 *   4. Deposits danger into fieldD along the shell. The
 *      population's own behaviour layer senses the danger
 *      field, so beings learn to avoid the immortal's path
 *      without ever knowing it exists.
 *
 * Cost: O(shocks × live_beings). At 16 shocks and 24K beings
 * that's 384K distance checks per tick. Most shocks are dead
 * (age > life) or weak (strength < 0.05), so the real inner
 * loop runs a small fraction of that. Runs in the worker; does
 * not block render.
 */
function applyImmortalShocks(dt) {
  const IO = views.immortalIO;
  if (!IO) return;

  const head  = IO[IIO_SHOCK_HEAD_OFF] | 0;
  const count = Math.min(IIO_SHOCK_SLOTS, IO[IIO_SHOCK_COUNT_OFF] | 0);
  if (count === 0) return;

  for (let i = 0; i < count; i++) {
    const slot = (head - 1 - i + IIO_SHOCK_SLOTS) % IIO_SHOCK_SLOTS;
    const b    = IIO_SHOCK_RING_BASE + slot * IIO_SHOCK_STRIDE;

    const sx       = IO[b + 0];
    const sy       = IO[b + 1];   // unused for physics (2D plane)
    const sz       = IO[b + 2];
    const radius   = IO[b + 6];
    const strength = IO[b + 8];
    const age      = IO[b + 9];
    const life     = IO[b + 10];
    const type     = IO[b + 11] | 0;

    if (strength < 0.02) continue;
    if (age >= life) continue;

    // Shell thickness scales with strength. Weak shocks are
    // thin rings; strong shocks have fat, churning edges.
    const sigma = 1.5 + strength * 2.5;

    // Push force. Scaled by strength and by dt so a shock that
    // lives two seconds keeps pushing every tick.
    const pushForce = strength * 900;

    // Kill zone multiplier. Only strong shocks kill; weak ones
    // just bruise.
    const killStrength = type === 2 ? 3.5 : 1.0;
    const killProbBase = strength > 0.55 ? (strength - 0.55) * 2.0 * killStrength : 0;

    // Deposit rate for the danger field.
    const depositRate = strength * 6.0;

    // Iterate live beings. The allIds array is walked every tick
    // for stepBeing anyway; we piggyback on the same iteration
    // budget.
    for (let k = 0; k < allIds.length; k++) {
      const b2 = coldState.get(allIds[k]);
      if (!b2 || b2.dead) continue;

      const dx = b2.x - sx;
      const dz = b2.z - sz;
      const d2 = dx * dx + dz * dz;
      const d  = Math.sqrt(d2);

      if (d < 1e-3) continue;

      // Outer shell push.
      const shellDist = d - radius;
      const sigma2 = 2 * sigma * sigma;
      if (shellDist * shellDist < 9 * sigma2) {
        const g = Math.exp(-(shellDist * shellDist) / sigma2);
        const nx = dx / d;
        const nz = dz / d;
        const push = pushForce * g * dt;
        b2.x += nx * push;
        b2.z += nz * push;

        // Energy cost of the wave. Scaled hard so a strong
        // shock is felt — a being caught in the shell of a
        // strength-1 dash loses a lot of energy in one pass.
        b2.energy -= g * strength * 12 * dt;

        // Populate the danger field for the population's own
        // learning layer.
        if (g > 0.15) {
          Q.depositDanger(world, b2.x, b2.z, g * depositRate * dt);
        }
      }

      // Inner kill zone.
      if (killProbBase > 0 && d < radius * 0.40) {
        const killProb = killProbBase * dt;
        if (rng() < killProb) {
          const mass = Math.max(0, b2.energy);
          b2.dead = true;
          b2.energy = 0;
          recordDeath(b2, 'immortal-shock');

          // Drop a corpse so the population can scavenge the
          // remains. Preserves hue so the wave leaves a visible
          // stain in the corpse field.
          if (mass > 5) {
            const n = views.worldhdr[6];
            if (n < world.CORPSE_MAX) {
              const o = n * CORPSE_STRIDE_F32;
              views.corpse[o + 0] = b2.x;
              views.corpse[o + 1] = b2.z;
              views.corpse[o + 2] = mass;
              views.corpse[o + 3] = b2.genes.hue;
              views.corpse[o + 4] = 1;
              views.worldhdr[6] = n + 1;
            } else {
              ledger.sink += mass;
            }
          }
          // The mark on the SAB row so the renderer stops
          // instancing this being next frame.
          const base = b2.id * BEING_STRIDE_F32;
          views.beings[base + 11] = 0;
        }
      }

      // Teleport: massive inner damage, no outward push. The
      // body does not travel in a shockwave — it was never
      // there. The world simply finds a hole where it used to
      // be.
      if (type === 2 && d < radius * 0.55) {
        b2.energy -= strength * 40 * dt;
      }
    }
  }
}

function drainImmortalCommands() {
  const IO = views.immortalIO;
  if (!IO) return;
  const WH = IO[384] | 0;
  let   RH = IO[385] | 0;
  let   n  = 0;
  while (RH !== WH && n < 32) {
    const slot = RH & 31;
    const base = slot * 8;
    applyImmortalCommand(
      IO[base], IO[base+1], IO[base+2], IO[base+3],
      IO[base+4], IO[base+5], IO[base+6], IO[base+7]
    );
    RH = (RH + 1) & 0xFFFF;
    n++;
  }
  IO[385] = RH;
}

function writeImmortalStats() {
  const IO = views.immortalIO;
  if (!IO) return;
  let alive = 0, eSum = 0, aSum = 0, fOn = 0;
  let vSum = 0, mSum = 0, fusedSum = 0;
  let spdSum = 0, snsSum = 0, szSum = 0, lsSum = 0, rcSum = 0;
  let cplSum = 0, plastSum = 0, childSum = 0;
  let maxE = 0;
  const census = [0, 0, 0, 0];
  const energies = [];
  for (const b of coldState.values()) {
    if (b.dead) continue;
    alive++;
    eSum += b.energy;
    aSum += b.age;
    if (b.genes.fusionEnabled) fOn++;
    const lid = b.genes.lineageId ?? 0;
    if (lid >= 0 && lid < 4) census[lid]++;
    vSum    += b._valence ?? 0;
    mSum    += b._stateMag ?? 0;
    fusedSum += b._fusedSelf ?? 0;
    spdSum  += b.genes.speed;
    snsSum  += b.genes.sense;
    szSum   += b.genes.size;
    lsSum   += b.genes.lifespan;
    rcSum   += b.genes.repCost;
    cplSum  += b._effCoupling ?? b.genes.stateCoupling;
    plastSum += b.genes.statePlasticity;
    childSum += b._childCount || 0;
    if (b.energy > maxE) maxE = b.energy;
    if (energies.length < 1000) energies.push(b.energy);
  }
  energies.sort((x, y) => y - x);
  const topN = Math.max(1, Math.floor(energies.length * 0.10));
  let top10Sum = 0;
  for (let i = 0; i < topN; i++) top10Sum += energies[i];

  IO[256] = simTime;
  IO[257] = alive;
  IO[258] = views.worldhdr[5];
  IO[259] = views.worldhdr[6];
  IO[260] = views.worldhdr[2];
  IO[261] = alive > 0 ? eSum / alive : 0;
  IO[262] = alive > 0 ? aSum / alive : 0;
  IO[263] = alive > 0 ? fOn / alive : 0;
  IO[264] = census[0];
  IO[265] = census[1];
  IO[266] = census[2];
  IO[267] = census[3];
  IO[268] = tickCount;
  IO[269] = globalThis.worker_metrics.births || 0;
  IO[270] = Object.values(globalThis.worker_metrics.deaths || {})
              .reduce((s, x) => s + x, 0);
  IO[271] = alive > 0 ? vSum / alive : 0;
  IO[272] = alive > 0 ? mSum / alive : 0;
  IO[273] = alive > 0 ? fusedSum / alive : 0;
  IO[274] = currentPhase;
  IO[275] = elites.filter(e => e).length;
  IO[276] = noveltyArchive.length;
  IO[277] = alive > 0 ? spdSum / alive : 0;
  IO[278] = alive > 0 ? snsSum / alive : 0;
  IO[279] = alive > 0 ? szSum / alive : 0;
  IO[280] = alive > 0 ? lsSum / alive : 0;
  IO[281] = alive > 0 ? rcSum / alive : 0;
  IO[282] = alive > 0 ? cplSum / alive : 0;
  IO[283] = alive > 0 ? plastSum / alive : 0;
  IO[284] = Math.max(0, energies.length - topN);
  IO[285] = top10Sum / topN;
  IO[286] = maxE;
  IO[287] = alive > 0 ? childSum / alive : 0;

  // ── Step 8: perception block ───────────────────────────────
  const histE = new Float32Array(16);
  const histV = new Float32Array(8);
  const arch  = new Float32Array(8);
  const geneS = new Float32Array(6);
  const geneQ = new Float32Array(6);
  for (const b of coldState.values()) {
    if (b.dead) continue;
    histE[Math.min(15, Math.floor(b.energy / 25))]++;
    histV[Math.min(7, Math.max(0, Math.floor((b._valence + 1) * 4)))]++;
    let a = 0;
    const p = b.program;
    for (let i = 0; i < 128; i++) {
      const op = p[i];
      if      (op === 0x0E || op === 0x13) { a |= 1;   }
      else if (op === 0x23 || op === 0x30) { a |= 2;   }
      else if (op === 0x1B || op === 0x1E) { a |= 4;   }
      else if (op === 0x22)                { a |= 8;   }
      else if (op === 0x0F)                { a |= 16;  }
      else if (op === 0x67)                { a |= 32;  }
      else if (op === 0x60 || op === 0x61) { a |= 128; }
    }
    if      (a & 2)   arch[0]++;
    else if (a & 4)   arch[1]++;
    else if (a & 8)   arch[2]++;
    else if (a & 128) arch[3]++;
    else if (a & 1)   arch[4]++;
    else if (a & 16)  arch[5]++;
    else if (a & 32)  arch[6]++;
    else              arch[7]++;
    geneS[0] += b.genes.speed;      geneQ[0] += b.genes.speed ** 2;
    geneS[1] += b.genes.sense;      geneQ[1] += b.genes.sense ** 2;
    geneS[2] += b.genes.size;       geneQ[2] += b.genes.size ** 2;
    geneS[3] += b.genes.metabolism; geneQ[3] += b.genes.metabolism ** 2;
    geneS[4] += b.genes.lifespan;   geneQ[4] += b.genes.lifespan ** 2;
    geneS[5] += b.genes.repCost;    geneQ[5] += b.genes.repCost ** 2;
  }
  const PB = IIO_PERCEPTION_BASE;
  const N = Math.max(1, alive);
  for (let i = 0; i < 16; i++) IO[PB + i] = histE[i] / N;
  for (let i = 0; i < 8;  i++) IO[PB + 16 + i] = histV[i] / N;
  for (let i = 0; i < 4;  i++) IO[PB + 24 + i] = IO[264 + i] / N;
  for (let i = 0; i < 8;  i++) IO[PB + 28 + i] = arch[i] / N;
  for (let i = 0; i < 6;  i++) {
    const m = geneS[i] / N;
    const v = Math.max(0, geneQ[i] / N - m * m);
    IO[PB + 36 + i * 2]     = m;
    IO[PB + 36 + i * 2 + 1] = Math.sqrt(v);
  }
  if (tickCount % 20 === 0) {
    for (let i = 14; i >= 0; i--) IO[PB + 80 + i + 1] = IO[PB + 80 + i];
    for (let i = 14; i >= 0; i--) IO[PB + 96 + i + 1] = IO[PB + 96 + i];
    IO[PB + 80] = IO[261];
    IO[PB + 96] = IO[271];
  }
}

/* ── lifecycle: food / corpse / struct / field ────────────────────── */

function tickFood(dt) {
  const F = views.food;
  const n = views.worldhdr[5];
  const inc = dt / FOOD_GROWTH_TIME;
  let live = 0;

  for (let i = 0; i < n; i++) {
    const o = i * FOOD_STRIDE_F32;
    if (F[o + 5] === 0) continue;
    live++;
    F[o + 3] += dt;
    if (F[o + 2] < 1) {
      const before = F[o + 2];
      F[o + 2] = Math.min(1, F[o + 2] + inc);
      ledger.source += (F[o + 2] - before) * PLANT_FULL_ENERGY;
    }
    if (F[o + 3] > F[o + 4]) {
      F[o + 5] = 0;
      ledger.sink += F[o + 2] * PLANT_FULL_ENERGY;
    }
  }

  // The `live` counter walks the array from 0 to worldhdr[5].
  // If worldhdr[5] has been capped at FOOD_MAX and no compaction
  // has run since, live can hit FOOD_MAX while dead slots exist
  // below. The array-level cap is what should gate spawning, not
  // the live count. Remove the guard.
  // if (live >= FOOD_MAX) return;
  const deficit = world.FOOD_MAX - live;
  const chance = 0.45 + (deficit / world.FOOD_MAX) * 0.50;
  if (rng() >= chance) return;
  const count = 1 + Math.floor(deficit / 300);

  for (let k = 0; k < count; k++){
    const idx = views.worldhdr[5];
    if (idx >= world.FOOD_MAX) break;
    const f = _spawnFoodInPatch();
    if (!f) continue;
    const patch = f._patch;
    if (patch >= 0 && rng() > (views.patch[patch * PATCH_STRIDE_F32 + 7] ?? 1.0) / 1.6){
      // Rolled a dead patch — discard this attempt.
      const o = (idx) * FOOD_STRIDE_F32;
      for (let s = 0; s < FOOD_STRIDE_F32; s++) views.food[o + s] = 0;
      continue;
    }
  }
}   // ← this closing brace is the one that was missing

function tickCorpses(dt) {
  const C = views.corpse;
  const n = views.worldhdr[6];
  const d = CORPSE_DECOMPOSE_RATE * dt;
  for (let i = 0; i < n; i++) {
    const o = i * CORPSE_STRIDE_F32;
    if (C[o + 4] === 0) continue;
    C[o + 3] += dt;
    const take = Math.min(C[o + 2], d);
    C[o + 2] -= take;
    ledger.sink += take;
    if (C[o + 2] < 1) {
      ledger.sink += C[o + 2];
      C[o + 2] = 0;
      C[o + 4] = 0;
    }
  }
}

function tickStructures(dt) {
  const S = views.struct;
  const n = views.worldhdr[2];
  const d = STRUCTURE_DECAY_PER_S * dt;
  for (let i = 0; i < n; i++) {
    const o = i * STRUCT_STRIDE_F32;
    if (S[o + 2] <= 0) continue;
    const before = S[o + 2];
    S[o + 2] = Math.max(0, before - d);
    ledger.sink += (before - S[o + 2]) * STRUCTURE_BUILD_COST;
  }
}

function tickField(dt) {
  fieldTimer += dt;
  if (fieldTimer < 1.0) return;
  fieldTimer -= 1.0;
  const F = views.fieldF, D = views.fieldD, C = views.fieldC;
  for (let i = 0; i < GRID_CELLS; i++) {
    F[i] *= FIELD_DECAY;
    D[i] *= FIELD_DECAY;
    C[i] *= FIELD_DECAY;
  }
}

/* ── compaction ───────────────────────────────────────────────────── */

function compactFood() {
  const F = views.food;
  // Walk the FULL physical array, not worldhdr[5]. If the bound ever
  // falls below the highest-index used slot, walking to the bound
  // hides living food permanently. The bound is derived by this
  // function, not trusted as input.
  const n = world.FOOD_MAX;
  let w = 0;
  for (let r = 0; r < n; r++) {
    const ro = r * FOOD_STRIDE_F32;
    if (F[ro + 5] === 0) continue;
    if (w !== r) {
      const wo = w * FOOD_STRIDE_F32;
      for (let k = 0; k < FOOD_STRIDE_F32; k++) F[wo + k] = F[ro + k];
    }
    w++;
  }
  for (let i = w; i < n; i++) {
    const o = i * FOOD_STRIDE_F32;
    for (let k = 0; k < FOOD_STRIDE_F32; k++) F[o + k] = 0;
  }
  views.worldhdr[5] = w;
}

function compactCorpses() {
  const C = views.corpse;
  const n = views.worldhdr[6];
  let w = 0;
  for (let r = 0; r < n; r++) {
    const ro = r * CORPSE_STRIDE_F32;
    if (C[ro + 4] === 0) continue;
    if (w !== r) {
      const wo = w * CORPSE_STRIDE_F32;
      for (let k = 0; k < CORPSE_STRIDE_F32; k++) C[wo + k] = C[ro + k];
    }
    w++;
  }
  for (let i = w; i < n; i++) {
    const o = i * CORPSE_STRIDE_F32;
    for (let k = 0; k < CORPSE_STRIDE_F32; k++) C[o + k] = 0;
  }
  views.worldhdr[6] = w;
}

function compactStructures() {
  const S = views.struct;
  const n = views.worldhdr[2];
  let w = 0;
  for (let r = 0; r < n; r++) {
    const ro = r * STRUCT_STRIDE_F32;
    if (S[ro + 2] <= 0) continue;
    if (w !== r) {
      const wo = w * STRUCT_STRIDE_F32;
      for (let k = 0; k < STRUCT_STRIDE_F32; k++) S[wo + k] = S[ro + k];
      const dSrc = r * STRUCT_DATA_SIZE, dDst = w * STRUCT_DATA_SIZE;
      for (let k = 0; k < STRUCT_DATA_SIZE; k++)
        views.structData[dDst + k] = views.structData[dSrc + k];
      const pSrc = r * STRUCT_PROG_SIZE, pDst = w * STRUCT_PROG_SIZE;
      views.structProg.copyWithin(pDst, pSrc, pSrc + STRUCT_PROG_SIZE);
    }
    w++;
  }
  for (let i = w; i < n; i++) {
    const o = i * STRUCT_STRIDE_F32;
    for (let k = 0; k < STRUCT_STRIDE_F32; k++) S[o + k] = 0;
    const dBase = i * STRUCT_DATA_SIZE;
    for (let k = 0; k < STRUCT_DATA_SIZE; k++) views.structData[dBase + k] = 0;
    const pBase = i * STRUCT_PROG_SIZE;
    views.structProg.fill(0, pBase, pBase + STRUCT_PROG_SIZE);
  }
  views.worldhdr[2] = w;
}

/* ── ledger ───────────────────────────────────────────────────────── */

function computeStored() {
  let total = 0;
  for (const b of coldState.values()) if (!b.dead) total += b.energy;

  const F = views.food, fn = views.worldhdr[5];
  for (let i = 0; i < fn; i++) {
    const o = i * FOOD_STRIDE_F32;
    if (F[o + 5] === 0) continue;
    total += F[o + 2] * PLANT_FULL_ENERGY;
  }

  const C = views.corpse, cn = views.worldhdr[6];
  for (let i = 0; i < cn; i++) {
    const o = i * CORPSE_STRIDE_F32;
    if (C[o + 4] === 0) continue;
    total += C[o + 2];
  }

  const S = views.struct, sn = views.worldhdr[2];
  for (let i = 0; i < sn; i++) {
    const o = i * STRUCT_STRIDE_F32;
    if (S[o + 2] <= 0) continue;
    total += 15 * S[o + 2];
  }

  return total;
}

function verifyLedger() {
  const stored = computeStored();
  const expected = ledger.initial + ledger.source - ledger.sink;
  const diff = stored - expected;
  if (Math.abs(diff) > 1.0) {
    self.postMessage({ type: 'ledger',
      msg: `MISMATCH T+${Math.floor(simTime)}: expected ${expected.toFixed(2)}, stored ${stored.toFixed(2)}, diff ${diff.toFixed(2)}` });
  } else if (Math.floor(simTime) % 5000 === 0) {
    self.postMessage({ type: 'ledger',
      msg: `balanced T+${Math.floor(simTime)}: stored=${stored.toFixed(2)}` });
  }
}

/* ── being construction ───────────────────────────────────────────── */

function makeBeing(spec) {
  const genes = spec.genes ?? makeGenes(rng, spec.lineageId ?? 0);
  if (spec.size !== undefined) genes.size = spec.size;

  const program = spec.program ?? BeingVM.makeSeed(spec.seedName, rng);
  const data    = spec.data    ?? new Int8Array(BeingVM.DATA_SIZE);

  if (rng && spec.program === undefined) {
    for (let i = 0; i < BeingVM.DATA_SIZE; i++) {
      if (rng() < 0.5) data[i] = ((rng() * 100) | 0) - 50;
    }
  }

  const usesWorldModel = programUsesWorldModel(program);

  const state     = new Float32Array(STATE_SIZE);
  const statePrev = new Float32Array(STATE_SIZE);

  return {
    id: spec.id,
    x: spec.x, z: spec.z,
    energy: spec.energy,
    age: spec.age ?? 0,
    dead: false,
    program, genes, data,
    stack:    new Int16Array(BeingVM.STACK_MAX),
    retStack: new Int16Array(BeingVM.RET_STACK_MAX),
    pc: 0, sp: 0, rsp: 0,
    lastDirX: 1, lastDirZ: 0,
    state, _statePrev: statePrev,
    symbionts: [], _maxSymbionts: 3,
    _stateMag: 0,
    _stateAge: 0,
    _arousalRef: undefined,
    _socialCacheTime: -1e9, _socialCache: 0,
    _foodCacheTime: -1e9, _foodCache: null, _foodCacheValid: false,
    _neighborCacheTime: -1e9, _neighborCache: null, _neighborCacheValid: false,
    _dangerCacheTime: -1e9, _dangerCache: null, _dangerCacheValid: false,
    _corpseCacheTime: -1e9, _corpseCache: null, _corpseCacheValid: false,
    _foodNoiseX: 0, _foodNoiseZ: 0, _dangerNoiseX: 0, _dangerNoiseZ: 0,
    _opUse: new Uint16Array(256),
    _lastAction: 0,
    _selfTrace: 0, _selfTraceVar: 0, _selfTraceAge: 0,
    _otherFused: 0, _g2: 0,
    _valence: 0,
    _kappaEMA: 0.3,
    _predictedFused: 0, _predError: 0, _predBias: 0,
    _predWeights: new Float32Array(STATE_SIZE),
    _corrSum: new Float32Array(STATE_SIZE),
    _varS:    new Float32Array(STATE_SIZE),
    _varF: 0, _corrWindow: 0, _rhoEMA: 0.5, _fusedPrev: 0,
    _fusedSelf: 0, _fusionValid: false,
    _effDecay:    genes.stateDecay,
    _effCoupling: genes.stateCoupling,
    _effInput:    genes.stateInput,
    _effDecayWorking:  0.01,
    _effDecayIdentity: 0.0005,
    _lastPlasticityEnergy: spec.energy,
    _plasticityTimer: 0,
    _corrCoupling: 0, _corrDecay: 0, _corrInput: 0,
    _episodic: {
      states:  new Float32Array(BeingVM.EPISODE_LEN * STATE_SIZE),
      actions: new Uint8Array(BeingVM.EPISODE_LEN),
      rewards: new Float32Array(BeingVM.EPISODE_LEN),
      head: 0, len: 0,
    },
    _episodicPrevEnergy: spec.energy,
    _actionValues: new Float32Array(256),
    _usesPredation: programUsesPredation(program) ? 1 : 0,
    _usesWorldModel: usesWorldModel,
    _worldModel: usesWorldModel ? {
      W: new Float32Array(STATE_SIZE * STATE_SIZE),
      W_action: new Float32Array(STATE_SIZE * 256),
      bias: 0, predictedFused: 0, predictionError: 0,
    } : null,
    _childCount: 0,
    _assimilationCount: 0,
    _paretoRank: 999,
    _pendingChild: null,
    _pendingNewborn: null,
    _parentId: spec.parentId ?? -1,
    _birthTick: tickCount,
    _phyloIdx: undefined,
    _heritage: [],   // list of programs absorbed; used at death for succession
    _mlpW1: (() => { const a = new Float32Array(32 * 16); for (let i = 0; i < a.length; i++) a[i] = (rng() - 0.5) * 0.5; return a; })(),
    _mlpB1: new Float32Array(16),
    _mlpW2: (() => { const a = new Float32Array(16); for (let i = 0; i < a.length; i++) a[i] = (rng() - 0.5) * 0.5; return a; })(),
    _mlpB2: 0,
    form: new Float32Array([
      genes.formColor,
      genes.formCadence
    ]),
  };
}

function programUsesWorldModel(prog) {
  for (let i = 0; i < BeingVM.LEN_MAX; i++) {
    const op = prog[i];
    if (op === BeingVM.OP.PREDICT_WORLD ||
        op === BeingVM.OP.WORLD_ERROR   ||
        op === BeingVM.OP.IMAGINE) return true;
    if (op === 0 && i > 8 && prog[i - 1] === 0) break;
  }
  return false;
}

function makeGenes(rng, lineageId = 0) {
  const g = {
    speed:      0.8 + rng() * 0.6,
    sense:      200 + rng() * 300,
    size:       1.5 + rng() * 1.5,
    lineageId,
    hue:        lineageHue(lineageId, rng),
    metabolism: 0.9 + rng() * 0.5,
    lifespan:   140 + rng() * 100,
    matAge:     15 + rng() * 10,
    repCost:    30 + rng() * 15,
    stateDecay:    0.02 + rng() * 0.78,
    stateCoupling: 0.05 + rng() * 1.45,
    stateInput:    0.5  + rng() * 1.5,
    statePlasticity: rng() * 5.0,
    plasticityRule: new Float32Array(3),
    fusionEnabled:  rng() < 0.75 ? 1 : 0,
    fusionStrength: 0.15 + rng() * 0.85,
    fusionSeed:     rng(),
    fusionDepth:    1 + Math.floor(rng() * 3),
    fusionAttn:     new Float32Array(STATE_SIZE),
    fusionBias:     (rng() - 0.5) * 0.4,
    formColor:   rng() * 2 - 1,       // -1..1 hue shift
    formCadence: 0.6 + rng() * 0.8,   // 0.6..1.4 flash rate
  };
  for (let i = 0; i < 3; i++) g.plasticityRule[i] = 0.5 + rng() * 2.0;
  for (let i = 0; i < STATE_SIZE; i++) g.fusionAttn[i] = 0.4 + rng() * 1.6;
  // ── Shape genome ────────────────────────────────────────────────
  // 16 floats, one per body parameter. Mutates with the program.
  g.shapeParams = new Float32Array(16);
  g.shapeParams[0]  = 0.55 + rng() * 0.55;   // coreRadius
  g.shapeParams[1]  = rng() * 0.55;          // coreSquash
  g.shapeParams[2]  = 0.08 + rng() * 0.30;   // noiseAmp
  g.shapeParams[3]  = 2.0  + rng() * 5.0;    // noiseFreq
  g.shapeParams[4]  = 0.70 + rng() * 0.90;   // spineLen
  g.shapeParams[5]  = rng() * 0.45;          // spineBend
  g.shapeParams[6]  = rng();                 // spineTwist
  g.shapeParams[7]  = 0.30 + rng() * 0.60;   // neckLen
  g.shapeParams[8]  = 0.35 + rng() * 0.65;   // ribbonCount
  g.shapeParams[9]  = 0.85 + rng() * 0.55;   // ribbonR
  g.shapeParams[10] = 0.06 + rng() * 0.18;   // ribbonW
  g.shapeParams[11] = rng();                 // ribbonFlap
  g.shapeParams[12] = 0.35 + rng() * 0.65;   // armCount
  g.shapeParams[13] = 0.70 + rng() * 0.90;   // armLen
  g.shapeParams[14] = rng() * 0.75;          // armCurve
  g.shapeParams[15] = 0.40 + rng() * 0.55;   // armTaper

  return g;
}


function mutateGenes(g, rng) {
  const m  = (v, k) => Math.max(0.05, Math.min(1e6, v * Math.exp((rng() - 0.5) * k)));
  const mS = (v, k, lo, hi) => Math.max(lo, Math.min(hi, v * Math.exp((rng() - 0.5) * k)));

  // Lineage branch: rare. 0.4% per birth. When it fires, the child
  // belongs to a uniformly random different lineage, taking a
  // distinct hue with it. Most births inherit.
  let lineageId = g.lineageId ?? 0;
  if (rng() < 0.004){
    lineageId = (lineageId + 1 + ((rng() * (LINEAGE_COUNT - 1)) | 0)) % LINEAGE_COUNT;
  }

  const newG = {
    speed:      m(g.speed, 0.20),
    sense:      m(g.sense, 0.20),
    size:       m(g.size, 0.15),
    lineageId,
    hue:        lineageHue(lineageId, rng),
    metabolism: m(g.metabolism, 0.15),
    lifespan:   m(g.lifespan, 0.15),
    matAge:     m(g.matAge, 0.15),
    repCost:    m(g.repCost, 0.15),
    stateDecay:      mS(g.stateDecay,    0.25, 0.02, 1.5),
    stateCoupling:   mS(g.stateCoupling, 0.25, 0.05, 3.0),
    stateInput:      mS(g.stateInput,    0.25, 0.50, 3.0),
    statePlasticity: mS(g.statePlasticity, 0.25, 0.00, 5.0),
    fusionEnabled:   rng() < 0.02 ? (g.fusionEnabled ? 0 : 1) : g.fusionEnabled,
    fusionStrength:  mS(g.fusionStrength, 0.20, 0.05, 1.50),
    fusionSeed:      (g.fusionSeed + (rng() - 0.5) * 0.2 + 1) % 1,
    fusionDepth:     Math.max(1, Math.min(4, Math.round(g.fusionDepth + (rng() - 0.5) * 0.8))),
    fusionAttn:      new Float32Array(STATE_SIZE),
    fusionBias:      Math.max(-1, Math.min(1, (g.fusionBias ?? 0) + (rng() - 0.5) * 0.10)),
    formColor:    Math.max(-1, Math.min(1, (g.formColor   ?? 0)   + (rng() - 0.5) * 0.15)),
    formCadence:  Math.max(0.4, Math.min(2.0, (g.formCadence ?? 1.0) * Math.exp((rng() - 0.5) * 0.15))),
    plasticityRule:  new Float32Array(3),
  };
  for (let i = 0; i < STATE_SIZE; i++) {
    const base = g.fusionAttn ? g.fusionAttn[i] : 1.0;
    newG.fusionAttn[i] = Math.max(0.05, Math.min(4.0, base * Math.exp((rng() - 0.5) * 0.30)));
  }
  const src = g.plasticityRule || new Float32Array([1, 1, 1]);
  for (let i = 0; i < 3; i++) {
    newG.plasticityRule[i] = Math.max(0.1, Math.min(5.0, src[i] * Math.exp((rng() - 0.5) * 0.25)));
  }
  // ── Shape genome mutation ───────────────────────────────────────
  // Log-normal drift per parameter. A rare saltation event (0.5%
  // of births) shifts one parameter by a large step.
  const srcShape = g.shapeParams || new Float32Array(16);
  newG.shapeParams = new Float32Array(16);
  const saltate = rng() < 0.005;
  for (let i = 0; i < 16; i++) {
    const k = 0.10 + (i % 3) * 0.05;
    newG.shapeParams[i] = Math.max(0.01,
      Math.min(2.5, srcShape[i] * Math.exp((rng() - 0.5) * k)));
  }
  if (saltate) {
    const j = (rng() * 16) | 0;
    newG.shapeParams[j] = Math.max(0.01,
      Math.min(2.5, newG.shapeParams[j] * (0.5 + rng() * 2.0)));
  }

  return newG;
}

function mutateMLP(parent, child) {
  for (let i = 0; i < parent._mlpW1.length; i++) {
    child._mlpW1[i] = Math.max(-2, Math.min(2,
      parent._mlpW1[i] + (rng() - 0.5) * 0.05));
  }
  for (let i = 0; i < parent._mlpB1.length; i++) {
    child._mlpB1[i] = parent._mlpB1[i] + (rng() - 0.5) * 0.05;
  }
  for (let i = 0; i < parent._mlpW2.length; i++) {
    child._mlpW2[i] = Math.max(-2, Math.min(2,
      parent._mlpW2[i] + (rng() - 0.5) * 0.05));
  }
  child._mlpB2 = parent._mlpB2 + (rng() - 0.5) * 0.05;
}

function allocId() {
  for (let i = 0; i < world.MAX_BEINGS; i++) {
    const id = (idCursor + i) % world.MAX_BEINGS;
    if (!coldState.has(id)) {
      idCursor = (id + 1) % MAX_BEINGS;
      return id;
    }
  }
  return -1;
}

function spawnChild(parent, startEnergy) {
  if (allIds.length >= world.MAX_BEINGS) return;
  const id = allocId();
  if (id < 0) return;
  globalThis.worker_metrics.births++;

  const genes   = mutateGenes(parent.genes, rng);
  const program = rng() < 0.5
    ? BeingVM.mutateProgram(parent.program, rng, true)
    : parent.program.slice();

  const data = new Int8Array(BeingVM.DATA_SIZE);
  data.set(parent.data);

  const a = rng() * Math.PI * 2;
  const x = clampPlane(parent.x + Math.cos(a) * 30);
  const z = clampPlane(parent.z + Math.sin(a) * 30);

  const child = makeBeing({ id, x, z, energy: startEnergy, genes, program, data });
  child._usesWorldModel = programUsesWorldModel(program);
  mutateMLP(parent, child);
  if (child._usesWorldModel && !child._worldModel) {
    child._worldModel = {
      W: new Float32Array(STATE_SIZE * STATE_SIZE),
      W_action: new Float32Array(STATE_SIZE * 256),
      bias: 0, predictedFused: 0, predictionError: 0,
    };
  }

  // Inherit a fraction of the parent's state
  const retain = 0.55 + genes.stateCoupling * 0.35;
  for (let i = 0; i < STATE_SIZE; i++) {
    child.state[i] = parent.state[i] * retain + (rng() - 0.5) * 0.4;
  }
  child._statePrev.set(child.state);

  child._parentId = parent.id;
  coldState.set(id, child);
  allIds.push(id);
  recordBirth(child);
  registerNovelty(child);
  parent._childCount = (parent._childCount || 0) + 1;

  // Offspring inherit the host's assimilation count, halved.
  // The child of a four-times-merged parent starts with two
  // absorptions' worth of heritage already folded in.
  child._assimilationCount = Math.floor((parent._assimilationCount || 0) / 2);
  child._heritage = (parent._heritage || []).slice(0, 8);
}

function releaseSymbiont(host, sym) {
  if (allIds.length >= world.MAX_BEINGS) return;
  const id = allocId();
  if (id < 0) return;
  const a = rng() * Math.PI * 2;
  const x = clampPlane(host.x + Math.cos(a) * 30);
  const z = clampPlane(host.z + Math.sin(a) * 30);
  const childEnergy = Math.max(20, host.energy * 0.15);
  const child = makeBeing({
    id, x, z,
    energy: childEnergy,
    genes: mutateGenes(sym.genes, rng),
    program: sym.program.slice(),
    data: new Int8Array(sym.data),
  });
  child._usesWorldModel = programUsesWorldModel(child.program);
  if (child._usesWorldModel && !child._worldModel) {
    child._worldModel = {
      W: new Float32Array(STATE_SIZE * STATE_SIZE),
      W_action: new Float32Array(STATE_SIZE * 256),
      bias: 0, predictedFused: 0, predictionError: 0,
    };
  }
  host.energy -= childEnergy;
  coldState.set(id, child);
  allIds.push(id);
  child._parentId = host.id;
  recordBirth(child);
  host._childCount = (host._childCount || 0) + 1;
}


function clampPlane(v) { return Math.max(-PLANE, Math.min(PLANE, v)); }

function _biomeFertility(x, z){
  // High-fertility bands run diagonally; danger tracks ridges.
  // Uses a pure trig function so it's identical in worker and
  // renderer (no dependency on the renderer's noise state).
  const n = Math.sin(x * 0.00007 + 3.1) * Math.cos(z * 0.00009 + 7.7);
  return 0.5 + 0.5 * n;
}

function initPatches(){
  const P = views.patch;
  const TYPES = [0, 1, 2];  // 0 sparse_safe, 1 dense_dangerous, 2 drifting
  views.worldhdr[3] = 0;
  for (let i = 0; i < 16; i++){
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * PLANE * 0.72;
    const type = TYPES[(rng() * TYPES.length) | 0];
    const o = i * PATCH_STRIDE_F32;
    P[o + 0] = Math.cos(a) * r;
    P[o + 1] = Math.sin(a) * r;
    P[o + 2] = 0;
    P[o + 3] = 0;
    P[o + 4] = 1.0;                                  // richness
    P[o + 5] = type;
    P[o + 6] = type === 1 ? 0.6 : type === 0 ? 1.6 : 1.0;   // sigmaScale
    P[o + 7] = type === 1 ? 1.6 : type === 0 ? 0.4 : 1.0;   // spawnWeight
    views.worldhdr[3] = i + 1;
  }
}


function _spawnFoodInPatch(){
  const n = views.worldhdr[3];
  if (n === 0) return null;
  let idx = views.worldhdr[5];
  if (idx >= world.FOOD_MAX){
    // Reclaim a dead slot. Without this, when the high-water mark
    // reaches FOOD_MAX the spawner returns null forever, and once
    // the food supply drops to zero the population cannot recover.
    idx = -1;
    for (let i = 0; i < world.FOOD_MAX; i++){
      if (views.food[i * FOOD_STRIDE_F32 + 5] === 0){ idx = i; break; }
    }
    if (idx < 0) return null;
  } else {
    views.worldhdr[5] = idx + 1;
  }
  const P = views.patch;
  const p = (rng() * n) | 0;
  const base = p * PATCH_STRIDE_F32;
  const px = P[base + 0], pz = P[base + 1];
  const sigmaScale = P[base + 6];
  // Local fertility modulates how tightly food clusters around
  // the patch center. Rich biomes concentrate; poor biomes scatter.
  const fertility = 0.7 + 0.6 * _biomeFertility(px, pz);
  const sigma = 700 * sigmaScale * fertility;

  // Box-Muller
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const mag = Math.sqrt(-2 * Math.log(u1));
  const th  = u2 * Math.PI * 2;
  const x = px + mag * Math.cos(th) * sigma;
  const z = pz + mag * Math.sin(th) * sigma;
  if (x*x + z*z > PLANE * PLANE) return null;

  const o = idx * FOOD_STRIDE_F32;
  views.food[o + 0] = x;
  views.food[o + 1] = z;
  views.food[o + 2] = 0;
  views.food[o + 3] = 0;
  views.food[o + 4] = 300 + rng() * 400;
  views.food[o + 5] = 1;
  return { _patch: p, x, z, _slot: idx };
}


function _driftPatches(h){
  const P = views.patch;
  const n = views.worldhdr[3];
  const maxR = PLANE * 0.78;
  for (let i = 0; i < n; i++){
    const o = i * PATCH_STRIDE_F32;
    const type = P[o + 5] | 0;
    const driftScale = type === 0 ? 0.3 : type === 1 ? 0.5 : 4.0;
    const drift = 0.8 * driftScale;
    if (P[o + 2] === 0 && P[o + 3] === 0 && rng() < 0.01){
      const a = rng() * Math.PI * 2;
      P[o + 2] = Math.cos(a) * drift;
      P[o + 3] = Math.sin(a) * drift;
    }
    P[o + 0] += P[o + 2] * h;
    P[o + 1] += P[o + 3] * h;
    const r2 = P[o + 0] * P[o + 0] + P[o + 1] * P[o + 1];
    if (r2 > maxR * maxR){
      const d = Math.sqrt(r2) || 1;
      P[o + 0] = P[o + 0] / d * maxR;
      P[o + 1] = P[o + 1] / d * maxR;
      const a = Math.atan2(-P[o + 1], -P[o + 0]) + (rng() - 0.5);
      P[o + 2] = Math.cos(a) * drift;
      P[o + 3] = Math.sin(a) * drift;
    }
    // Dangerous patches leak danger continuously.
    if (type === 1) Q.depositDanger(world, P[o + 0], P[o + 1], 0.2 * h);
  }
}