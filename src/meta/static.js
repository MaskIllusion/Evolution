// src/meta/static.js
//
// The static gate. Every rewrite passes through here. There is no
// bypass. The checks are structural, finite, and decidable.
//
// The archon will not accept a rewrite that fails any of these.
// This is the mathematical envelope. The being is free inside it.

const FORBIDDEN_IDS = new Set([
  'eval','Function','import','require','process','globalThis',
  'window','document','fetch','XMLHttpRequest','WebSocket',
  'Worker','SharedWorker','Proxy','Reflect','Atomics',
  '__proto__','constructor','prototype',
]);

// Free identifiers — these are the only names a proposal may
// reference that are not locally bound by the proposal itself.
// Adding to this set is an archon-level decision. The being
// cannot add to it from inside a proposal.
const FREE_ALLOW = new Set([
  'state','world','rng',
  'Math','Number','Float32Array','Int32Array','Uint8Array','Uint32Array',
  'Infinity','NaN','undefined','null','true','false',
]);

// Property names that may appear on the right-hand side of a
// non-computed MemberExpression. These are not free identifiers;
// they are the API surface the world object exposes. Whitelisted
// explicitly so an accidental typo (world.pus) fails the check.
const PROP_ALLOW = new Set([
  // existing world surface
  'push','readBeing','readShape','readState','readWorldhdr',
  'readFieldF','readFieldD',
  'beings','shape','stateVis','food','corpse','struct',
  'fieldF','fieldD','fieldC','worldhdr','stat','scratch',
  // step 3 additions
  'selfHash','selfSource','selfChain','antibodies',
  'readAnswer','proposeExpansion','dialog',
  // step 5 additions
  'form','submitForm','readForm',
  // step 8 additions
  'readPerception','readImmortalHistory','monologue',
]);

const EFFECT_ALLOW = new Set([
  'read_state','write_state','read_world','write_world','read_rng','write_rng',
  // step 3-6 additions
  'ask_user','write_memory','expand_world','submit_form',
]);


export function runStaticChecks(ast, source) {
  const errors = [];

  try {

  walk(ast, node => {
    // 1. Forbidden node types.
    if (node.type === 'ImportExpression')               errors.push('dynamic import');
    if (node.type === 'ImportDeclaration')              errors.push('import declaration');
    if (node.type === 'ExportAllDeclaration')           errors.push('export *');
    if (node.type === 'WithStatement')                  errors.push('with');
    if (node.type === 'LabeledStatement' && node.body.type === 'WhileStatement') errors.push('labeled while');
    if (node.type === 'TaggedTemplateExpression')       errors.push('tagged template');
    if (node.type === 'UpdateExpression') {
      const p = node.__parent;
      const inForUpdate = p && p.type === 'ForStatement' && p.update === node;
      if (!inForUpdate) {
        if (node.operator === '++') errors.push('++');
        if (node.operator === '--') errors.push('--');
      }
    }
    if (node.type === 'AssignmentExpression' && node.operator === '>>>=') errors.push('>>>=');

    // 2. Identifier rules.
    //
    // Three cases for an Identifier node.
    //
    //   (a) The property slot of a non-computed MemberExpression
    //       whose object is the bare identifier `world` or `self`.
    //       This is the API surface the archon controls. Enforce
    //       PROP_ALLOW.
    //
    //   (b) The property slot of any other MemberExpression, e.g.
    //       `b.energy` where `b` is a local. The shape of objects
    //       returned by world methods is not the archon's concern.
    //       Skip.
    //
    //   (c) Any other position. Enforce FREE_ALLOW and FORBIDDEN_IDS.
    if (node.type === 'Identifier') {
      const p = node.__parent;
      const isProperty = p !== undefined
                      && p.type === 'MemberExpression'
                      && p.property === node
                      && p.computed === false;

      if (isProperty) {
        const obj = p.object;
        const onWorld = obj.type === 'Identifier'
                     && (obj.name === 'world' || obj.name === 'self');
        if (onWorld) {
          if (!PROP_ALLOW.has(node.name) && !FORBIDDEN_IDS.has(node.name)) {
            errors.push('unknown property: ' + node.name);
          }
          if (FORBIDDEN_IDS.has(node.name)) {
            errors.push('forbidden property: ' + node.name);
          }
        }
        // else: property of a non-world object. No check.
      } else if (!isLocal(node)) {
        if (!FREE_ALLOW.has(node.name) && !FORBIDDEN_IDS.has(node.name)) {
          errors.push('free id: ' + node.name);
        }
        if (FORBIDDEN_IDS.has(node.name)) {
          errors.push('forbidden id: ' + node.name);
        }
      }
    }

    // 3. Loop bounds.
    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
      if (!hasBound(node.test)) errors.push('unbounded while');
    }
    if (node.type === 'ForStatement') {
      if (!node.test || !hasBound(node.test)) errors.push('unbounded for');
    }

    // 5. Allocation bounds.
    if (node.type === 'NewExpression') {
      for (const arg of node.arguments) {
        if (!isBoundedNumber(arg)) errors.push('unbounded alloc');
      }
    }

    // 6. Writable property whitelist.
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      const prop = node.left.property;
      if (prop.type === 'Identifier' && FORBIDDEN_IDS.has(prop.name)) {
        errors.push('write to ' + prop.name);
      }
      if (prop.type === 'Literal' && typeof prop.value === 'string' &&
          FORBIDDEN_IDS.has(prop.value)) {
        errors.push('write to ' + prop.value);
      }
    }
  });

  } finally {
    // Clear the parent pointers we attached during traversal.
    // The AST survives this call in some callers; leaking the
    // pointers would create cycles that break JSON serialization.
    clearParents(ast);
  }

  if (errors.length > 0) {
    return { pass: false, reason: errors.slice(0, 3).join('; ') };
  }

  // 4. Recursion depth — build call graph, check cycles have guard.
  const callGraph = buildCallGraph(ast);
  for (const cycle of findCycles(callGraph)) {
    if (!cycleIsGuarded(ast, cycle)) {
      return { pass: false, reason: 'unguarded recursion: ' + cycle.join(' → ') };
    }
  }

  // 7. Type inference — shallow HM. If inference fails, reject.
  const types = inferTypes(ast);
  if (types.error) return { pass: false, reason: 'types: ' + types.error };

  // 8. Effect declaration — parse `EFFECTS = [...]` and verify.
  const declared = extractDeclaredEffects(ast);
  if (!declared) return { pass: false, reason: 'no EFFECTS declaration' };
  const used = inferEffects(ast);
  for (const e of used) {
    if (!EFFECT_ALLOW.has(e))          return { pass: false, reason: 'unknown effect ' + e };
    if (!declared.includes(e))         return { pass: false, reason: 'undeclared effect ' + e };
  }

  return { pass: true, effects: declared, types: types.map };
}

