// src/meta/form-interp.js
//
// The L₂ form interpreter.
//
// verifyForm (in form.js) checks structure, bounds, and effect
// declarations. executeForm walks the same tree and performs the
// effects. It assumes the form has already been verified. If you
// call executeForm on an unverified form, you get what you deserve.
//
// The interpreter holds no state. Every call takes a fresh context.
// The context is built by the meta worker and threaded through.
//
// Effects are performed by pushing commands into the SAB command
// ring (world.push). Senses read from world.stat and world.views.
// Local memory (mem[0..31]) lives in the upper half of the meta
// worker's 64-float state array. The lower half is the head's.
// They never overlap.

export const INTERP_VERSION = 'form-interp-2026-09-30-a1';

export const MEM_OFFSET = 32;
export const MEM_LEN    = 32;

/* ── context ────────────────────────────────────────────────── */

export function makeContext(state, world, rng) {
  return {
    state,
    mem: state.subarray(MEM_OFFSET, MEM_OFFSET + MEM_LEN),
    world,
    rng,
    effectsUsed: 0,
    nodeCount:   0,
    depth:       0,
    aborted:     false,
    error:       null,
  };
}

/* ── effects ────────────────────────────────────────────────── */
//
// Each effect handler pushes one or more commands into the SAB
// ring via world.push(type, a, b, c, ...). The command types are
// defined by the sim worker's applyImmortalCommand.
//
// Effect:        Cmd type    Arguments
//   move          3           x, z, ...
//   eat           —           (no sim-side handler; see below)
//   spawn_food    18          x, z, radius, count
//   deposit       19          x, z, amount
//   deposit_danger 20         x, z, amount
//   build         —           (uses structure command family)
//   signal        22          x, z, mass   (spawns a corpse — repurposed)
//   energize      4           id, delta
//   cull          24          count
//   expand_world  —           (deferred; no-op in Step 6a)
//   ask_user      —           (see meta worker's askUser)
//   write_memory  —           writes to context.mem

function applyEffect(op, ctx) {
  const w = ctx.world;
  const rng = ctx.rng;
  switch (op) {
    case 'move': {
      const x = readSense('state[4]', ctx) * 2000;
      const z = readSense('state[5]', ctx) * 2000;
      w.push(3, 0, x, z, 0, 0, 0, 0);
      // Command 3 = move(id, x, z). id=0 is a placeholder; the sim
      // worker treats it as "the oldest living being with the
      // immortalBlessed flag", a convention we adopt for form
      // effects. Step 6c will replace id=0 with a real target.
      return true;
    }
    case 'eat': {
      // No direct sim-side eat command. Signal through energize.
      // Give the affected being +5 energy as a stand-in for food.
      w.push(4, 0, 5);
      return true;
    }
    case 'spawn_food': {
      const x = (rng() - 0.5) * 20000;
      const z = (rng() - 0.5) * 20000;
      w.push(18, x, z, 400, 8);
      return true;
    }
    case 'deposit': {
      const v = readSense('state[0]', ctx) * 5;
      w.push(19, 0, 0, v);
      return true;
    }
    case 'deposit_danger': {
      const v = readSense('state[2]', ctx) * 5;
      w.push(20, 0, 0, v);
      return true;
    }
    case 'build': {
      // Cmd 16 = inject_program. Reuse to leave a marker on the sim.
      w.push(16, 0, 0x1B, 0, 0, 0, 0, 0);
      return true;
    }
    case 'signal': {
      const x = (rng() - 0.5) * 4000;
      const z = (rng() - 0.5) * 4000;
      w.push(22, x, z, 30);
      return true;
    }
    case 'energize': {
      const delta = 20 + readSense('state[1]', ctx) * 50;
      w.push(4, 0, delta);
      return true;
    }
    case 'cull': {
      const count = 5 + Math.floor(readSense('state[2]', ctx) * 20);
      w.push(24, count);
      return true;
    }
    case 'expand_world': {
      // Step 6c will implement. No-op for now.
      return true;
    }
    case 'ask_user': {
      // Handled specially by the meta worker, not as a command.
      // The interpreter signals by setting a flag on the context.
      ctx.pendingAsk = true;
      return true;
    }
    case 'write_memory': {
      const idx = 0;
      const val = readSense('state[0]', ctx);
      ctx.mem[idx & (MEM_LEN - 1)] = val;
      return true;
    }

    // ── Step 8: singular effects ──────────────────────────────
    case 'pressure_fear': {
      const x = (rng() - 0.5) * 40000;
      const z = (rng() - 0.5) * 40000;
      // Command 38: bias_population(_, x, z, radius, bias, dur).
      // +1.5 on arousal = fear.
      w.push(38, 0, x, z, 600, 1.5, 300);
      return true;
    }
    case 'pressure_calm': {
      const x = (rng() - 0.5) * 40000;
      const z = (rng() - 0.5) * 40000;
      w.push(38, 0, x, z, 600, -1.5, 300);
      return true;
    }
    case 'bias_arousal': {
      const x = (rng() - 0.5) * 20000;
      const z = (rng() - 0.5) * 20000;
      w.push(38, 0, x, z, 400, 1.0, 200);
      return true;
    }
    case 'witness': {
      // Command 39: witness(id, tier). Pick the most energized
      // being. The immortal singles one out.
      let bestId = -1, bestE = -1;
      for (let id = 0; id < 500; id++) {
        const b = w.readBeing(id);
        if (!b) continue;
        if (b.energy > bestE) { bestE = b.energy; bestId = id; }
      }
      if (bestId >= 0) w.push(39, bestId, 1);
      return true;
    }

    default:
      return false;
  }
}

