// bench/verify.mjs — behavioural assertions for the occlusion-aware label placer.
// Exit 0 only if every assertion below actually holds. Every printed number is measured.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  buildViewProj, projectPoint, auditVisibility, placeLabels, auditPlacement,
  candidateOffsets, labelBox, overlapPairs, boxesOverlap, placementCost,
} from '../src/core.mjs';
import { placeNaive } from '../baseline/naive.mjs';
import { oracleProject, oracleVisibility, oracleOccluded, oracleOptimal } from './oracle.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const scene = JSON.parse(readFileSync(join(ROOT, 'data/scene.json'), 'utf8'));
const { triangles, labels, camera, viewport } = scene;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS ${name}  ${detail}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

console.log(`# scene: triangles=${triangles.length} labels=${labels.length} viewport=${viewport.w}x${viewport.h}`);

/* A1 — generator determinism (real: re-run the script into a scratch dir) */
const tmp = mkdtempSync(join(tmpdir(), 'labelcast-'));
const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
spawnSync('node', [join(ROOT, 'tools/gen-sample.mjs')], { cwd: ROOT });
const h1 = hashOf(join(ROOT, 'data/scene.json'));
spawnSync('node', [join(ROOT, 'tools/gen-sample.mjs')], { cwd: ROOT });
const h2 = hashOf(join(ROOT, 'data/scene.json'));
writeFileSync(join(tmp, 'unused'), 'x');
ok('A1 gen-sample deterministic', h1 === h2, `sha256 ${h1.slice(0, 16)} == ${h2.slice(0, 16)} after two runs`);

/* A2 — core projection vs independent projection */
const mvp = buildViewProj(camera, viewport);
const dxs = [], dys = [];
for (const l of labels) {
  const a = projectPoint(mvp, l.anchor, viewport);
  const b = oracleProject(camera, viewport, l.anchor);
  if (a.behind !== b.behind) { dxs.push(NaN); continue; }
  if (a.behind) continue;
  dxs.push(a.x - b.x); dys.push(a.y - b.y);
}
ok('A2 projection == independent projection',
  maxAbs(dxs) < 1e-9 && maxAbs(dys) < 1e-9,
  `max|dx|=${maxAbs(dxs).toExponential(3)} px max|dy|=${maxAbs(dys).toExponential(3)} px over ${dxs.length} points`);

/* A3 — core visibility vs independent oracle */
const coreVis = auditVisibility(labels, triangles, camera, viewport);
const orcVis = oracleVisibility(labels, triangles, camera, viewport);
let statusMismatch = 0, witnessMismatch = 0, occludedN = 0, visibleN = 0, behindN = 0;
for (let i = 0; i < labels.length; i++) {
  if (coreVis[i].status !== orcVis[i].status) statusMismatch++;
  if (coreVis[i].status === 'occluded') {
    occludedN++;
    if (!orcVis[i].witness || orcVis[i].witness.tri !== coreVis[i].witness.tri) witnessMismatch++;
  }
  if (coreVis[i].status === 'visible') visibleN++;
  if (coreVis[i].status === 'behind') behindN++;
}
ok('A3 visibility == independent oracle', statusMismatch === 0 && witnessMismatch === 0,
  `${labels.length - statusMismatch}/${labels.length} status agree (visible=${visibleN} occluded=${occludedN} behind=${behindN}), witness triangle ${occludedN - witnessMismatch}/${occludedN} agree`);

/* A4 — baseline overlaps are real and non-zero; placer removes them */
const naive = placeNaive(labels, camera, viewport);
const placed = placeLabels(labels, triangles, camera, viewport);
ok('A4a baseline (draw at anchor) overlaps > 0', naive.stats.overlapCount > 0,
  `naive overlapping pairs = ${naive.stats.overlapCount}`);
ok('A4b placer overlaps == 0', placed.stats.overlapCount === 0,
  `placer overlapping pairs = ${placed.stats.overlapCount}  (leader total ${placed.stats.leaderLength.toFixed(1)} px)`);

/* A5 — independent recount of the placement, different code path */
const audit = auditPlacement(placed);
const orcScreens = labels.map((l) => oracleProject(camera, viewport, l.anchor));
const reBoxes = placed.items.map((it, i) =>
  it.box ? { x: orcScreens[i].x + it.dx - labels[i].w / 2, y: orcScreens[i].y + it.dy - labels[i].h / 2, w: labels[i].w, h: labels[i].h } : null);
const reOverlap = (() => {
  let n = 0;
  for (let i = 0; i < reBoxes.length; i++) for (let j = i + 1; j < reBoxes.length; j++) {
    const a = reBoxes[i], b = reBoxes[j];
    if (!a || !b) continue;
    if (Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w) && Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h)) n++;
  }
  return n;
})();
ok('A5 independent recount matches', audit.overlapCount === placed.stats.overlapCount && reOverlap === placed.stats.overlapCount,
  `auditPlacement=${audit.overlapCount} oracle-projected-recount=${reOverlap} stats=${placed.stats.overlapCount}`);

