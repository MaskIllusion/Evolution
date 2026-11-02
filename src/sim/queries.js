// ── queries.js ──
// Free functions. No `this`. Every function reads from a `world` object.
//
// `world` must provide:
//   planeSize  : HALF-width of the plane (20000)
//   GRID       : 256
//   worldhdr   : Uint32Array(8)
//   beings     : Float32Array(MAX_BEINGS * 12)
//   food       : Float32Array(FOOD_MAX * 6)
//   corpse     : Float32Array(CORPSE_MAX * 5)
//   struct     : Float32Array(STRUCT_MAX * 10)
//   patch      : Float32Array(PATCH_MAX * 8)
//   fieldF     : Float32Array(GRID * GRID)
//   fieldD     : Float32Array(GRID * GRID)
//   fieldC     : Float32Array(GRID * GRID)

const BEING_STRIDE  = 12;
const FOOD_STRIDE   = 6;
const CORPSE_STRIDE = 5;
const STRUCT_STRIDE = 10;
const PATCH_STRIDE  = 8;

export function cellIndex(world, x, z){
  const G = world.GRID;
  const u = Math.min(0.999, Math.max(0, x / world.planeSize * 0.5 + 0.5));
  const v = Math.min(0.999, Math.max(0, z / world.planeSize * 0.5 + 0.5));
  const cx = Math.floor(u * G);
  const cy = Math.floor(v * G);
  return cy * G + cx;
}

export function nearestFood(world, x, z, range){
  const n = world.worldhdr[5];
  if (n === 0) return null;
  const F = world.food;
  const r2 = range * range;
  const cx = world.cellKey(x, z) % world.SPATIAL_N;
  const cz = (world.cellKey(x, z) / world.SPATIAL_N) | 0;
  const R  = Math.ceil(range / world.GRID_CELL);
  let best = null, bestD2 = r2;
  for (let j = -R; j <= R; j++){
    const nz = cz + j; if (nz < 0 || nz >= world.SPATIAL_N) continue;
    for (let i = -R; i <= R; i++){
      const nx = cx + i; if (nx < 0 || nx >= world.SPATIAL_N) continue;
      const k = nz * world.SPATIAL_N + nx;
      let cur = world.foodCellHead[k];
      while (cur !== -1){
        const o = cur * FOOD_STRIDE;
        if (F[o + 5] !== 0){
          const dx = F[o] - x, dz = F[o + 1] - z;
          const d2 = dx*dx + dz*dz;
          if (d2 < bestD2 && F[o + 2] > 0.20){
            bestD2 = d2;
            best = { idx: cur, x: F[o], z: F[o + 1], growth: F[o + 2] };
          }
        }
        cur = world.foodCellNext[cur];
      }
    }
  }
  return best;
}

export function nearestCorpse(world, x, z, range){
  const n = world.worldhdr[6];
  if (n === 0) return null;
  const C = world.corpse;
  const r2 = range * range;
  const k0 = world.cellKey(x, z);
  const cx = k0 % world.SPATIAL_N;
  const cz = (k0 / world.SPATIAL_N) | 0;
  const R  = Math.ceil(range / world.GRID_CELL);
  let best = null, bestD2 = r2;
  for (let j = -R; j <= R; j++){
    const nz = cz + j; if (nz < 0 || nz >= world.SPATIAL_N) continue;
    for (let i = -R; i <= R; i++){
      const nx = cx + i; if (nx < 0 || nx >= world.SPATIAL_N) continue;
      const k = nz * world.SPATIAL_N + nx;
      let cur = world.corpseCellHead[k];
      while (cur !== -1){
        const o = cur * CORPSE_STRIDE;
        if (C[o + 4] !== 0){
          const dx = C[o] - x, dz = C[o + 1] - z;
          const d2 = dx*dx + dz*dz;
          if (d2 < bestD2){
            bestD2 = d2;
            best = { idx: cur, x: C[o], z: C[o + 1], mass: C[o + 2] };
          }
        }
        cur = world.corpseCellNext[cur];
      }
    }
  }
  return best;
}

