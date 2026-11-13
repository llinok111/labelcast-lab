// src/core.mjs — occlusion-aware 3D label placement.
//
// PURE ES module: no `three`, no DOM (window/document/navigator), no I/O, no env vars,
// no top-level side effects. `node -e "import('./src/core.mjs')"` must succeed.
//
// Units: world coordinates are in scene units; viewport and label sizes are in CSS pixels.
// Every tolerance in this file is RELATIVE (scaled by a local length) so that the whole
// pipeline is scale invariant — see README "Known limits".

/* ------------------------------------------------------------------ vec3 ---- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.sqrt(dot(a, a));
const unit = (a) => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/* ------------------------------------------------------------- 4x4 matrix --- */
// Row-major: m[r*4+c]. Column vectors, right-handed, camera looks down -Z.

export function mat4Mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] =
        a[r * 4 + 0] * b[0 * 4 + c] +
        a[r * 4 + 1] * b[1 * 4 + c] +
        a[r * 4 + 2] * b[2 * 4 + c] +
        a[r * 4 + 3] * b[3 * 4 + c];
    }
  }
  return o;
}

export function lookAt(eye, target, up = [0, 1, 0]) {
  const f = unit(sub(target, eye));
  const s = unit(cross(f, up));
  const u = cross(s, f);
  return [
    s[0], s[1], s[2], -dot(s, eye),
    u[0], u[1], u[2], -dot(u, eye),
    -f[0], -f[1], -f[2], dot(f, eye),
    0, 0, 0, 1,
  ];
}

export function perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), (2 * far * near) / (near - far),
    0, 0, -1, 0,
  ];
}

export function transform4(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
    m[12] * x + m[13] * y + m[14] * z + m[15],
  ];
}

export function buildViewProj(camera, viewport) {
  const view = lookAt(camera.eye, camera.target, camera.up ?? [0, 1, 0]);
  const proj = perspective(
    ((camera.fovYDeg ?? 45) * Math.PI) / 180,
    viewport.w / viewport.h,
    camera.near ?? 0.1,
    camera.far ?? 1000
  );
  return mat4Mul(proj, view);
}

/** Project a world point to screen pixels. Returns { behind:true } for points at/behind the eye. */
export function projectPoint(mvp, p, viewport) {
  const c = transform4(mvp, p);
  const cw = c[3];
  if (!(cw > 0) || !Number.isFinite(cw)) {
    return { behind: true, x: NaN, y: NaN, depth: NaN, w: cw };
  }
  return {
    behind: false,
    x: (c[0] / cw * 0.5 + 0.5) * viewport.w,
    y: (1 - (c[1] / cw * 0.5 + 0.5)) * viewport.h,
    depth: c[2] / cw,
    w: cw,
  };
}

/* ------------------------------------------------------------- occlusion ---- */
// Relative tolerances (dimensionless). tMin/tMax are fractions of |eye - anchor|.
export const TOL_RAY = 1e-9;   // reject hits within 1e-9 of either endpoint
export const TOL_DET = 1e-12;  // |det| < TOL_DET * |e1| * |e2|  => ray parallel to triangle

/**
 * Moller-Trumbore. `dir` MUST be unit length; the returned `t` is then a world distance.
 * Parallel test is relative to the triangle's own edge lengths (scale invariant).
 */
export function rayTriangleT(origin, dir, a, b, c) {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const pv = cross(dir, e2);
  const det = dot(e1, pv);
  const scale = len(e1) * len(e2);
  if (!(Math.abs(det) > TOL_DET * scale)) return null;
  const inv = 1 / det;
  const tv = sub(origin, a);
  const u = dot(tv, pv) * inv;
  if (u < 0 || u > 1) return null;
  const qv = cross(tv, e1);
  const v = dot(dir, qv) * inv;
  if (v < 0 || u + v > 1) return null;
  return dot(e2, qv) * inv;
}

/**
 * Nearest triangle blocking the segment anchor -> eye.
 * Returns { tri, t } (witness) or null when the anchor is visible.
 */
