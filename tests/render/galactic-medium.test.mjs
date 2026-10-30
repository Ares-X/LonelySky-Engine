import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createGalacticMedium,sampleGalacticStars} from '../../src/galactic-medium.js';
import {createSpatialGalacticMedium} from '../../src/galactic-spatial-medium.js';
import {createGalacticMediumVolume} from '../../src/render/galactic-medium.js';
import {createCosmos} from '../../src/render/cosmos.js';
import {encodeCell} from '../../src/coordinates.js';
const descriptor=()=>({id:'medium-test',seed:'medium-stars',kind:'galaxy',revision:3,gridCells:4096,
  macroCell:{x:0,y:0,z:0},offset:[0,0,0],orientation:[.1,.3,.2],radius:30000000,
  medium:createGalacticMedium({seed:'medium-field',resolution:64})});

test('all quality prefixes share one finite luminous budget and retain GPU buffers',()=>{
  const d=descriptor(),mesh=createGalacticMediumVolume(d),stars=mesh.children[0];
  const position=stars.geometry.attributes.position,colors=stars.geometry.attributes.color,raw=stars.geometry.attributes.rawLuminosity;
  assert.equal(position.count,4096);assert.equal(mesh.userData.stats.starBufferBytes,4096*28);
  const psf=stars.material.uniforms.stellarPsfTable.value,psfPixels=psf.image.data,initialPsfVersion=psf.version;
  let tablePower=0;const texture=mesh.material.uniforms.mediumTable.value,texels=texture.image.data;
  for(let i=0;i<texels.length;i+=4)tablePower+=(THREE.DataUtils.fromHalfFloat(texels[i])+THREE.DataUtils.fromHalfFloat(texels[i+1]))*d.medium.pixelArea;
  assert.ok(Math.abs(tablePower/d.medium.diskLuminosity-1)<.001,'uploaded half-float table preserves the generated luminosity');
  let bulgePower=0;const volumeData=mesh.material.uniforms.stellarVolumeTable.value.image.data;
  for(const value of volumeData)bulgePower+=THREE.DataUtils.fromHalfFloat(value)*d.medium.bulgePixelVolume;
  assert.ok(Math.abs(bulgePower/d.medium.bulgeLuminosity-1)<.001,'uploaded central population preserves its luminous budget');
  for(const [quality,count] of [['low',512],['high',4096],['auto',2048],['low',512]]){
    mesh.userData.setQuality(quality,1080,1.5);
    assert.equal(stars.geometry.attributes.position,position);assert.equal(stars.geometry.attributes.color,colors);assert.equal(stars.geometry.attributes.rawLuminosity,raw);
    assert.equal(stars.geometry.drawRange.count,count);
    assert.equal(psf.image.data,psfPixels);assert.equal(psf.version,initialPsfVersion+1);
    let represented=0;for(let i=0;i<count;i++)represented+=raw.getX(i)*stars.material.uniforms.powerScale.value;
    const continuum=mesh.material.uniforms.continuumWeight.value*d.medium.totalLuminosity;
    assert.ok(Math.abs(represented+continuum-d.medium.totalLuminosity)<1e-14);
    assert.equal(mesh.userData.stats.resolvedLuminosity,d.medium.totalLuminosity*d.medium.resolvedFraction);
  }
  mesh.userData.dispose();
});

