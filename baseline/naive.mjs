// baseline/naive.mjs — the baseline every number in README is compared against.
//
// This is what a three.js CSS2DRenderer-style scene does: it draws each label at the
// projected anchor point with no collision avoidance at all. It shares only the
// projection with src/core.mjs (nothing else), so the comparison is honest:
// the baseline is not a strawman we wrote badly on purpose, it is the actual behaviour
// of "put a div at the projected anchor".
//
// Run:  node baseline/naive.mjs        (prints the baseline stats for the sample scene)
import { readFileSync } from 'node:fs';
import { buildViewProj, projectPoint, labelBox, overlapPairs } from '../src/core.mjs';

export function placeNaive(labels, camera, viewport) {
  const mvp = buildViewProj(camera, viewport);
  const items = labels.map((l) => {
    const p = projectPoint(mvp, l.anchor, viewport);
    if (p.behind) {
      return { id: l.id, status: 'behind', screen: null, dx: 0, dy: 0, leader: 0, box: null, text: l.text ?? null };
    }
    const off = { dx: 0, dy: 0, leader: 0 };
    return {
      id: l.id,
      status: 'placed',           // no occlusion test at all
      screen: { x: p.x, y: p.y, depth: p.depth },
      witness: null,
      dx: 0, dy: 0, leader: 0,
      box: labelBox(p, l.w, l.h, off),
      text: l.text ?? null,
    };
  });
  const boxes = items.map((it) => it.box);
  const pairs = overlapPairs(boxes);
  return {
    items,
    stats: {
      total: labels.length,
      placed: items.filter((it) => it.box).length,
      overlapCount: pairs.length,
      overlapPairs: pairs,
      leaderLength: 0,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scene = JSON.parse(readFileSync(new URL('../data/scene.json', import.meta.url), 'utf8'));
  const r = placeNaive(scene.labels, scene.camera, scene.viewport);
  console.log(JSON.stringify({ placed: r.stats.placed, overlappingPairs: r.stats.overlapCount }, null, 2));
}
