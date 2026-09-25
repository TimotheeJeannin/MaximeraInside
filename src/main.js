import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectInterior } from './detect.js';
import { buildInsert } from './insert.js';
import { layoutSheets, sheetToSVG, sheetToDXF } from './export.js';

const MODELS_MANIFEST = 'models/models.json';
const $ = (id) => document.getElementById(id);

// --- 3D scene ---------------------------------------------------------------
const viewer = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewer.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f4f4);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(300, 800, 500);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = viewer;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}).observe(viewer);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

const drawerGroup = new THREE.Group();
const insertGroup = new THREE.Group();
scene.add(drawerGroup, insertGroup);
const wood = new THREE.MeshStandardMaterial({ color: 0xd9b07a, roughness: 0.85 });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x6b4a22 });

// --- Measure tool -----------------------------------------------------------
let measureOn = false;
const measurePts = [];
const measureGeo = new THREE.BufferGeometry();
measureGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
const onTop = { color: 0xe0115f, depthTest: false, transparent: true };
const measureDots = new THREE.Points(measureGeo, new THREE.PointsMaterial({ ...onTop, size: 8, sizeAttenuation: false }));
const measureLine = new THREE.Line(measureGeo, new THREE.LineBasicMaterial(onTop));
for (const o of [measureDots, measureLine]) {
  o.renderOrder = 1;
  o.frustumCulled = false;
}
scene.add(measureDots, measureLine);

function drawMeasure() {
  const pos = measureGeo.attributes.position;
  measurePts.forEach((p, i) => pos.setXYZ(i, p.x, p.y, p.z));
  pos.needsUpdate = true;
  measureGeo.setDrawRange(0, measurePts.length);
  const [a, b] = measurePts;
  const d = b && b.clone().sub(a);
  $('measureInfo').textContent = !measureOn
    ? ''
    : !a
      ? 'Click a point'
      : !b
        ? 'Click a second point'
        : `${d.length().toFixed(1)} mm  (Δx ${Math.abs(d.x).toFixed(1)} · Δy ${Math.abs(d.y).toFixed(1)} · Δz ${Math.abs(d.z).toFixed(1)})`;
}

const SNAP_PX = 12;
const cursorGeo = new THREE.BufferGeometry();
cursorGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3), 3));
const cursorDot = new THREE.Points(cursorGeo, new THREE.PointsMaterial({ ...onTop, size: 11, sizeAttenuation: false }));
cursorDot.renderOrder = 2;
cursorDot.frustumCulled = false;
cursorDot.visible = false;
scene.add(cursorDot);

