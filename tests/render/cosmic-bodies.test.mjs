import fs from 'node:fs';
import vm from 'node:vm';
import {createRingHabitatRegions} from '../../src/ring-habitat-regions.js';
import {createRingHabitat,RING_HABITAT_ECOLOGY} from '../../src/ring-habitat.js';
import {buildTerrainMesh} from '../../src/mesh-terrain.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCosmicBodies } from '../../src/render/cosmic-bodies.js';
import {cosmicBodyUniforms,setCosmicBody} from '../../src/render/distant-landmark.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';
import {createRingSurfaceLattice} from '../../src/ring-surface-lattice.js';
import {NebulaRenderPass} from '../../src/render/nebula-render-pass.js';

const frame = [1, 0, 0, 0, 1, 0, 0, 0, 1];

test('procedural gas slots reuse identity and replay the same weather independently of the orbit clock',()=>{
  const {body,camera,group}=fixture('gas-giant');
  const other={...body,id:'physical-fixture-east',center:[2000000,30000,-4400000]};
  const view={bodies:[body,other],camera,viewportHeight:720,celestialTime:1e12-1};
  const state=u=>({jet:u.uGasJetRotations.value.toArray(),storm:u.uGasStormMotion.value[0].toArray(),
    cell:u.uGasNoiseCells.value[2].toArray(),fraction:u.uGasNoiseFractions.value[2].toArray()});
  try{
    group.userData.update(view);
    const [surface,otherSurface]=group.children.filter(object=>object.name==='Cosmic solid surface');
    const first=surface.material.uniforms,second=otherSurface.material.uniforms;
    assert.equal(first.uClouds.value,null);
    assert.equal(surface.material.defines.GAS_OBSERVED_CLOUDS,undefined);
    const air=surface.children.find(object=>object.name==='Cosmic optical atmosphere');
    assert.equal(air.material.uniforms,first);
    assert.equal(air.material.defines.GAS_OBSERVED_CLOUDS,undefined);
    const band=first.uGasMacroBands.value,jet=first.uGasJetRotations.value;
    assert.notDeepEqual(first.uGasMacroOrigin.value.toArray(),second.uGasMacroOrigin.value.toArray());
    const initial=state(first),periodic=initial.jet;
    group.userData.update({...view,celestialTime:view.celestialTime+.25});
    const advanced=state(first),rotated=advanced.jet;
    assert.equal(first.uGasMacroBands.value,band);
    assert.equal(first.uGasJetRotations.value,jet);
    assert.ok(periodic[0]*rotated[1]-periodic[1]*rotated[0]<0,'east jet traces back eastward transport');
    assert.ok(periodic[2]*rotated[3]-periodic[3]*rotated[2]>0,'west jet traces back westward transport');
    assert.notDeepEqual(advanced.storm,initial.storm);
    assert.notDeepEqual(advanced.fraction,initial.fraction);
    group.userData.update({...view,celestialTime:view.celestialTime+.5,gasWeatherTime:view.celestialTime});
    assert.deepEqual(state(first),initial);
    group.userData.update({...view,bodies:[other,body]});
    assert.deepEqual(state(second),initial,'revisiting in a different slot preserves the weather');
  }finally{group.userData.dispose();}
});

test('a recycled moon slot selects the surface of its current satellite', () => {
  const {body, group} = fixture('moon');
  const uniforms = group.children[0].material.uniforms;
  try {
    body.family = 'rock';
    setCosmicBody(uniforms, body);
    const rocky = uniforms.uBodyKind.value;
    body.family = 'ice';
    setCosmicBody(uniforms, body);
    assert.notEqual(uniforms.uBodyKind.value, rocky);
    body.family = 'rock';
    setCosmicBody(uniforms, body);
    assert.equal(uniforms.uBodyKind.value, rocky);
  } finally {
    group.userData.dispose();
  }
});

test('cloud material coordinates retain subpixel body-fixed positions through large-origin motion and cell crossings',()=>{
  const f=fixture('gas-giant'),u=f.group.children[0].material.uniforms,scales=[16000,4000,1000];
  const initial=[-3500000.123456,8900000.789012,-1780000.345678],relative=[4100.125,-3500.75,2310.0625];
  const cells=u.uGasNoiseCells.value,fractions=u.uGasNoiseFractions.value;
  const address=(layer,axis,offset)=>{
    const q=Math.fround(Math.fround(fractions[layer].getComponent(axis))+Math.fround(Math.fround(offset)/scales[layer]));
    return [((cells[layer].getComponent(axis)+Math.floor(q))%256+256)%256,q-Math.floor(q)];
  };
  try{
    f.body.center=initial.slice();setCosmicBody(u,f.body);const original=scales.map((_,i)=>relative.map((value,axis)=>address(i,axis,value)));
    for(const move of [.015625,15.25,999.875,1000.125,2048.5]){
      f.body.center=initial.map((value,axis)=>value+move*(axis+1));setCosmicBody(u,f.body);
      assert.equal(u.uGasNoiseCells.value,cells);assert.equal(u.uGasNoiseFractions.value,fractions);
      for(let i=0;i<scales.length;i++)for(let axis=0;axis<3;axis++){
        const actual=address(i,axis,relative[axis]+move*(axis+1)),expected=original[i][axis];
        assert.equal(actual[0],expected[0]);assert.ok(Math.abs(actual[1]-expected[1])*scales[i]<.01);
      }
    }
  }finally{f.group.userData.dispose();}
});

test('local photosphere metadata is copied and slots borrow one image through retirement', () => {
  const image = new THREE.Texture({width: 64, height: 64});
  const metadata = {uvRect: [.125, .125, .875, .875], linearLumaMean: .42, tileGranules: 19, maxLod: 2};
  const group = createCosmicBodies({stellarTexture: image, photosphereMaterial: metadata});
  const camera = new THREE.PerspectiveCamera(65, 1, .5, 220000);
  const bodies = [{visibility: 0}, {visibility: 0}];
  let imageDisposals = 0;
  image.addEventListener('dispose', () => imageDisposals++);
  try {
    metadata.uvRect[0] = 0; metadata.linearLumaMean = 1;
    group.userData.update({bodies, camera, viewportHeight: 1000});
    const slots = group.children.filter(object => object.name === 'Cosmic solid surface');
    assert.equal(slots.length, 2);
    const uniforms = slots.map(object => object.material.uniforms);
    const identities = uniforms.map(u => [u.uStellar.value, u.uPhotosphereUV.value, u.uPhotosphereParameters.value]);
    for (const u of uniforms) {
      assert.equal(u.uStellar.value, image);
      assert.equal(u.uHasStellarPhotosphere.value, true);
      assert.equal(u.uPhotosphereUV.value.x, .125);
      assert.equal(u.uPhotosphereParameters.value.x, .42);
    }
    for (let i = 0; i < 100; i++) group.userData.update({bodies, camera, viewportHeight: 1000});
    for (let i = 0; i < uniforms.length; i++)
      assert.deepEqual([uniforms[i].uStellar.value, uniforms[i].uPhotosphereUV.value, uniforms[i].uPhotosphereParameters.value], identities[i]);
    group.userData.dispose(); group.userData.dispose();
    for (const u of uniforms) {
      assert.equal(u.uStellar.value, null);
      assert.equal(u.uHasStellarPhotosphere.value, false);
    }
    assert.equal(imageDisposals, 0);
  } finally { group.userData.dispose(); image.dispose(); }
  assert.equal(imageDisposals, 1);
});

test('photosphere entry rejects incomplete borrowed material metadata', () => {
  const image = new THREE.Texture({width: 64, height: 64});
  const valid = {uvRect: [.125, .125, .875, .875], linearLumaMean: .42, tileGranules: 19, maxLod: 2};
  try {
    assert.throws(() => createCosmicBodies({photosphereMaterial: valid}), TypeError);
    for (const change of [{uvRect: [0, 1, 0, 1]}, {linearLumaMean: 0}, {tileGranules: 0}, {maxLod: 7}])
      assert.throws(() => createCosmicBodies({stellarTexture: image, photosphereMaterial: {...valid, ...change}}), RangeError);
  } finally { image.dispose(); }
});

const SUPPORT_ROW_OFFSET=64*4;
// Independent retained oracle for the former uniform support sphere. Tests
// check both its geometric enclosure and its exact former float32 upload.
function originalSectionSupport(part,bodyRadius){
  const outer=part.surfaceLattice?.outerRadius??part.outerRadius;
  const middleY=(part.minY+part.maxY)*.5,halfHeight=(part.maxY-part.minY)*.5;
  if(part.gapHalfAngle<=Math.PI*.5)return[0,middleY/bodyRadius,0,Math.hypot(outer,halfHeight)/bodyRadius];
  const angle=part.gapCenter+Math.PI,halfAngle=Math.PI-part.gapHalfAngle,middleRadius=(part.innerRadius+outer)*.5;
  const radialReach=(outer-part.innerRadius)*.5+outer*(1-Math.cos(halfAngle)),tangentReach=outer*Math.sin(halfAngle);
  return[Math.cos(angle)*middleRadius/bodyRadius,middleY/bodyRadius,Math.sin(angle)*middleRadius/bodyRadius,Math.hypot(radialReach,tangentReach,halfHeight)/bodyRadius];
}
function fixture(kind = 'ring', options) {
  const body = { id: 'physical-fixture', kind, radius: 1000000, halfWidth: .02, thickness: .0005, phase: .3,
    center: [2000000, 30000, -4000000], frame, light: [.5, .4, -.8], tint: [.5, .58, .64],
    shape: kind === 'ring' ? { type: 'compound', parts: [
      { type: 'annular-sector-slab', innerRadius: 999100, outerRadius: 1000700, minY: -22000, maxY: 21000, gapCenter: .42, gapHalfAngle: .27 },
      { type: 'annular-sector-slab', innerRadius: 998600, outerRadius: 1000900, minY: 21000, maxY: 24000, gapCenter: .48, gapHalfAngle: .31 },
    ] } : { type: 'sphere', radius: 1000000 } };
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  camera.position.set(1300, -100, 12000);camera.lookAt(1200000, 80000, -1000000);camera.updateMatrixWorld();
  const group = createCosmicBodies(options);
  return { group, body, camera, update: () => group.userData.update({ body, camera, viewportHeight: 720, pixelRatio: 1.25 }) };
}

