// bench/bench.mjs — timing for the placer vs the baseline on the sample scene.
// warmup 1 + 7 measured runs, median + min/p25/p75/p95/stddev, cold start recorded separately.
// Writes bench/result.json. Every number here comes from a real run on this machine.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { placeLabels, auditVisibility, buildViewProj, projectPoint } from '../src/core.mjs';
import { placeNaive } from '../baseline/naive.mjs';
import { oracleVisibility, oracleOccluded } from './oracle.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const scene = JSON.parse(readFileSync(join(ROOT, 'data/scene.json'), 'utf8'));
const { triangles, labels, camera, viewport } = scene;

const REPEATS = 7;
const time = (fn) => {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return {
    n: s.length,
    min: +s[0].toFixed(3),
    p25: +pct(0.25).toFixed(3),
    median: +pct(0.5).toFixed(3),
    p75: +pct(0.75).toFixed(3),
    p95: +pct(0.95).toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    mean: +mean.toFixed(3),
    stddev: +sd.toFixed(3),
    rsdPct: +((sd / mean) * 100).toFixed(3),
  };
};

// cold start: very first call, including module warm-up of the JIT
const cold = time(() => placeLabels(labels, triangles, camera, viewport)).ms;
// warmup
placeLabels(labels, triangles, camera, viewport);

const ours = [], naive = [], vis = [], orcVis = [];
let oursResult = null, naiveResult = null;
for (let i = 0; i < REPEATS; i++) {
  const a = time(() => placeLabels(labels, triangles, camera, viewport)); ours.push(a.ms); oursResult = a.r;
  const b = time(() => placeNaive(labels, camera, viewport)); naive.push(b.ms); naiveResult = b.r;
  const c = time(() => auditVisibility(labels, triangles, camera, viewport)); vis.push(c.ms);
  const d = time(() => oracleVisibility(labels, triangles, camera, viewport)); orcVis.push(d.ms);
}
// separate micro-measurement: pure occlusion cost (all anchors vs all triangles)
const occ = time(() => labels.map((l) => oracleOccluded(l.anchor, camera.eye, triangles)).length);

const result = {
  scene: {
    triangleCount: triangles.length,
    labelCount: labels.length,
    viewport,
    seed: scene.seed,
  },
  method: {
    repeats: REPEATS,
    warmup: 1,
    timing: 'performance.now() around the whole call; median of the repeats reported',
    note: 'coldStartMs is the very first invocation of placeLabels in this process, before any warmup',
  },
  timings: {
    placeLabels: { coldStartMs: +cold.toFixed(3), ...stats(ours) },
    naivePlaceAtAnchor: stats(naive),
    auditVisibility: stats(vis),
    oracleVisibility: stats(orcVis),
  },
  occlusionMicro: {
    oracleOcclusionOnly: {
      rayCount: labels.length,
      triangleCount: triangles.length,
      rayTriangleTests: labels.length * triangles.length,
      ms: +occ.ms.toFixed(3),
    },
  },
  placement: {
    overlaps: { naive: naiveResult.stats.overlapCount, placer: oursResult.stats.overlapCount },
    leaderLengthPx: +oursResult.stats.leaderLength.toFixed(3),
    visible: oursResult.stats.visible,
    occluded: oursResult.stats.occluded,
    behind: oursResult.stats.behind,
  },
  correctness: {
    independentVisibilityAgreement:
      oursResult.items.filter((it, i) => it.status === oracleVisibility(labels, triangles, camera, viewport)[i].status).length,
    totalLabels: labels.length,
  },
};
writeFileSync(join(ROOT, 'bench/result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.timings, null, 2));
console.log(JSON.stringify(result.placement, null, 2));
console.log(`wrote bench/result.json  (naive overlaps=${result.placement.overlaps.naive} -> placer overlaps=${result.placement.overlaps.placer})`);
