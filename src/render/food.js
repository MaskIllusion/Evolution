// src/render/food.js
import * as THREE from 'three';
import { FOOD_MAX_CAP } from '../sim/shared-buffer.js';

export function register(World, Engine, sim){
  // Sized at the SAB cap, not the current bound.
  const MAX = FOOD_MAX_CAP;

  const posArr = new Float32Array(MAX * 3);
  const valArr = new Float32Array(MAX);
  const szArr  = new Float32Array(MAX);
  const seedArr = new Float32Array(MAX);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('aValue',   new THREE.BufferAttribute(valArr, 1));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(szArr, 1));
  geo.setAttribute('aSeed',    new THREE.BufferAttribute(seedArr, 1));
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:     { value: 0 },
      uScale:    { value: 24000 },
      uMinPx:    { value: 4 },
      uMaxPx:    { value: 220 },
    },
    vertexShader: `
      attribute float aValue;
      attribute float aSize;
      attribute float aSeed;
      uniform float uScale, uMinPx, uMaxPx;
      varying float vValue;
      varying float vSeed;

      void main(){
        vValue = aValue;
        vSeed  = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 1.0);
        // Size grows sublinearly with growth value.
        float g = 0.5 + 0.5 * aValue;
        gl_PointSize = clamp(aSize * g * uScale / dist, uMinPx, uMaxPx);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      varying float vValue;
      varying float vSeed;

      float hash(float n){ return fract(sin(n) * 43758.5453); }

      void main(){
        vec2 p = gl_PointCoord;
        float x = p.x - 0.5;          // -0.5 to 0.5
        float y = 1.0 - p.y;          //  0 at bottom, 1 at top

        // Per-plant random phase for the wind sway
        float sway = sin(uTime * 1.4 + vSeed * 6.2831) * 0.06 * y;

        // Three blades at base positions with per-seed variation.
        float blades = 0.0;
        for (int i = 0; i < 3; i++) {
          float fi = float(i) - 1.0;
          float r = hash(vSeed * 7.3 + float(i) * 13.7);
          float baseX  = fi * 0.26 + (r - 0.5) * 0.12;
          float bladeH = 0.50 + r * 0.45;
          float curve  = baseX * y * 0.55 + sway;
          float xDist  = abs(x - baseX - curve);
          float width  = 0.045 + 0.015 * r;
          float blade  = smoothstep(width, 0.0, xDist);
          float hMask  = 1.0 - smoothstep(bladeH - 0.10, bladeH, y);
          blades = max(blades, blade * hMask);
        }

        if (blades < 0.05) discard;

        // Color: dark base, bright tip, saturation by growth.
        vec3 dark  = vec3(0.10, 0.22, 0.06);
        vec3 mid   = vec3(0.28, 0.55, 0.14);
        vec3 light = vec3(0.62, 0.98, 0.38);
        vec3 col = mix(dark, mid, smoothstep(0.0, 0.6, y));
        col = mix(col, light, smoothstep(0.6, 1.0, y));
        col *= (0.55 + 0.65 * vValue);
        // Slight per-plant hue shift.
        col.r *= 0.9 + 0.2 * vSeed;

        gl_FragColor = vec4(col, blades * 0.95);
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.position.set(0, -6000, 0);
  Engine.scene.add(points);

  World.registerSystem('food-render', {
    order: 56,
    init(){ this.mesh = points; },
    update(dt, t){
      const F = sim.food;
      const n = Math.min(sim.worldhdr[5], MAX);
      let w = 0;
      for (let i = 0; i < n; i++){
        const o = i * 6;
        if (F[o + 5] === 0) continue;
        const g = F[o + 2];
        if (g <= 0.03) continue;

        posArr[w*3]     = F[o + 0];
        posArr[w*3 + 1] = 0;
        posArr[w*3 + 2] = F[o + 1];
        valArr[w] = g;
        // Larger world-unit size per plant so tufts read at zoom.
        szArr[w]  = 12.0 + 30.0 * g;
        // Per-plant seed from the food array (hue) — stable per plant.
        seedArr[w] = F[o + 4] || 0.5;
        w++;
      }
      geo.setDrawRange(0, w);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aValue.needsUpdate   = true;
      geo.attributes.aSize.needsUpdate    = true;
      geo.attributes.aSeed.needsUpdate    = true;
      mat.uniforms.uTime.value = t;
    }
  });
}