import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRingHabitat} from '../../src/ring-habitat.js';
import {cosmicRingParts,describeCosmicBody} from '../../src/cosmic-bodies.js';
import {createRingHabitatField} from '../../src/ring-habitat-field.js';
import {createRingHabitatRegions} from '../../src/ring-habitat-regions.js';
import {createRingHabitatFarPatch,createRingHabitatTriangleGeometry,createRingHabitatRegionRenderer,RING_HABITAT_RENDER_LIMITS} from '../../src/render/ring-habitat-regions.js';
import {createCosmicBodies} from '../../src/render/cosmic-bodies.js';
import {createRingHabitatShadowTriangles} from '../../src/render/ring-habitat-shadow-triangles.js';
import {createRingHabitatShadowUniforms} from '../../src/render/ring-habitat-shadow-receiver.js';

const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture'};options.parts=cosmicRingParts(options);
const habitat=createRingHabitat({...options,terrainMode:'regions'}),identity=[1,0,0,0,1,0,0,0,1];
function fixture(){const r=habitat.terrainRecipes[0],f=createRingHabitatField(r),p=[0,0,0];f.position(f.bounds.maxX*.5,f.bounds.maxY*.5,p);const a=r.minAngle+f.bounds.maxX*.5/r.innerRadius;p[0]-=Math.cos(a)*200;p[2]-=Math.sin(a)*200;
 const body={id:'region-render-fixture',kind:'ring',habitat,radius:options.radius,phase:options.phase,theme:options.theme,position:[0,0,0],center:p.map(v=>-v),frame:identity,light:[.6,.3,-.7],tint:[.2,.3,.4],shape:{type:'compound',parts:options.parts,terrainGroups:[]}};
 const camera=new THREE.PerspectiveCamera(70,1.6,.5,220000);camera.updateMatrixWorld(true);return {body,camera,frame:{bodies:[body],camera,sectorIndex:0,viewportHeight:1000,pixelRatio:1}};}

test('far transition shares every canonical16L boundary vertex including the final shortened cell',()=>{
 const field={bounds:{maxX:1300.5,maxY:900.25},position(x,y,out){out[0]=x;out[1]=Math.sin(x/80)*20+y*.07;out[2]=y;return out;},normal(x,y,out){const a=-Math.cos(x/80)*.25,b=1,c=-.07,n=Math.hypot(a,b,c);out[0]=a/n;out[1]=b/n;out[2]=c/n;return out;}},near={minX:512,minY:0,maxX:1300.5,maxY:512},p=createRingHabitatFarPatch(field,near),world=p.vertices.map(v=>v.map((q,k)=>q+p.center[k]));
 const shore=world.filter(v=>Math.abs(v[2]-512)<1e-9&&v[0]>=512-1e-9),xs=new Set(shore.map(v=>v[0]));
 for(let x=512;x<1300.5;x+=16)assert.ok(xs.has(x),'exact physical16L boundary '+x);assert.ok(xs.has(1300.5),'final shortened16L cell corner');
 for(const f of p.faces){const cx=f.reduce((n,i)=>n+world[i][0],0)/3,cy=f.reduce((n,i)=>n+world[i][2],0)/3;assert.ok(!(cx>512&&cx<1300.5&&cy>0&&cy<512),'far triangles fully replace the near window');}
 assert.ok(p.normals.every(n=>n.every(Number.isFinite)&&Math.abs(Math.hypot(...n)-1)<1e-12));
});

// This test field exposes its chart as world X/Z. Reconstruct topology from
// emitted triangles rather than asking the tessellator for diagnostic metadata.
function checkTopSeams(patch,width,height,near){
 const uv=patch.vertices.map(v=>[v[0]+patch.center[0],v[2]+patch.center[2]]),edges=new Map(),lengths=new Set();let area=0;
 for(const f of patch.faces){const [a,b,c]=f.map(i=>uv[i]),det=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);assert.ok(det>0);area+=det/2;const x=(a[0]+b[0]+c[0])/3,y=(a[1]+b[1]+c[1])/3;assert.ok(!(x>near.minX&&x<near.maxX&&y>near.minY&&y<near.maxY));
  for(let k=0;k<3;k++){const a=f[k],b=f[(k+1)%3],key=a<b?a+','+b:b+','+a,e=edges.get(key);if(e){e.count++;e.winding+=a<b?1:-1;}else edges.set(key,{a,b,count:1,winding:a<b?1:-1});const p=uv[a],q=uv[b];if(p[0]===q[0]||p[1]===q[1])lengths.add(Math.hypot(p[0]-q[0],p[1]-q[1]));}
 }
 for(const e of edges.values()){
  if(e.count===2){assert.equal(e.winding,0);continue;}assert.equal(e.count,1);const a=uv[e.a],b=uv[e.b];
  const outer=a[0]===b[0]&&(a[0]===0||a[0]===width)||a[1]===b[1]&&(a[1]===0||a[1]===height);
  const hole=a[0]===b[0]&&(a[0]===near.minX||a[0]===near.maxX)&&Math.min(a[1],b[1])>=near.minY&&Math.max(a[1],b[1])<=near.maxY||a[1]===b[1]&&(a[1]===near.minY||a[1]===near.maxY)&&Math.min(a[0],b[0])>=near.minX&&Math.max(a[0],b[0])<=near.maxX;
  assert.ok(outer||hole,'no open internal edge at a128/256/512 transition');
 }
 assert.ok(Math.abs(area-(width*height-(near.maxX-near.minX)*(near.maxY-near.minY)))<1e-4);
 const points=new Set(uv.map(p=>p[0]+','+p[1]));for(let x=near.minX;x<near.maxX;x+=16){if(near.minY>0)assert.ok(points.has(x+','+near.minY));if(near.maxY<height)assert.ok(points.has(x+','+near.maxY));}for(let y=near.minY;y<near.maxY;y+=16){if(near.minX>0)assert.ok(points.has(near.minX+','+y));if(near.maxX<width)assert.ok(points.has(near.maxX+','+y));}
 assert.ok(patch.normals.every(n=>n.every(Number.isFinite)&&Math.abs(Math.hypot(...n)-1)<1e-12));return lengths;
}
test('adaptive display cells join128/256/512 bands and the physical16L hole without internal open edges',()=>{
 const field={bounds:{maxX:38000.5,maxY:21000.25},position(x,y,out){out[0]=x;out[1]=Math.sin(x/1700)*50+Math.cos(y/900)*30;out[2]=y;return out;},normal(x,y,out){const a=-Math.cos(x/1700)*50/1700,b=1,c=Math.sin(y/900)*30/900,n=Math.hypot(a,b,c);out[0]=a/n;out[1]=b/n;out[2]=c/n;return out;}},near={minX:9216,minY:8192,maxX:11264,maxY:10240},patch=createRingHabitatFarPatch(field,near,512,{x:10000.125,y:9000.5}),lengths=checkTopSeams(patch,field.bounds.maxX,field.bounds.maxY,near);
 for(const length of [128,256,512])assert.ok(lengths.has(length),'display band retains actual'+length+'L cells');
 const short={...field,bounds:{maxX:1300.5,maxY:900.25}},hole={minX:512,minY:0,maxX:1300.5,maxY:512},clipped=createRingHabitatFarPatch(short,hole,512,{x:600,y:400});checkTopSeams(clipped,1300.5,900.25,hole);
});

