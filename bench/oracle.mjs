// bench/oracle.mjs — INDEPENDENT re-implementations used to falsify src/core.mjs.
//
// Deliberately does NOT reuse core's projection matrix code, core's Moller-Trumbore routine,
// or core's ray tolerances. It replaces all three with different formulations:
//
//   projection : explicit camera basis + focal length in pixels (no 4x4 matrices at all)
//   occlusion  : plane intersection + normalised barycentric areas (dimensionless),
//                with its own tolerance TOL_BARY = 1e-9 and its own relative hit window
//                TOL_T = 1e-7  (core uses TOL_RAY = 1e-9 and TOL_DET = 1e-12)
//   placement  : exhaustive enumeration of the whole candidate product
//                (core uses greedy + local search)
//
// The one thing it DOES share is core's discrete candidate generator / box predicate /
// cost weight, because the optimality claim is "within X% of the optimum over the same
// candidate space". That sharing is disclosed in README "Known limits".
import { candidateOffsets, labelBox, boxesOverlap, COST_OVERLAP } from '../src/core.mjs';

export const TOL_BARY = 1e-9;
export const TOL_T = 1e-7;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const nrm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Independent projection: camera basis + pixel focal length. */
export function oracleProject(camera, viewport, p) {
  const eye = camera.eye;
  const fwd = nrm(sub(camera.target, eye));
  const upHint = camera.up ?? [0, 1, 0];
  const right = nrm(cross(fwd, upHint));
  const up = cross(right, fwd);
  const rel = sub(p, eye);
  const ze = dot(rel, fwd);
  if (!(ze > 0)) return { behind: true };
  const xe = dot(rel, right);
  const ye = dot(rel, up);
  const focal = (viewport.h / 2) / Math.tan((((camera.fovYDeg ?? 45) * Math.PI) / 180) / 2);
  return {
    behind: false,
    x: viewport.w / 2 + (xe / ze) * focal,
    y: viewport.h / 2 - (ye / ze) * focal,
    depth: ze,
  };
}

/** Independent occlusion: plane hit + normalised barycentric coords (area ratios). */
export function oracleOccluded(anchor, eye, triangles) {
  const d = sub(eye, anchor);
  const L = Math.hypot(d[0], d[1], d[2]);
  if (!(L > 0)) return null;
  let best = null;
  for (let i = 0; i < triangles.length; i++) {
    const [a, b, c] = triangles[i];
    const n = cross(sub(b, a), sub(c, a));
    const denom = dot(n, sub(eye, anchor));
    if (denom === 0) continue;
    const t = dot(n, sub(a, anchor)) / denom;
    if (!(t > TOL_T && t < 1 - TOL_T)) continue;
    const hit = [anchor[0] + d[0] * t, anchor[1] + d[1] * t, anchor[2] + d[2] * t];
    // normalised barycentric coordinates via unsigned sub-triangle areas
    const area = (p, q, r) => {
      const v = cross(sub(q, p), sub(r, p));
      return Math.hypot(v[0], v[1], v[2]) / 2;
    };
    const A = area(a, b, c);
    if (!(A > 0)) continue;
    const w0 = area(hit, b, c) / A;
    const w1 = area(a, hit, c) / A;
    const w2 = area(a, b, hit) / A;
    if (w0 < -TOL_BARY || w1 < -TOL_BARY || w2 < -TOL_BARY) continue;
    if (w0 + w1 + w2 > 1 + 3 * TOL_BARY) continue;
    if (best === null || t < best.t) best = { tri: i, t };
  }
  return best;
}

export function oracleVisibility(labels, triangles, camera, viewport) {
  return labels.map((l) => {
    const s = oracleProject(camera, viewport, l.anchor);
    if (s.behind) return { id: l.id, status: 'behind', witness: null };
    const w = oracleOccluded(l.anchor, camera.eye, triangles);
    return { id: l.id, status: w ? 'occluded' : 'visible', witness: w };
  });
}

/**
 * Exhaustive optimum over the SAME candidate space core searches greedily.
 * Only usable for small label subsets (k candidates ^ n labels).
 */
export function oracleOptimal(labels, camera, viewport, opts = {}) {
  const cands = labels.map((l) => candidateOffsets(l.w, l.h, opts));
  const screens = labels.map((l) => oracleProject(camera, viewport, l.anchor));
  const n = labels.length;
  const idx = new Array(n).fill(0);
  let best = null;
  const boxes = new Array(n);
  const total = cands.reduce((s, c) => s * c.length, 1);

  for (let combo = 0; combo < total; combo++) {
    let rem = combo;
    for (let i = 0; i < n; i++) {
      idx[i] = rem % cands[i].length;
      rem = (rem - idx[i]) / cands[i].length;
    }
    let ov = 0;
    let leader = 0;
    for (let i = 0; i < n; i++) {
      boxes[i] = labelBox(screens[i], labels[i].w, labels[i].h, cands[i][idx[i]]);
      leader += cands[i][idx[i]].leader;
    }
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) if (boxesOverlap(boxes[i], boxes[j])) ov++;
    const cost = ov * COST_OVERLAP + leader;
    if (best === null || cost < best.cost) {
      best = { cost, overlaps: ov, leader, choice: idx.slice(), boxes: boxes.map((b) => ({ ...b })) };
    }
  }
  return best;
}
