export const TASK_VERSION = 'v1-2026-09-27';

export const TASKS = Object.freeze([
  // ── Foraging under shifted resource structure
  { name: 'forage_2patch_shifted',        worldOverride: { PATCH_DRIFT: 2.4, PATCH_COUNT: 10 },                                 runTicks: 5000,  score: m => m.children },
  { name: 'forage_sparse_patch',          worldOverride: { PATCH_DRIFT: 0.4, PATCH_COUNT: 4,  FOOD_SEED_INIT: 2000 },          runTicks: 6000,  score: m => m.children },
  { name: 'forage_rich_dense',            worldOverride: { PATCH_DRIFT: 1.0, PATCH_COUNT: 16, FOOD_SEED_INIT: 12000 },         runTicks: 4000,  score: m => m.children },
  { name: 'forage_noise_sense',           worldOverride: { SENSE_COST: 0.6 },                                                   runTicks: 6000,  score: m => m.children },
  { name: 'forage_cheap_sense',           worldOverride: { SENSE_COST: 0.05 },                                                  runTicks: 6000,  score: m => m.children },

  // ── Conflict structure novelty
  { name: 'conflict_double_danger',       worldOverride: { DANGER_SCALE: 2.0 },                                                 runTicks: 6000,  score: m => m.children },
  { name: 'conflict_high_pop',            worldOverride: { FOOD_SEED_INIT: 16000, MAX_BEINGS: 6000 },                           runTicks: 6000,  score: m => m.children },
  { name: 'conflict_scarcity_threshold',  worldOverride: { FOOD_SEED_INIT: 800 },                                               runTicks: 8000,  score: m => m.children },
  { name: 'conflict_reverse_danger',      worldOverride: { DANGER_INVERTED: true },                                             runTicks: 6000,  score: m => m.children },

  // ── Predation and scavenging
  { name: 'predator_only',                worldOverride: { FOOD_SEED_INIT: 0, PATCH_COUNT: 0 },                                 runTicks: 5000,  score: m => m.children },
  { name: 'scavenge_only',                worldOverride: { FOOD_SEED_INIT: 200, CORPSE_DENSE: true },                           runTicks: 5000,  score: m => m.children },
  { name: 'predator_heavy',               worldOverride: { PREDATOR_SPAWN_BIAS: 0.5 },                                          runTicks: 5000,  score: m => m.children },

  // ── Social and signal
  { name: 'signal_isolation',             worldOverride: { SPATIAL_N_REDUCE: 4 },                                              runTicks: 6000,  score: m => m.children },
  { name: 'signal_high_density',          worldOverride: { FOOD_SEED_INIT: 12000, MAX_BEINGS: 6000 },                           runTicks: 6000,  score: m => m.children },
  { name: 'signal_against_noise',         worldOverride: { SENSE_COST: 0.6, SIGNAL_COST: 0.005 },                               runTicks: 6000,  score: m => m.children },

  // ── Credit assignment / temporal
  { name: 'delay_long_horizon',           worldOverride: { EPISODE_LEN: 128 },                                                  runTicks: 8000,  score: m => m.children },
  { name: 'delay_short_horizon',          worldOverride: { EPISODE_LEN: 16 },                                                   runTicks: 8000,  score: m => m.children },
  { name: 'delay_reward_scarcity',        worldOverride: { FOOD_SEED_INIT: 1000 },                                              runTicks: 8000,  score: m => m.children },

  // ── Fusion-directed objectives
  { name: 'fusion_low_recoverability',    worldOverride: {},                                                                    runTicks: 6000,  score: m => 1 - m.rhoEMA },
  { name: 'fusion_high_valence',          worldOverride: {},                                                                    runTicks: 6000,  score: m => m.valence + m.children * 0.5 },
]);

export function hashTasks() {
  // FNV-1a over the descriptor JSON. Log this with every run.
  const s = JSON.stringify(TASKS);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}