test('indexed far geometry retains every ordered source corner and smooth normal while accounting for shared vertices and indices',()=>{
 const field={bounds:{maxX:2048,maxY:1536},position(x,y,out){out[0]=x;out[1]=Math.sin(x/300)*25+Math.cos(y/400)*19;out[2]=y;return out;},normal(x,y,out){const a=-Math.cos(x/300)*25/300,b=1,c=Math.sin(y/400)*19/400,n=Math.hypot(a,b,c);out[0]=a/n;out[1]=b/n;out[2]=c/n;return out;}},patch=createRingHabitatFarPatch(field),geometry=createRingHabitatTriangleGeometry(patch);
 try{assert.ok(geometry.index.array instanceof Uint16Array);assert.equal(geometry.index.count,patch.faces.length*3);assert.equal(geometry.attributes.position.count,patch.vertices.length);assert.deepEqual(Object.keys(geometry.attributes),['position','normal']);
  for(let face=0;face<patch.faces.length;face++)for(let corner=0;corner<3;corner++){const at=geometry.index.getX(face*3+corner),expected=patch.faces[face][corner];assert.equal(at,expected,'indices retain source winding and triangle order');for(let axis=0;axis<3;axis++){assert.equal(geometry.attributes.position.array[at*3+axis],Math.fround(patch.vertices[expected][axis]));assert.equal(geometry.attributes.normal.array[at*3+axis],Math.fround(patch.normals[expected][axis]));}}
  const bytes=geometry.index.array.byteLength+Object.values(geometry.attributes).reduce((sum,a)=>sum+a.array.byteLength,0);assert.equal(bytes,patch.vertices.length*24+patch.faces.length*6);assert.ok(bytes<patch.faces.length*132/2,'shared indexed storage saves memory without dropping source triangles');
 }finally{geometry.dispose();}
});

test('large far vertex addresses select32bit indices without truncating source corners',()=>{
 for(const count of [65535,65537]){const patch={vertices:Array.from({length:count},(_,i)=>[i,(i%3)*.2,Math.sin(i)*.03]),normals:Array.from({length:count},()=>[0,0,1]),faces:[[0,count-2,count-1]]},g=createRingHabitatTriangleGeometry(patch);
  try{assert.equal(g.index.array.constructor,count>65536?Uint32Array:Uint16Array);assert.deepEqual(Array.from(g.index.array),patch.faces[0]);assert.equal(g.attributes.position.getX(g.index.getX(2)),count-1);}finally{g.dispose();}
 }
 const engineered={vertices:[[0,0,0],[1,0,0],[0,1,0]],normals:[[0,0,1],[0,0,1],[0,0,1]],faces:[[0,1,2]],surfaceKinds:[1,0,0]};assert.throws(()=>createRingHabitatTriangleGeometry(engineered),/engineered-rock coverage/,'far natural geometry must not silently discard material coverage');
});

test('canonical near geometry keeps closed mesh data and all original per-corner attributes',async()=>{
 const f=prewarmFixture(),body=f.frame.bodies[0];let lease;
 try{lease=await f.registry.prepareRegions(body,[{siteIndex:7,tileX:0,tileY:0}]);const mesh=lease.regions[0].mesh,before=JSON.stringify(mesh),g=createRingHabitatTriangleGeometry(mesh,1000001);
  try{assert.equal(g.index,null);assert.deepEqual(Object.keys(g.attributes).sort(),['haloShadowFaceId','position','normal','haloFaceNormal','haloRockCoverage'].sort());for(let i=0;i<mesh.faces.length;i++){const face=mesh.faces[i],a=mesh.vertices[face[0]],b=mesh.vertices[face[1]],c=mesh.vertices[face[2]],ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,size=Math.hypot(nx,ny,nz);for(let k=0;k<3;k++){const at=i*3+k,v=face[k];assert.equal(g.attributes.haloShadowFaceId.getX(at),1000001+i);assert.equal(g.attributes.haloRockCoverage.getX(at),mesh.surfaceKinds[v]);for(let axis=0;axis<3;axis++){assert.equal(g.attributes.position.array[at*3+axis],Math.fround(mesh.vertices[v][axis]));assert.equal(g.attributes.normal.array[at*3+axis],Math.fround(mesh.normals[v][axis]));}assert.deepEqual([g.attributes.haloFaceNormal.getX(at),g.attributes.haloFaceNormal.getY(at),g.attributes.haloFaceNormal.getZ(at)],[Math.fround(nx/size),Math.fround(ny/size),Math.fround(nz/size)]);}}
   assert.equal(JSON.stringify(mesh),before,'render construction does not mutate the authoritative closed CCD mesh');
  }finally{g.dispose();}
 }finally{lease?.release();f.dispose();}
});

