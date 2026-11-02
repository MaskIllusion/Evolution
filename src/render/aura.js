// src/render/aura.js
import * as THREE from 'three';
import { MAX_BEINGS_CAP } from '../sim/shared-buffer.js';

export function register(World, Engine, sim){
  const MAX = 2000;                    // particle budget, unchanged
  const SIM_MAX = MAX_BEINGS_CAP;      // iteration bound, at cap

  const posArr = new Float32Array(MAX * 3);
  const colArr = new Float32Array(MAX * 3);
  const szArr  = new Float32Array(MAX);
  const ageArr = new Float32Array(MAX);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(colArr, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(szArr,  1));
  geo.setAttribute('aAge',     new THREE.BufferAttribute(ageArr, 1));
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec3  aColor;
      attribute float aSize;
      attribute float aAge;
      varying vec3  vColor;
      varying float vAge;
      void main(){
        vColor = aColor;
        vAge = aAge;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 1.0);
        gl_PointSize = clamp(aSize * (1200.0 / dist), 1.5, 18.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3  vColor;
      varying float vAge;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        if (r > 0.5) discard;
        float mask = smoothstep(0.5, 0.05, r);
        float fade = pow(1.0 - vAge, 1.5);
        gl_FragColor = vec4(vColor * (0.9 + (1.0 - vAge) * 1.2),
                            mask * fade * 0.85);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.position.set(0, -6000, 0);
  Engine.scene.add(points);

  const particles = new Array(MAX);
  for (let i = 0; i < MAX; i++){
    particles[i] = {
      active: false,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      hue: 0,
      age: 0, maxAge: 1.0, size: 3,
    };
  }
  let cursor = 0;

  function hsv2rgb(h, s, v){
    const hue6 = h * 6;
    const hh = Math.floor(hue6);
    const f = hue6 - hh;
    const q = 1 - f;
    let r, g, b;
    switch (hh % 6){
      case 0: r = 1; g = f; b = 0; break;
      case 1: r = q; g = 1; b = 0; break;
      case 2: r = 0; g = 1; b = f; break;
      case 3: r = 0; g = q; b = 1; break;
      case 4: r = f; g = 0; b = 1; break;
      case 5: r = 1; g = 0; b = q; break;
    }
    return [r * v, g * v, b * v];
  }

  World.registerSystem('beings-aura', {
    order: 58,
    init(){ this.mesh = points; },
    update(dt, t){
      const B = sim.beings;

      // Age existing particles.
      for (let i = 0; i < MAX; i++){
        const p = particles[i];
        if (!p.active) continue;
        p.age += dt;
        if (p.age >= p.maxAge){
          p.active = false;
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.vz *= 0.96;
        p.vy += 4 * dt;
      }

      // Emit particles only from beings that carry 3+ absorbed guests.
      // A single symbiont no longer triggers the aura. The aura is a
      // marker of deep merges, not a general host glow.
      let emitted = 0;
      const MAX_EMIT = 8;   // was 30 — 4x less
      for (let i = 0; i < SIM_MAX && emitted < MAX_EMIT; i++){
        const o = i * 12;
        if (B[o + 11] < 0.5) continue;
        const symCount = B[o + 1] | 0;
        if (symCount < 3) continue;   // was 1
        const emitN = Math.min(2, Math.floor(symCount / 2));
        for (let k = 0; k < emitN && emitted < MAX_EMIT; k++){
          const p = particles[cursor];
          cursor = (cursor + 1) % MAX;
          const a = Math.random() * Math.PI * 2;
          const rad = 20 + Math.random() * 40;
          p.active = true;
          p.x = B[o + 0] + Math.cos(a) * rad;
          p.y = Math.random() * 10 - 5;
          p.z = B[o + 2] + Math.sin(a) * rad;
          const sp = 15 + Math.random() * 25;
          p.vx = Math.cos(a) * sp;
          p.vy = 5 + Math.random() * 15;
          p.vz = Math.sin(a) * sp;
          // Symbiont hue drifts toward violet from the host hue.
          p.hue = (B[o + 8] + 0.42 + Math.random() * 0.18) % 1;
          p.age = 0;
          p.maxAge = 0.4 + Math.random() * 0.3;   // was 0.8-1.4
          p.size = 3 + Math.random() * 4;         // was 4-9
          emitted++;
        }
      }

      // Write live particles to GPU buffers.
      let w = 0;
      for (let i = 0; i < MAX; i++){
        const p = particles[i];
        if (!p.active) continue;
        posArr[w*3]     = p.x;
        posArr[w*3 + 1] = p.y;
        posArr[w*3 + 2] = p.z;
        const [r, g, b] = hsv2rgb(p.hue, 0.7, 1.0);
        colArr[w*3]     = r * 0.5 + 0.5;
        colArr[w*3 + 1] = g * 0.5 + 0.5;
        colArr[w*3 + 2] = b * 0.5 + 0.5;
        szArr[w]  = p.size;
        ageArr[w] = p.age / p.maxAge;
        w++;
      }
      geo.setDrawRange(0, w);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aColor.needsUpdate   = true;
      geo.attributes.aSize.needsUpdate    = true;
      geo.attributes.aAge.needsUpdate     = true;
      mat.uniforms.uTime.value = t;
    }
  });
}