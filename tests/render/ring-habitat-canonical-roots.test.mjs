import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRingHabitatVegetation} from '../../src/render/ring-habitat-vegetation.js';
import {createRingHabitatGroundcover} from '../../src/render/ring-habitat-groundcover.js';
import {createRingHabitatRegions,HaloTerrainUnavailable} from '../../src/ring-habitat-regions.js';
import {createMeshTerrainWorkspace,meshTerrainDistance} from '../../src/mesh-terrain.js';

function field(recipe){
  const height=(x,y)=>120+1.8*Math.sin(x/31)+.7*Math.sin(y/23);
  return {statistics:{accountedBytes:512},innerRadius:recipe.innerRadius,minAngle:recipe.minAngle,minY:recipe.minY,bounds:{minX:0,minY:0,maxX:1103,maxY:523},hmin:117.5,hmax:122.5,
    position(x,y,out){const a=recipe.minAngle+x/recipe.innerRadius,r=recipe.innerRadius-height(x,y);out[0]=r*Math.cos(a);out[1]=recipe.minY+y;out[2]=r*Math.sin(a);return out;},
    normal(x,y,out){const a=recipe.minAngle+x/recipe.innerRadius,q=1-height(x,y)/recipe.innerRadius,hx=1.8/31*Math.cos(x/31),hy=.7/23*Math.cos(y/23);
      out[0]=-q*Math.cos(a)+hx*Math.sin(a);out[1]=-q*hy;out[2]=-q*Math.sin(a)-hx*Math.cos(a);const length=Math.hypot(...out);for(let i=0;i<3;i++)out[i]/=length;return out;}};
}
async function fixture(createField=field){
  const recipe={version:'halo-field-v1',siteIndex:7,innerRadius:100000,depth:100,minAngle:0,maxAngle:1103/100000,minY:0,maxY:523};
  const body={id:'canonical-roots',kind:'ring',phase:1.3,theme:'silver-dust',frame:[1,0,0,0,1,0,0,0,1],light:[.4,.8,.2],center:[0,0,0],shape:{parts:[{innerRadius:100000}],terrainGroups:[]},habitat:{terrainRecipes:[recipe],climate:0,ecology:{treeDensity:.9,forestCeiling:500}}};
  const registry=createRingHabitatRegions({parentsInBounds:()=>[body],createField});
  let acquisitions=0;const binding={get revision(){return registry.revision;},acquireField(body,site){acquisitions++;return registry.acquireField(body,site);},
    samplePreparedTop(body,site,x,y,point,normal,face,info){return registry.samplePreparedTop(body,site,x,y,point,normal,face,info);}};
  const ready=await registry.prepareField(body,7);ready.release();
  const p=[0,0,0];field(recipe).position(1000,490,p);const radial=Math.hypot(p[0],p[2]);body.center=[-p[0]*(1-8/radial),-p[1],-p[2]*(1-8/radial)];
  const camera=new THREE.PerspectiveCamera(65,1.6,.5,220000),trees=createRingHabitatVegetation({terrainRegistry:binding}),grass=createRingHabitatGroundcover({terrainRegistry:binding});
  const frame={body,camera,viewportHeight:1000,pixelRatio:1},update=()=>{trees.userData.update(frame);grass.userData.update(frame);};
  return {body,recipe,registry,trees,grass,frame,update,get acquisitions(){return acquisitions;},dispose(){trees.userData.dispose();grass.userData.dispose();registry.dispose();}};
}

