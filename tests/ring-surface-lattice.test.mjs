import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolidWorkspace, solidDistance, sweepSolid } from '../src/solid-geometry.js';
import { createRingSurfaceLattice, createRingSurfaceWorkspace, ringSurfaceHash, ringSurfacePlate, ringSurfaceDistance, visitRingSurfaceSweep, ringSurfaceChildCell, writeRingSurfaceChildLattice, RING_SURFACE_LATTICE_GLSL } from '../src/ring-surface-lattice.js';

const TAU = Math.PI * 2;
const parent = (extra = {}) => ({ innerRadius: 980, outerRadius: 1000, minY: -140, maxY: 140, gapCenter: 5.93, gapHalfAngle: 0, ...extra });
const lattice = (extra = {}, options = {}) => createRingSurfaceLattice(parent(extra), { pitch: 260, rowPitch: 75, depth: 12, seed: 0xf123abcd, ...options });
const solid = (parts, extra = {}) => ({ id: 'plates', position: [0, 0, 0], shape: { type: 'compound', parts }, ...extra });
const near = (a, b, epsilon = 3e-6) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
// Independent unsigned arithmetic oracle: no JS bitwise/imul hash operations.
function hash(seed, column, row, salt) {
  const mask = 0xffffffffn;
  let h = (BigInt(seed) ^ ((BigInt(column + 1) * 0x9e3779b9n) & mask) ^ ((BigInt(row + 1) * 0x85ebca6bn) & mask) ^ BigInt(salt)) & mask;
  h = ((h ^ (h >> 16n)) * 0x7feb352dn) & mask;
  h = ((h ^ (h >> 15n)) * 0x846ca68bn) & mask;
  return Number((h ^ (h >> 16n)) & mask);
}
function expanded(l) {
  const parts = [], dx = TAU / l.columns, dy = (l.maxY - l.minY) / l.rows;
  for (let c = 0; c < l.columns; c++) for (let row = 0; row < l.rows; row++) {
    if (l.gapHalfAngle > 0 && (c * dx < l.gapHalfAngle || (c + 1) * dx > TAU - l.gapHalfAngle)) continue;
    const u = salt => (hash(l.seed, c, row, salt) % 65536) / 65536;
    const width = (.2 + .6 * u(0)) * dx, height = (.2 + .6 * u(1)) * dy;
    const center = l.gapCenter + (c + .4 + .2 * u(2)) * dx;
    const middleY = l.minY + (row + .4 + .2 * u(3)) * dy;
    const root = { type: 'annular-sector-slab', innerRadius: l.innerRadius, outerRadius: l.innerRadius + (l.outerRadius-l.innerRadius)*(l.tiered ? .8 : 1)*(.15+.85*u(4)*u(4)),
      minY: middleY - height / 2, maxY: middleY + height / 2, gapCenter: center + Math.PI, gapHalfAngle: Math.PI - width / 2 };
    parts.push(root);
    if (l.tiered) {
      const seed = hash(l.seed, c, row, 5), mode = seed % 4;
      for (let cc = 0; cc < 8; cc++) for (let rr = 0; rr < 8; rr++) {
        const occupied = mode === 1 ? cc >= 2 && cc <= 5 && rr >= 1 && rr <= 6 && (cc + rr) % 2 === 0 :
          mode === 2 ? cc >= 1 && cc <= 6 && [1, 2, 5, 6].includes(rr) : rr >= 1 && rr <= 6 && [1, 2, 5, 6].includes(cc);
        if (!occupied) continue;
        const v = salt => (hash(seed, cc, rr, salt) % 65536) / 65536;
        const cw = (.2 + .6 * v(0)) * width / 8, ch = (.2 + .6 * v(1)) * height / 8;
        const ca = center - width / 2 + (cc + .4 + .2 * v(2)) * width / 8;
        const cy = root.minY + (rr + .4 + .2 * v(3)) * height / 8;
        parts.push({ type: 'annular-sector-slab', innerRadius: root.outerRadius,
          outerRadius: root.outerRadius + (l.outerRadius-l.innerRadius)*.2*(.15+.85*v(4)*v(4)),
          minY: cy - ch / 2, maxY: cy + ch / 2, gapCenter: ca + Math.PI, gapHalfAngle: Math.PI - cw / 2 });
      }
    }
  }
  return parts;
}
const callbackSolid = solid([]), callbackW = createSolidWorkspace();
function distanceSlab(part, x, y, z, out) {
  callbackSolid.shape.parts[0] = part;
  callbackW.probe[0] = x; callbackW.probe[1] = y; callbackW.probe[2] = z;
  return solidDistance(callbackSolid, callbackW.probe, out, callbackW);
}
function collect(part, p, delta, radius, parts) { parts.push({ ...part }); }

