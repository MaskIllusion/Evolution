// src/render/immortal-post.js
//
// The Immortal's impact layer. Sits in the composer after the
// render pass and after bloom. Reads the shock ring from the SAB
// and distorts the frame radially around each live shock shell.
//
// This is *screen-space* work. The shock's actual world-space
// push happens in the sim worker (applyImmortalShocks). This
// file only makes the air look like it was hit.
//
// Uniforms driven from SAB:
//   IIO_POST_PARAMS_BASE   — radialDistort, chroma, darken, flash
//   shock ring             — origin (x,z), radius, strength
//   agitation              — pushes the whole effect intensity
//   kin state              — dashing → flash, teleporting → high chroma

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ── SAB layout — must match src/sim/shared-buffer.js ─────────
const POSTURE_BASE   = 512;
const STATE_BASE     = 520;
const KINETICS_BASE  = 772;
const SHOCK_BASE     = 788;
const SHOCK_HEAD     = 980;
const SHOCK_COUNT    = 981;
const SHOCK_SLOTS    = 16;
const SHOCK_STRIDE   = 12;
const AGITATION_OFF  = 1024;
const POST_PARAMS_BASE = 1180;

// The population render group sits at y = -5950. Shock origins
// written in sim space must be lifted by the same amount before
// projection.
const WORLD_Y_OFFSET = -5950;

// Same scale the immortal group uses. Applied to shock radius in
// sim units to get radius in world units.
const IMMORTAL_SCALE = 1500;

