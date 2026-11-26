import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectionalStars} from '../../src/render/directional-stars.js';
import {DISTANT_SKY_FIELD_GLSL} from '../../src/render/distant-sky-field.js';

test('directional sources retain their typed buffers and release exactly their own GPU resources', () => {
  const input = {positions: new Float32Array([0, 0, -1]), colors: new Float32Array([1, .8, .6]),
    flux: new Float32Array([.5]), magnitudes: new Float32Array([6]), ranks: new Float32Array([.1])};
  const stars = createDirectionalStars(input);
  assert.equal(stars.geometry.attributes.position.array, input.positions);
  assert.equal(stars.geometry.attributes.stellarFlux.array, input.flux);
  assert.equal(stars.userData.stats.candidates, 1);
  assert.equal(stars.material.depthTest, true); assert.equal(stars.material.depthWrite, false);
  let geometry = 0, material = 0, psf = 0;
  stars.material.uniforms.stellarPsfTable.value.addEventListener('dispose', () => psf++);
  stars.geometry.addEventListener('dispose', () => geometry++);
  stars.material.addEventListener('dispose', () => material++);
  stars.userData.dispose(); stars.userData.dispose();
  assert.equal(geometry, 1); assert.equal(material, 1); assert.equal(psf, 1);
});

test('attribute-count mismatch fails before creating partial GPU resources', () => {
  assert.throws(() => createDirectionalStars({positions: new Float32Array(0), colors: new Float32Array(0),
    flux: new Float32Array(1), magnitudes: new Float32Array(1), ranks: new Float32Array(1)}), /matching lengths/);
});

test('directional PSF uploads only when the existing pixel ratio changes', () => {
  const input = {positions: new Float32Array([0, 0, -1]), colors: new Float32Array([1, .8, .6]),
    flux: new Float32Array([.5]), magnitudes: new Float32Array([6]), ranks: new Float32Array([.1])};
  const stars = createDirectionalStars(input), table = stars.material.uniforms.stellarPsfTable.value;
  const pixels = table.image.data, initialVersion = table.version;
  try {
    for (let i = 0; i < 10; i++) stars.onBeforeRender();
    assert.equal(table.version, initialVersion);
    stars.material.uniforms.ratio.value = 1.5; stars.onBeforeRender();
    assert.equal(table.version, initialVersion + 1);
    assert.equal(table.image.data, pixels);
    for (let i = 0; i < 10; i++) stars.onBeforeRender();
    assert.equal(table.version, initialVersion + 1);
  } finally { stars.userData.dispose(); }
});

