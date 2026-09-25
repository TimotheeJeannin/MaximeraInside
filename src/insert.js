// Pure geometry for an egg-crate drawer insert. All units are mm.
// Parts are 2D polygons in (u, v): u along the strip, v up from the drawer floor.

export function profileAt(profile, h) {
  if (!profile) return 0;
  const { step, values } = profile;
  const x = Math.max(0, h / step);
  const i = Math.floor(x);
  if (i >= values.length - 1) return values[values.length - 1];
  return values[i] + (values[i + 1] - values[i]) * (x - i);
}

// Cell sizes and strip centre positions across a span. `spec` holds one entry per
// cell: a size in mm, or null to share what is left. With no null entries, the
// leftover (or shortfall) is spread over all cells.
function stripPositions(start, span, spec, t, frame) {
  const n = spec.length;
  const walls = frame ? n + 1 : n - 1;
  const free = span - walls * t;
  const fixed = spec.reduce((s, w) => s + (w ?? 0), 0);
  const autos = spec.filter((w) => w == null).length;
  const extra = (free - fixed) / (autos || n);
  const cells = spec.map((w) => (w == null ? extra : autos ? w : w + extra));
  const positions = [];
  let x = start + (frame ? t / 2 : -t / 2);
  if (frame) positions.push(x);
  cells.forEach((w, i) => {
    x += w + t;
    if (frame || i < n - 1) positions.push(x);
  });
  return { cells, positions, free, fixed, spread: !autos };
}

// Points along one long edge (u = 0 → L) with rectangular notches of the given depth.
function notchedEdge(centres, width, L, depth) {
  const slots = centres
    .map((c) => [Math.max(0, c - width / 2), Math.min(L, c + width / 2)])
    .sort((a, b) => a[0] - b[0]);
  const pts = [[0, slots.length && slots[0][0] <= 0 ? depth : 0]];
  for (const [a, b] of slots) {
    if (a > 0) pts.push([a, 0], [a, depth]);
    if (b < L) pts.push([b, depth], [b, 0]);
  }
  const last = slots[slots.length - 1];
  pts.push([L, last && last[1] >= L ? depth : 0]);
  return pts;
}

function endProfile(profile, H, sign, base) {
  if (!profile) return [];
  const pts = [];
  const n = Math.max(1, Math.ceil(H / profile.step));
  for (let i = 0; i <= n; i++) {
    const h = Math.min(H, i * profile.step);
    pts.push([base + sign * profileAt(profile, h), h]);
  }
  return simplify(pts, 0.2);
}

// Ramer–Douglas–Peucker on an open polyline.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let worst = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > worst) [worst, idx] = [d, i];
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

// Drops repeated and collinear vertices of a closed polygon.
function clean(poly) {
  const out = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) < 1e-6) out.pop();
  for (let i = 0; i < out.length && out.length > 3;) {
    const a = out[(i - 1 + out.length) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) out.splice(i, 1);
    else i++;
  }
  return out;
}

function stripPolygon({ L, H, topSlots, bottomSlots, width, startProfile, endProfile: endProf }) {
  const bottom = notchedEdge(bottomSlots, width, L, H / 2);
  const top = notchedEdge(topSlots, width, L, H / 2).map(([u, y]) => [u, H - y]).reverse();
  const right = endProfile(endProf, H, 1, L);
  const left = endProfile(startProfile, H, -1, 0).reverse();
  return clean([...bottom, ...right, ...top, ...left]);
}

/**
 * params:   { height, thickness, cols, rows, colWidths?, rowDepths?, frame, clearance, slotTol }
 *           colWidths/rowDepths: per-cell sizes (null = auto); they override cols/rows.
 * interior: { floorY, height, box: {xMin,xMax,zMin,zMax}, profiles: {xMin,...} }
 */
export function buildInsert(params, interior) {
  const { height: H, thickness: t, cols, rows, frame, clearance: c, slotTol = 0 } = params;
  const colSpec = params.colWidths?.length ? params.colWidths : Array(cols).fill(null);
  const rowSpec = params.rowDepths?.length ? params.rowDepths : Array(rows).fill(null);
  const slotW = t + slotTol;
  const errors = [];
  const warnings = [];

  const x0 = interior.box.xMin + c;
  const z0 = interior.box.zMin + c;
  const W = interior.box.xMax - c - x0;
  const D = interior.box.zMax - c - z0;

  const p = frame ? {} : interior.profiles;
  // Cells are sized at the top of the insert; sloped walls make outer cells narrower at the floor.
  const grow = (k) => profileAt(p[k], H);
  const xs = stripPositions(x0 - grow('xMin'), W + grow('xMin') + grow('xMax'), colSpec, t, frame);
  const zs = stripPositions(z0 - grow('zMin'), D + grow('zMin') + grow('zMax'), rowSpec, t, frame);
  const atFloor = (ws, lo, hi) =>
    ws.map((w, i) => w - (i === 0 ? grow(lo) : 0) - (i === ws.length - 1 ? grow(hi) : 0));
  const floorCells = { w: atFloor(xs.cells, 'xMin', 'xMax'), d: atFloor(zs.cells, 'zMin', 'zMax') };
  for (const [s, floor, what] of [[xs, floorCells.w, 'Column widths'], [zs, floorCells.d, 'Row depths']]) {
    if (s.fixed > s.free + 0.5 || floor.some((w) => w <= 0)) {
      errors.push(`${what} don't fit: ${s.fixed.toFixed(1)} mm requested, ${s.free.toFixed(1)} mm available.`);
    } else if (s.spread && Math.abs(s.free - s.fixed) > 0.5) {
      warnings.push(
        `${what} add up to ${s.fixed.toFixed(1)} mm but ${s.free.toFixed(1)} mm is available; ` +
        'the difference is spread over all cells (use * for a flexible cell).',
      );
    }
  }
  if (H > interior.height + 0.01) warnings.push(`Insert is taller than the drawer walls (~${interior.height.toFixed(0)} mm).`);
  if (!xs.positions.length && !zs.positions.length) errors.push('Nothing to cut: add columns/rows or enable the frame.');
  const cells = { w: xs.cells, d: zs.cells };
  if (errors.length) return { parts: [], errors, warnings, cells, floorCells };

  const parts = [];

  // Strips running along X (between rows); slotted from the top.
  if (zs.positions.length) {
    parts.push({
      id: 'A',
      length: W,
      poly: stripPolygon({
        L: W, H, width: slotW,
        topSlots: xs.positions.map((x) => x - x0),
        bottomSlots: [],
        startProfile: p.xMin,
        endProfile: p.xMax,
      }),
      placements: zs.positions.map((z) => ({ axis: 'x', start: x0, at: z })),
    });
  }
  // Strips running along Z (between columns); slotted from the bottom.
  if (xs.positions.length) {
    parts.push({
      id: 'B',
      length: D,
      poly: stripPolygon({
        L: D, H, width: slotW,
        topSlots: [],
        bottomSlots: zs.positions.map((z) => z - z0),
        startProfile: p.zMin,
        endProfile: p.zMax,
      }),
      placements: xs.positions.map((x) => ({ axis: 'z', start: z0, at: x })),
    });
  }

  return { parts, errors, warnings, cells, floorCells };
}
