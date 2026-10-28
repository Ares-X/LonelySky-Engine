import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeCell} from '../../src/coordinates.js';
import {describeCosmicStructures, COSMIC_GRID_CELLS, COSMIC_VIEW_FAR} from '../../src/cosmic-structures.js';
import {createCosmos, createLegacyGalaxySampler, sampleGalaxy, loadedMacros, galaxyRelativeCenter, COSMOS_QUALITY_COUNTS} from '../../src/render/cosmos.js';

const tinyBudget = .000001;
const cellA = {x: 0, y: 0, z: 0}, cellB = {x: 64, y: 0, z: 0}, cellC = {x: 112, y: 0, z: 0};
const frame = (cell = cellA, quality = 'low') => ({sectorIndex: encodeCell(cell), cameraPosition: [4, 5, 6], quality});
function provider(coordinate) {
  if (coordinate.y || coordinate.z || ![-2, 0, 3, 4, 6, 7].includes(coordinate.x)) return null;
  return {id: `preparation:${coordinate.x}`, seed: `preparation:${coordinate.x}`, revision: 3, kind: 'galaxy',
    macroCell: coordinate, offset: [123, -456, 789], orientation: [.81, 1.21, -.37],
    morphology: 'spiral', radius: 71000, thickness: .07, arms: 3, pitch: .29, bar: true, asymmetry: .63};
}
const options = {seed: 'preparation-test', descriptorProvider: provider};
const make = () => createCosmos({...options, incremental: true, preparationBudgetMs: tinyBudget});
const bytes = cosmos => Object.fromEntries(Object.entries(cosmos.children[0].geometry.attributes).map(([name, attribute]) => [name, Buffer.from(attribute.array.buffer).toString('hex')]));
function drain(cosmos, target, limit = 5000) {
  let turns = 0;
  while (!cosmos.userData.isReady(target) && turns++ < limit) cosmos.userData.update(target);
  assert.ok(cosmos.userData.isReady(target), 'complete publication must eventually become ready');
  return turns;
}
function matchesSync(cosmos, target) {
  const sync = createCosmos(options);
  try { sync.userData.update(target); assert.deepEqual(bytes(cosmos), bytes(sync)); }
  finally { sync.userData.dispose(); }
}

test('resuming at arbitrary point boundaries preserves the complete legacy byte stream', () => {
  for (const revision of [2, 3]) for (const morphology of ['spiral', 'elliptical', 'irregular']) for (const kind of ['galaxy', 'cluster', 'nebula']) {
    const descriptor = {...provider(cellA), revision, morphology, kind, family: kind === 'cluster' ? 'open' : 'fixture'};
    const sampler = createLegacyGalaxySampler(descriptor, 257), steps = [1, 17, 3, 64, 11, 255];
    assert.throws(() => sampler.result, /not complete/);
    let n = 0;
    while (!sampler.complete) sampler.step(steps[n++ % steps.length]);
    assert.equal(sampler.cursor, 257);
    const expected = sampleGalaxy(descriptor, 257);
    for (const key of ['positions', 'colors', 'sizes']) assert.deepEqual(Buffer.from(sampler.result[key].buffer), Buffer.from(expected[key].buffer));
    sampler.step(1); assert.equal(sampler.cursor, 257);
  }
  const empty = createLegacyGalaxySampler(provider(cellA), 0);
  assert.ok(empty.complete); assert.equal(empty.result.positions.length, 0);
});

test('sampling completion alone is not readiness; full assembly publishes together and warm update retains attributes', () => {
  const cosmos = make(), target = frame();
  try {
    assert.equal(cosmos.userData.isReady(target), false);
    cosmos.userData.requestPopulation(target);
    let turns = 0;
    while (cosmos.userData.stats.preparationStage !== 'attributes' && turns++ < 2000) cosmos.userData.advancePreparation(tinyBudget);
    assert.equal(cosmos.userData.stats.preparationStage, 'attributes');
    assert.ok(cosmos.userData.stats.sampleGenerations > 0);
    assert.equal(cosmos.userData.isReady(target), false);
    assert.equal(cosmos.children[0].geometry.attributes.position, undefined, 'partial geometry never reaches the scene');
    drain(cosmos, target); matchesSync(cosmos, target);
    const attributes = {...cosmos.children[0].geometry.attributes}, before = cosmos.userData.stats;
    for (let i = 0; i < 30; i++) cosmos.userData.update(target);
    for (const key of Object.keys(attributes)) assert.equal(cosmos.children[0].geometry.attributes[key], attributes[key]);
    assert.deepEqual(cosmos.userData.stats, before);
    assert.equal(before.activeSampleBytes, before.structures * COSMOS_QUALITY_COUNTS.low * 7 * 4);
    assert.equal(before.activeGeometryBytes, before.activeSampleBytes);
    assert.equal(before.pendingSampleBytes + before.pendingGeometryBytes, 0);
  } finally { cosmos.userData.dispose(); }
});