// API/state probe only: it records real pass/material routing without compiling
// shaders or claiming that an MRT, optical integral or history pixel rendered.
class OpticalRendererProbe {
  constructor() {
    this.capabilities = { isWebGL2: true, reversedDepthBuffer: false, maxTextureSize: 16384 };
    this.extensions = { has: () => true };this.xr = { enabled: true };
    this.autoClear = true;this.autoClearColor = true;this.autoClearDepth = true;this.autoClearStencil = true;
    this.target = null;this.face = 0;this.mip = 0;this.color = new THREE.Color(.2, .3, .4);this.alpha = .7;
    this.screenViewport = new THREE.Vector4(2, 3, 64, 32);this.viewport = this.screenViewport.clone();
    this.screenScissor = new THREE.Vector4(4, 5, 32, 16);this.scissor = this.screenScissor.clone();this.scissorTest = true;
    this.state = { viewport: value => this.viewport.copy(value), scissor: value => this.scissor.copy(value), setScissorTest: value => { this.scissorTest=value; } };this.draws = [];this.copies = [];this.onRender = null;
  }
  getRenderTarget() { return this.target; }
  getActiveCubeFace() { return this.face; }
  getActiveMipmapLevel() { return this.mip; }
  getClearColor(out) { return out.copy(this.color); }
  getClearAlpha() { return this.alpha; }
  getCurrentViewport(out) { return out.copy(this.viewport); }
  getViewport(out) { return out.copy(this.screenViewport); }
  setViewport(value) { this.screenViewport.copy(value);if (!this.target) this.viewport.copy(value); }
  getContext() { return { SCISSOR_BOX: 0, SCISSOR_TEST: 1, getParameter: () => this.scissor.toArray(), isEnabled: () => this.scissorTest }; }
  getScissor(out) { return out.copy(this.screenScissor); }
  getScissorTest() { return this.scissorTest; }
  setScissor(value) { this.screenScissor.copy(value);if (!this.target) this.scissor.copy(value); }
  setScissorTest(value) { this.scissorTest = value; }
  setClearColor(value, alpha = this.alpha) { this.color.set(value);this.alpha = alpha; }
  setClearAlpha(value) { this.alpha = value; }
  setRenderTarget(target, face = 0, mip = 0) {
    this.target = target;this.face = face;this.mip = mip;this.viewport.copy(target ? target.viewport : this.screenViewport);
    this.scissor.copy(target ? target.scissor : this.screenScissor);
  }
  initRenderTarget() {}
  copyTextureToTexture(source, destination) { this.copies.push([source, destination]); }
  clear() {}
  render(scene, camera) {
    const visible = [];
    scene.traverseVisible(object => {
      if (!object.material || !object.layers.test(camera.layers)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material.visible) visible.push({ object, material });
    });
    const draw = { scene, target: this.target, visible };this.draws.push(draw);if (this.onRender) this.onRender(draw);
  }
  snapshot() {
    return { target: this.target, face: this.face, mip: this.mip, color: this.color.toArray(), alpha: this.alpha, autoClear: this.autoClear,
      xr: this.xr.enabled, viewport: this.viewport.toArray(), scissor: this.scissor.toArray(), scissorTest: this.scissorTest };
  }
}
function opticalFixture(options) {
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000), group = createCosmicBodies(options), scene = new THREE.Scene();scene.add(group);
  const makeRing = (id, distance) => {
    const body = { id, kind: 'ring', radius: 1000000, halfWidth: .02, thickness: .0005, phase: .3, broken: false,
      center: [0, 0, -distance], frame, light: [.5, .4, -.8], tint: [.5, .58, .64] };
    body.shape = { type: 'compound', parts: cosmicRingParts(body) };return body;
  };
  const near = makeRing('near-habitat', 2000000), remote = makeRing('remote-habitat', 4000000);
  const gas = { ...near, id: 'closer-gas', kind: 'gas-giant', center: [0, 0, -1500000], ringed: true, shape: { type: 'sphere', radius: 1000000 } };
  const update = bodies => group.userData.update({ bodies, camera, viewportHeight: 32 });
  return { camera, group, scene, near, remote, gas, update, renderer: new OpticalRendererProbe() };
}

