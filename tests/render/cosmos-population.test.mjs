import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeCell} from '../../src/coordinates.js';
import {createCosmos, sampleGalaxy, COSMOS_QUALITY_COUNTS, PARTICLES_PER_GALAXY} from '../../src/render/cosmos.js';

const origin = Object.freeze({x: 0, y: 0, z: 0});
const away = Object.freeze({x: 96, y: 0, z: 0});
const descriptor = Object.freeze({
  id: 'population-fixture', seed: 'population-fixture:stars', revision: 3,
  kind: 'cluster', family: 'globular', morphology: 'elliptical',
  macroCell: origin, offset: Object.freeze([123, -456, 789]),
  orientation: Object.freeze([.81, 1.21, -.37]), radius: 71000,
  thickness: .65, arms: 2, pitch: .3, bar: false, asymmetry: .2,
});
const descriptorProvider = coordinate => coordinate.x || coordinate.y || coordinate.z ? null : descriptor;
const frame = (cell = origin, quality = 'high') => ({
  sectorIndex: encodeCell(cell), cameraPosition: [4, 5, 6], quality,
});
const options = {
  seed: 'shared-population-world', descriptorProvider,
  catalogue: {capacity: 4, immutable: true},
};
function population(red, green, blue) {
  const colors = new Float32Array(PARTICLES_PER_GALAXY * 3);
  for (let i = 0; i < PARTICLES_PER_GALAXY; i++) {
    colors[i * 3] = red * (1 + i / PARTICLES_PER_GALAXY);
    colors[i * 3 + 1] = green;
    colors[i * 3 + 2] = blue;
  }
  // The provider and its caller-owned data stay fixed for the instance lifetime.
  return Object.freeze({colors, coreRadius: .06, cumulativeExponent: .7});
}
function attributes(cosmos) {
  const a = cosmos.children[0].geometry.attributes;
  return {position: a.position.array.slice(), color: a.color.array.slice(), pointRadius: a.pointRadius.array.slice()};
}
async function publish(cosmos, target, incremental) {
  if (incremental) await cosmos.userData.prepare(target);
  else cosmos.userData.update(target);
  assert.ok(cosmos.userData.isReady(target));
}

