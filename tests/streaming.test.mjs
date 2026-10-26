import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL_SIZE, decodeCell, encodeCell } from '../src/coordinates.js';
import { createUniverse } from '../src/generator.js';
const { getSector } = createUniverse({ density: 1 });
import { STREAM_RADIUS, VIEW_FAR, FADE_START, visibilityAtDistance, loadedCells } from '../src/streaming.js';

test('distance visibility is bounded, continuous and monotonic through its fade interval', () => {
  assert.ok(FADE_START < VIEW_FAR);
  assert.equal(visibilityAtDistance(0), 1);
  assert.equal(visibilityAtDistance(FADE_START), 1);
  assert.equal(visibilityAtDistance(VIEW_FAR), 0);
  assert.equal(visibilityAtDistance(Infinity), 0);
  let previous = 1;
  for (let i = 0; i <= 10000; i += 1) {
    const distance = VIEW_FAR * 1.5 * i / 10000;
    const visibility = visibilityAtDistance(distance);
    assert.ok(visibility >= 0 && visibility <= 1);
    assert.ok(visibility <= previous);
    assert.ok(previous - visibility < 0.001);
    previous = visibility;
  }
  for (const boundary of [FADE_START, VIEW_FAR]) {
    assert.ok(Math.abs(visibilityAtDistance(boundary - 0.01) - visibilityAtDistance(boundary + 0.01)) < 1e-8);
  }
});

test('streamed cells have unique addresses and offsets consistent with the floating origin', () => {
  assert.equal(STREAM_RADIUS, 2);
  for (const centre of [{ x: 0, y: 0, z: 0 }, { x: -23, y: 14, z: -9 }]) {
    const cells = loadedCells(encodeCell(centre));
    assert.equal(cells.length, 125);
    assert.equal(new Set(cells.map((cell) => cell.index)).size, cells.length);
    for (const entry of cells) {
      const actual = decodeCell(entry.index);
      assert.deepEqual(entry.offset, ['x', 'y', 'z'].map((axis) => (actual[axis] - centre[axis]) * CELL_SIZE));
      assert.ok(entry.offset.every((offset) => Math.abs(offset) <= STREAM_RADIUS * CELL_SIZE));
    }
  }
  for (const corner of [-16384, 16383]) {
    const cells = loadedCells(encodeCell({ x: corner, y: corner, z: corner }));
    assert.equal(cells.length, 125);
    assert.equal(new Set(cells.map((cell) => cell.index)).size, cells.length);
    for (const entry of cells) {
      const actual = decodeCell(entry.index);
      for (const [k, axis] of ['x', 'y', 'z'].entries()) {
        assert.equal(((actual[axis] - corner - entry.offset[k] / CELL_SIZE) % 32768 + 32768) % 32768, 0);
        assert.ok(Math.abs(entry.offset[k]) <= STREAM_RADIUS * CELL_SIZE);
      }
    }
  }
});