test('cloud-map metadata belongs to its instance and remains copied for lazily created slots', () => {
  for(const mean of [null,[],[1,1],Array(3),[1,1,1,1],[0,1,1],[-1,1,1],[NaN,1,1],[Infinity,1,1]])
    assert.throws(()=>createCosmicBodies({cloudColorMean:mean}),RangeError);
  const image=new THREE.DataTexture(new Float32Array([.2,.4,.7,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
  const supplied=[2,.7,.3],original=supplied.slice();
  const first=fixture('gas-giant',{cloudTexture:image,cloudColorMean:supplied});
  const second=fixture('gas-giant',{cloudTexture:image,cloudColorMean:[.9,.5,.8]});
  const legacy=fixture('gas-giant',{cloudTexture:image});
  let disposed=0;image.addEventListener('dispose',()=>disposed++);
  try{
    supplied[0]=NaN;supplied[1]=0; // caller mutation before even the first slot
    first.update();second.update();legacy.update();
    const a=first.group.children[0].material.uniforms,b=second.group.children[0].material.uniforms;
    assert.equal(a.uClouds.value,image);assert.equal(b.uClouds.value,image);
    assert.deepEqual(a.uCloudColorMean.value.toArray(),original,'metadata was captured at the resource boundary');
    assert.deepEqual(b.uCloudColorMean.value.toArray(),[.9,.5,.8],'arbitrary external maps use caller calibration, with no asset-specific mean');
    assert.deepEqual(legacy.group.children[0].material.uniforms.uCloudColorMean.value.toArray(),[1,1,1]);
    a.uCloudColorMean.value.set(9,8,7);
    const other={...first.body,id:'second-gas',center:[-2000000,30000,-4000000]};
    first.group.userData.update({bodies:[first.body,other],camera:first.camera,viewportHeight:720});
    assert.deepEqual(first.group.children[2].material.uniforms.uCloudColorMean.value.toArray(),original,'a new slot copies the constructor snapshot, not caller or prior-slot mutations');
    assert.deepEqual(b.uCloudColorMean.value.toArray(),[.9,.5,.8],'another instance remains independent');
  }finally{
    first.group.userData.dispose();second.group.userData.dispose();legacy.group.userData.dispose();
    assert.equal(disposed,0,'cloud image remains borrowed');image.dispose();
  }
});

test('physical solids carry the catalogue bounds and every independent breach into the shader', () => {
  const { group, body, update } = fixture();
  try {
    body.visibility=0;update();assert.ok(group.children.every(child=>!child.visible),'a first invisible query must not expose uninitialized surfaces');
    delete body.visibility;update();
    const u = group.children[0].material.uniforms;
    assert.equal(u.uSectionCount.value, 2);
    assert.deepEqual(u.uSections.value[0].toArray(), [.9991, 1.0007, -.022, .021]);
    assert.deepEqual(u.uGaps.value[0].toArray().slice(0, 2), [.42, .27]);
    assert.deepEqual(u.uSections.value[1].toArray(), [.9986, 1.0009, .021, .024]);
    assert.deepEqual(u.uGaps.value[1].toArray().slice(0, 2), [.48, .31]);
    body.shape.parts[0].gapHalfAngle = .12;
    body.shape.parts[0].minY = -40000;
    update();
    assert.equal(u.uGaps.value[0].y, .12, 'no renderer-local rule replaces a changed gap');
    assert.equal(u.uSections.value[0].z, -.04);
    assert.equal(group.children[1].visible, false);
  } finally { group.userData.dispose(); }
});

test('uploaded wall clearances retain grazing hit distances as a camera skims a large tilted ring', () => {
  const {group, body, camera, update} = fixture();
  const radius = 3321532, inner = radius - 1923;
  body.radius = radius;
  body.frame = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(.42, -.81, 1.2))).toArray();
  body.shape.parts[0].innerRadius = inner;
  body.shape.parts[0].outerRadius = radius + 1923;
  body.shape.parts[1].innerRadius = inner - 866;
  body.shape.parts[1].outerRadius = radius + 2596;
  const toWorld = new THREE.Matrix3().fromArray(body.frame).transpose();
  try {
    for (const altitude of [15, 80]) {
      const rho = inner - altitude;
      const local = new THREE.Vector3(rho * Math.cos(2.3), -9610, rho * Math.sin(2.3));
      body.center = local.applyMatrix3(toWorld).negate().toArray();
      camera.lookAt(camera.position.clone().add(new THREE.Vector3(...body.center)));
      update();
      const gaps = group.children[0].material.uniforms.uGaps.value;
      for (const [i, part] of body.shape.parts.entries()) {
        for (const [side, wall] of [part.innerRadius, part.outerRadius].entries()) {
          // A horizontal tangent reaches an enclosing cylinder at this chord
          // length. A camera outside the cylinder must miss both tangent rays.
          const squaredChord = -Math.fround(gaps[i].getComponent(side + 2)) * radius ** 2;
          const reference = (wall - rho) * (wall + rho);
          assert.equal(Math.sign(squaredChord), Math.sign(reference));
          if (reference > 0) assert.ok(Math.abs(Math.sqrt(squaredChord) - Math.sqrt(reference)) < .05);
        }
      }
    }
  } finally { group.userData.dispose(); }
});

test('optional surface ports follow their current body without leaking across reused slots', () => {
  const {group,body,camera}=fixture();
  const port={along:-12000,across:3400,angle:Math.PI/3,size:[3000,1200],terrainReferenceRadius:250000};
  body.habitatPort=port;
  try {
    group.userData.update({body,camera,viewportHeight:720});
    const material=group.children[0].material,u=material.uniforms;
    const portUniform=u.uHabitatPort.value;
    assert.equal(u.uHasHabitatPort.value,true);
    assert.deepEqual(u.uHabitatSize.value.toArray(),[3000,1200]);
    assert.deepEqual(portUniform.toArray(),[-12000,3400]);
    assert.equal(u.uHabitatTerrainReferenceRadius.value,250000);
    assert.ok(u.uHabitatPortAxes.value.distanceTo(new THREE.Vector2(.5,Math.sqrt(3)/2))<1e-12);
    const sections=u.uSections.value.map(section=>section.toArray());
    const replacement={...body,habitatPort:undefined};
    group.userData.update({body:replacement,camera,viewportHeight:720});
    assert.equal(u.uHasHabitatPort.value,false,'the previous port is not assigned to the next body');
    assert.equal(u.uHabitatPort.value,portUniform);
    assert.deepEqual(u.uSections.value.map(section=>section.toArray()),sections,'surface art never changes the authoritative solid');
    group.userData.update({body,camera,viewportHeight:720});
    assert.equal(group.children[0].material,material);
    assert.equal(u.uHabitatPort.value,portUniform);
    const unrotated={...body,habitatPort:{along:0,across:0,size:[400,200]}};
    group.userData.update({body:unrotated,camera,viewportHeight:720});
    assert.deepEqual(u.uHabitatPortAxes.value.toArray(),[1,0],'omitted angle restores the default port axes');
    assert.equal(u.uHabitatTerrainReferenceRadius.value,body.radius,'an ordinary port retains the original terrain coordinates');
    assert.deepEqual(body.habitatPort,port);
  } finally {group.userData.dispose();}
});

test('an optional borrowed port image activates after image readiness and remains caller-owned', () => {
  const habitatTexture=new THREE.Texture();
  let disposals=0;
  habitatTexture.addEventListener('dispose',()=>disposals++);
  const {group,body,update}=fixture('ring',{habitatTexture});
  body.habitatPort={along:0,across:0,size:[400,200]};
  try {
    update();
    const uniforms=group.children[0].material.uniforms;
    assert.equal(uniforms.uHabitatMap.value,habitatTexture);
    assert.equal(uniforms.uHasHabitatMap.value,false,'a loader placeholder does not replace the native material');
    habitatTexture.image={width:0,height:0};update();
    assert.equal(uniforms.uHasHabitatMap.value,false);
    habitatTexture.image={width:512,height:256};update();
    assert.equal(uniforms.uHasHabitatMap.value,true,'the same texture can complete asynchronously');
    group.userData.dispose();
    assert.equal(disposals,0,'the renderer never disposes the caller image');
  } finally {group.userData.dispose();habitatTexture.dispose();}
  assert.equal(disposals,1);
});

test('the physical ray remains correct after camera rotation, floating-origin movement and viewport changes', () => {
  const { group, body, camera, update } = fixture('dark-world');
  try {
    update();
    const u = group.children[0].material.uniforms;
    const originUniform = u.uBodyOrigin.value, cameraUniform = u.uCameraRotation.value, sections = u.uSections.value;
    const direction = new THREE.Vector3(0, 0, 1).applyMatrix4(u.uInverseProjection.value).normalize().applyMatrix3(u.uCameraRotation.value);
    const expected = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(direction.distanceTo(expected) < 1e-12);
    assert.ok(direction.clone().applyMatrix3(u.uViewRotation.value).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-12);
    const oldSize = u.uPixelAngle.value;
    camera.position.addScalar(9000000);camera.lookAt(0, 0, 0);body.center[0] -= 9000000;
    group.userData.update({ body, camera, viewportHeight: 1440, pixelRatio: 1.25 });
    assert.equal(u.uPixelAngle.value, oldSize / 2);
    assert.equal(u.uBodyOrigin.value.x, 7);
    assert.equal(u.uBodyOrigin.value, originUniform);
    assert.equal(u.uCameraRotation.value, cameraUniform);
    assert.equal(u.uSections.value, sections, 'stable update workspaces');
    assert.equal(group.children[0].frustumCulled, false, 'physical 4M distance is never clipped as a small proxy mesh');
  } finally { group.userData.dispose(); }
});

test('one body slot switches between opaque solids, translucent rings and emissive prominences', () => {
  const { group, body, camera, update } = fixture('gas-giant');
  try {
    body.ringed = true;update();
    const [solid, overlay] = group.children;
    assert.equal(solid.material.depthWrite, true);
    assert.equal(solid.material.transparent, false);
    assert.equal(overlay.material.depthWrite, false);
    assert.equal(overlay.material.depthTest, true);
    assert.equal(overlay.material.transparent, true);
    assert.equal(overlay.visible, true);
    assert.equal(overlay.material.blending, THREE.NormalBlending);
    body.kind = 'stellar-giant';body.ringed = false;body.prominences = [{ axis: [0, 1, 0], radii: [.06, .1] }];update();
    assert.equal(overlay.visible, true);
    assert.equal(overlay.material.blending, THREE.AdditiveBlending);
    assert.equal(typeof overlay.userData.setSceneDepth, 'function');
    assert.deepEqual(solid.material.uniforms.uPlasmaAxes.value[0].toArray(), [0, 1, 0]);
    body.prominences = [];update();
    assert.equal(overlay.visible, false);
    assert.equal(overlay.userData.setSceneDepth, undefined);
    assert.deepEqual(solid.material.uniforms.uPlasmaAxes.value[0].toArray(), [0, 0, 0]);
    body.kind = 'gas-giant';body.ringed = true;update();
    assert.equal(overlay.visible, true);
    assert.equal(overlay.material.blending, THREE.NormalBlending);
    group.userData.update({ body: null, camera, viewportHeight: 720 });
    assert.equal(group.visible, false);
  } finally { group.userData.dispose(); }
});

test('a fixed-range multi-body query keeps simultaneous solids and reuses slots when the query changes', () => {
  const { group, body } = fixture('dark-world');
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  const second = { ...body, id: 'second', center: [2000000, 0, -4000000] };
  const behind = { ...body, id: 'behind', center: [0, 0, 4000000] };
  body.center = [0, 0, -4000000];
  try {
    group.userData.update({ bodies: [body, second, behind], camera, viewportHeight: 720 });
    assert.equal(group.children.length, 6);
    assert.equal(group.children[0].visible, true);assert.equal(group.children[2].visible, true);
    assert.equal(group.children[4].visible, false, 'physical support is wholly behind the near plane');
    assert.equal(group.children[0].geometry, group.children[4].geometry);
    const slot = group.children[2], material = slot.material;
    const bounds = material.uniforms.uScreenBounds.value;
    for (let i = 0; i < 160; i++) {
      const y = 1 - (i + .5) / 80, angle = i * 2.399963229728653;
      const point = new THREE.Vector3(Math.sqrt(1 - y * y) * Math.cos(angle), y, Math.sqrt(1 - y * y) * Math.sin(angle));
      point.multiplyScalar(second.radius).add(new THREE.Vector3().fromArray(second.center)).project(camera);
      if (point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1)
        assert.ok(point.x >= bounds.x && point.x <= bounds.z && point.y >= bounds.y && point.y <= bounds.w, 'projected solid fits its conservative screen quad');
    }
    group.userData.update({ bodies: [second], camera, viewportHeight: 720 });
    assert.equal(group.children[2], slot);assert.equal(slot.material, material);
    assert.equal(slot.visible, false);assert.equal(group.children[4].visible, false);
    group.userData.update({ bodies: [], camera, viewportHeight: 720 });
    assert.equal(group.visible, false);
  } finally { group.userData.dispose(); }
});

test('far partial visibility blends without owning depth and shares physical transparent ordering with overlays', () => {
  const { group, body } = fixture('gas-giant');
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  body.center = [0, 0, -28000000];body.ringed = true;body.visibility = .5;
  const near = { ...body, center: [0, 0, -4000000], visibility: 1 };
  try {
    group.userData.update({ bodies: [near, body], camera, viewportHeight: 720 });
    const [nearSurface, nearOverlay, farSurface, farOverlay] = group.children;
    assert.equal(nearSurface.material.transparent, false);assert.equal(nearSurface.material.depthWrite, true);
    assert.equal(farSurface.material.transparent, true);assert.equal(farSurface.material.depthWrite, false);
    assert.equal(farSurface.material.uniforms.uVisibility.value, .5);
    assert.equal(farSurface.renderOrder, farOverlay.renderOrder);
    assert.ok(farSurface.renderOrder < nearOverlay.renderOrder, 'far surface and overlay draw before the near overlay');
    body.visibility = 0;
    group.userData.update({ bodies: [body], camera, viewportHeight: 720 });
    assert.equal(nearSurface.visible, false);assert.equal(nearOverlay.visible, false);
    body.visibility = 1;
    group.userData.update({ bodies: [body], camera, viewportHeight: 720 });
    assert.equal(nearSurface.material.transparent, false);assert.equal(nearSurface.material.depthWrite, true);
    assert.equal(nearSurface.material.uniforms.uVisibility.value, 1);
  } finally { group.userData.dispose(); }
});

test('dispose releases each owned GPU resource once and retains borrowed texture ownership', () => {
  const texture = new THREE.Texture(), group = createCosmicBodies({ surfaceTexture: texture, cloudTexture: texture, stellarTexture: texture });
  let textures = 0, geometries = 0, materials = 0, metadataTextures = 0;
  texture.addEventListener('dispose', () => textures++);
  group.children[0].geometry.addEventListener('dispose', () => geometries++);
  const metadata = group.children[0].material.uniforms.uRingLattices.value;
  metadata.addEventListener('dispose', () => metadataTextures++);
  assert.equal(group.children[1].material.uniforms.uRingLattices.value, metadata);
  assert.equal(group.children[0].children[0].material.uniforms.uRingLattices.value, metadata);
  for (const mesh of group.children) mesh.material.addEventListener('dispose', () => materials++);
  group.children[0].children[0].material.addEventListener('dispose',()=>materials++);
  group.userData.dispose();group.userData.dispose();
  assert.equal(geometries, 1);assert.equal(materials, 3);assert.equal(textures, 0);assert.equal(metadataTextures, 1);
  assert.equal(group.children.length, 0);assert.equal(group.visible, false);
  group.userData.update({ body: {}, camera: null });
  assert.equal(group.visible, false, 'late updates cannot revive a disposed surface');
  texture.dispose();
});

test('optional habitat material bundle reaches every actual slot while maps remain borrowed on disposal',()=>{
  const maps={rockColor:new THREE.Texture(),rockNormal:new THREE.Texture(),groundColor:new THREE.Texture(),groundNormal:new THREE.Texture()};
  const expectedRockMean=[.2,.3,1],expectedGroundMean=[.14,.11,.09];
  const bundle=Object.freeze({...maps,rockTileSize:4,groundTileSize:6,rockColorMean:[...expectedRockMean],groundColorMean:[...expectedGroundMean]});
  const {group,body,camera}=fixture('ring',{habitatMaterials:bundle});
  const disposal={rockColor:0,rockNormal:0,groundColor:0,groundNormal:0,geometry:0,materials:0,metadata:0,terrain:0};
  for(const key of Object.keys(maps))maps[key].addEventListener('dispose',()=>disposal[key]++);
  try{
    const second={...body,id:'second-habitat-material-slot',center:[1000000,0,-4000000]};
    group.userData.update({bodies:[body,second],camera,viewportHeight:720});
    assert.equal(group.children.length,4);
    group.children[0].geometry.addEventListener('dispose',()=>disposal.geometry++);
    const bindings={uHabitatRockColor:'rockColor',uHabitatRockNormal:'rockNormal',uHabitatGroundColor:'groundColor',uHabitatGroundNormal:'groundNormal'};
    for(let slot=0;slot<2;slot++){
      const solid=group.children[slot*2],overlay=group.children[slot*2+1],air=solid.children[0],u=solid.material.uniforms;
      assert.equal(u.uHasHabitatMaterials.value,true);
      assert.deepEqual(u.uHabitatMaterialTileSize.value.toArray(),[4,6]);
      assert.ok(u.uHabitatRockColorMean.value instanceof THREE.Vector3);
      assert.ok(u.uHabitatGroundColorMean.value instanceof THREE.Vector3);
      assert.deepEqual(u.uHabitatRockColorMean.value.toArray(),expectedRockMean);
      assert.deepEqual(u.uHabitatGroundColorMean.value.toArray(),expectedGroundMean);
      assert.notEqual(u.uHabitatRockColorMean.value,u.uHabitatGroundColorMean.value);
      for(const [name,key]of Object.entries(bindings)){
        assert.equal(u[name].value,maps[key]);
        assert.equal(maps[key].version,0,'borrowing must not change the caller texture upload state');
      }
      for(const mesh of [solid,overlay,air]){
        assert.equal(mesh.material.uniforms,u);
        mesh.material.addEventListener('dispose',()=>disposal.materials++);
      }
      u.uRingLattices.value.addEventListener('dispose',()=>disposal.metadata++);
      u.uHabitatTerrain.value.addEventListener('dispose',()=>disposal.terrain++);
    }
    const first=group.children[0].material.uniforms,secondUniforms=group.children[2].material.uniforms;
    assert.notEqual(first.uHabitatRockColorMean.value,secondUniforms.uHabitatRockColorMean.value);
    assert.notEqual(first.uHabitatGroundColorMean.value,secondUniforms.uHabitatGroundColorMean.value);
    bundle.rockColorMean[0]=.9;bundle.groundColorMean[1]=.8;
    for(const u of [first,secondUniforms]){
      assert.deepEqual(u.uHabitatRockColorMean.value.toArray(),expectedRockMean,'slot means copy the caller array');
      assert.deepEqual(u.uHabitatGroundColorMean.value.toArray(),expectedGroundMean,'slot means copy the caller array');
    }
    first.uHabitatRockColorMean.value.x=.5;first.uHabitatGroundColorMean.value.y=.5;
    assert.deepEqual(secondUniforms.uHabitatRockColorMean.value.toArray(),expectedRockMean,'slot vectors do not alias each other');
    assert.deepEqual(secondUniforms.uHabitatGroundColorMean.value.toArray(),expectedGroundMean,'slot vectors do not alias each other');
    group.userData.dispose();group.userData.dispose();
    assert.equal(disposal.geometry,1);assert.equal(disposal.materials,6);
    assert.equal(disposal.metadata,2);assert.equal(disposal.terrain,2);
    for(const key of Object.keys(maps))assert.equal(disposal[key],0,`${key} belongs to the embedding app`);
    assert.equal(group.children.length,0);
  }finally{
    group.userData.dispose();
    for(const texture of Object.values(maps))texture.dispose();
  }
  for(const key of Object.keys(maps))assert.equal(disposal[key],1,'the embedding owner can still release each borrowed map exactly once');
});

test('habitat scan phases preserve a stationary body point across signed tile crossings and reuse their uniform records',()=>{
  const map=new THREE.Texture(),tileSizes=[4,6],seed=new THREE.Vector3(19013,7301,11027);
  const materials={rockColor:map,rockNormal:map,groundColor:map,groundNormal:map,
    rockTileSize:tileSizes[0],groundTileSize:tileSizes[1],rockColorMean:[1,1,1],groundColorMean:[1,1,1]};
  const uniforms=cosmicBodyUniforms({habitatMaterials:materials}),withoutMaps=cosmicBodyUniforms();
  const names=['uHabitatRockPhase','uHabitatGroundPhase'],records=names.map(name=>uniforms[name]),vectors=records.map(record=>record.value);
  const bodyFrame=new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.73,-1.2,2.1)));
  const toWorld=bodyFrame.clone().transpose(),phase=.3;
  // Both tiles divide these positive/negative boundaries. A nearby stationary
  // world point must retain its image phase while the camera crosses them.
  const boundary=new THREE.Vector3(999996,-799992,399996);
  const worldPoint=boundary.clone().add(new THREE.Vector3(12.375,18.75,21.625)).addScaledVector(seed,-phase).applyMatrix3(toWorld);
  const fixedBodyPoint=worldPoint.clone().applyMatrix3(bodyFrame).addScaledVector(seed,phase);
  const body={kind:'moon',radius:1000000,phase,frame:bodyFrame.toArray(),light:[1,0,0],tint:[1,1,1],shape:{type:'sphere',radius:1000000}};
  const wrapError=(a,b)=>Math.abs(a-b-Math.round(a-b));
  try{
    for(const delta of [-.125,.125]){
      const camera=boundary.clone().add(new THREE.Vector3(delta,-delta,delta)).addScaledVector(seed,-phase).applyMatrix3(toWorld);
      body.center=camera.clone().negate().toArray();
      setCosmicBody(uniforms,body);setCosmicBody(withoutMaps,body);
      const cameraSeed=camera.clone().applyMatrix3(bodyFrame).addScaledVector(seed,phase);
      const offset=worldPoint.clone().sub(camera).applyMatrix3(bodyFrame);
      for(let tileIndex=0;tileIndex<tileSizes.length;tileIndex++){
        const name=names[tileIndex],tile=tileSizes[tileIndex],value=uniforms[name].value;
        assert.equal(uniforms[name],records[tileIndex]);assert.equal(value,vectors[tileIndex]);
        for(let axis=0;axis<3;axis++){
          const p=value.getComponent(axis),expectedOrigin=cameraSeed.getComponent(axis)/tile;
          assert.ok(p>=0&&p<1,'phase is reduced before float32 upload');
          assert.ok(wrapError(Math.fround(p),expectedOrigin)<1e-7,'uploaded phase matches the independent double body-frame position');
          const sampled=Math.fround(Math.fround(offset.getComponent(axis)/tile)+Math.fround(p));
          assert.ok(wrapError(sampled,fixedBodyPoint.getComponent(axis)/tile)<1/1024,'the fixed world point retains its image phase within one 1K texel');
        }
        assert.deepEqual(withoutMaps[name].value.toArray(),[0,0,0],'the optional procedural path does not compute map phases');
      }
    }
  }finally{
    for(const u of [uniforms,withoutMaps]){u.uHabitatTerrain.value.dispose();u.uRingLattices.value.dispose();}
    map.dispose();
  }
});