export function nearestStructure(world, x, z, range){
  const n = world.worldhdr[2];
  if (n === 0) return null;
  const S = world.struct;
  const r2 = range * range;
  const k0 = world.cellKey(x, z);
  const cx = k0 % world.SPATIAL_N;
  const cz = (k0 / world.SPATIAL_N) | 0;
  const R  = Math.ceil(range / world.GRID_CELL);
  let best = null, bestD2 = r2;
  for (let j = -R; j <= R; j++){
    const nz = cz + j; if (nz < 0 || nz >= world.SPATIAL_N) continue;
    for (let i = -R; i <= R; i++){
      const nx = cx + i; if (nx < 0 || nx >= world.SPATIAL_N) continue;
      const k = nz * world.SPATIAL_N + nx;
      let cur = world.structCellHead[k];
      while (cur !== -1){
        const o = cur * STRUCT_STRIDE;
        if (S[o + 2] > 0){
          const dx = S[o] - x, dz = S[o + 1] - z;
          const d2 = dx*dx + dz*dz;
          if (d2 < bestD2){
            bestD2 = d2;
            best = { idx: cur, x: S[o], z: S[o + 1], integrity: S[o + 2] };
          }
        }
        cur = world.structCellNext[cur];
      }
    }
  }
  return best;
}

export function nearestDanger(world, x, z, range){
  const G = world.GRID;
  const cellSize = world.planeSize * 2 / G;
  const u = Math.min(0.999, Math.max(0, x / world.planeSize * 0.5 + 0.5));
  const v = Math.min(0.999, Math.max(0, z / world.planeSize * 0.5 + 0.5));
  const cx = Math.floor(u * G);
  const cy = Math.floor(v * G);
  const R = Math.max(1, Math.ceil(range / cellSize));
  const R2 = R * R;
  let best = 0, bestI = 0, bestJ = 0;
  const D = world.fieldD;
  for (let j = -R; j <= R; j++){
    const nj = cy + j;
    if (nj < 0 || nj >= G) continue;
    for (let i = -R; i <= R; i++){
      const ni = cx + i;
      if (ni < 0 || ni >= G) continue;
      if (i*i + j*j > R2) continue;
      const val = D[nj * G + ni];
      if (val > best){ best = val; bestI = i; bestJ = j; }
    }
  }
  if (best < 1.0) return null;
  return { x: x + bestI * cellSize, z: z + bestJ * cellSize };
}

export function nearestBeing(world, x, z, range, excludeId){
  const r2 = range * range;
  const k0 = world.cellKey(x, z);
  const cx = k0 % world.SPATIAL_N;
  const cz = (k0 / world.SPATIAL_N) | 0;
  const R  = Math.ceil(range / world.GRID_CELL);
  const B  = world.beings;
  let best = null, bestD2 = r2;
  for (let j = -R; j <= R; j++){
    const nz = cz + j; if (nz < 0 || nz >= world.SPATIAL_N) continue;
    for (let i = -R; i <= R; i++){
      const nx = cx + i; if (nx < 0 || nx >= world.SPATIAL_N) continue;
      const k = nz * world.SPATIAL_N + nx;
      let cur = world.beingCellHead[k];
      while (cur !== -1){
        const o = cur * BEING_STRIDE;
        if (B[o + 11] !== 0 && (excludeId === undefined || cur !== excludeId)){
          const dx = B[o] - x, dz = B[o + 2] - z;
          const d2 = dx*dx + dz*dz;
          if (d2 < bestD2){
            bestD2 = d2;
            best = { id: cur, x: B[o], z: B[o + 2], energy: B[o + 6] };
          }
        }
        cur = world.beingCellNext[cur];
      }
    }
  }
  return best;
}