test('canonical trees and grass share physical clipped-cell roots and normals without loading distant BVHs',async()=>{
  const f=await fixture();let regions=null;
  try{
    f.update();assert.ok(f.trees.userData.stats.instances>50);assert.ok(f.grass.userData.stats.instances>100);
    assert.equal(f.registry.stats.regionsBuilt,0,'root generation borrows the canonical field without constructing physical region meshes');
    assert.equal(f.registry.stats.pinnedFields,1);assert.equal(f.acquisitions,2);
    const addresses=[];for(let y=0;y<3;y++)for(let x=0;x<5;x++)addresses.push({siteIndex:7,tileX:x,tileY:y});
    regions=await f.registry.prepareRegions(f.body,addresses);
    const samples=[{geometry:f.trees.userData.shadowMesh.geometry,count:f.trees.userData.stats.instances,kind:'tree'},{geometry:f.grass.userData.mesh.geometry,count:f.grass.userData.stats.instances,kind:'grass'}];
    const point=new THREE.Vector3(),normal=new THREE.Vector3(),flat=new THREE.Vector3(),info={},work=createMeshTerrainWorkspace(),distanceOut={normal:[0,0,0]};
    let clippedTrees=0,clippedGrass=0;
    for(const sample of samples){
      const roots=sample.geometry.attributes.iRoot.array,normals=sample.geometry.attributes.iGroundNormal.array;
      for(let i=0;i<sample.count;i++){
        const at=i*3,x=roots[at],y=roots[at+1],z=roots[at+2],chartX=Math.atan2(z,x)*f.recipe.innerRadius;
        assert.equal(f.registry.sampleTop(f.body,7,chartX,y,point,normal,flat,info),true);
        assert.ok(Math.hypot(point.x-x,point.y-y,point.z-z)<.012,`${sample.kind} root matches the physical triangle sampler`);
        assert.ok(normal.x*normals[at]+normal.y*normals[at+1]+normal.z*normals[at+2]>.999999,`${sample.kind} consumes the physical interpolated normal`);
        const tx=Math.floor(chartX/256),ty=Math.floor(y/256),region=regions.regions.find(r=>r.tileX===tx&&r.tileY===ty);
        assert.notEqual(meshTerrainDistance(region.mesh,x,y,z,distanceOut,work),false);assert.ok(Math.sqrt(work.closest.squared)<.012);
        if(chartX>1088){if(sample.kind==='tree')clippedTrees++;else clippedGrass++;}
      }
    }
    assert.ok(clippedTrees>0,'tree fixture reaches the shortened final16L cell');assert.ok(clippedGrass>0,'grass fixture reaches the shortened final16L cell');
  }finally{regions?.release();f.dispose();}
});

test('river banks exclude canonical tree and grass roots while retaining adjacent cover',async()=>{
  function sampleRiver(x,y,out){out.distance=Math.abs(y-450)/32;return out.distance<2;}
  const f=await fixture(recipe=>({...field(recipe),sampleRiver})),dry=await fixture();
  try{
    f.update();dry.update();
    const pairs=[[f.trees.userData.shadowMesh.geometry,dry.trees.userData.shadowMesh.geometry],
      [f.grass.userData.mesh.geometry,dry.grass.userData.mesh.geometry]];
    for(const [wet,dry] of pairs){
      const count=wet.instanceCount,roots=wet.attributes.iRoot.array,previous=dry.attributes.iRoot.array;
      assert.ok(count>0&&count<dry.instanceCount);
      assert.ok(Array.from({length:dry.instanceCount},(_,i)=>previous[i*3+1]).some(y=>Math.abs(y-450)<32));
      for(let i=0;i<count;i++)assert.ok(Math.abs(roots[i*3+1]-450)>=32-.001);
    }
  }finally{f.dispose();dry.dispose();}
});

test('warm canonical roots reuse buffers and field leases; revision failure publishes no partial roots and reentry is deterministic',async()=>{
  const f=await fixture();
  try{
    f.update();const tree=f.trees.userData.shadowMesh.geometry,grass=f.grass.userData.mesh.geometry,treeRoots=tree.attributes.iRoot.array.slice(),grassRoots=grass.attributes.iRoot.array.slice();
    const treeRebuilds=f.trees.userData.stats.rebuilds,grassRebuilds=f.grass.userData.stats.rebuilds,treeVersion=tree.attributes.iRoot.version,grassVersion=grass.attributes.iRoot.version;
    for(let i=0;i<20;i++)f.update();
    assert.equal(f.acquisitions,2);assert.equal(f.trees.userData.stats.rebuilds,treeRebuilds);assert.equal(f.grass.userData.stats.rebuilds,grassRebuilds);
    assert.equal(tree.attributes.iRoot.version,treeVersion);assert.equal(grass.attributes.iRoot.version,grassVersion);
    f.registry.clear();assert.equal(f.registry.stats.retiredFields,1);
    assert.throws(()=>f.trees.userData.update(f.frame),error=>error instanceof HaloTerrainUnavailable&&error.code==='halo-field-unavailable');
    assert.throws(()=>f.grass.userData.update(f.frame),error=>error instanceof HaloTerrainUnavailable&&error.code==='halo-field-unavailable');
    assert.equal(f.trees.visible,false);assert.equal(f.grass.visible,false);assert.equal(f.trees.userData.stats.instances,0);assert.equal(f.grass.userData.stats.instances,0);
    assert.equal(f.registry.stats.pinnedFields,0);assert.equal(f.registry.stats.retiredFields,0);assert.equal(f.registry.stats.accountedBytes,0);
    const ready=await f.registry.prepareField(f.body,7);ready.release();f.update();
    assert.deepEqual(tree.attributes.iRoot.array,treeRoots);assert.deepEqual(grass.attributes.iRoot.array,grassRoots);
    f.trees.userData.update({...f.frame,body:null});assert.equal(f.registry.stats.pinnedFields,1,'grass retains its independent lease');
    f.grass.userData.clear();assert.equal(f.registry.stats.pinnedFields,0);
    f.update();assert.equal(f.registry.stats.pinnedFields,1);f.trees.userData.dispose();f.trees.userData.dispose();assert.equal(f.registry.stats.pinnedFields,1);
    f.grass.userData.dispose();f.grass.userData.dispose();assert.equal(f.registry.stats.pinnedFields,0);assert.equal(f.registry.stats.disposed,false,'registry ownership stays with the world');
  }finally{f.dispose();}
});