function setMeasure(on) {
  measureOn = on;
  $('measureBtn').setAttribute('aria-pressed', on);
  viewer.classList.toggle('measuring', on);
  cursorDot.visible = false;
  measurePts.length = 0;
  drawMeasure();
}

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const MAX_OCCLUSION_TESTS = 16;
// Nearest visible mesh vertex within SNAP_PX screen pixels of the cursor, else the surface point under it.
function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const meshes = [];
  for (const g of [insertGroup, drawerGroup]) if (g.visible) g.traverseVisible((o) => o.isMesh && meshes.push(o));

  // Camera projection narrowed to the SNAP_PX square around the cursor.
  const sx = (2 * SNAP_PX) / r.width;
  const sy = (2 * SNAP_PX) / r.height;
  const toPick = new THREE.Matrix4()
    .set(1 / sx, 0, 0, -ndc.x / sx, 0, 1 / sy, 0, -ndc.y / sy, 0, 0, 1, 0, 0, 0, 0, 1)
    .multiply(camera.projectionMatrix)
    .multiply(camera.matrixWorldInverse);
  const frustum = new THREE.Frustum();
  const m = new THREE.Matrix4();
  const candidates = [];
  for (const o of meshes) {
    if (!o.geometry.boundsTree) o.geometry.computeBoundsTree();
    frustum.setFromProjectionMatrix(m.multiplyMatrices(toPick, o.matrixWorld));
    o.geometry.boundsTree.shapecast({
      intersectsBounds: (box) => frustum.intersectsBox(box),
      intersectsTriangle: (tri) => {
        for (const p of [tri.a, tri.b, tri.c]) {
          const w = p.clone().applyMatrix4(o.matrixWorld);
          const s = w.clone().project(camera);
          const px = Math.hypot(((s.x - ndc.x) * r.width) / 2, ((s.y - ndc.y) * r.height) / 2);
          if (px < SNAP_PX && Math.abs(s.z) < 1) candidates.push({ w, px });
        }
      },
    });
  }

  candidates.sort((a, b) => a.px - b.px);
  const dir = new THREE.Vector3();
  const tested = [];
  for (const { w } of candidates) {
    if (tested.length === MAX_OCCLUSION_TESTS) break;
    if (tested.some((t) => t.distanceToSquared(w) < 1e-6)) continue;
    tested.push(w);
    const dist = dir.subVectors(w, camera.position).length();
    raycaster.set(camera.position, dir.divideScalar(dist));
    const [blocker] = raycaster.intersectObjects(meshes, false);
    if (!blocker || blocker.distance > dist - 0.1) return { point: w, snapped: true };
  }

  raycaster.setFromCamera(ndc, camera);
  const [hit] = raycaster.intersectObjects(meshes, false);
  return hit ? { point: hit.point, snapped: false } : null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  const p = measureOn && !e.buttons && pick(e);
  cursorDot.visible = Boolean(p);
  if (!p) return;
  cursorGeo.attributes.position.setXYZ(0, p.point.x, p.point.y, p.point.z);
  cursorGeo.attributes.position.needsUpdate = true;
  cursorDot.material.color.set(p.snapped ? 0x1a9e3a : 0xe0115f);
});
renderer.domElement.addEventListener('pointerleave', () => (cursorDot.visible = false));

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  // A drag is an orbit, not a pick.
  if (!measureOn || e.button !== 0 || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const p = pick(e);
  if (!p) return;
  if (measurePts.length === 2) measurePts.length = 0;
  measurePts.push(p.point.clone());
  drawMeasure();
});
$('measureBtn').addEventListener('click', () => setMeasure(!measureOn));
window.addEventListener('keydown', (e) => e.key === 'Escape' && measureOn && setMeasure(false));

// --- State ------------------------------------------------------------------
let detected = null;

function message(text, cls = '') {
  const p = document.createElement('div');
  p.textContent = text;
  p.className = cls;
  $('messages').append(p);
}

function disposeObject(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const mat of [].concat(o.material)) {
      for (const v of Object.values(mat)) if (v?.isTexture) v.dispose();
      mat.dispose();
    }
  });
}

let loadId = 0;
async function loadModel(url) {
  const id = ++loadId;
  $('messages').textContent = '';
  message('Loading model…');
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(url);
  } catch (e) {
    if (id !== loadId) return;
    $('messages').textContent = '';
    message(`Could not load model: ${e.message}`, 'error');
    return;
  }
  // A newer load was started while this one was in flight.
  if (id !== loadId) {
    disposeObject(gltf.scene);
    return;
  }
  const model = gltf.scene;
  // glTF is in metres by spec, but some exporters write cm or mm.
  const raw = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  const m = Math.max(raw.x, raw.y, raw.z);
  model.scale.setScalar(m < 10 ? 1000 : m < 100 ? 10 : 1);
  model.traverse((o) => {
    if (o.isMesh) for (const mat of [].concat(o.material)) mat.side = THREE.DoubleSide;
  });

  drawerGroup.children.forEach(disposeObject);
  drawerGroup.clear();
  drawerGroup.add(model);
  measurePts.length = 0;
  drawMeasure();
  detected = detectInterior(model);
  frameCamera(model);

  if (!detected) {
    clearInsert();
    $('drawerInfo').textContent = '';
    $('messages').textContent = '';
    message('No drawer floor found. The model must be Y-up and open at the top.', 'error');
    return;
  }
  resetDims();
}

function frameCamera(object) {
  const box = new THREE.Box3().setFromObject(object);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.35, 0.9, 0.75).multiplyScalar(r));
  controls.update();
}

function resetDims() {
  const b = detected.box;
  $('width').value = (b.xMax - b.xMin).toFixed(1);
  $('depth').value = (b.zMax - b.zMin).toFixed(1);
  update();
}

// Applies the user's width/depth to the detected box. Open sides (no wall found)
// move first; otherwise both walls move symmetrically.
function currentBox() {
  const b = { ...detected.box };
  for (const [axis, id] of [['x', 'width'], ['z', 'depth']]) {
    const lo = `${axis}Min`;
    const hi = `${axis}Max`;
    const delta = Number($(id).value) - (b[hi] - b[lo]);
    const openLo = detected.open.includes(lo);
    const openHi = detected.open.includes(hi);
    if (openHi && !openLo) b[hi] += delta;
    else if (openLo && !openHi) b[lo] -= delta;
    else {
      b[hi] += delta / 2;
      b[lo] -= delta / 2;
    }
  }
  return b;
}

