// src/render/points.js
import * as THREE from 'three';

export function makeSABPoints(Engine, max, colorHex, scale, minPx, maxPx){
  const posArr = new Float32Array(max * 3);
  const valArr = new Float32Array(max);
  const szArr  = new Float32Array(max);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('aValue',   new THREE.BufferAttribute(valArr, 1));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(szArr,  1));
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:  { value: 0 },
      uColor: { value: new THREE.Color(colorHex) },
      uScale: { value: scale },
      uMinPx: { value: minPx },
      uMaxPx: { value: maxPx },
    },
    vertexShader: `
      attribute float aValue;
      attribute float aSize;
      uniform float uScale, uMinPx, uMaxPx;
      varying float vValue;
      void main(){
        vValue = aValue;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(-mv.z, 1.0);
        gl_PointSize = clamp(aSize * uScale / dist, uMinPx, uMaxPx);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uColor;
      varying float vValue;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        if (r > 0.5) discard;
        float mask = smoothstep(0.5, 0.18, r);
        float v = clamp(vValue, 0.0, 1.0);
        vec3 col = uColor * (0.35 + 1.1 * v);
        gl_FragColor = vec4(col, mask * (0.25 + 0.70 * v));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.position.set(0, -6000, 0);
  Engine.scene.add(points);

  return { posArr, valArr, szArr, geo, mat, points };
}