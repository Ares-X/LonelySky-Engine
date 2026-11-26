import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRingHabitatRegions,HaloTerrainUnavailable,createRingHabitatLatticeWorkspace,sampleCanonicalTop,clearRingHabitatLatticeWorkspace} from '../src/ring-habitat-regions.js';
import {createSolidWorkspace,solidDistance,sweepSolid} from '../src/solid-geometry.js';
import {createRingHabitat} from '../src/ring-habitat.js';
import {cosmicRingParts} from '../src/cosmic-bodies.js';

const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const vector=()=>({x:0,y:0,z:0});
const recipe=Object.freeze({version:'halo-field-v1',siteIndex:7,innerRadius:10000,depth:100,minAngle:0,maxAngle:.0771,minY:0,maxY:523});
function field(r){return {statistics:{accountedBytes:2048},innerRadius:r.innerRadius,minAngle:r.minAngle,minY:r.minY,bounds:{minX:0,minY:0,maxX:(r.maxAngle-r.minAngle)*r.innerRadius,maxY:r.maxY-r.minY},hmin:40,hmax:80,
  position(x,y,o){const a=r.minAngle+x/r.innerRadius,h=40+.03*x+.02*y,radial=r.innerRadius-h;o[0]=radial*Math.cos(a);o[1]=r.minY+y;o[2]=radial*Math.sin(a);return o;},
  normal(x,y,o){const a=r.minAngle+x/r.innerRadius,q=1-(40+.03*x+.02*y)/r.innerRadius,nx=-Math.cos(a)+Math.sin(a)*.03/q,nz=-Math.sin(a)-Math.cos(a)*.03/q,k=Math.hypot(nx,.02,nz);o[0]=nx/k;o[1]=-.02/k;o[2]=nz/k;return o;}};}
function fixture(options={}){const body={id:'ring-fixture',position:[20000,-5000,8000],frame:[0,0,-1,0,1,0,1,0,0],habitat:{terrainRecipes:[recipe]}};const registry=createRingHabitatRegions({parentsInBounds:()=>[body],createField:field,...options});return {body,registry};}
// Advance elapsed construction work without busy-waiting or depending on the
// test machine's speed. Geometry still uses the ordinary field and mesh builder.
function constructionClock(t){let now=0;t.mock.method(performance,'now',()=>now);return r=>{const f=field(r),position=f.position;f.position=(x,y,out)=>{now+=.01;return position(x,y,out);};return f;};}
function world(body,p){const f=body.frame;return p.map((_,i)=>body.position[i]+f[i*3]*p[0]+f[i*3+1]*p[1]+f[i*3+2]*p[2]);}
function chart(body,x,y,above=0){const p=[0,0,0];field(recipe).position(x,y,p);const a=x/recipe.innerRadius;p[0]-=above*Math.cos(a);p[2]-=above*Math.sin(a);return world(body,p);}
function box(points,padding=1){return {min:[0,1,2].map(a=>Math.min(...points.map(p=>p[a]))-padding),max:[0,1,2].map(a=>Math.max(...points.map(p=>p[a]))+padding)};}
const digest=m=>createHash('sha256').update(JSON.stringify(m)).digest('hex');

test('physics query before render is explicit, complete and workspace-owned across origins',async()=>{
  const {body,registry:r}=fixture(),a=r.createQueryWorkspace(),b=r.createQueryWorkspace(),bounds=box([chart(body,256,128)],2);
  assert.throws(()=>r.query(0,bounds,a),HaloTerrainUnavailable);assert.equal(a.results.length,0);
  const ready=await r.prepare(0,bounds),first=r.query(0,bounds,a);assert.equal(first.length,2);const position=first[0].position.slice(),mesh=first[0].mesh;
  body.position[0]+=1200;const moved=box([chart(body,256,128)],2);r.query(1,moved,b);
  assert.deepEqual(first[0].position,position);assert.notEqual(a.records[0],b.records[0]);assert.notEqual(a.records[0].frame,b.records[0].frame);assert.equal(b.records[0].mesh,mesh);near(b.records[0].position[0],position[0]+1200);
  assert.ok(Object.isFrozen(mesh.vertices[0])&&Object.isFrozen(mesh.nodes[0].min));assert.ok(mesh.surfaceKinds.every(k=>k===0));
  ready.release();r.dispose();assert.equal(a.results.length,0);assert.equal(b.results.length,0);assert.equal(r.stats.accountedBytes,0);
});

