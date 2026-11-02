// src/sim/master.js
import {
  allocate, MAX_BEINGS, BEING_STRIDE_F32,
  SHAPE_STRIDE_F32, STATEVIS_STRIDE_F32,
  FOOD_MAX, FOOD_STRIDE_F32,
  CORPSE_MAX, CORPSE_STRIDE_F32,
  STRUCT_MAX, STRUCT_STRIDE_F32,
  STRUCT_DATA_SIZE, STRUCT_PROG_SIZE,
  PATCH_MAX, PATCH_STRIDE_F32,
  DEPOSIT_MAX, DEPOSIT_STRIDE_F32,
  FLUID_CELLS, REQUEST_MAX, REQUEST_STRIDE_F32,
  GRID,
} from './shared-buffer.js';

// Rebuild views over an existing SAB without reallocating. Used by
// _rebind. Takes a fresh SAB and the same offsets structure that
// allocate() produced; returns typed arrays over it.
function _allocate(sab, offsets, cfg) {
  const c = cfg || { beings: MAX_BEINGS, food: FOOD_MAX,
                     corpse: CORPSE_MAX, struct: STRUCT_MAX, grid: GRID };
  const G2 = c.grid * c.grid;
  const view = (key, Type, len) => new Type(sab, offsets[key], len);
  return {
    beings:    view('beings',    Float32Array, c.beings  * BEING_STRIDE_F32),
    shape:     view('shape',     Float32Array, c.beings  * SHAPE_STRIDE_F32),
    stateVis:  view('stateVis',  Float32Array, c.beings  * STATEVIS_STRIDE_F32),
    fluid:     view('fluid',     Float32Array, FLUID_CELLS * 5),
    dephdr:    view('dephdr',    Uint32Array,  2),
    deposit:   view('deposit',   Float32Array, DEPOSIT_MAX * DEPOSIT_STRIDE_F32),
    terrain:   view('terrain',   Float32Array, 512 * 512),
    food:      view('food',      Float32Array, c.food    * FOOD_STRIDE_F32),
    corpse:    view('corpse',    Float32Array, c.corpse  * CORPSE_STRIDE_F32),
    struct:    view('struct',    Float32Array, c.struct  * STRUCT_STRIDE_F32),
    patch:     view('patch',     Float32Array, PATCH_MAX * PATCH_STRIDE_F32),
    fieldF:    view('fieldF',    Float32Array, G2),
    fieldD:    view('fieldD',    Float32Array, G2),
    fieldC:    view('fieldC',    Float32Array, G2),
    reqhdr:    view('reqhdr',    Uint32Array,  2),
    request:   view('request',   Float32Array, REQUEST_MAX * REQUEST_STRIDE_F32),
    worldhdr:  view('worldhdr',  Uint32Array,  8),
    structData: view('structData', Int8Array,   c.struct * STRUCT_DATA_SIZE),
    structProg: view('structProg', Uint8Array,  c.struct * STRUCT_PROG_SIZE),
    immortalIO: view('immortalIO', Float32Array, 2048),
    deityIO:    view('deityIO',    Float32Array, 1024),
  };
}