test('explicit 16k representation reuses one source field and normalizes each selected prefix',()=>{
  const d=descriptor(),fraction=d.medium.resolvedFraction,starCounts={low:512,auto:2048,high:16384};
  const defaults=createGalacticMediumVolume(d),mesh=createGalacticMediumVolume(d,{starCounts,resolvedFraction:.6}),stars=mesh.children[0];
  try{
    const attributes=stars.geometry.attributes,buffers={...attributes},psf=stars.material.uniforms.stellarPsfTable.value;
    const source=mesh.material.uniforms.stellarVolumeTable.value,dust=mesh.material.uniforms.dustVolumeTable.value;
    assert.equal(attributes.position.count,16384);assert.equal(mesh.userData.stats.starBufferBytes,16384*28);
    assert.equal(mesh.userData.stats.textureBytes,defaults.userData.stats.textureBytes);
    for(const key of ['mediumTable','verticalGeometryTable','stellarVolumeTable','dustVolumeTable'])
      assert.deepEqual(mesh.material.uniforms[key].value.image.data,defaults.material.uniforms[key].value.image.data);
    const old=sampleGalacticStars(d.medium,d.seed,4096);
    for(const [name,key] of [['position','positions'],['color','colors'],['rawLuminosity','rawLuminosities']])
      assert.deepEqual(attributes[name].array.subarray(0,old[key].length),old[key]);
    starCounts.high=8192;
    for(const [quality,count,steps] of [['high',16384,96],['low',512,32],['auto',2048,64],['high',16384,96]]){
      mesh.userData.setQuality(quality,1080,1);
      for(const name of Object.keys(buffers))assert.equal(stars.geometry.attributes[name],buffers[name]);
      assert.equal(stars.geometry.drawRange.count,count);
      assert.equal(stars.material.uniforms.stellarPsfTable.value,psf);
      assert.equal(mesh.material.uniforms.stellarVolumeTable.value,source);assert.equal(mesh.material.uniforms.dustVolumeTable.value,dust);
      assert.equal(mesh.material.uniforms.steps.value,steps);assert.equal(mesh.material.uniforms.continuumWeight.value,.4);
      let represented=0;for(let i=0;i<count;i++)represented+=attributes.rawLuminosity.getX(i)*stars.material.uniforms.powerScale.value;
      assert.ok(Math.abs(represented/d.medium.totalLuminosity-.6)<1e-13);
      assert.ok(Math.abs(represented+mesh.userData.stats.unresolvedLuminosity-d.medium.totalLuminosity)<1e-13);
    }
    assert.equal(d.medium.resolvedFraction,fraction);
    assert.equal(defaults.userData.stats.resolvedLuminosity,fraction*d.medium.totalLuminosity);
    let releases=0;stars.geometry.addEventListener('dispose',()=>releases++);
    mesh.userData.dispose();mesh.userData.dispose();assert.equal(releases,1);assert.equal(mesh.userData.stats.starBufferBytes,0);
  }finally{mesh.userData.dispose();defaults.userData.dispose();}
});

test('representation options reject unsupported counts and fractions before resource creation',()=>{
  const d=descriptor();
  for(const starCounts of [{low:0,auto:2048,high:4096},{low:513,auto:512,high:4096},
    {low:512,auto:4097,high:4096},{low:512,auto:2048,high:16385},{low:512,auto:2048,high:NaN},
    {low:1.5,auto:2048,high:4096},{low:512,high:4096}])assert.throws(()=>createGalacticMediumVolume(d,{starCounts}),/star counts/);
  for(const resolvedFraction of [-.01,1.01,NaN,Infinity,null])assert.throws(()=>createGalacticMediumVolume(d,{resolvedFraction}),/resolved fraction/);
  for(const resolvedFraction of [0,1]){
    const mesh=createGalacticMediumVolume(d,{resolvedFraction});
    try{
      assert.equal(mesh.userData.stats.resolvedLuminosity,d.medium.totalLuminosity*resolvedFraction);
      assert.equal(mesh.userData.stats.unresolvedLuminosity,d.medium.totalLuminosity*(1-resolvedFraction));
      assert.equal(mesh.material.uniforms.continuumWeight.value,1-resolvedFraction);
    }finally{mesh.userData.dispose();}
  }
});

