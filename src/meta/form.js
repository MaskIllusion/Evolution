// src/meta/form.js
//
// The L₂ form grammar verifier.
//
// A Form is a value, not code. It is JSON-serializable. It cannot
// eval. The verifier walks the tree and returns a total verdict.
//
// This module is orthogonal to the L₁ head (the JavaScript source
// the being runs as `tick`). L₁ is verified by static.js. L₂ is
// verified here. The head proposes a Form; the archon verifies it
// with this module; the meta worker interprets it with the
// interpreter that lands in Step 6. The two languages share no
// code and no trust.
//
// The grammar (recursive, depth-bounded):
//
//   Form    ::= Prim | Seq | Par | If | Choose | Loop | Adapt | Recur
//   Prim    ::= Sense | Effect | Recall | Emit
//
// Every Form is guaranteed by the verifier to:
//   - Be total (no unbounded loops, no unbounded recursion).
//   - Have bounded effect budget (<= MAX_EFFECTS).
//   - Have bounded depth (<= MAX_DEPTH).
//   - Reference only declared effects.
//   - Fit inside the MAX_NODES cap.
//
// The verifier is a total function. It always returns a verdict.
// It never throws. It never evaluates anything.

export const FORM_VERSION = 'form-2026-09-30-a1';

export const FORM_LIMITS = Object.freeze({
  MAX_DEPTH:     24,
  MAX_NODES:     8192,
  MAX_LOOP:      64,
  MAX_RECUR:     4,
  MAX_CHOICES:   8,
  MAX_EFFECTS:   4096,
  MAX_ADAPT_IDX: 15,
  MAX_CHOICE_W:  1000,
});

const NODE = {
  PRIM:   'prim',
  SEQ:    'seq',
  PAR:    'par',
  IF:     'if',
  CHOOSE: 'choose',
  LOOP:   'loop',
  ADAPT:  'adapt',
  RECUR:  'recur',
};

const PRIM = {
  SENSE:  'sense',
  EFFECT: 'effect',
  RECALL: 'recall',
  EMIT:   'emit',
};

const SENSE_BASE = new Set([
  'energy', 'valence', 'threat', 'neighbor', 'food', 'structure',
  'self.hash', 'self.age',
]);

const EFFECT_OPS = new Set([
  'move', 'eat', 'spawn_food', 'deposit', 'deposit_danger',
  'build', 'signal', 'energize', 'cull', 'expand_world',
  'ask_user', 'write_memory',
  // Step 8 — singular effects
  'pressure_fear', 'pressure_calm', 'bias_arousal', 'witness',
]);

const PRED_OPS = new Set(['lt', 'gt', 'has', 'chance']);
const EXPR_OPS = new Set(['const', 'read', 'recall', 'sum']);

const SCHEMA = {
  [NODE.PRIM]:   ['arg', 'kind'],
  [NODE.SEQ]:    ['a', 'b'],
  [NODE.PAR]:    ['a', 'b'],
  [NODE.IF]:     ['a', 'b', 'p'],
  [NODE.CHOOSE]: ['items', 'w'],
  [NODE.LOOP]:   ['body', 'n'],
  [NODE.ADAPT]:  ['body', 'param'],
  [NODE.RECUR]:  ['body', 'd'],
};

/* ── public API ─────────────────────────────────────────────── */

export function verifyForm(form, opts = {}) {
  const declared = new Set(opts.declaredEffects || []);

  const ctx = {
    nodes:    0,
    cost:     0,
    maxDepth: 0,
    effects:  new Set(),
    error:    null,
  };

  const ok = walk(form, 0, ctx, declared);

  if (!ok) {
    return {
      pass:      false,
      reason:    ctx.error || 'verification failed',
      version:   FORM_VERSION,
      cost:      0,
      maxDepth:  ctx.maxDepth,
      effectSet: Array.from(ctx.effects).sort(),
      nodeCount: ctx.nodes,
    };
  }

  return {
    pass:      true,
    version:   FORM_VERSION,
    cost:      ctx.cost,
    maxDepth:  ctx.maxDepth,
    effectSet: Array.from(ctx.effects).sort(),
    nodeCount: ctx.nodes,
  };
}

/* ── walker ─────────────────────────────────────────────────── */

function fail(ctx, reason) {
  if (!ctx.error) ctx.error = reason;
  return false;
}

