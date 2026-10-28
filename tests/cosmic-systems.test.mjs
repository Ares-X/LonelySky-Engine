import test from 'node:test';
import assert from 'node:assert/strict';
import { rotationFrame3, frameToWorld3 } from '../src/frame.js';
import { encodeCell, wrapCell, CELL_SIZE } from '../src/coordinates.js';
import { describeCosmicBody, cosmicBodyCenter, COSMIC_BODY_GRID_SIZE } from '../src/cosmic-bodies.js';
import { describeCosmicSystem, cosmicSystemBodiesInBounds, cosmicGravitySourcesInBounds,
  cosmicSystemOccupancyInBounds, COSMIC_SYSTEM_MAX_REACH } from '../src/cosmic-systems.js';
import { evaluateBodyState, orbitalPeriod } from '../src/orbits.js';
import { solidDistance, createSolidWorkspace } from '../src/solid-geometry.js';

const seed = 'satellite-fixture', axes = ['x', 'y', 'z'];
const frame = rotationFrame3([.4, .7, -.3]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const primary = (kind = 'gas-giant', id = 'test-primary', radius = 1000000) => ({ id, kind, radius, boundsRadius: radius, frame });
const systems = Array.from({ length: 120 }, (_, i) => describeCosmicSystem(primary(i % 2 ? 'dark-world' : 'gas-giant', `test-${i}`), seed));
const pointBounds = point => ({ min: [...point], max: [...point] });

test('independent named satellite streams preserve primaries and deterministic complete systems', () => {
  const body = primary(), original = structuredClone(body);
  const first = describeCosmicSystem(body, seed);
  for (let i = 119; i >= 0; i--) describeCosmicSystem(primary('dark-world', `test-${i}`), seed);
  assert.deepEqual(first, describeCosmicSystem(body, seed));
  assert.notDeepEqual(first, describeCosmicSystem(body, `${seed}-other`));
  assert.deepEqual(body, original);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.primaryGravity) && Object.isFrozen(first.satellites));
  assert.ok(systems.some(system => system.satellites.length === 0));
  assert.ok(systems.some(system => system.satellites.length >= 4));
  for (let i = 0; i < systems.length; i++) {
    const system = systems[i];
    assert.ok(system.satellites.length <= (i % 2 ? 2 : 5));
    const g = system.primaryGravity.mu / system.primaryGravity.radius ** 2;
    assert.ok(g >= (i % 2 ? 3 : 6) && g <= (i % 2 ? 8 : 12));
  }
});

test('all phases clear the primary, one another and the bounded macro-system envelope', () => {
  for (const system of systems) {
    let previous;
    assert.ok(system.gravityEnvelopeRadius <= COSMIC_SYSTEM_MAX_REACH);
    assert.ok(system.solidEnvelopeRadius < COSMIC_BODY_GRID_SIZE * .47);
    for (const moon of system.satellites) {
      assert.ok(Object.isFrozen(moon.orbit) && Object.isFrozen(moon.position));
      const { semiMajorAxis: a, eccentricity: e, mu } = moon.orbit;
      assert.ok(a >= 2.5e6 && a <= 4.2e6);
      assert.ok(moon.radius >= 8000 && moon.radius <= 35000);
      assert.ok(a * (1 - e) - moon.radius > 1000000);
      assert.ok(a*(1-e)>moon.rocheLimit);
      assert.equal(moon.rocheLimit,2.44*1000000*Math.cbrt(1/moon.densityRatio));
      assert.ok(a * (1 + e) + moon.radius <= system.solidEnvelopeRadius);
      assert.ok(a * (1 + e) + moon.influence <= system.gravityEnvelopeRadius);
      assert.equal(moon.mu, mu * moon.densityRatio * (moon.radius / 1000000) ** 3);
      assert.ok(moon.influence > moon.radius);
      if (previous) {
        assert.ok(a * (1 - e) - moon.radius > previous.boundsRadius);
        const hill = (a + previous.orbit.semiMajorAxis) * .5 * Math.cbrt((moon.mu + previous.mu) / (3 * mu));
        assert.ok(a - previous.orbit.semiMajorAxis >= 3.5 * hill);
      }
      previous = moon;
    }
  }
  const star = describeCosmicSystem(primary('stellar-giant', 'star', 1200000), seed);
  assert.equal(star.satellites.length, 0);
  assert.ok(star.primaryGravity.mu / 1200000 ** 2 >= 12);
  assert.equal(star.gravityEnvelopeRadius, COSMIC_SYSTEM_MAX_REACH);
});

