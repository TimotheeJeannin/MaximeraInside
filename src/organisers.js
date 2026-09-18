// Parametric organiser inserts for the MAXIMERA drawer cavity.
// All lengths are in metres. The cavity is an axis-aligned box:
//   { x0, x1, z0, z1, y0 (inner floor), y1 (rim) }
// A design returns flat panels (boxes) plus the usable cells between them,
// where a cell is { x, z, angle, length, width } with `angle` the direction of
// the cell's long axis in the XZ plane.

function panel(name, size, pos, rotY = 0) {
  return { name, size, pos, rotY };
}

function frame(cavity, t, h, withBack = true) {
  const { x0, x1, z0, z1, y0 } = cavity;
  const w = x1 - x0;
  const d = z1 - z0;
  const cy = y0 + h / 2;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const panels = [
    panel('Côté', [t, h, d], [x0 + t / 2, cy, cz]),
    panel('Côté', [t, h, d], [x1 - t / 2, cy, cz]),
    panel('Traverse avant', [w - 2 * t, h, t], [cx, cy, z1 - t / 2]),
  ];
  if (withBack) panels.push(panel('Traverse arrière', [w - 2 * t, h, t], [cx, cy, z0 + t / 2]));
  return panels;
}

function basePlate(cavity, tb) {
  const { x0, x1, z0, z1, y0 } = cavity;
  return panel('Fond', [x1 - x0, tb, z1 - z0], [(x0 + x1) / 2, y0 + tb / 2, (z0 + z1) / 2]);
}

// Clip the infinite line p(s) = origin + s * dir to the rectangle, returning
// [sMin, sMax] or null when the line misses it.
function clipToRect(origin, dir, x0, x1, z0, z1) {
  let sMin = -Infinity;
  let sMax = Infinity;
  for (const [o, d, lo, hi] of [[origin.x, dir.x, x0, x1], [origin.z, dir.z, z0, z1]]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      const a = (lo - o) / d;
      const b = (hi - o) / d;
      sMin = Math.max(sMin, Math.min(a, b));
      sMax = Math.min(sMax, Math.max(a, b));
    }
  }
  return sMax > sMin ? [sMin, sMax] : null;
}

function inner(cavity, t) {
  return {
    x0: cavity.x0 + t, x1: cavity.x1 - t,
    z0: cavity.z0 + t, z1: cavity.z1 - t,
  };
}

// Parallel dividers running front-to-back: shoes go in like files in a folder.
function lanes(cavity, p) {
  const { t, h, count } = p;
  const iv = inner(cavity, t);
  const panels = frame(cavity, t, h);
  const span = iv.x1 - iv.x0;
  const pitch = span / count;
  const cz = (iv.z0 + iv.z1) / 2;
  const depth = iv.z1 - iv.z0;
  for (let i = 1; i < count; i++) {
    panels.push(panel('Séparateur', [t, h, depth], [iv.x0 + i * pitch, cavity.y0 + h / 2, cz]));
  }
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push({ x: iv.x0 + (i + 0.5) * pitch, z: cz, angle: Math.PI / 2, length: depth, width: pitch - t });
  }
  return { panels, cells };
}

// Dividers running left-to-right: shelves of shoes stacked front to back.
function rows(cavity, p) {
  const { t, h, count } = p;
  const iv = inner(cavity, t);
  const panels = frame(cavity, t, h);
  const span = iv.z1 - iv.z0;
  const pitch = span / count;
  const cx = (iv.x0 + iv.x1) / 2;
  const width = iv.x1 - iv.x0;
  for (let i = 1; i < count; i++) {
    panels.push(panel('Séparateur', [width, h, t], [cx, cavity.y0 + h / 2, iv.z0 + i * pitch]));
  }
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push({ x: cx, z: iv.z0 + (i + 0.5) * pitch, angle: 0, length: width, width: pitch - t });
  }
  return { panels, cells };
}