test('omitted, null and undefined habitat bundles retain the disabled procedural program state',()=>{
  for(const options of [undefined,{habitatMaterials:null},{habitatMaterials:undefined}]){
    const {group,update}=fixture('ring',options);
    try{
      update();const solid=group.children[0],u=solid.material.uniforms;
      assert.equal(u.uHasHabitatMaterials.value,false);
      for(const name of ['uHabitatRockColor','uHabitatRockNormal','uHabitatGroundColor','uHabitatGroundNormal'])assert.equal(u[name].value,null);
      assert.deepEqual(u.uHabitatMaterialTileSize.value.toArray(),[1,1]);
      assert.deepEqual(u.uHabitatRockColorMean.value.toArray(),[1,1,1]);
      assert.deepEqual(u.uHabitatGroundColorMean.value.toArray(),[1,1,1]);
      assert.equal(solid.children[0].material.uniforms,u);
      update();assert.equal(u.uHasHabitatMaterials.value,false);
    }finally{group.userData.dispose();}
  }
});

test('habitat material factory rejects incomplete textures, invalid world tiles and invalid linear RGB means at entry',()=>{
  const maps={rockColor:new THREE.Texture(),rockNormal:new THREE.Texture(),groundColor:new THREE.Texture(),groundNormal:new THREE.Texture()};
  const valid={...maps,rockTileSize:4,groundTileSize:6,rockColorMean:[.2,.3,.4],groundColorMean:[.14,.11,.09]};
  try{
    for(const key of Object.keys(maps))for(const invalid of [undefined,null,{},0]){
      assert.throws(()=>createCosmicBodies({habitatMaterials:{...valid,[key]:invalid}}),TypeError);
    }
    for(const key of ['rockTileSize','groundTileSize'])for(const invalid of [0,-1,NaN,Infinity,-Infinity,undefined,'4']){
      assert.throws(()=>createCosmicBodies({habitatMaterials:{...valid,[key]:invalid}}),RangeError);
    }
    for(const key of ['rockColorMean','groundColorMean'])for(const invalid of [undefined,null,[],[.2,.3],[.2,.3,.4,.5],
      [.2,0,.3],[.2,-.1,.3],[.2,NaN,.3],[.2,Infinity,.3],[.2,-Infinity,.3],[.2,1.01,.3],[.2,undefined,.3],new Float32Array([.2,.3,.4])]){
      assert.throws(()=>createCosmicBodies({habitatMaterials:{...valid,[key]:invalid}}),RangeError);
    }
    assert.throws(()=>createCosmicBodies({habitatMaterials:{}}),TypeError);
  }finally{for(const texture of Object.values(maps))texture.dispose();}
});

