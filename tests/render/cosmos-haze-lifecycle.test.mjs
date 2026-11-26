import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCell, wrapCell } from '../../src/coordinates.js';
import { createCosmos } from '../../src/render/cosmos.js';

const gridCells = 16;
const frame = (x, y = 0, z = 0, quality = 'low') => ({
  sectorIndex: encodeCell({ x, y, z }), cameraPosition: [4, 5, 6], quality,
});

function createFixture({ macroCell = { x: 2, y: 1, z: 1 }, structures = true,
  immutable = true, incremental = false } = {}) {
  const batch = ['galaxy', 'nebula'].map((kind, index) => Object.freeze({
    id: kind, seed: kind, kind, revision: 3, macroCell,
    offset: [123 + 42000 * index, -456, 789], orientation: [.81, 1.21, -.37],
    morphology: index ? 'irregular' : 'spiral', radius: 71000, thickness: .07,
    arms: 3, pitch: .29, bar: true, asymmetry: .63,
  }));
  const descriptorProvider = coordinate => ['x', 'y', 'z'].every(
    axis => wrapCell(coordinate[axis] * gridCells) === macroCell[axis] * gridCells,
  ) ? batch : null;
  return createCosmos({
    descriptorProvider, structures, incremental, gridCells, preparationBudgetMs: .000001,
    catalogue: { capacity: 4, supportFade: true, immutable },
  });
}

function disposalCount(resource) {
  let count = 0;
  resource.addEventListener('dispose', () => count++);
  return () => count;
}

function observeBatch(haze) {
  assert.deepEqual(haze.children.map(mesh => mesh.name), ['galaxy', 'nebula']);
  const materials = haze.children.map(mesh => mesh.material);
  return { materials, disposals: materials.map(disposalCount) };
}

function assertBatch(haze, previous, retained) {
  assert.deepEqual(haze.children.map(mesh => mesh.name), ['galaxy', 'nebula']);
  for (let index = 0; index < previous.materials.length; index++) {
    assert.equal(haze.children[index].material === previous.materials[index], retained);
    assert.equal(previous.disposals[index](), retained ? 0 : 1);
  }
}

test('warm haze materials survive updates within a macro, including quality changes, and neighbouring macros', () => {
  const routes = [
    { macroCell: { x: 2, y: 1, z: 1 }, frames: [frame(0), frame(1, 0, 0, 'auto'), frame(16), frame(32, 16, 16)] },
    { macroCell: { x: -1024, y: 1, z: 1 }, frames: [frame(16383, 15, 15), frame(-16384, 16, 16)] },
  ];
  for (const { macroCell, frames } of routes) {
    const cosmos = createFixture({ macroCell });
    try {
      cosmos.userData.update(frames[0]);
      const haze = cosmos.children[1], before = observeBatch(haze);
      for (const next of frames.slice(1)) {
        cosmos.userData.update(next);
        assertBatch(haze, before, true);
      }
      cosmos.userData.dispose();
      assert.deepEqual(before.disposals.map(count => count()), [1, 1]);
    } finally { cosmos.userData.dispose(); }
  }
});

test('a distant publication retires each structured immutable haze material once and keeps shared geometry', () => {
  const cases = [
    { structures: true, immutable: true, retire: true, start: frame(32, 16, 16), finish: frame(64, 16, 16) },
    { structures: true, immutable: false, retire: false, start: frame(32, 16, 16), finish: frame(64, 16, 16) },
    { structures: false, immutable: true, retire: false, start: frame(32, 16, 16), finish: frame(64, 16, 16) },
    { structures: true, immutable: true, retire: true, macroCell: { x: -1024, y: 1, z: 1 },
      start: frame(16383, 16, 16), finish: frame(-16368, 16, 16) },
  ];
  for (const { structures, immutable, retire, macroCell, start, finish } of cases) {
    const cosmos = createFixture({ structures, immutable, macroCell });
    try {
      cosmos.userData.update(start);
      const haze = cosmos.children[1], before = observeBatch(haze);
      const geometry = haze.children[0].geometry, geometryDisposals = disposalCount(geometry);
      cosmos.userData.update(finish);
      assertBatch(haze, before, !retire);
      assert.ok(haze.children.every(mesh => mesh.geometry === geometry));
      assert.equal(geometryDisposals(), 0);

      const after = observeBatch(haze);
      cosmos.userData.update({ ...finish, quiet: .5, quality: 'high' });
      assertBatch(haze, after, true);
      cosmos.userData.dispose();
      cosmos.userData.dispose();
      assert.deepEqual(before.disposals.map(count => count()), [1, 1]);
      assert.deepEqual(after.disposals.map(count => count()), [1, 1]);
      assert.equal(geometryDisposals(), 1);
    } finally { cosmos.userData.dispose(); }
  }
});

test('unpublished or cancelled preparation does not retire the active haze or change the next crossing', () => {
  const cosmos = createFixture({ incremental: true }), { userData } = cosmos;
  const origin = frame(0), adjacent = frame(16), jump = frame(64, 16, 16, 'high');
  function stage(target) {
    userData.requestPopulation(target);
    userData.advancePreparation(1000);
    assert.equal(userData.stats.preparationStage, 'ready');
  }
  try {
    stage(origin);
    userData.update(origin);
    const haze = cosmos.children[1], before = observeBatch(haze);
    userData.update(jump);
    assert.equal(userData.isReady(jump), false);
    assertBatch(haze, before, true);
    userData.cancelPreparation();

    stage(adjacent);
    userData.update(adjacent);
    assertBatch(haze, before, true);
    stage(jump);
    userData.update(adjacent);
    assertBatch(haze, before, true);
    userData.cancelPreparation();
    assert.equal(userData.stats.preparationStage, 'idle');

    stage(jump);
    userData.update(jump);
    assert.equal(userData.isReady(jump), true);
    assertBatch(haze, before, false);
  } finally { cosmos.userData.dispose(); }
});