/* A6 — optimality gap vs exhaustive optimum on a 6-label subset */
const subsetIds = ['B-22', 'B-23', 'B-32', 'B-33', 'B-12', 'B-21'];
const subset = subsetIds.map((id) => labels.find((l) => l.id === id));
const subPlaced = placeLabels(subset, triangles, camera, viewport);
const subBoxes = subPlaced.items.map((it) => it.box);
const subLeaders = subPlaced.items.map((it) => it.leader);
const oursCost = placementCost(subBoxes, subLeaders);
const opt = oracleOptimal(subset, camera, viewport);
const N_CAND = candidateOffsets(subset[0].w, subset[0].h).length;
const gap = oursCost === 0 ? 0 : (oursCost - opt.cost) / Math.max(1, opt.cost);
ok('A6 within 2% of exhaustive optimum (n=6)', oursCost <= opt.cost * 1.02 + 1e-9,
  `ours cost=${oursCost.toFixed(3)} (overlaps=${subPlaced.stats.overlapCount}) optimum=${opt.cost.toFixed(3)} (overlaps=${opt.overlaps}) over ${N_CAND}^6=${N_CAND ** 6} combos, gap=${(gap * 100).toFixed(3)}%`);

/* A7 — scale invariance across 6 orders of magnitude */
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
let scaleStatusMismatch = 0, scaleScreenDrift = 0, scaleZeroOverlap = 0;
for (const s of scales) {
  const tri2 = triangles.map((t) => t.map((p) => [p[0] * s, p[1] * s, p[2] * s]));
  const lab2 = labels.map((l) => ({ ...l, anchor: [l.anchor[0] * s, l.anchor[1] * s, l.anchor[2] * s] }));
  const cam2 = {
    ...camera,
    eye: camera.eye.map((v) => v * s),
    target: camera.target.map((v) => v * s),
  };
  const v2 = auditVisibility(lab2, tri2, cam2, viewport);
  const o2 = oracleVisibility(lab2, tri2, cam2, viewport);
  for (let i = 0; i < lab2.length; i++) if (v2[i].status !== o2[i].status) scaleStatusMismatch++;
  for (let i = 0; i < lab2.length; i++) {
    if (v2[i].screen && coreVis[i].screen) {
      scaleScreenDrift = Math.max(scaleScreenDrift, Math.abs(v2[i].screen.x - coreVis[i].screen.x), Math.abs(v2[i].screen.y - coreVis[i].screen.y));
    }
  }
  const p2 = placeLabels(lab2, tri2, cam2, viewport);
  if (p2.stats.overlapCount === 0) scaleZeroOverlap++;
}
ok('A7 scale invariance s in {1e-6..1e6}', scaleStatusMismatch === 0 && scaleScreenDrift < 1e-6 && scaleZeroOverlap === scales.length,
  `status mismatches=${scaleStatusMismatch}/${scales.length * labels.length}, max screen drift=${scaleScreenDrift.toExponential(3)} px, zero-overlap at ${scaleZeroOverlap}/${scales.length} scales`);

/* A8 — degenerate cases: anchor behind the eye, and a blocker in front */
const synthLabels = [
  { id: 'front', anchor: [0, 0, 0], w: 40, h: 12 },
  { id: 'behind', anchor: [0, 0, 10], w: 40, h: 12 },
];
const synthCam = { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fovYDeg: 45, near: 0.1, far: 100 };
const synthTri = [[[-1, -1, 1], [1, -1, 1], [0, 1, 1]]];
const sVis = auditVisibility(synthLabels, synthTri, synthCam, viewport);
const sPlace = placeLabels(synthLabels, synthTri, synthCam, viewport);
ok('A8a anchor behind eye => status behind, no box',
  sVis[1].status === 'behind' && sPlace.items[1].box === null && sPlace.items[1].dx === null,
  `status=${sVis[1].status} box=${sPlace.items[1].box}`);
ok('A8b blocker in front => occluded with witness tri 0',
  sVis[0].status === 'occluded' && sVis[0].witness.tri === 0 && oracleOccluded(synthLabels[0].anchor, synthCam.eye, synthTri).tri === 0,
  `status=${sVis[0].status} witness tri=${sVis[0].witness && sVis[0].witness.tri} oracle tri=${oracleOccluded(synthLabels[0].anchor, synthCam.eye, synthTri).tri}`);

/* A9 — placement is deterministic */
const r1 = createHash('sha256').update(JSON.stringify(placeLabels(labels, triangles, camera, viewport).items)).digest('hex');
const r2 = createHash('sha256').update(JSON.stringify(placeLabels(labels, triangles, camera, viewport).items)).digest('hex');
ok('A9 placement deterministic', r1 === r2, `sha256 ${r1.slice(0, 16)} == ${r2.slice(0, 16)}`);

/* A10 — witness hit parameter cross-checked by the independent plane/barycentric oracle */
let tMaxRel = 0, checked = 0;
for (let i = 0; i < labels.length; i++) {
  if (coreVis[i].status !== 'occluded') continue;
  const ow = oracleOccluded(labels[i].anchor, camera.eye, triangles);
  if (!ow || ow.tri !== coreVis[i].witness.tri) continue;
  checked++;
  const d = [camera.eye[0] - labels[i].anchor[0], camera.eye[1] - labels[i].anchor[1], camera.eye[2] - labels[i].anchor[2]];
  const segLen = Math.hypot(d[0], d[1], d[2]);
  const tFractions = coreVis[i].witness.t / segLen;   // core returns a distance; oracle a fraction
  tMaxRel = Math.max(tMaxRel, Math.abs(ow.t - tFractions) / Math.max(1e-30, ow.t));
}
ok('A10 witness hit distance agrees with oracle', tMaxRel < 1e-6,
  `${checked}/${occludedN} witnesses cross-checked, max relative |dt|=${tMaxRel.toExponential(3)}`);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
