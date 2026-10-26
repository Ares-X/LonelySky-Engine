import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStellarRemnant } from '../../src/render/stellar-remnant.js';
const families=['brown-dwarf','white-dwarf','neutron-star','pulsar','red-giant'];
const body=stellarFamily=>({id:stellarFamily,stellarFamily,radius:70,seed:47,phase:.4,spinTilt:.3,magneticTilt:.7,visualSpinRate:.48});
const meshes=object=>{const result=[];object.traverse(child=>{if(child.isMesh)result.push(child);});return result;};
const camera=new THREE.PerspectiveCamera();camera.position.set(0,0,1000);

test('all stellar families have bounded local geometry and the exact physical core radius',()=>{
  for(const family of families){
    const star=createStellarRemnant(body(family));
    try{
      assert.equal(star.getObjectByName('stellar-core').geometry.parameters.radius,70);
      assert.ok(meshes(star).length<=4);
      assert.equal(star.userData.stats.beams,family==='pulsar'?2:0);
      assert.equal(star.userData.bodyRadius,70);
      assert.equal(star.getObjectByName('stellar-corona').geometry,star.getObjectByName('stellar-core').geometry,
        'the close corona shares the detailed photosphere sphere');
      for(const mesh of meshes(star))for(const value of mesh.geometry.attributes.position.array)assert.ok(Number.isFinite(value));
      star.userData.update(10,camera,.5,'high',false);
      assert.equal(star.getObjectByName('stellar-core').material.uniforms.visibility.value,.5);
      assert.equal(star.getObjectByName('stellar-core').material.depthWrite,false);
      star.userData.update(10,camera,0,'high',false);
      assert.equal(star.visible,false);assert.equal(star.userData.stats.drawCalls,0);
    }finally{star.userData.dispose();}
  }
  assert.throws(()=>createStellarRemnant({radius:70}),TypeError);
});

test('pulsar beams are antipodal and sweep an inclined magnetic axis while neutron stars stay steady',()=>{
  const pulsar=createStellarRemnant(body('pulsar')),neutron=createStellarRemnant(body('neutron-star'));
  try{
    const beams=meshes(pulsar).filter(mesh=>mesh.name==='stellar-magnetic-beam');
    assert.ok(beams.every(beam=>beam.material.forceSinglePass));
    const beamUniforms=beams[0].material.uniforms;
    const opticalSnapshot=Object.fromEntries(Object.entries(beamUniforms).map(([key,uniform])=>[key,uniform.value?.clone?.()??uniform.value]));
    const point=new THREE.Vector3();
    const direction=time=>{pulsar.userData.update(time,camera,1,'high',false);pulsar.updateMatrixWorld(true);return beams[0].getWorldPosition(point).clone().normalize();};
    const first=direction(0),second=direction(2);
    assert.ok(first.distanceTo(second)>.1);
    const opposing=beams[1].getWorldPosition(new THREE.Vector3()).normalize();
    assert.ok(second.dot(opposing)<-.999999);
    const fixedDirection=time=>{pulsar.userData.update(time,camera,1,'high',true);pulsar.updateMatrixWorld(true);return beams[0].getWorldPosition(new THREE.Vector3()).normalize();};
    assert.deepEqual(fixedDirection(2),fixedDirection(500));
    assert.deepEqual(Object.fromEntries(Object.entries(beamUniforms).map(([key,uniform])=>[key,uniform.value])),opticalSnapshot,
      'celestial time changes beam direction without a global intensity clock');
    assert.equal(pulsar.getObjectByName('stellar-core').material.uniforms.time.value,0);
    assert.equal(meshes(neutron).filter(mesh=>mesh.name==='stellar-magnetic-beam').length,0);
    neutron.userData.update(2,camera,1,'high',false);
    const steady=neutron.getObjectByName('stellar-core').material.uniforms.visibility.value;
    neutron.userData.update(500,camera,1,'high',false);
    assert.equal(neutron.getObjectByName('stellar-core').material.uniforms.visibility.value,steady);
  }finally{pulsar.userData.dispose();neutron.userData.dispose();}
});

test('quality and distance reduce detail without changing solid size; disposal is idempotent',()=>{
  const giant=createStellarRemnant(body('red-giant'));
  const resources=new Set(meshes(giant).flatMap(mesh=>[mesh.geometry,mesh.material]));
  giant.userData.update(0,camera,1,'low',false);
  resources.add(giant.getObjectByName('stellar-core').geometry);
  assert.equal(giant.getObjectByName('stellar-corona').geometry,giant.getObjectByName('stellar-core').geometry);
  const counters=new Map([...resources].map(resource=>[resource,0]));
  for(const resource of resources)resource.addEventListener('dispose',()=>counters.set(resource,counters.get(resource)+1));
  giant.userData.update(0,camera,1,'low',false);
  assert.equal(giant.userData.stats.lod,'far');assert.equal(giant.userData.stats.drawCalls,2);
  assert.equal(giant.getObjectByName('stellar-core').geometry.parameters.radius,70);
  camera.position.z=100000;
  giant.userData.update(0,camera,1,'high',false);
  assert.equal(giant.userData.stats.lod,'far');assert.equal(giant.userData.stats.drawCalls,2);
  giant.userData.dispose();giant.userData.dispose();
  for(const count of counters.values())assert.equal(count,1);
  camera.position.z=1000;
});