// Egg-crate: dividers in both directions, one compartment per shoe.
function grid(cavity, p) {
  const { t, h, count, rows: rowCount } = p;
  const iv = inner(cavity, t);
  const panels = frame(cavity, t, h);
  const pitchX = (iv.x1 - iv.x0) / count;
  const pitchZ = (iv.z1 - iv.z0) / rowCount;
  const cy = cavity.y0 + h / 2;
  for (let i = 1; i < count; i++) {
    panels.push(panel('Séparateur long.', [t, h, iv.z1 - iv.z0], [iv.x0 + i * pitchX, cy, (iv.z0 + iv.z1) / 2]));
  }
  for (let j = 1; j < rowCount; j++) {
    panels.push(panel('Séparateur trav.', [iv.x1 - iv.x0, h, t], [(iv.x0 + iv.x1) / 2, cy, iv.z0 + j * pitchZ]));
  }
  const cells = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < rowCount; j++) {
      cells.push({
        x: iv.x0 + (i + 0.5) * pitchX,
        z: iv.z0 + (j + 0.5) * pitchZ,
        angle: pitchZ > pitchX ? Math.PI / 2 : 0,
        length: Math.max(pitchX, pitchZ) - t,
        width: Math.min(pitchX, pitchZ) - t,
      });
    }
  }
  return { panels, cells };
}

// Diagonal lanes: the drawer diagonal is longer than its sides, so angled
// lanes fit longer shoes and present the toes towards the front corner.
function herringbone(cavity, p) {
  const { t, h, count, angle } = p;
  const iv = inner(cavity, t);
  const panels = frame(cavity, t, h);
  const a = (angle * Math.PI) / 180;
  const dir = { x: Math.cos(a), z: Math.sin(a) };
  const nrm = { x: -Math.sin(a), z: Math.cos(a) };
  const cx = (iv.x0 + iv.x1) / 2;
  const cz = (iv.z0 + iv.z1) / 2;
  const w = iv.x1 - iv.x0;
  const d = iv.z1 - iv.z0;
  const reach = (Math.abs(nrm.x) * w + Math.abs(nrm.z) * d) / 2;
  const pitch = (2 * reach) / count;
  const cy = cavity.y0 + h / 2;
  const cells = [];

  const segment = (offset) => {
    const origin = { x: cx + nrm.x * offset, z: cz + nrm.z * offset };
    const range = clipToRect(origin, dir, iv.x0, iv.x1, iv.z0, iv.z1);
    if (!range) return null;
    const [s0, s1] = range;
    const len = s1 - s0;
    const mid = (s0 + s1) / 2;
    return { len, x: origin.x + dir.x * mid, z: origin.z + dir.z * mid };
  };

  for (let i = 1; i < count; i++) {
    const seg = segment(-reach + i * pitch);
    if (!seg || seg.len < 0.12) continue;
    panels.push(panel('Séparateur diag.', [seg.len, h, t], [seg.x, cy, seg.z], -a));
  }
  for (let i = 0; i < count; i++) {
    const seg = segment(-reach + (i + 0.5) * pitch);
    if (!seg || seg.len < 0.15) continue;
    cells.push({ x: seg.x, z: seg.z, angle: a, length: seg.len, width: pitch - t });
  }
  return { panels, cells };
}

export const DESIGNS = {
  lanes: {
    label: 'Couloirs longitudinaux',
    hint: 'Séparateurs avant-arrière : les chaussures se rangent comme des dossiers, le profil visible du dessus.',
    build: lanes,
    controls: ['count'],
    defaults: { count: 4 },
  },
  rows: {
    label: 'Rangées transversales',
    hint: 'Séparateurs gauche-droite : une rangée de chaussures par bande, on voit toute la rangée en ouvrant.',
    build: rows,
    controls: ['count'],
    defaults: { count: 4 },
  },
  grid: {
    label: 'Casiers (nid d’abeille)',
    hint: 'Grille de compartiments : une chaussure par case, idéal pour les petites pointures et les sandales.',
    build: grid,
    controls: ['count', 'rows'],
    defaults: { count: 4, rows: 2 },
  },
  herringbone: {
    label: 'Couloirs diagonaux',
    hint: 'Couloirs à 45° : la diagonale du tiroir est plus longue que ses côtés, donc plus de place par couloir.',
    build: herringbone,
    controls: ['count', 'angle'],
    defaults: { count: 5, angle: 45 },
  },
};

export function buildOrganiser(kind, cavity, params) {
  const design = DESIGNS[kind];
  const { panels, cells } = design.build(cavity, params);
  if (params.base) panels.unshift(basePlate(cavity, params.tb));
  const lift = params.base ? params.tb : 0;
  for (const pl of panels) {
    if (pl.name !== 'Fond') pl.pos[1] += lift;
  }
  return { panels, cells, floorY: cavity.y0 + lift };
}