test('cosmos resolves options once per installed medium and leaves other populations at defaults',()=>{
  const selected=descriptor(),other={...selected,id:'ordinary-medium',seed:'ordinary-stars'},calls=[];
  const cosmos=createCosmos({descriptorProvider:coordinate=>coordinate.x===0&&coordinate.y===0&&coordinate.z===0?[selected,other]:[],
    gridCells:4096,structures:true,catalogue:{capacity:4,supportFade:true,immutable:true},
    galacticMediumOptions:d=>{calls.push(d);return d===selected?{starCounts:{low:512,auto:2048,high:16384},resolvedFraction:.6}:undefined;}});
  const frame={sectorIndex:encodeCell({x:0,y:0,z:0}),cameraPosition:[0,0,0],quality:'high'};
  try{
    cosmos.userData.update(frame);
    const [expanded,ordinary]=cosmos.children[1].children,position=expanded.children[0].geometry.attributes.position;
    assert.deepEqual(calls,[selected,other]);assert.equal(expanded.children[0].geometry.drawRange.count,16384);
    assert.equal(ordinary.children[0].geometry.drawRange.count,4096);assert.equal(cosmos.userData.stats.particles,20480);
    assert.equal(cosmos.userData.stats.maxParticles,28672);assert.equal(cosmos.userData.stats.starBufferBytes,20480*28);
    cosmos.userData.update({...frame,quality:'low'});cosmos.userData.update(frame);
    assert.deepEqual(calls,[selected,other]);assert.equal(expanded.children[0].geometry.attributes.position,position);
    assert.equal(cosmos.userData.stats.starBufferBytes,20480*28);
  }finally{cosmos.userData.dispose();}
  assert.equal(cosmos.userData.stats.starBufferBytes,0);
});

test('legacy RGB columns are rejected before they can be read as population densities',()=>{
  const d=descriptor();d.medium={...d.medium,revision:1};
  assert.throws(()=>createGalacticMediumVolume(d),/revision/);
});

test('mediums own their resources and descriptor replacement releases the previous field once',()=>{
  const mesh=createGalacticMediumVolume(descriptor()),resources=[mesh.geometry,mesh.material,mesh.children[0].geometry,mesh.children[0].material,mesh.material.uniforms.mediumTable.value,mesh.material.uniforms.verticalGeometryTable.value,mesh.material.uniforms.stellarVolumeTable.value,mesh.material.uniforms.dustVolumeTable.value,mesh.children[0].material.uniforms.stellarPsfTable.value];
  const counts=resources.map(()=>0);resources.forEach((r,i)=>r.addEventListener('dispose',()=>counts[i]++));
  const depth=new THREE.Texture(),camera=new THREE.PerspectiveCamera(60,1,2,220000);
  mesh.userData.setSceneDepth(depth,1920,1080,camera);assert.equal(mesh.material.uniforms.uSceneDepth.value,depth);
  mesh.userData.dispose();mesh.userData.dispose();
  assert.deepEqual(counts,[1,1,1,1,1,1,1,1,1]);assert.equal(mesh.children.length,0);assert.equal(mesh.material.uniforms.uSceneDepth.value,null);
  depth.dispose();
});

test('a medium is drawn once beside legacy points, with shared support and exact rebase storage',()=>{
  const d=descriptor(),provider=coordinate=>coordinate.x===0&&coordinate.y===0&&coordinate.z===0?[d]:[];
  const cosmos=createCosmos({descriptorProvider:provider,gridCells:4096,structures:true,catalogue:{capacity:4,supportFade:true,immutable:true}});
  const frame={sectorIndex:encodeCell({x:0,y:0,z:0}),cameraPosition:[0,0,0],quality:'high',viewportHeight:1080,pixelRatio:1};
  cosmos.userData.update(frame);
  assert.equal(cosmos.children[0].geometry.attributes.position.count,0,'the legacy point batch must not add a second full population');
  const volume=cosmos.children[1].children[0],stars=volume.children[0],positions=stars.geometry.attributes.position;
  assert.equal(stars.geometry.drawRange.count,4096);assert.equal(cosmos.userData.stats.particles,4096);
  cosmos.userData.update({...frame,sectorIndex:encodeCell({x:1,y:0,z:0}),cameraPosition:[-20000,0,0]});
  assert.equal(volume.children[0].geometry.attributes.position,positions);
  assert.equal(volume.material.uniforms.structureVisibility.value,cosmos.children[0].material.uniforms.structureWeights.value[0]);
  cosmos.userData.update({...frame,quality:'low'});assert.equal(stars.geometry.drawRange.count,512);
  cosmos.userData.dispose();
});