test('uint recipe matches independent unsigned arithmetic and cells stay within parent bounds', () => {
  for (const seed of [0, 1, 0xffffffff, 0xf123abcd]) for (const c of [0, 1, 4095]) for (const row of [0, 17, 129]) for (let salt = 0; salt < 5; salt++) {
    assert.equal(ringSurfaceHash(seed, c, row, salt), hash(seed, c, row, salt));
  }
  const l = lattice({ gapHalfAngle: .37 }), w = createRingSurfaceWorkspace(), all = expanded(l);
  let i = 0;
  for (let c = 0; c < l.columns; c++) for (let row = 0; row < l.rows; row++) {
    if (!ringSurfacePlate(l, c, row, w.plate)) continue;
    const expected = all[i++];
    for (const key of ['innerRadius', 'outerRadius', 'minY', 'maxY', 'gapCenter', 'gapHalfAngle']) near(w.plate[key], expected[key], 1e-12);
    assert.ok(w.plate.minY >= l.minY && w.plate.maxY <= l.maxY);
    const angle = w.plate.gapCenter - Math.PI - l.gapCenter, half = Math.PI - w.plate.gapHalfAngle;
    assert.ok(angle - half >= c * TAU / l.columns - 1e-12);
    assert.ok(angle + half <= (c + 1) * TAU / l.columns + 1e-12);
  }
  assert.equal(i, all.length);
});

test('nearest plate equals independently expanded slabs across wrap, gap, corners and remote points', () => {
  for (const gapHalfAngle of [0, .41, 2.92]) {
    const l = lattice({ gapHalfAngle }), all = solid(expanded(l)), w = createRingSurfaceWorkspace(), out = w.distance;
    // Use separate output: workspace.distance is the reusable slab probe.
    const result = { distance: Infinity, normal: [0, 0, 0], feature: '' };
    for (let i = 0; i < 170; i++) {
      const angle = -2 + i * .173, r = i % 17 === 0 ? 0 : 970 + (i % 11) * 9, y = -220 + ((i * 47) % 440);
      const p = [r * Math.cos(angle), y, r * Math.sin(angle)];
      result.distance = Infinity;
      assert.equal(ringSurfaceDistance(l, ...p, result, w, distanceSlab), true, w.reason);
      const expected = solidDistance(all, p);
      near(result.distance, expected.distance);
      assert.equal(result.feature, expected.feature);
    }
    assert.equal(out, w.distance);
  }
});

test('near-wall nearest search is bounded independently of million-cell catalogue size', () => {
  const l = createRingSurfaceLattice(parent({ outerRadius: 1e6, minY: -1e6, maxY: 1e6 }));
  assert.ok(l.columns * l.rows > 1e6);
  const w = createRingSurfaceWorkspace({ maxCells: 32 }), out = { distance: 1000, normal: [0, 0, 0], feature: '' };
  assert.equal(ringSurfaceDistance(l, 1e6 + 30, 0, 0, out, w, distanceSlab), true);
  assert.ok(w.count <= 32);
  out.distance = Infinity;
  assert.equal(ringSurfaceDistance(l, 0, 1e6, 0, out, w, distanceSlab), false);
  assert.equal(w.status, 'failed'); assert.equal(w.reason, 'ring-surface-cell-budget');
});

test('conservative clipped sweep candidates preserve exact finite slab sweeps', () => {
  for (const gapHalfAngle of [0, .41, 2.92]) {
    const l = lattice({ gapHalfAngle }), all = solid(expanded(l)), w = createRingSurfaceWorkspace();
    const cases = [
      [[-100000, 0, 0], [100000, 0, 0], 8],
      [[0, -10000, 1005], [0, 10000, 1005], 8],
      [[990, 148, -3000], [990, 148, 3000], 8],
      [[1000, 0, -500], [1000, 0, 500], 0],
      [[0, 0, 0], [1200, 0, 0], 8],
      [[1000, 0, 0], [1000, 0, 0], 8],
      [[-1200, -220, -400], [1200, 220, 400], 40],
    ];
    // Exact plate cap tangency, a corner crossing, and one near tangent.
    const plate = all.shape.parts[Math.floor(all.shape.parts.length / 2)], angle = plate.gapCenter - Math.PI;
    const c = Math.cos(angle), s = Math.sin(angle);
    cases.push([[c * 1040, plate.maxY + 8, s * 1040], [c * 970, plate.maxY + 8, s * 970], 8]);
    cases.push([[c * 1040, plate.maxY + 7.99, s * 1040], [c * 970, plate.maxY + 7.99, s * 970], 8]);
    for (let i = 0; i < 12; i++) {
      const a = i * .71, c = Math.cos(a), s = Math.sin(a), y = -140 + i * 25;
      cases.push([[c * 1300, y + 30, s * 1300], [c * 700, y - 30, s * 700], 8]);
    }
    for (const [start, end, radius] of cases) {
      const delta = end.map((v, i) => v - start[i]), candidates = [];
      assert.equal(visitRingSurfaceSweep(l, start, delta, radius, w, collect, candidates), true);
      const expected = sweepSolid(all, start, end, radius, { maxIterations: 1000000 });
      const actual = sweepSolid(solid(candidates), start, end, radius, { maxIterations: 1000000 });
      assert.notEqual(expected.status, 'failed'); assert.notEqual(actual.status, 'failed');
      assert.equal(actual.status, expected.status, JSON.stringify({ start, end, gapHalfAngle }));
      near(actual.fraction, expected.fraction, 1e-10);
    }
  }
});

