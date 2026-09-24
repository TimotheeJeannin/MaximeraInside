import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DESIGNS, buildOrganiser } from './organisers.js';
import { makeShoeGeometry, shoeDimensions } from './shoe.js';

const MODEL_URL = 'maximera-30285025-rqp3.glb';
const CLEARANCE = 0.004; // play between the insert and the drawer walls

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181c);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 50);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.52;

const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(0.6, 1.4, 0.9);
scene.add(key, new THREE.AmbientLight(0xffffff, 0.35));

const organiserGroup = new THREE.Group();
const shoeGroup = new THREE.Group();
scene.add(organiserGroup, shoeGroup);

const panelMat = new THREE.MeshStandardMaterial({ color: 0xc8a06a, roughness: 0.72, metalness: 0.02 });
const baseMat = new THREE.MeshStandardMaterial({ color: 0xb08a58, roughness: 0.8, metalness: 0.02 });
const shoeMat = new THREE.MeshStandardMaterial({
    color: 0x4f7fd4, roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.85,
});

let drawer = null;
let cavity = null;
const ui = {};
let shoeGeoCache = { key: '', geo: null };

const loader = new GLTFLoader();
loader.load(MODEL_URL, (gltf) => {
    drawer = gltf.scene;
    drawer.traverse((o) => {
        if (o.isMesh) {
            o.material.side = THREE.DoubleSide; // needed to probe walls from inside
        }
    });
    scene.add(drawer);
    cavity = probeCavity(drawer);
    frameCamera();
    bindUI();
    rebuild();
}, undefined, () => {
    document.getElementById('stats').textContent = 'Échec du chargement du modèle du tiroir.';
});

// Measure the usable cavity by shooting rays inside the drawer mesh.
function probeCavity(root) {
    const box = new THREE.Box3().setFromObject(root);
    const ray = new THREE.Raycaster();
    const shoot = (origin, dir) => {
        ray.set(origin, dir);
        const hit = ray.intersectObject(root, true)[0];
        return hit ? hit.point : null;
    };
    const top = box.max.y;
    const floor = shoot(new THREE.Vector3(0, top + 0.05, 0), new THREE.Vector3(0, -1, 0));
    const y0 = floor ? floor.y : box.min.y;
    const probeY = y0 + 0.05;
    const at = (dx, dz) => shoot(new THREE.Vector3(0, probeY, 0), new THREE.Vector3(dx, 0, dz));
    const left = at(-1, 0);
    const right = at(1, 0);
    const back = at(0, -1);
    const front = at(0, 1);
    return {
        x0: (left ? left.x : box.min.x) + CLEARANCE,
        x1: (right ? right.x : box.max.x) - CLEARANCE,
        z0: (back ? back.z : box.min.z) + CLEARANCE,
        z1: (front ? front.z : box.max.z) - CLEARANCE,
        y0,
        y1: top,
    };
}

function frameCamera(top = false) {
    const c = cavity;
    const centre = new THREE.Vector3((c.x0 + c.x1) / 2, c.y0, (c.z0 + c.z1) / 2);
    controls.target.copy(centre);
    if (top) camera.position.set(centre.x, centre.y + 1.05, centre.z + 0.05);
    else camera.position.set(centre.x + 0.32, centre.y + 0.62, centre.z + 0.78);
    controls.update();
}

function readParams() {
    const kind = ui.design.value;
    return {
        kind,
        count: Number(ui.count.value),
        rows: Number(ui.rows.value),
        angle: Number(ui.angle.value),
        t: Number(ui.thickness.value) / 1000,
        tb: 0.006,
        h: Number(ui.height.value) / 100,
        base: ui.base.checked,
        euSize: Number(ui.size.value),
        mode: ui.mode.value,
        showShoes: ui.shoes.checked,
    };
}