test('shared canonical borders, clipped edge locator and root points use retained triangles',async()=>{
  const {body,registry:r}=fixture(),ready=await r.prepare(0,box([chart(body,256,128),chart(body,770,522)],2)),left=r.acquire(body,7,0,0),right=r.acquire(body,7,1,0);
  const a=left.regions[0].mesh,b=right.regions[0].mesh;
  for(let row=0;row<17;row++){const ia=row*17+16,ib=row*17;for(let axis=0;axis<3;axis++){near(a.vertices[ia][axis]+a.center[axis],b.vertices[ib][axis]+b.center[axis],1e-10);assert.equal(a.normals[ia][axis],b.normals[ib][axis]);}}
  const w=r.createQueryWorkspace(),q=r.query(0,box([chart(body,256,128),chart(body,770,522)],2),w),point=vector(),normal=vector(),flat=vector(),info={};
  for(const [x,y] of [[255.3,121.2],[256,128],[770.5,522.7]]){
    assert.equal(r.sampleTop(body,7,x,y,point,normal,flat,info),true);const p=world(body,[point.x,point.y,point.z]);let best=Infinity;
    for(const solid of q)best=Math.min(best,Math.abs(solidDistance(solid,p).distance));near(best,0,2e-8);near(Math.hypot(normal.x,normal.y,normal.z),1);near(Math.hypot(flat.x,flat.y,flat.z),1);assert.equal(info.rockCoverage,0);
  }
  left.release();right.release();ready.release();r.dispose();
});

test('full swept bounds include both seam regions for radius0 and radius7 CCD',async()=>{
  const {body,registry:r}=fixture();
  const start=chart(body,240,120,30),end=chart(body,280,120,-30),bounds=box([start,end],7),ready=await r.prepare(0,bounds),w=r.createQueryWorkspace(),solids=r.query(0,bounds,w);
  assert.equal(solids.length,2);const sw=createSolidWorkspace();
  for(const radius of [0,7]){let first=1;for(const solid of solids){const hit=sweepSolid(solid,start,end,radius,{},undefined,sw);assert.notEqual(hit.status,'failed',hit.reason);if(hit.status==='hit')first=Math.min(first,hit.fraction);}assert.ok(first>.2&&first<.6,`radius ${radius}: ${first}`);}
  const seamAirStart=chart(body,240,120,20),seamAirEnd=chart(body,280,120,20);for(const solid of solids)assert.equal(sweepSolid(solid,seamAirStart,seamAirEnd,7).status,'clear');
  ready.release();r.dispose();
});

test('cache eviction regenerates identical geometry and external leases defer retirement',async()=>{
  const {body,registry:r}=fixture({maxRegions:1}),one=box([chart(body,120,120)]),two=box([chart(body,380,120)]);
  let ready=await r.prepare(0,one);const borrowed=r.acquire(body,7,0,0),hash=digest(borrowed.regions[0].mesh),id=borrowed.regions[0].id;ready.release();
  await assert.rejects(r.prepare(0,two),e=>e.code==='halo-region-cache-capacity');assert.equal(r.stats.cacheRegions,1);
  borrowed.release();ready=await r.prepare(0,two);ready.release();ready=await r.prepare(0,one);assert.equal(digest(ready.regions[0].mesh),hash);assert.equal(ready.regions[0].id,id);
  const w=r.createQueryWorkspace();r.query(0,one,w);r.clear();assert.equal(w.results.length,0);assert.equal(r.stats.retiredRegions,1);assert.equal(digest(ready.regions[0].mesh),hash);ready.release();assert.equal(r.stats.cacheRegions,0);assert.equal(r.stats.pinnedRegions,0);r.dispose();
});

test('dispose retires external leases safely and rejects invalid aliased tile addresses',async()=>{
  const {body,registry:r}=fixture(),ready=await r.prepare(0,box([chart(body,120,120)]));
  assert.throws(()=>r.acquire(body,7,-1,1),/address/);assert.throws(()=>r.acquire(body,7,0,1.5),/address/);
  const m=ready.regions[0].mesh;r.dispose();assert.equal(r.stats.retiredRegions,1);assert.equal(r.stats.cacheSites,1);assert.equal(ready.regions[0].mesh,m);assert.ok(r.stats.accountedBytes>0);
  ready.release();ready.release();assert.equal(ready.regions.length,0);assert.equal(r.stats.retiredRegions,0);assert.equal(r.stats.cacheSites,0);assert.equal(r.stats.fieldBytes,0);assert.equal(r.stats.accountedBytes,0);
});