export function occlusionWitness(anchor, eye, triangles) {
  const d = sub(eye, anchor);
  const L = len(d);
  if (!(L > 0)) return null;
  const dir = [d[0] / L, d[1] / L, d[2] / L];
  const tMin = TOL_RAY * L;
  const tMax = (1 - TOL_RAY) * L;
  let best = null;
  for (let i = 0; i < triangles.length; i++) {
    const t = rayTriangleT(anchor, dir, triangles[i][0], triangles[i][1], triangles[i][2]);
    if (t === null || t <= tMin || t >= tMax) continue;
    if (best === null || t < best.t) best = { tri: i, t };
  }
  return best;
}

/**
 * Per-label visibility audit: 'behind' | 'occluded' (with witness triangle + hit distance)
 * | 'visible'. Does not place anything.
 */
export function auditVisibility(labels, triangles, camera, viewport) {
  const mvp = buildViewProj(camera, viewport);
  return labels.map((l) => {
    const p = projectPoint(mvp, l.anchor, viewport);
    if (p.behind) return { id: l.id, status: 'behind', witness: null, screen: null };
    const w = occlusionWitness(l.anchor, camera.eye, triangles);
    return {
      id: l.id,
      status: w ? 'occluded' : 'visible',
      witness: w,
      screen: { x: p.x, y: p.y, depth: p.depth },
    };
  });
}

/* -------------------------------------------------------- screen geometry ---- */
export function labelBox(screen, w, h, off) {
  return { x: screen.x + off.dx - w / 2, y: screen.y + off.dy - h / 2, w, h };
}

export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** All overlapping index pairs (i<j) among a box array; null entries are skipped. */
export function overlapPairs(boxes) {
  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    if (!boxes[i]) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      if (!boxes[j]) continue;
      if (boxesOverlap(boxes[i], boxes[j])) out.push([i, j]);
    }
  }
  return out;
}

/**
 * Discrete candidate placements for one label: the anchor itself plus 8 compass
 * directions at each radius in `opts.ring` (default: one ring at 0.6 * max(w,h)).
 * `leader` is the distance from the anchor to the box centre.
 */
export function candidateOffsets(w, h, opts = {}) {
  const ring = opts.ring ?? [Math.max(w, h) * 0.6];
  const out = [{ dx: 0, dy: 0, leader: 0, tag: 'anchor' }];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  for (let r = 0; r < ring.length; r++) {
    for (let k = 0; k < dirs.length; k++) {
      const dl = Math.hypot(dirs[k][0], dirs[k][1]);
      out.push({
        dx: (dirs[k][0] / dl) * ring[r],
        dy: (dirs[k][1] / dl) * ring[r],
        leader: ring[r],
        tag: `r${r}d${k}`,
      });
    }
  }
  return out;
}

/** Weight (in px of leader length) of one overlapping pair. Must dominate leader length. */
export const COST_OVERLAP = 1e6;

export function placementCost(boxes, leaders) {
  let c = overlapPairs(boxes).length * COST_OVERLAP;
  for (const l of leaders) c += l;
  return c;
}

/* --------------------------------------------------------------- placement --- */
/**
 * Place every label box so screen-space overlaps are minimised.
 *
 * labels:    [{ id, anchor:[x,y,z], w, h, text? }]
 * triangles: [[[x,y,z],[x,y,z],[x,y,z]], ...]
 * camera:    { eye, target, up?, fovYDeg, near, far }
 * viewport:  { w, h }
 * opts:      { ring?, maxPass? }  (maxPass = local-search passes, default 8)
 *
 * Visible anchors are placed first, occluded ones afterwards (occlusion-aware priority).
 * All numbers returned are recomputable from the inputs alone.
 */