// "125, *, 90" → [125, null, 90]; empty → null; undefined if anything is invalid.
function parseSizes(text) {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return null;
  const sizes = tokens.map((s) => (s === '*' ? null : Number(s)));
  return sizes.every((w) => w === null || (Number.isFinite(w) && w > 0)) ? sizes : undefined;
}

function readParams() {
  const num = (id) => Number($(id).value);
  const colWidths = parseSizes($('colWidths').value);
  const rowDepths = parseSizes($('rowDepths').value);
  return {
    height: num('height'),
    thickness: num('thickness'),
    cols: colWidths?.length ?? Math.max(1, Math.round(num('cols'))),
    rows: rowDepths?.length ?? Math.max(1, Math.round(num('rows'))),
    colWidths,
    rowDepths,
    clearance: num('clearance'),
    frame: $('frame').checked,
    kerf: num('kerf'),
    slotTol: num('slotTol'),
    sheet: { w: num('sheetW'), h: num('sheetH') },
  };
}

// --- Update -----------------------------------------------------------------
function update() {
  if (!detected) return;
  $('messages').textContent = '';
  // A size list drives the count; the typed count comes back when the list is cleared.
  for (const [id, listId] of [['cols', 'colWidths'], ['rows', 'rowDepths']]) {
    const el = $(id);
    const list = parseSizes($(listId).value);
    if (list === undefined) continue;
    if (list && !el.disabled) el.dataset.count = el.value;
    if (!list && el.disabled) el.value = el.dataset.count;
    el.disabled = Boolean(list);
    if (list) el.value = list.length;
  }
  const p = readParams();
  if (p.colWidths === undefined || p.rowDepths === undefined) {
    clearInsert();
    message('Cell sizes must be positive numbers or *, separated by commas.', 'error');
    return;
  }
  const nums = [p.height, p.thickness, p.clearance, p.kerf, p.slotTol, p.sheet.w, p.sheet.h, +$('width').value, +$('depth').value];
  if (nums.some((n) => !Number.isFinite(n) || n < 0) || p.height <= 0 || p.thickness <= 0) {
    clearInsert();
    message('Enter valid positive numbers.', 'error');
    return;
  }

  const box = currentBox();
  const sideNames = { xMin: 'left', xMax: 'right', zMin: 'back', zMax: 'front' };
  $('drawerInfo').textContent =
    `Detected: ${(detected.box.xMax - detected.box.xMin).toFixed(1)} × ` +
    `${(detected.box.zMax - detected.box.zMin).toFixed(1)} mm at the floor, walls ~${detected.height.toFixed(0)} mm high.` +
    (detected.open.length
      ? `\nNo wall found on: ${detected.open.map((k) => sideNames[k] ?? k).join(', ')} — check that dimension.`
      : '');

  const res = buildInsert(p, { ...detected, box });
  res.errors.forEach((e) => message(e, 'error'));
  res.warnings.forEach((w) => message(w, 'warn'));

  rebuildInsert(res.parts, p.thickness);

  const fmt = (ws) => (ws.every((w) => Math.abs(w - ws[0]) < 0.05) ? ws[0].toFixed(1) : ws.map((w) => w.toFixed(1)).join(', '));
  const { w, d } = res.cells;
  const [fw, fd] = [fmt(w), fmt(d)];
  const lines =
    fw.includes(',') || fd.includes(',')
      ? [`Column widths: ${fw} mm`, `Row depths: ${fd} mm (at the top)`]
      : [`Cells: ${fw} × ${fd} mm (at the top)`];
  const floor = [];
  if (fmt(res.floorCells.w) !== fw) floor.push(`widths ${fmt(res.floorCells.w)}`);
  if (fmt(res.floorCells.d) !== fd) floor.push(`depths ${fmt(res.floorCells.d)}`);
  if (floor.length) lines.push(`At the floor: ${floor.join('; ')} mm`);
  for (const part of res.parts) {
    const slots = part.id === 'A' ? 'slots on top' : 'slots underneath';
    const us = part.poly.map(([u]) => u);
    const len = Math.max(...us) - Math.min(...us);
    lines.push(`Strip ${part.id}: ${part.placements.length} × ${len.toFixed(1)} × ${p.height} mm, ${slots}`);
  }
  $('insertInfo').textContent = res.errors.length ? '' : lines.join('\n');

  const { sheets, size, error } = layoutSheets(res.parts, p.sheet, p.kerf);
  if (error) message(error, 'error');
  renderCutting(sheets, size, p);
}