// The global-light table is Float32 transport, not canonical-exact raster.
// CPU replay of the accepted native A/B poses measured up to0.04656L world reconstruction
// error and0.13994L old-to-new depth difference in an explicit F32 arithmetic
// model. The existing0.12L bias is unchanged; actual GPU FMA/pixels and long
// flight behavior remain separate from this ordered-corner/storage proof.
// Shared-table decoding adds zero CPU Float32 corner error. The20261112 native
// A/B still had output-channel deltas up to40/255 at the coastal view; their
// shader/raster cause is unresolved, so pixel identity is not asserted.
test('triangle transport shares indexed vertices and preserves nonindexed corners in one ID order with owned texture lifetime',()=>{
 const indexed=createRingHabitatTriangleGeometry({vertices:[[0,0,0],[512,.25,0],[0,.5,512],[512,.75,512]],normals:[[0,1,0],[0,1,0],[0,1,0],[0,1,0]],faces:[[0,1,2],[1,3,2]]}),plain=new THREE.BufferGeometry();plain.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,16,1,0,0,2,16],3));
 const entries=[{mesh:{geometry:indexed},center:[800000.123,-20000.456,-600000.789]},{mesh:{geometry:plain},center:[800512.123,-19999.456,-599488.789]}],uniforms=createRingHabitatShadowUniforms(),owner=createRingHabitatShadowTriangles({uniforms}),point=new THREE.Vector3(),inverse=new THREE.Matrix3();let firstDisposals=0,secondDisposals=0,geometryDisposals=0;indexed.addEventListener('dispose',()=>geometryDisposals++);plain.addEventListener('dispose',()=>geometryDisposals++);
 try{owner.update(entries,[.39,.81,.44],1);const texture=uniforms.uVegetationShadowTriangles.value;texture.addEventListener('dispose',()=>firstDisposals++);assert.equal(owner.stats.faces,3);assert.equal(texture.image.width,2048);assert.ok(texture.image.height<=2048);let corner=0,quantization=0;inverse.copy(uniforms.uVegetationShadowTriangleBasis.value).transpose();
  for(const entry of entries){const g=entry.mesh.geometry,p=g.attributes.position,count=g.index?g.index.count:p.count;for(let i=0;i<count;i++,corner++){const at=g.index?g.index.getX(i):i,c=entry.center,o=texture.image.data[Math.floor(corner/3)*4+corner%3]*4,origin=uniforms.uVegetationShadowTriangleOrigin.value;point.set(c[0]-origin.x+p.getX(at),c[1]-origin.y+p.getY(at),c[2]-origin.z+p.getZ(at)).applyMatrix3(uniforms.uVegetationShadowTriangleBasis.value);assert.deepEqual(Array.from(texture.image.data.subarray(o,o+3)),[Math.fround(point.x),Math.fround(point.y),Math.fround(point.z)]);const word=texture.image.data[o+3]-1;assert.ok(Number.isInteger(word)&&word>=0&&word<16777216);const exact=point.toArray();point.fromArray(texture.image.data,o);for(let axis=0;axis<3;axis++){const high=point.getComponent(axis),ulp=high===0?2**-149:2**Math.max(-149,Math.floor(Math.log2(Math.abs(high)))-23),low=(((word>>>(axis*8))&255)-128)*(ulp/255);assert.ok(Math.abs((high-exact[axis])+low)<=ulp/510+Math.abs(low)*2**-23);point.setComponent(axis,high+low);}point.applyMatrix3(inverse).add(origin);quantization=Math.max(quantization,Math.hypot(point.x-(c[0]+p.getX(at)),point.y-(c[1]+p.getY(at)),point.z-(c[2]+p.getZ(at))));}}
  assert.equal(corner,9);assert.ok(quantization>0,'global-light Float32 transport is deliberately not claimed canonical-exact');assert.equal(uniforms.uVegetationShadowWorldBias.value,.12);
  const builds=owner.stats.builds;owner.update(entries,[.39,.81,.44],1);assert.equal(owner.stats.builds,builds);assert.equal(uniforms.uVegetationShadowTriangles.value,texture);owner.clear();assert.equal(firstDisposals,1);assert.equal(geometryDisposals,0,'borrowed view geometry remains alive');owner.update(entries,[.39,.81,.44],1);uniforms.uVegetationShadowTriangles.value.addEventListener('dispose',()=>secondDisposals++);owner.dispose();owner.dispose();assert.equal(secondDisposals,1);assert.equal(geometryDisposals,0);
 }finally{owner.dispose();indexed.dispose();plain.dispose();}
 const limited=createRingHabitatShadowTriangles({uniforms:createRingHabitatShadowUniforms()});try{assert.throws(()=>limited.update([{mesh:{geometry:{index:{count:12582912},attributes:{position:{count:1}}}},center:[0,0,0]}],[1,0,0],1),/2048x2048/);assert.equal(limited.stats.bytes,0,'oversized transport rejects before allocating');}finally{limited.dispose();}
});