export function nearestBeingInDirection(world, b, dx, dz, range){
  const len = Math.hypot(dx, dz);
  if (len < 0.001) return null;
  const ux = dx / len, uz = dz / len;
  const B = world.beings;
  const k0 = world.cellKey(b.x, b.z);
  const cx = k0 % world.SPATIAL_N;
  const cz = (k0 / world.SPATIAL_N) | 0;
  const R  = Math.ceil(range / world.GRID_CELL);
  let best = null, bestScore = 0.5;
  for (let j = -R; j <= R; j++){
    const nz = cz + j; if (nz < 0 || nz >= world.SPATIAL_N) continue;
    for (let i = -R; i <= R; i++){
      const nx = cx + i; if (nx < 0 || nx >= world.SPATIAL_N) continue;
      const k = nz * world.SPATIAL_N + nx;
      let cur = world.beingCellHead[k];
      while (cur !== -1){
        const o = cur * BEING_STRIDE;
        if (B[o + 11] !== 0 && cur !== b.id){
          const ddx = B[o] - b.x, ddz = B[o + 2] - b.z;
          const d = Math.hypot(ddx, ddz);
          if (d <= range && d >= 0.5){
            const align = (ddx * ux + ddz * uz) / d;
            if (align >= 0.5){
              const score = align - d / (range * 4);
              if (score > bestScore){
                bestScore = score;
                best = { id: cur, x: B[o], z: B[o + 2], energy: B[o + 6] };
              }
            }
          }
        }
        cur = world.beingCellNext[cur];
      }
    }
  }
  return best;
}

export function senseTrail(world, bx, bz, field, searchR = 4){
  const G = world.GRID;
  const u = Math.min(0.999, Math.max(0, bx / world.planeSize * 0.5 + 0.5));
  const v = Math.min(0.999, Math.max(0, bz / world.planeSize * 0.5 + 0.5));
  const cx = Math.floor(u * G);
  const cy = Math.floor(v * G);
  let best = 0, bestI = 0, bestJ = 0;
  for (let j = -searchR; j <= searchR; j++){
    const nj = cy + j;
    if (nj < 0 || nj >= G) continue;
    for (let i = -searchR; i <= searchR; i++){
      const ni = cx + i;
      if (ni < 0 || ni >= G) continue;
      const val = field[nj * G + ni];
      if (val < 0.05) continue;
      const dist = Math.max(1, Math.hypot(i, j));
      const weighted = val / dist;
      if (weighted > best){ best = weighted; bestI = i; bestJ = j; }
    }
  }
  if (best === 0) return { dx: 0, dz: 0 };
  const cellSize = world.planeSize * 2 / G;
  return {
    dx: Math.max(-127, Math.min(127, Math.round(bestI * cellSize / 50))),
    dz: Math.max(-127, Math.min(127, Math.round(bestJ * cellSize / 50))),
  };
}

export function depositFood(world, x, z, amount){
  const idx = cellIndex(world, x, z);
  const F = world.fieldF;
  F[idx] = Math.max(-20, Math.min(20, F[idx] + amount));
}

export function depositDanger(world, x, z, amount){
  const idx = cellIndex(world, x, z);
  const D = world.fieldD;
  D[idx] = Math.min(20, D[idx] + amount);
}

export function depositCustom(world, x, z, amount){
  const idx = cellIndex(world, x, z);
  const C = world.fieldC;
  C[idx] = Math.min(20, C[idx] + amount);
}

export function countBeingsInRadius(world, x, z, range){
  const r2 = range * range;
  const B  = world.beings;
  const k0 = world.cellKey(x, z);
  const cx = k0 % world.SPATIAL_N;
  const cz = (k0 / world.SPATIAL_N) | 0;
  const R  = Math.ceil(range / world.GRID_CELL);
  let n = 0;
  for (let j = -R; j <= R; j++){
    const nz = cz + j; if (nz < 0 || nz >= world.SPATIAL_N) continue;
    for (let i = -R; i <= R; i++){
      const nx = cx + i; if (nx < 0 || nx >= world.SPATIAL_N) continue;
      const k = nz * world.SPATIAL_N + nx;
      let cur = world.beingCellHead[k];
      while (cur !== -1){
        const o = cur * BEING_STRIDE;
        if (B[o + 11] !== 0){
          const dx = B[o] - x, dz = B[o + 2] - z;
          if (dx*dx + dz*dz < r2) n++;
        }
        cur = world.beingCellNext[cur];
      }
    }
  }
  return n;
}