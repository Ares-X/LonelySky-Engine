import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectionalStars} from '../../src/render/directional-stars.js';

test('directional sources retain their typed buffers and release exactly their own GPU resources', () => {
  const input = {positions: new Float32Array([0, 0, -1]), colors: new Float32Array([1, .8, .6]),
    flux: new Float32Array([.5]), magnitudes: new Float32Array([6]), ranks: new Float32Array([.1])};
  const stars = createDirectionalStars(input);
  assert.equal(stars.geometry.attributes.position.array, input.positions);
  assert.equal(stars.geometry.attributes.stellarFlux.array, input.flux);
  assert.equal(stars.userData.stats.candidates, 1);
  assert.equal(stars.material.depthTest, true); assert.equal(stars.material.depthWrite, false);
  let geometry = 0, material = 0;
  stars.geometry.addEventListener('dispose', () => geometry++);
  stars.material.addEventListener('dispose', () => material++);
  stars.userData.dispose(); stars.userData.dispose();
  assert.equal(geometry, 1); assert.equal(material, 1);
});

test('attribute-count mismatch fails before creating partial GPU resources', () => {
  assert.throws(() => createDirectionalStars({positions: new Float32Array(0), colors: new Float32Array(0),
    flux: new Float32Array(1), magnitudes: new Float32Array(1), ranks: new Float32Array(1)}), /matching lengths/);
});