test('shared triangle transport retains mixed16bit32bit and nonindexed corners through light and shape changes',()=>{
 const small=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,512,.25,0,0,.5,512,512,.75,512],3));small.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2,1,3,2]),1));
 const plain=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,16,1,0,0,2,16],3)),positions=new Float32Array(65537*3);positions.set([32,.125,16],65535*3);positions.set([64,.875,32],65536*3);
 const large=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(positions,3));large.setIndex(new THREE.BufferAttribute(new Uint32Array([65535,65536,0]),1));
 const entries=[small,plain,large].map((geometry,i)=>({mesh:{geometry},center:[800000.123+i*512,-20000.456,-600000.789]})),uniforms=createRingHabitatShadowUniforms(),owner=createRingHabitatShadowTriangles({uniforms}),point=new THREE.Vector3();let texture;
 try{for(const [revision,light] of [[1,[.39,.81,.44]],[1,[-.6,.2,.7]],[2,[.39,.81,.44]]]){
  owner.update(entries,light,revision);const next=uniforms.uVegetationShadowTriangles.value;if(texture)assert.equal(next,texture,'unchanged storage capacity reuses texture');texture=next;const data=texture.image.data;assert.equal(owner.stats.faces,4);assert.equal(owner.stats.bytes,Math.ceil((4+4+3+65537)/2048)*2048*16);assert.deepEqual(Array.from(data.subarray(0,16)),[4,5,6,0,5,7,6,0,8,9,10,0,65546,65547,11,0]);
  let corner=0;for(const e of entries){const g=e.mesh.geometry,p=g.attributes.position;for(let i=0,n=g.index?g.index.count:p.count;i<n;i++,corner++){const at=g.index?g.index.getX(i):i,address=data[Math.floor(corner/3)*4+corner%3],origin=uniforms.uVegetationShadowTriangleOrigin.value;assert.equal(Math.fround(address),address);point.set(e.center[0]-origin.x+p.getX(at),e.center[1]-origin.y+p.getY(at),e.center[2]-origin.z+p.getZ(at)).applyMatrix3(uniforms.uVegetationShadowTriangleBasis.value);assert.deepEqual(Array.from(data.subarray(address*4,address*4+3)),[Math.fround(point.x),Math.fround(point.y),Math.fround(point.z)]);}}
 }}finally{owner.dispose();small.dispose();plain.dispose();large.dispose();}
});

test('shared transport fits the audited large-ring face and vertex budget without raising its2048 table limit',()=>{
 // Actual WORLD_SEED ring -21,-11,19, focused site26 plus64 physical tiles:
 // 2217380 faces and1307481 uploaded positions previously needed3249 rows.
 // Virtual coordinate getters exercise representation capacity, not terrain.
 const faces=2217380,vertices=1307481,uniforms=createRingHabitatShadowUniforms(),owner=createRingHabitatShadowTriangles({uniforms});let reads=0;
 const entries=[{mesh:{geometry:{index:{count:faces*3,getX:i=>i%vertices},attributes:{position:{count:vertices,getX:i=>{reads++;return i%17;},getY:i=>i%13,getZ:i=>i%11}}}},center:[800000,0,-600000]}];
 try{owner.update(entries,[.39,.81,.44],1);const image=uniforms.uVegetationShadowTriangles.value.image;assert.equal(image.width,2048);assert.equal(image.height,1722);assert.equal(image.data.byteLength,56426496);assert.equal(owner.stats.faces,faces);
  for(const corner of [0,1,2,vertices-1,vertices,faces*3-1]){const address=image.data[Math.floor(corner/3)*4+corner%3];assert.equal(address,faces+corner%vertices);assert.equal(Math.fround(address),address);}
  owner.clear();const before=reads;assert.throws(()=>owner.update([{mesh:{geometry:{index:{count:4194304*3},attributes:{position:{count:1,getX:()=>{reads++;throw Error('coordinate access before rejection');}}}}},center:[0,0,0]}],[1,0,0],2),/2048x2048/);assert.equal(reads,before);assert.equal(uniforms.uVegetationShadowTriangles.value,null);assert.equal(owner.stats.bytes,0);
 }finally{owner.dispose();}
});

test('five visible rings use actual projected farLOD without a body-count rejection; zero visibility creates no field',async()=>{
 const {body,frame}=fixture();for(let i=1;i<5;i++)frame.bodies.push({...body,id:'far-ring-'+i,center:[4000000*i,300000*i,-200000*i]});frame.bodies.push({...body,id:'invisible-ring',visibility:0});
 const registry=createRingHabitatRegions({parentsInBounds:()=>frame.bodies}),render=createRingHabitatRegionRenderer({terrainRegistry:registry});
 try{assert.equal(render.userData.terrainReady(frame),false);await render.userData.prepareTerrain(frame);assert.equal(render.userData.terrainReady(frame),true);assert.equal(render.userData.stats.farBodies,5);assert.equal(render.userData.stats.nearRegions,64);assert.ok(render.userData.stats.gpuBytes<RING_HABITAT_RENDER_LIMITS.maxGpuBytes);assert.equal(registry.stats.pinnedRegions,64);
  const geometries=render.children.map(m=>m.geometry),builds=render.userData.stats.builds;await render.userData.prepareTerrain(frame);assert.equal(render.userData.stats.builds,builds);assert.deepEqual(render.children.map(m=>m.geometry),geometries);
  const near=render.children.filter(m=>m.userData.canonicalMesh);assert.equal(near.length,64);for(const mesh of near){const source=mesh.userData.canonicalMesh,a=mesh.geometry.attributes.position;assert.equal(a.count,source.faces.length*3);for(let i=0;i<source.faces.length;i+=83)for(let j=0;j<3;j++){const p=source.vertices[source.faces[i][j]],at=i*3+j;assert.equal(a.getX(at),Math.fround(p[0]));assert.equal(a.getY(at),Math.fround(p[1]));assert.equal(a.getZ(at),Math.fround(p[2]));}}
  frame.bodies[1].center[0]=10000;assert.equal(render.userData.terrainReady(frame),false,'approach invalidates a coarse farLOD when its cell would exceed2pixels');
 }finally{render.userData.dispose();assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pinnedFields,0);registry.dispose();}
});