test('reuse, transformed-frame callers, zero planar motion and explicit visitor/cell budgets', () => {
  const l = lattice(), parts = expanded(l), frame = [0, 0, -1, 0, 1, 0, 1, 0, 0], position = [1e7, -2e7, 3e7];
  const transformed = solid(parts, { frame, position }), plain = solid(parts), w = createRingSurfaceWorkspace();
  const plateRef = w.plate, intervalsRef = w.intervals;
  const start = [-1400, 0, 0], end = [1400, 0, 0];
  const world = p => [position[0] - p[2], position[1] + p[1], position[2] + p[0]];
  const candidates = [];
  assert.equal(visitRingSurfaceSweep(l, start, end.map((v, i) => v - start[i]), 8, w, collect, candidates), true);
  const actual = sweepSolid(solid(candidates, { frame, position }), world(start), world(end), 8, { maxIterations: 1000000 });
  const expected = sweepSolid(transformed, world(start), world(end), 8, { maxIterations: 1000000 });
  assert.equal(actual.status, expected.status); near(actual.fraction, expected.fraction, 1e-10);
  near(expected.fraction, sweepSolid(plain, start, end, 8, { maxIterations: 1000000 }).fraction, 1e-10);
  assert.equal(w.plate, plateRef); assert.equal(w.intervals, intervalsRef);
  const tiny = createRingSurfaceWorkspace({ maxCells: 1 });
  assert.equal(visitRingSurfaceSweep(l, start, [2800, 0, 0], 8, tiny, collect, []), false);
  assert.equal(tiny.reason, 'ring-surface-cell-budget');
  assert.equal(visitRingSurfaceSweep(l, start, [2800, 0, 0], 8, w, () => false), false);
  assert.equal(w.reason, 'ring-surface-visitor-budget');
  assert.equal(visitRingSurfaceSweep(l, [0, -1e4, 0], [0, 2e4, 0], 8, w, collect, []), true);
  assert.equal(w.count, 0);
});

// Execute the shader's scalar crossing kernel itself, with float inputs and
// rounded scalar assignments. This is bounded CPU numeric regression evidence;
// native shader compilation and actual pixels remain a separate boundary.
const boundaryKernel = (() => {
  const match = RING_SURFACE_LATTICE_GLSL.match(/float ringLatticeAngularBoundary\(([^)]*)\)\{([\s\S]*?)\n\}/);
  const names = match[1].split(',').map(p => p.trim().replace(/^float /, ''));
  const body = match[2].replace('float c=cos(boundary),s=sin(boundary);', 'let c=f(cos(boundary)),s=f(sin(boundary));')
    .replace(/float (\w+)=([^;]+);/g, 'let $1=f($2);');
  const execute = new Function('f', 'abs', 'cos', 'sin', 'max', ...names, body);
  return (...values) => execute(Math.fround, Math.abs, Math.cos, Math.sin, Math.max, ...values.map(Math.fround));
})();

test('shader boundary kernel rejects opposite radial half-plane and never walks backwards', () => {
  // V5 ring-close pixel 595.5,510.5 actual pose, support 10, far shell
  // interval. Previously its next plane root at .007546 walked back from
  // current 2.008522 and consumed all 80 cells.
  const ox = -.5441405383963079, oz = .8447396200831131, dx = .542346045821747, dz = -.840140204211863;
  const boundary = 4.2374370063742735 + 291 * TAU / 1746;
  assert.ok(boundaryKernel(ox, oz, dx, dz, boundary, 2.0085220763776452) > 1e24);
  // Proper half-plane, already crossed by a rounded starting coordinate:
  // its zero-time correction must retain the current traversal time.
  near(boundaryKernel(2, 0, -1, 1, Math.PI / 4, 1.000001), Math.fround(1.000001), 0);
  // Parallel radial flight never crosses angular cells.
  assert.ok(boundaryKernel(2, 0, -1, 0, 0, 0) > 1e24);
});