test('prepare cancellation and disposal publish no partial clear and release owned pins',async t=>{
  const {body,registry:r}=fixture({createField:constructionClock(t)}),controller=new AbortController(),bounds=box([chart(body,120,120),chart(body,650,120)]),pending=r.prepare(0,bounds,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(r.stats.pinnedRegions,0);
  const w=r.createQueryWorkspace();assert.throws(()=>r.query(0,bounds,w),HaloTerrainUnavailable);assert.equal(w.results.length,0);
  const second=r.prepare(0,bounds);r.dispose();await assert.rejects(second,{name:'AbortError'});assert.equal(r.stats.pendingJobs,0);assert.equal(r.stats.cacheRegions,0);assert.equal(r.stats.accountedBytes,0);assert.throws(()=>r.query(0,bounds,w),/disposed/);
});

test('capacity failure does not publish partial results or leak preparation pins',async()=>{
  const {body,registry:r}=fixture({queryCapacity:1}),bounds=box([chart(body,256,128)],2),w=r.createQueryWorkspace();
  assert.throws(()=>r.query(0,bounds,w),e=>e.code==='halo-region-query-capacity');await assert.rejects(r.prepare(0,bounds),e=>e.code==='halo-region-query-capacity');assert.equal(w.results.length,0);assert.equal(r.stats.cacheRegions,0);r.dispose();
});

test('empty axis/far radial queries need no fields and workspace release permits repeated owners',async()=>{
  const {body,registry:r}=fixture();
  for(const p of [world(body,[0,120,0]),world(body,[20000,120,0])]){const w=r.createQueryWorkspace(),bounds=box([p]);assert.deepEqual(r.query(0,bounds,w),[]);const ready=await r.prepare(0,bounds);assert.equal(ready.regions.length,0);ready.release();r.releaseQuery(w);}
  assert.equal(r.stats.cacheRegions,0);const bounds=box([chart(body,120,120)]),ready=await r.prepare(0,bounds);
  for(let i=0;i<48;i++){const w=r.createQueryWorkspace();r.query(0,bounds,w);r.releaseQuery(w);assert.equal(w.results.length,0);assert.equal(r.stats.queryWorkspaces,0);}
  ready.release();r.dispose();
});

test('failed cold field construction/accounting publishes no empty parent maps',async()=>{
  let fail=true;const failure=new Error('field construction witness'),f=fixture({createField(r){if(fail)throw failure;const result=field(r);result.statistics.accountedBytes=0;return result;}}),bounds=box([chart(f.body,120,120)]);
  await assert.rejects(f.registry.prepare(0,bounds),e=>e===failure);assert.equal(f.registry.stats.cacheParents,0);assert.equal(f.registry.stats.cacheSites,0);assert.equal(f.registry.stats.accountedBytes,0);
  fail=false;await assert.rejects(f.registry.prepare(0,bounds),/field accounted bytes/);assert.equal(f.registry.stats.cacheParents,0);assert.equal(f.registry.stats.pendingJobs,0);f.registry.dispose();
});

test('canonical provider rejects missing ring recipes but accepts explicit empty sites and nonrings',async()=>{
  let body={id:'missing-ring',kind:'ring',position:[0,0,0],frame:[1,0,0,0,1,0,0,0,1],habitat:{}},r=createRingHabitatRegions({parentsInBounds:()=>[body]}),w=r.createQueryWorkspace(),bounds=box([[10000,0,0]]);
  assert.throws(()=>r.query(0,bounds,w),e=>e.code==='halo-recipe-contract');await assert.rejects(r.prepare(0,bounds),e=>e.code==='halo-recipe-contract');assert.equal(w.results.length,0);
  body={...body,habitat:{terrainRecipes:[]}};assert.deepEqual(r.query(0,bounds,w),[]);body={...body,kind:'dark-world',habitat:null};assert.deepEqual(r.query(0,bounds,w),[]);assert.equal(r.stats.cacheParents,0);r.dispose();
});

test('pure lattice sampler equals retained mesh triangles/normals on interiors, edges and clipped cells',async()=>{
  const {body,registry:r}=fixture(),addresses=[];for(let y=0;y<3;y++)for(let x=0;x<4;x++)addresses.push({siteIndex:7,tileX:x,tileY:y});
  const ready=await r.prepareRegions(body,addresses),borrow=r.acquireField(body,7),field=borrow.field,w=createRingHabitatLatticeWorkspace(),vertices=w.vertices.slice(),normals=w.normals.slice(),p=vector(),n=vector(),flat=vector(),info={},mp=vector(),mn=vector(),mf=vector(),mi={};
  const points=[[0,0],[16,16],[256,256],[512,512],[770.9,522.9],[768,512],[255.999999,32],[256.000001,32],[8,8],[770.5,522.5]];
  let seed=0x68bc21eb;for(let i=0;i<250;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const x=seed/4294967296*field.bounds.maxX;seed=(Math.imul(seed,1664525)+1013904223)>>>0;points.push([x,seed/4294967296*field.bounds.maxY]);}
  for(const [x,y] of points){assert.equal(sampleCanonicalTop(field,x,y,p,n,flat,info,w),true);assert.equal(r.sampleTop(body,7,x,y,mp,mn,mf,mi),true);assert.deepEqual(p,mp);assert.deepEqual(n,mn);assert.deepEqual(flat,mf);assert.deepEqual(info,mi);}
  for(let i=0;i<4;i++){assert.equal(w.vertices[i],vertices[i]);assert.equal(w.normals[i],normals[i]);}assert.equal(sampleCanonicalTop(field,field.bounds.maxX,1,p,n,flat,info,w),false);assert.throws(()=>sampleCanonicalTop(field,NaN,1,p,n,flat,info,w),/finite/);
  borrow.release();ready.release();r.dispose();
});

test('field-only leases support canonical roots with zero meshes and share the unchanged byte cap',async()=>{
  const {body,registry:r}=fixture({maxFields:1,maxBytes:2048}),other={...body,id:'second-body'};assert.throws(()=>r.acquireField(body,7),e=>e.code==='halo-field-unavailable');
  const ready=await r.prepareField(body,7),borrow=r.acquireField(body,7),field=ready.field,w=createRingHabitatLatticeWorkspace(),p=vector(),n=vector(),flat=vector();
  assert.equal(r.stats.cacheRegions,0);assert.equal(r.stats.regionsBuilt,0);assert.equal(r.stats.cacheSites,1);assert.equal(r.stats.accountedBytes,2048);assert.equal(r.stats.pinnedFields,1);assert.equal(sampleCanonicalTop(field,770.5,522.5,p,n,flat,null,w),true);assert.throws(()=>r.sampleTop(body,7,770.5,522.5,p,n,flat),HaloTerrainUnavailable);
  await assert.rejects(r.prepareField(other,7),e=>e.code==='halo-region-cache-capacity');assert.equal(r.stats.cacheParents,1);assert.equal(r.stats.cacheSites,1);assert.equal(r.stats.accountedBytes,2048);
  await assert.rejects(r.prepareRegions(body,[{siteIndex:7,tileX:0,tileY:0}]),e=>e.code==='halo-region-cache-capacity');assert.equal(r.stats.cacheRegions,0);
  ready.release();borrow.release();assert.equal(ready.field,null);assert.equal(r.stats.pinnedFields,0);const next=await r.prepareField(other,7);assert.equal(r.stats.cacheSites,1);assert.equal(r.stats.accountedBytes,2048);assert.throws(()=>r.acquireField(body,7),HaloTerrainUnavailable);
  r.clear();r.clear();assert.equal(r.stats.retiredFields,1);assert.equal(next.field.innerRadius,recipe.innerRadius);r.dispose();assert.equal(r.stats.retiredFields,1);next.release();next.release();assert.equal(r.stats.retiredFields,0);assert.equal(r.stats.accountedBytes,0);assert.equal(r.stats.cacheSites,0);
});

test('fixed vertex memo matches raw evaluation through hits, eviction, field changes and clipped boundaries',()=>{
  const a=field(recipe),b=field({...recipe,innerRadius:12000}),raw=createRingHabitatLatticeWorkspace(0),cached=createRingHabitatLatticeWorkspace(4),p=vector(),n=vector(),f=vector(),rp=vector(),rn=vector(),rf=vector(),info={},ri={},values=cached.values,keys=cached.keysX;
  for(let i=0;i<400;i++){const source=i%3===0?b:a,x=i%7===0?770.8:(i*173.733)%770,y=i%5===0?522.9:(i*91.177)%522;sampleCanonicalTop(source,x,y,p,n,f,info,cached);sampleCanonicalTop(source,x,y,rp,rn,rf,ri,raw);assert.deepEqual(p,rp);assert.deepEqual(n,rn);assert.deepEqual(f,rf);assert.deepEqual(info,ri);}
  assert.equal(cached.values,values);assert.equal(cached.keysX,keys);assert.equal(cached.values.length,24);assert.ok(cached.misses>cached.vertexCapacity);assert.equal(cached.field,b);
  clearRingHabitatLatticeWorkspace(cached);assert.equal(cached.field,null);assert.equal(cached.hits,0);assert.equal(cached.misses,0);assert.ok(cached.keysX.every(v=>v===-1));assert.throws(()=>createRingHabitatLatticeWorkspace(4097),/capacity/);
  const warm=createRingHabitatLatticeWorkspace(),originalPosition=a.position,originalNormal=a.normal;let positions=0,normals=0;a.position=(x,y,out)=>{positions++;return originalPosition(x,y,out);};a.normal=(x,y,out)=>{normals++;return originalNormal(x,y,out);};
  sampleCanonicalTop(a,17,19,p,n,f,null,warm);const calls=[positions,normals],misses=warm.misses;sampleCanonicalTop(a,17,19,p,n,f,null,warm);assert.deepEqual([positions,normals],calls);assert.equal(warm.misses,misses);assert.deepEqual(calls,[4,3],'only the hit triangle corners need normals; page center needs position only');assert.ok(warm.hits>=4);assert.equal(warm.cacheBytes,4096*(2*4+6*8+1));clearRingHabitatLatticeWorkspace(warm);clearRingHabitatLatticeWorkspace(raw);
});

test('exact region batches validate completely, copy addresses and release cancelled pins',async t=>{
  const {body,registry:r}=fixture({queryCapacity:2,createField:constructionClock(t)}),controller=new AbortController();controller.abort();await assert.rejects(r.prepareField(body,7,{signal:controller.signal}),{name:'AbortError'});assert.equal(r.stats.cacheSites,0);
  await assert.rejects(r.prepareRegions(body,[{siteIndex:7,tileX:0,tileY:0},{siteIndex:7,tileX:99,tileY:0}]),/address/);assert.equal(r.stats.fieldsBuilt,0);
  await assert.rejects(r.prepareRegions(body,[{siteIndex:7,tileX:0,tileY:0},{siteIndex:7,tileX:0,tileY:0}]),/Duplicate/);assert.equal(r.stats.fieldsBuilt,0);
  await assert.rejects(r.prepareRegions(body,new Array(3).fill({siteIndex:7,tileX:0,tileY:0})),e=>e.code==='halo-region-query-capacity');
  const addresses=[{siteIndex:7,tileX:0,tileY:0},{siteIndex:7,tileX:1,tileY:0}],pending=r.prepareRegions(body,addresses);addresses[1].tileX=99;const ready=await pending;assert.deepEqual(ready.regions.map(e=>e.tileX),[0,1]);ready.release();
  const stop=new AbortController(),cancelled=r.prepareRegions(body,[{siteIndex:7,tileX:2,tileY:0},{siteIndex:7,tileX:3,tileY:0}],{signal:stop.signal});stop.abort();await assert.rejects(cancelled,{name:'AbortError'});assert.equal(r.stats.pinnedRegions,0);assert.equal(r.stats.pinnedFields,0);assert.equal(r.stats.pendingJobs,0);r.dispose();assert.equal(r.stats.accountedBytes,0);
});

test('a resident64-region view is acquired before the next timer turn without rebuilding its physical meshes',async()=>{
  const {body,registry:r}=fixture();body.habitat.terrainRecipes=[{...recipe,maxAngle:.2048,maxY:2048}];
  const addresses=[];for(let y=0;y<8;y++)for(let x=0;x<8;x++)addresses.push({siteIndex:7,tileX:x,tileY:y});
  let first,second,timer;
  try{
    first=await r.prepareRegions(body,addresses);const built=r.stats.regionsBuilt;
    const nextTurn=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),0);});
    const pending=r.prepareRegions(body,addresses),result=await Promise.race([pending,nextTurn]);second=await pending;
    assert.equal(result,second,'resident readiness must not wait behind unrelated timer work');
    assert.equal(second.regions.length,64);assert.equal(r.stats.regionsBuilt,built);
    for(let i=0;i<64;i++)assert.equal(second.regions[i].mesh,first.regions[i].mesh);
    first.release();assert.equal(r.stats.pinnedRegions,64,'the second complete lease remains independently owned');
    second.release();assert.equal(r.stats.pinnedRegions,0);assert.equal(r.stats.pendingJobs,0);
  }finally{clearTimeout(timer);first?.release();second?.release();r.dispose();}
});