test('a far-only focused view replaces its display plan once after movement without building collision regions',async()=>{
 const {body,frame}=fixture(),r=habitat.terrainRecipes[0],angle=(r.minAngle+r.maxAngle)/2;body.center[0]+=Math.cos(angle)*20000;body.center[2]+=Math.sin(angle)*20000;
 const registry=createRingHabitatRegions({parentsInBounds:()=>[body]}),render=createRingHabitatRegionRenderer({terrainRegistry:registry});
 try{await render.userData.prepareTerrain(frame);assert.equal(render.userData.stats.nearRegions,0);assert.equal(registry.stats.regionsBuilt,0);const old=new Set(render.children.map(m=>m.geometry)),builds=render.userData.stats.builds;
  body.center[0]+=Math.sin(angle)*1000;body.center[2]-=Math.cos(angle)*1000;assert.equal(render.userData.terrainReady(frame),false);await render.userData.prepareTerrain(frame);assert.equal(render.userData.terrainReady(frame),true);assert.equal(render.userData.stats.builds,builds+1);assert.equal(registry.stats.regionsBuilt,0);const reused=render.children.filter(m=>old.has(m.geometry)).length;assert.ok(reused>=render.children.length-2&&reused<render.children.length);
  const current=render.children.map(m=>m.geometry);await render.userData.prepareTerrain(frame);assert.equal(render.userData.stats.builds,builds+1);assert.deepEqual(render.children.map(m=>m.geometry),current);
 }finally{render.userData.dispose();assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pinnedFields,0);registry.dispose();}
});

test('a cancelled older preparation cannot install or clear a newer scene and releases its field lease',async()=>{
 const {body,camera}=fixture(),simple={bounds:{maxX:1024,maxY:1024},position(x,y,out){out[0]=x;out[1]=0;out[2]=y;return out;},normal(x,y,out){out[0]=0;out[1]=1;out[2]=0;return out;}};let resolveOld,oldReleased=0,newReleased=0;
 const registry={revision:0,prepareRegions(){throw Error('far-only fixture must not build physical regions');},prepareField(body){if(body.id==='old')return new Promise(resolve=>{resolveOld=()=>resolve({field:simple,release(){oldReleased++;}});});return Promise.resolve({field:simple,release(){newReleased++;}});}};
 const render=createRingHabitatRegionRenderer({terrainRegistry:registry}),a={...body,id:'old',center:[4000000,0,0],habitat:{...habitat,terrainRecipes:[habitat.terrainRecipes[0]]}},b={...a,id:'new'},frameA={bodies:[a],camera,viewportHeight:1000,pixelRatio:1},frameB={bodies:[b],camera,viewportHeight:1000,pixelRatio:1};
 try{const pending=render.userData.prepareTerrain(frameA);a.center[0]=1;await render.userData.prepareTerrain(frameB);assert.equal(render.userData.terrainReady(frameB),true);const children=render.children.slice(),builds=render.userData.stats.builds;resolveOld();await assert.rejects(pending,{name:'AbortError'});assert.equal(oldReleased,1);assert.equal(newReleased,1);assert.equal(render.userData.terrainReady(frameB),true);assert.equal(render.userData.stats.ready,true);assert.equal(render.userData.stats.builds,builds);assert.deepEqual(render.children,children);
 }finally{render.userData.dispose();}
});

function prewarmFixture(){
 const recipe={version:'halo-field-v1',siteIndex:7,innerRadius:10000,depth:100,minAngle:0,maxAngle:.4096,minY:0,maxY:4096};
 const field=r=>({statistics:{accountedBytes:2048},innerRadius:r.innerRadius,minAngle:0,minY:0,bounds:{maxX:4096,maxY:4096},hmin:40,hmax:40,
  position(x,y,out){const a=x/r.innerRadius;out[0]=(r.innerRadius-40)*Math.cos(a);out[1]=y;out[2]=(r.innerRadius-40)*Math.sin(a);},normal(x,y,out){const a=x/r.innerRadius;out[0]=-Math.cos(a);out[1]=0;out[2]=-Math.sin(a);}});
 const body={id:'prewarm-ring',kind:'ring',radius:10000,habitat:{terrainRecipes:[recipe]},frame:identity,center:[0,0,0]};
 const registry=createRingHabitatRegions({parentsInBounds:()=>[body],createField:field});
 let block=false,entered,finish;
 const reached=new Promise(resolve=>{entered=resolve;});
 const owner={get revision(){return registry.revision;},prepareField:registry.prepareField,async prepareRegions(...args){const lease=await registry.prepareRegions(...args);if(block){entered();await new Promise(resolve=>{finish=resolve;});}return lease;}};
 const render=createRingHabitatRegionRenderer({terrainRegistry:owner}),camera=new THREE.PerspectiveCamera(70,1.6,.5,220000),frame={bodies:[body],camera,viewportHeight:1000,pixelRatio:1};
 const move=x=>{const a=x/10000;body.center[0]=-9860*Math.cos(a);body.center[1]=-1636;body.center[2]=-9860*Math.sin(a);};move(1636);
 return {registry,render,frame,move,hold(){block=true;return reached;},finish(){finish();},dispose(){render.userData.dispose();assert.equal(registry.stats.pinnedRegions,0);registry.dispose();assert.equal(registry.stats.accountedBytes,0);}};
}

test('near preparation starts inside the valid view and replaces it only when the live hard guard is covered',async()=>{
 const f=prewarmFixture(),u=f.render.userData;
 try{
  await u.prepareTerrain(f.frame);assert.equal(u.terrainReady(f.frame),true);assert.equal(u.terrainPreparationNeeded(f.frame),false);
  f.move(2100);assert.equal(u.terrainReady(f.frame),true);assert.equal(u.terrainPreparationNeeded(f.frame),true,'the prewarm margin precedes the physical hard guard');
  const held=f.hold(),pending=u.prepareTerrain(f.frame);await held;
  assert.equal(u.terrainReady(f.frame),true,'the previous complete physical window remains usable during preparation');
  f.move(2350);assert.equal(u.terrainReady(f.frame),false,'crossing the actual old hard guard still suspends consumers');
  f.finish();assert.equal(await pending,true);assert.equal(u.terrainReady(f.frame),true);assert.equal(u.terrainPreparationNeeded(f.frame),false);
  assert.equal(u.stats.nearRegions,64);assert.equal(f.registry.stats.pinnedRegions,64);
 }finally{f.dispose();}
});

