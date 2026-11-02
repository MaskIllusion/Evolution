// src/render/civilizations.js
import * as THREE from 'three';
import { STRUCT_MAX_CAP } from '../sim/shared-buffer.js';

export function register(World, Engine, sim){
  const group = new THREE.Group();
  group.position.set(0, -6000, 0);
  Engine.scene.add(group);

   const CLUSTER_RADIUS = 300;
  const MIN_CLUSTER    = 6;
  const MAX_CLUSTERS   = 60;
  // Sized at the SAB cap so it survives a swap without rebuild.
  const MAX_STRUCTS    = STRUCT_MAX_CAP;

  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0xa898c8, roughness: 0.72, metalness: 0.10,
    emissive: new THREE.Color(0x2a1050), emissiveIntensity: 0.85,
    flatShading: true,
  });
  const stoneGeo    = new THREE.ConeGeometry(6, 22, 5);
  const monolithGeo = new THREE.CylinderGeometry(10, 18, 120, 6);

  const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, MAX_STRUCTS);
  stones.frustumCulled = false;
  stones.count = 0;
  stones.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STRUCTS * 3), 3);
  group.add(stones);

  const monoliths = new THREE.InstancedMesh(monolithGeo, stoneMat, MAX_CLUSTERS);
  monoliths.frustumCulled = false;
  monoliths.count = 0;
  monoliths.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CLUSTERS * 3), 3);
  group.add(monoliths);

  const _dummy = new THREE.Object3D();
  const _color = new THREE.Color();

  function hueFromData(idx) {
    const d = sim.structData;
    const base = idx * 32;
    const s0 = d[base] + d[base + 1] * 3 + d[base + 2] * 7;
    return ((s0 / 128) % 1 + 1) % 1;
  }

  function findClusters(S, n) {
    const assigned = new Uint8Array(n);
    const clusters = [];
    const R2 = CLUSTER_RADIUS * CLUSTER_RADIUS;
    for (let i = 0; i < n; i++) {
      const io = i * 10;
      if (S[io + 2] <= 0 || assigned[i]) continue;
      const members = [i];
      assigned[i] = 1;
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < n; j++) {
          if (assigned[j]) continue;
          const jo = j * 10;
          if (S[jo + 2] <= 0) continue;
          for (let k = 0; k < members.length; k++) {
            const mo = members[k] * 10;
            const dx = S[jo] - S[mo], dz = S[jo + 1] - S[mo + 1];
            if (dx*dx + dz*dz < R2) {
              members.push(j);
              assigned[j] = 1;
              changed = true;
              break;
            }
          }
        }
      }
      if (members.length >= MIN_CLUSTER) clusters.push(members);
    }
    return clusters;
  }

  let scanTimer = 0;

  World.registerSystem('civilizations', {
    order: 57,
    init(){ this.group = group; this.stones = stones; this.monoliths = monoliths; },
    update(dt, t){
      scanTimer += dt;
      if (scanTimer < 1.5) return;
      scanTimer = 0;
      const S = sim.struct;
      const n = Math.min(sim.worldhdr[2], MAX_STRUCTS);

      let w = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 10;
        if (S[o + 2] <= 0.02) continue;
        _dummy.position.set(S[o], 10, S[o + 1]);
        _dummy.rotation.set(0, (S[o] * 0.1 + S[o + 1] * 0.3) % (Math.PI * 2), 0);
        _dummy.scale.setScalar(0.6 + S[o + 2] * 0.6);
        _dummy.updateMatrix();
        stones.setMatrixAt(w, _dummy.matrix);
        _color.setHSL(hueFromData(i), 0.7, 0.25 + S[o + 2] * 0.35);
        stones.setColorAt(w, _color);
        w++;
      }
      stones.count = w;
      stones.instanceMatrix.needsUpdate = true;
      stones.instanceColor.needsUpdate = true;

      const clusters = findClusters(S, n);
      let cw = 0;
      for (const members of clusters) {
        if (cw >= MAX_CLUSTERS) break;
        let cx = 0, cz = 0, hSum = 0;
        for (const m of members) { const mo = m * 10; cx += S[mo]; cz += S[mo + 1]; hSum += hueFromData(m); }
        cx /= members.length; cz /= members.length;
        _dummy.position.set(cx, 60, cz);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.setScalar(0.8 + Math.min(1.6, members.length / 25));
        _dummy.updateMatrix();
        monoliths.setMatrixAt(cw, _dummy.matrix);
        _color.setHSL((hSum / members.length) % 1, 0.65, 0.55);
        monoliths.setColorAt(cw, _color);
        cw++;
      }
      monoliths.count = cw;
      monoliths.instanceMatrix.needsUpdate = true;
      monoliths.instanceColor.needsUpdate = true;
    },
  });
}