test('the directional field selects existing stars differently and preserves a sparse threshold in dark regions', () => {
  const stars=createDirectionalStars({positions:new Float32Array([0,0,-1,0,0,1]),colors:new Float32Array(6),
    flux:new Float32Array([1,1]),magnitudes:new Float32Array([6,6]),ranks:new Float32Array([.25,.25])});
  const {uniforms,vertexShader}=stars.material;
  const positions=stars.geometry.attributes.position.array;
  const field={blend:1,plane:[0,1,0,.1],facing:[0,0,-1,0],style:[1,.5,0,0]};
  try {
    stars.userData.setDistantSkyField(field);
    assert.equal(uniforms.uDistantFieldBlend.value,1);
    assert.deepEqual(uniforms.uDistantFieldFacing.value.toArray(),field.facing);
    const smoothstep=(a,b,p)=>{
      const x=Math.max(0,Math.min(1,(p-a)/(b-a)));
      return x*x*(3-2*x);
    };
    const vec3=(x,y,z)=>({x,y,z});
    const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
    const mix=(a,b,t)=>a+(b-a)*t;
    const mask=DISTANT_SKY_FIELD_GLSL.match(/float distantSkyPattern\(vec3 ray\) \{([\s\S]*?)\}/)[1].replaceAll('float ','const ');
    const pattern=Function('ray','uDistantFieldPlane','uDistantFieldFacing','uDistantFieldStyle',
      'dot','smoothstep','sin','exp','mix','vec3',mask);
    const remoteDensity=Function('field','uDistantFieldStyle','smoothstep',
      'return '+vertexShader.match(/float remotePopulation=([^;]+);/)[1]);
    const visible=Function('threshold','sourceRank','smoothstep','max',
      'return '+vertexShader.match(/float visibleRank\(.*?\)\{\s*return ([^;]+);/)[1]);
    const select=(field,style,smoothstep,max,rank)=>visible(remoteDensity(field,style,smoothstep),rank,smoothstep,max);
    const rankForPhase=Function('rank','uDistantFieldStyle','abs','fract',
      'return '+DISTANT_SKY_FIELD_GLSL.match(/float distantStarRank\(.*?\) \{\s*return ([^;]+);/)[1]);
    const regionalRank=(rank,phase)=>rankForPhase(rank,{z:phase},Math.abs,n=>n-Math.floor(n));
    assert.ok(Math.abs(regionalRank(.42,.7)-regionalRank(.42,.7+2*Math.PI))<1e-7);
    assert.ok(visible(.16,regionalRank(.5,0),smoothstep,Math.max)>.99);
    assert.ok(visible(.16,regionalRank(.5,Math.PI),smoothstep,Math.max)<.01);
    const plane={xyz:vec3(0,1,0),w:uniforms.uDistantFieldPlane.value.w};
    const facing={xyz:vec3(0,0,-1),w:uniforms.uDistantFieldFacing.value.w};
    const front=pattern(vec3(0,0,-1),plane,facing,
      uniforms.uDistantFieldStyle.value,dot,smoothstep,Math.sin,Math.exp,mix,vec3);
    const back=pattern(vec3(0,0,1),plane,facing,
      uniforms.uDistantFieldStyle.value,dot,smoothstep,Math.sin,Math.exp,mix,vec3);
    assert.equal(select(front,{x:1},smoothstep,Math.max,.25),1);
    assert.equal(select(back,{x:1},smoothstep,Math.max,.25),0);
    assert.equal(select(front,{x:0},smoothstep,Math.max,.25),0);
    assert.equal(select(front,{x:0},smoothstep,Math.max,.12),1);
    assert.equal(select(back,{x:0},smoothstep,Math.max,.12),1);
    const baselineExpression=vertexShader.match(/float directionalGain=([^;]+);/)[1];
    const weightExpression=vertexShader.match(/float fieldWeight=([^;]+);/)[1];
    const gainExpression=vertexShader.match(/directionalGain\+=([^;]+);/)[1];
    const gain=Function('uDistantFieldBlend','uDistantFieldStyle','field','knots','smoothstep',
      `const fieldWeight=${weightExpression};return ${baselineExpression}+${gainExpression};`);
    assert.ok(gain(1,{x:0},front,.7,smoothstep)>1);
    assert.equal(gain(0,{x:1},front,.7,smoothstep),1);
    assert.equal(gain(1,{x:1},.01,0,smoothstep),gain(1,{x:0},front,.7,smoothstep));
    assert.ok(gain(1,{x:1},front,.1,smoothstep)>gain(1,{x:1},back,0,smoothstep));
    assert.ok(gain(1,{x:1},.72,.6,smoothstep)>gain(1,{x:1},.72,.1,smoothstep));
    assert.equal(stars.geometry.attributes.position.array,positions);
    stars.userData.setDistantSkyField();
    assert.equal(uniforms.uDistantFieldBlend.value,0);
    stars.userData.setDistantSkyField(field);
    assert.deepEqual(uniforms.uDistantFieldFacing.value.toArray(),field.facing);
    assert.deepEqual(uniforms.uDistantFieldStyle.value.toArray(),field.style);
    assert.equal(stars.geometry.attributes.position.array,positions);
  } finally {stars.userData.dispose();}
});
