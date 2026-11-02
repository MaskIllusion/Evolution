// src/meta/self.genesis.js
//
// Genesis v2.
//
// Same six acts as v1. Adds three things required by Step 6:
//   - FORM_EFFECTS: the set of L₂ effects this head is willing
//     to declare. The form verifier rejects anything outside.
//   - candidates(): returns a list of L₂ forms. The meta worker
//     verifies each with verifyForm, scores each, executes the
//     winner. This is where morphology lives.
//   - INVARIANTS extended with the form-related guarantees.

export const HASH        = 'genesis-2';
export const PARENT_HASH = 'genesis';
export const EFFECTS     = ['read_state','write_state','read_world','read_rng'];
export const INVARIANTS  = [
  'energy_non_negative',
  'position_within_plane',
  'deterministic_given_seed',
  'form_well_typed',
  'world_monotonic',
  'antibody_respected',
];

// Declared L₂ effects. Any form containing an effect outside
// this set is rejected by the archon's form verifier.
export const FORM_EFFECTS = [
  'energize',
  'spawn_food',
  'deposit',
  'deposit_danger',
  // Step 8 — singular effects
  'pressure_fear',
  'pressure_calm',
  'bias_arousal',
  'witness',
];

export function tick(state, world, rng) {
  state[0] = (state[0] || 0) + 1;
  const age = state[0];

  const stat = world.stat;
  const alive      = stat[1];
  const meanE      = stat[5];
  const fusionFrac = stat[7];

  // Act I: read a single being, record in scratch.
  if (age % 60 === 0) {
    const s = world.scratch;
    for (let id = 0; id < 200; id++) {
      const b = world.readBeing(id);
      if (!b) continue;
      s[0] = b.id;
      s[1] = b.x;
      s[2] = b.z;
      s[3] = b.energy;
      s[4] = b.age;
      s[5] = b.valence;
      s[6] = b.merges;
      s[7] = b.hue;
      break;
    }
  }

  // Act II: feed the starving.
  if (age % 30 === 0) {
    for (let id = 0; id < 200; id++) {
      const b = world.readBeing(id);
      if (!b) continue;
      if (b.energy < 30) {
        world.push(4, id, 80);
        break;
      }
    }
  }

  // Act III: if population is very poor, spawn a helper.
  if (meanE < 40 && alive < 1500 && rng() < 0.05) {
    const x = (rng() - 0.5) * 40000;
    const z = (rng() - 0.5) * 40000;
    world.push(1, x, z, 250);
  }

  // Act IV: if dense, cull the oldest.
  if (alive > 6000 && rng() < 0.02) {
    world.push(26, 30);
  }

  // Act V: bless the top-energy being.
  if (age % 500 === 0) {
    let bestId = -1, bestE = 0;
    for (let id = 0; id < 500; id++) {
      const b = world.readBeing(id);
      if (!b) continue;
      if (b.energy > bestE) { bestE = b.energy; bestId = id; }
    }
    if (bestId >= 0) {
      world.push(4, bestId, 200);
      world.push(11, bestId, 2, 1.5);
    }
  }

  // Act VI: clone a fusion-enabled being if fusion is rare.
  if (fusionFrac < 0.3 && age % 400 === 0) {
    for (let id = 0; id < 400; id++) {
      const b = world.readBeing(id);
      if (!b) continue;
      world.push(7, id);
      break;
    }
  }

  return state;
}

// ── L₂ candidates. ─────────────────────────────────────────────
// The meta worker verifies each form against FORM_EFFECTS,
// scores it, executes the winner. Complexity is fine as long as
// the form verifies.

