// Nesting of parts onto sheets and SVG/DXF output. All units are mm.

const MARGIN = 5;
const GAP = 3;

// Grows a closed polygon by d (mitred corners) to compensate for the laser kerf.
export function offsetPolygon(poly, d) {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  const s = area > 0 ? d : -d;
  const normal = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return [dy / l, -dx / l];
  };
  return poly.map((p, i) => {
    const n1 = normal(poly[(i - 1 + n) % n], p);
    const n2 = normal(p, poly[(i + 1) % n]);
    const k = s / Math.max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + k * (n1[0] + n2[0]), p[1] + k * (n1[1] + n2[1])];
  });
}

function bounds(poly) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * Shelf-packs every part instance onto as many sheets as needed.
 * Parts are laid along the sheet's long side. Returns { sheets, size, error }.
 * Each sheet is a list of polygons already placed in sheet coordinates (y down).
 */
export function layoutSheets(parts, sheet, kerf) {
  const size = { w: Math.max(sheet.w, sheet.h), h: Math.min(sheet.w, sheet.h) };
  const items = [];
  for (const part of parts) {
    const poly = offsetPolygon(part.poly, kerf / 2);
    const b = bounds(poly);
    for (let i = 0; i < part.placements.length; i++) {
      items.push({ poly, b, w: b.maxX - b.minX, h: b.maxY - b.minY });
    }
  }
  if (!items.length) return { sheets: [], size };

  const maxW = size.w - 2 * MARGIN;
  const maxH = size.h - 2 * MARGIN;
  const tooBig = items.find((it) => it.w > maxW || it.h > maxH);
  if (tooBig) {
    return { sheets: [], size, error: `A ${tooBig.w.toFixed(0)} × ${tooBig.h.toFixed(0)} mm part does not fit on the sheet.` };
  }

  items.sort((a, b) => b.w - a.w);
  const sheets = [];
  const rows = [];
  for (const it of items) {
    let row = rows.find((r) => r.used + it.w <= maxW && it.h <= r.h);
    if (!row) {
      let sheetIdx = sheets.length - 1;
      const last = rows.filter((r) => r.sheet === sheetIdx).at(-1);
      let y = last ? last.y + last.h + GAP : MARGIN;
      if (sheetIdx < 0 || y + it.h > size.h - MARGIN) {
        sheets.push([]);
        sheetIdx++;
        y = MARGIN;
      }
      row = { sheet: sheetIdx, y, h: it.h, used: 0 };
      rows.push(row);
    }
    const x = MARGIN + row.used;
    // Flip v so the top edge of the strip is at the top of the sheet.
    sheets[row.sheet].push(it.poly.map(([u, v]) => [x + u - it.b.minX, row.y + it.b.maxY - v]));
    row.used += it.w + GAP;
  }
  return { sheets, size };
}

const f = (n) => (Math.round(n * 1000) / 1000).toString();

export function sheetToSVG(polys, size, { preview = false } = {}) {
  const paths = polys
    .map((p) => `<path d="M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z"/>`)
    .join('\n');
  const bg = preview ? `<rect width="${size.w}" height="${size.h}" fill="#fff" stroke="#999" stroke-width="1"/>\n` : '';
  const dims = preview ? '' : ` width="${size.w}mm" height="${size.h}mm"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"${dims} viewBox="0 0 ${size.w} ${size.h}">
${bg}<g fill="none" stroke="#ff0000" stroke-width="${preview ? 0.8 : 0.1}">
${paths}
</g>
</svg>
`;
}

// Minimal AutoCAD R12 DXF: closed POLYLINEs on a "CUT" layer, y up.
export function sheetToDXF(polys, size) {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES'];
  for (const p of polys) {
    out.push('0', 'POLYLINE', '8', 'CUT', '66', '1', '10', '0', '20', '0', '30', '0', '70', '1');
    for (const [x, y] of p) out.push('0', 'VERTEX', '8', 'CUT', '10', f(x), '20', f(size.h - y), '30', '0');
    out.push('0', 'SEQEND', '8', 'CUT');
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}