test('borrowed foliage atlas reaches two visible vegetation slots with independent UVs and owned draw cleanup',()=>{
  const color=new THREE.Texture({width:1024,height:512}),alpha=new THREE.Texture({width:1024,height:512}),expectedUV=[0,.25,1,.75];
  const bundle=Object.freeze({color,alpha,uvRect:[...expectedUV]});
  const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-vegetation-fixture'};
  const parts=cosmicRingParts(options),habitat=createRingHabitat({...options,parts}),inner=parts[0].innerRadius;
  const body={...options,id:'foliage-material-slot',kind:'ring',frame,center:[0,0,0],light:[.4,.8,.2],tint:[.5,.58,.64],
    shape:{type:'compound',parts,terrainGroups:habitat.terrainGroups},habitat:{climate:habitat.climate,ecology:habitat.ecology}};
  let selected=false;
  for(const patch of habitat.terrainGroups){
    for(let i=0;i<patch.topGrid.columns*patch.topGrid.rows;i++){
      const p=patch.vertices[i],x=p[0]+patch.center[0],y=p[1]+patch.center[1],z=p[2]+patch.center[2],r=Math.hypot(x,z),h=inner-r,n=patch.normals[i];
      if(h>100&&h<500&&-(n[0]*x+n[2]*z)/r>.94){
        body.center=[-x*(1-120/r),-y,-z*(1-120/r)];selected=true;break;
      }
    }
    if(selected)break;
  }
  assert.ok(selected,'a retained low mountain shoulder actually activates nearby vegetation');
  const group=createCosmicBodies({foliageMaterial:bundle}),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  const disposal={color:0,alpha:0,geometry:0,materials:0};
  color.addEventListener('dispose',()=>disposal.color++);alpha.addEventListener('dispose',()=>disposal.alpha++);
  try{
    group.userData.update({bodies:[body,{...body,id:'second-foliage-material-slot',center:[...body.center]}],camera,viewportHeight:1000,pixelRatio:1});
    assert.equal(group.children.length,4);
    const slots=[];
    for(let slot=0;slot<2;slot++){
      const opaque=group.children[slot*2],vegetation=opaque.children[1],u=vegetation.userData.foliageUniforms;
      assert.equal(vegetation.visible,true);assert.equal(vegetation.children.length,3);
      assert.ok(vegetation.userData.stats.instances>0);
      assert.equal(u.uHasHabitatFoliage.value,true);assert.equal(u.uHabitatFoliageColor.value,color);assert.equal(u.uHabitatFoliageAlpha.value,alpha);
      assert.ok(u.uHabitatFoliageUV.value instanceof THREE.Vector4);assert.deepEqual(u.uHabitatFoliageUV.value.toArray(),expectedUV);
      assert.equal(opaque.material.uniforms.uHasHabitatFoliage,undefined,'tree samplers belong to the vegetation owner');
      for(const mesh of vegetation.children){
        for(const name of ['uHasHabitatFoliage','uHabitatFoliageColor','uHabitatFoliageAlpha','uHabitatFoliageUV'])assert.equal(mesh.material.uniforms[name],u[name]);
        mesh.geometry.addEventListener('dispose',()=>disposal.geometry++);mesh.material.addEventListener('dispose',()=>disposal.materials++);
      }
      slots.push(u);
    }
    assert.notEqual(slots[0].uHabitatFoliageUV.value,slots[1].uHabitatFoliageUV.value);
    bundle.uvRect[0]=.125;bundle.uvRect[1]=.375;
    for(const u of slots)assert.deepEqual(u.uHabitatFoliageUV.value.toArray(),expectedUV,'caller arrays are copied into slot-owned UV vectors');
    slots[0].uHabitatFoliageUV.value.x=.2;
    assert.deepEqual(slots[1].uHabitatFoliageUV.value.toArray(),expectedUV);
    assert.equal(color.version,0);assert.equal(alpha.version,0,'borrowing does not alter texture upload state');
    group.userData.dispose();group.userData.dispose();
    assert.equal(disposal.geometry,6);assert.equal(disposal.materials,6);
    assert.equal(disposal.color,0);assert.equal(disposal.alpha,0);
  }finally{group.userData.dispose();color.dispose();alpha.dispose();}
  assert.equal(disposal.color,1);assert.equal(disposal.alpha,1,'the app remains the atlas owner');
});

test('omitted, null and undefined foliage bundles keep procedural vegetation enabled without atlas samplers',()=>{
  for(const options of [undefined,{foliageMaterial:null},{foliageMaterial:undefined}]){
    const {group,update}=fixture('ring',options);
    try{
      update();const u=group.children[0].children[1].userData.foliageUniforms;
      assert.equal(u.uHasHabitatFoliage.value,false);
      assert.equal(u.uHabitatFoliageColor.value,null);assert.equal(u.uHabitatFoliageAlpha.value,null);
      assert.deepEqual(u.uHabitatFoliageUV.value.toArray(),[0,0,1,1]);
    }finally{group.userData.dispose();}
  }
});

test('foliage bundle rejects missing textures, unloaded dimensions and invalid UV rectangles before allocation',()=>{
  const loadedImage={width:1024,height:512};
  const color=new THREE.Texture(loadedImage),alpha=new THREE.Texture({width:1024,height:512}),valid={color,alpha,uvRect:[0,0,1,1]};
  try{
    for(const key of ['color','alpha'])for(const invalid of [undefined,null,{},1])
      assert.throws(()=>createCosmicBodies({foliageMaterial:{...valid,[key]:invalid}}),TypeError);
    for(const image of [null,{}, {width:0,height:512},{width:-1,height:512},{width:Infinity,height:512},{width:'1024',height:512},
      {width:1024},{height:512},{width:1024,height:0},{width:1024,height:NaN},{width:1024,height:Infinity}]){
      color.image=image;
      assert.throws(()=>createCosmicBodies({foliageMaterial:valid}),{name:'RangeError',message:/loaded dimensions/});
    }
    color.image=null;
    assert.throws(()=>createCosmicBodies({foliageMaterial:{...valid,alpha:null}}),TypeError,'missing textures are rejected before image dimensions');
    color.image=loadedImage;
    for(const uvRect of [undefined,null,[],[0,0,1],[0,0,1,1,0],[0,0,NaN,1],[0,0,Infinity,1],[0,0,-Infinity,1],
      [-.1,0,1,1],[0,0,1.1,1],[.8,0,.2,1],[0,.8,1,.2],[.5,0,.5,1],[0,.5,1,.5],[0,undefined,1,1],new Float32Array([0,0,1,1])])
      assert.throws(()=>createCosmicBodies({foliageMaterial:{...valid,uvRect}}),{name:'RangeError',message:/UV rectangle/});
    assert.throws(()=>createCosmicBodies({foliageMaterial:{}}),TypeError);
  }finally{color.dispose();alpha.dispose();}
});

test('ring metadata preserves CPU admitted columns when the rounded gap would admit an extra plate', () => {
  const { group, body, update } = fixture();
  Object.assign(body, { radius: 624409.496, halfWidth: .022913999999999997, thickness: .0006649399999999995, phase: 2.4406114 });
  // Recorded real support at the float32 admission boundary, independent
  // of later ring-shell additions.
  const recorded={type:'annular-sector-slab',innerRadius:624741.6518802162,outerRadius:626998.0975350233,
    minY:-14522.334979214156,maxY:14522.334979214156,gapCenter:10.687292115673205,gapHalfAngle:3.132029518005667};
  recorded.surfaceLattice=createRingSurfaceLattice(recorded,{seed:0xffffff,depth:64});
  body.shape.parts=[recorded];
  try {
    update();
    const texture = group.children[0].material.uniforms.uRingLattices.value, data = texture.image.data;
    assert.equal(texture.image.width, 64);assert.equal(texture.image.height, 2);
    assert.equal(data.byteLength,2048,'the second metadata row adds 1024 owned bytes');
    assert.equal(texture.type, THREE.FloatType);assert.equal(texture.format, THREE.RGBAFormat);
    assert.equal(texture.minFilter, THREE.NearestFilter);assert.equal(texture.magFilter, THREE.NearestFilter);
    assert.equal(texture.generateMipmaps, false);assert.ok(data instanceof Float32Array);
    const lattice = body.shape.parts[0].surfaceLattice, offset = 0;
    const roundedTau = Math.fround(Math.PI * 2), roundedStep = Math.fround(roundedTau / lattice.columns);
    const roundedLast = Math.floor(Math.fround(Math.fround(roundedTau - Math.fround(lattice.gapHalfAngle)) / roundedStep)) - 1;
    assert.equal(lattice.lastColumn, 657);assert.equal(roundedLast, 658, 'the original gap-based decision really differs after upload');
    const counts = data[offset], columns = Math.floor(counts / 128), rows = counts - columns * 128;
    const admitted = data[offset + 2], first = Math.floor(admitted / 4096), last = admitted - first * 4096;
    assert.equal(columns, lattice.columns);assert.equal(rows, lattice.rows);
    assert.equal(data[offset + 1], lattice.seed);
    assert.equal(first, lattice.firstColumn);assert.equal(last, lattice.lastColumn);
    const version = texture.version, buffer = data.buffer;
    update();update();
    assert.equal(texture.version, version, 'unchanged metadata does not trigger another GPU upload');
    assert.equal(texture.image.data.buffer, buffer);
  } finally { group.userData.dispose(); }
});

test('tiered metadata retains exact zero and maximum seeds without reducing the row range', () => {
  const {group,body,update}=fixture();
  try{
    for(const seed of [0,0xffffff]){
      const part=body.shape.parts[0];
      part.surfaceLattice=createRingSurfaceLattice(part,{seed,depth:80,rowPitch:500,tiered:true});
      update();
      const texture=group.children[0].material.uniforms.uRingLattices.value,data=texture.image.data;
      assert.equal(data[1],-seed-1);
      assert.equal(-data[1]-1,seed);
      assert.equal(data[0]%128,part.surfaceLattice.rows);
      const version=texture.version;
      update();assert.equal(texture.version,version);
    }
    const part=body.shape.parts[0];
    part.surfaceLattice=createRingSurfaceLattice(part,{seed:0xffffff,depth:80,rowPitch:500});
    update();assert.equal(group.children[0].material.uniforms.uRingLattices.value.image.data[1],0xffffff);
  }finally{group.userData.dispose();}
});

test('each raised section retains its own normalized depth in the stable metadata texture', () => {
  const { group, body, update } = fixture();
  body.shape.parts[0].surfaceLattice = createRingSurfaceLattice(body.shape.parts[0], { depth: 17, seed: 3 });
  body.shape.parts[1].surfaceLattice = createRingSurfaceLattice(body.shape.parts[1], { depth: 41, seed: 0xffffff });
  try {
    update();
    const texture = group.children[0].material.uniforms.uRingLattices.value, data = texture.image.data;
    assert.equal(data[3], Math.fround(17 / body.radius));assert.equal(data[7], Math.fround(41 / body.radius));
    assert.equal(data[5], 0xffffff, 'the maximum generated seed survives float32 upload exactly');
    const version = texture.version;
    body.radius *= 2;update();
    assert.equal(data[3], Math.fround(17 / body.radius));assert.equal(data[7], Math.fround(41 / body.radius));
    assert.equal(texture.version, version + 1);
    update();assert.equal(texture.version, version + 1);
  } finally { group.userData.dispose(); }
});

