// tools/gen-sample.mjs — deterministic sample scene: a 5x5 block of extruded boxes on a
// ground plane, plus 40 annotation anchors (25 on box roofs, 15 on the ground between
// blocks). Writes data/scene.json. Same command => byte-identical file (seeded PRNG).
//
// node tools/gen-sample.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// mulberry32 — tiny deterministic PRNG, no dependency.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quad(p0, p1, p2, p3, tris) {
  tris.push([p0, p1, p2], [p0, p2, p3]);
}

function box(cx, cz, h, half, tris) {
  const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
  const b = [
    [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1],
    [x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1],
  ];
  quad(b[4], b[5], b[6], b[7], tris); // roof (+y)
  quad(b[0], b[3], b[2], b[1], tris); // floor (unused visually, keeps the box closed)
  quad(b[0], b[1], b[5], b[4], tris);
  quad(b[1], b[2], b[6], b[5], tris);
  quad(b[2], b[3], b[7], b[6], tris);
  quad(b[3], b[0], b[4], b[7], tris);
}

function build() {
  const rnd = mulberry32(20261113);
  const triangles = [];
  // ground: 20x20 slab at y=0
  quad([-10, 0, -10], [-10, 0, 10], [10, 0, 10], [10, 0, -10], triangles);

  const labels = [];
  const half = 1.5;
  const cells = [-8, -4, 0, 4, 8];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const h = 1.6 + rnd() * 5.4; // 1.6 .. 7.0
      const x = cells[c], z = cells[r];
      box(x, z, h, half, triangles);
      labels.push({
        id: `B-${r}${c}`,
        anchor: [x, h, z],
        w: 72,
        h: 20,
        text: `BLDG ${r}${c} h=${h.toFixed(2)}`,
      });
    }
  }
  // 15 ground anchors on a deterministic lattice — several will be hidden behind blocks.
  const groundPts = [
    [-6, -2], [-6, 2], [-2, -6], [-2, -2], [-2, 2], [-2, 6], [2, -6], [2, -2],
    [2, 2], [2, 6], [6, -2], [6, 2], [0, 0], [4, 4], [-4, 4],
  ];
  for (let i = 0; i < groundPts.length; i++) {
    const [x, z] = groundPts[i];
    labels.push({
      id: `G-${String(i).padStart(2, '0')}`,
      anchor: [x, 0.02, z],
      w: 64,
      h: 18,
      text: `NODE ${i}`,
    });
  }

  const camera = {
    eye: [17, 12, 21],
    target: [0, 1.6, 0],
    up: [0, 1, 0],
    fovYDeg: 45,
    near: 0.1,
    far: 200,
  };
  return { seed: 20261113, viewport: { w: 1200, h: 760 }, camera, triangles, labels };
}

const scene = build();
mkdirSync(join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(scene);
writeFileSync(join(ROOT, 'data', 'scene.json'), json);
const hash = createHash('sha256').update(json).digest('hex');
console.log(
  `wrote data/scene.json  triangles=${scene.triangles.length} labels=${scene.labels.length} bytes=${json.length} sha256=${hash.slice(0, 16)}`
);

// Node-baked reference for the default camera: main.js compares its live numbers with this.
const { placeLabels } = await import('../src/core.mjs');
const out = placeLabels(scene.labels, scene.triangles, scene.camera, scene.viewport);
const reference = {
  note: 'node bake for the DEFAULT camera only; main.js flags a MISMATCH when the live numbers differ',
  seed: scene.seed,
  overlaps: { placer: out.stats.overlapCount },
  visible: out.stats.visible,
  occluded: out.stats.occluded,
  behind: out.stats.behind,
  leaderLength: +out.stats.leaderLength.toFixed(6),
  itemHash: createHash('sha256').update(JSON.stringify(out.items)).digest('hex'),
};
const refJson = JSON.stringify(reference);
writeFileSync(join(ROOT, 'data', 'reference.json'), refJson);
console.log(
  `wrote data/reference.json  overlaps=${reference.overlaps.placer} visible=${reference.visible} occluded=${reference.occluded} itemHash=${reference.itemHash.slice(0, 16)}`
);
