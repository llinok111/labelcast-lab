// main.js — renderer + interaction ONLY. All geometry/visibility/placement maths lives in
// src/core.mjs, which is the exact same file node runs under bench/verify.mjs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { placeLabels, auditVisibility } from './src/core.mjs';

const scene = await (await fetch('./data/scene.json')).json();
let reference = null;
try { reference = await (await fetch('./data/reference.json')).json(); } catch { /* bake optional */ }
const triangles = scene.triangles;
const labels = scene.labels.map((l) => ({ ...l }));

/* ---------------------------------------------------------------- three.js --- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(0x0b0e13);
const camera = new THREE.PerspectiveCamera(
  scene.camera.fovYDeg, 1, scene.camera.near, scene.camera.far);
camera.position.set(...scene.camera.eye);
scene3.add(new THREE.HemisphereLight(0xdfefff, 0x2a3444, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(12, 22, 10);
scene3.add(dir);

const pos = [];
for (const t of triangles) for (const v of t) pos.push(v[0], v[1], v[2]);
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
geo.computeVertexNormals();
const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
  color: 0x5d7fa8, metalness: 0.1, roughness: 0.75, flatShading: true,
}));
scene3.add(mesh);
scene3.add(new THREE.GridHelper(24, 24, 0x223044, 0x1a2431));
// anchor markers
scene3.add(new THREE.Points(
  new THREE.BufferGeometry().setAttribute('position',
    new THREE.Float32BufferAttribute(labels.flatMap((l) => l.anchor), 3)),
  new THREE.PointsMaterial({ color: 0x3ddc97, size: 0.22, sizeAttenuation: true })));

const controls = new OrbitControls(camera, canvas);
controls.target.set(...scene.camera.target);
controls.enableDamping = true;

/* -------------------------------------------------------------- DOM overlay --- */
const labelHost = document.getElementById('labels');
const leadCanvas = document.getElementById('leaders');
const leadCtx = leadCanvas.getContext('2d');
const doms = labels.map((l) => {
  const d = document.createElement('div');
  d.className = 'label';
  d.textContent = l.text || l.id;
  labelHost.appendChild(d);
  return d;
});

const el = (id) => document.getElementById(id);
const sliderW = el('w'), sliderR = el('r');
let msLast = 0, msMedian = 0;

function viewportSize() {
  return { w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight };
}

function frame() {
  controls.update();
  const vp = viewportSize();
  renderer.setSize(vp.w, vp.h, false);
  camera.aspect = vp.w / vp.h;
  camera.updateProjectionMatrix();
  leadCanvas.width = vp.w; leadCanvas.height = vp.h;

  const labelW = +sliderW.value;
  const ring = +sliderR.value;
  for (const l of labels) l.w = labelW;
  const cam = {
    eye: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray(),
    fovYDeg: camera.fov,
    near: camera.near,
    far: camera.far,
  };

  const t0 = performance.now();
  const out = placeLabels(labels, triangles, cam, vp, { ring: [ring] });
  const ms = performance.now() - t0;
  msLast = ms;
  msMedian = msMedian === 0 ? ms : msMedian * 0.85 + ms * 0.15;

  const naiveVerdicts = auditVisibility(labels, triangles, cam, vp);

  // draw boxes + leader lines straight from core's output
  leadCtx.clearRect(0, 0, vp.w, vp.h);
  for (let i = 0; i < out.items.length; i++) {
    const it = out.items[i], d = doms[i];
    d.className = 'label ' + it.status;
    if (!it.box) { d.style.display = 'none'; continue; }
    d.style.display = 'block';
    d.style.left = (it.box.x + it.box.w / 2) + 'px';
    d.style.top = (it.box.y + it.box.h / 2) + 'px';
    d.style.width = it.box.w + 'px';
    d.style.height = it.box.h + 'px';
    d.style.lineHeight = (it.box.h - 4) + 'px';
    if (it.leader > 0 && it.screen) {
      leadCtx.strokeStyle = it.status === 'occluded' ? 'rgba(255,107,107,.75)' : 'rgba(61,220,151,.75)';
      leadCtx.lineWidth = 1;
      leadCtx.beginPath();
      leadCtx.moveTo(it.screen.x, it.screen.y);
      leadCtx.lineTo(it.box.x + it.box.w / 2, it.box.y + it.box.h / 2);
      leadCtx.stroke();
    }
  }

  // ---- HUD: every number is core's own output, recomputed live ----
  const s = out.stats;
  el('s-total').textContent = String(s.total);
  el('s-vis').textContent = `${s.visible}/${s.occluded}/${s.behind}`;
  el('s-ov').textContent = String(s.overlapCount);
  el('s-naive').textContent = String(countAtAnchor(labels, cam, vp));
  el('s-lead').textContent = s.leaderLength.toFixed(0);
  el('s-ms').textContent = msMedian.toFixed(3);
  el('w-v').textContent = String(labelW);
  el('r-v').textContent = String(ring);
  el('s-ref').textContent = compareToReference(s, out, cam);

  renderer.render(scene3, camera);
  requestAnimationFrame(frame);
}

/** Tiny in-page baseline: how many pairs overlap if every box is drawn at its anchor. */
function countAtAnchor(labs, cam, vp) {
  const v = auditVisibility(labs, triangles, cam, vp);
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    if (!v[i].screen) continue;
    for (let j = i + 1; j < v.length; j++) {
      if (!v[j].screen) continue;
      const a = v[i].screen, b = v[j].screen;
      const ax = a.x - labs[i].w / 2, ay = a.y - labs[i].h / 2;
      const bx = b.x - labs[j].w / 2, by = b.y - labs[j].h / 2;
      if (Math.max(ax, bx) < Math.min(ax + labs[i].w, bx + labs[j].w) &&
          Math.max(ay, by) < Math.min(ay + labs[i].h, by + labs[j].h)) n++;
    }
  }
  return n;
}

/** Compare the live numbers with the node-baked ones — only meaningful at the default camera. */
function compareToReference(s, out, cam) {
  if (!reference) return 'no bake';
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const near = d(cam.eye, scene.camera.eye) + d(cam.target, scene.camera.target);
  if (near > 1e-3) return 'camera moved (bake is for the default view)';
  const same = s.overlapCount === reference.overlaps.placer &&
               s.visible === reference.visible &&
               s.occluded === reference.occluded;
  return same
    ? `MATCH  overlaps=${s.overlapCount} visible=${s.visible} occluded=${s.occluded}`
    : `MISMATCH live(ov=${s.overlapCount} vis=${s.visible} occ=${s.occluded}) vs bake(ov=${reference.overlaps.placer} vis=${reference.visible} occ=${reference.occluded})`;
}

window.addEventListener('resize', () => { msMedian = 0; });
requestAnimationFrame(frame);
