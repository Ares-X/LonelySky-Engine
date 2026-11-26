import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeMacro, sampleGalaxy, COSMOS_QUALITY_COUNTS } from '../../src/render/cosmos.js';
import {createOpenClusterProfile,createGalaxyHaze} from '../../src/render/galaxy-haze.js';

const base = Object.freeze({ seed: 'volume-contract', revision: 3, kind: 'cluster', family: 'open',
  morphology: 'irregular', radius: 6500000, thickness: .8,
  orientation: Object.freeze([.27, 1.1, -.64]), asymmetry: .37, arms: 3, pitch: .31, bar: false });
const appearanceHashes = [
  ['volume-contract', '7e1e76e51d93b63ab1ade345b9eea88df56feec351c1f623bf6ce5e6dc58f478'],
  ['volume-contract-1', '20f9ba6fac9e4a9b8d6a2566e61e5ea1c7b752b4d7aa85fdfd21a7e8ba87456d'],
  ['volume-contract-2', 'd7cf87872a8836674f9929b3de925226bad05c8c00cbf360be7072b380107714'],
];
const digest = (...arrays) => {
  const hash = createHash('sha256');
  for (const array of arrays) hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
};

test('open clusters retain a bounded 3D population without a dense support shell', () => {
  for (const [seed] of appearanceHashes) {
    const descriptor = Object.freeze({ ...base, seed }), before = structuredClone(descriptor);
    const { positions, sizes } = sampleGalaxy(descriptor), count = sizes.length;
    const mean = [0, 0, 0], second = Array.from({ length: 3 }, () => [0, 0, 0]), outerBins = new Map();
    for (let i = 0; i < count; i++) {
      const p = Array.from(positions.subarray(i * 3, i * 3 + 3), n => n / descriptor.radius);
      const r = Math.hypot(...p);
      assert.ok(Number.isFinite(r) && r <= .980001, 'every tracer remains inside the declared support');
      if (r > .85) { const bin = Math.floor(r * 100); outerBins.set(bin, (outerBins.get(bin) ?? 0) + 1); }
      for (let a = 0; a < 3; a++) {
        mean[a] += p[a] / count;
        for (let b = 0; b < 3; b++) second[a][b] += p[a] * p[b] / count;
      }
    }
    assert.ok(Math.max(0, ...outerBins.values()) < count * .04, 'outer particles must not pile onto one radius');
    const c = second.map((row, a) => row.map((n, b) => n - mean[a] * mean[b]));
    const determinant = c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1])
      - c[0][1] * (c[1][0] * c[2][2] - c[1][2] * c[2][0])
      + c[0][2] * (c[1][0] * c[2][1] - c[1][1] * c[2][0]);
    assert.ok(determinant > 1e-5, 'removing the shell must retain volume rather than collapse to a plane');
    assert.deepEqual(descriptor, before);
  }
});

test('V3 open-cluster representation has stable appearance bytes and exact 16k quality prefixes', () => {
  for (const [seed, appearanceHash] of appearanceHashes) {
    const descriptor = { ...base, seed }, full = sampleGalaxy(descriptor,16384);
    // Only these V3 open fixtures adopt the new shared association stream.
    // The recorded 4k appearance leaf remains separate from tier-prefix checks.
    assert.equal(digest(full.colors.subarray(0,4096*3),full.sizes.subarray(0,4096)),appearanceHash);
    assert.deepEqual(sampleGalaxy(descriptor,16384),full);
    for (const count of [0, ...Object.values(COSMOS_QUALITY_COUNTS),16384]) {
      const prefix = sampleGalaxy(descriptor, count);
      assert.deepEqual(prefix.positions, full.positions.slice(0, count * 3));
      assert.deepEqual(prefix.colors, full.colors.slice(0, count * 3));
      assert.deepEqual(prefix.sizes, full.sizes.slice(0, count));
    }
  }
});

test('published legacy morphologies retain their immutable particle bytes', () => {
  const fixtures = [
    ['elliptical', { x: -8, y: -8, z: -8 }, 'e6827811d5845a770b0960e434e6ed12a9e8743d3ac6ac79ad507ecb46519936'],
    ['irregular', { x: -8, y: -8, z: -1 }, '413a2ac87235c2bbd3e5aeea34a1115686737f64e0ba862f579c1c1ca7664f25'],
    ['spiral', { x: -8, y: -5, z: 7 }, '6178989a1885a682337e20cb57d66a170b5eaf1d728d4ea233eb469fd147722e'],
  ];
  for (const [morphology, coordinate, expected] of fixtures) {
    const descriptor = describeMacro(coordinate, 'sampler-legacy-contract');
    assert.equal(descriptor.morphology, morphology);
    const sample = sampleGalaxy(descriptor, 128);
    assert.equal(digest(sample.positions, sample.colors, sample.sizes), expected);
  }
});