test('an ahead request survives frames in the active macro and cannot publish before actual arrival', () => {
  const cosmos = make(), a = frame(), b = frame(cellB);
  try {
    drain(cosmos, a);
    const before = bytes(cosmos);
    cosmos.userData.requestPopulation(b);
    for (let i = 0; i < 10; i++) cosmos.userData.update(a);
    assert.notEqual(cosmos.userData.stats.preparationStage, 'idle', 'active frames must not cancel an explicit ahead request');
    cosmos.userData.advancePreparation(1000);
    assert.equal(cosmos.userData.stats.preparationStage, 'ready');
    cosmos.userData.update(a);
    assert.deepEqual(bytes(cosmos), before); assert.equal(cosmos.userData.isReady(b), false);
    cosmos.userData.update(b);
    assert.ok(cosmos.userData.isReady(b)); matchesSync(cosmos, b);
  } finally { cosmos.userData.dispose(); }
});

test('latest macro replaces unfinished work; cancellation cannot later publish the old macro', () => {
  const cosmos = make(), a = frame(), b = frame(cellB), c = frame(cellC);
  try {
    drain(cosmos, a); const before = bytes(cosmos);
    cosmos.userData.requestPopulation(b); cosmos.userData.advancePreparation(tinyBudget);
    cosmos.userData.requestPopulation(c); cosmos.userData.advancePreparation(tinyBudget);
    cosmos.userData.cancelPreparation();
    assert.deepEqual(bytes(cosmos), before);
    assert.equal(cosmos.userData.stats.pendingSampleBytes + cosmos.userData.stats.pendingGeometryBytes, 0);
    cosmos.userData.update(a); assert.deepEqual(bytes(cosmos), before);
    drain(cosmos, c); matchesSync(cosmos, c);
    assert.equal(cosmos.userData.isReady(b), false);
  } finally { cosmos.userData.dispose(); }
});

test('quality reversals retain the complete active count, weight and haze until latest tier is assembled', () => {
  const cosmos = make(), high = frame(cellA, 'high'), low = frame();
  try {
    drain(cosmos, high); const before = bytes(cosmos), points = cosmos.children[0], haze = cosmos.children[1];
    const hazeChildren = [...haze.children];
    cosmos.userData.update(low);
    assert.equal(cosmos.userData.isReady(low), false); assert.deepEqual(bytes(cosmos), before);
    assert.equal(points.material.uniforms.sampleWeight.value, .5);
    assert.equal(haze.children[0].material.uniforms.steps.value, 48);
    cosmos.userData.update(high);
    assert.equal(cosmos.userData.stats.preparationStage, 'idle'); assert.deepEqual(bytes(cosmos), before);
    drain(cosmos, low); matchesSync(cosmos, low);
    assert.equal(points.material.uniforms.sampleWeight.value, 4);
    assert.equal(haze.children[0].material.uniforms.steps.value, 16);
    assert.deepEqual(haze.children, hazeChildren, 'quality alone must not recreate haze');
    drain(cosmos, high); matchesSync(cosmos, high);
  } finally { cosmos.userData.dispose(); }
});

test('an origin change during position assembly recomputes from local samples without double Float32 rounding', () => {
  const cosmos = make(), target = frame(cellB, 'high'), shifted = frame({...cellB, x: cellB.x + 1}, 'high');
  try {
    cosmos.userData.requestPopulation(target);
    let turns = 0;
    while (cosmos.userData.stats.preparationStage !== 'positions' && turns++ < 3000) cosmos.userData.advancePreparation(tinyBudget);
    assert.equal(cosmos.userData.stats.preparationStage, 'positions');
    cosmos.userData.advancePreparation(tinyBudget);
    cosmos.userData.update(shifted);
    drain(cosmos, shifted); matchesSync(cosmos, shifted);
    const attributes = {...cosmos.children[0].geometry.attributes};
    cosmos.userData.update(target); matchesSync(cosmos, target);
    for (const name of Object.keys(attributes)) assert.equal(cosmos.children[0].geometry.attributes[name], attributes[name]);
  } finally { cosmos.userData.dispose(); }
});