test('a cold second nearby field releases already acquired leases and preserves explicit readiness failure',async()=>{
  const f=await fixture();
  try{
    f.trees.userData.update(f.frame);assert.ok(f.trees.userData.stats.instances>0);
    f.body.habitat.terrainRecipes=[f.recipe,{...f.recipe,siteIndex:8}];
    assert.throws(()=>f.trees.userData.update(f.frame),error=>error instanceof HaloTerrainUnavailable&&error.code==='halo-field-unavailable');
    assert.equal(f.registry.stats.pinnedFields,0);assert.equal(f.trees.userData.stats.instances,0);assert.equal(f.trees.visible,false);
    const ready=await f.registry.prepareField(f.body,8);ready.release();f.trees.userData.update(f.frame);
    assert.ok(f.trees.userData.stats.instances>0);assert.equal(f.registry.stats.pinnedFields,2);
    f.trees.userData.update({...f.frame,body:null});assert.equal(f.registry.stats.pinnedFields,0);
  }finally{f.dispose();}
});

test('canonical shadow roots preserve uploaded root precision and update only for their anchor or packed root version',async()=>{
  const f=await fixture();
  try{
    f.update();const lods=f.trees.userData.lodMeshes,anchor=new THREE.Vector3(99800.123456789,490.234567891,1000.345678912);
    const buffers=lods.map(mesh=>mesh.geometry.attributes.iShadowRoot.array);
    const verify=()=>{for(const mesh of lods){const g=mesh.geometry,roots=g.attributes.iRoot.array,relative=g.attributes.iShadowRoot.array;for(let i=0;i<g.instanceCount;i++){
      const at=i*3;assert.equal(relative[at],Math.fround(roots[at]-anchor.x));assert.equal(relative[at+1],Math.fround(roots[at+1]-anchor.y));assert.equal(relative[at+2],Math.fround(roots[at+2]-anchor.z));
    }}};
    f.trees.userData.updateShadowAnchor(anchor);verify();
    const versions=lods.map(mesh=>mesh.geometry.attributes.iShadowRoot.version),uploads=f.trees.userData.stats.shadowAnchorUploads;
    for(let i=0;i<20;i++)f.trees.userData.updateShadowAnchor(anchor);
    assert.deepEqual(lods.map(mesh=>mesh.geometry.attributes.iShadowRoot.version),versions);assert.equal(f.trees.userData.stats.shadowAnchorUploads,uploads);
    anchor.x+=.000001;f.trees.userData.updateShadowAnchor(anchor);verify();
    assert.ok(lods.every((mesh,i)=>mesh.geometry.attributes.iShadowRoot.array===buffers[i]));
    f.body.center[1]-=48;f.trees.userData.update(f.frame);const before=lods.map(mesh=>mesh.geometry.attributes.iShadowRoot.version);f.trees.userData.updateShadowAnchor(anchor);verify();
    assert.ok(lods.some((mesh,i)=>mesh.geometry.attributes.iShadowRoot.version>before[i]),'a packed-root upload invalidates the same-anchor relative buffer');
  }finally{f.dispose();}
});
