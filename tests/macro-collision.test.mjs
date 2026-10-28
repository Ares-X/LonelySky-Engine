import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionWorld, safeRadius, COLLISION_CACHE_LIMIT } from '../src/collision.js';
import { CELL_SIZE, encodeCell, decodeCell, wrapCell } from '../src/coordinates.js';
import { evaluateBodyState } from '../src/orbits.js';

const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const close = (a, b, epsilon = 1e-6) => assert.ok(distance(a, b) < epsilon, `${a} != ${b}`);
const zero = [0, 0, 0], h = 1 / 120;
function cellOffset(from, to) {
  const a = decodeCell(from), b = decodeCell(to);
  return ['x', 'y', 'z'].map(axis => wrapCell(a[axis] - b[axis]) * CELL_SIZE);
}
const moon = (changes = {}) => ({ id: 'large-moon', type: 'planet', radius: 5000,
  position: [-1000000, 0, 0], orbit: { semiMajorAxis: 1000000, eccentricity: 0, mu: 1e16 }, ...changes });
// A full-phase envelope: the focus may be > 40 legacy cells away. This fixture
// deliberately does not select candidates from their pose at a requested time.
function boundsWorld(bodies, sector = () => []) {
  return { revision: 0, sector, bodiesInBounds(index, bounds) {
    const offset = cellOffset(0, index);
    const result = [];
    for (const body of bodies) {
      const position = body.position.map((n, i) => n + offset[i]);
      const reach = (body.orbit?.semiMajorAxis ?? 0) * (1 + (body.orbit?.eccentricity ?? 0)) + body.radius;
      if (position.every((n, i) => n + reach >= bounds.min[i] && n - reach <= bounds.max[i])) {
        result.push({ ...body, position });
      }
    }
    return result;
  } };
}

test('a macro moon with a far focus sweeps a stationary ship using relative surface velocity', () => {
  const body = moon(), world = boundsWorld([body]);
  const collision = createCollisionWorld({ world }), start = [0, 5500, 0];
  assert.ok(Math.abs(body.position[0]) > 40 * CELL_SIZE);
  const result = collision.move(0, start, start, zero, { deltaTime: h });
  assert.equal(result.contact.id, body.id); assert.equal(result.corrected, true);
  assert.equal(result.failure, undefined); assert.ok(result.velocity[1] > 0);
  assert.ok(distance(result.position, evaluateBodyState(body, h).position) >= body.radius + 8 - 1e-6);
  const relative = result.velocity.map((n, i) => n - result.contact.velocity[i]);
  assert.ok(relative.reduce((sum, n, i) => sum + n * result.contact.normal[i], 0) >= -1e-6);
});

test('macro moon CCD catches a whole crossing with both endpoints outside', () => {
  const body = moon({ orbit: { ...moon().orbit, meanAnomalyAtEpoch: -.006 } });
  const collision = createCollisionWorld({ world: boundsWorld([body]) }), duration = .12;
  assert.ok(distance(zero, evaluateBodyState(body, 0).position) > body.radius + 8);
  assert.ok(distance(zero, evaluateBodyState(body, duration).position) > body.radius + 8);
  const result = collision.move(0, zero, zero, zero, { deltaTime: duration });
  assert.equal(result.contact.id, body.id); assert.equal(result.failure, undefined);
  assert.ok(result.position[1] > 5000);
  assert.ok(distance(result.position, evaluateBodyState(body, duration).position) >= body.radius + 8 - 1e-6);
});

test('macro physical hulls support ordinary, zero and subunit ship radii without legacy exclusion walls', () => {
  for (const radius of [3500, 25000]) for (const shipRadius of [8, 0, .5]) {
    const body = moon({ radius, position: zero, orbit: undefined });
    const collision = createCollisionWorld({ world: boundsWorld([body]), shipRadius });
    const start = [-radius - 1000, 0, 0], end = [radius + 1000, 0, 0];
    const result = collision.move(0, start, end, [1e7, 0, 0], { deltaTime: h });
    assert.equal(result.contact.id, body.id); assert.equal(result.failure, undefined);
    close(result.position, [-radius - shipRadius, 0, 0]);
    assert.equal(collision.ensureSafe(0, [radius + shipRadius + .01, 0, 0], zero).corrected, false);
    assert.ok(safeRadius('planet', radius) > radius + shipRadius);
  }
});