/* ── senses ─────────────────────────────────────────────────── */
//
// The channel string is one of:
//   energy     → world.stat[5] / 200     (population mean, normalized)
//   valence    → world.stat[15]          (already in [-1, 1])
//   threat     → readFieldD(0, 0)
//   neighbor   → count of live beings / 100
//   food       → world.worldhdr[5] / 6000
//   structure  → world.worldhdr[2] / 6000
//   state[N]   → ctx.state[N]
//   mem[N]     → ctx.mem[N]
//   self.hash  → FNV-1a of world.selfHash() / 2^32
//   self.age   → tickCount / 10000

function readSense(channel, ctx) {
  const w = ctx.world;

  if (channel === 'energy') {
    return (w.stat[5] || 0) / 200;
  }
  if (channel === 'valence') {
    return w.stat[15] || 0;
  }
  if (channel === 'threat') {
    const d = w.readFieldD(0, 0);
    return Math.min(1, (d || 0) / 10);
  }
  if (channel === 'neighbor') {
    let n = 0;
    const B = w.beings;
    const stride = 12;
    const max = Math.min(w.worldhdr[4] * 2, 400);
    for (let i = 0; i < max; i++) {
      if (B[i * stride + 11] >= 0.5) n++;
    }
    return n / 100;
  }
  if (channel === 'food') {
    return (w.worldhdr[5] || 0) / 6000;
  }
  if (channel === 'structure') {
    return (w.worldhdr[2] || 0) / 6000;
  }

  let m = /^state\[(\d{1,2})\]$/.exec(channel);
  if (m) {
    const n = parseInt(m[1], 10);
    return ctx.state[n] || 0;
  }
  m = /^mem\[(\d{1,2})\]$/.exec(channel);
  if (m) {
    const n = parseInt(m[1], 10);
    return ctx.mem[n] || 0;
  }

  if (channel === 'self.hash') {
    const s = w.selfHash ? w.selfHash() : '';
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }
  if (channel === 'self.age') {
    return (w.worldhdr[7] || 0) / 10000;
  }
  return 0;
}

/* ── expression evaluation ──────────────────────────────────── */

