import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRingHabitatGroundcover} from '../../src/render/ring-habitat-groundcover.js';
import {createRingHabitat} from '../../src/ring-habitat.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';
import {RING_HABITAT_ROCK_SLOPE_START,RING_HABITAT_MEADOW_PALETTES} from '../../src/render/ring-habitat-surface.js';
import {sampleRingHabitatTop} from '../../src/ring-habitat-sampling.js';
import {createMeshTerrainWorkspace,meshTerrainDistance} from '../../src/mesh-terrain.js';
import {createRingHabitatShadowUniforms} from '../../src/render/ring-habitat-shadow-receiver.js';

const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-groundcover-fixture'};
const parts=cosmicRingParts(options),habitat=createRingHabitat({...options,parts}),inner=parts[0].innerRadius;
function fixture(shadowUniforms){
  const group=createRingHabitatGroundcover({shadowUniforms}),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  const body={id:options.seed,kind:'ring',phase:options.phase,frame:[1,0,0,0,1,0,0,0,1],light:[.4,.8,.2],center:[0,0,0],shape:{parts,terrainGroups:habitat.terrainGroups},habitat:{ecology:habitat.ecology}};
  let selected=false;
  for(const patch of habitat.terrainGroups){
    for(let i=0;i<patch.topGrid.columns*patch.topGrid.rows;i++){
      const v=patch.vertices[i],x=v[0]+patch.center[0],y=v[1]+patch.center[1],z=v[2]+patch.center[2],r=Math.hypot(x,z),n=patch.normals[i];
      if(inner-r>100&&inner-r<400&&-(n[0]*x+n[2]*z)/r>.98&&patch.surfaceKinds[i]<.1){
        body.center=[-x*(1-8/r),-y,-z*(1-8/r)];selected=true;break;
      }
    }
    if(selected)break;
  }
  assert.ok(selected);
  const update=()=>group.userData.update({body,camera,viewportHeight:1000,pixelRatio:1});
  return {group,body,camera,update};
}

test('bounded body-fixed roots lie on retained physical triangles and use their normals',()=>{
  const {group,body,update}=fixture(),other=fixture();
  try{
    update();other.update();
    const g=group.userData.mesh.geometry,roots=g.attributes.iRoot.array,normals=g.attributes.iGroundNormal.array;
    assert.ok(g.instanceCount>100&&g.instanceCount<=8192);assert.equal(g.attributes.position.count,18);
    assert.deepEqual(roots,other.group.userData.mesh.geometry.attributes.iRoot.array);
    assert.deepEqual(g.attributes.iShape.array,other.group.userData.mesh.geometry.attributes.iShape.array);
    const workspace=createMeshTerrainWorkspace(),out={point:[0,0,0],normal:[0,0,0]},p=new THREE.Vector3(),n=new THREE.Vector3(),f=new THREE.Vector3(),info={rockCoverage:0};
    for(let i=0;i<g.instanceCount;i+=Math.max(1,Math.floor(g.instanceCount/80))){
      const at=i*3,x=roots[at],y=roots[at+1],z=roots[at+2],r=Math.hypot(x,z),angle=Math.atan2(z,x);
      let nearest=Infinity,matched=false;
      for(const patch of body.shape.terrainGroups){
        if(Math.hypot(x-patch.center[0],y-patch.center[1],z-patch.center[2])>patch.radius+1)continue;
        assert.notEqual(meshTerrainDistance(patch,x,y,z,out,workspace),false);nearest=Math.min(nearest,Math.sqrt(workspace.closest.squared));
        if(sampleRingHabitatTop(patch,angle,y,p,n,f,info)&&p.distanceTo(new THREE.Vector3(x,y,z))<.1){
          assert.ok(n.dot(new THREE.Vector3().fromArray(normals,at))>.9999);assert.ok(info.rockCoverage<=.0201);
          const upright=-(n.x*x+n.z*z)/r,steepness=Math.sqrt(Math.max(0,1-upright*upright))/Math.max(upright,.08);
          assert.ok(steepness<RING_HABITAT_ROCK_SLOPE_START+1e-5);matched=true;
        }
      }
      assert.ok(nearest<.08);assert.ok(matched);assert.ok(inner-r>11.9&&inner-r<habitat.ecology.forestCeiling+.1);
      assert.ok(g.attributes.iShape.array[at]>=.35&&g.attributes.iShape.array[at]<=1.2);
    }
  }finally{group.userData.dispose();other.group.userData.dispose();}
});

