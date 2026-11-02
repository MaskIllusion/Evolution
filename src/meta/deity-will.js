// src/meta/deity-will.js
//
// The god's hand. Reads will declarations from the deityIO will
// slot block and applies them to the three fields (fieldD,
// fieldF, fieldC) at a location and radius.
//
// The god does not touch beings. The god does not touch food or
// corpses. The god only writes to fields — the three continuous
// substrates that every being in the world senses through its
// own nervous system. A god who writes to fields never has to
// know who is affected. He only has to know what the ground
// should say.
//
// Will slot layout (4 words, repeated DIO_WILL_SLOTS times from
// DIO_WILL_BASE):
//   [0] generation   monotonic counter; 0 = never used
//   [1] kind         0=idle 1=danger 2=food 3=custom 4=storm
//   [2] x            target world-x
//   [3] z            target world-z
//
// Strength and radius are fixed per kind. The god's will is not
// a numeric tuning problem; it is a decision about *what* and
// *where*. The magnitudes are the world's business.

import {
  DIO_WILL_BASE, DIO_WILL_SLOTS,
  GRID, GRID_CELLS,
} from '../sim/shared-buffer.js';

const WILL_KIND = Object.freeze({
  IDLE:   0,
  DANGER: 1,
  FOOD:   2,
  CUSTOM: 3,
  STORM:  4,
});

const KIND_PARAMS = Object.freeze({
  1: { radius: 900,  danger: 15, food: 0,  custom: 0  },
  2: { radius: 1200, danger: 0,  food: 12, custom: 0  },
  3: { radius: 1000, danger: 0,  food: 0,  custom: 10 },
  4: { radius: 2500, danger: 15, food: 10, custom: 10 },
});

export function register(World, Engine, sim) {
  console.log('[deity-will] register v1 · the hand');

  const IO = sim.deityIO;
  const fieldD = sim.fieldD;
  const fieldF = sim.fieldF;
  const fieldC = sim.fieldC;

  const PLANE = 50000;
  // Clamp field writes so the god can never blow up the substrate.
  const FIELD_MAX = 20;

  // The last generation applied per slot. When the presence
  // driver writes a new generation into a slot, we detect the
  // change and apply once. This makes a will a one-shot command,
  // not a state. The field decays on its own timescale.
  const lastGen = new Int32Array(DIO_WILL_SLOTS);
  // When we need to check a slot, we walk all DIO_WILL_SLOTS slots
  // each frame. Slot count is 8, so this is trivially cheap.

  function applyWill(kind, x, z) {
    const params = KIND_PARAMS[kind];
    if (!params) return;

    // Convert world (x, z) to grid cell range.
    const cellSize = PLANE * 2 / GRID;
    const cx = Math.floor((x / PLANE * 0.5 + 0.5) * GRID);
    const cy = Math.floor((z / PLANE * 0.5 + 0.5) * GRID);
    const R  = Math.max(1, Math.ceil(params.radius / cellSize));
    const R2 = R * R;

    for (let j = -R; j <= R; j++) {
      const nj = cy + j;
      if (nj < 0 || nj >= GRID) continue;
      for (let i = -R; i <= R; i++) {
        const ni = cx + i;
        if (ni < 0 || ni >= GRID) continue;
        const d2 = i * i + j * j;
        if (d2 > R2) continue;

        // Gaussian falloff, so the god's will has a soft edge.
        // A hard-edged circle would read as mechanical.
        const dist = Math.sqrt(d2);
        const falloff = Math.exp(-(dist * dist) / (R2 * 0.55));
        const idx = nj * GRID + ni;

        if (params.danger > 0) {
          const v = fieldD[idx] + params.danger * falloff;
          fieldD[idx] = v > FIELD_MAX ? FIELD_MAX : v;
        }
        if (params.food > 0) {
          const v = fieldF[idx] + params.food * falloff;
          fieldF[idx] = v > FIELD_MAX ? FIELD_MAX : (v < -FIELD_MAX ? -FIELD_MAX : v);
        }
        if (params.custom > 0) {
          const v = fieldC[idx] + params.custom * falloff;
          fieldC[idx] = v > FIELD_MAX ? FIELD_MAX : v;
        }
      }
    }
  }

  World.registerSystem('deity-will', {
    order: 91,
    init() {},
    update(dt, t) {
      for (let i = 0; i < DIO_WILL_SLOTS; i++) {
        const base = DIO_WILL_BASE + i * 4;
        const gen = IO[base + 0] | 0;
        if (gen === 0) continue;
        if (gen === lastGen[i]) continue;

        const kind = IO[base + 1] | 0;
        const x    = IO[base + 2];
        const z    = IO[base + 3];
        lastGen[i] = gen;

        if (kind === WILL_KIND.IDLE) continue;
        applyWill(kind, x, z);
      }
    },
  });

  console.log('[deity-will] registered');
}