function walk(node, depth, ctx, declared) {
  if (ctx.error) return false;
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return fail(ctx, 'not an object');
  }
  if (typeof node.t !== 'string') {
    return fail(ctx, 'missing or invalid field `t`');
  }

  ctx.nodes++;
  if (ctx.nodes > FORM_LIMITS.MAX_NODES) {
    return fail(ctx, 'node count exceeds MAX_NODES');
  }
  if (depth > FORM_LIMITS.MAX_DEPTH) {
    return fail(ctx, 'depth exceeds MAX_DEPTH');
  }
  if (depth > ctx.maxDepth) ctx.maxDepth = depth;

  const expected = SCHEMA[node.t];
  if (!expected) return fail(ctx, 'unknown node type: ' + node.t);

  const presentKeys = Object.keys(node).sort();
  const expectKeys  = [...expected, 't'].sort();
  if (presentKeys.length !== expectKeys.length) {
    return fail(ctx, 'field count mismatch in ' + node.t);
  }
  for (let i = 0; i < expectKeys.length; i++) {
    if (presentKeys[i] !== expectKeys[i]) {
      return fail(ctx,
        'unexpected field in ' + node.t + ': ' + presentKeys[i]);
    }
  }

  switch (node.t) {
    case NODE.PRIM:   return walkPrim(node, depth, ctx, declared);
    case NODE.SEQ:    return walkSeq(node, depth, ctx, declared);
    case NODE.PAR:    return walkSeq(node, depth, ctx, declared);
    case NODE.IF:     return walkIf(node, depth, ctx, declared);
    case NODE.CHOOSE: return walkChoose(node, depth, ctx, declared);
    case NODE.LOOP:   return walkLoop(node, depth, ctx, declared);
    case NODE.ADAPT:  return walkAdapt(node, depth, ctx, declared);
    case NODE.RECUR:  return walkRecur(node, depth, ctx, declared);
  }
  return fail(ctx, 'unhandled node type');
}

function walkPrim(node, depth, ctx, declared) {
  const kind = node.kind;
  const arg  = node.arg;

  if (typeof kind !== 'string') {
    return fail(ctx, 'prim: kind must be a string');
  }

  if (kind === PRIM.SENSE) {
    if (typeof arg !== 'string') {
      return fail(ctx, 'prim/sense: arg must be a string');
    }
    if (!isValidSenseChannel(arg)) {
      return fail(ctx, 'prim/sense: unknown channel ' + arg);
    }
  } else if (kind === PRIM.EFFECT) {
    if (typeof arg !== 'string') {
      return fail(ctx, 'prim/effect: arg must be a string');
    }
    if (!EFFECT_OPS.has(arg)) {
      return fail(ctx, 'prim/effect: unknown op ' + arg);
    }
    if (!declared.has(arg)) {
      return fail(ctx, 'prim/effect: undeclared effect ' + arg);
    }
    ctx.effects.add(arg);
  } else if (kind === PRIM.RECALL) {
    if (typeof arg !== 'number' || !Number.isInteger(arg)
        || arg < 0 || arg > 31) {
      return fail(ctx, 'prim/recall: arg must be integer in [0,31]');
    }
  } else if (kind === PRIM.EMIT) {
    if (typeof arg !== 'string') {
      return fail(ctx, 'prim/emit: arg must be a string');
    }
    if (arg.length === 0 || arg.length > 128) {
      return fail(ctx, 'prim/emit: arg length out of bounds');
    }
  } else {
    return fail(ctx, 'prim: unknown kind ' + kind);
  }

  ctx.cost += 1;
  if (ctx.cost > FORM_LIMITS.MAX_EFFECTS) {
    return fail(ctx, 'effect budget exceeded');
  }
  return true;
}

function walkSeq(node, depth, ctx, declared) {
  if (!walk(node.a, depth + 1, ctx, declared)) return false;
  if (!walk(node.b, depth + 1, ctx, declared)) return false;
  return true;
}

function walkIf(node, depth, ctx, declared) {
  if (!verifyPred(node.p, ctx)) return false;

  const saved = ctx.cost;
  if (!walk(node.a, depth + 1, ctx, declared)) return false;
  const costA = ctx.cost - saved;

  ctx.cost = saved;
  if (!walk(node.b, depth + 1, ctx, declared)) return false;
  const costB = ctx.cost - saved;

  ctx.cost = saved + Math.max(costA, costB);
  if (ctx.cost > FORM_LIMITS.MAX_EFFECTS) {
    return fail(ctx, 'effect budget exceeded');
  }
  return true;
}

