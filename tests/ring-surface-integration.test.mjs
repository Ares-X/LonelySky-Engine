import test from 'node:test';
import assert from 'node:assert/strict';
import { cosmicRingParts } from '../src/cosmic-bodies.js';
import { createRingSurfaceLattice, ringSurfaceHash } from '../src/ring-surface-lattice.js';
import { createSolidWorkspace, solidDistance, sweepSolid } from '../src/solid-geometry.js';

const TAU = Math.PI * 2;
const near = (a, b, epsilon = 3e-6) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const makeSolid = (parts, extra = {}) => ({ id: 'lattice-integration', position: [0, 0, 0],
  boundsRadius: Math.max(...parts.map(p => Math.hypot(p.surfaceLattice?.outerRadius ?? p.outerRadius, Math.max(Math.abs(p.minY), Math.abs(p.maxY))))),
  shape: { type: 'compound', parts }, ...extra });
// Materialize the finite geometric contract independently of the procedural
// query functions; the hash itself already has a separate BigInt oracle test.
function expand(parts) {
  const result = [];
  for (const parent of parts) {
    const { surfaceLattice: l, ...base } = parent;
    result.push(base);
    if (!l) continue;
    const step = TAU / l.columns, dy = (l.maxY - l.minY) / l.rows;
    for (let c = 0; c < l.columns; c++) for (let row = 0; row < l.rows; row++) {
      if (l.gapHalfAngle > 0 && (c * step < l.gapHalfAngle || (c + 1) * step > TAU - l.gapHalfAngle)) continue;
      const u = salt => (ringSurfaceHash(l.seed, c, row, salt) & 65535) / 65536;
      const angle = l.gapCenter + (c + .4 + .2 * u(2)) * step;
      const centerY = l.minY + (row + .4 + .2 * u(3)) * dy;
      const halfY = (.1 + .3 * u(1)) * dy;
      const root = { type: 'annular-sector-slab', innerRadius: l.innerRadius, outerRadius: l.innerRadius + (l.outerRadius-l.innerRadius)*(l.tiered ? .8 : 1)*(.15+.85*u(4)*u(4)),
        minY: centerY - halfY, maxY: centerY + halfY,
        gapCenter: angle + Math.PI, gapHalfAngle: Math.PI - (.1 + .3 * u(0)) * step };
      result.push(root);
      if (l.tiered) {
        const seed = ringSurfaceHash(l.seed, c, row, 5), mode = seed % 4, width = (.2 + .6 * u(0)) * step, height = halfY * 2;
        for (let cc = 0; cc < 8; cc++) for (let rr = 0; rr < 8; rr++) {
          const occupied = mode === 1 ? cc >= 2 && cc <= 5 && rr >= 1 && rr <= 6 && (cc + rr) % 2 === 0 :
            mode === 2 ? cc >= 1 && cc <= 6 && [1, 2, 5, 6].includes(rr) : rr >= 1 && rr <= 6 && [1, 2, 5, 6].includes(cc);
          if (!occupied) continue;
          const v = salt => (ringSurfaceHash(seed, cc, rr, salt) & 65535) / 65536;
          const ca = angle - width / 2 + (cc + .4 + .2 * v(2)) * width / 8;
          const cy = root.minY + (rr + .4 + .2 * v(3)) * height / 8, halfChildY = (.1 + .3 * v(1)) * height / 8;
          result.push({ type: 'annular-sector-slab', innerRadius: root.outerRadius,
            outerRadius: root.outerRadius + (l.outerRadius - l.innerRadius) * .2 * (.15 + .85 * v(4) * v(4)),
            minY: cy - halfChildY, maxY: cy + halfChildY, gapCenter: ca + Math.PI, gapHalfAngle: Math.PI - (.1 + .3 * v(0)) * width / 8 });
        }
      }
    }
  }
  return result;
}
function fixture(gapHalfAngle = 0, tiered = false) {
  const parent = { type: 'annular-sector-slab', innerRadius: 980, outerRadius: 1000, minY: -140, maxY: 140,
    gapCenter: 5.93, gapHalfAngle };
  parent.surfaceLattice = createRingSurfaceLattice(parent, { pitch: tiered ? 800 : 260, rowPitch: tiered ? 200 : 75, depth: 12, seed: 0xf123abcd, tiered });
  return makeSolid([parent]);
}
function compareDistance(actual, expanded, point, w) {
  const result = solidDistance(actual, point, w.distance, w), expected = solidDistance(expanded, point);
  near(result.distance, expected.distance);
  for (let axis = 0; axis < 3; axis++) near(result.normal[axis], expected.normal[axis]);
  assert.equal(result.feature, expected.feature);
  return result;
}
function compareSweep(actual, expanded, start, end, radius, w) {
  const expected = sweepSolid(expanded, start, end, radius, { maxIterations: 1000000 });
  const result = sweepSolid(actual, start, end, radius, {}, w.result, w);
  assert.notEqual(expected.status, 'failed', expected.reason);
  assert.notEqual(result.status, 'failed', result.reason);
  assert.equal(result.status, expected.status, JSON.stringify({ start, end, radius }));
  near(result.fraction, expected.fraction, 3e-10);
  if (result.status === 'hit') {
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(result.normal[axis] - expected.normal[axis]) < 3e-6,
      JSON.stringify({ start, end, radius, result, expected }));
    near(result.safeFraction, expected.safeFraction, 3e-10);
    assert.equal(result.feature, expected.feature);
  }
  return result;
}