// ── Shader ───────────────────────────────────────────────────
const ImmortalPostShader = {
  uniforms: {
    tDiffuse:        { value: null },
    tPrev:           { value: null },   // previous frame (motion smear)
    uTime:           { value: 0 },
    uResolution:     { value: new THREE.Vector2(1, 1) },

    // Body screen position (UV) — used for motion smear
    uBodyUV:         { value: new THREE.Vector2(0.5, 0.5) },
    uBodyUVPrev:     { value: new THREE.Vector2(0.5, 0.5) },

    // Global drivers
    uAgitation:      { value: 0 },
    uSpeedNorm:      { value: 0 },
    uKinState:       { value: 0 },
    uRadialDistort:  { value: 0 },      // from POST_PARAMS[0]
    uChroma:         { value: 0 },      // from POST_PARAMS[1]
    uDarken:         { value: 0 },      // from POST_PARAMS[2]
    uFlash:          { value: 0 },      // from POST_PARAMS[3]

    // Shock ring, packed as vec4 (centerUV.x, centerUV.y, radiusUV, strength)
    uShocks:         { value: Array.from({ length: SHOCK_SLOTS },
                          () => new THREE.Vector4()) },
    uShockCount:     { value: 0 },

    // Motion smear strength (0..1). Non-zero only during teleport.
    uSmear:          { value: 0 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tPrev;
    uniform vec2  uResolution;
    uniform vec2  uBodyUV, uBodyUVPrev;
    uniform float uTime, uAgitation, uSpeedNorm, uKinState;
    uniform float uRadialDistort, uChroma, uDarken, uFlash, uSmear;
    uniform vec4  uShocks[${SHOCK_SLOTS}];
    uniform float uShockCount;

    varying vec2 vUv;

    // Aspect-corrected UV distance, so radial effects are round
    // regardless of viewport shape.
    vec2 aspectUV(vec2 uv){
      return (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    }

    void main(){
      vec2 uv = vUv;

      // ── 1. Accumulate shock displacement ───────────────────
      // For each live shock, compute a radial push whose
      // magnitude is a Gaussian shell around the shock radius.
      // The direction is outward from the shock center in
      // screen space. Aspect-corrected so the shell is circular.
      vec2  disp  = vec2(0.0);
      float dark  = 0.0;
      float flash = 0.0;

      for (int i = 0; i < ${SHOCK_SLOTS}; i++){
        if (float(i) >= uShockCount) break;
        vec4 s = uShocks[i];
        if (s.w < 0.005) continue;

        vec2  sc = aspectUV(s.xy);
        vec2  pc = aspectUV(uv);
        vec2  d  = pc - sc;
        float dist = length(d) + 1e-5;
        float rUV  = s.z;                    // radius in aspect-UV units
        float shell = dist - rUV;

        // Shell profile — tight ring, moves outward with radius.
        float sigma = 0.06 + s.w * 0.10;
        float g = exp(-(shell * shell) / (2.0 * sigma * sigma));

        // Radial outward push.
        vec2 dir = d / dist;
        disp += dir * g * s.w * uRadialDistort * 0.05;

        // Dark band just behind the shell (negative-space feel).
        dark += g * s.w * uDarken;

        // Flash only at the very front of the newest shell.
        flash += g * s.w * uFlash;
      }

      // ── 2. Motion smear ────────────────────────────────────
      // When the body jumps (teleport), blend the previous frame
      // into the current one along the screen-space jump vector.
      // The jump direction is used to offset the sample, so the
      // smear trails backwards from the new position.
      vec3 col;
      if (uSmear > 0.001){
        vec2 jump = uBodyUV - uBodyUVPrev;
        // Sample the previous frame at a UV pulled along the
        // jump vector, so the smear stretches across the gap.
        vec3 prevA = texture2D(tPrev, uv - jump * 0.5).rgb;
        vec3 prevB = texture2D(tPrev, uv).rgb;
        vec3 prev  = max(prevA, prevB);

        // ── 3. Chroma aberration ─────────────────────────────
        vec2 off = disp;
        float ca = uChroma * (0.6 + uSpeedNorm * 1.4);
        vec3 curr;
        curr.r = texture2D(tDiffuse, uv + off + vec2( ca, 0.0)).r;
        curr.g = texture2D(tDiffuse, uv + off).g;
        curr.b = texture2D(tDiffuse, uv + off + vec2(-ca, 0.0)).b;

        col = mix(curr, max(prev * 0.85, curr), uSmear);
      } else {
        // ── 3b. Chroma aberration (no smear path) ────────────
        vec2 off = disp;
        float ca = uChroma * (0.6 + uSpeedNorm * 1.4);
        col.r = texture2D(tDiffuse, uv + off + vec2( ca, 0.0)).r;
        col.g = texture2D(tDiffuse, uv + off).g;
        col.b = texture2D(tDiffuse, uv + off + vec2(-ca, 0.0)).b;
      }

      // ── 4. Darken + flash ──────────────────────────────────
      col *= (1.0 - clamp(dark, 0.0, 0.7));
      col += vec3(1.0, 0.94, 0.82) * clamp(flash, 0.0, 1.2);

      // ── 5. Global agitation tint ───────────────────────────
      // As agitation rises, the whole frame picks up a hot
      // fringe at the corners. Subtle but present.
      vec2 ac = aspectUV(uv);
      float vig = dot(ac, ac);
      col += vec3(1.0, 0.35, 0.08) * vig * uAgitation * 0.10;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ── Registration ─────────────────────────────────────────────

export function register(World, Engine, sim){
  console.log('[immortal-post] register v1 · kinetic impact');

  const composer = Engine.composer;
  if (!composer){
    console.warn('[immortal-post] no composer — post FX disabled');
    return;
  }

  const block = sim.immortalIO;

  // Persistent previous-frame RT for motion smear. Sized to
  // match the current canvas; resized when the canvas resizes.
  const w = Engine.renderer.domElement.width;
  const h = Engine.renderer.domElement.height;

  const prevRT = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false,
  });

  // Build the pass and insert it into the composer. We want it
  // after the grade pass so the chroma + vignette of the base
  // look are already baked in.
  const pass = new ShaderPass(ImmortalPostShader);
  pass.uniforms.tPrev.value = prevRT.texture;
  pass.uniforms.uResolution.value.set(w, h);

  // Insert after the last existing pass. If no pass has been added
  // yet, this still works — composer.render() will handle it.
  composer.addPass(pass);

  // ── Blit helper: copy composer output to prevRT ─────────────
  // We need a small render pass that runs *after* the composer
  // so we can snapshot the frame for the next tick's motion smear.
  // Three.js doesn't offer an "after composer" hook, so we render
  // a copy quad ourselves once per frame using the renderer.
  const copyScene = new THREE.Scene();
  const copyCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const copyMat   = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tSrc;
      varying vec2 vUv;
      void main(){ gl_FragColor = texture2D(tSrc, vUv); }
    `,
    depthTest: false, depthWrite: false,
  });
  const copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMat);
  copyQuad.frustumCulled = false;
  copyScene.add(copyQuad);

  // Reuse vectors for projection.
  const _v3 = new THREE.Vector3();
  const _v3b = new THREE.Vector3();

  // Project a world-space point to UV.
  function projectToUV(x, y, z, out) {
    _v3.set(x, y + WORLD_Y_OFFSET, z);
    _v3.project(Engine.camera);
    out.set(_v3.x * 0.5 + 0.5, _v3.y * 0.5 + 0.5);
  }

  // For each live shock: project origin + project a point at
  // origin + radius along world X, take the UV distance as the
  // screen-space radius. Cheap; good enough for a stylized effect.
  const _uvA = new THREE.Vector2();
  const _uvB = new THREE.Vector2();
  const _uvC = new THREE.Vector2();

  function packShocks() {
    const head  = block[SHOCK_HEAD] | 0;
    const count = Math.min(SHOCK_SLOTS, block[SHOCK_COUNT] | 0);
    pass.uniforms.uShockCount.value = count;

    for (let i = 0; i < SHOCK_SLOTS; i++) {
      const v = pass.uniforms.uShocks.value[i];
      if (i >= count) { v.set(0, 0, 0, 0); continue; }

      const slot = (head - 1 - i + SHOCK_SLOTS) % SHOCK_SLOTS;
      const b = SHOCK_BASE + slot * SHOCK_STRIDE;

      const sx = block[b + 0] || 0;
      const sy = block[b + 1] || 0;
      const sz = block[b + 2] || 0;
      const radiusSim = block[b + 6] || 0;
      const strength  = block[b + 8] || 0;
      // Same conversion the raymarcher uses: sim units → world
      // units through both IMMORTAL_SCALE and the body's own
      // scale factor (0.4). Keeps shock size matched to SDF size.
      const radiusWorld = radiusSim * IMMORTAL_SCALE * 0.4;

      // Project center.
      projectToUV(sx, sy, sz, _uvA);
      // Project a point at center + radius along world X.
      _v3b.set(sx + radiusWorld, sy, sz);
      _v3b.y += WORLD_Y_OFFSET;
      _v3b.project(Engine.camera);
      _uvC.set(_v3b.x * 0.5 + 0.5, _v3b.y * 0.5 + 0.5);

      const rUV = Math.hypot(_uvC.x - _uvA.x, _uvC.y - _uvA.y);

      v.set(_uvA.x, _uvA.y, rUV, strength);
    }
  }

  // ── Previous body UV, for motion smear direction ────────────
  const _bodyUVPrev = new THREE.Vector2(0.5, 0.5);
  const _bodyUVNow  = new THREE.Vector2(0.5, 0.5);

  function readBodyUV() {
    const bx = block[POSTURE_BASE + 0] || 0;
    const by = block[POSTURE_BASE + 1] || 0;
    const bz = block[POSTURE_BASE + 2] || 0;
    projectToUV(bx, by, bz, _bodyUVNow);
  }

  // ── Per-frame update (called from the render loop) ──────────

  World.registerSystem('immortal-post', {
    order: 100,   // after the immortal-render system (55)

    init(){ this.pass = pass; },

    update(dt, t){
      readBodyUV();
      packShocks();

      const kinState = block[KINETICS_BASE + 0] | 0;
      const speed    = block[KINETICS_BASE + 6] || 0;
      const speedN   = Math.min(1, speed / 3600);

      pass.uniforms.uTime.value      = t;
      pass.uniforms.uAgitation.value = block[AGITATION_OFF] || 0;
      pass.uniforms.uSpeedNorm.value = speedN;
      pass.uniforms.uKinState.value  = kinState;

      const P = POST_PARAMS_BASE;
      pass.uniforms.uRadialDistort.value = block[P + 0] || 0;
      pass.uniforms.uChroma.value        = block[P + 1] || 0;
      pass.uniforms.uDarken.value        = block[P + 2] || 0;
      pass.uniforms.uFlash.value         = block[P + 3] || 0;

      pass.uniforms.uBodyUV.value.copy(_bodyUVNow);
      pass.uniforms.uBodyUVPrev.value.copy(_bodyUVPrev);

      // Motion smear active only during the teleport state. The
      // jump distance drives the smear strength so a long
      // teleport smears harder.
      const jumpDist = _bodyUVNow.distanceTo(_bodyUVPrev);
      const smear = kinState === 4
        ? Math.min(1.0, jumpDist * 6.0)
        : Math.max(0, pass.uniforms.uSmear.value - dt * 4.0);
      pass.uniforms.uSmear.value = smear;

      _bodyUVPrev.copy(_bodyUVNow);

      // ── Snapshot the frame into prevRT for next-tick smear ──
      // We read from composer's write target. That's stored in
      // composer.renderTarget2 (or 1) depending on parity. We
      // snapshot the *scene* target (before the post pass) so
      // the smear feeds forward from the same stage each frame.
      // Simpler + more stable: copy the previous composer output
      // via the grade pass texture. That texture is whatever
      // the previous pass wrote. We grab it here.
      const prevTexture = Engine.gradePass?.uniforms?.tDiffuse?.value
                       || Engine.renderer.domElement;
      copyMat.uniforms.tSrc.value = prevTexture;

      const oldTarget = Engine.renderer.getRenderTarget();
      Engine.renderer.setRenderTarget(prevRT);
      Engine.renderer.render(copyScene, copyCam);
      Engine.renderer.setRenderTarget(oldTarget);
    },
  });

  // Resize handler.
  const origResize = Engine.resize;
  Engine.resize = function(){
    if (origResize) origResize.call(Engine);
    const nw = Engine.renderer.domElement.width;
    const nh = Engine.renderer.domElement.height;
    prevRT.setSize(nw, nh);
    pass.uniforms.uResolution.value.set(nw, nh);
  };

  console.log('[immortal-post] registered');
}