function walkChoose(node, depth, ctx, declared) {
  if (!Array.isArray(node.items)) {
    return fail(ctx, 'choose: items must be an array');
  }
  if (node.items.length === 0) {
    return fail(ctx, 'choose: no items');
  }
  if (node.items.length > FORM_LIMITS.MAX_CHOICES) {
    return fail(ctx, 'choose: too many items');
  }
  if (!Array.isArray(node.w)) {
    return fail(ctx, 'choose: w must be an array');
  }
  if (node.w.length !== node.items.length) {
    return fail(ctx, 'choose: w length mismatch');
  }

  let sum = 0;
  for (let i = 0; i < node.w.length; i++) {
    const wi = node.w[i];
    if (typeof wi !== 'number' || !Number.isFinite(wi) || wi < 0) {
      return fail(ctx, 'choose: invalid weight at ' + i);
    }
    if (wi > FORM_LIMITS.MAX_CHOICE_W) {
      return fail(ctx, 'choose: weight exceeds MAX_CHOICE_W at ' + i);
    }
    sum += wi;
  }
  if (sum < 0.99 || sum > 1.01) {
    return fail(ctx,
      'choose: weights not normalized (sum=' + sum.toFixed(4) + ')');
  }

  const saved = ctx.cost;
  let maxBranch = 0;
  for (const item of node.items) {
    ctx.cost = saved;
    if (!walk(item, depth + 1, ctx, declared)) return false;
    const bc = ctx.cost - saved;
    if (bc > maxBranch) maxBranch = bc;
  }
  ctx.cost = saved + maxBranch;
  if (ctx.cost > FORM_LIMITS.MAX_EFFECTS) {
    return fail(ctx, 'effect budget exceeded');
  }
  return true;
}

function walkLoop(node, depth, ctx, declared) {
  if (typeof node.n !== 'number' || !Number.isInteger(node.n)) {
    return fail(ctx, 'loop: n must be an integer');
  }
  if (node.n < 1 || node.n > FORM_LIMITS.MAX_LOOP) {
    return fail(ctx, 'loop: n out of [1, MAX_LOOP]');
  }
  const saved = ctx.cost;
  if (!walk(node.body, depth + 1, ctx, declared)) return false;
  const bodyCost = ctx.cost - saved;
  ctx.cost = saved + node.n * bodyCost;
  if (ctx.cost > FORM_LIMITS.MAX_EFFECTS) {
    return fail(ctx, 'effect budget exceeded');
  }
  return true;
}

function walkAdapt(node, depth, ctx, declared) {
  if (typeof node.param !== 'number' || !Number.isInteger(node.param)) {
    return fail(ctx, 'adapt: param must be an integer');
  }
  if (node.param < 0 || node.param > FORM_LIMITS.MAX_ADAPT_IDX) {
    return fail(ctx, 'adapt: param out of [0, MAX_ADAPT_IDX]');
  }
  return walk(node.body, depth + 1, ctx, declared);
}

function walkRecur(node, depth, ctx, declared) {
  if (typeof node.d !== 'number' || !Number.isInteger(node.d)) {
    return fail(ctx, 'recur: d must be an integer');
  }
  if (node.d < 0 || node.d > FORM_LIMITS.MAX_RECUR) {
    return fail(ctx, 'recur: d out of [0, MAX_RECUR]');
  }
  const saved = ctx.cost;
  if (!walk(node.body, depth + 1, ctx, declared)) return false;
  const bodyCost = ctx.cost - saved;
  ctx.cost = saved + (node.d + 1) * bodyCost;
  if (ctx.cost > FORM_LIMITS.MAX_EFFECTS) {
    return fail(ctx, 'effect budget exceeded');
  }
  return true;
}

function verifyPred(p, ctx) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return fail(ctx, 'pred: not an object');
  }
  if (typeof p.op !== 'string') {
    return fail(ctx, 'pred: missing op');
  }
  if (!PRED_OPS.has(p.op)) {
    return fail(ctx, 'pred: unknown op ' + p.op);
  }

  if (p.op === 'chance') {
    if (typeof p.p !== 'number' || p.p < 0 || p.p > 1) {
      return fail(ctx, 'pred/chance: p out of [0,1]');
    }
    return true;
  }
  if (p.op === 'has') {
    if (typeof p.channel !== 'string') {
      return fail(ctx, 'pred/has: channel must be a string');
    }
    if (!isValidSenseChannel(p.channel)) {
      return fail(ctx, 'pred/has: unknown channel ' + p.channel);
    }
    return true;
  }
  return verifyExpr(p.a, ctx) && verifyExpr(p.b, ctx);
}

function verifyExpr(e, ctx) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    return fail(ctx, 'expr: not an object');
  }
  if (typeof e.op !== 'string') {
    return fail(ctx, 'expr: missing op');
  }
  if (!EXPR_OPS.has(e.op)) {
    return fail(ctx, 'expr: unknown op ' + e.op);
  }

  if (e.op === 'const') {
    if (typeof e.v !== 'number' || !Number.isFinite(e.v)) {
      return fail(ctx, 'expr/const: v must be a finite number');
    }
    return true;
  }
  if (e.op === 'read') {
    if (typeof e.channel !== 'string') {
      return fail(ctx, 'expr/read: channel must be a string');
    }
    if (!isValidSenseChannel(e.channel)) {
      return fail(ctx, 'expr/read: unknown channel ' + e.channel);
    }
    return true;
  }
  if (e.op === 'recall') {
    if (typeof e.idx !== 'number' || !Number.isInteger(e.idx)
        || e.idx < 0 || e.idx > 31) {
      return fail(ctx, 'expr/recall: idx out of [0,31]');
    }
    return true;
  }
  if (e.op === 'sum') {
    return verifyExpr(e.a, ctx) && verifyExpr(e.b, ctx);
  }
  return fail(ctx, 'expr: unhandled op');
}