test('other revisions and structure families retain their existing samples', () => {
  const fixtures = [
    [{ revision: 2 }, '2930cd67932552395619bc8985c731e1b889704a54132edf6299fb7e8ea35ff6'],
    [{ kind: 'galaxy' }, 'c97f0dd64c622af97354fd0a854e5f062df16a9002ce5ff9b951f16d4648b6bd'],
    [{ family: 'globular' }, 'f8bc2e41a34c0b2fbc0e29c20ad93251d800552e44008d1da73c82fcbca3b77c'],
    [{ morphology: 'elliptical' }, '4affaded5d32827869566a4ed0740f0caee1f7b31bdb928b51fcc6730e1ad061'],
  ];
  for (const [change, expected] of fixtures) {
    const sample = sampleGalaxy({ ...base, ...change }, 128);
    assert.equal(digest(sample.positions, sample.colors, sample.sizes), expected);
  }
});

test('open-cluster identities vary unequal associations while visits and parent-family structure stay deterministic',()=>{
  const profiles=new Set(),counts=new Set();
  for(let i=0;i<128;i++){
    const descriptor={...base,id:`association:${i}`,seed:'shared-seed',childAppearance:{family:'barred-spiral'}},profile=createOpenClusterProfile(descriptor);
    createOpenClusterProfile({...descriptor,id:'unrelated'});
    assert.deepEqual(createOpenClusterProfile(descriptor),profile);
    assert.ok(Object.isFrozen(profile.nodes));assert.ok(Object.isFrozen(profile.nodes[0].center));
    assert.ok(profile.nodes.length>=4&&profile.nodes.length<=8);counts.add(profile.nodes.length);
    assert.ok(new Set(profile.nodes.map(node=>node.width)).size>1);
    assert.equal(profile.cdf.at(-1),1);profiles.add(JSON.stringify(profile));
  }
  assert.equal(profiles.size,128);assert.deepEqual([...counts].sort(),[4,5,6,7,8]);
  const a=createOpenClusterProfile({...base,id:'parent-shape',childAppearance:{family:'barred-spiral'}});
  const b=createOpenClusterProfile({...base,id:'parent-shape',childAppearance:{family:'ancient-halo'}});
  assert.notDeepEqual(a.nodes.map(node=>node.center),b.nodes.map(node=>node.center));
  assert.equal(createOpenClusterProfile({...base,family:'globular'}),null);
});

test('open-cluster point and diffuse representations consume the same immutable association geometry',()=>{
  const descriptor={...base,id:'shared-associations',stellarTint:[1,1,1],childAppearance:{family:'barred-spiral'}},profile=createOpenClusterProfile(descriptor);
  const haze=createGalaxyHaze({structures:true});
  try{
    haze.userData.setDescriptors([descriptor]);
    const uniforms=haze.children[0].material.uniforms;
    assert.equal(uniforms.openClusterCount.value,profile.nodes.length);
    assert.deepEqual(uniforms.openClusterHaloAxes.value.toArray(),profile.haloAxes);
    assert.equal(uniforms.openClusterHaloFraction.value,profile.haloFraction);
    for(let i=0;i<profile.nodes.length;i++){
      const node=profile.nodes[i];
      assert.deepEqual(uniforms.openClusterCenters.value[i].toArray(),[...node.center,node.width]);
      assert.deepEqual(uniforms.openClusterAxes.value[i].toArray(),[...node.axis,node.long]);
      assert.ok(Math.abs(uniforms.openClusterMasses.value[i]-(profile.cdf[i]-(profile.cdf[i-1]??0)))<1e-7);
    }
    assert.ok(Math.abs(uniforms.openClusterMasses.value.reduce((sum,mass)=>sum+mass,0)-1)<1e-7);
    // The sampler's observable first moment must follow these association
    // centers, not just upload correct-looking uniforms beside unrelated points.
    const sample=sampleGalaxy({...descriptor,orientation:[0,0,0]},16384),actual=[0,0,0],expected=[0,0,0];
    for(let i=0;i<sample.sizes.length;i++)for(let axis=0;axis<3;axis++)actual[axis]+=sample.positions[i*3+axis]/descriptor.radius/sample.sizes.length;
    for(let i=0;i<profile.nodes.length;i++){
      const mass=profile.cdf[i]-(profile.cdf[i-1]??0);
      for(let axis=0;axis<3;axis++)expected[axis]+=(1-profile.haloFraction)*mass*profile.nodes[i].center[axis];
    }
    for(let axis=0;axis<3;axis++)assert.ok(Math.abs(actual[axis]-expected[axis])<.025,'sampled stars follow the shared mixture within sampling and bounded-tail error');
  }finally{haze.userData.dispose();}
});