test('real bodies enter and leave the stream beyond visibility along both directions of every axis', () => {
  const axes = ['x', 'y', 'z'];
  const sectors = new Map();
  const sector = (index) => {
    if (!sectors.has(index)) sectors.set(index, getSector(index));
    return sectors.get(index);
  };
  const samples = [];
  for (const axis of axes) for (const sign of [-1, 1]) {
    for (const base of [{ x: 0, y: 0, z: 0 }, { x: 12, y: -9, z: 17 }, { x: -24, y: 19, z: -11 }]) samples.push({ base, axis, sign });
    // Exercise the initial sector and nearby addresses entering and leaving.
    for (let index = 0; index < 4; index += 1) {
      const target = decodeCell(index);
      samples.push({ base: { ...target, [axis]: target[axis] - sign * 3 }, axis, sign });
      samples.push({ base: { ...target, [axis]: target[axis] + sign * 2 }, axis, sign });
    }
    samples.push({ base: { x: 0, y: 1, z: 0, [axis]: sign > 0 ? 16383 : -16384 }, axis, sign });
  }
  const initialChanged = new Set();
  let checkedBodies = 0;
  for (const { base, axis, sign } of samples) {
    const next = { ...base, [axis]: base[axis] + sign };
    if (next[axis] > 16383) next[axis] = -16384;
    if (next[axis] < -16384) next[axis] = 16383;
    const before = new Map(loadedCells(encodeCell(base)).map((entry) => [entry.index, entry]));
    const after = new Map(loadedCells(encodeCell(next)).map((entry) => [entry.index, entry]));
    assert.equal(before.size, 125);
    assert.equal(after.size, 125);
    assert.equal([...before.keys()].filter((index) => after.has(index)).length, 100);
    const changed = [...before.keys()].filter((index) => !after.has(index)).concat([...after.keys()].filter((index) => !before.has(index)));
    const transverse = axes.filter((name) => name !== axis);
    for (const index of changed) {
      if (index < 4) initialChanged.add(index);
      const data = sector(index);
      const bodies = [...data.planets, ...data.stars, ...(data.blackHole ? [data.blackHole] : [])];
      for (const body of bodies) for (const sideA of [-0.49, 0, 0.49]) for (const sideB of [-0.49, 0, 0.49]) {
        const camera = { x: 0, y: 0, z: 0 };
        camera[axis] = (before.has(index) ? sign : -sign) * CELL_SIZE / 2;
        camera[transverse[0]] = sideA * CELL_SIZE;
        camera[transverse[1]] = sideB * CELL_SIZE;
        const entry = before.get(index) ?? after.get(index);
        const distance = Math.hypot(...axes.map((name, k) => body.position[k] + entry.offset[k] - camera[name]));
        assert.ok(distance > VIEW_FAR, `${index} ${axis} ${sign}: body ${distance} entered/left inside ${VIEW_FAR}`);
        assert.equal(visibilityAtDistance(distance), 0);
        checkedBodies += 1;
      }
    }
  }
  assert.deepEqual([...initialChanged].sort(), [0, 1, 2, 3]);
  assert.ok(checkedBodies > 1000);
});

test('real bodies retain camera-relative positions across positive and negative grid edges', () => {
  const axes = ['x', 'y', 'z'];
  let checkedBodies = 0;
  for (const axis of axes) for (const sign of [-1, 1]) {
    const base = { x: 0, y: 1, z: 0, [axis]: sign > 0 ? 16383 : -16384 };
    const next = { ...base, [axis]: sign > 0 ? -16384 : 16383 };
    const before = loadedCells(encodeCell(base));
    const after = new Map(loadedCells(encodeCell(next)).map((entry) => [entry.index, entry]));
    for (const entry of before) {
      const retained = after.get(entry.index);
      if (!retained) continue;
      const data = getSector(entry.index);
      for (const body of [...data.planets, ...data.stars, ...(data.blackHole ? [data.blackHole] : [])]) {
        const relativeBefore = axes.map((name, k) => body.position[k] + entry.offset[k] - (name === axis ? sign * CELL_SIZE / 2 : 0));
        const relativeAfter = axes.map((name, k) => body.position[k] + retained.offset[k] - (name === axis ? -sign * CELL_SIZE / 2 : 0));
        relativeBefore.forEach((value, k) => assert.ok(Math.abs(value - relativeAfter[k]) < 1e-8));
        assert.ok(Math.abs(visibilityAtDistance(Math.hypot(...relativeBefore)) - visibilityAtDistance(Math.hypot(...relativeAfter))) < 1e-12);
        checkedBodies += 1;
      }
    }
  }
  assert.ok(checkedBodies > 100);
});


test('invalid addresses fail and invalid distances cannot introduce NaNs', () => {
  for (const value of [-1, 2 ** 45, NaN, Infinity, .5, '0', null]) assert.throws(() => loadedCells(value), RangeError);
  for (const value of [NaN, undefined, null, '12', {}]) assert.equal(visibilityAtDistance(value), 0);
  assert.equal(visibilityAtDistance(30500), .5);
});