test('compound distance consumes implicit plates and preserves transformed physical normals', () => {
  for (const gapHalfAngle of [0, .41, 2.7]) {
    const actual = fixture(gapHalfAngle), expanded = makeSolid(expand(actual.shape.parts)), w = createSolidWorkspace();
    for (let i = 0; i < 90; i++) {
      const a = 5.7 + i * .139, r = 990 + (i % 9) * 5;
      compareDistance(actual, expanded, [Math.cos(a) * r, -170 + ((i * 37) % 340), Math.sin(a) * r], w);
    }
    const plate = expanded.shape.parts.find(p => p.innerRadius === 1000 && p.outerRadius > 1000);
    const a = plate.gapCenter - Math.PI, r = plate.outerRadius+5, y = (plate.minY + plate.maxY) / 2;
    const local = [Math.cos(a) * r, y, Math.sin(a) * r];
    const d = compareDistance(actual, expanded, local, w);
    near(d.distance, 5); assert.equal(d.part, 0);
    const frame = [0, 0, -1, 0, 1, 0, 1, 0, 0], position = [1e7, -2e7, 3e7];
    const transformed = makeSolid(actual.shape.parts, { frame, position });
    const transformedExpanded = makeSolid(expanded.shape.parts, { frame, position });
    compareDistance(transformed, transformedExpanded, [position[0] - local[2], position[1] + local[1], position[2] + local[0]], w);
  }
});

test('integrated CCD matches expanded plates at high speed, across both shell intervals and at contact', () => {
  for (const gapHalfAngle of [0, .41, 2.7]) {
    const actual = fixture(gapHalfAngle), expanded = makeSolid(expand(actual.shape.parts)), w = createSolidWorkspace();
    const plate = expanded.shape.parts.find(p => p.innerRadius === 1000 && p.outerRadius > 1000);
    const angle = plate.gapCenter - Math.PI, c = Math.cos(angle), s = Math.sin(angle), y = (plate.minY + plate.maxY) / 2;
    const cases = [
      [[-100000, 0, 0], [100000, 0, 0], 8],
      [[c * 100000, y, s * 100000], [-c * 100000, y, -s * 100000], 8],
      [[c * 1040, y, s * 1040], [c * 970, y, s * 970], 0],
      [[c * 1020, y, s * 1020], [c * 990, y, s * 990], 8],
      [[c * 1020, y, s * 1020], [c * 1050, y, s * 1050], 8],
      [[c * 1040, plate.maxY + 8, s * 1040], [c * 1001, plate.maxY + 8, s * 1001], 8],
      [[c * 1040, plate.maxY + 7.99, s * 1040], [c * 1001, plate.maxY + 7.99, s * 1001], 8],
      [[c * 1007, 1e4, s * 1007], [c * 1007, -1e4, s * 1007], 8],
    ];
    for (const [start, end, radius] of cases) compareSweep(actual, expanded, start, end, radius, w);
    const frame = [0, 0, -1, 0, 1, 0, 1, 0, 0], position = [1e7, -2e7, 3e7];
    const world = p => [position[0] - p[2], position[1] + p[1], position[2] + p[0]];
    const [start, end, radius] = cases[1];
    compareSweep(makeSolid(actual.shape.parts, { frame, position }), makeSolid(expanded.shape.parts, { frame, position }), world(start), world(end), radius, w);
    // A warm workspace retains every owned numeric backing store.
    const buffers = [w.candidates, w.lattice.intervals, w.lattice.plate, w.lattice.distance, ...w.roots, ...w.coefficients];
    for (let i = 0; i < 8; i++) compareSweep(actual, expanded, ...cases[3], w);
    for (let i = 0; i < buffers.length; i++) assert.equal([w.candidates, w.lattice.intervals, w.lattice.plate, w.lattice.distance, ...w.roots, ...w.coefficients][i], buffers[i]);
    assert.ok(w.candidateCount < w.candidates.length);
  }
});

