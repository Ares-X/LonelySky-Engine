import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolidWorkspace, solidDistance, sweepSolid } from '../src/solid-geometry.js';

const near = (actual, expected, tolerance = 2e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const part = (extra = {}) => ({ type: 'annular-sector-slab', innerRadius: 100, outerRadius: 200, minY: -10, maxY: 10, gapCenter: 0, gapHalfAngle: 0, ...extra });
const ring = (extra = {}) => ({ id: 'ring', position: [0, 0, 0], boundsRadius: 203, shape: { type: 'compound', parts: [part()] }, ...extra });

test('annular distance preserves the actual middle hole and rounded slab lips', () => {
  const solid = ring();
  near(solidDistance(solid, [0, 0, 0]).distance, 100);
  near(solidDistance(solid, [150, 0, 0]).distance, -10);
  near(solidDistance(solid, [206, 18, 0]).distance, 10);
  near(solidDistance(solid, [94, 18, 0]).distance, 10);
  const lip = solidDistance(solid, [206, 18, 0]);
  near(lip.normal[0], .6); near(lip.normal[1], .8);
  assert.equal(lip.feature, 'outer-top');
  assert.equal(solidDistance(solid, [94, 18, 0]).feature, 'inner-top');
});

test('gap distance uses finite cut segments and their endpoints', () => {
  const solid = ring({ shape: { type: 'compound', parts: [part({ gapHalfAngle: .5 })] } });
  near(solidDistance(solid, [150, 0, 0]).distance, 150 * Math.sin(.5));
  const radius = 80, expected = Math.hypot(radius - 100 * Math.cos(.5), 100 * Math.sin(.5));
  near(solidDistance(solid, [radius, 0, 0]).distance, expected);
  const corner = solidDistance(solid, [radius, 14, 0]);
  near(corner.distance, Math.hypot(expected, 4));
});

test('sphere sweep has the same analytic time of impact at high speed', () => {
  const sphere = { id: 'ball', position: [50, 20, -30], boundsRadius: 10, shape: { type: 'sphere', radius: 10 } };
  const sweep = sweepSolid(sphere, [-100000, 20, -30], [100000, 20, -30], 8);
  assert.equal(sweep.status, 'hit'); near(sweep.fraction, (100000 + 32) / 200000, 1e-12);
  assert.deepEqual(sweep.normal, [-1, 0, 0]);
  assert.equal(sweepSolid(sphere, [-100000, 38, -30], [100000, 38, -30], 8).status, 'clear');
});

test('fast ring sweeps resolve outer/inner cylinders, caps and toroidal lips', () => {
  const solid = ring();
  let sweep = sweepSolid(solid, [-100000, 0, 0], [100000, 0, 0], 8);
  assert.equal(sweep.status, 'hit'); near(-100000 + sweep.fraction * 200000, -208);
  sweep = sweepSolid(solid, [0, 0, 0], [1000, 0, 0], 8);
  assert.equal(sweep.status, 'hit'); near(sweep.fraction * 1000, 92);
  sweep = sweepSolid(solid, [150, 100, 0], [150, -100, 0], 8);
  assert.equal(sweep.status, 'hit'); near(100 - sweep.fraction * 200, 18);
  sweep = sweepSolid(solid, [-100000, 15, 0], [100000, 15, 0], 8);
  assert.equal(sweep.status, 'hit'); near(-100000 + sweep.fraction * 200000, -200 - Math.sqrt(39));
  assert.equal(sweep.feature, 'outer-top');
});

test('genuine hole and selected gap are traversable while a stepped gap blocks', () => {
  const solid = ring({ shape: { type: 'compound', parts: [part({ gapHalfAngle: .4 })] } });
  assert.equal(sweepSolid(solid, [0, -1000, 0], [0, 1000, 0], 8).status, 'clear');
  assert.equal(sweepSolid(solid, [0, 0, 0], [1000, 0, 0], 8).status, 'clear');
  solid.shape.parts.push(part({ minY: 15, maxY: 25, gapCenter: Math.PI, gapHalfAngle: .4 }));
  assert.equal(sweepSolid(solid, [0, 20, 0], [1000, 20, 0], 8).status, 'hit');
});

test('exact and nearby cap tangencies stay distinct at large sweep lengths', () => {
  const solid = ring();
  for (const y of [18, 18 + 1e-4]) assert.equal(sweepSolid(solid, [-100000, y, 0], [100000, y, 0], 8).status, 'clear');
  assert.equal(sweepSolid(solid, [-100000, 18 - 1e-4, 0], [100000, 18 - 1e-4, 0], 8).status, 'hit');
  assert.equal(sweepSolid(solid, [150, 18, -20], [150, 18, 20], 8).status, 'clear');
});

test('rotated frames and translated floating origins retain distance and TOI', () => {
  const original = ring(), transformed = ring({ position: [10000000, -20000000, 30000000], frame: [0, 0, -1, 0, 1, 0, 1, 0, 0] });
  const a = solidDistance(original, [206, 18, 0]);
  const b = solidDistance(transformed, [10000000, -20000000 + 18, 30000000 + 206]);
  near(a.distance, b.distance); near(b.normal[2], a.normal[0]); near(b.normal[1], a.normal[1]);
  const start = [10000000, -20000000 + 15, 30000000 - 1000], end = [10000000, -20000000 + 15, 30000000 + 1000];
  const actual = sweepSolid(transformed, start, end, 8), expected = sweepSolid(original, [-1000, 15, 0], [1000, 15, 0], 8);
  assert.equal(actual.status, expected.status); near(actual.fraction, expected.fraction, 1e-10);
});

test('bounded work fails explicitly without changing descriptors or endpoints', () => {
  const solid = ring(), start = [-1000, 15, 0], end = [1000, 15, 0], before = structuredClone({ solid, start, end });
  const sweep = sweepSolid(solid, start, end, 8, { maxIterations: 1 });
  assert.equal(sweep.status, 'failed'); assert.equal(sweep.reason, 'solid-root-budget'); assert.equal(sweep.safeFraction, 0);
  assert.deepEqual({ solid, start, end }, before);
});

test('consumer-owned workspaces reuse outputs and do not alias independent consumers', () => {
  const solid = ring(), one = createSolidWorkspace(), two = createSolidWorkspace();
  const first = sweepSolid(solid, [-1000, 0, 0], [1000, 0, 0], 8, {}, one.result, one);
  const snapshot = structuredClone(first);
  sweepSolid(solid, [0, 1000, 0], [0, -1000, 0], 8, {}, two.result, two);
  assert.deepEqual(first, snapshot);
  assert.equal(sweepSolid(solid, [-1000, 15, 0], [1000, 15, 0], 8, {}, one.result, one), first);
});

test('a gap three-face corner keeps the spherical ship corner instead of a box inflation', () => {
  const angle = .4, c = Math.cos(angle), s = Math.sin(angle);
  const solid = ring({ shape: { type: 'compound', parts: [part({ gapHalfAngle: angle })] } });
  const corner = [200 * c, 10, 200 * s], normal = [(c + s) / Math.sqrt(3), 1 / Math.sqrt(3), (s - c) / Math.sqrt(3)];
  const start = corner.map((n, i) => n + normal[i] * 100), end = [...corner];
  near(solidDistance(solid, start).distance, 100);
  const sweep = sweepSolid(solid, start, end, 8);
  assert.equal(sweep.status, 'hit'); near(sweep.fraction, .92, 1e-9);
  for (let axis = 0; axis < 3; axis++) near(sweep.normal[axis], normal[axis], 1e-7);
});

test('seeded oblique sweeps agree with an independent dense penetration oracle', () => {
  const solid = ring({ shape: { type: 'compound', parts: [part({ gapCenter: .7, gapHalfAngle: .35 }), part({ minY: 15, maxY: 30, gapCenter: 2.1, gapHalfAngle: .35 })] } });
  const workspace = createSolidWorkspace(), output = { distance: 0, normal: [0, 0, 0] }, probe = [0, 0, 0];
  let seed = 32;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let compared = 0;
  for (let sample = 0; sample < 200; sample++) {
    const start = [(random() - .5) * 700, (random() - .5) * 150, (random() - .5) * 700];
    const end = [(random() - .5) * 700, (random() - .5) * 150, (random() - .5) * 700];
    if (solidDistance(solid, start, output, workspace).distance < 8 + 1e-4) continue;
    const sweep = sweepSolid(solid, start, end, 8, {}, workspace.result, workspace);
    assert.notEqual(sweep.status, 'failed');
    let minimum = Infinity;
    for (let i = 0; i <= 1000; i++) {
      for (let axis = 0; axis < 3; axis++) probe[axis] = start[axis] + (end[axis] - start[axis]) * i / 1000;
      minimum = Math.min(minimum, solidDistance(solid, probe, output, workspace).distance);
    }
    if (minimum < 8 - 1e-4) assert.equal(sweep.status, 'hit');
    if (sweep.status === 'hit') {
      for (let axis = 0; axis < 3; axis++) probe[axis] = start[axis] + (end[axis] - start[axis]) * sweep.safeFraction;
      assert.ok(solidDistance(solid, probe, output, workspace).distance >= 8 - 1e-6);
    }
    compared++;
  }
  assert.ok(compared >= 150);
});

test('million-unit toroidal lips still resolve the finite eight-unit round edge', () => {
  const solid = ring({ boundsRadius: Math.hypot(990000, 2000), shape: { type: 'compound', parts: [part({ innerRadius: 900000, outerRadius: 990000, minY: -2000, maxY: 2000 })] } });
  for (const radius of [900000, 990000]) {
    const direction = radius === 990000 ? 1 : -1, start = [radius + direction * 30, 2005, 0], end = [radius - direction * 30, 2005, 0];
    const result = sweepSolid(solid, start, end, 8);
    assert.equal(result.status, 'hit');
    near(start[0] + (end[0] - start[0]) * result.fraction, radius + direction * Math.sqrt(39), 2e-6);
  }
});
