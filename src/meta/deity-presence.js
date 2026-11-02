// src/meta/deity-presence.js
//
// The god's presence driver. A temporary stand-in for the full
// deity worker. Owns the deityIO region of the SAB. Drifts the
// god's position slowly across the plane, breathes its vitality,
// sets its phase.
//
// When the full deity worker exists, this file goes away. The
// worker becomes the owner of deityIO. The renderer, the sim
// worker, and the symbiote keep reading from the same offsets.

import {
  DIO_POSTURE_BASE, DIO_STATE_BASE, DIO_MOTION_BASE,
  DIO_PHASE_CONFIRMATION,
} from '../sim/shared-buffer.js';

export function register(World, Engine, sim) {
  console.log('[deity-presence] register v1 · drifting monument');

  const IO = sim.deityIO;
  const SEED = 0xD00D5EED >>> 0;
  let rngState = SEED;

  function rng() {
    rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Current state — not persisted yet. The full deity worker
  // will restore this from chaoscell-deity. For phase 1 it
  // begins wherever the driver decides.
  const state = {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    targetX: 0, targetY: 0, targetZ: 0,
    lastRetarget: -999,
    phase: DIO_PHASE_CONFIRMATION,
    t0: performance.now() / 1000,
  };

  function pickTarget() {
    const r = 8000 + Math.sqrt(rng()) * 22000;
    const a = rng() * Math.PI * 2;
    state.targetX = Math.cos(a) * r;
    state.targetZ = Math.sin(a) * r;
    state.targetY = 0;
  }

  World.registerSystem('deity-presence', {
    order: 90,
    init() {
      pickTarget();
      state.lastRetarget = 0;
      // Seed the SAB immediately so the first frame of the
      // renderer has valid data.
      IO[DIO_POSTURE_BASE + 7] = 1.0;
      IO[DIO_STATE_BASE  + 1]  = 1.0;   // authority
      IO[DIO_STATE_BASE  + 4]  = 1;     // layer: Primordial Deep
      IO[DIO_STATE_BASE  + 5]  = state.phase;
    },
    update(dt, t) {
      // Retarget on a slow cadence. The god is not in a hurry.
      if (t - state.lastRetarget > 45 + rng() * 45) {
        state.lastRetarget = t;
        pickTarget();
      }

      // Drift with an 8-second time constant. Slow, monumental,
      // unbothered by anything the watcher or the population does.
      const tau = 8.0;
      const k = 1 - Math.exp(-dt / tau);
      state.vx = (state.targetX - state.x) / tau;
      state.vz = (state.targetZ - state.z) / tau;
      state.vy = 0;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.z += state.vz * dt;

      // Presence scalars. These are placeholders. When the deity
      // worker arrives, they will be functions of the world's
      // measured health, of the symbiote's prayers, of the
      // watcher's recent attention. For now they breathe.
      const vitality  = 0.65 + 0.25 * Math.sin(t * 0.05)
                             + 0.10 * Math.sin(t * 0.13);
      const authority = 1.0;
      const agitation = 0.18 + 0.12 * Math.sin(t * 0.21 + 1.7);
      const coherence = 0.85 + 0.10 * Math.sin(t * 0.03 + 0.4);

      // Write to the SAB.
      const P = DIO_POSTURE_BASE;
      IO[P + 0] = state.x;
      IO[P + 1] = state.y;
      IO[P + 2] = state.z;
      IO[P + 3] = state.vx;
      IO[P + 4] = state.vy;
      IO[P + 5] = state.vz;
      IO[P + 6] = 0;
      IO[P + 7] = 1.0;

      const S = DIO_STATE_BASE;
      IO[S + 0] = vitality;
      IO[S + 1] = authority;
      IO[S + 2] = agitation;
      IO[S + 3] = coherence;
      IO[S + 4] = 1;                // layer index
      IO[S + 5] = state.phase;
      IO[S + 6] = 0;
      IO[S + 7] = 0;

      const M = DIO_MOTION_BASE;
      IO[M + 0] = state.targetX;
      IO[M + 1] = state.targetY;
      IO[M + 2] = state.targetZ;
      IO[M + 3] = 0.5;
      IO[M + 4] = (SEED & 0xFFFF) / 65536;
      IO[M + 5] = (t * 0.05) % 1;
      IO[M + 6] = 0;
      IO[M + 7] = 0;
    },
  });

  console.log('[deity-presence] registered');
}