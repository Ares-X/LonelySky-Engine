// Intended destination: engine/tests/render/cosmos-core-radiometry.test.mjs (Apache-2.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeCell} from '../../src/coordinates.js';
import {createCosmos,sampleGalaxy,galaxyRelativeCenter} from '../../src/render/cosmos.js';
const origin={x:0,y:0,z:0},away={x:96,y:0,z:0},shifted={x:1,y:0,z:0};
const selected={id:'radiometric-fixture',seed:'radiometric-fixture',revision:3,kind:'cluster',family:'globular',morphology:'elliptical',macroCell:origin,offset:[123,-456,789],orientation:[.81,1.21,-.37],radius:71000,thickness:.65,arms:2,pitch:.3,bar:false,asymmetry:.2};
const ordinary={...selected,id:'ordinary-fixture',seed:'ordinary-fixture',macroCell:{x:6,y:0,z:0},orientation:[.2,-.4,.8]};
const provider=c=>c.y||c.z?null:c.x===0?selected:c.x===6?ordinary:null;
const options={seed:'core-radiometry-regression',descriptorProvider:provider,structures:true,catalogue:{capacity:4,supportFade:true,immutable:true}};
const profile={coreRadius:.06,axes:[1,.65,.8],maximumExtraGain:70};
const alternate={coreRadius:.08,axes:[.7,1,.9],maximumExtraGain:11};
const frame=(cell=origin)=>{const d=cell.x>80?ordinary:selected,center=galaxyRelativeCenter(d,cell,16);return{sectorIndex:encodeCell(cell),cameraPosition:center.map((v,i)=>v+[100,50,25][i]),quality:'high'};};
const bytes=g=>Object.fromEntries(Object.entries(g.children[0].geometry.attributes).map(([k,a])=>[k,Buffer.from(a.array.buffer,a.array.byteOffset,a.array.byteLength).toString('hex')]));
const state=g=>{const u=g.children[0].material.uniforms;return u.coreIndex.value<0?{enabled:false}:{enabled:true,index:u.coreIndex.value,center:u.coreCenter.value.toArray(),shape:u.coreInverseShape.value.toArray(),radius:u.coreRadius.value,lod:u.coreLOD.value,gain:u.coreMaxExtraGain.value};};
async function publish(g,f,incremental){if(incremental)await g.userData.prepare(f);else g.userData.update(f);assert.ok(g.userData.isReady(f));}

test('optional-off is legacy; enabled instances keep isolated source and uniform state across rebases',async()=>{
 const off=createCosmos(options),a=createCosmos({...options,coreRadiometry:d=>d===selected?profile:null}),b=createCosmos({...options,incremental:true,coreRadiometry:d=>d===selected?alternate:null}),syncB=createCosmos({...options,coreRadiometry:d=>d===selected?alternate:null});
 try{
  await publish(off,frame(),false);await publish(a,frame(),false);await publish(b,frame(),true);await publish(syncB,frame(),false);
  assert.equal(off.children[0].material.uniforms.coreIndex,undefined);assert.equal(off.children[0].material.defines.CORE_RADIOMETRY,undefined);
  assert.deepEqual(off.children[0].geometry.attributes.color.array,sampleGalaxy(selected).colors);
  assert.deepEqual(bytes(off),bytes(a));assert.deepEqual(bytes(a),bytes(b));assert.deepEqual(state(b),state(syncB));
  const aState=state(a);assert.notDeepEqual(aState.shape,state(b).shape);assert.notEqual(aState.gain,state(b).gain);
  assert.notEqual(a.children[0].material.uniforms.coreInverseShape.value,b.children[0].material.uniforms.coreInverseShape.value);
  await publish(b,frame(shifted),true);await publish(syncB,frame(shifted),false);
  assert.deepEqual(bytes(b),bytes(syncB));assert.deepEqual(state(b),state(syncB));assert.deepEqual(state(a),aState);
  await publish(b,frame(),true);assert.deepEqual(bytes(a),bytes(b));assert.equal(state(b).gain,alternate.maximumExtraGain);
  a.userData.dispose();await publish(b,frame(shifted),true);assert.deepEqual(state(b),state(syncB));
 }finally{for(const g of [off,a,b,syncB])g.userData.dispose();}
});

test('batch activation is atomic through cancellation, unselected publication, revisit and pending disposal',async()=>{
 const g=createCosmos({...options,incremental:true,preparationBudgetMs:.01,coreRadiometry:d=>d===selected?profile:null});
 let disposedGeometry=0,disposedMaterial=0;
 try{
  await publish(g,frame(),true);const active=state(g),activeBytes=bytes(g);
  g.userData.requestPopulation(frame(away));g.userData.advancePreparation(.000001);g.userData.cancelPreparation();
  assert.deepEqual(state(g),active);assert.deepEqual(bytes(g),activeBytes,'cancelled next batch cannot change the still-active geometry or radiometry');
  await publish(g,frame(away),true);assert.deepEqual(state(g),{enabled:false},'old shape/gain is unreachable when no descriptor is selected');
  const controller=new AbortController(),pending=g.userData.prepare(frame(),{signal:controller.signal}),rejected=assert.rejects(pending,e=>e.name==='AbortError');controller.abort();await rejected;
  assert.deepEqual(state(g),{enabled:false},'aborted selected preparation cannot re-enable old core state');
  await publish(g,frame(),true);assert.deepEqual(state(g),active);assert.deepEqual(bytes(g),activeBytes);
  const points=g.children[0];points.geometry.addEventListener('dispose',()=>disposedGeometry++);points.material.addEventListener('dispose',()=>disposedMaterial++);
  const waiting=g.userData.prepare(frame(away)),disposedWaiter=assert.rejects(waiting,e=>e.name==='AbortError');g.userData.dispose();await disposedWaiter;
  assert.equal(disposedGeometry,1);assert.equal(disposedMaterial,1);assert.equal(g.children.length,0);assert.equal(g.userData.stats.pendingSampleBytes+g.userData.stats.pendingGeometryBytes+g.userData.stats.sampleCacheBytes,0);
 }finally{g.userData.dispose();}
});