test('shared transparent-sort center conservatively contains the physical hull and stars',()=>{
  const d=descriptor();d.medium=createGalacticMedium({seed:'warped-sort-support',resolution:64,dustCloudFraction:.75,
    stellarWarp:.075,stellarHeightVariation:.8,dustWarp:.07,dustHeightVariation:.8});
  const mesh=createGalacticMediumVolume(d),stars=mesh.children[0],point=new THREE.Vector3();
  try{
    assert.deepEqual(mesh.geometry.boundingSphere.center.toArray(),[0,0,0]);
    assert.deepEqual(stars.geometry.boundingSphere.center.toArray(),[0,0,0]);
    for(const object of [mesh,stars]){
      const positions=object.geometry.attributes.position,sphere=object.geometry.boundingSphere;
      for(let i=0;i<positions.count;i++)assert.ok(sphere.containsPoint(point.fromBufferAttribute(positions,i)),'physical vertex lies inside its real support');
    }
    assert.equal(mesh.renderOrder,stars.renderOrder,'foreground transparent ordering remains available to the scene');
  }finally{mesh.userData.dispose();}
});

test('spatial source families share the actual RGBA field and own only their real textures',()=>{
  const d=descriptor();
  d.medium=createSpatialGalacticMedium({seed:'spatial-upload',sourceCenter:[0,0,0],sourceAxes:[1,.4,1],dustCenter:[0,0,0],dustAxes:[1,.4,1],
    luminosities:[.010,.007,.005],colors:[[1,.8,.6],[.6,.8,1],[1,.9,.7]],dustIntegral:.032,extinctionColor:[.6,1,1.5],resolvedFraction:.005,
    sourceKernels:[0,1,2].map(component=>({component,weight:1,center:[(component-1)*.25,(component-1)*.04,0],axes:[.18,.08,.16],rotation:[.1,.3,.2]})),
    dustKernels:[{weight:1,center:[.1,0,.1],axes:[.15,.07,.16],rotation:[.2,.3,.1],contrast:.7}]});
  const mesh=createGalacticMediumVolume(d),stars=mesh.children[0],u=mesh.material.uniforms;
  assert.equal(mesh.material.defines.GALACTIC_SPATIAL_EMISSION,1);
  assert.equal(stars.material.defines.GALACTIC_SPATIAL_EMISSION,1);
  assert.equal(u.mediumTable,undefined);assert.equal(u.verticalGeometryTable,undefined);
  assert.equal(u.stellarVolumeTable.value.format,THREE.RGBAFormat);
  assert.equal(u.stellarVolumeTable.value.image.data.length,64**3*4);
  for(const name of ['stellarVolumeTable','dustVolumeTable','oldStellarColor','youngStellarColor','bulgeColor'])assert.equal(stars.material.uniforms[name],u[name]);
  const source=u.stellarVolumeTable.value.image.data,integrals=[0,0,0];
  for(let i=0;i<source.length;i+=4)for(let p=0;p<3;p++)integrals[p]+=THREE.DataUtils.fromHalfFloat(source[i+p])*d.medium.sourceVolumePixelVolume;
  for(let p=0;p<3;p++)assert.ok(Math.abs(integrals[p]/d.medium.sourceComponentIntegrals[p]-1)<.001);
  const expanded=createGalacticMediumVolume(d,{starCounts:{low:512,auto:2048,high:16384},resolvedFraction:.6});
  try{
    const expandedStars=expanded.children[0];expanded.userData.setQuality('high');
    assert.equal(expandedStars.geometry.drawRange.count,16384);
    for(const name of ['position','color','rawLuminosity'])assert.deepEqual(
      expandedStars.geometry.attributes[name].array.subarray(0,stars.geometry.attributes[name].array.length),stars.geometry.attributes[name].array);
    let represented=0;for(const value of expandedStars.geometry.attributes.rawLuminosity.array)
      represented+=value*expandedStars.material.uniforms.powerScale.value;
    assert.ok(Math.abs(represented/d.medium.totalLuminosity-.6)<1e-13);
    for(const key of ['stellarVolumeTable','dustVolumeTable'])assert.deepEqual(expanded.material.uniforms[key].value.image.data,u[key].value.image.data);
  }finally{expanded.userData.dispose();}
  const resources=[mesh.geometry,mesh.material,stars.geometry,stars.material,u.stellarVolumeTable.value,u.dustVolumeTable.value,stars.material.uniforms.stellarPsfTable.value];
  const counts=resources.map(()=>0);resources.forEach((resource,i)=>resource.addEventListener('dispose',()=>counts[i]++));
  mesh.userData.dispose();mesh.userData.dispose();assert.deepEqual(counts,[1,1,1,1,1,1,1]);
});