test('prepare uses host tasks, shares same-target readiness and removes abort listeners on completion', async () => {
  const cosmos = createCosmos({...options, incremental: true, preparationBudgetMs: .05}), target = frame(cellA, 'high');
  const controller = new AbortController(); let timer, marker = false;
  try {
    const first = cosmos.userData.prepare(target, {signal: controller.signal});
    const second = cosmos.userData.prepare(target);
    timer = setTimeout(() => { marker = true; }, 0);
    await Promise.resolve(); assert.equal(cosmos.userData.isReady(target), false);
    await Promise.all([first, second]);
    assert.ok(marker, 'preparation must yield beyond the microtask queue');
    assert.ok(cosmos.userData.isReady(target)); matchesSync(cosmos, target);
    const before = cosmos.userData.stats;
    controller.abort(); await new Promise(resolve => setTimeout(resolve, 2));
    assert.deepEqual(cosmos.userData.stats, before, 'completed preparation no longer owns an abort listener');
  } finally { clearTimeout(timer); cosmos.userData.dispose(); }
});

test('superseding, aborting and disposing pending prepare settle promises and prevent late publication', async () => {
  const cosmos = make(), controller = new AbortController();
  try {
    drain(cosmos, frame(cellC));
    const geometry = cosmos.children[0].geometry;
    const superseded = cosmos.userData.prepare(frame());
    const oldRejection = assert.rejects(superseded, {name: 'AbortError'});
    cosmos.userData.requestPopulation(frame(cellB)); await oldRejection;
    const aborted = cosmos.userData.prepare(frame(cellB), {signal: controller.signal});
    const abortRejection = assert.rejects(aborted, {name: 'AbortError'});
    controller.abort(); await abortRejection;
    for (const reason of [false, 0, null]) {
      const exactAbort = new AbortController();
      const promise = cosmos.userData.prepare(frame(cellB), {signal: exactAbort.signal});
      const rejection = promise.then(() => assert.fail('Cancellation must not resolve as success'), error => assert.equal(error, reason));
      exactAbort.abort(reason); await rejection;
    }
    const disposed = cosmos.userData.prepare(frame(cellB));
    const disposeRejection = assert.rejects(disposed, {name: 'AbortError'});
    cosmos.userData.dispose(); await disposeRejection;
    const before = cosmos.userData.stats;
    await new Promise(resolve => setTimeout(resolve, 3));
    cosmos.userData.update(frame()); cosmos.userData.advancePreparation(1);
    assert.deepEqual(cosmos.userData.stats, before);
    assert.equal(before.activeGeometryBytes + before.activeSampleBytes + before.pendingGeometryBytes + before.pendingSampleBytes + before.sampleCacheBytes, 0);
    assert.equal(cosmos.children.length, 0);
    assert.equal(Object.keys(geometry.attributes).length, 0, 'disposed scene retains no active CPU attribute arrays');
    await assert.rejects(cosmos.userData.prepare(frame()), /disposed/);
  } finally { cosmos.userData.dispose(); }
});

test('mutable custom providers never reuse cancelled or previously displayed ID samples', () => {
  let radius = 200;
  const mutable = coordinate => coordinate.x || coordinate.y || coordinate.z ? null : {...provider(coordinate), radius};
  const cosmos = createCosmos({descriptorProvider: mutable, incremental: true, preparationBudgetMs: tinyBudget});
  try {
    drain(cosmos, frame()); const before = bytes(cosmos);
    drain(cosmos, frame({x: 16, y: 0, z: 0}));
    radius = 900; drain(cosmos, frame());
    assert.notDeepEqual(bytes(cosmos), before);
    assert.equal(cosmos.userData.stats.sampleCacheEntries, 0);
    const sync = createCosmos({descriptorProvider: mutable});
    try { sync.userData.update(frame()); assert.deepEqual(bytes(cosmos), bytes(sync)); }
    finally { sync.userData.dispose(); }
  } finally { cosmos.userData.dispose(); }
});

test('a failed preparation retains its original error without retrying on every frame', async () => {
  const cause = new Error('descriptor rotation failed'); let attempts = 0;
  const broken = coordinate => {
    if (coordinate.x || coordinate.y || coordinate.z) return null;
    const descriptor = provider(coordinate);
    Object.defineProperty(descriptor, 'orientation', {get() { attempts++; throw cause; }});
    return descriptor;
  };
  const cosmos = createCosmos({descriptorProvider: broken, incremental: true});
  try {
    await assert.rejects(cosmos.userData.prepare(frame()), error => error === cause);
    assert.equal(attempts, 1);
    assert.throws(() => cosmos.userData.update(frame()), error => error === cause);
    assert.throws(() => cosmos.userData.update(frame()), error => error === cause);
    assert.equal(attempts, 1, 'only an explicit new request may retry failed sampling');
    assert.equal(cosmos.userData.stats.pendingSampleBytes + cosmos.userData.stats.pendingGeometryBytes, 0);
  } finally { cosmos.userData.dispose(); }
});

