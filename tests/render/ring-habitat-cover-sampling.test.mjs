import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRingHabitat} from '../../src/ring-habitat.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';
import {createRingHabitatRegions} from '../../src/ring-habitat-regions.js';
import {RING_HABITAT_REGION_SIZE_L} from '../../src/ring-habitat-field.js';
import {createRingHabitatGroundcover} from '../../src/render/ring-habitat-groundcover.js';
import {createRingHabitatVegetation} from '../../src/render/ring-habitat-vegetation.js';

// An ordinary seeded low shoulder, with enough visible grass and trees to catch
// placement/lighting changes. No QA loader or alternate field is involved.
async function fixture(){
  const input={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture',terrainMode:'regions'};
  input.parts=cosmicRingParts(input);const habitat=createRingHabitat(input),recipe=habitat.terrainRecipes[22];
  const body={id:'canonical-cover-reuse',kind:'ring',position:[0,0,0],center:[0,0,0],frame:[1,0,0,0,1,0,0,0,1],light:[.4,.8,.2],shape:{parts:input.parts,terrainGroups:[]},habitat:{...habitat,terrainRecipes:[recipe]}};
  const registry=createRingHabitatRegions({parentsInBounds:()=>[]}),borrow=await registry.prepareField(body,recipe.siteIndex),field=borrow.field;
  const x=field.bounds.maxX/3,y=field.bounds.maxY*5/6,p=[0,0,0];field.position(x,y,p);const radius=Math.hypot(p[0],p[2]);
  body.center=[-p[0]*(1-8/radius),-p[1],-p[2]*(1-8/radius)];borrow.release();
  return {body,registry,x,y,field};
}
function attributes(group){
  const meshes=group.userData.lodMeshes??[group.userData.mesh];
  return meshes.map(mesh=>({count:mesh.geometry.instanceCount,attributes:Object.fromEntries(Object.entries(mesh.geometry.attributes).filter(([,a])=>a.isInstancedBufferAttribute).map(([key,a])=>[key,a.array.slice(0,mesh.geometry.instanceCount*a.itemSize)]))}));
}

test('visible seeded cover keeps identical buffers through mesh/fallback and clear/reentry',async()=>{
  const {body,registry,x,y,field}=await fixture(),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000),grass=createRingHabitatGroundcover({terrainRegistry:registry}),trees=createRingHabitatVegetation({terrainRegistry:registry});
  let lease;
  const update=()=>{for(const g of [grass,trees])g.userData.update({body,camera,viewportHeight:1000,pixelRatio:1});};
  try{
    update();const before=[attributes(grass),attributes(trees)],counts=[grass.userData.stats.instances,trees.userData.stats.instances];
    assert.ok(counts[0]>50&&counts[1]>50,'both owners produce an eligible visible population');
    const roots=grass.userData.mesh.geometry.attributes.iRoot.array;let fullyVisible=0;
    for(let i=0;i<counts[0];i++)if(Math.hypot(roots[i*3]+body.center[0],roots[i*3+1]+body.center[1],roots[i*3+2]+body.center[2])<100)fullyVisible++;
    assert.ok(fullyVisible>20,'positive control includes distance-resolved foreground grass');
    // The prepared footprint covers the complete 180L grass support. Trees
    // deliberately straddle it, exercising prepared and fallback in one update.
    const size=RING_HABITAT_REGION_SIZE_L,addresses=[];
    for(let ty=Math.max(0,Math.floor((y-256)/size));ty<=Math.floor((y+256)/size);ty++)for(let tx=Math.max(0,Math.floor((x-256)/size));tx<=Math.floor((x+256)/size);tx++)if(tx*size<field.bounds.maxX&&ty*size<field.bounds.maxY)addresses.push({siteIndex:22,tileX:tx,tileY:ty});
    lease=await registry.prepareRegions(body,addresses);
    // Replacing the borrowed recipe list with identical entries forces both
    // owners to rebuild at the same point, now using the prepared pages.
    const rebuilds=[grass.userData.stats.rebuilds,trees.userData.stats.rebuilds];
    body.habitat.terrainRecipes=body.habitat.terrainRecipes.slice();update();
    assert.deepEqual([grass.userData.stats.rebuilds,trees.userData.stats.rebuilds],rebuilds.map(n=>n+1));
    assert.deepEqual([attributes(grass),attributes(trees)],before);assert.deepEqual([grass.userData.stats.instances,trees.userData.stats.instances],counts);
    lease.release();registry.clear();const fieldLease=await registry.prepareField(body,22);fieldLease.release();update();assert.deepEqual([attributes(grass),attributes(trees)],before);
    const revision=grass.userData.mesh.geometry.attributes.iRoot.version;update();assert.equal(grass.userData.mesh.geometry.attributes.iRoot.version,revision,'unchanged camera does not add a rebuild');
  }finally{grass.userData.dispose();trees.userData.dispose();lease?.release();registry.dispose();assert.equal(registry.stats.accountedBytes,0);assert.equal(registry.stats.pinnedFields,0);assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pendingJobs,0);assert.equal(grass.children.length,0);assert.equal(trees.children.length,0);}
});
