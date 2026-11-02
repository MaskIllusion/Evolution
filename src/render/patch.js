 import * as THREE from 'three';

export function register(World, Engine, sim){
  const MAX = 32;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(col, 3));
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec3 aColor;
      varying vec3 vC;
      void main(){
        vC = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mv.z, 1.0);
        gl_PointSize = clamp(3200.0 / d * 40.0, 20.0, 400.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vC;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r) * 0.08;
        gl_FragColor = vec4(vC, a);
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.position.set(0, -5995, 0);
  Engine.scene.add(points);

  World.registerSystem('patch-render', {
    order: 55,
    init(){ this.mesh = points; },
    update(dt, t){
      const P = sim.patch;
      const n = sim.worldhdr[3];
      let w = 0;
      for (let i = 0; i < n && i < MAX; i++){
        const o = i * 8;
        pos[w*3]     = P[o + 0];
        pos[w*3 + 1] = 0;
        pos[w*3 + 2] = P[o + 1];
        const type = P[o + 5] | 0;
        if (type === 0){ col[w*3] = 0.5; col[w*3+1] = 0.9; col[w*3+2] = 0.5; }
        else if (type === 1){ col[w*3] = 1.0; col[w*3+1] = 0.3; col[w*3+2] = 0.2; }
        else { col[w*3] = 0.5; col[w*3+1] = 0.5; col[w*3+2] = 1.0; }
        w++;
      }
      geo.setDrawRange(0, w);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aColor.needsUpdate = true;
      mat.uniforms.uTime.value = t;
    },
  });
}