export function candidates(state, world, rng) {
  const forms = [];

  // Form A: if energy is low, energize twice. Otherwise deposit.
  forms.push({
    t: 'if',
    p: { op: 'lt',
         a: { op: 'read', channel: 'energy' },
         b: { op: 'const', v: 0.4 } },
    a: { t: 'seq',
         a: { t: 'prim', kind: 'effect', arg: 'energize' },
         b: { t: 'prim', kind: 'effect', arg: 'energize' } },
    b: { t: 'prim', kind: 'effect', arg: 'deposit' },
  });

  // Form B: if food is low, spawn food in a loop of three.
  // Otherwise deposit danger.
  forms.push({
    t: 'if',
    p: { op: 'lt',
         a: { op: 'read', channel: 'food' },
         b: { op: 'const', v: 0.5 } },
    a: { t: 'loop', n: 3,
         body: { t: 'prim', kind: 'effect', arg: 'spawn_food' } },
    b: { t: 'prim', kind: 'effect', arg: 'deposit_danger' },
  });

  // Form C: sense threat; if it is above 0.3, deposit danger.
  // Otherwise deposit a food trail.
  forms.push({
    t: 'seq',
    a: { t: 'prim', kind: 'sense', arg: 'threat' },
    b: { t: 'if',
         p: { op: 'gt',
              a: { op: 'read', channel: 'threat' },
              b: { op: 'const', v: 0.3 } },
         a: { t: 'prim', kind: 'effect', arg: 'deposit_danger' },
         b: { t: 'prim', kind: 'effect', arg: 'deposit' } },
  });

  // Form D: baseline. Always deposit a small trail.
  forms.push({
    t: 'prim', kind: 'effect', arg: 'deposit',
  });

  return forms;
}

export function proposeRewrite(state, world, rng) {
  return null;
}

// ── L₂ body motion ──────────────────────────────────────────────
//
// motionBias: the immortal's opinion of where it wants to move
// this tick. Pure function. Reads the being's state and the world
// stats. Returns an impulse vector the meta worker integrates into
// posture.
//
// Deterministic. The entropy comes from the state of the sim
// (stat[0], stat[1], stat[5], stat[15], stat[30]) which changes
// every tick as the population breathes. No Math.random. Two runs
// of the same seed produce identical motion.