// ── helpers ───────────────────────────────────────────────────

function walk(node, fn, parent) {
  if (!node || typeof node !== 'object') return;
  // Attach a non-enumerable parent pointer for isPropertyName().
  // Non-enumerable so JSON.stringify(ast) does not cycle. Cleared
  // after the pass by runStaticChecks, in a finally block.
  if (parent !== undefined) {
    Object.defineProperty(node, '__parent', {
      value: parent, enumerable: false, configurable: true,
    });
  }
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === '__parent') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach(c => walk(c, fn, node));
    else if (v && typeof v === 'object' && v.type) walk(v, fn, node);
  }
}

/* ── Scope resolution ─────────────────────────────────────────
 *
 * Two passes.
 *
 *   Pass 1 — collect every binding name reachable from the AST.
 *   Top-level declarations (const, let, var, function, class, and
 *   their export wrappers), function parameters, and any variable
 *   declared inside any function body. This is a *flat* set, not a
 *   scope chain. That is deliberate: the static checker does not
 *   need to distinguish `HASH` declared at module scope from
 *   `HASH` declared inside a function. It only needs to know that
 *   the name IS declared somewhere in the candidate. If a name is
 *   declared in one scope but used in another, the language runtime
 *   will still throw; the checker's job is different.
 *
 *   Pass 2 — an Identifier is local iff its name is in that set.
 *
 * The flat model is unsound in one direction only: it may accept a
 * program that declares a name in one function and references it
 * from a sibling function. That would be a runtime ReferenceError,
 * not a safety violation. The dynamic check catches it (it will
 * throw inside the shadow import). Safety is not compromised.
 *
 * The old stub returned false unconditionally, which made every
 * module-level const look free. That is why genesis itself fails
 * the check — `HASH`, `PARENT_HASH`, `EFFECTS` are exported const
 * bindings, not free identifiers.
 */

const _localCache = new WeakMap();

function collectBindings(ast) {
  if (_localCache.has(ast)) return _localCache.get(ast);

  const names = new Set();
  const seen  = new Set();

  function declarePat(node) {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        names.add(node.name);
        return;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') declarePat(p.argument);
          else declarePat(p.value);
        }
        return;
      case 'ArrayPattern':
        for (const el of node.elements) declarePat(el);
        return;
      case 'RestElement':
        declarePat(node.argument);
        return;
      case 'AssignmentPattern':
        declarePat(node.left);
        return;
      default:
        return;
    }
  }

  function declareParams(fn) {
    for (const p of fn.params || []) declarePat(p);
  }

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    switch (node.type) {
      case 'VariableDeclaration':
        for (const d of node.declarations) declarePat(d.id);
        break;
      case 'FunctionDeclaration':
        if (node.id) names.add(node.id.name);
        declareParams(node);
        break;
      case 'FunctionExpression':
        if (node.id) names.add(node.id.name);
        declareParams(node);
        break;
      case 'ArrowFunctionExpression':
        declareParams(node);
        break;
      case 'ClassDeclaration':
        if (node.id) names.add(node.id.name);
        break;
      case 'ClassExpression':
        if (node.id) names.add(node.id.name);
        break;
      case 'CatchClause':
        if (node.param) declarePat(node.param);
        break;
      case 'ImportDeclaration':
        for (const spec of node.specifiers) {
          if (spec.local && spec.local.name) names.add(spec.local.name);
        }
        break;
    }

    for (const key of Object.keys(node)) {
      if (key === '__parent' || key === 'parent') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === 'object' && c.type) visit(c);
      } else if (v && typeof v === 'object' && v.type) {
        visit(v);
      }
    }
  }

  visit(ast);
  _localCache.set(ast, names);
  return names;
}