test('macro body snapshots and recovery follow absolute time and ordinary/toroidal rebases', () => {
  for (const x of [0, 16383]) {
    const west = encodeCell({ x, y: 0, z: 0 });
    const east = encodeCell({ x: x === 16383 ? -16384 : x + 1, y: 0, z: 0 });
    const body = moon({ position: [-990000, 0, 0] });
    const world = { revision: 0, sector: () => [], bodiesInBounds(index) {
      return [{ ...body, position: body.position.map((n, i) => n + cellOffset(west, index)[i]) }];
    } };
    const collision = createCollisionWorld({ world }), timeSeconds = .03;
    const state = evaluateBodyState(body, timeSeconds), start = state.position;
    const rebased = start.map((n, i) => n - (i === 0 ? CELL_SIZE : 0));
    const a = collision.ensureSafe(west, start, zero, timeSeconds);
    const b = collision.ensureSafe(east, rebased, zero, timeSeconds);
    close(a.position, b.position.map((n, i) => n + (i === 0 ? CELL_SIZE : 0)));
    close(a.velocity, b.velocity); assert.equal(a.contact.id, b.contact.id);
    for (const t of [timeSeconds, -.1, 0, timeSeconds]) {
      close(collision.bodies(west, t)[0].position, evaluateBodyState(body, t).position);
    }
    const retained = collision.bodies(west, timeSeconds)[0];
    collision.bodies(east, -.1);
    close(retained.position, state.position);
    retained.position.fill(999); retained.orbit.mu = 1;
    close(collision.bodies(west, timeSeconds)[0].position, state.position);
  }
});

test('macro and local spheres share earliest TOI; stable IDs select macro physical radius', () => {
  const macro = moon({ position: zero, orbit: undefined, radius: 100 });
  const duplicate = { ...macro, radius: 1000 };
  const local = { id: 'local-first', type: 'planet', radius: 100, position: [-500, 0, 0] };
  const world = boundsWorld([macro, macro], index => index === 0 ? [duplicate, local] : []);
  const collision = createCollisionWorld({ world });
  const result = collision.move(0, [-1500, 0, 0], [1500, 0, 0], [3.6e5, 0, 0], { deltaTime: h });
  assert.equal(result.contact.id, 'local-first'); close(result.position, [-640, 0, 0]);
  assert.equal(collision.bodies(0).filter(body => body.id === macro.id).length, 1);
  assert.equal(collision.bodies(0).find(body => body.id === macro.id).clearance, 108);
  const macroFirst = boundsWorld([macro], index => index === 0 ? [{ ...local, position: [500, 0, 0] }] : []);
  assert.equal(createCollisionWorld({ world: macroFirst }).move(0, [-1500, 0, 0], [1500, 0, 0], [3.6e5, 0, 0], { deltaTime: h }).contact.id, macro.id);
});

test('macro cache covers a full spatial piece and refreshes same-time samples after radius/revision changes', () => {
  let queries = 0, reads = 0, boundsIdentity;
  const descriptor = moon({ orbit: undefined, radius: 100, position: zero });
  Object.defineProperty(descriptor, 'name', { get() { reads++; return 'cached'; } });
  const world = { revision: 0, sector: () => [], bodiesInBounds(index, bounds) {
    queries++;
    if (boundsIdentity) assert.equal(bounds, boundsIdentity);
    boundsIdentity = bounds;
    const extent = 15000 + activeRadius;
    assert.deepEqual(bounds, { min: [-extent, -extent, -extent], max: [extent, extent, extent] });
    return [descriptor];
  } };
  let activeRadius = 8;
  const collision = createCollisionWorld({ world });
  const snapshot = collision.bodies(0, 1)[0], initialReads = reads;
  for (let i = 0; i < 100; i++) {
    collision.ensureSafe(0, [1000, 0, 0], zero, i / 120);
    collision.move(0, [-1000, 0, 0], [1000, 0, 0], [240000, 0, 0], { timeSeconds: i / 120, deltaTime: h });
  }
  assert.equal(queries, 1); assert.equal(reads, initialReads);
  collision.setShipRadius(8); collision.bodies(0, 1); assert.equal(queries, 1);
  for (const radius of [0, .5, 8]) {
    activeRadius = radius; collision.setShipRadius(radius);
    assert.equal(collision.bodies(0, 1)[0].clearance, 100 + radius);
    const hit = collision.move(0, [-1000, 0, 0], [1000, 0, 0], [240000, 0, 0]);
    close(hit.position, [-100 - radius, 0, 0]);
  }
  assert.equal(queries, 4); assert.equal(snapshot.clearance, 108);
  descriptor.position = [500, 0, 0]; world.revision++;
  close(collision.bodies(0, 1)[0].position, descriptor.position); assert.equal(queries, 5);
  for (let x = 1; x <= COLLISION_CACHE_LIMIT; x++) collision.bodies(encodeCell({ x, y: 0, z: 0 }));
  collision.bodies(0); assert.equal(queries, COLLISION_CACHE_LIMIT + 6);
});

