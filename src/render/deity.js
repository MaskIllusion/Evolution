// src/render/deity.js
//
// The god's render layer. A raymarched cube with an interior.
//
// The face of the god is almost nothing — a faint violet film.
// Behind it, a lattice recedes into void. The silhouette is a
// hard white line: the exact edge of the held form.
//
// Reads: deityIO posture, state, motion.
// Writes: nothing. The renderer only observes.

import * as THREE from 'three';

import {
  DIO_POSTURE_BASE, DIO_STATE_BASE, DIO_MOTION_BASE,
} from '../sim/shared-buffer.js';

const WORLD_Y_OFFSET = -5950;
const WORLD_SCALE = 2600.0;

export function register(World, Engine, sim) {
  console.log('[deity] register v1 · the monument');

  const IO = sim.deityIO;

  const uniforms = {
    uTime:        { value: 0 },
    uDeityPos:    { value: new THREE.Vector3() },
    uDeityScale:  { value: 1.0 },
    uVitality:    { value: 0.6 },
    uAgitation:   { value: 0.2 },
    uCoherence:   { value: 0.85 },
    uInvView:     { value: new THREE.Matrix4() },
    uInvProj:     { value: new THREE.Matrix4() },
    uCamPos:      { value: new THREE.Vector3() },
  };

  const GLSL_NOISE = `
    float hash13(vec3 p3){
      p3 = fract(p3 * 0.1031);
      p3 += dot(p3, p3.zyx + 31.32);
      return fract((p3.x + p3.y) * p3.z);
    }
    float vnoise(vec3 p){
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float n000 = hash13(i + vec3(0,0,0));
      float n100 = hash13(i + vec3(1,0,0));
      float n010 = hash13(i + vec3(0,1,0));
      float n110 = hash13(i + vec3(1,1,0));
      float n001 = hash13(i + vec3(0,0,1));
      float n101 = hash13(i + vec3(1,0,1));
      float n011 = hash13(i + vec3(0,1,1));
      float n111 = hash13(i + vec3(1,1,1));
      return mix(
        mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
        mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
    }
    float fbm3(vec3 p){
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 3; i++){ v += a * vnoise(p); p *= 2.05; a *= 0.5; }
      return v;
    }
  `;

  const raymarchMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:       uniforms.uTime,
      uDeityPos:   uniforms.uDeityPos,
      uDeityScale: uniforms.uDeityScale,
      uVitality:   uniforms.uVitality,
      uAgitation:  uniforms.uAgitation,
      uCoherence:  uniforms.uCoherence,
      uInvView:    uniforms.uInvView,
      uInvProj:    uniforms.uInvProj,
      uCamPos:     uniforms.uCamPos,
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime, uDeityScale, uVitality, uAgitation, uCoherence;
      uniform vec3  uDeityPos;
      uniform mat4  uInvView, uInvProj;
      uniform vec3  uCamPos;
      varying vec2 vUv;

      ${GLSL_NOISE}

      const float WORLD_SCALE = ${WORLD_SCALE.toFixed(1)};

      float boxSDF(vec3 q){
        vec3 a = abs(q) - vec3(1.0);
        return length(max(a, 0.0))
             + min(max(a.x, max(a.y, a.z)), 0.0);
      }

      void rayFromUV(vec2 uv, out vec3 ro, out vec3 rd){
        vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
        vec4 view = uInvProj * clip;
        view /= view.w;
        vec4 world = uInvView * vec4(view.xyz, 0.0);
        rd = normalize(world.xyz);
        ro = uCamPos;
      }

      float sdfWorld(vec3 pw){
        vec3 local = (pw - uDeityPos) / WORLD_SCALE;
        return boxSDF(local) * WORLD_SCALE;
      }

      vec3 sdfNormal(vec3 pw){
        float e = 12.0;
        return normalize(vec3(
          sdfWorld(pw + vec3(e,0,0)) - sdfWorld(pw - vec3(e,0,0)),
          sdfWorld(pw + vec3(0,e,0)) - sdfWorld(pw - vec3(0,e,0)),
          sdfWorld(pw + vec3(0,0,e)) - sdfWorld(pw - vec3(0,0,e))));
      }

      float godLattice(vec3 p, float t){
        vec3 q1 = p * 0.55 + vec3(0.0, t * 0.008, 0.0);
        vec3 q2 = p * 1.4  - vec3(t * 0.011, 0.0, t * 0.006);
        vec3 q3 = p * 3.6  + vec3(t * 0.014, t * 0.009, 0.0);

        float n1 = fbm3(q1);
        float n2 = fbm3(q2);
        float n3 = fbm3(q3);

        float e1 = 1.0 - abs(n1 - n2) * 3.2;
        e1 = pow(clamp(e1, 0.0, 1.0), 7.0);

        float e2 = 1.0 - abs(n2 - n3) * 4.4;
        e2 = pow(clamp(e2, 0.0, 1.0), 10.0);

        float r = length(p);
        float core = exp(-r * r * 2.2);

        return e1 * 0.55 + e2 * 0.30 + core * 0.15;
      }

      void main(){
        vec3 ro, rd;
        rayFromUV(vUv, ro, rd);

        float BOX = WORLD_SCALE * 1.5;
        vec3 bmin = uDeityPos - vec3(BOX);
        vec3 bmax = uDeityPos + vec3(BOX);
        vec3 t0 = (bmin - ro) / (rd + 1e-8);
        vec3 t1 = (bmax - ro) / (rd + 1e-8);
        vec3 tsmall = min(t0, t1);
        vec3 tbig   = max(t0, t1);
        float tEnter = max(max(tsmall.x, tsmall.y), tsmall.z);
        float tExit  = min(min(tbig.x,   tbig.y),   tbig.z);
        if (tExit < 0.0 || tEnter > tExit) discard;

        float t = max(tEnter, 0.0);
        float tMax = tExit;
        bool hit = false;
        vec3 p = ro;
        for (int i = 0; i < 96; i++){
          p = ro + rd * t;
          float d = sdfWorld(p) / WORLD_SCALE;
          if (d < 0.004) { hit = true; break; }
          if (t > tMax) break;
          t += max(d * WORLD_SCALE * 0.92, 0.002 * WORLD_SCALE);
        }
        if (!hit) discard;

        vec3 N = sdfNormal(p);
        vec3 V = normalize(ro - p);
        float NdotV = max(dot(N, V), 0.0);

        float edge = pow(1.0 - NdotV, 8.0);

        float insideDepth = tExit - t;
        int STEPS = 20;
        float stepLen = insideDepth / float(STEPS);

        vec3 interior = vec3(0.0);
        float trans = 1.0;

        vec3 voidCol  = vec3(0.005, 0.006, 0.020);
        vec3 violet   = vec3(0.35, 0.10, 0.55);
        vec3 cobalt   = vec3(0.15, 0.35, 0.95);
        vec3 pale     = vec3(0.80, 0.90, 1.00);

        for (int i = 0; i < 20; i++){
          if (i >= STEPS) break;
          float ts = t + stepLen * (float(i) + 0.5);
          vec3 ps = ro + rd * ts;
          vec3 ls = (ps - uDeityPos) / WORLD_SCALE;

          float god = godLattice(ls, uTime);
          float depthFade = exp(-float(i) * 0.10);

          vec3 layerCol = mix(voidCol, violet, pow(god, 1.5));
          layerCol = mix(layerCol, cobalt, pow(god, 3.5));
          layerCol = mix(layerCol, pale, pow(god, 9.0));

          float density = god * 0.55 * depthFade + 0.008;

          float a = density * stepLen * 2.5;
          interior += layerCol * a * trans;
          trans *= (1.0 - a * 0.65);
        }

        vec3 membrane = vec3(1.0) * edge * 2.2;
        vec3 film = vec3(0.20, 0.15, 0.30) * (1.0 - NdotV) * 0.15;

        vec3 col = interior + membrane + film;

        float breath = 0.98 + 0.02 * sin(uTime * 0.12);
        col *= breath;

        col = col / (1.0 + col * 0.45);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), raymarchMat);
  fsQuad.frustumCulled = false;
  fsQuad.renderOrder = 901;
  Engine.scene.add(fsQuad);

  World.registerSystem('deity-render', {
    order: 56,
    init() { this.mesh = fsQuad; },
    update(dt, t) {
      const P = DIO_POSTURE_BASE;
      const S = DIO_STATE_BASE;

      uniforms.uDeityPos.value.set(
        IO[P + 0] || 0,
        (IO[P + 1] || 0) + WORLD_Y_OFFSET,
        IO[P + 2] || 0);
      uniforms.uDeityScale.value = IO[P + 7] || 1.0;

      uniforms.uVitality.value  = IO[S + 0] || 0.6;
      uniforms.uAgitation.value = IO[S + 2] || 0.2;
      uniforms.uCoherence.value = IO[S + 3] || 0.85;

      uniforms.uTime.value = t;

      const cam = Engine.camera;
      uniforms.uInvView.value.copy(cam.matrixWorld);
      uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
      uniforms.uCamPos.value.copy(cam.position);
    },
  });

  console.log('[deity] registered');
}