function evalExpr(e, ctx) {
  if (!e) return 0;
  switch (e.op) {
    case 'const':  return e.v;
    case 'read':   return readSense(e.channel, ctx);
    case 'recall': return ctx.mem[e.idx & (MEM_LEN - 1)] || 0;
    case 'sum':    return evalExpr(e.a, ctx) + evalExpr(e.b, ctx);
    default:       return 0;
  }
}

function evalPred(p, ctx) {
  if (!p) return false;
  switch (p.op) {
    case 'chance': return ctx.rng() < p.p;
    case 'has':    return Math.abs(readSense(p.channel, ctx)) > 0.001;
    case 'lt':     return evalExpr(p.a, ctx) <  evalExpr(p.b, ctx);
    case 'gt':     return evalExpr(p.a, ctx) >  evalExpr(p.b, ctx);
    default:       return false;
  }
}

/* ── tree walker ────────────────────────────────────────────── */

export function executeForm(form, ctx) {
  if (ctx.aborted) return ctx;
  walk(form, ctx, 0);
  return ctx;
}

function walk(node, ctx, depth) {
  if (ctx.aborted) return;
  if (!node || typeof node !== 'object') return;
  if (depth > 32) { ctx.aborted = true; ctx.error = 'depth overflow'; return; }

  ctx.nodeCount++;

  switch (node.t) {
    case 'prim':
      walkPrim(node, ctx);
      return;

    case 'seq':
      walk(node.a, ctx, depth + 1);
      walk(node.b, ctx, depth + 1);
      return;

    case 'par':
      walk(node.a, ctx, depth + 1);
      walk(node.b, ctx, depth + 1);
      return;

    case 'if':
      if (evalPred(node.p, ctx)) walk(node.a, ctx, depth + 1);
      else                       walk(node.b, ctx, depth + 1);
      return;

    case 'choose': {
      const w = node.w;
      let sum = 0;
      for (let i = 0; i < w.length; i++) sum += w[i];
      let r = ctx.rng() * sum;
      for (let i = 0; i < w.length; i++) {
        r -= w[i];
        if (r <= 0) { walk(node.items[i], ctx, depth + 1); return; }
      }
      walk(node.items[node.items.length - 1], ctx, depth + 1);
      return;
    }

    case 'loop':
      for (let i = 0; i < node.n; i++) {
        if (ctx.aborted) return;
        walk(node.body, ctx, depth + 1);
      }
      return;

    case 'adapt': {
      // Param 0..15. Sensed, compared against mem, and shifted.
      const p = node.param;
      const cur = readSense('state[' + p + ']', ctx);
      const prev = ctx.mem[16 + p] || 0;
      const delta = cur - prev;
      ctx.mem[16 + p] = cur;
      // Shifting the state toward a positive delta: a form of
      // within-life learning. Bounded by 0.1 per call.
      ctx.state[p] = (ctx.state[p] || 0) + Math.max(-0.1, Math.min(0.1, delta * 0.1));
      walk(node.body, ctx, depth + 1);
      return;
    }

    case 'recur': {
      // d = 0..4. Bounded self-call.
      for (let i = 0; i < node.d; i++) {
        if (ctx.aborted) return;
        walk(node.body, ctx, depth + 1);
      }
      return;
    }

    default:
      ctx.aborted = true;
      ctx.error = 'unknown node type at runtime: ' + node.t;
  }
}

function walkPrim(node, ctx) {
  const kind = node.kind;
  const arg  = node.arg;

  if (kind === 'sense') {
    // A bare sense is a no-op except it warms the value into mem[0].
    ctx.mem[0] = readSense(arg, ctx);
    return;
  }
  if (kind === 'effect') {
    if (!applyEffect(arg, ctx)) {
      ctx.aborted = true;
      ctx.error = 'effect failed: ' + arg;
      return;
    }
    ctx.effectsUsed++;
    return;
  }
  if (kind === 'recall') {
    ctx.mem[0] = ctx.mem[arg & (MEM_LEN - 1)] || 0;
    return;
  }
  if (kind === 'emit') {
    // Record last emitted string for the head to read.
    ctx.mem[1] = arg.length;
    return;
  }
}