test('macro moving contact infeasibility retains a verified initial pose and explicit cause', () => {
  const bodies = [-1, 1].map(sign => moon({ id: `closing-${sign}`, radius: 10,
    position: [sign * 28, -sign * 1000000, 0],
    orbit: { semiMajorAxis: 1000000, eccentricity: 0, mu: 4e15, meanAnomalyAtEpoch: sign * Math.PI / 2 } }));
  const collision = createCollisionWorld({ world: boundsWorld(bodies) });
  const result = collision.move(0, zero, [0, 0, .1], [0, 0, 12], { deltaTime: h });
  assert.equal(result.failure.code, 'infeasible-moving-contact'); assert.equal(result.failure.safeAtStart, true);
  assert.match(result.failure.cause.message, /no feasible/); assert.equal(result.failure.contacts.length, 2);
  close(result.position, zero); assert.equal(result.distance, 0);
});

test('a candidate just beyond the cell is included for the full next spatial piece across seams', () => {
  for (const x of [0, 16383]) {
    const index = encodeCell({ x, y: 0, z: 0 });
    const body = moon({ radius: 100, orbit: undefined, position: [14000, 0, 0] });
    let queried = 0;
    const world = { sector: () => [], bodiesInBounds(queryIndex, bounds) {
      queried++;
      const position = body.position.map((n, i) => n + cellOffset(index, queryIndex)[i]);
      return position[0] - body.radius <= bounds.max[0] ? [{ ...body, position }] : [];
    } };
    const result = createCollisionWorld({ world }).move(index, [9900, 0, 0], [14900, 0, 0], [600000, 0, 0]);
    assert.equal(result.contact.id, body.id); close(result.position, [13892, 0, 0]);
    assert.equal(queried, 1); // the first candidate query already covers the entire chord
  }
});

test('macro and static solid providers compete in the existing event loop', () => {
  const body = moon({ radius: 100, position: zero, orbit: undefined });
  const world = boundsWorld([body]);
  world.solidsInBounds = () => [{ id: 'solid', position: [-500, 0, 0], boundsRadius: 100,
    shape: { type: 'sphere', radius: 100 } }];
  const collision = createCollisionWorld({ world });
  const left = collision.move(0, [-1500, 0, 0], [1500, 0, 0], [3.6e5, 0, 0], { deltaTime: h });
  assert.equal(left.contact.id, 'solid'); close(left.position, [-608, 0, 0], 2e-5);
  const right = collision.move(0, [1500, 0, 0], [-1500, 0, 0], [-3.6e5, 0, 0], { deltaTime: h });
  assert.equal(right.contact.id, body.id); close(right.position, [108, 0, 0]);
});

test('empty or omitted macro providers preserve legacy collisions and validate only the external macro contract', () => {
  const body = { id: 'legacy', type: 'planet', radius: 100, position: zero };
  const sector = index => index === 0 ? [body] : [];
  const legacy = createCollisionWorld({ sector });
  const extended = createCollisionWorld({ sector, bodyProvider: () => [] });
  for (const timeSeconds of [0, 1, -.1]) {
    for (const deltaTime of [0, h]) {
      const args = [0, [-1000, 0, 0], [1000, 0, 0], [240000, 0, 0], { timeSeconds, deltaTime }];
      assert.deepEqual(extended.move(...args), legacy.move(...args));
    }
    assert.deepEqual(extended.bodies(0, timeSeconds), legacy.bodies(0, timeSeconds));
  }
  for (const bad of [{ ...body, id: '' }, { ...body, radius: Infinity }, { ...body, position: [0, NaN, 0] }]) {
    assert.throws(() => createCollisionWorld({ sector: () => [], bodyProvider: () => [bad] }).bodies(0), /Collision bounds bodies require|body.position/);
  }
});
