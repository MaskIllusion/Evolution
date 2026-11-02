// src/render/terrain.js
import * as THREE from 'three';

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a,b,t) => a + (b - a) * t;

export function register(World, Engine, sim){
  World.registerSystem('terrain-render', {
    order: 3,
    init(){
      const SEG = 240;
      const geo = new THREE.PlaneGeometry(140000, 140000, SEG, SEG);
      geo.rotateX(-Math.PI / 2);

      const rnd = mulberry32(0x7E44);
      const PERM = new Uint8Array(512);
      for (let i = 0; i < 256; i++) PERM[i] = i;
      for (let i = 255; i > 0; i--){
        const j = (rnd() * (i + 1)) | 0;
        const t = PERM[i]; PERM[i] = PERM[j]; PERM[j] = t;
      }
      for (let i = 0; i < 512; i++) PERM[i] = PERM[i & 255];

      const fade = t => t*t*t*(t*(t*6-15)+10);
      const grad2 = (h, x, y) => {
        switch (h & 3){
          case 0: return x + y;
          case 1: return -x + y;
          case 2: return x - y;
          default: return -x - y;
        }
      };
      const noise2 = (x, y) => {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
        x -= Math.floor(x); y -= Math.floor(y);
        const u = fade(x), v = fade(y);
        const A = PERM[X] + Y, B = PERM[X + 1] + Y;
        return 0.5 + 0.5 * (lerp(
          lerp(grad2(PERM[A], x, y),         grad2(PERM[B], x - 1, y), u),
          lerp(grad2(PERM[A + 1], x, y - 1), grad2(PERM[B + 1], x - 1, y - 1), u),
          v
        ));
      };

      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++){
        const x = pos.getX(i);
        const z = pos.getZ(i);
        let h = 0, amp = 220, freq = 0.00009;
        for (let o = 0; o < 5; o++){
          h += amp * (noise2(x * freq + 3.1, z * freq + 7.7) - 0.5);
          amp  *= 0.5;
          freq *= 2.1;
        }
        pos.setY(i, h);
      }
      geo.computeVertexNormals();

      // Expose noise to other systems via World, so biome layer can
      // sample the same function the terrain mesh was built from.
      World._terrainNoise = noise2;
      World._terrainFbm = (x, z, oct = 5) => {
          let h = 0, amp = 220, freq = 0.00009;
          for (let o = 0; o < oct; o++){
              h += amp * (noise2(x * freq + 3.1, z * freq + 7.7) - 0.5);
              amp *= 0.5; freq *= 2.1;
          }
          return h;
      };

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uLow:  { value: new THREE.Color('#3a3858') },
          uMid:  { value: new THREE.Color('#4a4468') },
          uHigh: { value: new THREE.Color('#6a5c98') },
          uSun:  { value: new THREE.Vector3(0.45, 0.80, 0.30) },
          uTime: { value: 0 },
        },
        vertexShader: `
          varying float vY;
          varying vec3 vN;
          varying vec2 vXZ;
          void main(){
            vY = position.y;
            vXZ = position.xz;
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          precision highp float;
          uniform vec3 uLow, uMid, uHigh, uSun;
          uniform float uTime;
          varying float vY;
          varying vec3 vN;
          varying vec2 vXZ;
          void main(){
            float h = clamp((vY + 220.0) / 440.0, 0.0, 1.0);
            vec3 col = mix(uLow, uMid, smoothstep(0.0, 0.5, h));
            col = mix(col, uHigh, smoothstep(0.5, 1.0, h));
            float light = max(dot(normalize(vN), normalize(uSun)), 0.0);
            col *= 0.70 + 1.05 * light;

            // A visible lattice — the eye needs a surface to anchor on.
            // Cells are 500 world-units across, so the ground reads as
            // a landscape instead of a flat sheet.
            vec2 g = abs(fract(vXZ * 0.002 + vec2(uTime * 0.0006, 0.0)) - 0.5);
            float line = smoothstep(0.46, 0.50, max(g.x, g.y));
            float dist = length(vXZ) / 40000.0;
            float pulse = 0.85 + 0.15 * sin(uTime * 0.25 - dist * 30.0 + vXZ.x * 0.0005);
            col += vec3(0.14, 0.11, 0.22) * line * pulse;

            gl_FragColor = vec4(col, 1.0);
          }
        `,
        side: THREE.DoubleSide,
        fog: false
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, -6300, 0);
      mesh.frustumCulled = false;
      Engine.scene.add(mesh);
      this.mesh = mesh;
    },
    update(dt, t){
      if (this.mesh && this.mesh.material.uniforms.uTime){
        this.mesh.material.uniforms.uTime.value = t;
      }
    },
  });
}