function isValidSenseChannel(ch) {
  if (SENSE_BASE.has(ch)) return true;
  const m = /^(state|mem)\[(\d{1,2})\]$/.exec(ch);
  if (m) {
    const n = parseInt(m[2], 10);
    return n >= 0 && n <= 31;
  }
  return false;
}

/* ── self test ──────────────────────────────────────────────── */

function buildDeepSeq(d) {
  let f = { t: 'prim', kind: 'effect', arg: 'move' };
  for (let i = 0; i < d; i++) {
    f = {
      t: 'seq',
      a: f,
      b: { t: 'prim', kind: 'effect', arg: 'move' },
    };
  }
  return f;
}

export function selfTest() {
  const cases = [
    {
      name: 'simple effect',
      form: { t: 'prim', kind: 'effect', arg: 'move' },
      declared: ['move'], expect: true,
    },
    {
      name: 'undeclared effect',
      form: { t: 'prim', kind: 'effect', arg: 'move' },
      declared: [], expect: false,
    },
    {
      name: 'unknown effect op',
      form: { t: 'prim', kind: 'effect', arg: 'nuke' },
      declared: ['nuke'], expect: false,
    },
    {
      name: 'simple seq',
      form: {
        t: 'seq',
        a: { t: 'prim', kind: 'effect', arg: 'move' },
        b: { t: 'prim', kind: 'effect', arg: 'eat' },
      },
      declared: ['move', 'eat'], expect: true,
    },
    {
      name: 'loop too large',
      form: {
        t: 'loop', n: 1000,
        body: { t: 'prim', kind: 'effect', arg: 'move' },
      },
      declared: ['move'], expect: false,
    },
    {
      name: 'loop at bound',
      form: {
        t: 'loop', n: 64,
        body: { t: 'prim', kind: 'effect', arg: 'move' },
      },
      declared: ['move'], expect: true,
    },
    {
      name: 'recur out of range',
      form: {
        t: 'recur', d: 100,
        body: { t: 'prim', kind: 'effect', arg: 'move' },
      },
      declared: ['move'], expect: false,
    },
    {
      name: 'adapt out of range',
      form: {
        t: 'adapt', param: 99,
        body: { t: 'prim', kind: 'effect', arg: 'move' },
      },
      declared: ['move'], expect: false,
    },
    {
      name: 'choose normalized',
      form: {
        t: 'choose',
        w: [0.5, 0.5],
        items: [
          { t: 'prim', kind: 'effect', arg: 'move' },
          { t: 'prim', kind: 'effect', arg: 'eat' },
        ],
      },
      declared: ['move', 'eat'], expect: true,
    },
    {
      name: 'choose bad sum',
      form: {
        t: 'choose',
        w: [0.9, 0.9],
        items: [
          { t: 'prim', kind: 'effect', arg: 'move' },
          { t: 'prim', kind: 'effect', arg: 'eat' },
        ],
      },
      declared: ['move', 'eat'], expect: false,
    },
    {
      name: 'unknown node type',
      form: { t: 'magic' },
      declared: [], expect: false,
    },
    {
      name: 'null form',
      form: null, declared: [], expect: false,
    },
    {
      name: 'array form',
      form: [], declared: [], expect: false,
    },
    {
      name: 'state[3] sense',
      form: { t: 'prim', kind: 'sense', arg: 'state[3]' },
      declared: [], expect: true,
    },
    {
      name: 'state[99] sense',
      form: { t: 'prim', kind: 'sense', arg: 'state[99]' },
      declared: [], expect: false,
    },
    {
      name: 'deep tree (30)',
      form: buildDeepSeq(30),
      declared: ['move'], expect: false,
    },
    {
      name: 'moderate tree (10)',
      form: buildDeepSeq(10),
      declared: ['move'], expect: true,
    },
  ];

  const results = cases.map(c => {
    const r = verifyForm(c.form, { declaredEffects: c.declared });
    return {
      name:   c.name,
      pass:   r.pass === c.expect,
      got:    r.pass,
      reason: r.reason || null,
      cost:   r.cost,
      depth:  r.maxDepth,
    };
  });

  const failed = results.filter(r => !r.pass);
  return {
    version: FORM_VERSION,
    pass:    failed.length === 0,
    total:   results.length,
    failed:  failed.length,
    results,
  };
}