test('terrain classification and ecology recipe exclude bare rock and ineligible ground',()=>{
  const {group,body,update}=fixture();
  try{
    update();assert.ok(group.userData.stats.instances>0);
    const original=body.shape.terrainGroups;
    body.shape.terrainGroups=original.map(p=>({...p,surfaceKinds:new Array(p.vertices.length).fill(1)}));update();
    assert.equal(group.userData.stats.instances,0);
    body.shape.terrainGroups=original;body.habitat={ecology:{...habitat.ecology,forestCeiling:12}};update();
    assert.equal(group.userData.stats.instances,0);
    body.habitat={ecology:{...habitat.ecology,treeDensity:0}};update();assert.equal(group.userData.stats.instances,0);
  }finally{group.userData.dispose();}
});

test('grass uses the material smooth-normal rock threshold as well as physical standing',()=>{
  const {group,body,update}=fixture();
  const original=body.shape.terrainGroups;
  function classified(slope,rockCoverage){
    return original.map(patch=>({...patch,surfaceKinds:new Array(patch.vertices.length).fill(rockCoverage),
      normals:patch.vertices.map(v=>{
        const x=v[0]+patch.center[0],z=v[2]+patch.center[2],r=Math.hypot(x,z),upright=1/Math.sqrt(1+slope*slope);
        return [-x/r*upright,slope*upright,-z/r*upright];
      })}));
  }
  try{
    body.shape.terrainGroups=classified(0,0);update();const flatCount=group.userData.stats.instances;assert.ok(flatCount>100);
    body.shape.terrainGroups=classified(RING_HABITAT_ROCK_SLOPE_START-.005,0);update();
    assert.equal(group.userData.stats.instances,flatCount,'natural side of material threshold retains standing candidates');
    body.shape.terrainGroups=classified(RING_HABITAT_ROCK_SLOPE_START+.005,0);update();
    assert.equal(group.userData.stats.instances,0,'material-exposed slope has no grass despite unchanged shallow physical faces');
    body.shape.terrainGroups=classified(0,.021);update();assert.equal(group.userData.stats.instances,0,'bare-rock transition excludes grass');
    body.shape.terrainGroups=classified(0,.019);update();assert.equal(group.userData.stats.instances,flatCount);
  }finally{group.userData.dispose();}
});

test('stationary and within-tile camera changes retain geometry, world sizes and upload versions',()=>{
  const {group,body,camera,update}=fixture();
  try{
    update();const mesh=group.userData.mesh,g=mesh.geometry,versions=Object.values(g.attributes).map(a=>a.version),roots=g.attributes.iRoot.array.slice(),shapes=g.attributes.iShape.array.slice();
    const rebuilds=group.userData.stats.rebuilds,pixelAngle=mesh.material.uniforms.uPixelAngle.value,cameraBefore=group.userData.cameraLocal.clone();
    for(let i=0;i<20;i++)update();
    assert.equal(group.userData.stats.rebuilds,rebuilds);assert.deepEqual(Object.values(g.attributes).map(a=>a.version),versions);
    // Radial motion changes shader distance without changing the angular tile.
    body.center[0]*=1-1e-6;body.center[2]*=1-1e-6;update();
    camera.fov=90;camera.updateProjectionMatrix();update();
    assert.equal(group.userData.stats.rebuilds,rebuilds);assert.deepEqual(g.attributes.iRoot.array,roots);assert.deepEqual(g.attributes.iShape.array,shapes);
    assert.notEqual(mesh.material.uniforms.uPixelAngle.value,pixelAngle);
    assert.ok(group.userData.cameraLocal.distanceTo(cameraBefore)>.1);
    body.center[1]-=32;update();assert.equal(group.userData.stats.rebuilds,rebuilds+1);
  }finally{group.userData.dispose();}
});

