// src/render/beings.js
import * as THREE from 'three';
import { MAX_BEINGS_CAP } from '../sim/shared-buffer.js';

const BANDS_MAX      = 12;
const BAND_SEGMENTS  = 16;
const ARMS_MAX       =  6;
const ARM_SEGMENTS   = 10;
const ARM_RADIAL     =  5;

/* ── template geometry ───────────────────────────────────────────────── */
// Emits one packed attribute `aCss` = (component, slot, segment, side).
// Vertex shader unpacks .x/.y/.z/.w from it.
function buildBeingGeometry(){
  const positions  = [];
  const css        = [];   // packed: comp, slot, seg, side
  const indices    = [];

  // CORE
  const core = new THREE.SphereGeometry(1.0, 24, 16);
  const corePos = core.attributes.position.array;
  const coreN   = corePos.length / 3;
  for (let i = 0; i < coreN; i++){
    positions.push(corePos[i*3], corePos[i*3+1], corePos[i*3+2]);
    css.push(0, 0, 0, 0);
  }
  for (const i of core.index.array) indices.push(i);

  // RIBBONS
  for (let b = 0; b < BANDS_MAX; b++){
    const base = positions.length / 3;
    for (let s = 0; s <= BAND_SEGMENTS; s++){
      for (let k = 0; k < 2; k++){
        positions.push(0, 0, 0);
        css.push(1, b, s, k);
      }
    }
    for (let s = 0; s < BAND_SEGMENTS; s++){
      const a0 = base + s * 2;
      const a1 = a0 + 1;
      const b0 = base + (s + 1) * 2;
      const b1 = b0 + 1;
      indices.push(a0, b0, a1, a1, b0, b1);
    }
  }

  // ARMS
  for (let a = 0; a < ARMS_MAX; a++){
    const base = positions.length / 3;
    for (let s = 0; s <= ARM_SEGMENTS; s++){
      for (let k = 0; k < ARM_RADIAL; k++){
        positions.push(0, 0, 0);
        css.push(2, a, s, k);
      }
    }
    for (let s = 0; s < ARM_SEGMENTS; s++){
      for (let k = 0; k < ARM_RADIAL; k++){
        const k1 = (k + 1) % ARM_RADIAL;
        const a0 = base + s * ARM_RADIAL + k;
        const a1 = base + s * ARM_RADIAL + k1;
        const b0 = base + (s + 1) * ARM_RADIAL + k;
        const b1 = base + (s + 1) * ARM_RADIAL + k1;
        indices.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',
    new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aCss',
    new THREE.Float32BufferAttribute(css, 4));
  geo.setIndex(indices);
  return geo;
}

/* ── vertex shader ───────────────────────────────────────────────────── */

const VERT = `
  precision highp float;

  attribute vec3 position;
  attribute mat4 instanceMatrix;

  uniform mat4 modelMatrix;
  uniform mat4 viewMatrix;
  uniform mat4 projectionMatrix;
  uniform vec3 cameraPosition;

  attribute vec4 aCss;

  attribute vec4 aState0;
  attribute vec4 aState1;
  attribute vec4 aMental0;
  attribute vec4 aMental1;
  attribute vec4 aShape0;
  attribute vec4 aShape1;
  attribute vec4 aShape2;
  attribute vec4 aShape3;
  attribute vec3 aVelocity;

  uniform float uTime;

  varying vec3  vLocalPos;
  varying vec3  vNormal;
  varying vec3  vViewDir;
  varying vec3  vColor;
  varying float vHeat;
  varying float vComponent;
  varying float vSlot;
  varying vec2  vSurfaceUv;
  varying float vThreat;
  varying float vArousal;
  varying float vCoherence;

  float hash13(vec3 p3){
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec3 p){
    vec3 i = floor(p);
    vec3 f = fract(p);
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
      mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y),
      f.z);
  }
  float fbm(vec3 p, int oct){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++){
      if (i >= oct) break;
      v += a * vnoise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  vec3 hsv2rgb(vec3 c){
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main(){
    float comp = aCss.x;
    float slot = aCss.y;
    float seg  = aCss.z;
    float side = aCss.w;

    float hue       = aState0.x;
    float energy    = aState0.y;
    float valence   = aState0.z;
    float coherence = aState0.w;
    float morph     = aState1.x;
    float merge     = aState1.y;
    float seed      = aState1.z;

    float arousal   = aMental0.x;
    float satiation = aMental0.y;
    float threat    = aMental0.z;
    float social    = aMental0.w;
    float biasX     = aMental1.x;
    float biasZ     = aMental1.y;
    float trace     = aMental1.z;
    float tempo     = aMental1.w;

    float coreR      = aShape0.x;
    float coreSquash = aShape0.y;
    float noiseAmp   = aShape0.z;
    float noiseFreq  = aShape0.w;
    float spineLen   = aShape1.x;
    float spineBend  = aShape1.y;
    float spineTwist = aShape1.z;
    float neckLen    = aShape1.w;
    float ribbonCnt  = aShape2.x;
    float ribbonR    = aShape2.y;
    float ribbonW    = aShape2.z;
    float ribbonFlap = aShape2.w;
    float armCnt     = aShape3.x;
    float armLen     = aShape3.y;
    float armCurve   = aShape3.z;
    float armTaper   = aShape3.w;

    float merg = clamp(merge, 0.0, 8.0);
    float e    = clamp(energy, 0.0, 1.0);
    float val  = clamp(valence, -1.0, 1.0);
    float coh  = clamp(coherence, 0.0, 1.0);
    float m    = clamp(morph, 0.0, 1.0);
    float threatC = clamp(threat, 0.0, 1.0);
    float arousC  = clamp(arousal, 0.0, 1.0);
    float satC    = clamp(satiation, 0.0, 1.0);

    float agg  = clamp(threatC * 0.55 + max(0.0, val) * 0.35 + m * 0.20, 0.0, 1.0);
    float calm = clamp(coh * (1.0 - agg), 0.0, 1.0);

    float mass = 1.0 + merg * 0.30;
    float inertia = 1.0 / mass;

    float bandCount = min(5.0 + floor(merg * 1.15), ribbonCnt * 12.0);
    float armCount  = min(2.0 + floor(merg * 0.55), armCnt * 6.0);

    vec3  pos;
    vec3  nrm;
    vec2  surfUv = vec2(0.5, 0.5);
    float heatOut;

    /* CORE */
    if (comp < 0.5){
      vec3 dir = normalize(position + 0.0001);

      float lumpAmp  = mix(0.22, 0.08, coh) + merg * 0.020 + m * 0.10;
      float lumpFreq = noiseFreq + merg * 0.25;
      float n  = fbm(dir * lumpFreq + vec3(seed * 41.0, uTime * 0.10, 0.0), 3);
      float n2 = vnoise(dir * (lumpFreq * 2.4)
                        + vec3(seed * 73.0, uTime * 0.35, 0.0));
      float ripple = vnoise(dir * 8.0 + vec3(uTime * 0.10, trace * 0.7, 0.0));
      float disp = (n - 0.5) * 2.0 * lumpAmp
                 + (n2 - 0.5) * 0.04 * (1.0 - coh)
                 + (ripple - 0.5) * 0.03 * (1.0 - coh);

      float breathRate = 0.35 + arousC * 0.75 + tempo * 0.25;
      float breathAmp  = 0.025 + satC * 0.020;
      float breath = 1.0 + breathAmp * e
                   * sin(uTime * breathRate + seed * 6.283);

      float baseR = coreR * (1.0 + merg * 0.045);
      vec3 ellip = vec3(
        baseR,
        baseR * (1.0 - coreSquash * 0.5),
        baseR
      );

      vec3 lean = vec3(biasX * 0.025, 0.0, biasZ * 0.025);

      pos = dir * ellip * breath * (1.0 + disp) + lean;
      nrm = dir;
      surfUv = vec2(dir.x * 0.5 + 0.5, dir.y * 0.5 + 0.5);
      heatOut = clamp(e * 0.15 + max(0.0, val) * 0.15 + merg * 0.02, 0.0, 1.0);
    }
    /* RIBBON */
    else if (comp < 1.5){
      float bIdx = slot;
      if (bIdx >= bandCount){
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vColor = vec3(0.0); vHeat = 0.0; vComponent = -1.0; vSlot = 0.0;
        vLocalPos = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0);
        vViewDir = vec3(0.0, 0.0, 1.0); vSurfaceUv = vec2(0.0);
        vThreat = 0.0; vArousal = 0.0; vCoherence = 0.0;
        return;
      }

      float t = seg / 16.0;
      float sideSign = side * 2.0 - 1.0;

      float bandPhase = (bIdx / max(bandCount, 1.0)) * 6.2831853
                      + seed * 6.2831853;

      float spinSpeed = 0.03 + agg * 0.12 + arousC * 0.08;
      float spin = uTime * spinSpeed + seed * 1.7;

      float turns = 1.15 + 0.45 * sin(bandPhase);
      float angle = bandPhase + t * 6.2831853 * turns + spin;

      float height = (t - 0.5) * spineLen * (1.25 + 0.30 * sin(bandPhase * 1.7))
                   + sin(angle * 0.7 + uTime * 0.20) * spineBend * 0.25;

      float baseRib = coreR * ribbonR * (1.0 + merg * 0.030);
      float hug = baseRib * 1.02;

      float flapSeed  = sin(t * 3.1415 + bandPhase * 2.1 + uTime * 0.35);
      float flapSeed2 = sin(t * 7.1 + bandPhase * 0.9 + uTime * 0.55);
      float flapAmt = smoothstep(0.55, 1.0, flapSeed * 0.5 + 0.5);
      float flare = (flapAmt * ribbonFlap * (0.03 + agg * 0.10 + arousC * 0.05)
                    + flapSeed2 * 0.008
                    - calm * 0.02);

      float r = hug + flare;

      vec3 p = vec3(cos(angle) * r, height, sin(angle) * r);

      float dA = 0.04;
      float a2 = angle + dA;
      float t2 = min(t + dA / turns, 1.0);
      vec3 p2 = vec3(cos(a2) * r, (t2 - 0.5) * spineLen * 1.30,
                     sin(a2) * r);
      vec3 tangent = normalize(p2 - p + vec3(0.0, 0.001, 0.0));

      vec3 radial = normalize(vec3(cos(angle), 0.0, sin(angle)));
      vec3 bitangent = normalize(cross(tangent, radial));

      float intoCore = smoothstep(0.0, 0.20, t)
                     * smoothstep(1.0, 0.80, t);
      float halfWidth = ribbonW * 0.85
                      * (1.0 + agg * 0.30)
                      * (0.65 + 0.35 * sin(t * 3.1415))
                      * intoCore;

      pos = p + bitangent * halfWidth * sideSign;
      nrm = normalize(cross(bitangent, tangent));
      surfUv = vec2(side, t);
      heatOut = clamp(0.10 + max(0.0, val) * 0.20 + merg * 0.015, 0.0, 1.0);
    }
    /* ARM */
    else {
      float aIdx = slot;
      if (aIdx >= armCount){
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vColor = vec3(0.0); vHeat = 0.0; vComponent = -1.0; vSlot = 0.0;
        vLocalPos = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0);
        vViewDir = vec3(0.0, 0.0, 1.0); vSurfaceUv = vec2(0.0);
        vThreat = 0.0; vArousal = 0.0; vCoherence = 0.0;
        return;
      }

      float t = seg / 10.0;
      float k = side;
      float ka = k / 5.0 * 6.2831853;

      float baseAngle = 3.14159265
                      + (aIdx / max(armCount, 1.0)) * 6.2831853
                      + sin(aIdx * 1.7 + seed * 3.1) * 0.35;

      vec3 attachDir = normalize(vec3(cos(baseAngle), 0.15, sin(baseAngle)));
      vec3 base = attachDir * coreR * (1.0 + merg * 0.04);

      float armL = armLen * (1.8 + agg * 0.9 + m * 0.5 + merg * 0.08);
      vec3 tipDir = normalize(vec3(cos(baseAngle), 0.55, sin(baseAngle)));
      vec3 tip = tipDir * armL;

      vec3 ctrl = mix(base, tip, 0.5)
                + vec3(0.0, 0.20 * armCurve, 0.0)
                + vec3(cos(baseAngle + 1.2), 0.0,
                       sin(baseAngle + 1.2)) * 0.12 * armCurve;

      float u = 1.0 - t;
      vec3 p = u*u*base + 2.0*u*t*ctrl + t*t*tip;

      float whipSpeed = 0.18 + agg * 0.35 + arousC * 0.15;
      float whipPhase = uTime * whipSpeed + aIdx * 1.9 + seed * 4.1;
      float whipAmp = (0.015 + 0.045 * agg + 0.020 * arousC)
                    * pow(t, 1.6) * inertia;
      vec3 whipTangent = vec3(cos(baseAngle + 1.57), 0.0,
                              sin(baseAngle + 1.57));
      p += whipTangent * sin(whipPhase) * whipAmp;
      p.y += cos(whipPhase * 0.7) * whipAmp * 0.5;

      float baseR = (0.22 + merg * 0.012) * (1.0 - armTaper * 0.35);
      float tipR  = 0.006 * (1.0 + armTaper * 0.5);
      float r = mix(baseR, tipR, pow(t, 1.3));

      vec3 armDir = normalize(tip - base);
      vec3 up = vec3(0.0, 1.0, 0.0);
      vec3 right = normalize(cross(armDir, up));
      if (length(right) < 0.01) right = vec3(1.0, 0.0, 0.0);
      vec3 realUp = normalize(cross(right, armDir));

      vec3 ringPos = right * cos(ka) + realUp * sin(ka);
      pos = p + ringPos * r;
      nrm = ringPos;
      surfUv = vec2(k / 5.0, t);
      heatOut = clamp(0.15 + merg * 0.020 + agg * 0.20, 0.0, 1.0);
    }

    /* velocity stretch — heavy */
    float vLen = length(aVelocity);
    if (vLen > 1e-4){
      vec3 vDir = normalize(aVelocity);
      float k2 = clamp(vLen * 0.5, 0.0, 0.4);
      float along = dot(pos, vDir);
      vec3 perp = pos - vDir * along;
      float sAlong = 1.0 + k2 * 0.14;
      float sPerp  = 1.0 - k2 * 0.05;
      pos = vDir * (along * sAlong) + perp * sPerp;
    }

    /* color */
    float hueOffset = comp < 0.5 ? 0.0 : merg * 0.045;
    float hueFinal = fract(hue + hueOffset + (seed - 0.5) * 0.03);

    float sat = mix(0.55, 0.90, heatOut);
    vec3 col = hsv2rgb(vec3(hueFinal, sat, 1.0));

    vec4 worldPos = modelMatrix * instanceMatrix * vec4(pos, 1.0);
    vec3 worldN   = normalize(mat3(instanceMatrix) * nrm);
    vec3 worldV   = normalize(cameraPosition - worldPos.xyz);

    vLocalPos  = normalize(pos);
    vNormal    = worldN;
    vViewDir   = worldV;
    vColor     = col;
    vHeat      = heatOut;
    vComponent = comp;
    vSlot      = slot;
    vSurfaceUv = surfUv;
    vThreat    = threatC;
    vArousal   = arousC;
    vCoherence = coh;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

/* ── fragment shader ─────────────────────────────────────────────────── */

const FRAG = `
  precision highp float;

  varying vec3  vLocalPos;
  varying vec3  vNormal;
  varying vec3  vViewDir;
  varying vec3  vColor;
  varying float vHeat;
  varying float vComponent;
  varying float vSlot;
  varying vec2  vSurfaceUv;
  varying float vThreat;
  varying float vArousal;
  varying float vCoherence;

  const vec3 KEY_DIR  = normalize(vec3( 0.35,  0.85,  0.40));
  const vec3 KEY_COL  = vec3(1.00,  0.92,  0.78);
  const vec3 RIM_DIR  = normalize(vec3(-0.55,  0.15, -0.82));
  const vec3 RIM_COL  = vec3(0.28,  0.42,  0.90);
  const vec3 FILL_DIR = normalize(vec3( 0.00, -0.95,  0.10));
  const vec3 FILL_COL = vec3(0.06,  0.07,  0.10);

  vec3 wetSurface(vec3 N, vec3 V, vec3 tint, float heat, float roughness){
    vec3 albedo = tint * 0.035 + vec3(0.010, 0.008, 0.012);

    float NdotK = max(dot(N, KEY_DIR), 0.0);
    float NdotR = max(dot(N, RIM_DIR), 0.0);

    // Two lights, no sheen, no fill. That was 60% of the
    // fragment cost per being. Population is now 200-unit
    // scale; the eye cannot resolve the missing lobe.
    vec3 col = albedo * KEY_COL * NdotK
             + albedo * RIM_COL * NdotR * 0.55;

    vec3 Hk = normalize(KEY_DIR + V);
    float spec = pow(max(dot(N, Hk), 0.0), mix(220.0, 40.0, roughness));
    col += mix(KEY_COL, tint, 0.15) * spec * 1.35;

    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += mix(tint * 0.5, vec3(0.9), 0.35) * fres * 0.30;

    col += tint * heat * 0.04;

    return col;
  }

  void main(){
    if (vComponent < -0.5) discard;

    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(vViewDir);

    vec3 col;

    if (vComponent < 0.5){
      col = wetSurface(N, V, vColor, vHeat, 0.05);

      vec3 LD = normalize(vLocalPos);
      float front = smoothstep(-0.15, 0.45, LD.z);

      float eyeX = abs(LD.x);
      float eyeY = abs(LD.y - 0.18);
      float eyeMask = smoothstep(0.075, 0.015, eyeX)
                    * smoothstep(0.20, 0.09, eyeY)
                    * front;

      float eyeHeat = clamp(vHeat * 0.5 + vArousal * 0.6 + vThreat * 0.5,
                            0.0, 1.0);
      vec3 eyeCol = mix(vec3(0.35, 0.14, 0.03),
                        vec3(1.00, 0.68, 0.30),
                        eyeHeat);
      col += eyeCol * eyeMask * (0.20 + eyeHeat * 0.85);

      float pupilR = 0.022 + vArousal * 0.020;
      float pupil = smoothstep(pupilR, pupilR * 0.35, eyeX)
                  * smoothstep(0.10, 0.03, eyeY) * front;
      col *= (1.0 - pupil * 0.90);

      float mouthX = abs(LD.x);
      float mouthY = abs(LD.y + 0.14);
      float mouthMask = smoothstep(0.28, 0.05, mouthX)
                      * smoothstep(0.075, 0.015, mouthY)
                      * front;
      col *= (1.0 - mouthMask * 0.80);
    }
    else if (vComponent < 1.5){
      col = wetSurface(N, V, vColor, vHeat, 0.30);

      float edgeDist = abs(vSurfaceUv.x - 0.5) * 2.0;
      float edge = smoothstep(0.85, 0.98, edgeDist);
      col += mix(vColor, vec3(1.0), 0.3) * edge * 0.14;

      float thread = sin(vSurfaceUv.y * 55.0 + vSlot * 7.3);
      col *= 1.0 + thread * 0.035;
    }
    else {
      col = wetSurface(N, V, vColor, vHeat, 0.08);

      float baseDark = smoothstep(0.25, 0.0, vSurfaceUv.y);
      col *= (1.0 - baseDark * 0.70);

      float tip = smoothstep(0.88, 1.0, vSurfaceUv.y);
      col += vec3(1.00, 0.94, 0.82) * tip * 0.55;

      float bladeLine = smoothstep(0.48, 0.50, abs(vSurfaceUv.x - 0.5))
                      * smoothstep(0.60, 0.30, vSurfaceUv.y);
      col += mix(vColor, vec3(1.0), 0.25) * bladeLine * 0.20;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ── registration ────────────────────────────────────────────────────── */

export function register(World, Engine, sim){
  console.log('[beings] register v8 · wet-metal');

  // Sized at the SAB cap, not the current bound. When the SAB
  // grows via the swap protocol (Step 6c-3), the instanced
  // buffers here already hold enough slots. Without this, an
  // out-of-bounds write into state0Arr would silently corrupt
  // adjacent memory.
  const MAX = MAX_BEINGS_CAP;
  const geo = buildBeingGeometry();

  // ── instanced attributes ────────────────────────────────────────────
  const state0Arr   = new Float32Array(MAX * 4);
  const state1Arr   = new Float32Array(MAX * 4);
  const mental0Arr  = new Float32Array(MAX * 4);
  const mental1Arr  = new Float32Array(MAX * 4);
  const shape0Arr   = new Float32Array(MAX * 4);
  const shape1Arr   = new Float32Array(MAX * 4);
  const shape2Arr   = new Float32Array(MAX * 4);
  const shape3Arr   = new Float32Array(MAX * 4);
  const velocityArr = new Float32Array(MAX * 3);

  const iAttr = (arr, n) =>
    new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);

  geo.setAttribute('aState0',   iAttr(state0Arr,   4));
  geo.setAttribute('aState1',   iAttr(state1Arr,   4));
  geo.setAttribute('aMental0',  iAttr(mental0Arr,  4));
  geo.setAttribute('aMental1',  iAttr(mental1Arr,  4));
  geo.setAttribute('aShape0',   iAttr(shape0Arr,   4));
  geo.setAttribute('aShape1',   iAttr(shape1Arr,   4));
  geo.setAttribute('aShape2',   iAttr(shape2Arr,   4));
  geo.setAttribute('aShape3',   iAttr(shape3Arr,   4));
  geo.setAttribute('aVelocity', iAttr(velocityArr, 3));

  const mat = new THREE.RawShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader:   VERT,
    fragmentShader: FRAG,
    transparent:    false,
    depthWrite:     true,
    depthTest:      true,
    side:           THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.count = 0;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.position.set(0, -5950, 0);
  group.add(mesh);
  Engine.scene.add(group);

  // ── CPU-side smoothing ──────────────────────────────────────────────
  const smoothX    = new Float32Array(MAX);
  const smoothZ    = new Float32Array(MAX);
  const smoothYaw  = new Float32Array(MAX);
  const smoothSize = new Float32Array(MAX);
  const prevX      = new Float32Array(MAX);
  const prevZ      = new Float32Array(MAX);
  const initFlag   = new Uint8Array(MAX);

  const _m    = new THREE.Matrix4();
  const _q    = new THREE.Quaternion();
  const _pos  = new THREE.Vector3();
  const _scl  = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);

  // Beings were rendering at ~6800 world units each with the
  // default gene. 1850 of them overlapping at that size gave a
  // single visual mass and dominated fragment cost. 200 puts
  // each being at roughly 1.5% of the plane width, so the
  // population reads as a dispersed field instead of a blob.
  const VISUAL_SCALE = 200;

  const DEFAULT_SHAPE = new Float32Array([
    0.70, 0.20, 0.15, 3.5,
    1.00, 0.15, 0.30, 0.50,
    0.60, 1.00, 0.10, 0.50,
    0.60, 1.00, 0.30, 0.50,
  ]);

  World.registerSystem('beings-render', {
    order: 56,
    init(){ this.group = group; },
    update(dt, t){
      const b = sim.beings;
      const shapeBuf = sim.shape;
      const stateBuf = sim.stateVis;
      let w = 0;
      const dtSafe = Math.max(dt, 1 / 240);

      for (let i = 0; i < MAX; i++){
        const o = i * 12;
        if (b[o + 11] < 0.5) continue;

        const tx   = b[o + 0];
        const tz   = b[o + 2];
        const tyaw = b[o + 3] || 0;

        const mergeCount = Math.min(8, b[o + 1] || 0);
        const sizeGene   = Math.max(1.2, b[o + 9] || 2);
        const sizeMul    = 1 + Math.min(1.4, mergeCount * 0.18);
        const targetSize = sizeGene * sizeMul;

        if (!initFlag[i]){
          smoothX[i] = prevX[i] = tx;
          smoothZ[i] = prevZ[i] = tz;
          smoothYaw[i] = tyaw;
          smoothSize[i] = targetSize;
          initFlag[i] = 1;
        } else {
          const sdt = Math.min(dt, 0.033);
          const k = 1 - Math.exp(-6 * sdt);
          prevX[i] = smoothX[i];
          prevZ[i] = smoothZ[i];
          smoothX[i] += (tx - smoothX[i]) * k;
          smoothZ[i] += (tz - smoothZ[i]) * k;
          let dy = tyaw - smoothYaw[i];
          while (dy >  Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          smoothYaw[i] += dy * k;
          const ks = 1 - Math.exp(-3 * sdt);
          smoothSize[i] += (targetSize - smoothSize[i]) * ks;
        }

        const hoverY = Math.sin(t * 0.35 + i * 0.17) * 8
                     + (b[o + 6] || 0) * 0.05;

        _pos.set(smoothX[i], hoverY, smoothZ[i]);
        _q.setFromAxisAngle(_yAxis, smoothYaw[i]);
        _scl.setScalar(smoothSize[i] * VISUAL_SCALE);
        _m.compose(_pos, _q, _scl);
        mesh.setMatrixAt(w, _m);

        const vx = (smoothX[i] - prevX[i]) / dtSafe;
        const vz = (smoothZ[i] - prevZ[i]) / dtSafe;

        // state0
        state0Arr[w*4]     = b[o + 8];
        state0Arr[w*4 + 1] = Math.min(1, (b[o + 6] || 0) / 200);
        state0Arr[w*4 + 2] = b[o + 10] || 0;
        state0Arr[w*4 + 3] = Math.min(1, b[o + 5] || 0);

        // state1
        state1Arr[w*4]     = Math.min(1, b[o + 4] || 0);
        state1Arr[w*4 + 1] = mergeCount;
        state1Arr[w*4 + 2] = ((i * 16807) % 2147483647) / 2147483647;
        state1Arr[w*4 + 3] = 0;

        // mental (state slots 0..7)
        if (stateBuf){
          const vo = i * 8;
          mental0Arr[w*4]     = stateBuf[vo + 0];
          mental0Arr[w*4 + 1] = stateBuf[vo + 1];
          mental0Arr[w*4 + 2] = stateBuf[vo + 2];
          mental0Arr[w*4 + 3] = stateBuf[vo + 3];
          mental1Arr[w*4]     = stateBuf[vo + 4];
          mental1Arr[w*4 + 1] = stateBuf[vo + 5];
          mental1Arr[w*4 + 2] = stateBuf[vo + 6];
          mental1Arr[w*4 + 3] = stateBuf[vo + 7];
        } else {
          mental0Arr[w*4] = mental0Arr[w*4+1] = 0;
          mental0Arr[w*4+2] = mental0Arr[w*4+3] = 0;
          mental1Arr[w*4] = mental1Arr[w*4+1] = 0;
          mental1Arr[w*4+2] = mental1Arr[w*4+3] = 0;
        }

        // shape genome
        const src = shapeBuf ? (i * 16) : -1;
        if (src >= 0){
          shape0Arr[w*4]     = shapeBuf[src +  0];
          shape0Arr[w*4 + 1] = shapeBuf[src +  1];
          shape0Arr[w*4 + 2] = shapeBuf[src +  2];
          shape0Arr[w*4 + 3] = shapeBuf[src +  3];
          shape1Arr[w*4]     = shapeBuf[src +  4];
          shape1Arr[w*4 + 1] = shapeBuf[src +  5];
          shape1Arr[w*4 + 2] = shapeBuf[src +  6];
          shape1Arr[w*4 + 3] = shapeBuf[src +  7];
          shape2Arr[w*4]     = shapeBuf[src +  8];
          shape2Arr[w*4 + 1] = shapeBuf[src +  9];
          shape2Arr[w*4 + 2] = shapeBuf[src + 10];
          shape2Arr[w*4 + 3] = shapeBuf[src + 11];
          shape3Arr[w*4]     = shapeBuf[src + 12];
          shape3Arr[w*4 + 1] = shapeBuf[src + 13];
          shape3Arr[w*4 + 2] = shapeBuf[src + 14];
          shape3Arr[w*4 + 3] = shapeBuf[src + 15];
        } else {
          shape0Arr[w*4]     = DEFAULT_SHAPE[ 0];
          shape0Arr[w*4 + 1] = DEFAULT_SHAPE[ 1];
          shape0Arr[w*4 + 2] = DEFAULT_SHAPE[ 2];
          shape0Arr[w*4 + 3] = DEFAULT_SHAPE[ 3];
          shape1Arr[w*4]     = DEFAULT_SHAPE[ 4];
          shape1Arr[w*4 + 1] = DEFAULT_SHAPE[ 5];
          shape1Arr[w*4 + 2] = DEFAULT_SHAPE[ 6];
          shape1Arr[w*4 + 3] = DEFAULT_SHAPE[ 7];
          shape2Arr[w*4]     = DEFAULT_SHAPE[ 8];
          shape2Arr[w*4 + 1] = DEFAULT_SHAPE[ 9];
          shape2Arr[w*4 + 2] = DEFAULT_SHAPE[10];
          shape2Arr[w*4 + 3] = DEFAULT_SHAPE[11];
          shape3Arr[w*4]     = DEFAULT_SHAPE[12];
          shape3Arr[w*4 + 1] = DEFAULT_SHAPE[13];
          shape3Arr[w*4 + 2] = DEFAULT_SHAPE[14];
          shape3Arr[w*4 + 3] = DEFAULT_SHAPE[15];
        }

        velocityArr[w*3]     = vx * 0.0125;
        velocityArr[w*3 + 1] = 0;
        velocityArr[w*3 + 2] = vz * 0.0125;

        w++;
      }

      mesh.count = w;

      geo.attributes.aState0.needsUpdate   = true;
      geo.attributes.aState1.needsUpdate   = true;
      geo.attributes.aMental0.needsUpdate  = true;
      geo.attributes.aMental1.needsUpdate  = true;
      geo.attributes.aShape0.needsUpdate   = true;
      geo.attributes.aShape1.needsUpdate   = true;
      geo.attributes.aShape2.needsUpdate   = true;
      geo.attributes.aShape3.needsUpdate   = true;
      geo.attributes.aVelocity.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate      = true;

      mat.uniforms.uTime.value = t;
    }
  });
}