test('a reversed live view discards an ahead-only prewarm without disposing the current geometry',async()=>{
 const f=prewarmFixture(),u=f.render.userData;
 try{
  await u.prepareTerrain(f.frame);const previous=f.render.children.slice(),builds=u.stats.builds;
  f.move(2100);const held=f.hold(),pending=u.prepareTerrain(f.frame);await held;
  f.move(1100);assert.equal(u.terrainReady(f.frame),true);
  f.finish();assert.equal(await pending,false,'a completed preparation is not a committed view unless it covers the current camera');
  assert.equal(u.terrainReady(f.frame),true);assert.equal(u.terrainPreparationNeeded(f.frame),true,'the opposite direction can prewarm while the previous window remains valid');
  assert.deepEqual(f.render.children,previous);assert.equal(u.stats.builds,builds);assert.equal(u.stats.preparationDiscards,1);assert.equal(f.registry.stats.pinnedRegions,64);
 }finally{f.dispose();}
});

test('aborting a prewarm releases its new lease while the committed window stays ready',async()=>{
 const f=prewarmFixture(),u=f.render.userData,controller=new AbortController();
 try{
  await u.prepareTerrain(f.frame);const previous=f.render.children.slice();
  f.move(2100);f.frame.signal=controller.signal;const held=f.hold(),pending=u.prepareTerrain(f.frame);await held;
  controller.abort();f.finish();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(u.terrainReady(f.frame),true);assert.deepEqual(f.render.children,previous);assert.equal(f.registry.stats.pinnedRegions,64);
 }finally{f.dispose();}
});

test('ordinary cosmic body integration gates preparation and borrows registry triangles without a terrain atlas',async()=>{
 const {body,frame}=fixture(),registry=createRingHabitatRegions({parentsInBounds:()=>[body]}),group=createCosmicBodies({haloTerrain:registry});
 try{assert.throws(()=>group.userData.update(frame),/Prepare the complete canonical terrain view/);await group.userData.prepareTerrain(frame);group.userData.update(frame);assert.equal(group.userData.terrainPreparationNeeded(frame),false);const slot=group.children.find(m=>m.name==='Cosmic solid surface'),owner=group.children.find(m=>m.name==='Canonical habitat regions');assert.ok(owner.visible);assert.equal(slot.material.uniforms.uHabitatGroupCount.value,0);assert.equal(slot.material.uniforms.uHabitatTerrain.value.userData.isHabitatFull,false);assert.equal(group.userData.haloTerrainStats.nearRegions,64);assert.equal(group.userData.haloTerrainStats.farBodies,1);const versions=owner.children.map(m=>m.geometry.attributes.position.version);for(let i=0;i<10;i++)group.userData.update(frame);assert.deepEqual(owner.children.map(m=>m.geometry.attributes.position.version),versions,'stationary updates reuse geometry');
  const oldFar=new Set(owner.children.filter(m=>m.name==='Habitat field visual LOD').map(m=>m.geometry)),oldBuilds=group.userData.haloTerrainStats.builds,oldNear=new Map(owner.children.filter(m=>m.userData.regionId).map(m=>[m.userData.regionId,m.geometry])),r=habitat.terrainRecipes[0],angle=r.minAngle+(r.maxAngle-r.minAngle)*.5;
  body.center[0]+=Math.sin(angle)*1000;body.center[2]-=Math.cos(angle)*1000;assert.equal(group.userData.terrainReady(frame),false);assert.equal(group.userData.terrainPreparationNeeded(frame),true);await group.userData.prepareTerrain(frame);group.userData.update(frame);let reused=0;
  for(const mesh of owner.children)if(oldNear.has(mesh.userData.regionId)){assert.equal(mesh.geometry,oldNear.get(mesh.userData.regionId),'overlapping world regions retain GPU geometry across a near-box change');reused++;}assert.ok(reused>=24);assert.equal(group.userData.haloTerrainStats.builds,oldBuilds+1);
  const farMeshes=owner.children.filter(m=>m.name==='Habitat field visual LOD'),farReuse=farMeshes.filter(m=>oldFar.has(m.geometry)).length;assert.ok(farReuse>=farMeshes.length-2&&farReuse<farMeshes.length,'one changed view plan replaces the affected site and retains remote GPU buffers');
  const replaced=owner.children.map(m=>m.geometry);await group.userData.prepareTerrain(frame);assert.equal(group.userData.haloTerrainStats.builds,oldBuilds+1);assert.deepEqual(owner.children.map(m=>m.geometry),replaced);
  // Looking through the far arc must draw its real tile, while looking in
  // the opposite direction can omit both its colour and redundant depth work.
  const distant=farMeshes.reduce((best,m)=>m.material.uniforms.uHaloTileCameraCenter.value.lengthSq()>
    best.material.uniforms.uHaloTileCameraCenter.value.lengthSq()?m:best);
  const target=distant.material.uniforms.uHaloTileCameraCenter.value.clone();
  frame.camera.lookAt(target);group.userData.update(frame);assert.equal(distant.visible,true);
  frame.camera.lookAt(target.negate());group.userData.update(frame);assert.equal(distant.visible,false);
  assert.equal(group.userData.haloTerrainStats.builds,oldBuilds+1,'turning the camera consumes the same ready terrain');



 }finally{group.userData.dispose();assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pinnedFields,0);registry.dispose();}
});