test('shared Kepler state has parent-frame planes, conserved motion and the game-second period', () => {
  for (const system of systems.slice(0, 15)) for (const moon of system.satellites) {
    const period = orbitalPeriod(moon.orbit), a = moon.orbit.semiMajorAxis;
    const expected = Math.PI * 2 * Math.sqrt(a ** 3 / system.primaryGravity.mu);
    assert.ok(Math.abs(period / expected - 1) < 1e-14);
    const atZero = evaluateBodyState(moon, 0), after = evaluateBodyState(moon, period);
    after.position.forEach((n, i) => assert.ok(Math.abs(n - atZero.position[i]) < 1e-7));
    const energy = -moon.orbit.mu / (2 * a);
    for (let step = 0; step < 32; step++) {
      const state = evaluateBodyState(moon, period * step / 32);
      const p = state.position, v = state.velocity, momentum = cross(p, v);
      assert.ok(dot(momentum, system.planeNormal) / Math.hypot(...momentum) >= Math.cos(.025) - 1e-14);
      assert.ok(Math.abs((dot(v, v) / 2 - moon.orbit.mu / Math.hypot(...p)) / energy - 1) < 2e-14);
      assert.ok(Math.hypot(...p) <= moon.boundsRadius - moon.radius + 1e-7);
    }
    const time = period * .19, dt = period * 1e-6;
    const before = evaluateBodyState(moon, time - dt), current = evaluateBodyState(moon, time), later = evaluateBodyState(moon, time + dt);
    current.velocity.forEach((n, i) => assert.ok(Math.abs((later.position[i] - before.position[i]) / (2 * dt) - n) < .00001));
    assert.ok(Math.hypot(...current.position.map((n, i) => n - atZero.position[i])) > a * .5);
  }
});

const catalogue = [];
for (const x of [-32, 0, 1]) for (let y = -10; y <= 10; y++) for (let z = -10; z <= 10; z++) {
  const body = describeCosmicBody({ x, y, z }, seed);
  if (body) catalogue.push(body);
}

test('satellite broadphase reaches beyond parent surfaces, rebases, wraps seams and deduplicates', () => {
  const parents = catalogue.filter(body => describeCosmicSystem(body, seed).satellites.length);
  assert.ok(parents.some(body => body.cell.x === -32), 'fixture includes a world-seam parent');
  for (const body of parents) {
    const system = describeCosmicSystem(body, seed), moon = system.satellites.at(-1);
    const cell = { x: wrapCell(body.cell.x * 512), y: wrapCell(body.cell.y * 512), z: wrapCell(body.cell.z * 512) };
    const index = encodeCell(cell), center = cosmicBodyCenter(body, index);
    const point = center.map((n, i) => n + (i === 0 ? moon.orbit.semiMajorAxis : 0));
    const query = cosmicSystemBodiesInBounds({ sectorIndex: index, seed, bounds: pointBounds(point) });
    assert.ok(query.some(candidate => candidate.id === moon.id));
    assert.equal(new Set(query.map(candidate => candidate.id)).size, query.length);
    const relocated = { ...cell, x: wrapCell(cell.x - 1) }, nextIndex = encodeCell(relocated);
    const next = cosmicSystemBodiesInBounds({ sectorIndex: nextIndex, seed,
      bounds: pointBounds(point.map((n, i) => n + (i === 0 ? CELL_SIZE : 0))) });
    const result = next.find(candidate => candidate.id === moon.id);
    assert.ok(result);
    const expectedCenter = cosmicBodyCenter(body, nextIndex);
    result.position.forEach((n, i) => assert.ok(Math.abs(n - expectedCenter[i]) < 1e-7));
    assert.deepEqual(result.orbit, moon.orbit);
    assert.ok(Math.abs(result.position[0] - query.find(candidate => candidate.id === moon.id).position[0] - CELL_SIZE) < 1e-7);
  }
});