test('cold view construction lets an external cancellation run before publishing any lease',async t=>{
  const {body,registry:r}=fixture({createField:constructionClock(t)}),controller=new AbortController();
  const addresses=[{siteIndex:7,tileX:0,tileY:0},{siteIndex:7,tileX:1,tileY:0},{siteIndex:7,tileX:2,tileY:0}];
  let observedPending=false;const timer=setTimeout(()=>{observedPending=r.stats.pendingJobs>0;controller.abort();},0);
  try{
    await assert.rejects(r.prepareRegions(body,addresses,{signal:controller.signal}),{name:'AbortError'});
    assert.equal(observedPending,true,'cold construction must let queued input run while preparation is still pending');
    assert.equal(r.stats.pendingJobs,0);assert.equal(r.stats.pinnedRegions,0);assert.equal(r.stats.pinnedFields,0);
    assert.throws(()=>r.acquire(body,7,2,0),HaloTerrainUnavailable,'unbuilt regions are never published as ready');
  }finally{clearTimeout(timer);r.dispose();assert.equal(r.stats.accountedBytes,0);}
});

test('asynchronous preparation snapshots parents before a provider reuses its borrowed records',async()=>{
  const {body,registry:r}=fixture(),originalId=body.id,bounds=box([chart(body,120,120),chart(body,380,120)]),pending=r.prepare(0,bounds);
  body.id='provider-reused-other-sector';body.position.fill(50000);body.frame.fill(0);body.habitat={terrainRecipes:[]};
  const ready=await pending;assert.equal(ready.regions.length,2);assert.ok(ready.regions.every(e=>e.parentId===originalId&&e.id.startsWith(originalId+':')));ready.release();r.dispose();assert.equal(r.stats.accountedBytes,0);
});