test('simultaneous body slots own distinct metadata and clear both retired rows on reuse', () => {
  const { group, body } = fixture();
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  const plainParts = body.shape.parts;
  body.center = [0, 0, -4000000];
  body.shape.parts=cosmicRingParts({...body,broken:false});
  const second = { ...body, center: [1000000, 0, -4000000], phase: 1.19 };
  second.shape = { type: 'compound', parts: cosmicRingParts({ ...second, broken: true }) };
  let firstDisposals = 0, secondDisposals = 0;
  try {
    group.userData.update({ bodies: [body, second], camera, viewportHeight: 720 });
    const firstUniforms = group.children[0].material.uniforms, secondUniforms = group.children[2].material.uniforms;
    const firstTexture = firstUniforms.uRingLattices.value, secondTexture = secondUniforms.uRingLattices.value;
    firstTexture.addEventListener('dispose', () => firstDisposals++);
    secondTexture.addEventListener('dispose', () => secondDisposals++);
    assert.notEqual(firstTexture, secondTexture);assert.notEqual(firstTexture.image.data, secondTexture.image.data);
    assert.equal(firstTexture.image.data[1], -body.shape.parts[0].surfaceLattice.seed-1);
    assert.equal(secondTexture.image.data[1], -second.shape.parts[0].surfaceLattice.seed-1);
    const secondBytes = secondTexture.image.data.slice(), secondVersion = secondTexture.version;
    const plain = { ...body, kind: 'dark-world', center: [0, 0, -4000000], shape: { type: 'sphere', radius: body.radius } };
    group.userData.update({ body: plain, camera, viewportHeight: 720 });
    assert.equal(firstUniforms.uSectionCount.value, 0);
    assert.ok(firstTexture.image.data.every(value => value === 0), 'sphere slot reuse retires every previous lattice cell');
    assert.deepEqual(secondTexture.image.data, secondBytes);assert.equal(secondTexture.version, secondVersion);
    const clearedVersion = firstTexture.version;
    group.userData.update({ body: plain, camera, viewportHeight: 720 });
    assert.equal(firstTexture.version, clearedVersion);
    group.userData.update({ body: second, camera, viewportHeight: 720 });
    assert.equal(firstUniforms.uRingLattices.value, firstTexture);
    assert.equal(firstTexture.image.data[1], -second.shape.parts[0].surfaceLattice.seed-1);
    const plainRing = { ...body, shape: { type: 'compound', parts: plainParts } };
    group.userData.update({ body: plainRing, camera, viewportHeight: 720 });
    assert.equal(firstUniforms.uSectionCount.value, 2);
    assert.ok(firstTexture.image.data.subarray(0,SUPPORT_ROW_OFFSET).every(value=>value===0),'unplated compound has no active or retired lattice words');
    assert.ok(firstTexture.image.data.subarray(SUPPORT_ROW_OFFSET+2*4).every(value=>value===0),'both rows retire every section past the new compound');
    assert.deepEqual(Array.from(firstTexture.image.data.subarray(SUPPORT_ROW_OFFSET,SUPPORT_ROW_OFFSET+4)),originalSectionSupport(plainParts[0],body.radius).map(Math.fround));
    const plainVersion = firstTexture.version;
    group.userData.update({ body: plainRing, camera, viewportHeight: 720 });
    assert.equal(firstTexture.version, plainVersion);
  } finally { group.userData.dispose(); }
  assert.equal(firstDisposals, 1);assert.equal(secondDisposals, 1);
});

test('habitat primitives share their frame and finite metadata with the surface and air, and retire on slot reuse',()=>{
  const {group,body,camera,update}=fixture();
  const groups=[buildTerrainMesh({center:[900000,0,0],radius:2000,
    vertices:[[-1000,-1000,-1000],[1000,-1000,-1000],[1000,1000,-1000],[-1000,1000,-1000],[-1000,-1000,1000],[1000,-1000,1000],[1000,1000,1000],[-1000,1000,1000]],
    normals:[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(v=>v.map(x=>x/Math.sqrt(3))),
    faces:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]]})];
  body.shape.parts=cosmicRingParts({...body,broken:false});body.shape.terrainGroups=groups;body.habitat={climate:1,ecology:RING_HABITAT_ECOLOGY[1]};
  let disposals=0;
  try{
    update();const solid=group.children[0],air=solid.children[0],u=solid.material.uniforms,texture=u.uHabitatTerrain.value;
    texture.addEventListener('dispose',()=>disposals++);
    assert.equal(u.uHabitatGroupCount.value,1);assert.equal(u.uHabitatClimate.value,1);assert.deepEqual(u.uHabitatEcology.value.toArray(),[750,1100,.42]);
    assert.equal(air.material.uniforms.uHabitatWind,u.uHabitatWind);
    assert.deepEqual(u.uHabitatWind.value.toArray(),[0,0,0]);
    group.userData.update({body,camera,viewportHeight:720,celestialTime:15});
    assert.ok(u.uHabitatWind.value.length()>50,'flight time advances the shared cloud field');
    group.userData.update({body,camera,viewportHeight:720,celestialTime:1815});
    const wind=u.uHabitatWind.value.clone();
    group.userData.update({body,camera,viewportHeight:720,celestialTime:15});
    assert.ok(wind.equals(u.uHabitatWind.value),'wind repeats continuously within a bounded visual period');
    assert.equal(air.visible,true);assert.ok(air.renderOrder>0,'local air composites after transparent background stars');assert.equal(air.material.uniforms.uHabitatTerrain,u.uHabitatTerrain);
    const depth=new THREE.DepthTexture(1600,1000);let depthDisposals=0;
    depth.addEventListener('dispose',()=>depthDisposals++);
    air.userData.setSceneDepth(depth,1600,1000,{near:.5,far:220000});
    assert.equal(u.uSceneDepth.value,depth);assert.equal(u.uHasSceneDepth.value,1);
    assert.deepEqual(u.uDepthResolution.value.toArray(),[1600,1000]);
    air.userData.setSceneDepth(null);
    assert.equal(u.uSceneDepth.value,null);assert.equal(u.uHasSceneDepth.value,0);
    assert.equal(depthDisposals,0,'opaque depth is borrowed from the shared pass');depth.dispose();
    assert.equal(texture.image.data[0],Math.fround(.9));
    const version=texture.version,storage=texture.image.data;
    update();assert.equal(texture.version,version);assert.equal(texture.image.data,storage);
    group.userData.update({body:null,camera,viewportHeight:720});
    assert.equal(disposals,1);assert.equal(u.uHabitatTerrain.value.image.data.byteLength,16);
    const empty=u.uHabitatTerrain.value;
    group.userData.update({body:null,camera,viewportHeight:720});assert.equal(u.uHabitatTerrain.value,empty,'retired warm slots allocate nothing');
    update();assert.notEqual(u.uHabitatTerrain.value,texture);assert.equal(u.uHabitatGroupCount.value,1);

    body.kind='dark-world';body.shape={type:'sphere',radius:body.radius};body.habitat=null;update();
    assert.equal(u.uHabitatGroupCount.value,0);assert.equal(u.uHabitatClimate.value,0);assert.equal(air.visible,false);
    assert.notEqual(u.uHabitatTerrain.value,texture);assert.equal(u.uHabitatTerrain.value.image.data.byteLength,16,'retired terrain releases its large allocation');
  }finally{group.userData.dispose();}
  assert.equal(disposals,1);
});

test('gas optical depth belongs to its own transparent pass independently of planetary rings',()=>{
  const {group,body,camera,update}=fixture('gas-giant');
  try{
    body.ringed=false;const shape=structuredClone(body.shape);update();
    const solid=group.children[0],ring=group.children[1],air=solid.children[0];
    assert.equal(air.visible,true);assert.equal(ring.visible,false);
    assert.notEqual(air.material,ring.material);
    assert.equal(air.material.uniforms,solid.material.uniforms,'the same body frame and radius own every layer');
    assert.equal(air.material.depthWrite,false);assert.equal(air.material.depthTest,true);
    assert.deepEqual(body.shape,shape,'an optical column does not inflate the solid');
    body.ringed=true;update();assert.equal(ring.visible,true);assert.equal(air.visible,true);
    body.kind='dark-world';update();assert.equal(air.visible,false);
    group.userData.update({body:null,camera,viewportHeight:720});assert.equal(group.visible,false);
  }finally{group.userData.dispose();}
});

test('stellar additive air retires when the same slot becomes a gas or solid world', () => {
  const {group, body, update} = fixture('stellar-giant');
  try {
    update();
    const surface = group.children[0], air = surface.children[0];
    assert.equal(air.visible, true);
    assert.equal(air.material.blending, THREE.AdditiveBlending);
    assert.equal(air.material.depthWrite, false);
    assert.equal(air.material.uniforms, surface.material.uniforms);
    body.kind = 'gas-giant'; body.ringed = false; update();
    assert.equal(surface.children[0], air);
    assert.equal(air.visible, true);
    assert.equal(air.material.blending, THREE.NormalBlending);
    body.kind = 'dark-world'; update();
    assert.equal(air.visible, false);
  } finally { group.userData.dispose(); }
});

test('raised structures upload every slab and conservative ray supports enclose the curved sidewalls', () => {
  const {group,body,update}=fixture();
  body.shape.parts=cosmicRingParts({radius:body.radius,halfWidth:body.halfWidth,thickness:body.thickness,phase:body.phase,broken:false});
  try {
    update();
    const u=group.children[0].material.uniforms;
    assert.equal(u.uSectionSupports,undefined,'support spheres no longer reserve 64 uniform vectors');
    assert.equal(u.uSectionCount.value,body.shape.parts.length);
    assert.ok(u.uSections.value.length>=body.shape.parts.length);
    const texture=u.uRingLattices.value,data=texture.image.data;
    for(let i=0;i<body.shape.parts.length;i++){
      const p=body.shape.parts[i],support=originalSectionSupport(p,body.radius),at=SUPPORT_ROW_OFFSET+i*4;
      const packed=Array.from(data.subarray(at,at+4));
      assert.deepEqual(packed,support.map(Math.fround),'same float32 values as the former vec4 uniform upload');
      assert.deepEqual(u.uSections.value[i].toArray(),[p.innerRadius,p.outerRadius,p.minY,p.maxY].map(n=>n/body.radius));
      const center=p.gapCenter+Math.PI,half=Math.PI-p.gapHalfAngle;
      const rounding=Math.hypot(support[0]-packed[0],support[1]-packed[1],support[2]-packed[2])+Math.abs(support[3]-packed[3]);
      for(const radius of [p.innerRadius,p.surfaceLattice?.outerRadius??p.outerRadius])for(const y of [p.minY,p.maxY])for(let j=0;j<=32;j++){
        const angle=center-half+half*2*j/32;
        const x=radius*Math.cos(angle)/body.radius,yy=y/body.radius,z=radius*Math.sin(angle)/body.radius;
        assert.ok(Math.hypot(x-support[0],yy-support[1],z-support[2])<=support[3]+1e-12,`part ${i} original support encloses its physical surface`);
        assert.ok(Math.hypot(x-packed[0],yy-packed[1],z-packed[2])<=packed[3]+rounding+1e-12,`part ${i} preserves the former upload rounding bound`);
      }
    }
    const sections=u.uSections.value,version=texture.version,buffer=data.buffer;
    update();assert.equal(u.uSections.value,sections);assert.equal(texture.image.data.buffer,buffer);assert.equal(texture.version,version);
  }finally{group.userData.dispose();}
});