function clearInsert() {
  rebuildInsert([], 0);
  renderCutting([], null, readParams());
  $('insertInfo').textContent = '';
}

let insertGeometries = [];
function rebuildInsert(parts, t) {
  insertGeometries.forEach((g) => g.dispose());
  insertGeometries = [];
  insertGroup.clear();
  for (const part of parts) {
    const shape = new THREE.Shape(part.poly.map(([u, v]) => new THREE.Vector2(u, v)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    const edges = new THREE.EdgesGeometry(geo, 30);
    insertGeometries.push(geo, edges);
    for (const pl of part.placements) {
      const obj = new THREE.Group();
      obj.add(new THREE.Mesh(geo, wood), new THREE.LineSegments(edges, edgeMat));
      if (pl.axis === 'x') {
        obj.position.set(pl.start, detected.floorY, pl.at - t / 2);
      } else {
        // Local u → world +Z, extrusion → world −X.
        obj.rotation.y = -Math.PI / 2;
        obj.position.set(pl.at + t / 2, detected.floorY, pl.start);
      }
      insertGroup.add(obj);
    }
  }
}

let downloadUrls = [];
function renderCutting(sheets, size, p) {
  downloadUrls.forEach(URL.revokeObjectURL);
  downloadUrls = [];
  $('preview').innerHTML = sheets
    .map((s) => sheetToSVG(s, size, { preview: true }).replace(/^<\?xml[^>]*>\s*/, ''))
    .join('');

  const dl = $('downloads');
  dl.textContent = '';
  const base = `insert-${p.cols}x${p.rows}-${p.height}mm-${p.thickness}mm`;
  sheets.forEach((s, i) => {
    const suffix = sheets.length > 1 ? `-sheet${i + 1}` : '';
    for (const [ext, text, type] of [
      ['svg', sheetToSVG(s, size), 'image/svg+xml'],
      ['dxf', sheetToDXF(s, size), 'application/dxf'],
    ]) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      downloadUrls.push(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}${suffix}.${ext}`;
      a.textContent = `${sheets.length > 1 ? `Sheet ${i + 1} ` : ''}${ext.toUpperCase()}`;
      a.className = 'button';
      dl.append(a);
    }
  });
  if (sheets.length) {
    const note = document.createElement('span');
    note.textContent = `${size.w} × ${size.h} mm, ${sheets.length} sheet${sheets.length > 1 ? 's' : ''}, red = cut`;
    dl.prepend(note);
  }
}

// --- Wiring -----------------------------------------------------------------
document.querySelectorAll('aside input:not([type="file"])').forEach((el) => el.addEventListener('input', update));
$('resetDims').addEventListener('click', () => detected && resetDims());
$('showDrawer').addEventListener('change', (e) => (drawerGroup.visible = e.target.checked));
const LOCAL_FILE = '#local';
let localFile = null;
function loadLocalFile() {
  const url = URL.createObjectURL(localFile);
  return loadModel(url).finally(() => URL.revokeObjectURL(url));
}
$('modelSelect').addEventListener('change', (e) => {
  if (e.target.value === LOCAL_FILE) loadLocalFile();
  else loadModel(e.target.value);
});
$('modelFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  localFile = file;
  // Lets picking the same file again fire another change event.
  e.target.value = '';
  const select = $('modelSelect');
  select.querySelector(`option[value="${LOCAL_FILE}"]`)?.remove();
  select.prepend(new Option(file.name, LOCAL_FILE, true, true));
  loadLocalFile();
});

async function loadModelList() {
  try {
    const res = await fetch(MODELS_MANIFEST);
    if (!res.ok) throw new Error(res.statusText);
    const models = await res.json();
    const select = $('modelSelect');
    for (const m of models) select.append(new Option(m.name, `models/${m.file}`));
    if (models.length) loadModel(select.value);
  } catch (e) {
    message(`Could not read ${MODELS_MANIFEST}: ${e.message}`, 'error');
  }
}

loadModelList();