test('bounded shader DDA math covers both shell intervals of the rejected V5 ray', () => {
  const origin = [-.5441405383963079, -.01348457518532359, .8447396200831131].map(Math.fround);
  const ray = [.542346045821747, .0050203434508677425, -.840140204211863].map(Math.fround);
  const shell = [833432.6181647138, 833496.6181647138, -22708.696596552625, 22708.696596552625].map(x => Math.fround(x / 830383.1183351576));
  const phase = Math.fround(4.2374370063742735), columns = 1746, rows = 31;
  const planar = ray[0] ** 2 + ray[2] ** 2, along = origin[0] * ray[0] + origin[2] * ray[2];
  const cross = origin[0] * ray[2] - origin[2] * ray[0];
  const outerRoot = Math.sqrt(planar * shell[1] ** 2 - cross ** 2), innerRoot = Math.sqrt(planar * shell[0] ** 2 - cross ** 2);
  const ranges = [[(-along - outerRoot) / planar, (-along - innerRoot) / planar], [(-along + innerRoot) / planar, (-along + outerRoot) / planar]];
  const step = Math.fround(TAU / columns), rowStep = Math.fround((shell[3] - shell[2]) / rows);
  const angularDirection = cross >= 0 ? 1 : -1, rowDirection = ray[1] >= 0 ? 1 : -1;
  let total = 0;
  for (const [lo, hi] of ranges) {
    const x = origin[0] + ray[0] * lo, y = origin[1] + ray[1] * lo, z = origin[2] + ray[2] * lo;
    const angle = ((Math.atan2(z, x) - phase) % TAU + TAU) % TAU;
    let column = Math.floor(angle / step), row = Math.floor((y - shell[2]) / rowStep), current = lo, finished = false;
    const visited = new Set();
    for (let i = 0; i < 80; i++) {
      total++; visited.add(`${(column % columns + columns) % columns},${row}`);
      const boundary = Math.fround(phase + (column + (angularDirection > 0 ? 1 : 0)) * step);
      const nextAngle = boundaryKernel(origin[0], origin[2], ray[0], ray[2], boundary, current);
      const nextRow = Math.max(current, (shell[2] + (row + (rowDirection > 0 ? 1 : 0)) * rowStep - origin[1]) / ray[1]);
      const next = Math.min(nextAngle, nextRow);
      assert.ok(next >= current);
      if (next > hi) { finished = true; break; }
      if (nextAngle <= nextRow) column += angularDirection;
      if (nextRow <= nextAngle) row += rowDirection;
      current = next;
    }
    assert.equal(finished, true);
    // Independent dense samples verify the finite interval's geometric cells
    // were visited; this is not just an assertion on iteration count.
    for (let i = 1; i < 64; i++) {
      const t = lo + (hi - lo) * i / 64, x = origin[0] + ray[0] * t, z = origin[2] + ray[2] * t;
      const a = ((Math.atan2(z, x) - phase) % TAU + TAU) % TAU;
      const c = Math.floor(a / step), r = Math.floor((origin[1] + ray[1] * t - shell[2]) / rowStep);
      assert.ok(visited.has(`${c},${r}`), `unvisited cell ${c},${r}`);
    }
  }
  assert.ok(total < 80);
});