test('non-tiered cosmic compatibility retains its complete finite oracle and remote distance budget', () => {
  for (const broken of [false, true]) for (const phase of [0, 1.239, 5.93]) {
    // This is explicitly the original non-tiered compatibility window, not a
    // claim that a production tiered ring was expanded into millions of slabs.
    const parts = cosmicRingParts({ radius: 1000000, halfWidth: .025, thickness: .0005, phase, broken })
      .map(p => p.surfaceLattice ? { ...p, surfaceLattice: { ...p.surfaceLattice, tiered: false } } : p);
    const actual = makeSolid(parts), expanded = makeSolid(expand(parts)), w = createSolidWorkspace();
    assert.ok(parts.some(p => p.surfaceLattice));
    const points = [[0, 0, 0], [0, 5e7, 0], [5e7, 5e7, -5e7], [-5e7, 0, 0], [0, 0, 5e7]];
    for (let i = 0; i < 12; i++) {
      const a = phase + i * TAU / 12;
      points.push([Math.cos(a) * 1010000, i % 2 ? 40000 : -40000, Math.sin(a) * 1010000]);
    }
    for (const point of points) {
      compareDistance(actual, expanded, point, w);
      assert.notEqual(w.lattice.status, 'failed');
      assert.ok(w.lattice.count <= 512);
    }
    const decorated = expanded.shape.parts.find(p => p.innerRadius > 990000 && p.outerRadius - p.innerRadius < 64);
    const a = decorated.gapCenter - Math.PI, y = (decorated.minY + decorated.maxY) / 2;
    const start = [Math.cos(a) * (decorated.outerRadius + 100), y, Math.sin(a) * (decorated.outerRadius + 100)];
    const end = [Math.cos(a) * (decorated.innerRadius - 100), y, Math.sin(a) * (decorated.innerRadius - 100)];
    compareSweep(actual, expanded, start, end, 8, w);
    assert.ok(w.latticeCells <= 256);
  }
});

test('small integrated tiered compound matches a complete finite oracle with production root budgets', () => {
  for (const gap of [0, .41, 1.3]) {
    const actual = fixture(gap, true), expanded = makeSolid(expand(actual.shape.parts)), w = createSolidWorkspace();
    assert.ok(expanded.shape.parts.length < 500);
    for (let i = 0; i < 80; i++) {
      const a = 5.7 + i * .157, r = 997 + i % 7 * 2;
      compareDistance(actual, expanded, [r * Math.cos(a), -150 + i * 29 % 300, r * Math.sin(a)], w);
    }
    const child = expanded.shape.parts.find(p => p.innerRadius > 1000), a = child.gapCenter - Math.PI, c = Math.cos(a), s = Math.sin(a), y = (child.minY + child.maxY) / 2;
    const cases = [
      [[c * 1050, y, s * 1050], [c * 990, y, s * 990], 0],
      [[c * 1e5, y, s * 1e5], [-c * 1e5, y, -s * 1e5], 1],
      [[c * (child.outerRadius + 1), y, s * (child.outerRadius + 1)], [c * 990, y, s * 990], 1],
      [[c * child.outerRadius, 1e4, s * child.outerRadius], [c * child.outerRadius, -1e4, s * child.outerRadius], 1],
    ];
    for (const [start, end, radius] of cases) compareSweep(actual, expanded, start, end, radius, w);
    const rootBuffers = [w.candidates, w.lattice.child, w.lattice.child.plate, w.lattice.child.distance, w.lattice.child.intervals, w.lattice.childLattice, w.lattice.envelope];
    for (let i = 0; i < 8; i++) compareSweep(actual, expanded, ...cases[0], w);
    [w.candidates, w.lattice.child, w.lattice.child.plate, w.lattice.child.distance, w.lattice.child.intervals, w.lattice.childLattice, w.lattice.envelope].forEach((value, i) => assert.equal(value, rootBuffers[i]));
  }
});

test('production tiered cosmic queries and real sweeps retain finite bounds and default work budgets', () => {
  for (const phase of [.7031452710857568, 1.239, 5.93]) for (const broken of [false, true]) {
    const radius = 1000000, parts = cosmicRingParts({ radius, halfWidth: .028, thickness: .00075, phase, broken });
    const actual = makeSolid(parts), w = createSolidWorkspace();
    assert.ok(parts.some(p => p.surfaceLattice?.tiered));
    for (const point of [[0, 0, 0], [0, 5e7, 0], [5e7, 5e7, -5e7], [-5e7, 0, 0], [0, 0, 5e7]]) {
      const d = solidDistance(actual, point, w.distance, w);
      assert.ok(Number.isFinite(d.distance));
      assert.equal(w.lattice.status, 'complete');
    }
    for (let i = 0; i < 8; i++) {
      const a = phase + (i + .5) * TAU / 8, c = Math.cos(a), s = Math.sin(a), outer = radius * 1.00075;
      const cases = [
        [[c * (outer + 1000), 0, s * (outer + 1000)], [c * (outer - 1000), 0, s * (outer - 1000)]],
        [[c * (outer + 32) - s * 20000, -28000, s * (outer + 32) + c * 20000], [c * (outer + 32) + s * 20000, 28000, s * (outer + 32) - c * 20000]],
      ];
      for (const [start, end] of cases) {
        const result = sweepSolid(actual, start, end, 8, {}, w.result, w);
        assert.notEqual(result.status, 'failed', JSON.stringify({ phase, broken, i, reason: result.reason, cells: w.latticeCells, evaluations: w.evaluations }));
        assert.ok(w.latticeCells <= 256 && w.evaluations <= 32768);
        if (result.status === 'hit') {
          const safe = start.map((v, i) => v + (end[i] - v) * result.safeFraction);
          assert.ok(solidDistance(actual, safe, w.distance, w).distance >= 8 - 1e-8);
        }
      }
    }
  }
});