test('support-only metadata changes upload once while camera and unchanged float32 values reuse storage',()=>{
  const {group,body,camera,update}=fixture();
  try{
    update();const texture=group.children[0].material.uniforms.uRingLattices.value,data=texture.image.data,buffer=data.buffer;
    const initial=texture.version,original=data.slice();
    update();update();assert.equal(texture.version,initial);
    camera.position.addScalar(1200);camera.updateMatrixWorld();body.center[0]-=1200;update();
    assert.equal(texture.version,initial,'body-local supports do not depend on the camera or floating origin');
    assert.deepEqual(data,original);
    body.shape.parts[0].minY-=130;update();
    assert.equal(texture.version,initial+1);
    assert.deepEqual(Array.from(data.subarray(SUPPORT_ROW_OFFSET,SUPPORT_ROW_OFFSET+4)),originalSectionSupport(body.shape.parts[0],body.radius).map(Math.fround));
    assert.deepEqual(data.subarray(0,SUPPORT_ROW_OFFSET),original.subarray(0,SUPPORT_ROW_OFFSET),'support-only edits leave the lattice protocol unchanged');
    const changed=data.slice();
    body.shape.parts[0].minY+=1e-9;update();
    assert.deepEqual(data,changed);assert.equal(texture.version,initial+1,'changes below float32 resolution do not request another upload');
    assert.equal(data.buffer,buffer);
  }finally{group.userData.dispose();}
});

test('one group history selects only the nearest visible habitat while gas and remote air retain their direct materials', () => {
  const f = opticalFixture(), depth = new THREE.DepthTexture(64, 32);
  try {
    f.update([f.remote, f.gas, f.near]);
    const remote = f.group.children[0].children[0], gas = f.group.children[2].children[0], near = f.group.children[4].children[0];
    const directRemote = remote.material, directGas = gas.material, directNear = near.material;
    f.group.userData.prepare(f.renderer);
    assert.equal(remote.material, directRemote);assert.equal(gas.material, directGas);assert.equal(near.material, directNear);
    assert.equal(remote.material.uniforms, f.group.children[0].material.uniforms);assert.equal(gas.material.uniforms, f.group.children[2].material.uniforms);
    assert.equal(f.group.userData.habitatTemporal.targets, 0, 'binding does not create history before the opaque snapshot exists');
    for (const air of [remote, gas, near]) { air.userData.setVolumePreparation(true);air.userData.setSceneDepth(depth, 64, 32, f.camera); }
    const frames = f.group.userData.habitatTemporal.frames;
    remote.userData.prepareVolume(f.renderer, 64, 32, f.camera);gas.userData.prepareVolume(f.renderer, 64, 32, f.camera);
    assert.equal(f.group.userData.habitatTemporal.frames, frames);
    near.userData.prepareVolume(f.renderer, 64, 32, f.camera);
    assert.notEqual(near.material, directNear);assert.equal(near.material.uniforms.uBodyOrigin, f.group.children[4].material.uniforms.uBodyOrigin);
    assert.equal(f.group.userData.habitatTemporal.frames, frames + 1);assert.equal(f.group.userData.habitatTemporal.targets, 3);
    assert.equal(near.material.uniforms.uSceneDepth.value, depth);
    assert.equal(directRemote.uniforms.uHasSceneDepth.value, 1);assert.equal(directGas.uniforms.uHasSceneDepth.value, 1);
    for (const air of [remote, gas, near]) { air.userData.setSceneDepth(null);air.userData.setVolumePreparation(false); }
    assert.equal(near.material.uniforms.uSceneDepth.value, null);
    assert.equal(near.material, directNear);
    f.renderer.extensions.has = () => false;f.group.userData.prepare(f.renderer);
    assert.equal(near.material, directNear);assert.equal(remote.material, directRemote);assert.equal(gas.material, directGas);
    assert.equal(f.group.userData.habitatTemporal.targets, 0, 'losing temporal support restores every complete direct path and releases history');
  } finally { f.group.userData.dispose();depth.dispose(); }
});

test('GPU cache invalidation releases derived targets and rebuilds an unchanged habitat without disposing CPU or borrowed resources',()=>{
  const image=new THREE.Texture(),f=opticalFixture({surfaceTexture:image,cloudTexture:image}),depth=new THREE.DepthTexture(64,32);
  const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-vegetation-fixture'};
  const parts=cosmicRingParts(options),habitat=createRingHabitat({...options,parts}),inner=parts[0].innerRadius;
  Object.assign(f.near,options,{shape:{type:'compound',parts,terrainGroups:habitat.terrainGroups},habitat:{climate:habitat.climate,ecology:habitat.ecology}});
  let selected=false;
  for(const patch of habitat.terrainGroups){
    for(let i=0;i<patch.topGrid.columns*patch.topGrid.rows;i++){
      const p=patch.vertices[i],x=p[0]+patch.center[0],y=p[1]+patch.center[1],z=p[2]+patch.center[2],r=Math.hypot(x,z),h=inner-r,n=patch.normals[i];
      if(h>100&&h<500&&-(n[0]*x+n[2]*z)/r>.94){f.near.center=[-x*(1-120/r),-y,-z*(1-120/r)];selected=true;break;}
    }
    if(selected)break;
  }
  assert.ok(selected);
  let borrowedDisposals=0,cpuDisposals=0;
  image.addEventListener('dispose',()=>borrowedDisposals++);depth.addEventListener('dispose',()=>borrowedDisposals++);
  try{
    f.update([f.near]);
    const solid=f.group.children[0],air=solid.children[0],direct=air.material,u=solid.material.uniforms;
    const cpuResources=[solid.geometry,u.uHabitatTerrain.value,u.uRingLattices.value];
    for(const resource of cpuResources)resource.addEventListener('dispose',()=>cpuDisposals++);
    f.group.userData.prepare(f.renderer);
    assert.equal(f.group.userData.shadowMapCount,2);
    air.userData.setVolumePreparation(true);air.userData.setSceneDepth(depth,64,32,f.camera);
    air.userData.prepareVolume(f.renderer,64,32,f.camera);air.userData.prepareVolume(f.renderer,64,32,f.camera);
    assert.equal(f.group.userData.habitatTemporal.targets,3);assert.notEqual(air.material,direct);
    const oldTargets=new Set(f.renderer.draws.map(draw=>draw.target).filter(Boolean));
    const disposals=new Map();
    for(const target of oldTargets){disposals.set(target,0);target.addEventListener('dispose',()=>disposals.set(target,disposals.get(target)+1));}
    f.group.userData.invalidateGpuCaches();f.group.userData.invalidateGpuCaches();
    assert.equal(air.material,direct);assert.equal(f.group.userData.habitatTemporal.targets,0);
    assert.equal(f.group.userData.habitatTemporal.historyFrames,0);
    assert.equal(f.group.userData.shadowMapCount,0);assert.equal(u.uVegetationShadow.value,null);assert.equal(u.uVegetationShadowNear.value,null);
    assert.equal(cpuDisposals,0);assert.equal(borrowedDisposals,0);
    for(const count of disposals.values())assert.equal(count,1,'each invalidated target is released exactly once');
    const start=f.renderer.draws.length;
    f.group.userData.prepare(f.renderer);
    assert.equal(f.group.userData.shadowMapCount,2);
    air.userData.setVolumePreparation(true);air.userData.prepareVolume(f.renderer,64,32,f.camera);
    assert.equal(f.group.userData.habitatTemporal.historyFrames,1);
    const rebuilt=new Set(f.renderer.draws.slice(start).map(draw=>draw.target).filter(Boolean));
    assert.ok(rebuilt.size>=4,'unchanged descriptor/camera rebuilds both shadows and optical history');
    for(const target of rebuilt){assert.ok(!oldTargets.has(target));disposals.set(target,0);target.addEventListener('dispose',()=>disposals.set(target,disposals.get(target)+1));}
    f.group.userData.dispose();f.group.userData.dispose();
    for(const count of disposals.values())assert.equal(count,1);
    assert.equal(f.group.userData.habitatTemporal.targets,0);
    assert.equal(borrowedDisposals,0);
  }finally{f.group.userData.dispose();image.dispose();depth.dispose();}
});

test('a ring below the volume visibility threshold cannot take history from the nearest composited habitat', () => {
  const f = opticalFixture(), pass = new NebulaRenderPass(f.scene, f.camera), target = new THREE.WebGLRenderTarget(64, 32);
  try {
    f.near.visibility = .0005;f.update([f.near, f.remote]);
    const faint = f.group.children[0].children[0], remote = f.group.children[2].children[0], directFaint = faint.material, directRemote = remote.material;
    f.group.userData.prepare(f.renderer);pass.render(f.renderer, null, target);
    const main = f.renderer.draws.findLast(draw => draw.scene === f.scene), remoteDraw = main.visible.find(draw => draw.object === remote);
    assert.ok(remoteDraw);assert.ok(remoteDraw.material !== directRemote, 'the pass-composited ring must receive the single history');
    assert.equal(faint.material, directFaint);assert.equal(remote.material, directRemote);
    assert.equal(f.group.userData.habitatTemporal.frames, 1);assert.equal(f.group.userData.habitatTemporal.targets, 3);
  } finally { pass.dispose();f.group.userData.dispose();target.dispose(); }
});

