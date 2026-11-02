// src/render/struct.js
import { makeSABPoints } from './points.js';
import { STRUCT_MAX_CAP } from '../sim/shared-buffer.js';

export function register(World, Engine, sim){
  // Sized at the SAB cap, not the current bound.
  const STRUCT_MAX_R = STRUCT_MAX_CAP;
  const R = makeSABPoints(Engine, STRUCT_MAX_R, '#8a7cff', 8000, 4.0, 56.0);

  World.registerSystem('struct-render', {
    order: 56,
    init(){ this.mesh = R.points; },
    update(dt, t){
      const S = sim.struct;
      const n = Math.min(sim.worldhdr[2], STRUCT_MAX_R);
      let w = 0;
      for (let i = 0; i < n; i++){
        const o = i * 10;
        const integ = S[o + 2];
        if (integ <= 0.02) continue;
        const v = Math.min(1, integ);
        R.posArr[w*3]     = S[o + 0];
        R.posArr[w*3 + 1] = 0;
        R.posArr[w*3 + 2] = S[o + 1];
        R.valArr[w] = v;
        R.szArr[w]  = 3.0 + 6.0 * v;
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