test('ordinary V3 face, corner and torus crossings keep the changing supports invisible until exact publication', async () => {
  const raw = {seed: 'preparation-support', descriptorProvider: describeCosmicStructures, gridCells: COSMIC_GRID_CELLS, structures: true};
  const crossings = [
    [{x: 4095, y: 0, z: 0}, {x: 4096, y: 0, z: 0}],
    [{x: 4095, y: 4095, z: 4095}, {x: 4096, y: 4096, z: 4096}],
    [{x: 16383, y: 16383, z: 16383}, {x: -16384, y: -16384, z: -16384}],
  ];
  for (const [before, after] of crossings) {
    const cosmos = createCosmos({...raw, incremental: true, preparationBudgetMs: .1}), target = frame(after, 'high');
    const previous = loadedMacros(encodeCell(before), raw.seed, raw), next = loadedMacros(target.sectorIndex, raw.seed, raw);
    const differences = previous.filter(a => !next.some(b => b.id === a.id)).concat(next.filter(a => !previous.some(b => b.id === a.id)));
    try {
      await cosmos.userData.prepare(frame(before, 'high'));
      cosmos.userData.requestPopulation(target);
      let turns = 0;
      do {
        // Bounded synthetic camera movement, not a claim about arbitrary solo
        // velocities or the unexercised real browser/natural-voyage workflow.
        target.cameraPosition[0] = 10 + turns * 10;
        for (const descriptor of differences) {
          const center = galaxyRelativeCenter(descriptor, after, COSMIC_GRID_CELLS);
          const supportDistance = Math.hypot(...center.map((n, axis) => n - target.cameraPosition[axis])) - descriptor.radius;
          assert.ok(supportDistance > COSMIC_VIEW_FAR, 'changed population remains fully faded before publication');
        }
        cosmos.userData.update(target);
      } while (!cosmos.userData.isReady(target) && ++turns < 3000);
      assert.ok(cosmos.userData.isReady(target));
      const sync = createCosmos(raw);
      try { sync.userData.update(target); assert.deepEqual(bytes(cosmos), bytes(sync)); }
      finally { sync.userData.dispose(); }
      assert.ok(cosmos.userData.stats.sampleCacheBytes <= cosmos.userData.stats.sampleCacheLimit);
    } finally { cosmos.userData.dispose(); }
  }
});


test('legacy custom providers retain their valid 125-descriptor batch without a canonical support cap', async () => {
  const everyMacro = coordinate => ({...provider(cellA), id: `legacy:${coordinate.x},${coordinate.y},${coordinate.z}`, macroCell: coordinate});
  const uncapped = {descriptorProvider: everyMacro};
  const sync = createCosmos(uncapped), incremental = createCosmos({...uncapped, incremental: true, preparationBudgetMs: .25});
  const target = frame();
  try {
    sync.userData.update(target);
    await incremental.userData.prepare(target);
    assert.equal(sync.userData.stats.structures, 125);
    assert.equal(incremental.userData.stats.structures, 125);
    assert.equal(incremental.children[0].geometry.attributes.position.count, 125 * COSMOS_QUALITY_COUNTS.low);
    assert.deepEqual(bytes(incremental), bytes(sync));
    assert.equal(incremental.userData.stats.sampleCacheEntries, 0);
  } finally { sync.userData.dispose(); incremental.userData.dispose(); }
});


test('default synchronous providers may repair a failed sample and succeed on the next update', () => {
  let repaired = false;
  const cause = new Error('descriptor rotation failed');
  const mutable = coordinate => {
    if (coordinate.x || coordinate.y || coordinate.z) return null;
    const descriptor = provider(coordinate);
    Object.defineProperty(descriptor, 'orientation', {get() { if (!repaired) throw cause; return [.81, 1.21, -.37]; }});
    return descriptor;
  };
  const cosmos = createCosmos({descriptorProvider: mutable}), target = frame();
  try {
    assert.throws(() => cosmos.userData.update(target), error => error === cause);
    repaired = true;
    cosmos.userData.update(target);
    assert.ok(cosmos.userData.isReady(target));
    assert.equal(cosmos.userData.stats.sampleGenerations, 1);
    assert.equal(cosmos.children[0].geometry.attributes.position.count, COSMOS_QUALITY_COUNTS.low);
  } finally { cosmos.userData.dispose(); }
});
