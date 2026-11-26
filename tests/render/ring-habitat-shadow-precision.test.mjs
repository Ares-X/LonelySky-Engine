import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import {createRingHabitatShadowTriangles} from '../../src/render/ring-habitat-shadow-triangles.js';
import {createRingHabitatShadowUniforms,RING_HABITAT_SHADOW_GLSL} from '../../src/render/ring-habitat-shadow-receiver.js';
const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/ring-habitat-full-ring-shadow.json',import.meta.url))),f=Math.fround;
const bitBuffer=new ArrayBuffer(4),floats=new Float32Array(bitBuffer),bits=new Uint32Array(bitBuffer);
function ulp(value){floats[0]=Math.abs(value);const exponent=bits[0]>>>23&255;bits[0]=exponent>23?(exponent-23)<<23:1<<(exponent>0?exponent-1:0);return floats[0];}
function low(v){if(v[3]===0)return[0,0,0];const word=v[3]-1;return v.slice(0,3).map((h,i)=>f((((word>>>(i*8))&255)-128)*f(ulp(h)/255)));}
function vec(...a){return new Proxy(a,{get(a,k){if(typeof k==='string'&&/^[xyzw]{1,4}$/.test(k)){const v=[...k].map(c=>a['xyzw'.indexOf(c)]);return v.length===1?v[0]:vec(...v);}return a[k];}});}
const sub=(a,b)=>vec(...a.map((v,i)=>f(v-b[i]))),add=(a,b)=>vec(...a.map((v,i)=>f(v+b[i])));
function kernel(records){
 const match=RING_HABITAT_SHADOW_GLSL.match(/float habitatShadowTerrainVisibility\([^)]*\)\{([\s\S]*?)\n\}/);assert.ok(match);
 const body=match[1].replace(/\/\/[^\n]*/g,'')
 .replace(/\(([abc])v\.xyz-receiverHi\)\+\(habitatShadowResidual\(\1v\)-receiverLo\)-receiverSmall/g,'sub(add(sub($1v.xyz,receiverHi),sub(habitatShadowResidual($1v),receiverLo)),receiverSmall)')
 .replace(/([abc])\.xy-tapDelta.xy/g,'sub($1.xy,tapDelta.xy)')
 .replace(/\b(?:int|float|vec[234])\s+/g,'let ').replace(/\bint\(/g,'Math.trunc(');
 const run=new Function('habitatShadowTriangleVertex','habitatShadowResidual','sub','add','uVegetationShadowWorldBias','id','receiverHi','receiverLo','receiverSmall','tapDelta','receiverError',body).bind(null,i=>vec(...records[i]),v=>vec(...low(v)),sub,add,.12,1);
 return (hi,lo,small,delta,error=0)=>run(hi,lo,small,delta,error);
}
function matrix32(matrix,v){const a=matrix.elements;return[0,1,2].map(r=>f(f(f(f(a[r])*f(v[0]))+f(f(a[r+3])*f(v[1])))+f(f(a[r+6])*f(v[2]))));}
test('full-ring Float32 table preserves a real16L face self plane, blocker and finite silhouette',()=>{
 const e=fixture.example,u=createRingHabitatShadowUniforms(),table=createRingHabitatShadowTriangles({uniforms:u}),geometries=[];
 function entry(values,center,index){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(values,3));g.setIndex(index);geometries.push(g);return{mesh:{geometry:g},center};}
 const entries=[entry(e.localTriangle.flat(),e.entryCenter,[0,1,2])];
 // Whole-ring range support keeps the actual captured table origin. No second
 // face, invented caster or world generator participates in this small fixture.
 for(const sign of[-1,1])entries.push(entry([0,0,0],fixture.origin.map(v=>v+sign*1e6),[]));
 try{
  table.update(entries,fixture.light,1);const data=u.uVegetationShadowTriangles.value.image.data,basis=u.uVegetationShadowTriangleBasis.value,origin=u.uVegetationShadowTriangleOrigin.value;
  const records=[0,1,2].map(i=>Array.from(data.slice(data[i]*4,data[i]*4+4))),evaluate=kernel(records);
  assert.deepEqual(records.map(v=>v.slice(0,3)),e.tableTriangle,'actual full-ring high coordinates survive the fixture');
  const btow=new THREE.Matrix3().fromArray(fixture.frame).transpose(),wtob=btow.clone().transpose(),center=new THREE.Vector3(...e.entryCenter).applyMatrix3(btow).add(new THREE.Vector3(...fixture.worldCenter)).toArray().map(f);
  const world=e.localTriangle.map(p=>matrix32(btow,p).map((v,i)=>f(v+center[i]))),interp=[0,1,2].map(i=>f((world[0][i]+world[1][i]+world[2][i])/3)),distance=f(Math.hypot(...interp)),direction=interp.map(v=>f(v/distance)),ray=matrix32(wtob,direction),bodyDistance=f(f(distance/f(fixture.radius))*f(fixture.radius)),offset=ray.map(v=>f(v*bodyDistance));
  const anchor=new THREE.Vector3(...fixture.cameraBody).sub(origin).applyMatrix3(basis).toArray(),hi=anchor.map(f),lo=anchor.map((v,i)=>f(v-hi[i])),small=matrix32(basis,offset);
  assert.equal(evaluate(vec(...hi),vec(...lo),vec(...small),vec(0,0,0)),1,'the actual camera-ray surface is not its own blocker');
  const caster=e.localTriangle.map(p=>new THREE.Vector3(...p).add(new THREE.Vector3(...e.entryCenter)).sub(origin).applyMatrix3(basis));
  const point=caster.reduce((sum,p)=>sum.add(p),new THREE.Vector3()).multiplyScalar(1/3),a=new THREE.Vector3(point.x,point.y,point.z+100),rayOracle=new THREE.Ray(a,new THREE.Vector3(0,0,-1)),hit=new THREE.Vector3();
  assert.ok(rayOracle.intersectTriangle(...caster,false,hit));assert.ok(hit.distanceTo(point)<1e-7,'independent finite ray intersects the original source self plane');
  const at=(p,delta=[0,0,0])=>{const high=p.toArray().map(f),lower=p.toArray().map((v,i)=>f(v-high[i]));return evaluate(vec(...high),vec(...lower),vec(0,0,0),vec(...delta));};
  assert.equal(at(point.clone().add(new THREE.Vector3(0,0,-30))),0,'a real caster30L before the receiver still blocks');
  assert.equal(at(point.clone().add(new THREE.Vector3(0,0,30))),1,'a receiver before the finite caster stays clear');
  assert.equal(at(point.clone().add(new THREE.Vector3(1000,0,-30))),1,'outside the finite triangle stays clear');
  // Negative control: the old ring-scale sum erases the small physical offset.
  const oldRecords=records.map(v=>[v[0],v[1],v[2],0]);assert.equal(kernel(oldRecords)(vec(...e.receiverLight),vec(0,0,0),vec(0,0,0),vec(0,0,0)),0,'captured381 centre arithmetic falsely self shadows this same face');
  let maxQuantizationULP=0;
  for(let i=0;i<3;i++){const exact=caster[i].toArray(),l=low(records[i]);for(let k=0;k<3;k++){const ratio=Math.abs((records[i][k]-exact[k])+l[k])/ulp(records[i][k]);maxQuantizationULP=Math.max(maxQuantizationULP,ratio);assert.ok(ratio<=1/510+1e-6,'packed residual retains the whole-ring source vertex toULP/510');}}
  assert.ok(maxQuantizationULP>0);assert.equal(table.stats.faces,1);assert.equal(table.stats.bytes,2048*16);const builds=table.stats.builds;table.update(entries,fixture.light,1);assert.equal(table.stats.builds,builds,'camera does not own immutable transport');
 }finally{table.dispose();for(const g of geometries)g.dispose();assert.equal(table.stats.bytes,0);assert.equal(u.uVegetationShadowTriangles.value,null);}
});
test('residual float encoding has an exact legacy zero and finite exponent boundaries',()=>{
 assert.deepEqual(low([1e6,-1e6,0,0]),[0,0,0]);
 for(const v of[0,-0,2**-149,2**-126,2**-125,.5,1,2,524288,1048576,-1048576]){assert.ok(Number.isFinite(ulp(v)));assert.ok(ulp(v)>0);for(const w of[1,0x800001,0x1000000])for(const l of low([v,v,v,w]))assert.ok(Number.isFinite(l));}
 // Residuals below Float32's minimum subnormal can underflow onGPU. Those
 // coordinates are not present in the actual full-ring corpus; no all-finite
 // or arbitrarily grazing exactness is claimed by the24bit transport.
});
