// src/sim/runner.js
import { TASKS, TASK_VERSION, hashTasks } from './tasks.js';

export async function runSuite(sim, {
  objectives = ['children', 'rhoInverted'],
  tasks       = null,
  log         = console.log,
  onResult    = null,
} = {}) {
  const target = tasks ?? TASKS.map(t => t.name);
  const manifest = {
    taskVersion: TASK_VERSION,
    taskHash:    hashTasks(),
    startedAt:   new Date().toISOString(),
    results:     [],
  };

  // Stop posting step messages, wait for queued ones to drain, then
  // set the worker-side flag so any late step messages are no-ops.
  // Without this, evaluateChampion queries queue behind hundreds of
  // already-posted steps and time out.
  sim.pause();
  await sim.waitIdle();
  await sim.query('pause', {});

  try {
    for (const obj of objectives) {
      log(`[runner] objective: ${obj}`);
      const champs = await sim.query('champion', { objective: obj, k: 5 });
      if (!champs || champs.error) { log(`  champion query failed: ${champs.error}`); continue; }

      for (const champion of champs.champions) {
        for (const taskName of target) {
          const res = await sim.query('evaluateChampion', {
            champion: {
            program: champion.program,
            genes:   champion.genes,
            mlpW1:   champion.mlpW1,
            mlpB1:   champion.mlpB1,
            mlpW2:   champion.mlpW2,
            mlpB2:   champion.mlpB2,
            _assimilationCount: champion._assimilationCount,
            _heritage: champion._heritage,
          },
            task: taskName,
          });
          if (!res || res.error) { log(`  ${taskName}: ${res.error}`); continue; }
          const row = {
            objective: obj,
            championId: champion.id,
            task: taskName,
            score: res.score,
            survivorCount: res.survivorCount,
          };
          manifest.results.push(row);
          if (onResult) onResult(row);
        }
        log(`  champion ${champion.id} done`);
      }
    }
  } finally {
    await sim.query('resume', {});
    sim.resume();
  }

  manifest.finishedAt = new Date().toISOString();
  return manifest;
}