test('actual seeded recipe builds closed canonical mesh without old roof or render input',async()=>{
  const input={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture',terrainMode:'regions'};input.parts=cosmicRingParts(input);
  const habitat=createRingHabitat(input),recipe=habitat.terrainRecipes[0],body={id:'real-ring',position:[0,0,0],frame:[1,0,0,0,1,0,0,0,1],habitat:{terrainRecipes:[recipe]}};
  assert.deepEqual(habitat.terrainGroups,[]);const a=recipe.minAngle+128/recipe.innerRadius,p=[(recipe.innerRadius-50)*Math.cos(a),recipe.minY+128,(recipe.innerRadius-50)*Math.sin(a)],r=createRingHabitatRegions({parentsInBounds:()=>[body]}),ready=await r.prepare(0,box([p],1));
  assert.equal(ready.regions.length,1);const m=ready.regions[0].mesh;assert.equal(m.vertices.length,578);assert.equal(m.topFaces,512);assert.equal(m.faces.length,1152);assert.ok(r.stats.lastBuildMs>0);ready.release();r.dispose();
});

test('actual nonlinear seeded field-only samples reproduce loaded canonical triangle attributes',async()=>{
  const input={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture',terrainMode:'regions'};input.parts=cosmicRingParts(input);
  const recipe=createRingHabitat(input).terrainRecipes[22],body={id:'seeded-nonlinear-ring',kind:'ring',habitat:{terrainRecipes:[recipe]}},r=createRingHabitatRegions({parentsInBounds:()=>[]}),borrow=await r.prepareField(body,recipe.siteIndex),field=borrow.field;
  assert.ok(Object.isFrozen(field)&&Object.isFrozen(field.bounds));let best=-Infinity,x=0,y=0;for(let j=1;j<8;j++)for(let i=1;i<8;i++){const u=i/8*field.bounds.maxX,v=j/8*field.bounds.maxY,h=field.sampleHeight(u,v);if(h>best){best=h;x=u;y=v;}}
  assert.ok(best>100);const tx=Math.floor(x/256),ty=Math.floor(y/256),ready=await r.prepareRegions(body,[{siteIndex:recipe.siteIndex,tileX:tx,tileY:ty}]),w=createRingHabitatLatticeWorkspace(),p=vector(),n=vector(),flat=vector(),info={},mp=vector(),mn=vector(),mf=vector(),mi={};
  for(let j=0;j<8;j++)for(let i=0;i<8;i++){const u=tx*256+(i+.31)/8*256,v=ty*256+(j+.71)/8*256;assert.equal(sampleCanonicalTop(field,u,v,p,n,flat,info,w),true);r.sampleTop(body,recipe.siteIndex,u,v,mp,mn,mf,mi);assert.deepEqual(p,mp);assert.deepEqual(n,mn);assert.deepEqual(flat,mf);assert.deepEqual(info,mi);}
  ready.release();borrow.release();r.dispose();assert.equal(r.stats.accountedBytes,0);
});

test('prepared-only sampling preserves physical triangle outputs without constructing unavailable pages',async()=>{
  const {body,registry:r}=fixture(),p=vector(),n=vector(),flat=vector(),info={},w=createRingHabitatLatticeWorkspace();
  let ready,borrow;
  try{
    assert.equal(r.samplePreparedTop(body,7,255.3,121.2,p,n,flat,info),false);
    assert.equal(r.stats.fieldsBuilt,0);assert.equal(r.stats.regionsBuilt,0);
    assert.throws(()=>r.sampleTop(body,7,255.3,121.2,p,n,flat,info),HaloTerrainUnavailable);
    ready=await r.prepareRegions(body,[{siteIndex:7,tileX:0,tileY:0},{siteIndex:7,tileX:1,tileY:0},{siteIndex:7,tileX:3,tileY:2}]);
    borrow=r.acquireField(body,7);
    for(const [x,y] of [[.3,.2],[15.7,15.4],[255.3,121.2],[256,128],[770.5,522.7]]){
      const expected={p:vector(),n:vector(),f:vector(),info:{}};
      sampleCanonicalTop(borrow.field,x,y,expected.p,expected.n,expected.f,expected.info,w);
      assert.equal(r.samplePreparedTop(body,7,x,y,p,null,flat,info),true);
      assert.deepEqual([p,flat,info],[expected.p,expected.f,expected.info]);
      assert.equal(r.samplePreparedTop(body,7,x,y,p,n,flat,info),true);
      assert.deepEqual([p,n,flat,info],[expected.p,expected.n,expected.f,expected.info]);
    }
    const builds=r.stats.regionsBuilt;assert.equal(r.samplePreparedTop(body,7,600,400,p,n,flat,info),false);assert.equal(r.stats.regionsBuilt,builds);
    assert.equal(r.samplePreparedTop(body,7,771,1,p,n,flat,info),false);
  }finally{ready?.release();borrow?.release();r.dispose();assert.equal(r.stats.accountedBytes,0);assert.equal(r.stats.pinnedFields,0);assert.equal(r.stats.pinnedRegions,0);assert.equal(r.stats.pendingJobs,0);}
});

test('position-only canonical reads upgrade only three triangle normals and invalidate readiness on a field change',()=>{
  const a=field(recipe),b=field({...recipe,innerRadius:12000});
  for(const capacity of [0,1,4096]){
    const w=createRingHabitatLatticeWorkspace(capacity),p=vector(),n=vector(),flat=vector();let normalCalls=0;
    const tracked={...a,normal(x,y,out){normalCalls++;return a.normal(x,y,out);}};
    sampleCanonicalTop(tracked,17,19,p,null,flat,null,w);assert.equal(normalCalls,0);
    const expected={p:vector(),n:vector(),f:vector()},raw=createRingHabitatLatticeWorkspace(0);
    sampleCanonicalTop(a,17,19,expected.p,expected.n,expected.f,null,raw);
    sampleCanonicalTop(tracked,17,19,p,n,flat,null,w);assert.equal(normalCalls,3);assert.deepEqual([p,n,flat],[expected.p,expected.n,expected.f]);
    sampleCanonicalTop(b,17,19,p,null,flat,null,w);
    sampleCanonicalTop(b,17,19,p,n,flat,null,w);sampleCanonicalTop(b,17,19,expected.p,expected.n,expected.f,null,raw);
    assert.deepEqual([p,n,flat],[expected.p,expected.n,expected.f]);
    clearRingHabitatLatticeWorkspace(w);assert.equal(w.field,null);assert.ok(w.normalReady.every(v=>v===0));
  }
});