test('an ordinary seeded reach follows the physical terrain across region seams and responds to celestial time',async()=>{
 const source=describeCosmicBody({x:-28,y:30,z:-22},'lonely-universe-v2','regions');
 const recipe=source.habitat.terrainRecipes.find(r=>r.siteIndex===17),field=createRingHabitatField(recipe);
 const x=59600,seam=6656,point=[0,0,0],water={};
 let lastProgress=0;
 for(const y of [6864,seam,6624,4816,4640,4608]){
  assert.ok(field.sampleRiver(x,y,water)&&water.distance<.6,'the same narrow channel reaches the shoreline');
  assert.ok(water.progressL>lastProgress&&water.tangentY<-.9,'the sampled direction leads to the coast');
  lastProgress=water.progressL;
 }
 assert.ok(field.sampleHeight(x,4640)>12&&field.sampleHeight(x,4608)<12);
 assert.equal(field.sampleRiver(x+320,seam,water),false);
 assert.equal(createRingHabitatField({...recipe,climate:2}).sampleRiver(x,seam,water),false);
 field.position(x,seam,point);
 const angle=recipe.minAngle+x/recipe.innerRadius;
 const body={...source,frame:identity,center:[-point[0]+Math.cos(angle)*400,-point[1],-point[2]+Math.sin(angle)*400],habitat:{...source.habitat,terrainRecipes:[recipe]}};
 const registry=createRingHabitatRegions({parentsInBounds:()=>[body]}),group=createCosmicBodies({haloTerrain:registry});
 const camera=new THREE.PerspectiveCamera(65,1.6,.5,220000),frame={bodies:[body],camera,viewportHeight:800,celestialTime:129};
 try{
  await group.userData.prepareTerrain(frame);group.userData.update(frame);
  const owner=group.children.find(child=>child.name==='Canonical habitat regions');
  const riverTiles=owner.children.filter(mesh=>mesh.geometry.hasAttribute('haloRiver'));
  const seamValues=[];
  for(const mesh of riverTiles){
   const canonical=mesh.userData.canonicalMesh,b=canonical.chartBounds,river=mesh.geometry.getAttribute('haloRiver');
   assert.deepEqual(mesh.material.defines,{HALO_RIVER:1});
   assert.equal(mesh.material.uniforms.uHaloRiverTime.value,1);
   if(x<b.minX||x>b.maxX||seam<b.minY||seam>b.maxY)continue;
   const i=(x-b.minX)/16,j=(seam-b.minY)/16;
   const corner=canonical.faces.slice(0,canonical.topFaces).flat().findIndex(k=>canonical.vertexUV[k][0]===i&&canonical.vertexUV[k][1]===j);
   assert.ok(corner>=0);assert.equal(river.getX(canonical.topFaces*3),2,'foundation faces remain dry');
   seamValues.push([river.getX(corner),river.getY(corner),river.getZ(corner),river.getW(corner)]);
  }
  assert.equal(seamValues.length,2);assert.deepEqual(seamValues[0],seamValues[1]);assert.ok(seamValues[0][0]<.5);
  frame.celestialTime=132;group.userData.update(frame);
  for(const mesh of riverTiles){
   assert.equal(mesh.material.uniforms.uHaloRiverTime.value,4);
   assert.equal(mesh.geometry.getAttribute('haloRiver').version,0);
  }
 }finally{group.userData.dispose();assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pinnedFields,0);registry.dispose();}
});

class RendererProbe{
  constructor(reversed=false){
    this.capabilities={reversedDepthBuffer:reversed,isWebGL2:false,maxTextureSize:0};this.extensions={has:()=>true};this.xr={enabled:true};this.autoClear=true;
    this.target=null;this.face=0;this.mip=0;this.color=new THREE.Color(.2,.3,.4);this.alpha=.7;
    this.viewport=new THREE.Vector4(3,5,700,500);this.scissor=new THREE.Vector4(7,9,450,300);this.scissorTest=true;
    this.actualViewport=new THREE.Vector4(6,10,1400,1000);this.actualScissor=new THREE.Vector4(14,18,900,600);this.actualScissorTest=false;
    this.state={viewport:v=>this.actualViewport.copy(v),scissor:v=>this.actualScissor.copy(v),setScissorTest:v=>{this.actualScissorTest=v;}};
    this.stateReads=0;
    this.gl={SCISSOR_BOX:1,SCISSOR_TEST:2,getParameter:()=>{this.stateReads++;return this.actualScissor.toArray();},isEnabled:()=>this.actualScissorTest};
    this.renders=0;this.fail=false;this.draw=null;this.draws=[];
  }
  getDrawingBufferSize(out){return out.set(1600,1000);}
  getContext(){return this.gl;}
  getRenderTarget(){return this.target;}
  getActiveCubeFace(){return this.face;}
  getActiveMipmapLevel(){return this.mip;}
  getClearColor(out){return out.copy(this.color);}
  getClearAlpha(){return this.alpha;}
  getViewport(out){return out.copy(this.viewport);}
  getCurrentViewport(out){return out.copy(this.actualViewport);}
  getScissor(out){return out.copy(this.scissor);}
  getScissorTest(){return this.scissorTest;}
  setViewport(v){this.viewport.copy(v);this.actualViewport.copy(v).multiplyScalar(2);}
  setScissor(v){this.scissor.copy(v);this.actualScissor.copy(v).multiplyScalar(2);}
  setScissorTest(v){this.scissorTest=v;this.actualScissorTest=v;}
  setClearColor(v,a){this.color.set(v);this.alpha=a;}
  setRenderTarget(target,face=0,mip=0){
    this.target=target;this.face=face;this.mip=mip;
    if(target){this.actualViewport.copy(target.viewport);this.actualScissor.copy(target.scissor);this.actualScissorTest=target.scissorTest;}
    else{this.actualViewport.copy(this.viewport).multiplyScalar(2);this.actualScissor.copy(this.scissor).multiplyScalar(2);this.actualScissorTest=this.scissorTest;}
  }
  clear(color,depth,stencil){assert.deepEqual([color,depth,stencil],[true,true,false]);}
  render(scene,camera){
    this.renders++;this.draw={scene,camera,target:this.target,mesh:scene.children[0]};this.draws.push(this.draw);
    assert.equal(this.xr.enabled,false);assert.equal(this.autoClear,false);assert.equal(this.actualScissorTest,false);
    if(this.fail||this.renders===this.failAt)throw new Error('shadow render failed');
  }
  snapshot(){
    return {target:this.target,face:this.face,mip:this.mip,color:this.color.toArray(),alpha:this.alpha,xr:this.xr.enabled,autoClear:this.autoClear,
      viewport:this.viewport.toArray(),scissor:this.scissor.toArray(),scissorTest:this.scissorTest,
      actualViewport:this.actualViewport.toArray(),actualScissor:this.actualScissor.toArray(),actualScissorTest:this.actualScissorTest};
  }
}