export async function startSim(initialBeings, opts = {}) {
  const views = allocate();
  const sab   = views.sab;

  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

  let readyResolve = null;
  const readyPromise = new Promise(r => { readyResolve = r; });

  let queryCounter = 0;
  const pendingQueries = new Map();

  const handlerState = { inflight: 0 };

  worker.onerror = (e) => {
    console.error('[worker]', e.message || e, e.filename, e.lineno);
    handlerState.inflight = 0;   // unwind back-pressure so the sim can retry
  };

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') readyResolve();
    else if (m.type === 'ledger') console.log('[ledger]', m.msg);
    else if (m.type === 'stats') {
      window.__simStats = m.stats;
      if (window.World && window.World.State) {
        window.World.State.simPresent = m.stats.t;
        window.World.State.simView    = m.stats.t;
      }
    }
    else if (m.type === 'tick-done') {
      handlerState.inflight = Math.max(0, handlerState.inflight - 1);
    }
    else if (m.type === 'query-result') {
      const resolve = pendingQueries.get(m.id);
      if (resolve) {
        pendingQueries.delete(m.id);
        resolve(m.result);
      }
    }
  };

  worker.postMessage({
    type: 'init', sab, offsets: views.offsets, cfg: views.cfg,
    beings: initialBeings,
    curriculumId: opts.curriculumId || 'default-v1',
  });
  await readyPromise;

  return {
  _curriculumId: opts.curriculumId || 'default-v1',
  sab,
  offsets: views.offsets,
  worker,
  workers: [worker],

  beings:      views.beings,
  shape:       views.shape,
  stateVis:    views.stateVis,
  fluid:       views.fluid,
  deposit:     views.deposit,
  terrain:     views.terrain,
  food:        views.food,
  corpse:      views.corpse,
  struct:      views.struct,
  structData:  views.structData,
  structProg:  views.structProg,
  patch:       views.patch,
  fieldF:      views.fieldF,
  fieldD:      views.fieldD,
  fieldC:      views.fieldC,
  rreqhdr:     views.reqhdr,
  request:     views.request,
  dephdr:      views.dephdr,
  worldhdr:    views.worldhdr,
  immortalIO:  views.immortalIO,
  deityIO:     views.deityIO,

  get _inflight() { return handlerState.inflight; },
  _incInflight()  { handlerState.inflight++; },

  _paused: false,
  pause()  { this._paused = true;  },
  resume() { this._paused = false; },
  waitIdle() {
    if (handlerState.inflight === 0) return Promise.resolve();
    return new Promise(r => {
      const check = () => {
        if (handlerState.inflight === 0) r();
        else setTimeout(check, 20);
      };
      check();
    });
  },

  simTime: 0,

    query(name, args) {
      return new Promise((resolve) => {
        const id = ++queryCounter;
        pendingQueries.set(id, resolve);
        worker.postMessage({ type: 'query', id, name, args });
        setTimeout(() => {
          if (pendingQueries.has(id)) {
            pendingQueries.delete(id);
            resolve({ error: 'query timeout: ' + name });
          }
        }, 60000);
      });
    },

    save(name = 'auto'){
      return this.query('snapshot', {}).then(snap => {
        if (!snap || snap.error) return false;
        return import('./persistence.js').then(({ saveSnapshot }) =>
          saveSnapshot(name, snap));
      });
    },

    // ── _rebind. Called by the archon after a successful SAB
    //    swap. Rebuilds every exposed view to point at the new
    //    SAB. Existing closures hold a reference to `sim`; they
    //    read sim.beings, sim.food, etc. at each frame. Because
    //    those are property reads, reassigning them here is
    //    transparent to the render modules.
    _rebind(newSab, newOffsets, newCfg) {
      const fresh = _allocate(newSab, newOffsets, newCfg);
      this.sab = newSab;
      this.offsets = newOffsets;
      this.beings = fresh.beings;
      this.shape = fresh.shape;
      this.stateVis = fresh.stateVis;
      this.fluid = fresh.fluid;
      this.deposit = fresh.deposit;
      this.terrain = fresh.terrain;
      this.food = fresh.food;
      this.corpse = fresh.corpse;
      this.struct = fresh.struct;
      this.structData = fresh.structData;
      this.structProg = fresh.structProg;
      this.patch = fresh.patch;
      this.fieldF = fresh.fieldF;
      this.fieldD = fresh.fieldD;
      this.fieldC = fresh.fieldC;
      this.rreqhdr = fresh.reqhdr;
      this.request = fresh.request;
      this.dephdr = fresh.dephdr;
      this.worldhdr = fresh.worldhdr;
      this.immortalIO = fresh.immortalIO;
      this.deityIO = fresh.deityIO;
      return true;
    },
  };
}

export function tick(sim, dt, t) {
  if (dt <= 0) return;
  if (sim._paused) return;
  if (sim._inflight >= 2) return;
  sim._incInflight();
  sim.worker.postMessage({ type: 'step', dt, t });
}

import { TASK_VERSION, hashTasks } from './tasks.js';

export function dumpManifest(sim, extra = {}) {
  const m = {
    schemaVersion: 1,
    userAgent: navigator.userAgent,
    startTimeUTC: sim._startTimeUTC || new Date().toISOString(),
    seed: '0xA5C0DE5A',
    workerCount: sim.workers.length,
    maxBeings: sim.beings.length / 12,
    offsets: sim.offsets,
    curriculumId: sim._curriculumId || 'default-v1',
    taskVersion: TASK_VERSION,
    taskHash: hashTasks(),
    ...extra,
  };
  return m;
}