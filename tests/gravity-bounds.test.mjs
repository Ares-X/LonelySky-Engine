import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyGravity, createGravityField, MAX_GRAVITY } from '../src/gravity.js';
import { CELL_SIZE, decodeCell, encodeCell, wrapCell } from '../src/coordinates.js';
import { evaluateBodyState, orbitalPeriod } from '../src/orbits.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const vectorNear = (a, b) => a.forEach((value, i) => near(value, b[i]));
const sphere = (id, position, mu = 1e6) => ({ id, type: 'planet', position, radius: 20, mu, influence: 1e7 });
const emptySector = () => [];
const boundedWorld = bodies => ({ revision: 0, sector: emptySector, gravitySourcesInBounds: () => bodies });

test('large-range sources sum as vectors, cancel, and retain only a strongest-source HUD record', () => {
  const east = sphere('east', [1000, 0, 0]), west = sphere('west', [-1000, 0, 0]);
  const world = boundedWorld([east, west]);
  const field = createGravityField({ world });
  const canceled = field.sample(0, [0, 0, 0]);
  assert.deepEqual(canceled.acceleration, [0, 0, 0]);
  assert.equal(canceled.magnitude, 0);
  assert.equal(canceled.source.id, 'east');
  world.gravitySourcesInBounds = () => [east, west, sphere('north', [0, 2000, 0])];
  world.revision++;
  const north = field.sample(0, [0, 0, 0]);
  vectorNear(north.acceleration, [0, .25, 0]);
  assert.equal(north.source.id, 'east');
  world.gravitySourcesInBounds = () => [sphere('east', [1000, 0, 0], 3e8), sphere('north', [0, 1000, 0], 4e8)];
  world.revision++;
  const capped = field.sample(0, [0, 0, 0]);
  vectorNear(capped.acceleration, [MAX_GRAVITY * .6, MAX_GRAVITY * .8, 0]);
  assert.equal(capped.source.id, 'north');
});

for (const baseX of [0, 16383]) test(`gravity reads a source 40 cells away across frame ${baseX}`, () => {
  const from = encodeCell({ x: baseX, y: 0, z: 0 });
  const to = encodeCell({ x: wrapCell(baseX + 1), y: 0, z: 0 });
  const bodyX = wrapCell(baseX + 40);
  let calls = 0;
  const world = { revision: 0, sector: emptySector, gravitySourcesInBounds(index, bounds) {
    calls++;
    assert.deepEqual(bounds, { min: [-10000, -10000, -10000], max: [10000, 10000, 10000] });
    return [{ ...sphere('distant-giant', [wrapCell(bodyX - decodeCell(index).x) * CELL_SIZE, 0, 0], 6.4e11),
      radius: 400000, orbit: { semiMajorAxis: 50000, eccentricity: .1, mu: 1e12 } }];
  } };
  const field = createGravityField({ world });
  const before = field.sample(from, [9900, 0, 0], 17);
  const after = field.sample(to, [-10100, 0, 0], 17);
  assert.ok(before.acceleration[0] > 0);
  vectorNear(before.acceleration, after.acceleration);
  vectorNear(before.source.velocity, after.source.velocity);
  near(before.source.position[0] - after.source.position[0], CELL_SIZE);
  assert.equal(calls, 2);
});

test('orbital bounds candidates sample the same absolute time and focus as the authoritative body sampler', () => {
  const body = { ...sphere('moon', [700000, 100, -200], 1e8), orbit: {
    semiMajorAxis: 60000, eccentricity: .3, mu: 1e13, inclination: .2, ascendingNode: .7,
  } };
  const world = boundedWorld([body]), field = createGravityField({ world });
  const period = orbitalPeriod(body.orbit), position = [0, 0, 0];
  const first = field.sample(0, position, 0);
  for (const time of [0, period * .25, -period * .1, period * .75, 0]) {
    const state = evaluateBodyState(body, time), result = field.sample(0, position, time);
    vectorNear(result.source.position, state.position);
    vectorNear(result.source.velocity, state.velocity);
    vectorNear(result.acceleration, bodyGravity({ ...body, position: state.position }, position));
  }
  assert.notDeepEqual(field.sample(0, position, period * .25).source.position, first.source.position);
  vectorNear(field.sample(0, position, 0).source.position, first.source.position);
});

test('stable IDs prevent double force through bounds duplicates and local-sector overlap', () => {
  const macro = sphere('shared', [1000, 0, 0]);
  const world = { ...boundedWorld([macro, { ...macro }]), sector: index => index === 0 ? [macro, sphere('local-only', [0, 2000, 0])] : [] };
  const result = createGravityField({ world }).sample(0, [0, 0, 0]);
  vectorNear(result.acceleration, [1, .25, 0]);
  assert.equal(result.source.id, 'shared');
});

test('adding an empty bounds provider keeps ordinary legacy gravity byte-for-byte unchanged', () => {
  const bodies = [{ id: 'legacy', type: 'star', position: [900, -300, 100], radius: 120 }];
  const sector = index => index === 0 ? bodies : [];
  const legacy = createGravityField({ sector });
  const extended = createGravityField({ world: { sector, revision: 0, gravitySourcesInBounds: emptySector } });
  for (const position of [[0, 0, 0], [900, -300, 100], [-9000, 50, 900], [100000, 0, 0]]) {
    assert.deepEqual(extended.sample(0, position, 14), legacy.sample(0, position, 14));
  }
});

test('integration substeps reuse the active candidates, sampler descriptors and output storage until index or revision changes', () => {
  let providerCalls = 0, descriptorReads = 0, boundsIdentity;
  const body = sphere('cached', [700000, 0, 0], 1e11);
  const watched = new Proxy(body, { get(target, key) { descriptorReads++; return target[key]; } });
  const world = { revision: 0, sector: emptySector, gravitySourcesInBounds(index, bounds) {
    providerCalls++;
    if (boundsIdentity) assert.equal(bounds, boundsIdentity);
    boundsIdentity = bounds;
    return [watched];
  } };
  const field = createGravityField({ world }), out = field.createSample(), point = [0, 0, 0];
  field.sampleInto(0, point, 0, out);
  const acceleration = out.acceleration, source = out.source, sourcePosition = source.position, sourceVelocity = source.velocity;
  const readsAtEntry = descriptorReads, firstAcceleration = acceleration[0];
  body.mu *= 2;
  for (let step = 1; step <= 12000; step++) {
    field.sampleInto(0, point, step / 120, out);
    assert.equal(out.acceleration, acceleration); assert.equal(out.source, source);
    assert.equal(source.position, sourcePosition); assert.equal(source.velocity, sourceVelocity);
  }
  assert.equal(providerCalls, 1); assert.equal(descriptorReads, readsAtEntry);
  assert.equal(acceleration[0], firstAcceleration);
  world.revision++;
  field.sampleInto(0, point, 100, out);
  near(acceleration[0], firstAcceleration * 2); assert.equal(providerCalls, 2);
  field.sampleInto(encodeCell({ x: 1, y: 0, z: 0 }), point, 100, out);
  assert.equal(providerCalls, 3);
});

test('bounds-provider invalid mass contracts fail explicitly before entering integration', () => {
  for (const changes of [{ id: '' }, { mu: 0 }, { influence: Infinity }, { radius: -1 }]) {
    const body = { ...sphere('invalid', [1000, 0, 0]), ...changes };
    assert.throws(() => createGravityField({ world: boundedWorld([body]) }).sample(0, [0, 0, 0]), /Gravity bounds sources require/);
  }
});