export function placeLabels(labels, triangles, camera, viewport, opts = {}) {
  const mvp = buildViewProj(camera, viewport);
  const meta = labels.map((l) => {
    const p = projectPoint(mvp, l.anchor, viewport);
    const witness = p.behind ? null : occlusionWitness(l.anchor, camera.eye, triangles);
    return {
      id: l.id,
      p,
      witness,
      status: p.behind ? 'behind' : witness ? 'occluded' : 'visible',
    };
  });

  const live = [];
  for (let i = 0; i < labels.length; i++) if (!meta[i].p.behind) live.push(i);
  live.sort((i, j) => {
    const a = meta[i], b = meta[j];
    const pa = a.status === 'visible' ? 0 : 1;
    const pb = b.status === 'visible' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.p.y !== b.p.y) return a.p.y - b.p.y;
    if (a.p.x !== b.p.x) return a.p.x - b.p.x;
    return i - j;
  });

  const cands = labels.map((l) => candidateOffsets(l.w, l.h, opts));
  const choice = new Array(labels.length).fill(0);
  const boxes = new Array(labels.length).fill(null);

  // Greedy: place in priority order, picking the cheapest candidate against what is placed.
  for (const i of live) {
    const l = labels[i], p = meta[i].p, cs = cands[i];
    let best = null;
    for (let c = 0; c < cs.length; c++) {
      const box = labelBox(p, l.w, l.h, cs[c]);
      let ov = 0;
      for (const j of live) {
        if (j === i || !boxes[j]) continue;
        if (boxesOverlap(box, boxes[j])) ov++;
      }
      const cost = ov * COST_OVERLAP + cs[c].leader;
      if (best === null || cost < best.cost - 1e-12) best = { c, cost, box };
    }
    choice[i] = best.c;
    boxes[i] = best.box;
  }

  // Local search: a single label may move to any candidate if that lowers the global cost.
  const maxPass = opts.maxPass ?? 8;
  for (let pass = 0; pass < maxPass; pass++) {
    let improved = false;
    for (const i of live) {
      const l = labels[i], p = meta[i].p, cs = cands[i], cur = choice[i];
      const localCost = (box, leader) => {
        let ov = 0;
        for (const j of live) {
          if (j === i || !boxes[j]) continue;
          if (boxesOverlap(box, boxes[j])) ov++;
        }
        return ov * COST_OVERLAP + leader;
      };
      const before = localCost(boxes[i], cs[cur].leader);
      let bestC = cur, bestBox = boxes[i], bestCost = before;
      for (let c = 0; c < cs.length; c++) {
        if (c === cur) continue;
        const box = labelBox(p, l.w, l.h, cs[c]);
        const cost = localCost(box, cs[c].leader);
        if (cost < bestCost - 1e-12) { bestC = c; bestBox = box; bestCost = cost; }
      }
      if (bestC !== cur) { choice[i] = bestC; boxes[i] = bestBox; improved = true; }
    }
    if (!improved) break;
  }

  const items = labels.map((l, i) => {
    if (meta[i].p.behind) {
      return {
        id: l.id, status: 'behind', screen: null, witness: null,
        dx: null, dy: null, leader: 0, box: null, text: l.text ?? null,
      };
    }
    const off = cands[i][choice[i]];
    return {
      id: l.id,
      status: meta[i].status,
      screen: { x: meta[i].p.x, y: meta[i].p.y, depth: meta[i].p.depth },
      witness: meta[i].witness,
      dx: off.dx,
      dy: off.dy,
      leader: off.leader,
      box: boxes[i],
      text: l.text ?? null,
    };
  });

  const liveBoxes = items.map((it) => it.box);
  const pairs = overlapPairs(liveBoxes);
  const stats = {
    total: labels.length,
    placed: live.length,
    visible: meta.filter((m) => m.status === 'visible').length,
    occluded: meta.filter((m) => m.status === 'occluded').length,
    behind: meta.filter((m) => m.status === 'behind').length,
    overlapCount: pairs.length,
    overlapPairs: pairs,
    leaderLength: items.reduce((s, it) => s + (it.leader || 0), 0),
  };

  return { items, stats, viewport, camera };
}

/** Independent-ish re-count of overlaps straight off a placement result (audit entry point). */
export function auditPlacement(result) {
  const boxes = result.items.map((it) => it.box);
  const pairs = overlapPairs(boxes);
  return {
    overlapCount: pairs.length,
    overlapPairs: pairs,
    leaderLength: result.items.reduce((s, it) => s + (it.leader || 0), 0),
    occludedIds: result.items.filter((it) => it.status === 'occluded').map((it) => it.id),
    behindIds: result.items.filter((it) => it.status === 'behind').map((it) => it.id),
    witnessTris: result.items
      .filter((it) => it.witness)
      .map((it) => ({ id: it.id, tri: it.witness.tri, t: it.witness.t })),
  };
}