function layout(p) {
    const params = { ...p, h: Math.min(p.h, cavity.y1 - cavity.y0 - (p.base ? p.tb : 0)) };
    const { panels, cells, floorY } = buildOrganiser(p.kind, cavity, params);
    const dims = shoeDimensions(p.euSize);
    const freeHeight = cavity.y1 - floorY;
  const bounds = {
    x0: cavity.x0 + params.t, x1: cavity.x1 - params.t,
    z0: cavity.z0 + params.t, z1: cavity.z1 - params.t,
  };
  const placements = cells.flatMap((cell) => fillCell(cell, dims, p.mode, freeHeight, bounds));
    const design = DESIGNS[p.kind];
    const { panels, cells, floorY, placements, dims, freeHeight } = layout(p);

    organiserGroup.clear();
    shoeGroup.clear();

    for (const pl of panels) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...pl.size), pl.name === 'Fond' ? baseMat : panelMat);
        mesh.position.set(...pl.pos);
        mesh.rotation.y = pl.rotY;
        organiserGroup.add(mesh);
    }

    if (p.showShoes) {
        const geo = shoeGeometryFor(dims);
        for (const s of placements) {
            const holder = new THREE.Group();
            holder.position.set(s.x, floorY, s.z);
            holder.rotation.y = s.rotY;
            const inner = new THREE.Object3D();
            inner.rotation.x = s.tiltX;
            inner.position.y = s.lift;
            inner.add(new THREE.Mesh(geo, shoeMat));
            holder.add(inner);
            shoeGroup.add(holder);
        }
    }

    drawer.visible = ui.drawer.checked;
    ui.hint.textContent = design.hint;
    for (const [name, el] of Object.entries(ui.rowsOf)) {
        el.hidden = !design.controls.includes(name);
    }
    updateStats(p, panels, cells, placements.length, dims, freeHeight);
}

// Try every divider count (and grid rows / diagonal angle) and keep the layout
// that holds the most shoes, preferring the simplest build on a tie.
function optimise() {
    const base = readParams();
    const design = DESIGNS[base.kind];
    const counts = range(2, 8);
    const rowOptions = design.controls.includes('rows') ? range(1, 4) : [base.rows];
    const angles = design.controls.includes('angle') ? range(15, 75, 5) : [base.angle];
    let best = null;
    for (const count of counts) {
        for (const rows of rowOptions) {
            for (const angle of angles) {
                const p = { ...base, count, rows, angle };
                const n = layout(p).placements.length;
                // On equal capacity, keep the most dividers: one shoe per compartment.
                if (!best || n > best.n || (n === best.n && count > best.p.count)) best = { n, p };
            }
        }
    }
    if (!best) return;
    ui.count.value = best.p.count;
    ui.rows.value = best.p.rows;
    ui.angle.value = best.p.angle;
    syncOutputs();
    rebuild();
}

function range(from, to, step = 1) {
    const out = [];
    for (let v = from; v <= to; v += step) out.push(v);
    return out;
}

function shoeGeometryFor(dims) {
    const k = `${dims.length.toFixed(4)}`;
    if (shoeGeoCache.key !== k) {
        shoeGeoCache.geo?.dispose();
        shoeGeoCache = { key: k, geo: makeShoeGeometry(dims.length, dims.height, dims.width) };
    }
    return shoeGeoCache.geo;
}

// How a single shoe occupies space, depending on how it is stored.
function footprint(dims, mode) {
    switch (mode) {
        case 'edge':   // resting on its side, sole vertical
            return { along: dims.length, across: dims.height, vertical: dims.width, perSlot: 1 };
        case 'nested': // a pair, the second shoe upside-down on top of the first
            return { along: dims.length, across: dims.width * 1.02, vertical: dims.height * 1.5, perSlot: 2 };
        default:       // flat, sole down
            return { along: dims.length, across: dims.width, vertical: dims.height, perSlot: 1 };
    }
}

function fillCell(cell, dims, mode, freeHeight, bounds) {
    const f = footprint(dims, mode);
    if (f.vertical > freeHeight) return [];
    const gap = 0.006;
    const cols = Math.floor((cell.width + gap) / (f.across + gap));
    const rows = Math.floor((cell.length + gap) / (f.along + gap));
    if (cols < 1 || rows < 1) return [];

    const dir = { x: Math.cos(cell.angle), z: Math.sin(cell.angle) };
    const nrm = { x: -Math.sin(cell.angle), z: Math.cos(cell.angle) };
    const out = [];
    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
            const u = (j - (rows - 1) / 2) * (f.along + gap);
            const v = (i - (cols - 1) / 2) * (f.across + gap);
            const x = cell.x + dir.x * u + nrm.x * v;
            const z = cell.z + dir.z * u + nrm.z * v;
            if (!fitsInside(x, z, dir, nrm, f.along / 2, f.across / 2, bounds)) continue;
            const flip = j % 2 === 1 ? Math.PI : 0;
            const rotY = -cell.angle + flip;
            if (mode === 'edge') {
                out.push({ x, z, rotY, tiltX: Math.PI / 2, lift: dims.width / 2 });
            } else if (mode === 'nested') {
                out.push({ x, z, rotY, tiltX: 0, lift: 0 });
                out.push({ x, z, rotY: rotY + Math.PI, tiltX: Math.PI, lift: dims.height * 1.5 });
            } else {
                out.push({ x, z, rotY, tiltX: 0, lift: 0 });
            }
        }
    }
    return out;
}

