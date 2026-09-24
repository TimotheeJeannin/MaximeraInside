import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const STEP = 1; // mm between sampled heights

// Measures the usable space inside a drawer model (Y-up, open at the top, in mm).
// Each wall gets a base position (tightest point) and a profile of how far it
// recedes above that, so parts touching the wall can follow rounded corners.
export function detectInterior(object) {
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    if (o.isMesh && !o.geometry.boundsTree) o.geometry.computeBoundsTree();
  });

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;

  const cast = (origin, dir) => {
    rc.set(origin, dir);
    const hit = rc.intersectObject(object, true)[0];
    return hit ? hit.distance : null;
  };

  const floors = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const o = new THREE.Vector3(c.x + i * 0.08 * size.x, box.max.y + 1, c.z + j * 0.08 * size.z);
      const d = cast(o, new THREE.Vector3(0, -1, 0));
      if (d !== null) floors.push(o.y - d);
    }
  }
  if (!floors.length) return null;
  floors.sort((a, b) => a - b);
  const floorY = floors[floors.length >> 1];

  const levels = Math.floor((box.max.y - floorY) / STEP);
  const heightAt = (k) => Math.max(0.5, k * STEP);
  const dirs = {
    xMax: { v: new THREE.Vector3(1, 0, 0), axis: 'x', perp: 'z', sign: 1 },
    xMin: { v: new THREE.Vector3(-1, 0, 0), axis: 'x', perp: 'z', sign: -1 },
    zMax: { v: new THREE.Vector3(0, 0, 1), axis: 'z', perp: 'x', sign: 1 },
    zMin: { v: new THREE.Vector3(0, 0, -1), axis: 'z', perp: 'x', sign: -1 },
  };

  // Distance from the centre to the closest wall hit, per wall and height.
  const raw = {};
  for (const [key, d] of Object.entries(dirs)) {
    raw[key] = [];
    for (let k = 0; k <= levels; k++) {
      let best = null;
      for (let s = -2; s <= 2; s++) {
        const o = c.clone();
        o.y = floorY + heightAt(k);
        o[d.perp] += s * 0.2 * size[d.perp];
        const dist = cast(o, d.v);
        if (dist === null) continue;
        const reach = o[d.axis] + d.sign * dist - c[d.axis];
        best = best === null ? d.sign * reach : Math.min(best, d.sign * reach);
      }
      raw[key].push(best);
    }
  }

  const topHit = (arr) => arr.findLastIndex((v) => v !== null);
  const closed = Object.keys(dirs).filter((k) => topHit(raw[k]) >= 0);
  const open = Object.keys(dirs).filter((k) => !closed.includes(k));
  const topLevel = closed.length ? Math.min(...closed.map((k) => topHit(raw[k]))) : levels;

  const box2 = {};
  const profiles = {};
  for (const [key, d] of Object.entries(dirs)) {
    if (open.includes(key)) {
      box2[key] = d.sign > 0 ? box.max[d.axis] : box.min[d.axis];
      profiles[key] = { step: STEP, values: [0] };
      continue;
    }
    // Gaps (e.g. open side panels) are assumed to continue the wall below them.
    const w = raw[key].slice(0, topHit(raw[key]) + 1);
    const first = w.find((v) => v !== null);
    for (let k = 0; k < w.length; k++) w[k] = w[k] ?? (k ? w[k - 1] : first);
    // The insert goes in from above, so at each height it must clear everything higher up.
    for (let k = w.length - 2; k >= 0; k--) w[k] = Math.min(w[k], w[k + 1]);
    box2[key] = c[d.axis] + d.sign * w[0];
    profiles[key] = { step: STEP, values: w.slice(0, topLevel + 1).map((v) => v - w[0]) };
  }

  return {
    floorY,
    height: heightAt(topLevel),
    box: box2,
    profiles,
    open,
  };
}
