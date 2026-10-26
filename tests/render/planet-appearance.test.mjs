import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { describePlanetAppearance, PLANET_APPEARANCE_FAMILIES } from '../../src/render/planet-appearance.js';
import { planetMaterial } from '../../src/render/materials.js';
import { createUniverse } from '../../src/generator.js';

const body=(kind,seed=1)=>({id:`fixture-${kind}`,kind,seed,radius:650,position:[1,2,-3000],colorA:0x558899,colorB:0xccccbb});

test('all ten surface families are reachable without mutating the body or generation stream',()=>{
  const seen=new Set(),universe=createUniverse({seed:'planet-stability'}),before=universe.getSector(0);
  for(const kind of ['gas','ocean','ice','rock','lava'])for(let seed=0;seed<128;seed++){
    const source=body(kind,seed),snapshot=structuredClone(source),a=describePlanetAppearance(source);
    seen.add(a.family);assert.deepEqual(a,describePlanetAppearance(source));assert.ok(Object.isFrozen(a));
    assert.deepEqual(source,snapshot);assert.equal(PLANET_APPEARANCE_FAMILIES[a.family].kind,kind);
    assert.ok(a.detailScale>=.88&&a.detailScale<=1.12);
    assert.deepEqual(a,describePlanetAppearance({...source,radius:900,position:[0,0,0]}),'appearance is independent of size and placement');
  }
  assert.deepEqual([...seen].sort(),Object.keys(PLANET_APPEARANCE_FAMILIES).sort());
  assert.deepEqual(universe.getSector(0),before);
});

test('identity and every seed bit influence independently derived appearance',()=>{
  const a=body('gas',1),baseline=describePlanetAppearance(a);
  assert.notDeepEqual(describePlanetAppearance({...a,seed:1+2**24}),baseline);
  assert.notDeepEqual(describePlanetAppearance({...a,id:'another-body'}),baseline);
  assert.deepEqual(describePlanetAppearance(a),baseline);
});

test('authored maps and saved home surfaces remain on their existing rendering path',()=>{
  const texture=new THREE.Texture();
  for(const extra of [{texture:'saturn'},{homeId:'my-home',proceduralSurface:true},{home:{seed:1},proceduralSurface:true}]){
    const source={...body('gas'),...extra};assert.equal(describePlanetAppearance(source),null);
    const material=planetMaterial(source,{textures:{saturn:texture,moon:texture}});
    assert.equal(material.uniforms.surfaceStyle.value,0);
    assert.equal(material.uniforms.proceduralSurface.value,Boolean(extra.proceduralSurface));
    if(extra.texture){assert.equal(material.uniforms.surface.value,texture);assert.equal(material.uniforms.hasSurface.value,true);}
    assert.equal(material.uniforms.colorA.value.getHex(),source.colorA);
    material.dispose();
  }
  assert.equal(describePlanetAppearance(null),null);assert.equal(describePlanetAppearance(body('unsupported')),null);
  texture.dispose();
});

test('natural worlds share one shader with independent uniforms and no automatic photograph',()=>{
  const moon=new THREE.Texture(),earth=new THREE.Texture();let shader;
  for(const kind of ['gas','ocean','ice','rock','lava']){
    const source=body(kind),appearance=describePlanetAppearance(source),material=planetMaterial(source,{textures:{moon,earth}});
    assert.equal(material.uniforms.hasSurface.value,false);
    assert.equal(material.uniforms.surfaceStyle.value,appearance.surfaceStyle);
    assert.equal(material.uniforms.appearanceA.value.getHex(),appearance.colorA);
    assert.equal(material.uniforms.appearanceB.value.getHex(),appearance.colorB);
    assert.equal(material.uniforms.bodyRadius.value,source.radius);
    if(shader)assert.equal(material.fragmentShader,shader);shader=material.fragmentShader;
    material.dispose();
  }
  moon.dispose();earth.dispose();
});


test('anonymous legacy materials and explicitly procedural bodies retain public defaults',()=>{
  const earth=new THREE.Texture(),moon=new THREE.Texture();
  for(const kind of ['ocean','rock']){
    const source=body(kind);delete source.id;
    assert.equal(describePlanetAppearance(source),null);
    const material=planetMaterial(source,{textures:{earth,moon}});
    assert.equal(material.uniforms.surfaceStyle.value,0);
    assert.equal(material.uniforms.hasSurface.value,true);
    assert.equal(material.uniforms.surface.value,kind==='ocean'?earth:moon);
    material.dispose();
  }
  const source={...body('ocean'),proceduralSurface:true};
  assert.equal(describePlanetAppearance(source),null);
  const material=planetMaterial(source,{textures:{earth,moon}});
  assert.equal(material.uniforms.surfaceStyle.value,0);
  assert.equal(material.uniforms.proceduralSurface.value,true);
  assert.equal(material.uniforms.hasSurface.value,false);
  material.dispose();earth.dispose();moon.dispose();
});

test('crater profile slope matches its height and remains finite at bowls and rims',()=>{
  const material=planetMaterial(body('rock'));
  const expression=material.fragmentShader.match(/float radialSlope=([^;]+);/)?.[1];
  assert.ok(expression);
  const actual=Function('rimDistance','rim','bowlSlope',`return ${expression};`);
  const smoothstep=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  for(const r of [.1,.2,.46])for(const d of [0,r*.2,r*.5,r*.9,r,r*1.2,r*2]){
    const phase=Math.max(0,Math.min(1,(d-r*.35)/(r*.65)));
    const rimDistance=(d-r)/.045,rim=Math.exp(-rimDistance*rimDistance);
    const slope=actual(rimDistance,rim,6*phase*(1-phase)/(r*.65));
    const height=x=>.0024*Math.exp(-(((x-r)/.045)**2))-.0045*(1-smoothstep(r*.35,r,x));
    const delta=1e-7,numeric=(height(d+delta)-height(d-delta))/(2*delta);
    assert.ok(Number.isFinite(slope));assert.ok(Math.abs(slope-numeric)<1e-6);
  }
  material.dispose();
});


test('only the cratered natural family borrows the loaded regolith map',()=>{
  const moon=new THREE.Texture(),seen=new Set();
  for(const kind of ['gas','ocean','ice','rock','lava'])for(let seed=0;seed<32;seed++){
    const source=body(kind,seed),appearance=describePlanetAppearance(source);
    if(seen.has(appearance.family))continue;seen.add(appearance.family);
    const mapped=planetMaterial(source,{textures:{moon}}),bare=planetMaterial(source);
    assert.equal(mapped.uniforms.hasRegolithMap.value,appearance.family==='cratered');
    assert.equal(bare.uniforms.hasRegolithMap.value,false);
    assert.equal(mapped.uniforms.hasSurface.value,false,'detail map does not enter the legacy photo path');
    assert.equal(mapped.uniforms.proceduralSurface.value,false);
    if(appearance.family==='cratered')assert.equal(mapped.uniforms.surface.value,moon);
    mapped.dispose();bare.dispose();
  }
  for(const extra of [{texture:'moon'},{homeId:'home'},{proceduralSurface:true}]){
    const material=planetMaterial({...body('rock'),...extra},{textures:{moon}});
    assert.equal(material.uniforms.hasRegolithMap.value,false);material.dispose();
  }
  assert.equal(seen.size,10);moon.dispose();
});
