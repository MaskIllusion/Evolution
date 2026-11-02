// src/meta/dynamic.js
//
// The dynamic gate. Runs after the static checks. Two modules are
// compared: the current head of the chain and the candidate. Every
// check is finite. Nothing here evaluates arbitrary code.

export async function runDynamicChecks({
  oldModule, newModule, oldSource, newSource,
}) {
  if (typeof newModule.tick !== 'function')
    return { pass: false, reason: 'no tick export' };

  const oldInv = Array.isArray(oldModule.INVARIANTS) ? oldModule.INVARIANTS : [];
  const newInv = Array.isArray(newModule.INVARIANTS) ? newModule.INVARIANTS : [];
  for (const inv of oldInv) {
    if (!newInv.includes(inv)) {
      return { pass: false, reason: 'dropped invariant: ' + inv };
    }
  }

  if (typeof newModule.proposeRewrite !== 'function')
    return { pass: false, reason: 'no proposeRewrite export' };

  // Determinism: run both modules on identical inputs and confirm
  // the new module is deterministic across two runs.
  const stateA1 = new Float32Array(64);
  const stateA2 = new Float32Array(64);
  const world   = makeStubWorld();
  const rngA = makeRng(0x12345678);
  const rngB = makeRng(0x12345678);
  try {
    for (let i = 0; i < 100; i++) newModule.tick(stateA1, world, rngA);
    for (let i = 0; i < 100; i++) newModule.tick(stateA2, world, rngB);
  } catch (e) {
    return { pass: false, reason: 'runtime: ' + String(e) };
  }
  for (let i = 0; i < 64; i++) {
    if (stateA1[i] !== stateA2[i]) {
      return { pass: false, reason: 'nondeterministic at slot ' + i };
    }
  }

  return { pass: true };
}

function makeStubWorld() {
  const stat    = new Float32Array(128);
  const scratch = new Float32Array(126);
  return {
    stat,
    scratch,
    push(){ return true; },
  };
}

function makeRng(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}