test('nearest-body replacement, retirement and gas slot reuse release one shared history without disposing borrowed resources', () => {
  const image = new THREE.Texture(), f = opticalFixture({ surfaceTexture: image, cloudTexture: image, stellarTexture: image }), depth = new THREE.DepthTexture(64, 32);
  let imageDisposals = 0, depthDisposals = 0, geometryDisposals = 0;
  image.addEventListener('dispose', () => imageDisposals++);depth.addEventListener('dispose', () => depthDisposals++);
  try {
    f.update([f.near, f.remote]);
    const a = f.group.children[0].children[0], b = f.group.children[2].children[0], directA = a.material, directB = b.material;
    const geometry = f.group.children[0].geometry;geometry.addEventListener('dispose', () => geometryDisposals++);
    const directDisposals = [0, 0];directA.addEventListener('dispose', () => directDisposals[0]++);directB.addEventListener('dispose', () => directDisposals[1]++);
    f.group.userData.prepare(f.renderer);a.userData.setVolumePreparation(true);const presentation = a.material;let presentationDisposals = 0;
    presentation.addEventListener('dispose', () => presentationDisposals++);
    a.userData.setSceneDepth(depth, 64, 32, f.camera);
    const start = f.renderer.draws.length;
    a.userData.prepareVolume(f.renderer, 64, 32, f.camera);a.userData.prepareVolume(f.renderer, 64, 32, f.camera);
    const historyTargets = new Set(f.renderer.draws.slice(start).map(draw => draw.target));let historyDisposals = 0;
    for (const target of historyTargets) target.addEventListener('dispose', () => historyDisposals++);
    a.userData.setSceneDepth(null);a.userData.setVolumePreparation(false);
    f.remote.center = [0, 0, -1700000];f.update([f.near, f.remote]);f.group.userData.prepare(f.renderer);
    assert.equal(a.material, directA);assert.equal(b.material, directB);assert.equal(historyDisposals, historyTargets.size);
    assert.equal(f.group.userData.habitatTemporal.targets, 0);assert.equal(presentationDisposals, 0);
    b.userData.setVolumePreparation(true);assert.equal(b.material, presentation);
    b.userData.setSceneDepth(depth, 64, 32, f.camera);b.userData.prepareVolume(f.renderer, 64, 32, f.camera);b.userData.setSceneDepth(null);b.userData.setVolumePreparation(false);
    assert.equal(f.group.userData.habitatTemporal.targets, 3);
    f.update([f.near]);assert.equal(f.group.userData.habitatTemporal.targets, 0, 'dropping the selected slot retires its history immediately');
    assert.equal(b.material, directB);assert.equal(b.visible, false);
    f.group.userData.prepare(f.renderer);assert.equal(a.material, directA);a.userData.setVolumePreparation(true);assert.equal(a.material, presentation);
    a.userData.setSceneDepth(depth, 64, 32, f.camera);a.userData.prepareVolume(f.renderer, 64, 32, f.camera);a.userData.setSceneDepth(null);a.userData.setVolumePreparation(false);
    f.update([f.gas]);f.group.userData.prepare(f.renderer);
    assert.equal(a.material, directA);assert.equal(a.visible, true);assert.equal(f.group.userData.habitatTemporal.targets, 0);
    f.update([]);assert.equal(f.group.visible, false);assert.equal(f.group.userData.habitatTemporal.targets, 0);
    f.group.userData.dispose();f.group.userData.dispose();
    assert.equal(presentationDisposals, 1);assert.deepEqual(directDisposals, [1, 1]);assert.equal(geometryDisposals, 1);
    assert.equal(imageDisposals, 0);assert.equal(depthDisposals, 0);
  } finally { f.group.userData.dispose();image.dispose();depth.dispose(); }
});

for (const directPath of ['direct to screen', 'no composer buffer']) {
  test(`${directPath} retains the complete direct atmosphere with cold or previously prepared history`, () => {
    const f = opticalFixture(), pass = new NebulaRenderPass(f.scene, f.camera), target = new THREE.WebGLRenderTarget(64, 32);
    try {
      f.update([f.near]);const air = f.group.children[0].children[0], direct = air.material;
      for (const warm of [false, true]) {
        if (warm) {
          pass.renderToScreen = false;f.group.userData.prepare(f.renderer);pass.render(f.renderer, null, target);
          assert.equal(f.group.userData.habitatTemporal.targets, 3);assert.equal(air.material, direct);
        }
        f.group.userData.prepare(f.renderer);pass.renderToScreen = directPath === 'direct to screen';
        const frames = f.group.userData.habitatTemporal.frames, copies = f.renderer.copies.length;
        pass.render(f.renderer, null, pass.renderToScreen ? target : null);
        const main = f.renderer.draws.findLast(draw => draw.scene === f.scene), airDraw = main.visible.find(draw => draw.object === air);
        assert.ok(airDraw);assert.ok(airDraw.material === direct, 'an ordinary draw must consume the complete direct integral, never missing or stale history');
        assert.equal(air.material, direct);assert.equal(direct.uniforms.uSceneDepth.value, null);
        assert.equal(f.group.userData.habitatTemporal.frames, frames);assert.equal(f.renderer.copies.length, copies);
        if (!warm) assert.equal(f.group.userData.habitatTemporal.targets, 0);
      }
    } finally { pass.dispose();f.group.userData.dispose();target.dispose(); }
  });
}

for (const failedPhase of ['raw optical draw', 'history resolve', 'translucent draw']) {
  test(`a ${failedPhase} failure restores the real body/pass integration and the next frame recovers`, () => {
    const f = opticalFixture(), pass = new NebulaRenderPass(f.scene, f.camera, { reuseWorldMatrices: true });
    const depth = new THREE.DepthTexture(64, 32), target = new THREE.WebGLRenderTarget(64, 32, { depthTexture: depth, samples: 4 }), prior = new THREE.WebGLRenderTarget(8, 8);
    const failure = new Error(`${failedPhase} failed`), background = new THREE.Color(0x293847);
    const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })], geometry = new THREE.BoxGeometry();
    const mixed = new THREE.Mesh(geometry, materials);f.scene.add(mixed);f.scene.background = background;
    let depthDisposals = 0;depth.addEventListener('dispose', () => depthDisposals++);
    try {
      f.update([f.near, f.remote, f.gas]);
      const near = f.group.children[0].children[0], remote = f.group.children[2].children[0], gas = f.group.children[4].children[0];
      const airs = [near, remote, gas], direct = airs.map(air => air.material);
      f.group.userData.prepare(f.renderer);f.renderer.setRenderTarget(prior);
      const state = f.renderer.snapshot(), resolveDepth = target.resolveDepthBuffer, storeDepth = target.storeMultisampledDepthBuffer;
      pass.clearColor = new THREE.Color(0xaa1122);pass.clearAlpha = .17;
      const phases = [];
      const inspect = draw => {
        let phase;
        if (draw.scene === f.scene) phase = draw.visible.some(item => item.object === near) ? 'translucent draw' : 'opaque draw';
        else if (draw.visible.some(item => item.material.uniforms?.uTemporalRaw)) phase = 'history resolve';
        else if (draw.visible.some(item => item.material.uniforms?.uHabitatSampleIndex)) phase = 'raw optical draw';
        else return;
        phases.push(phase);
        if (phase === 'raw optical draw' || phase === 'history resolve') {
          const snapshot = f.renderer.copies.at(-1)[1];
          for (const material of direct) { assert.equal(material.uniforms.uSceneDepth.value, snapshot);assert.equal(material.uniforms.uHasSceneDepth.value, 1); }
          assert.equal(mixed.material[0], materials[0]);assert.equal(mixed.material[1].visible, false);
        }
        if (phase === 'translucent draw') {
          const nearDraw = draw.visible.find(item => item.object === near);
          assert.notEqual(nearDraw.material, direct[0]);assert.ok(nearDraw.material.uniforms.uTemporalHistory.value);
          assert.equal(draw.visible.find(item => item.object === remote).material, direct[1]);
          assert.equal(draw.visible.find(item => item.object === gas).material, direct[2]);
          assert.equal(mixed.material[0].visible, false);assert.equal(mixed.material[1], materials[1]);
        }
        return phase;
      };
      f.renderer.onRender = draw => { if (inspect(draw) === failedPhase) throw failure; };
      assert.throws(() => pass.render(f.renderer, null, target), error => error === failure);
      assert.deepEqual(phases, ['opaque draw', 'raw optical draw', 'history resolve', 'translucent draw'].slice(0, ['raw optical draw', 'history resolve', 'translucent draw'].indexOf(failedPhase) + 2));
      assert.deepEqual(f.renderer.snapshot(), state);assert.equal(f.scene.background, background);assert.equal(f.scene.matrixWorldAutoUpdate, true);
      assert.equal(mixed.material, materials);assert.equal(target.resolveDepthBuffer, resolveDepth);assert.equal(target.storeMultisampledDepthBuffer, storeDepth);
      for (let i = 0; i < airs.length; i++) {
        assert.equal(airs[i].material, direct[i]);assert.equal(direct[i].uniforms.uSceneDepth.value, null);assert.equal(direct[i].uniforms.uHasSceneDepth.value, 0);
      }
      assert.equal(depthDisposals, 0);
      phases.length = 0;f.renderer.onRender = inspect;
      f.group.userData.prepare(f.renderer);pass.render(f.renderer, null, target);
      assert.deepEqual(phases, ['opaque draw', 'raw optical draw', 'history resolve', 'translucent draw']);
      for (let i = 0; i < airs.length; i++) { assert.equal(airs[i].material, direct[i]);assert.equal(direct[i].uniforms.uSceneDepth.value, null); }
      assert.equal(f.group.userData.habitatTemporal.targets, 3);assert.equal(depthDisposals, 0);
    } finally { pass.dispose();f.group.userData.dispose();target.dispose();prior.dispose();depth.dispose();geometry.dispose();for (const material of materials) material.dispose(); }
  });
}

test('actual cosmic view release retires Halo ecology field borrowers as well as near geometry',async()=>{
 const source=fs.readFileSync(new URL('../../src/render/cosmic-bodies.js',import.meta.url),'utf8'),r=createRingHabitatRegions({parentsInBounds:()=>[],createField:()=>({statistics:{accountedBytes:256}})}),body={id:'ecology-lease',kind:'ring',habitat:{terrainRecipes:[{siteIndex:0}]}},a=await r.prepareField(body,0),b=await r.prepareField(body,0);let cleared=0;
 const entry={active:true,opaque:{visible:true},overlay:{visible:true,userData:{}},atmosphere:{visible:true,material:null},atmosphereMaterial:{},shadows:null,
 vegetationFrame:{body:{kind:'ring'}},vegetation:{userData:{update(frame){assert.equal(frame.body,null);a.release();}}},groundcover:{userData:{clear(){b.release();}}},uniforms:{uVegetationShadowEnabled:{value:1},uRockyShadowEnabled:{value:1},uHabitatTerrain:{value:{userData:{isHabitatFull:false}}},uHabitatGroupCount:{value:1}}};
 const ctx={entries:[entry],temporalEntry:null,group:{userData:{}},halo:{userData:{clear(){cleared++;assert.equal(r.stats.pinnedFields,0);}}}};vm.createContext(ctx);
 const retire=source.slice(source.indexOf('  const retireEntry=entry=>{'),source.indexOf('  const updateEntry =')),forward=source.match(/  group\.userData\.releaseTerrainView=.*\n/)[0];
 try{assert.equal(r.stats.pinnedFields,1);vm.runInContext(retire+'\n'+forward,ctx);ctx.group.userData.releaseTerrainView();assert.equal(entry.active,false);assert.equal(entry.opaque.visible,false);assert.equal(cleared,1);assert.equal(r.stats.pinnedFields,0);}finally{a.release();b.release();r.dispose();assert.equal(r.stats.accountedBytes,0);}
});
