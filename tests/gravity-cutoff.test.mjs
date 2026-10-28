import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyGravity, createGravityField } from '../src/gravity.js';

const provider = body => index => index === 0 ? [body] : [];

test('field cutoff preserves component, diagonal and taper boundaries for each gravity profile', () => {
  for (const type of ['planet', 'star', 'black-hole', 'toString']) for (const mu of [undefined, 1e6]) {
    const body = { id: 'source', type, radius: 100, position: [0, 0, 0], mu, influence: 1000 };
    const field = createGravityField({ sector: provider(body) });
    for (const distance of [0, 1, 650, 999.999999999, 1000, 1000.000000001, 1e308]) {
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const position = [0, 0, 0]; position[axis] = sign * distance;
        assert.deepEqual(field.sample(0, position).acceleration, bodyGravity(body, position));
      }
    }
    for (const position of [[600, 600, 600], [700, 700, 0], [800, 800, 0], [1e308, -1e308, 0]]) {
      assert.deepEqual(field.sample(0, position).acceleration, bodyGravity(body, position));
    }
  }
});

test('field influence retains legacy zero, negative, infinite and invalid numeric behavior', () => {
  for (const influence of [0, -1, Infinity, NaN]) {
    const body = { id: 'source', type: 'planet', radius: 100, position: [0, 0, 0], influence };
    const field = createGravityField({ sector: provider(body) });
    assert.deepEqual(field.sample(0, [0, 0, 0]).acceleration, [0, 0, 0]);
    if (Number.isNaN(influence)) assert.throws(() => field.sample(0, [1000, 0, 0]), /Summed gravity/);
    else assert.deepEqual(field.sample(0, [1000, 0, 0]).acceleration, bodyGravity(body, [1000, 0, 0]));
  }
});

test('descriptor influence snapshots change only with revisions for local and bounds sources', () => {
  for (const extended of [false, true]) {
    const body = { id: 'source', type: 'planet', radius: 100, position: [1000, 0, 0], mu: 1e6, influence: 100 };
    let queries = 0;
    const world = { revision: 0, sector: provider(body) };
    if (extended) world.gravitySourcesInBounds = () => { queries++; return [body]; };
    const field = createGravityField({ world }), out = field.createSample();
    assert.equal(field.sampleInto(0, [0, 0, 0], 0, out).source, null);
    body.influence = 2000;
    assert.equal(field.sampleInto(0, [0, 0, 0], 0, out).source, null);
    if (extended) assert.equal(queries, 1);
    world.revision++;
    assert.deepEqual(field.sampleInto(0, [0, 0, 0], 0, out).acceleration, [1, 0, 0]);
    assert.equal(out.source.id, body.id);
    assert.deepEqual(out.source.position, body.position);
    const retained = field.sample(0, [0, 0, 0]);
    body.influence = 100;
    world.revision++;
    assert.equal(field.sampleInto(0, [0, 0, 0], 0, out).source, null);
    assert.deepEqual(retained.acceleration, [1, 0, 0]);
    assert.equal(retained.source.id, body.id);
    if (extended) assert.equal(queries, 3);
  }
});