test('gravity broadphase includes only overlapping finite influence envelopes, ring has no fictitious center', () => {
  for (const body of catalogue) {
    const system = describeCosmicSystem(body, seed);
    if (!system.primaryGravity) continue;
    const index = encodeCell({ x: 0, y: 0, z: 0 }), center = cosmicBodyCenter(body, index);
    const inside = center.map((n, i) => n + (i === 1 ? system.primaryGravity.influence * .99 : 0));
    const outside = center.map((n, i) => n + (i === 1 ? system.primaryGravity.influence * 1.01 : 0));
    assert.ok(cosmicGravitySourcesInBounds({ sectorIndex: index, seed, bounds: pointBounds(inside) }).some(source => source.id === body.id));
    assert.ok(!cosmicGravitySourcesInBounds({ sectorIndex: index, seed, bounds: pointBounds(outside) }).some(source => source.id === body.id));
    const sources = cosmicGravitySourcesInBounds({ sectorIndex: index, seed,
      bounds: { min: center.map(n => n - system.gravityEnvelopeRadius), max: center.map(n => n + system.gravityEnvelopeRadius) } });
    for (const moon of system.satellites) assert.ok(sources.some(source => source.id === moon.id && source.mu === moon.mu));
  }
  for (const kind of ['ring', 'nebula', 'cluster']) {
    const system = describeCosmicSystem(primary(kind), seed);
    assert.equal(system.primaryGravity, null);
    assert.deepEqual(system.satellites, []);
  }
});

test('query rejects inverted bounds rather than turning expansion into valid bounds', () => {
  assert.throws(() => cosmicSystemBodiesInBounds({ sectorIndex: 0, bounds: { min: [1, 0, 0], max: [0, 0, 0] } }), RangeError);
});

test('placement-only orbit annuli contain complete moon spheres through every sampled phase', () => {
  const index = encodeCell({ x: 0, y: 0, z: 0 }), workspace = createSolidWorkspace();
  let sampled = 0;
  for (const body of catalogue) {
    const center = cosmicBodyCenter(body, index), system = describeCosmicSystem(body, seed);
    const reservations = cosmicSystemOccupancyInBounds({ sectorIndex: index, seed, bounds: pointBounds(center) });
    if (body.kind === 'ring') assert.ok(!reservations.some(value => value.parentId === body.id));
    for (const moon of system.satellites) {
      const reservation = reservations.find(value => value.id === `${moon.id}:orbit-occupancy`);
      assert.ok(reservation);
      assert.equal(reservation.role, 'placement-reservation');
      assert.ok(!Object.hasOwn(reservation, 'mu') && !Object.hasOwn(reservation, 'orbit'));
      const part = reservation.shape.parts[0];
      assert.equal(part.gapHalfAngle, 0);
      assert.equal(reservation.boundsRadius, Math.hypot(part.outerRadius, part.maxY));
      const anchoredMoon = { ...moon, position: center }, period = orbitalPeriod(moon.orbit);
      for (let phase = 0; phase < 128; phase++) {
        const state = evaluateBodyState(anchoredMoon, period * phase / 128);
        const distance = solidDistance(reservation, state.position, workspace.distance, workspace).distance;
        assert.ok(distance <= -moon.radius + 1e-7, `whole moon sphere is reserved at phase ${phase}`);
        sampled++;
      }
      // A local radius-500 body in the central hole remains admitted, while
      // one at the actual moon center is excluded. Above-plane space also stays
      // available rather than reserving an apoapsis-sized solid sphere.
      assert.ok(solidDistance(reservation, center, workspace.distance, workspace).distance > 500);
      const state = evaluateBodyState(anchoredMoon, 0);
      assert.ok(solidDistance(reservation, state.position, workspace.distance, workspace).distance < 500);
      const above = frameToWorld3(reservation.frame, [moon.orbit.semiMajorAxis, part.maxY + 700, 0]).map((n, i) => n + center[i]);
      assert.ok(solidDistance(reservation, above, workspace.distance, workspace).distance > 500);
      const outside = center.map((n, i) => n + (i === 0 ? reservation.boundsRadius + 1 : 0));
      assert.ok(!cosmicSystemOccupancyInBounds({ sectorIndex: index, seed, bounds: pointBounds(outside) })
        .some(value => value.id === reservation.id));
    }
  }
  assert.ok(sampled >= 128);
});