test('fixed population providers are isolated across same-seed instances, tiers and cached revisits', async () => {
  const a = population(.8, .2, .1), b = population(.1, .3, .9);
  const aBefore = a.colors.slice(), bBefore = b.colors.slice();
  const descriptorBefore = structuredClone(descriptor);
  const cases = [
    {population: a, incremental: false},
    {population: b, incremental: false},
    {population: null, incremental: false},
    {population: a, incremental: true},
  ];
  let released = false;
  try {
    // Keep all four alive: a module-global sample cache would contaminate these.
    for (const entry of cases) {
      entry.calls = 0;
      entry.cosmos = createCosmos({...options, incremental: entry.incremental,
        stellarPopulation: entry.population ? d => {
          assert.equal(d.id, descriptor.id);
          entry.calls++;
          return entry.population;
        } : null});
      await publish(entry.cosmos, frame(), entry.incremental);
      entry.full = attributes(entry.cosmos);
      assert.deepEqual(entry.full.color, entry.population?.colors ?? sampleGalaxy(descriptor).colors);
      if (entry.population) assert.notEqual(entry.cosmos.children[0].geometry.attributes.color.array, entry.population.colors);
    }
    assert.notDeepEqual(cases[0].full.color, cases[1].full.color);
    assert.notDeepEqual(cases[0].full.color, cases[2].full.color);
    assert.deepEqual(cases[0].full, cases[3].full);
    assert.deepEqual(cases[0].full.position, cases[1].full.position);
    for (const entry of cases) {
      const {cosmos, incremental, full} = entry;
      const calls = entry.calls, attributesBefore = {...cosmos.children[0].geometry.attributes};
      for (let i = 0; i < 3; i++) cosmos.userData.update(frame());
      assert.equal(entry.calls, calls, 'warm frames do not resample population data');
      for (const name of Object.keys(attributesBefore)) assert.equal(cosmos.children[0].geometry.attributes[name], attributesBefore[name]);
      for (const quality of ['low', 'auto', 'high']) {
        await publish(cosmos, frame(origin, quality), incremental);
        const count = COSMOS_QUALITY_COUNTS[quality], actual = attributes(cosmos);
        assert.deepEqual(actual.color, full.color.slice(0, count * 3));
        assert.deepEqual(actual.position, full.position.slice(0, count * 3));
        assert.deepEqual(actual.pointRadius, full.pointRadius.slice(0, count));
      }
      // Renderer output is separate from both caller-owned data and cached templates.
      cosmos.children[0].geometry.attributes.color.array.fill(-1);
      await publish(cosmos, frame(away), incremental);
      const before = cosmos.userData.stats, callsBeforeRevisit = entry.calls;
      await publish(cosmos, frame(), incremental);
      assert.deepEqual(attributes(cosmos), full);
      assert.equal(entry.calls, callsBeforeRevisit);
      assert.equal(cosmos.userData.stats.sampleGenerations, before.sampleGenerations);
      assert.ok(cosmos.userData.stats.sampleCacheHits > before.sampleCacheHits);
    }
    assert.deepEqual(a.colors, aBefore);
    assert.deepEqual(b.colors, bBefore);
    assert.deepEqual(descriptor, descriptorBefore);
    // Releasing one instance cannot invalidate another instance's population/cache.
    cases[0].cosmos.userData.dispose();
    released = true;
    assert.equal(cases[0].cosmos.userData.stats.sampleCacheBytes, 0);
    assert.equal(cases[0].cosmos.userData.stats.sampleCacheEntries, 0);
    for (const entry of cases.slice(1)) {
      await publish(entry.cosmos, frame(away), entry.incremental);
      await publish(entry.cosmos, frame(), entry.incremental);
      assert.deepEqual(attributes(entry.cosmos), entry.full);
      assert.ok(entry.cosmos.userData.stats.sampleCacheBytes > 0);
    }
  } finally {
    const disposalChecks = [];
    for (let i = 0; i < cases.length; i++) {
      const cosmos = cases[i].cosmos;
      if (!cosmos) continue;
      if (i !== 0 || !released) {
        let geometryDisposals = 0, materialDisposals = 0;
        cosmos.children[0].geometry.addEventListener('dispose', () => geometryDisposals++);
        cosmos.children[0].material.addEventListener('dispose', () => materialDisposals++);
        cosmos.userData.dispose();
        disposalChecks.push({geometryDisposals, materialDisposals});
      }
    }
    // Finish releasing every instance before any cleanup assertion can fail.
    for (const {geometryDisposals, materialDisposals} of disposalChecks) {
      assert.equal(geometryDisposals, 1);
      assert.equal(materialDisposals, 1);
    }
    for (const {cosmos} of cases) {
      if (!cosmos) continue;
      assert.equal(cosmos.userData.stats.sampleCacheBytes, 0);
      assert.equal(cosmos.userData.stats.sampleCacheEntries, 0);
      assert.equal(cosmos.children.length, 0);
    }
  }
});

test('disposing an unstarted incremental population preparation rejects its waiter', async () => {
  const immutablePopulation = population(.4, .5, .6);
  let calls = 0;
  const cosmos = createCosmos({...options, incremental: true, stellarPopulation: () => {
    calls++;
    return immutablePopulation;
  }});
  try {
    const pending = cosmos.userData.prepare(frame());
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    cosmos.userData.dispose();
    await rejected;
    assert.equal(calls, 0, 'disposed scheduled work cannot consume the population');
    assert.equal(cosmos.userData.stats.sampleCacheBytes, 0);
    assert.equal(cosmos.userData.stats.sampleCacheEntries, 0);
    assert.equal(cosmos.children.length, 0);
  } finally { cosmos.userData.dispose(); }
});