test('game terrain depth uses renderer-owned scissor across target restore and draw failure',async()=>{
  const {body,frame}=fixture(),registry=createRingHabitatRegions({parentsInBounds:()=>[body]});
  const group=createCosmicBodies({haloTerrain:registry,haloTargetOwnsScissor:true}),renderer=new RendererProbe();
  const target=new THREE.WebGLRenderTarget(200,120);
  target.viewport.set(5,6,130,80);target.scissor.set(12,14,100,60);target.scissorTest=true;
  try{
    await group.userData.prepareTerrain(frame);group.userData.update(frame);
    const depth=group.children.find(m=>m.name==='Canonical habitat regions').userData.prepareDepth;
    for(const activeTarget of [null,target]){
      renderer.setRenderTarget(activeTarget);
      const before=renderer.snapshot();
      depth(renderer,frame.camera);
      assert.deepEqual(renderer.snapshot(),before);
      renderer.fail=true;
      assert.throws(()=>depth(renderer,frame.camera),/shadow render failed/);
      assert.deepEqual(renderer.snapshot(),before);
      renderer.fail=false;
    }
    assert.equal(renderer.stateReads,0);
    assert.equal(group.userData.haloTerrainStats.depthRenders,2);
  }finally{group.userData.dispose();registry.dispose();target.dispose();}
});

test('canonical pull shadows retain IDs and borrowed view geometry across reuse, context recovery, failures and disposal',async()=>{
 const {body,frame}=fixture(),registry=createRingHabitatRegions({parentsInBounds:()=>[body]}),group=createCosmicBodies({haloTerrain:registry}),renderer=new RendererProbe(),disposed=new Map(),pullDisposed=new Map(),viewDisposed=new Map(),tables=new Map();
 function observe(map,object){if(map.has(object))return;map.set(object,0);object.addEventListener('dispose',()=>map.set(object,map.get(object)+1));}
 function checkPulls(owner,receiver){
  const byFirst=new Map(owner.children.map(m=>[m.material.uniforms.uHaloFirstShadowVertex.value,m]));let corners=0;
  for(const caster of renderer.draws.at(-1).scene.children){if(caster.name!=='Canonical terrain shadow caster')continue;const u=caster.material.uniforms,first=u.uTerrainFirstVertex.value,source=byFirst.get(first);assert.ok(source);assert.equal(u.uTerrainFirstVertex,source.material.uniforms.uHaloFirstShadowVertex,'caster borrows the authoritative ID offset record');assert.equal(u.uTerrainTriangles,receiver.uVegetationShadowTriangles);assert.equal(Object.keys(caster.geometry.attributes).length,0);assert.equal(caster.geometry.index,null);assert.equal(caster.geometry.drawRange.start,0);const count=source.geometry.index?.count??source.geometry.attributes.position.count;assert.equal(caster.geometry.drawRange.count,count);assert.equal(first%3,0);const image=receiver.uVegetationShadowTriangles.value.image;for(let corner=first;corner<first+count;corner++){const address=image.data[Math.floor(corner/3)*4+corner%3];assert.ok(Number.isInteger(address)&&address>=group.userData.haloShadowStats.terrainFaces&&address<image.width*image.height);}corners+=count;observe(pullDisposed,caster.geometry);}
  assert.equal(corners,owner.children.reduce((n,m)=>n+(m.geometry.index?.count??m.geometry.attributes.position.count),0));assert.equal(group.userData.haloShadowStats.terrainFaces,corners/3);
 }
 try{
  await group.userData.prepareTerrain(frame);group.userData.update(frame);const owner=group.children.find(m=>m.name==='Canonical habitat regions'),receiver=group.children.find(m=>m.name==='Cosmic solid surface').material.uniforms,views=owner.children.map(m=>m.geometry),before=renderer.snapshot();for(const g of views)observe(viewDisposed,g);group.userData.prepare(renderer);
  assert.deepEqual(renderer.snapshot(),before);assert.equal(group.userData.shadowMapCount,2);assert.equal(group.userData.haloShadowStats.mapBytes,2048*2048*12*2);assert.ok(group.userData.haloShadowStats.instances>0);assert.ok(receiver.uVegetationShadowTriangles.value.image.width<=2048&&receiver.uVegetationShadowTriangles.value.image.height<=2048);observe(tables,receiver.uVegetationShadowTriangles.value);checkPulls(owner,receiver);
  const targets=new Set(renderer.draws.map(d=>d.target));assert.equal(targets.size,3,'one terrain depth and two RG32F shadow cascades for the view');for(const t of targets)observe(disposed,t);
  const shadows=group.userData.haloShadowStats.renders;group.userData.prepare(renderer);assert.equal(group.userData.haloShadowStats.renders,shadows,'stationary shadow maps reuse contents');assert.deepEqual(renderer.snapshot(),before);
  group.userData.invalidateGpuCaches();for(const count of pullDisposed.values())assert.equal(count,1);for(const count of disposed.values())assert.equal(count,1);for(const count of tables.values())assert.equal(count,1);for(const count of viewDisposed.values())assert.equal(count,0,'context retirement preserves shared view buffers');
  group.userData.update(frame);group.userData.prepare(renderer);assert.deepEqual(owner.children.map(m=>m.geometry),views);checkPulls(owner,receiver);observe(tables,receiver.uVegetationShadowTriangles.value);for(const draw of renderer.draws)observe(disposed,draw.target);assert.deepEqual(renderer.snapshot(),before);
  renderer.fail=true;assert.throws(()=>group.userData.prepare(renderer),/shadow render failed/);assert.deepEqual(renderer.snapshot(),before);renderer.fail=false;group.userData.prepare(renderer);assert.equal(group.userData.shadowMapCount,2);
 }finally{
  group.userData.dispose();group.userData.dispose();for(const map of [disposed,pullDisposed,viewDisposed,tables])for(const n of map.values())assert.equal(n,1);assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pinnedFields,0);registry.dispose();
 }
});
