import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CELL_SIZE, MAX_SECTOR, encodeCell, decodeCell, wrapCell, hashSeed, randomFromSeed } from '../src/index.js';

test('signed Morton addresses preserve their bit layout and round trip all boundaries', () => {
  assert.equal(CELL_SIZE, 20000);
  assert.equal(MAX_SECTOR, 2 ** 45 - 1);
  for (const [cell, address] of [
    [{ x: 0, y: 0, z: 0 }, 0], [{ x: -1, y: 0, z: 0 }, 1],
    [{ x: 1, y: 0, z: 0 }, 8], [{ x: 0, y: 1, z: 0 }, 16],
    [{ x: 0, y: 0, z: 1 }, 32], [{ x: -16384, y: -16384, z: -16384 }, MAX_SECTOR],
  ]) {
    assert.equal(encodeCell(cell), address);
    assert.deepEqual(decodeCell(address), cell);
  }
  const random = randomFromSeed('coordinates'), seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const cell = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.floor(random() * 32768) - 16384]));
    const address = encodeCell(cell);
    assert.deepEqual(decodeCell(address), cell);
    assert.ok(!seen.has(address)); seen.add(address);
  }
  assert.equal(wrapCell(16384), -16384);
  assert.equal(wrapCell(-16385), 16383);
  assert.equal(wrapCell(32768 * 3 + 19), 19);
});

test('invalid addresses and random seeds fail at the boundary', () => {
  for (const index of [-1, .5, NaN, Infinity, MAX_SECTOR + 1, '0', null]) assert.throws(() => decodeCell(index), RangeError);
  for (const axis of ['x', 'y', 'z']) {
    for (const value of [-16385, 16384, .5, NaN, Infinity, undefined, null, false, '1', {}]) {
      assert.throws(() => encodeCell({ x: 0, y: 0, z: 0, [axis]: value }), RangeError);
    }
  }
  assert.throws(() => hashSeed(123), TypeError);
  for (const seed of [-1, .5, NaN, Infinity, {}, 4294967296]) assert.throws(() => randomFromSeed(seed), TypeError);
});

test('published 45-bit addresses remain stable across full-range signed coordinates', () => {
  const edges = [-16384, -1, 0, 1, 16383];
  for (const x of edges) for (const y of edges) for (const z of edges) {
    assert.deepEqual(decodeCell(encodeCell({ x, y, z })), { x, y, z });
  }
  const random = randomFromSeed('morton-scalar-contract-v1'), hash = createHash('sha256');
  for (let i = 0; i < 10000; i++) {
    const cell = { x: Math.floor(random() * 32768) - 16384,
      y: Math.floor(random() * 32768) - 16384, z: Math.floor(random() * 32768) - 16384 };
    const address = encodeCell(cell);
    assert.ok(Number.isSafeInteger(address) && address >= 0 && address <= MAX_SECTOR);
    assert.deepEqual(decodeCell(address), cell);
    hash.update(`${address}\n`);
  }
  // Frozen from the public engine 6cb442f, so mutually changed encode/decode
  // implementations cannot silently remap saved worlds while roundtripping.
  assert.equal(hash.digest('hex'), '1b985540fec3ae5b275ef2c41e8377110d56f0b056987883f42c631ab9025813');
});

test('FNV hash and random streams are deterministic and independent of global state', () => {
  assert.equal(hashSeed('hello'), 1335831723);
  const a = randomFromSeed('hello'), b = randomFromSeed(hashSeed('hello'));
  const unrelated = randomFromSeed('other');
  for (let i = 0; i < 100; i++) {
    unrelated(); unrelated();
    const value = a();
    assert.equal(value, b()); assert.ok(value >= 0 && value < 1);
  }
  const zero = randomFromSeed(0);
  assert.deepEqual(Array.from({ length: 5 }, zero), [
    0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
    0.1462021479383111, 0.46732782293111086,
  ]);
});
