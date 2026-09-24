import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectInterior } from './detect.js';
import { buildInsert } from './insert.js';
import { layoutSheets, sheetToSVG, sheetToDXF } from './export.js';

const DEFAULT_MODEL = 'models/maximera-30285025-rqp3.glb';
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

// --- State ------------------------------------------------------------------
let detected = null;

function message(text, cls = '') {
  const p = document.createElement('div');
  p.textContent = text;
  p.className = cls;
  $('messages').append(p);
}

async function loadModel(url) {
  $('messages').textContent = '';
  message('Loading model…');
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(url);
  } catch (e) {
    $('messages').textContent = '';
    message(`Could not load model: ${e.message}`, 'error');
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

  drawerGroup.clear();
  drawerGroup.add(model);
  detected = detectInterior(model);
  frameCamera(model);

  if (!detected) {
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

function readParams() {
  const num = (id) => Number($(id).value);
  return {
    height: num('height'),
    thickness: num('thickness'),
    cols: Math.max(1, Math.round(num('cols'))),
    rows: Math.max(1, Math.round(num('rows'))),
    clearance: num('clearance'),
    frame: $('frame').checked,
    kerf: num('kerf'),
    sheet: { w: num('sheetW'), h: num('sheetH') },
  };
}

// --- Update -----------------------------------------------------------------
function update() {
  if (!detected) return;
  $('messages').textContent = '';
  const p = readParams();
  const nums = [p.height, p.thickness, p.clearance, p.kerf, p.sheet.w, p.sheet.h, +$('width').value, +$('depth').value];
  if (nums.some((n) => !Number.isFinite(n) || n < 0) || p.height <= 0 || p.thickness <= 0) {
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

  const lines = [`Cells: ${res.cell.w.toFixed(1)} × ${res.cell.d.toFixed(1)} mm (at the floor)`];
  for (const part of res.parts) {
    const slots = part.id === 'A' ? 'slots on top' : 'slots underneath';
    lines.push(`Strip ${part.id}: ${part.placements.length} × ${part.length.toFixed(1)} × ${p.height} mm, ${slots}`);
  }
  $('insertInfo').textContent = res.errors.length ? '' : lines.join('\n');

  const { sheets, size, error } = layoutSheets(res.parts, p.sheet, p.kerf);
  if (error) message(error, 'error');
  renderCutting(sheets, size, p);
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
$('modelFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  loadModel(url).finally(() => URL.revokeObjectURL(url));
});

loadModel(DEFAULT_MODEL);