// A shoe only counts if its whole footprint stays inside the drawer walls:
// diagonal lanes are cut short by the corners of the drawer.
function fitsInside(x, z, dir, nrm, halfAlong, halfAcross, bounds) {
    const eps = 1e-4;
    for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
            const px = x + dir.x * su * halfAlong + nrm.x * sv * halfAcross;
            const pz = z + dir.z * su * halfAlong + nrm.z * sv * halfAcross;
            if (px < bounds.x0 - eps || px > bounds.x1 + eps
                || pz < bounds.z0 - eps || pz > bounds.z1 + eps) return false;
        }
    }
    return true;
}

function updateStats(p, panels, cells, shoeCount, dims, freeHeight) {
    const cm = (v) => (v * 100).toFixed(1);
    const pairs = Math.floor(shoeCount / 2);
    const lines = [
        `Cavité mesurée <b>${cm(cavity.x1 - cavity.x0)} × ${cm(cavity.z1 - cavity.z0)} × ${cm(cavity.y1 - cavity.y0)} cm</b>`,
        `Capacité <b>${shoeCount} chaussures</b> (${pairs} paires) en pointure ${p.euSize}`,
        `Chaussure ${cm(dims.length)} × ${cm(dims.width)} × ${cm(dims.height)} cm — hauteur libre ${cm(freeHeight)} cm`,
        `${panels.length} panneaux`,
    ];
    if (shoeCount === 0) lines.push(`<b>${whyEmpty(cells, dims, p.mode, freeHeight, cm)}</b>`);
    document.getElementById('stats').innerHTML = lines.join(' · ');

    const tally = new Map();
    for (const pl of panels) {
        const [t, b, a] = pl.size.map((v) => Math.round(v * 1000)).sort((x, y) => x - y);
        const label = `${pl.name} — ${a} × ${b} × ${t} mm`;
        tally.set(label, (tally.get(label) || 0) + 1);
    }
    document.getElementById('cutlist').innerHTML = [...tally]
        .map(([label, n]) => `<li>${n} × ${label}</li>`).join('');
}

function whyEmpty(cells, dims, mode, freeHeight, cm) {
    const f = footprint(dims, mode);
    if (f.vertical > freeHeight) return `Trop haut : il faut ${cm(f.vertical)} cm, il y a ${cm(freeHeight)} cm`;
    const widest = Math.max(...cells.map((c) => c.width), 0);
    const longest = Math.max(...cells.map((c) => c.length), 0);
    if (f.across > widest) return `Compartiment trop étroit : ${cm(widest)} cm pour ${cm(f.across)} cm nécessaires`;
    if (f.along > longest) return `Compartiment trop court : ${cm(longest)} cm pour ${cm(f.along)} cm nécessaires`;
    return 'Aucune chaussure ne tient dans cette configuration';
}

function bindUI() {
    for (const id of ['design', 'count', 'rows', 'angle', 'thickness', 'height', 'size', 'mode', 'base', 'shoes', 'drawer']) {
        ui[id] = document.getElementById(id);
    }
    ui.hint = document.getElementById('hint');
    ui.rowsOf = {
        count: document.getElementById('row-count'),
        rows: document.getElementById('row-rows'),
        angle: document.getElementById('row-angle'),
    };

    for (const el of Object.values(ui)) {
        if (el instanceof HTMLElement && (el.tagName === 'SELECT' || el.tagName === 'INPUT')) {
            el.addEventListener('input', () => {
                if (el === ui.design) applyDesignDefaults();
                syncOutputs();
                rebuild();
            });
        }
    }
    document.getElementById('view-top').addEventListener('click', () => frameCamera(true));
    document.getElementById('view-reset').addEventListener('click', () => frameCamera(false));
    document.getElementById('optimise').addEventListener('click', optimise);
    document.getElementById('export').addEventListener('click', exportGLB);
    applyDesignDefaults();
    syncOutputs();
}

function applyDesignDefaults() {
    const d = DESIGNS[ui.design.value];
    for (const [k, v] of Object.entries(d.defaults)) {
        if (ui[k]) ui[k].value = v;
    }
}

function syncOutputs() {
    for (const el of document.querySelectorAll('input[type=range]')) {
        const out = document.querySelector(`output[for="${el.id}"]`);
        if (out) out.textContent = el.value;
    }
}

function exportGLB() {
    new GLTFExporter().parse(organiserGroup, (result) => {
        const blob = new Blob([result], { type: 'model/gltf-binary' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `organiseur-${ui.design.value}.glb`;
        a.click();
        URL.revokeObjectURL(a.href);
    }, () => { }, { binary: true });
}

function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
}

renderer.setAnimationLoop(() => {
    resize();
    controls.update();
    renderer.render(scene, camera);
});
