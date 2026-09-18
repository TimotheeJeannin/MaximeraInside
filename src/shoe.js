import * as THREE from 'three';

// Side profile of a shoe, normalised to length 1 (heel at x=0) and height 1.
const SOLE = [
  [0.02, 0.00], [0.30, 0.00], [0.62, 0.00], [0.86, 0.01], [0.96, 0.06],
];
const UPPER = [
  [0.99, 0.13], [0.92, 0.19], [0.74, 0.26], [0.58, 0.33], [0.49, 0.47],
  [0.44, 0.58], [0.33, 0.62], [0.18, 0.62], [0.07, 0.52], [0.02, 0.28],
];

export function makeShoeGeometry(length, height, width) {
  const shape = new THREE.Shape();
  shape.moveTo(SOLE[0][0] * length, SOLE[0][1] * height);
  shape.splineThru(SOLE.slice(1).map(([x, y]) => new THREE.Vector2(x * length, y * height)));
  shape.splineThru(UPPER.map(([x, y]) => new THREE.Vector2(x * length, y * height)));
  shape.closePath();

  const bevel = Math.min(width * 0.14, height * 0.14);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(width - 2 * bevel, width * 0.4),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 10,
  });
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.computeVertexNormals();
  return geo;
}

// Rough outer dimensions of a shoe from its EU size, in metres.
export function shoeDimensions(euSize) {
  const length = 0.0068 * euSize;
  return { length, width: length * 0.36, height: length * 0.39 };
}