test('camera tile rebuild retains overlapping roots and leaf sizes in body space',()=>{
  const {group,body,update}=fixture();
  try{
    update();const g=group.userData.mesh.geometry,old=new Map();
    for(let i=0;i<g.instanceCount;i++){
      const at=i*3;old.set(g.attributes.iRoot.array.subarray(at,at+3).join(','),Array.from(g.attributes.iShape.array.subarray(at,at+3)));
    }
    body.center[1]-=32;update();let overlap=0;
    for(let i=0;i<g.instanceCount;i++){
      const at=i*3,shape=old.get(g.attributes.iRoot.array.subarray(at,at+3).join(','));
      if(shape){overlap++;assert.deepEqual(Array.from(g.attributes.iShape.array.subarray(at,at+3)),shape);}
    }
    assert.ok(overlap>old.size*.65,'moving the generation window does not reseed its retained interior');
  }finally{group.userData.dispose();}
});

test('all climate palettes change only shared grass colors while retaining roots and buffers',()=>{
  const {group,body,camera,update}=fixture();
  try{
    update();const mesh=group.userData.mesh,g=mesh.geometry,uniforms=mesh.material.uniforms;
    const roots=g.attributes.iRoot.array.slice(),shapes=g.attributes.iShape.array.slice(),normals=g.attributes.iGroundNormal.array.slice();
    const versions=Object.values(g.attributes).map(a=>a.version),rebuilds=group.userData.stats.rebuilds;
    const low=uniforms.uGrassLow.value,high=uniforms.uGrassHigh.value,colors=[];
    assert.deepEqual(low.toArray(),RING_HABITAT_MEADOW_PALETTES[0].low,'standalone omission uses temperate palette');
    for(let climate=0;climate<4;climate++){
      group.userData.update({body,camera,viewportHeight:1000,pixelRatio:1,climate});
      assert.equal(uniforms.uGrassLow.value,low);assert.equal(uniforms.uGrassHigh.value,high);
      assert.deepEqual(low.toArray(),RING_HABITAT_MEADOW_PALETTES[climate].low);
      assert.deepEqual(high.toArray(),RING_HABITAT_MEADOW_PALETTES[climate].high);
      colors.push(low.toArray().join(','));
      assert.equal(group.userData.stats.rebuilds,rebuilds);assert.equal(group.userData.mesh,mesh);
      assert.deepEqual(Object.values(g.attributes).map(a=>a.version),versions);
      assert.deepEqual(g.attributes.iRoot.array,roots);assert.deepEqual(g.attributes.iShape.array,shapes);assert.deepEqual(g.attributes.iGroundNormal.array,normals);
    }
    assert.equal(new Set(colors).size,4,'each material climate has a distinct grass palette');
  }finally{group.userData.dispose();}
});

test('clear, retired body and disposal release only owned geometry/material and allow reentry',()=>{
  const borrowed=createRingHabitatShadowUniforms(),texture=new THREE.Texture();borrowed.uVegetationShadow.value=texture;
  let textureDisposals=0;texture.addEventListener('dispose',()=>textureDisposals++);
  const {group,camera,update}=fixture(borrowed);
  update();const mesh=group.userData.mesh;let geometryDisposals=0,materialDisposals=0;
  mesh.geometry.addEventListener('dispose',()=>geometryDisposals++);mesh.material.addEventListener('dispose',()=>materialDisposals++);
  assert.equal(mesh.material.uniforms.uVegetationShadow,borrowed.uVegetationShadow);
  group.userData.clear();assert.equal(group.visible,false);update();assert.ok(group.userData.stats.instances>0);
  group.userData.update({body:null,camera,viewportHeight:1000});assert.equal(group.userData.stats.instances,0);
  update();assert.ok(group.visible);group.userData.dispose();group.userData.dispose();update();
  assert.equal(group.children.length,0);assert.equal(group.userData.mesh,null);assert.equal(geometryDisposals,1);assert.equal(materialDisposals,1);assert.equal(textureDisposals,0);
  texture.dispose();assert.equal(textureDisposals,1);
});
