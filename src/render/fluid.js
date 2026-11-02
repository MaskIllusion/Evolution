// src/render/fluid.js
import * as THREE from 'three';

export function register(World, Engine, sim){
  const FLUID_RING = 8192;
  const geo  = new THREE.BufferGeometry();
  const posA = new Float32Array(FLUID_RING * 3);
  const valA = new Float32Array(FLUID_RING);
  const ageA = new Float32Array(FLUID_RING);
  geo.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  geo.setAttribute('aValue',   new THREE.BufferAttribute(valA, 1));
  geo.setAttribute('aAge',     new THREE.BufferAttribute(ageA, 1));
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:  { value: 0 },
      uColor: { value: new THREE.Color('#3aa8ff') },
    },
    vertexShader: `
      attribute float aValue;
      attribute float aAge;
      varying float vA;
      varying float vV;
      void main(){
        vA = 1.0 - aAge;
        vV = aValue;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 1.0);
        gl_PointSize = clamp((3.0 + 7.0 * aValue) * 3200.0 / dist, 1.5, 20.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uColor;
      varying float vA;
      varying float vV;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        if (r > 0.5) discard;
        float mask = smoothstep(0.5, 0.05, r);
        float a = mask * vA * vA * (0.25 + 0.70 * vV);
        vec3 col = uColor * (0.45 + 1.15 * vV);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.position.set(0, -6000, 0);
  Engine.scene.add(pts);

  World.registerSystem('fluid-render', {
    order: 54,
    init(){ this.mesh = pts; },
    update(dt, t){
      const D   = sim.deposit;
      const write = Atomics.load(sim.dephdr, 0);
      let w = 0;
      for (let k = 0; k < FLUID_RING; k++){
        const i = (write - 1 - k + FLUID_RING * 4) % FLUID_RING;
        const o = i * 8;
        const intensity = D[o + 6];
        if (intensity <= 0.001) continue;
        // valence (`D[o+7]`) written first, intensity (`D[o+6]`) last.
        // If intensity is nonzero, valence is guaranteed written.
        posA[w*3]     = D[o + 0];
        posA[w*3 + 1] = 0;
        posA[w*3 + 2] = D[o + 2];
        valA[w] = Math.min(1, intensity);
        ageA[w] = k / FLUID_RING;
        w++;
        if (w >= FLUID_RING) break;
      }
      geo.setDrawRange(0, w);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aValue.needsUpdate   = true;
      geo.attributes.aAge.needsUpdate     = true;
      mat.uniforms.uTime.value = t;
    }
  });
}