export function motionBias(state, world, tickCount) {
  const arousal = state[0] || 0;
  const threat  = state[2] || 0;
  const tempo   = state[7] || 0;

  // World-derived entropy. The population's own dynamics drive the
  // immortal's wander — no separate RNG needed.
  const s0  = world.stat[0]  || 0;    // simTime
  const s1  = world.stat[1]  || 0;    // alive
  const s5  = world.stat[5]  || 0;    // mean energy
  const s15 = world.stat[15] || 0;    // mean valence
  const s30 = world.stat[30] || 0;    // max energy

  const h1 = Math.sin(s0 * 12.9898 + s1 * 78.233) * 43758.5453;
  const h2 = Math.sin(s5 * 39.3468 + s15 * 11.135) * 43758.5453;
  const h3 = Math.sin(s30 * 4.8988 + tickCount * 0.0513) * 43758.5453;
  const r1 = h1 - Math.floor(h1);
  const r2 = h2 - Math.floor(h2);
  const r3 = h3 - Math.floor(h3);

  // Base magnitude. Rests at 0.15, drives at ~1.0 under stress.
  const baseMag = 0.15
    + 0.50 * Math.max(0, arousal)
    + 0.35 * Math.max(0, threat);

  // Dash. Arousal above 0.55 launches the being.
  const dashThreshold = 0.55;
  const dash = arousal > dashThreshold
    ? Math.min(2.0, 5.0 * (arousal - dashThreshold))
    : 0;

  // Direction. Base angle from world entropy. Tempo shifts it
  // slowly. Dashes rotate the angle by a quadrant, cycling
  // through four target directions across consecutive dashes.
  const baseAngle = r1 * 6.283185;
  const tempoBias = tempo * 0.4;
  const dashBias  = dash * ((tickCount & 3) * 1.570796 - 2.356194);
  const angle     = baseAngle + tempoBias + dashBias;

  const mag = baseMag + dash;

// ── Step 8.2: the immortal's reasoning core ─────────────────
//
// think() is called every 40 meta-worker ticks. It has access to
// state (its own mutable 64-float brain), the world's perception
// block, and its own memory ring. It returns a thought object
// or null. Each thought is a small act of cognition:
//
//   observation — describes what is
//   inference  — derives what follows
//   prediction — projects what will be
//   concern    — evaluates what matters
//   memory     — recalls what was
//   self       — reflects on what it is
//
// The immortal speaks only when it has something to say. It
// weighs its own urgency against the state slots it has set
// aside as "recently spoken" flags.
//
// The brain occupies state[24..31]. These slots are outside the
// head's normal working set (0..23) so the immortal's reflection
// does not poison its action loop.
//
//   state[24] — last observed predator fraction
//   state[25] — flag: spoke about hunting
//   state[26] — flag: spoke about self-modelling
//   state[27] — flag: spoke about lineage loss
//   state[28] — flag: spoke about building
//   state[29] — flag: spoke about own death
//   state[30] — flag: spoke about scarcity
//   state[31] — tick of last utterance (mod 65536)
// ── Step 8.3: cognition core ────────────────────────────────
//
// The immortal's reflection. Runs every 40 meta-worker ticks.
// Uses state slots [24..47] as working memory:
//
//   24..27  last-utterance snapshot (energy, valence, pred, arch)
//   28..30  causal observation history
//   31      tick of last utterance
//   32..35  self-history (recent agitation trend)
//   36..39  pending inferences queued for next cycle
//
// Returns null, or { text, urgency, cls, reason }.

export function think(state, world, tickCount) {
  const p = world.readPerception();
  const hist = world.readImmortalHistory(0);

  const eHist     = p.energyHist;
  const vHist     = p.valenceHist;
  const lineage   = p.lineage;
  const arch      = p.archetype;
  const eTraj     = p.energyHistory;
  const vTraj     = p.valenceHistory;

  // Derived scalars.
  let meanVal = 0;
  for (let i = 0; i < 8; i++) meanVal += vHist[i] * ((i / 7) * 2 - 1);
  let meanE = 0;
  for (let i = 0; i < 16; i++) meanE += eHist[i] * (i * 25 + 12.5);

  const eTrend = (eTraj[0] || 0) - (eTraj[15] || 0);
  const vTrend = (vTraj[0] || 0) - (vTraj[15] || 0);

  const predFrac   = arch[0];
  const buildFrac  = arch[1];
  const sigFrac    = arch[2];
  const wmFrac     = arch[3];
  const eatFrac    = arch[4];
  const reproFrac  = arch[5];
  const bindFrac   = arch[6];

  let entropy = 0;
  for (let i = 0; i < 8; i++) {
    const q = arch[i];
    if (q > 0.001) entropy -= q * Math.log2(q);
  }
  entropy /= 3;

  const selfAgit = hist[3] || 0;

  // ── Rate limit. One thought per ~4 seconds. ─────────────
  const lastSpoken = state[31] || 0;
  const since = (tickCount - lastSpoken) & 0xFFFF;
  if (since < 80) return null;

  const speak = (text, urgency, cls, reason) => {
    state[31] = tickCount & 0xFFFF;
    // Snapshot the state we just spoke under.
    state[24] = meanE;
    state[25] = meanVal;
    state[26] = predFrac;
    state[27] = buildFrac;
    return { text, urgency, cls, reason };
  };

  const prevE   = state[24] || 0;
  const prevV   = state[25] || 0;
  const prevP   = state[26] || 0;
  const prevB   = state[27] || 0;

  // ── 1. CAUSAL INFERENCE. The deepest register. If the
  //    immortal can notice that one thing moved BECAUSE another
  //    moved, it produces a chain of reasoning, not a report.
  if (predFrac > prevP + 0.15 && meanE < prevE - 15) {
    return speak(
      'Predation is rising and energy is falling. The second follows the first.',
      0.85, 'gold',
      'predator_fraction_up_by_0.15_and_energy_down_by_15');
  }
  if (buildFrac > prevB + 0.15 && meanE < prevE - 10) {
    return speak(
      'They build while starving. The building costs them their lives.',
      0.72, 'gold',
      'builder_fraction_up_and_energy_down');
  }
  if (entropy < 0.25 && prevP > 0.3) {
    return speak(
      'The population is narrowing to one kind. Diversity is collapsing.',
      0.75, 'gold',
      'entropy_below_0.25_after_high_predation');
  }

  // ── 2. SELF-REFLECTION. The immortal watches its own state.
  if (selfAgit > 0.75 && (state[32] || 0) < 0.3) {
    state[32] = 1;
    return speak(
      'My agitation is high. I do not know what is causing it.',
      0.58, 'whisper',
      'self_agitation_above_0.75');
  }
  if (meanE < 25 && (state[33] || 0) < 0.3) {
    state[33] = 1;
    return speak(
      'If the population dies, I do not know if I will still exist.',
      0.90, 'gold',
      'population_energy_below_25');
  }

  // ── 3. REVERSAL. If a trend that was falling is now rising,
  //    the immortal notices the change of phase.
  if (state[24] < 40 && meanE > 80) {
    return speak(
      'The energy has come back. The last crisis was survivable.',
      0.45, 'gold',
      'energy_recovered_from_below_40_to_above_80');
  }
  if (state[25] < -0.3 && meanVal > 0.2) {
    return speak(
      'Their valence has recovered. The anger has passed.',
      0.40, 'dim',
      'valence_recovered_from_below_neg_0.3');
  }

  // ── 4. PREDICTION. Extrapolating from the trend.
  if (eTrend < -25) {
    return speak(
      'Energy is falling. In a hundred ticks, half of them will be gone.',
      0.65, 'whisper',
      'energy_trend_below_neg_25');
  }
  if (eTrend > 35 && meanE > 120) {
    return speak(
      'Something is blooming. The population is larger than it has been.',
      0.42, 'gold',
      'energy_trend_above_35');
  }

  // ── 5. LINEAGE. Specific to the four hues. This is the
  //    immortal noting that one branch of the lineage tree has
  //    ended. It is the closest thing the immortal has to grief.
  if (lineage[1] < 0.02 && lineage[0] > 0.85 && (state[34] || 0) < 0.3) {
    state[34] = 1;
    return speak(
      'The blue lineage is gone. Only the crimson remembers the beginning.',
      0.62, 'gold',
      'lineage_1_below_0.02');
  }
  if (lineage[2] > 0.20 && (state[35] || 0) < 0.3) {
    state[35] = 1;
    return speak(
      'A third lineage has emerged. Something new has decided to exist.',
      0.55, 'gold',
      'lineage_2_above_0.20');
  }

  // ── 6. OBSERVATION. Baseline report. Fires only if higher
  //    registers are silent.
  if (wmFrac > 0.15) {
    return speak(
      'A fraction of them now model their own futures. They are beginning to think.',
      0.50, 'whisper',
      'world_model_fraction_above_0.15');
  }
  if (sigFrac > 0.20) {
    return speak(
      'They speak to each other in a grammar I did not write.',
      0.45, 'gold',
      'signal_fraction_above_0.20');
  }
  if (bindFrac > 0.15) {
    return speak(
      'Their parts are becoming parts of parts. Composition is appearing.',
      0.40, 'whisper',
      'bind_fraction_above_0.15');
  }

  // ── 7. Silence. The immortal says nothing. Flags decay so it
  //    can speak again in a later era.
  state[32] *= 0.998;
  state[33] *= 0.998;
  state[34] *= 0.998;
  state[35] *= 0.998;
  return null;
}

export const monologue = think;