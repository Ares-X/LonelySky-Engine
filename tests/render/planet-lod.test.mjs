import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createPlanetLod, projectedPlanetRadius, selectPlanetLod} from '../../src/render/planet-lod.js';

const view = {radius: 1000, distance: 3000, fov: 55, viewportHeight: 1080, pixelRatio: 1};

test('screen coverage follows scale, zoom and drawing buffer rather than absolute distance', () => {
  const baseline = projectedPlanetRadius(view);
  assert.equal(projectedPlanetRadius({...view,radius:2000,distance:6000}),baseline);
  assert.ok(projectedPlanetRadius({...view,fov:30})>baseline);
  assert.equal(projectedPlanetRadius({...view,pixelRatio:2}),baseline*2);
  assert.equal(projectedPlanetRadius({...view,viewportHeight:2160}),baseline*2);
  assert.ok(projectedPlanetRadius({...view,distance:2000})>baseline);
  assert.equal(projectedPlanetRadius({...view,distance:1000}),Infinity);
  assert.equal(projectedPlanetRadius({...view,distance:999}),Infinity);
  assert.equal(projectedPlanetRadius({...view,radius:0}),0);
});

test('detail tiers obey quality ceilings and remain stable near their boundaries', () => {
  assert.equal(selectPlanetLod(Infinity,'low'),2);
  assert.equal(selectPlanetLod(Infinity,'auto'),3);
  assert.equal(selectPlanetLod(Infinity,'high'),4);
  assert.equal(selectPlanetLod(10,'high'),0);
  assert.equal(selectPlanetLod(350,'high',1),1);
  assert.equal(selectPlanetLod(380,'high',1),1);
  assert.equal(selectPlanetLod(420,'high',1),2);
  assert.equal(selectPlanetLod(350,'high',2),2);
  assert.equal(selectPlanetLod(300,'high',2),1);
  assert.equal(selectPlanetLod(5000,'low',4),2);
});

test('a close giant keeps a smooth limb beyond the former fixed-distance cutoff', () => {
  const pool=createPlanetLod(), initial=pool.geometry();
  const surface=new THREE.Mesh(initial),air=new THREE.Mesh(initial);
  surface.scale.setScalar(100000);air.scale.setScalar(101500);
  try {
    const options={radius:100000,distance:100500,fov:65,viewportHeight:1080,pixelRatio:1,quality:'high'};
    assert.equal(pool.update([surface,air],options),4);
    assert.equal(surface.geometry,air.geometry);
    assert.equal(surface.geometry.parameters.widthSegments,320);
    assert.equal(surface.scale.x,100000);
    assert.equal(air.scale.x,101500);
    // A lost graphics context retains CPU geometry; the next frame borrows
    // the same pool resource instead of allocating or disposing a second pool.
    const geometry=surface.geometry;
    assert.equal(pool.update([surface,air],options),4);
    assert.equal(surface.geometry,geometry);
    assert.equal(pool.update([surface,air],{...options,quality:'low'}),2);
    assert.equal(surface.geometry,air.geometry);
  } finally { pool.dispose();surface.material.dispose();air.material.dispose(); }
});

test('surfaces and air borrow the same lazily reused geometries and release them once', () => {
  const pool=createPlanetLod();
  const initial=pool.geometry();
  const surface=new THREE.Mesh(initial),air=new THREE.Mesh(initial);
  const meshes=[surface,air], allocated=new Set([initial]);
  const disposals=new Map();
  const track = geometry => {
    if(allocated.has(geometry))return;
    allocated.add(geometry);
    geometry.addEventListener('dispose',()=>disposals.set(geometry,(disposals.get(geometry)||0)+1));
  };
  initial.addEventListener('dispose',()=>disposals.set(initial,(disposals.get(initial)||0)+1));
  for(let i=0;i<20;i++){
    for(const distance of [100000,3000,1100,1001]){
      pool.update(meshes,{...view,distance,quality:'high'});
      assert.equal(surface.geometry,air.geometry);
      assert.equal(surface.userData.planetLodLevel,air.userData.planetLodLevel);
      track(surface.geometry);
      assert.equal(surface.geometry,pool.geometry(surface.userData.planetLodLevel));
    }
  }
  assert.ok(allocated.size<=5);
  assert.ok(allocated.size>1);
  pool.dispose();pool.dispose();
  for(const geometry of allocated)assert.equal(disposals.get(geometry),1);
  assert.throws(()=>pool.geometry(),/disposed/);
  surface.material.dispose();air.material.dispose();
});
