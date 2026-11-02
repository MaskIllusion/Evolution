// src/render/corpse.js
import { makeSABPoints } from './points.js';
import { CORPSE_MAX_CAP } from '../sim/shared-buffer.js';

export function register(World, Engine, sim){
  // Sized at the SAB cap, not the current bound.
  const CORPSE_MAX_R = CORPSE_MAX_CAP;
  const R = makeSABPoints(Engine, CORPSE_MAX_R, '#c85a3a', 4200, 2.5, 32.0);

  World.registerSystem('corpse-render', {
    order: 56,
    init(){ this.mesh = R.points; },
    update(dt, t){
      const C = sim.corpse;
      const n = Math.min(sim.worldhdr[6], CORPSE_MAX_R);
      let w = 0;
      for (let i = 0; i < n; i++){
        const o = i * 5;
        if (C[o + 4] === 0) continue;
        const m = C[o + 2];
        if (m < 3) continue;
        const v = Math.min(1, m / 60);
        R.posArr[w*3]     = C[o + 0];
        R.posArr[w*3 + 1] = 0;
        R.posArr[w*3 + 2] = C[o + 1];
        R.valArr[w] = v;
        R.szArr[w]  = 3.0 + 7.0 * v;
        w++;
      }
      R.geo.setDrawRange(0, w);
      R.geo.attributes.position.needsUpdate = true;
      R.geo.attributes.aValue.needsUpdate   = true;
      R.geo.attributes.aSize.needsUpdate    = true;
      R.mat.uniforms.uTime.value = t;
    }
  });
}