test('an oriented local source transfers its family budget once and owns one stable upload',()=>{
  const d=descriptor();
  d.medium=createSpatialGalacticMedium({seed:'local-source-upload',sourceCenter:[0,0,0],sourceAxes:[1,.4,1],
    dustCenter:[0,0,0],dustAxes:[1,.4,1],luminosities:[.01,.007,.005],
    colors:[[1,.8,.6],[.6,.8,1],[1,.9,.7]],dustIntegral:0,extinctionColor:[.6,1,1.5],resolvedFraction:.005,
    sourceKernels:[0,1,2].map(component=>({component,weight:1,center:[(component-1)*.25,(component-1)*.04,0],
      axes:[.18,.08,.16],rotation:[.2,.5,-.3]})),dustKernels:[],
    sourceBrick:{kernelIndex:1,profile:'coherent-ribbon-v1',macroSpan:[.036,.02,.036],fineSpan:[.012,.008,.012]}});
  const mesh=createGalacticMediumVolume(d),stars=mesh.children[0],u=mesh.material.uniforms,brick=d.medium.sourceBrick;
  try{
    assert.equal(mesh.material.defines.GALACTIC_LOCAL_SOURCE,1);
    assert.equal(stars.material.uniforms.localSourceTable,u.localSourceTable);
    const texture=u.localSourceTable.value,pixels=texture.image.data,version=texture.version;
    assert.equal(texture.format,THREE.RedFormat);assert.equal(pixels.byteLength,32**3*2);
    assert.equal(u.localSourceResolution.value,32);
    let uploaded=0,baseYoung=0;
    for(const value of pixels)uploaded+=THREE.DataUtils.fromHalfFloat(value)*brick.pixelVolume;
    for(let i=1;i<u.stellarVolumeTable.value.image.data.length;i+=4)baseYoung+=u.stellarVolumeTable.value.image.data[i];
    assert.equal(baseYoung,0,'the only young kernel is absent from the coarse field');
    assert.ok(Math.abs(uploaded/d.medium.sourceComponentIntegrals[1]-1)<.001,'one local upload contains the whole young budget');
    const local=new THREE.Vector3(.14,-.08,.23),rotation=new THREE.Matrix3().set(...brick.rotation);
    const body=local.clone().multiply(new THREE.Vector3(...brick.axes)).applyMatrix3(rotation).add(u.localSourceCenter.value);
    body.sub(u.localSourceCenter.value).applyMatrix3(u.localSourceInverse.value);
    assert.ok(body.distanceTo(local)<1e-12,'row-major input is uploaded as the same body-to-brick transform');
    for(const quality of ['high','low','high']){
      mesh.userData.setQuality(quality,1080,1);
      assert.equal(u.localSourceTable.value,texture);assert.equal(texture.image.data,pixels);assert.equal(texture.version,version);
    }
    const resources=[mesh.geometry,mesh.material,stars.geometry,stars.material,u.stellarVolumeTable.value,
      u.dustVolumeTable.value,texture,stars.material.uniforms.stellarPsfTable.value];
    const counts=resources.map(()=>0);resources.forEach((resource,i)=>resource.addEventListener('dispose',()=>counts[i]++));
    mesh.userData.dispose();mesh.userData.dispose();assert.deepEqual(counts,[1,1,1,1,1,1,1,1]);
  }finally{mesh.userData.dispose();}
});