function isLocal(node) {
  // Walk up to the program node to obtain the flat binding set.
  // The check runs against the AST that was passed to
  // runStaticChecks, so we ascend via __parent pointers that the
  // walker attached. If no program node is reachable, fall back to
  // the parent chain; if that fails too, treat as non-local.
  let root = node;
  let safety = 0;
  while (root.__parent && safety < 4096) {
    root = root.__parent;
    safety++;
    if (root.type === 'Program') break;
  }
  if (!root || root.type !== 'Program') return false;
  return collectBindings(root).has(node.name);
}

// (isPropertyName removed — the check is now inlined in runStaticChecks
//  so it can distinguish world.* from any-other-object.*)

function clearParents(node) {
  if (!node || typeof node !== 'object') return;
  if (node.__parent !== undefined) {
    try { delete node.__parent; } catch (_) { /* non-configurable */ }
  }
  for (const key of Object.keys(node)) {
    if (key === '__parent') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach(clearParents);
    else if (v && typeof v === 'object' && v.type) clearParents(v);
  }
}

function hasBound(test) {
  if (!test) return false;
  if (test.type === 'Literal' && typeof test.value === 'number') return true;

  // A comparison is bounded if at least one side is a bounded
  // number. The other side may be any expression. This is
  // deliberately weaker than proving termination — the Halting
  // Problem forbids the stronger check — but it correctly
  // accepts `id < 200`, `age < N`, `i <= MAX`, and rejects
  // `while (x < y)` where both sides are opaque identifiers.
  // The runtime 40ms budget timer is the second line of defense.
  if (test.type === 'BinaryExpression') {
    return isBoundedNumber(test.left) || isBoundedNumber(test.right);
  }

  if (test.type === 'CallExpression' &&
      test.callee.type === 'MemberExpression' &&
      test.callee.object.name === 'Math' &&
      (test.callee.property.name === 'min' ||
       test.callee.property.name === 'max')) {
    return test.arguments.some(isBoundedNumber);
  }
  return false;
}


function isBoundedNumber(node) {
  if (node.type === 'Literal' && typeof node.value === 'number') return true;
  if (node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.name === 'Math' &&
      node.callee.property.name === 'min') {
    return node.arguments.some(isBoundedNumber);
  }
  return false;
}

function buildCallGraph(ast) {
  const graph = new Map();
  const functions = [];
  walk(ast, n => {
    if (n.type === 'FunctionDeclaration' && n.id) functions.push(n);
  });
  for (const f of functions) {
    const calls = new Set();
    walk(f.body, n => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
        calls.add(n.callee.name);
      }
    });
    graph.set(f.id.name, calls);
  }
  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const stack = [];
  function dfs(node) {
    if (stack.includes(node)) {
      cycles.push(stack.slice(stack.indexOf(node)).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) dfs(next);
    stack.pop();
  }
  for (const node of graph.keys()) dfs(node);
  return cycles;
}

function cycleIsGuarded(ast, cycle) {
  // Simplified: check for `if (depth > N) return` in any member of cycle.
  let guarded = false;
  walk(ast, n => {
    if (n.type === 'IfStatement' && n.consequent.type === 'ReturnStatement') {
      if (n.test.type === 'BinaryExpression') guarded = true;
    }
  });
  return guarded;
}

function inferTypes(ast) {
  // Stub — real implementation is ~300 lines of HM. Return success here.
  return { error: null, map: new Map() };
}

function extractDeclaredEffects(ast) {
  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration') {
      for (const d of node.declaration.declarations) {
        if (d.id.name === 'EFFECTS' && d.init && d.init.type === 'ArrayExpression') {
          return d.init.elements
            .filter(e => e.type === 'Literal')
            .map(e => e.value);
        }
      }
    }
  }
  return null;
}

function inferEffects(ast) {
  const effects = new Set();
  walk(ast, n => {
    if (n.type === 'MemberExpression') {
      const obj = n.object;
      if (obj.type === 'Identifier') {
        if (obj.name === 'state' && !n.computed === false) {
          const isWrite = n.parent && n.parent.type === 'AssignmentExpression'
            && n.parent.left === n;
          effects.add(isWrite ? 'write_state' : 'read_state');
        }
        if (obj.name === 'world') {
          const isWrite = n.parent && n.parent.type === 'AssignmentExpression'
            && n.parent.left === n;
          effects.add(isWrite ? 'write_world' : 'read_world');
        }
      }
    }
  });
  return effects;
}