test('GPU metadata preserves CPU column admission at the actual float32 extra-column boundary', () => {
  // Freeze the physical slab that exposed the bug; later exterior designs
  // must not accidentally turn this precision regression into another case.
  const recorded={type:'annular-sector-slab',innerRadius:624741.6518802162,outerRadius:626998.0975350233,
    minY:-14522.334979214156,maxY:14522.334979214156,gapCenter:10.687292115673205,gapHalfAngle:3.132029518005667};
  const l=createRingSurfaceLattice(recorded,{seed:123,depth:64});
  assert.equal(l.firstColumn, 656); assert.equal(l.lastColumn, 657);
  assert.equal(l.columns, 1314);
  // Independent IEEE-float replay of the replaced shader decision. A whole
  // extra plate column was rendered despite being absent from the solid.
  const f = Math.fround, gpuTau = f(TAU), gpuGap = f(l.gapHalfAngle), gpuStep = f(gpuTau / l.columns);
  const oldGpuLast = Math.floor(f(f(gpuTau - gpuGap) / gpuStep)) - 1;
  assert.equal(oldGpuLast, 658);
  const metadata = new Float32Array([l.columns * 128 + l.rows, l.seed, l.firstColumn * 4096 + l.lastColumn, (l.outerRadius - l.innerRadius) / 624409.496]);
  const first = Math.floor(metadata[2] / 4096), last = metadata[2] - first * 4096;
  assert.equal(first, 656); assert.equal(last, 657);
  // Execute the real shader bounds function's scalar recipe, with metadata
  // already decoded from the float texture. Output constructors are simple
  // test values; the function's actual admission branch decides each result.
  const match = RING_SURFACE_LATTICE_GLSL.match(/bool ringPlateBounds\([^\n]+\)\{([\s\S]*?)\n\}/);
  const body = match[1].replace(/const float /g, 'const ').replace(/\bfloat\s+/g, 'let ')
    .replace(/\bfloat\(/g, 'Number(').replace(/\b(\d+)u\b/g, '$1');
  const execute = new Function('shell', 'parentGap', 'counts', 'seed', 'admittedColumns', 'tiered', 'masked', 'step', 'column', 'row', 'bounds', 'gap', 'ringPlateUnit', 'vec4', 'vec2', body);
  const unit = (seed, column, row, salt) => (ringSurfaceHash(seed, column, row, salt) & 65535) / 65536;
  const counts = { x: Math.floor(metadata[0] / 128), y: metadata[0] % 128 }, admitted = { x: first, y: last };
  const shell = { x: l.innerRadius, y: l.outerRadius, z: l.minY, w: l.maxY }, gap = { x: f(l.gapCenter), y: gpuGap };
  const out = createRingSurfaceWorkspace().plate;
  for (let column = first - 1; column <= oldGpuLast; column++) for (const row of [-1, 0, 10, l.rows]) {
    const gpuAccepted = execute(shell, gap, counts, metadata[1], admitted, false, false, l.angleStep, column, row, null, null, unit, (...values) => values, (...values) => values);
    assert.equal(gpuAccepted, ringSurfacePlate(l, column, row, out), `column ${column} row ${row}`);
  }
});

test('tiered nearest geometry equals independent root and grouped-child expansion', () => {
  for (const gapHalfAngle of [0, .41, 1.3]) {
    const l = lattice({ gapHalfAngle }, { pitch: 800, rowPitch: 200, tiered: true });
    const all = expanded(l), expected = solid(all), w = createRingSurfaceWorkspace();
    const out = { distance: Infinity, normal: [0, 0, 0], feature: '' };
    assert.ok(all.length < 500);
    const childRef = w.child, descriptorRef = w.childLattice, plateRef = w.child.plate, intervalsRef = w.child.intervals;
    for (let i = 0; i < 150; i++) {
      const a = 5.7 + i * .157, r = 995 + (i % 9) * 2.5;
      const p = [r * Math.cos(a), -165 + (i * 31 % 330), r * Math.sin(a)];
      out.distance = Infinity;
      assert.equal(ringSurfaceDistance(l, ...p, out, w, distanceSlab), true, w.reason);
      const reference = solidDistance(expected, p);
      near(out.distance, reference.distance);
      assert.equal(out.feature, reference.feature);
    }
    let checked = 0;
    for (const child of all) {
      if (child.innerRadius === l.innerRadius || checked++ % 11 !== 0) continue;
      const a = child.gapCenter - Math.PI, r = child.outerRadius + .1, p = [r * Math.cos(a), (child.minY + child.maxY) / 2, r * Math.sin(a)];
      out.distance = Infinity;
      assert.equal(ringSurfaceDistance(l, ...p, out, w, distanceSlab), true, w.reason);
      near(out.distance, solidDistance(expected, p).distance);
      assert.ok(out.distance <= .1 + 1e-9);
    }
    assert.equal(w.child, childRef); assert.equal(w.childLattice, descriptorRef);
    assert.equal(w.child.plate, plateRef); assert.equal(w.child.intervals, intervalsRef);
    // A remote query whose base solid is already closer never expands child
    // groups, even though the root catalogue remains implicit.
    out.distance = 980;
    assert.equal(ringSurfaceDistance(l, 0, 0, 0, out, w, distanceSlab), true);
    assert.equal(w.childCells, 0);
  }
});

test('tiered exact sweep candidates include diagonal, cap, high-speed and transformed child contacts', () => {
  const l = lattice({ gapHalfAngle: .41 }, { pitch: 800, rowPitch: 200, tiered: true });
  const all = expanded(l), oracle = solid(all), w = createRingSurfaceWorkspace();
  const child = all.find(p => p.innerRadius !== l.innerRadius), a = child.gapCenter - Math.PI, c = Math.cos(a), s = Math.sin(a), y = (child.minY + child.maxY) / 2;
  const cases = [
    [[c * 1050, y, s * 1050], [c * 990, y, s * 990], 0],
    [[c * 1e5, y, s * 1e5], [-c * 1e5, y, -s * 1e5], 1],
    [[c * (child.outerRadius + 1), y, s * (child.outerRadius + 1)], [c * 990, y, s * 990], 1],
    [[c * 1030, child.maxY + 1, s * 1030], [c * 1001, child.maxY + 1, s * 1001], 1],
    [[c * child.outerRadius, 1e4, s * child.outerRadius], [c * child.outerRadius, -1e4, s * child.outerRadius], 1],
    [[-1500, -300, -120], [1500, 300, 120], 8],
  ];
  for (const [start, end, radius] of cases) {
    const selected = [];
    assert.equal(visitRingSurfaceSweep(l, start, end.map((v, i) => v - start[i]), radius, w, collect, selected), true, w.reason);
    const expected = sweepSolid(oracle, start, end, radius, { maxIterations: 1000000 });
    const actual = sweepSolid(solid(selected), start, end, radius, { maxIterations: 1000000 });
    assert.notEqual(expected.status, 'failed'); assert.notEqual(actual.status, 'failed');
    assert.equal(actual.status, expected.status); near(actual.fraction, expected.fraction, 2e-10);
    const frame = [0, 0, -1, 0, 1, 0, 1, 0, 0], position = [1e7, -2e7, 3e7];
    const world = p => [position[0] - p[2], position[1] + p[1], position[2] + p[0]];
    const transformed = sweepSolid(solid(selected, { frame, position }), world(start), world(end), radius, { maxIterations: 1000000 });
    assert.equal(transformed.status, expected.status); near(transformed.fraction, expected.fraction, 2e-10);
  }
  w.child.maxCells = 1;
  const start = [c * 1050, y, s * 1050], delta = [-c * 60, 0, -s * 60];
  assert.equal(visitRingSurfaceSweep(l, start, delta, 8, w, collect, []), false);
  assert.equal(w.reason, 'ring-surface-cell-budget');
});

test('shader scalar recipe produces the same attached grouped child slabs and finite empty cells', () => {
  const maskSource = RING_SURFACE_LATTICE_GLSL.match(/bool ringChildCell\([^\n]+\)\{([\s\S]*?)\n\}/)[1]
    .replace(/\bint\s+/g, 'let ').replace(/\bint\(/g, 'Number(').replace(/\b(\d+)u\b/g, '$1');
  const shaderMask = new Function('seed', 'column', 'row', maskSource);
  const recipe = RING_SURFACE_LATTICE_GLSL.match(/bool ringPlateBounds\([^\n]+\)\{([\s\S]*?)\n\}/)[1]
    .replace(/const float /g, 'const ').replace(/\bfloat\s+/g, 'let ').replace(/\bfloat\(/g, 'Number(')
    .replace(/\b(\d+)u\b/g, '$1').replace('return true;', 'return {bounds,gap};');
  const execute = new Function('shell', 'parentGap', 'counts', 'seed', 'admittedColumns', 'tiered', 'masked', 'step', 'column', 'row', 'bounds', 'gap', 'ringPlateUnit', 'ringChildCell', 'vec4', 'vec2', recipe);
  const unit = (seed, c, r, salt) => (hash(seed, c, r, salt) % 65536) / 65536;
  const makeVector = (...values) => values;
  function gpu(l, c, r) {
    return execute({ x: l.innerRadius, y: l.outerRadius, z: l.minY, w: l.maxY }, { x: l.gapCenter },
      { x: l.columns, y: l.rows }, l.seed, { x: l.firstColumn, y: l.lastColumn }, l.tiered, l.masked, l.angleStep,
      c, r, null, null, unit, shaderMask, makeVector, makeVector);
  }
  const l = lattice({}, { pitch: 800, rowPitch: 200, tiered: true }), w = createRingSurfaceWorkspace(), modes = new Set();
  for (let c = 0; c < l.columns; c++) for (let r = 0; r < l.rows; r++) {
    ringSurfacePlate(l, c, r, w.plate);
    const root = { ...w.plate }, rootGpu = gpu(l, c, r);
    near(rootGpu.bounds[1], root.outerRadius, 1e-12);
    assert.ok(root.outerRadius <= l.innerRadius + (l.outerRadius - l.innerRadius) * .8);
    const child = writeRingSurfaceChildLattice(l, c, r, root, w.childLattice);
    assert.equal(child.seed, hash(l.seed, c, r, 5)); modes.add(child.seed & 3);
    let admitted = 0;
    for (let cc = 0; cc < 8; cc++) for (let rr = 0; rr < 8; rr++) {
      const expected = ringSurfacePlate(child, cc, rr, w.child.plate), actual = gpu(child, cc, rr);
      assert.equal(Boolean(actual), expected);
      assert.equal(shaderMask(child.seed, cc, rr), ringSurfaceChildCell(child.seed, cc, rr));
      if (!expected) continue;
      admitted++;
      const p = w.child.plate;
      for (let i = 0; i < 4; i++) near(actual.bounds[i], [p.innerRadius, p.outerRadius, p.minY, p.maxY][i], 1e-12);
      near(actual.gap[0], p.gapCenter, 1e-12); near(actual.gap[1], p.gapHalfAngle, 1e-12);
      assert.equal(p.innerRadius, root.outerRadius);
      assert.ok(p.outerRadius <= l.outerRadius && p.minY >= root.minY && p.maxY <= root.maxY);
      const half = Math.PI - p.gapHalfAngle, parentHalf = Math.PI - root.gapHalfAngle;
      assert.ok(p.gapCenter - half >= root.gapCenter - parentHalf - 1e-12);
      assert.ok(p.gapCenter + half <= root.gapCenter + parentHalf + 1e-12);
    }
    assert.equal(admitted, (child.seed & 3) === 1 ? 12 : 24);
  }
  assert.equal(modes.size, 4);
});

test('leaf DDA math clips the convex patch and covers diagonal/two-interval grids within twenty visits', () => {
  // The actual shader scalar crossing kernel above drives this CPU traversal;
  // independent dense interval samples check its visited cells. No native GPU
  // precision or pixels are claimed by this numeric geometry test.
  function trace(origin, ray, shell, start, width) {
    let lo = 0, hi = 1;
    for (let edge = 0; edge < 2; edge++) {
      const a = start + edge * width, sign = edge === 0 ? 1 : -1;
      const x = -Math.sin(a) * sign, z = Math.cos(a) * sign;
      const offset = origin[0] * x + origin[2] * z, rate = ray[0] * x + ray[2] * z;
      if (Math.abs(rate) < 1e-20) { if (offset < 0) return 0; }
      else if (rate > 0) lo = Math.max(lo, -offset / rate); else hi = Math.min(hi, -offset / rate);
    }
    if (Math.abs(ray[1]) < 1e-12) { if (origin[1] < shell[2] || origin[1] > shell[3]) return 0; }
    else {
      const a = (shell[2] - origin[1]) / ray[1], b = (shell[3] - origin[1]) / ray[1];
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    }
    const a = ray[0] ** 2 + ray[2] ** 2, b = origin[0] * ray[0] + origin[2] * ray[2], cross = origin[0] * ray[2] - origin[2] * ray[0];
    const disc = a * shell[1] ** 2 - cross ** 2;
    if (disc < 0) return 0;
    const root = Math.sqrt(disc);
    lo = Math.max(lo, (-b - root) / a); hi = Math.min(hi, (-b + root) / a);
    if (lo > hi) return 0;
    const hole = a * shell[0] ** 2 - cross ** 2, ranges = [];
    if (hole > 0) {
      const root = Math.sqrt(hole), enter = (-b - root) / a, leave = (-b + root) / a;
      if (enter > lo) ranges.push([lo, Math.min(hi, enter)]);
      if (leave < hi) ranges.push([Math.max(lo, leave), hi]);
    } else ranges.push([lo, hi]);
    const step = width / 8, rowStep = (shell[3] - shell[2]) / 8, ad = cross >= 0 ? 1 : -1, rd = ray[1] >= 0 ? 1 : -1;
    let count = 0;
    for (const [lo, hi] of ranges) {
      const p = origin.map((v, i) => v + ray[i] * lo), raw = Math.atan2(p[2], p[0]) - start;
      let column = Math.floor(Math.atan2(Math.sin(raw), Math.cos(raw)) / step), row = Math.floor((p[1] - shell[2]) / rowStep), current = lo, done = false;
      if (row === 8 && rd < 0) row--;
      const visited = new Set();
      for (let i = 0; i < 20; i++) {
        count++; visited.add(`${column},${row}`);
        assert.ok(count <= 20);
        if ((column < 0 && ad < 0) || (column >= 8 && ad > 0) || (row < 0 && rd < 0) || (row >= 8 && rd > 0)) { done = true; break; }
        const nextA = boundaryKernel(origin[0], origin[2], ray[0], ray[2], start + (column + (ad > 0 ? 1 : 0)) * step, current);
        const nextY = Math.abs(ray[1]) < 1e-12 ? 1e25 : Math.max(current, (shell[2] + (row + (rd > 0 ? 1 : 0)) * rowStep - origin[1]) / ray[1]);
        const next = Math.min(nextA, nextY);
        assert.ok(next >= current - 1e-7);
        if (next > hi) { done = true; break; }
        if (nextA <= nextY) column += ad;
        if (nextY <= nextA) row += rd;
        current = next;
      }
      assert.equal(done, true);
      for (let i = 1; i < 128; i++) {
        const t = lo + (hi - lo) * i / 128, p = origin.map((v, i) => v + ray[i] * t), raw = Math.atan2(p[2], p[0]) - start;
        const cx = Math.atan2(Math.sin(raw), Math.cos(raw)) / step, cy = (p[1] - shell[2]) / rowStep;
        if (Math.abs(cx - Math.round(cx)) < .005 || Math.abs(cy - Math.round(cy)) < .005) continue;
        assert.ok(visited.has(`${Math.floor(cx)},${Math.floor(cy)}`));
      }
    }
    return count;
  }
  for (const width of [.002, .2]) for (const reverse of [false, true]) {
    const center = 6.2, r = width === .002 ? 1.00001 : 1.00003;
    let start = [r * Math.cos(center - width * .49), -.00299, r * Math.sin(center - width * .49)];
    let end = [r * Math.cos(center + width * .49), .00299, r * Math.sin(center + width * .49)];
    if (reverse) [start, end] = [end, start];
    const ray = end.map((v, i) => v - start[i]), shell = [1, 1.00002, -.003, .003];
    assert.ok(trace(start, ray, shell, center - width / 2, width) > 0);
    assert.equal(trace(start.map(v => -v), ray.map(v => -v), shell, center - width / 2, width), 0);
  }
});

test('shader maximum-distance clipping preserves nearer shell intervals and excludes occluded detail', () => {
  // Execute the actual shader interval body with small vector values. Only
  // its one vector/scalar expression is expanded componentwise for JS; all
  // radial splitting and clipping branches are the production function.
  const source = RING_SURFACE_LATTICE_GLSL.match(/bool ringLatticeIntervals\([^\n]+\)\{([\s\S]*?)\n\}/)[1]
    .replace('(shell.zw-origin.y)/ray.y', 'vec2((shell.z-origin.y)/ray.y,(shell.w-origin.y)/ray.y)')
    .replace(/\bfloat\s+/g, 'let ').replace(/\bvec2\s+/g, 'let ');
  const execute = new Function('origin', 'ray', 'shell', 'clip', 'vec4', 'vec2', 'abs', 'min', 'max', 'dot', 'length', 'sqrt',
    `let intervals,intervalCount;const hit=(()=>{${source}})();return {hit,intervals,intervalCount};`);
  function vector(...values) {
    if (values.length === 1) values = [values[0], values[0], values[0], values[0]];
    const v = { x: values[0], y: values[1], z: values[2], w: values[3] };
    Object.defineProperties(v, {
      xz: { get: () => ({ x: v.x, y: v.z }) },
      xy: { get: () => ({ x: v.x, y: v.y }), set: p => { v.x = p.x; v.y = p.y; } },
      zw: { get: () => ({ x: v.z, y: v.w }), set: p => { v.z = p.x; v.w = p.y; } },
    });
    return v;
  }
  function intervals(origin, shell, minimum, maximum) {
    const result = execute(vector(...origin), vector(1, 0, 0), vector(...shell), vector(Math.max(0, minimum), Math.min(1e24, maximum)),
      vector, vector, Math.abs, Math.min, Math.max, (a, b) => a.x * b.x + a.y * b.y, a => Math.hypot(a.x, a.y), Math.sqrt);
    const i = result.intervals, ranges = result.intervalCount === 2 ? [[i.x, i.y], [i.z, i.w]] : result.intervalCount === 1 ? [[i.x, i.y]] : [];
    assert.equal(result.hit, result.intervalCount > 0);
    for (const [lo, hi] of ranges) assert.ok(lo >= minimum - 1e-12 && hi <= maximum + 1e-12);
    return ranges.filter(([lo, hi]) => hi > lo);
  }
  // A ray crosses a near shell, the hole, then a far shell. Every possible
  // minimum/known-nearest cut retains exactly their original intersection.
  for (const minimum of [0, 1.99, 2, 3.5, 4, 4.02]) for (const maximum of [1, 1.98, 1.99, 2, 3, 4, 4.01, 4.02, 6]) {
    if (maximum < minimum) continue;
    const actual = intervals([-3, 0, 0], [1, 1.02, -.5, .5], minimum, maximum);
    const expected = [[1.98, 2], [4, 4.02]].map(([lo, hi]) => [Math.max(minimum, lo), Math.min(maximum, hi)]).filter(([lo, hi]) => hi > lo);
    assert.equal(actual.length, expected.length, JSON.stringify({ minimum, maximum, actual, expected }));
    for (let i = 0; i < actual.length; i++) { near(actual[i][0], expected[i][0], 1e-12); near(actual[i][1], expected[i][1], 1e-12); }
  }
  // Interior view: the known inner-wall hit precedes both outer root/child
  // shells, so neither has an interval to traverse. No normal test is used.
  assert.deepEqual(intervals([0, 0, 0], [1, 1.02, -.5, .5], 0, .98), []);
  assert.deepEqual(intervals([0, 0, 0], [1.02, 1.024, -.5, .5], 0, .98), []);
  // Moving the bound just beyond a genuinely forward root/child surface
  // retains it; equality contributes no strictly nearer open interval.
  assert.deepEqual(intervals([0, 0, 0], [1, 1.02, -.5, .5], 0, 1), []);
  near(intervals([0, 0, 0], [1, 1.02, -.5, .5], 0, 1.001)[0][1], 1.001);
  near(intervals([0, 0, 0], [1.02, 1.024, -.5, .5], 0, 1.021)[0][1], 1.021);
});
