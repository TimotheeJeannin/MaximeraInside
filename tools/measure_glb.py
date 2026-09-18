"""Measure the MAXIMERA drawer GLB: overall bbox and inner cavity walls."""
import json
import struct
from array import array


def load_positions(path):
    data = open(path, 'rb').read()
    off, chunks = 12, {}
    while off < len(data):
        clen, ctype = struct.unpack_from('<I4s', data, off)
        chunks.setdefault(ctype.strip(b'\x00'), data[off + 8:off + 8 + clen])
        off += 8 + clen
    g = json.loads(chunks[b'JSON'].decode('utf-8'))
    acc = g['accessors'][g['meshes'][0]['primitives'][0]['attributes']['POSITION']]
    bv = g['bufferViews'][acc['bufferView']]
    start = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = bv.get('byteStride') or 12
    blob = chunks[b'BIN']
    pts = []
    for i in range(acc['count']):
        o = start + i * stride
        pts.append(struct.unpack_from('<3f', blob, o))
    return pts, acc


def clusters(vals, tol=0.004, top=8):
    vals = sorted(vals)
    out, lo, prev, n = [], vals[0], vals[0], 1
    for v in vals[1:]:
        if v - prev <= tol:
            n += 1
        else:
            out.append((lo, prev, n))
            lo, n = v, 1
        prev = v
    out.append((lo, prev, n))
    return sorted(out, key=lambda t: -t[2])[:top]


pts, acc = load_positions('maximera-30285025-rqp3.glb')
xs = array('f', (p[0] for p in pts))
ys = array('f', (p[1] for p in pts))
zs = array('f', (p[2] for p in pts))
print('vertices:', len(pts))
print('bbox  x %.4f..%.4f (%.1f cm)  y %.4f..%.4f (%.1f cm)  z %.4f..%.4f (%.1f cm)' % (
    min(xs), max(xs), (max(xs) - min(xs)) * 100,
    min(ys), max(ys), (max(ys) - min(ys)) * 100,
    min(zs), max(zs), (max(zs) - min(zs)) * 100))

band = [i for i, v in enumerate(ys) if 0.09 < v < 0.16]
print('\n-- mid-height band (y 9..16 cm), planes ordered by position --')
print('X planes:')
for lo, hi, n in sorted(clusters([xs[i] for i in band], top=20)):
    print('  %+.4f .. %+.4f   n=%d' % (lo, hi, n))
print('Z planes:')
for lo, hi, n in sorted(clusters([zs[i] for i in band], top=20)):
    print('  %+.4f .. %+.4f   n=%d' % (lo, hi, n))

centre = [i for i in range(len(pts)) if abs(xs[i]) < 0.255 and abs(zs[i]) < 0.243 and ys[i] < 0.09]
print('\n-- low vertices inside the cavity footprint (floor detection), %d pts --' % len(centre))
for lo, hi, n in sorted(clusters([ys[i] for i in centre], top=20)):
    print('  y %+.4f .. %+.4f   n=%d' % (lo, hi, n))
