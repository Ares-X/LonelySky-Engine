import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createRingHabitatShadows,createRingHabitatShadowUniforms} from '../../src/render/ring-habitat-shadows.js';
import {createRingHabitatVegetation} from '../../src/render/ring-habitat-vegetation.js';
import {createRingHabitat} from '../../src/ring-habitat.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';

const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-vegetation-fixture'};
const parts=cosmicRingParts(options),habitat=createRingHabitat({...options,parts});
function fixture(){
  const vegetation=createRingHabitatVegetation(),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  const body={id:'habitat-vegetation-fixture',kind:'ring',radius:options.radius,phase:options.phase,theme:options.theme,
    frame:[1,0,0,0,1,0,0,0,1],light:[.4,.8,.2],center:[0,0,0],
    shape:{type:'compound',parts,terrainGroups:habitat.terrainGroups},habitat:{climate:habitat.climate,ecology:habitat.ecology}};
  let selected=false;
  for(const patch of habitat.terrainGroups){
    for(let i=0;i<patch.topGrid.columns*patch.topGrid.rows;i++){
      const v=patch.vertices[i],x=v[0]+patch.center[0],y=v[1]+patch.center[1],z=v[2]+patch.center[2],r=Math.hypot(x,z),h=parts[0].innerRadius-r,n=patch.normals[i];
      if(h>100&&h<500&&-(n[0]*x+n[2]*z)/r>.94){
        body.center[0]=-x*(1-120/r);body.center[1]=-y;body.center[2]=-z*(1-120/r);selected=true;break;
      }
    }
    if(selected)break;
  }
  assert.ok(selected);
  const update=()=>vegetation.userData.update({body,camera,viewportHeight:1000,pixelRatio:1});
  return {vegetation,body,camera,update};
}

// Tracks both renderer's public logical rectangles and actual framebuffer state.
// Actual state deliberately differs from target defaults to exercise restoration.
class RendererProbe{
  constructor(reversed=false){
    this.capabilities={reversedDepthBuffer:reversed};this.xr={enabled:true};this.autoClear=true;
    this.target=null;this.face=0;this.mip=0;this.color=new THREE.Color(.2,.3,.4);this.alpha=.7;
    this.viewport=new THREE.Vector4(3,5,700,500);this.scissor=new THREE.Vector4(7,9,450,300);this.scissorTest=true;
    this.actualViewport=new THREE.Vector4(6,10,1400,1000);this.actualScissor=new THREE.Vector4(14,18,900,600);this.actualScissorTest=false;
    this.state={viewport:v=>this.actualViewport.copy(v),scissor:v=>this.actualScissor.copy(v),setScissorTest:v=>{this.actualScissorTest=v;}};
    this.stateReads=0;
    this.gl={SCISSOR_BOX:1,SCISSOR_TEST:2,getParameter:()=>{this.stateReads++;return this.actualScissor.toArray();},isEnabled:()=>this.actualScissorTest};
    this.renders=0;this.fail=false;this.draw=null;this.draws=[];
  }
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

test('shadows borrow every current packed LOD and its authoritative coverage, never the complete invisible master',()=>{
  const {vegetation,body,camera,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  try{
    assert.equal(shadow.uniforms.uVegetationShadow.value,null);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),false);assert.equal(renderer.renders,0);
    update();assert.ok(vegetation.visible);assert.ok(vegetation.userData.shadowMesh.geometry.instanceCount>40);
    assert.equal(vegetation.userData.shadowCasters,vegetation.userData.lodMeshes);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    const {mesh,target,scene}=renderer.draw,sources=vegetation.userData.shadowCasters,master=vegetation.userData.shadowMesh.geometry,material=mesh.material;
    assert.equal(scene.children.length,3);assert.ok(scene.children.every(caster=>caster.geometry!==master),'complete master is bounds-only and cannot cast ghost trees');
    const masterIndex=new Map(),castRoots=new Set(),masterRoots=master.attributes.iRoot,masterShapes=master.attributes.iShape;
    for(let i=0;i<master.instanceCount;i++)masterIndex.set(`${masterRoots.getX(i)},${masterRoots.getY(i)},${masterRoots.getZ(i)}`,i);
    let total=0;
    for(let detail=0;detail<3;detail++){
      const caster=scene.children[detail],source=sources[detail],g=source.geometry;
      assert.equal(caster.geometry,g);assert.equal(caster.geometry.attributes.iRoot,g.attributes.iRoot);
      assert.equal(caster.geometry.attributes.iShape,g.attributes.iShape);assert.equal(caster.geometry.attributes.iShadowCoverage,g.attributes.iShadowCoverage);
      assert.equal(g.attributes.iShadowCoverage.normalized,true);assert.equal(g.attributes.iShadowCoverage.itemSize,3);
      assert.ok(g.attributes.iShadowCoverage.array instanceof Uint8Array);
      const roots=g.attributes.iRoot,shape=g.attributes.iShape,coverage=g.attributes.iShadowCoverage;
      for(let i=0;i<g.instanceCount;i++){
        const key=`${roots.getX(i)},${roots.getY(i)},${roots.getZ(i)}`,index=masterIndex.get(key);
        assert.notEqual(index,undefined,'every rendered/casting root is an actual master tree');
        for(let component=0;component<4;component++)assert.equal(shape.array[i*4+component],masterShapes.array[index*4+component],'root and complete shape refer to the same tree');
        if(coverage.getX(i)>0&&coverage.getZ(i)>coverage.getY(i))castRoots.add(key);
      }
      assert.equal(caster.frustumCulled,false,'off-screen visible trees still cast');assert.equal(source.parent,vegetation,'borrowing does not reparent the real render mesh');
      assert.equal(caster.material,material);total+=g.instanceCount;
    }
    assert.equal(shadow.stats.instances,total);assert.equal(target.width,2048);assert.equal(target.height,2048);assert.equal(target.samples,0);
    assert.equal(target.texture.internalFormat,'R8');assert.equal(target.texture.generateMipmaps,false);
    assert.equal(shadow.uniforms.uVegetationShadowNear.value,target.depthTexture);assert.equal(material.colorWrite,false);
    assert.equal(shadow.uniforms.uVegetationShadow.value,renderer.draws[0].target.depthTexture);
    assert.ok(castRoots.size<master.instanceCount,'fully faded/invisible master trees are absent from the effective caster set');
    const rootBytes=sources.map(source=>source.geometry.attributes.iRoot.array),origin=shadow.uniforms.uVegetationShadowOrigin.value,matrix=shadow.uniforms.uVegetationShadowMatrix.value;
    const originBytes=origin.toArray(),matrixBytes=matrix.toArray();
    const stateReads=renderer.stateReads;
    for(let i=0;i<100;i++){
      camera.rotation.y+=.001;update();assert.equal(shadow.prepare(renderer,vegetation,body.light),false);
      assert.equal(renderer.draw.target,target);assert.equal(renderer.draw.mesh.material,material);
      assert.equal(shadow.uniforms.uVegetationShadowOrigin.value,origin);assert.equal(shadow.uniforms.uVegetationShadowMatrix.value,matrix);
    }
    assert.equal(renderer.stateReads,stateReads,'unchanged frames do not query GL or allocate its parameter arrays');
    assert.equal(renderer.renders,2);for(let i=0;i<3;i++)assert.equal(sources[i].geometry.attributes.iRoot.array,rootBytes[i]);
    assert.deepEqual(origin.toArray(),originBytes);assert.deepEqual(matrix.toArray(),matrixBytes);
    body.light[0]+=.1;assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    body.center[1]+=480;update();assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    sources[0].geometry.attributes.iShape.needsUpdate=true;assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    sources[0].geometry.attributes.position.needsUpdate=true;assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    sources[0].geometry.attributes.iShadowCoverage.needsUpdate=true;assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    assert.equal(renderer.draw.target,target);assert.equal(renderer.draw.mesh.material,material);
    shadow.clear();assert.equal(shadow.uniforms.uVegetationShadowEnabled.value,0);assert.equal(shadow.uniforms.uVegetationShadow.value,null);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true,'reactivation lazily creates fresh maps');
    assert.notEqual(renderer.draw.target,target);assert.notEqual(renderer.draw.mesh.material,material);
    vegetation.visible=false;assert.equal(shadow.prepare(renderer,vegetation,body.light),false);assert.equal(shadow.uniforms.uVegetationShadowEnabled.value,0);
  }finally{shadow.dispose();vegetation.userData.dispose();}
});

test('coverage-only and complementary-interval updates invalidate both maps without changing roots, shapes or projection',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  try{
    update();shadow.prepare(renderer,vegetation,body.light);
    const source=vegetation.userData.shadowCasters.find(mesh=>mesh.geometry.instanceCount>0),g=source.geometry,weight=g.attributes.iShadowCoverage;
    const roots=g.attributes.iRoot,shapes=g.attributes.iShape,count=g.instanceCount,rootVersion=roots.version,shapeVersion=shapes.version;
    const matrix=shadow.uniforms.uVegetationShadowMatrix.value.toArray(),near=shadow.uniforms.uVegetationShadowNearMatrix.value.toArray();
    const targets=renderer.draws.slice(-2).map(draw=>draw.target);
    // Simulate only the producer's uploaded visible-coverage decision. No
    // consumer distance/LOD calculation or new instance buffer is involved.
    weight.array[0]=0;weight.array[1]=0;weight.array[2]=255;weight.needsUpdate=true;
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true);assert.equal(renderer.renders,4);
    const borrowed=renderer.draw.scene.children.find(mesh=>mesh.geometry===g);
    assert.equal(borrowed.geometry.attributes.iShadowCoverage,weight);assert.equal(weight.getX(0),0,'zero coverage reaches the depth shader exactly');
    weight.array[0]=128;weight.array[1]=64;weight.array[2]=192;weight.needsUpdate=true;
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true);assert.equal(renderer.renders,6);
    assert.equal(weight.getX(0),128/255);assert.equal(weight.getY(0),64/255);assert.equal(weight.getZ(0),192/255,'interval remains independent of overall coverage');
    assert.equal(g.instanceCount,count);assert.equal(roots.version,rootVersion);assert.equal(shapes.version,shapeVersion);
    assert.deepEqual(shadow.uniforms.uVegetationShadowMatrix.value.toArray(),matrix);assert.deepEqual(shadow.uniforms.uVegetationShadowNearMatrix.value.toArray(),near);
    assert.equal(renderer.draws.at(-2).target,targets[0]);assert.equal(renderer.draws.at(-1).target,targets[1]);
    const reads=renderer.stateReads;for(let frame=0;frame<100;frame++)assert.equal(shadow.prepare(renderer,vegetation,body.light),false);
    assert.equal(renderer.renders,6);assert.equal(renderer.stateReads,reads);
  }finally{shadow.dispose();vegetation.userData.dispose();}
});

test('camera membership or coverage changes refresh casters while keeping complete-master projection bounds stable',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  try{
    const tileY=Math.floor(-body.center[1]/480);body.center[1]=-(tileY*480+240);update();
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    const master=vegetation.userData.shadowMesh.geometry,count=master.instanceCount,roots=master.attributes.iRoot,shapes=master.attributes.iShape;
    const rootVersion=roots.version,shapeVersion=shapes.version,rootBytes=roots.array.slice(),shapeBytes=shapes.array.slice();
    const lods=vegetation.userData.lodMeshes,versions=lods.map(m=>m.geometry.attributes.iRoot.version),rebuilds=vegetation.userData.stats.rebuilds;
    const target=renderer.draw.target,matrix=shadow.uniforms.uVegetationShadowMatrix.value.toArray(),origin=shadow.uniforms.uVegetationShadowOrigin.value.toArray();
    const alongLight=new THREE.Vector3().fromArray(body.light).normalize().multiplyScalar(20);
    for(let i=0;i<3;i++)body.center[i]-=alongLight.getComponent(i);update();
    assert.equal(vegetation.userData.stats.rebuilds,rebuilds,'movement stays within the authoritative forest tile');
    assert.ok(lods.some((m,i)=>m.geometry.attributes.iRoot.version>versions[i]),'movement changes real packed LOD membership');
    assert.equal(master.instanceCount,count);assert.equal(master.attributes.iRoot,roots);assert.equal(master.attributes.iShape,shapes);
    assert.equal(roots.version,rootVersion);assert.equal(shapes.version,shapeVersion);
    assert.deepEqual(roots.array,rootBytes);assert.deepEqual(shapes.array,shapeBytes);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true,'changed visible membership or weight must refresh the caster map');
    assert.equal(renderer.renders,4);assert.equal(renderer.draw.target,target);
    assert.deepEqual(shadow.uniforms.uVegetationShadowMatrix.value.toArray(),matrix);assert.deepEqual(shadow.uniforms.uVegetationShadowOrigin.value.toArray(),origin);
    update();assert.equal(shadow.prepare(renderer,vegetation,body.light),false);
  }finally{shadow.dispose();vegetation.userData.dispose();}
});

test('generic body uniforms share one state with the map owner and keep their identities through clear and reactivation',()=>{
  const {vegetation,body,update}=fixture(),defaults=createRingHabitatShadowUniforms(),otherUniform={value:7};
  const uniforms={...defaults,uOtherBodyValue:otherUniform},records=Object.entries(defaults),values=records.map(([,record])=>record.value);
  const shadow=createRingHabitatShadows({mapSize:1024,uniforms}),renderer=new RendererProbe();
  try{
    assert.equal(shadow.uniforms,uniforms);assert.equal(uniforms.uVegetationShadowEnabled.value,0);
    assert.equal(uniforms.uVegetationShadow.value,null);assert.equal(uniforms.uVegetationShadowTexel.value.x,1/1024);
    update();shadow.prepare(renderer,vegetation,body.light);
    assert.equal(uniforms.uVegetationShadow.value,renderer.draws[0].target.depthTexture);
    assert.equal(uniforms.uVegetationShadowNear.value,renderer.draw.target.depthTexture);
    shadow.clear();assert.equal(uniforms.uVegetationShadow.value,null);assert.equal(uniforms.uVegetationShadowEnabled.value,0);
    shadow.prepare(renderer,vegetation,body.light);
    for(let i=0;i<records.length;i++){
      const [name,record]=records[i];assert.equal(uniforms[name],record,'body material keeps its existing uniform record');
      if(values[i]&&typeof values[i]==='object')assert.equal(record.value,values[i],'matrix/vector identity survives clear');
    }
    assert.equal(uniforms.uOtherBodyValue,otherUniform);assert.equal(otherUniform.value,7);
  }finally{shadow.dispose();vegetation.userData.dispose();}
});

test('needle masks share exact render UVs and foliage records through shadow retirement without releasing borrowed atlas textures',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  const color=new THREE.DataTexture(new Uint8Array([20,60,30,255,35,80,25,255,30,70,20,255,15,50,20,255]),2,2);
  const alpha=new THREE.DataTexture(new Uint8Array([0,255,255,0]),2,2,THREE.RedFormat);
  let colorDisposals=0,alphaDisposals=0,materialDisposals=0;
  color.addEventListener('dispose',()=>colorDisposals++);alpha.addEventListener('dispose',()=>alphaDisposals++);
  try{
    const foliage=vegetation.userData.foliageUniforms;
    foliage.uHasHabitatFoliage.value=1;foliage.uHabitatFoliageColor.value=color;foliage.uHabitatFoliageAlpha.value=alpha;
    const rect=foliage.uHabitatFoliageUV.value;rect.set(.125,.25,.5,.5);
    update();shadow.prepare(renderer,vegetation,body.light);
    let mapped=0,unmapped=0;
    for(let detail=0;detail<3;detail++){
      const source=vegetation.userData.shadowCasters[detail],caster=renderer.draw.scene.children[detail];
      const uv=source.geometry.attributes.treeUV;
      assert.equal(caster.geometry.attributes.treeUV,uv,'the depth caster borrows the actual spray/core UV tags');
      assert.equal(uv.itemSize,3);assert.equal(uv.count,source.geometry.attributes.position.count);
      for(let vertex=0;vertex<uv.count;vertex++){
        assert.ok(uv.getZ(vertex)===0||uv.getZ(vertex)===1);
        if(uv.getZ(vertex)===1)mapped++;else unmapped++;
      }
      for(const name of ['uHasHabitatFoliage','uHabitatFoliageColor','uHabitatFoliageAlpha','uHabitatFoliageUV']){
        assert.equal(caster.material.uniforms[name],foliage[name],'visual and shadow passes retain one authoritative mask configuration');
        assert.equal(source.material.uniforms[name],foliage[name]);
      }
    }
    assert.ok(mapped>0,'real needle sprays use the alpha atlas');assert.ok(unmapped>0,'bark/core geometry remains opaque');
    const material=renderer.draw.mesh.material;material.addEventListener('dispose',()=>materialDisposals++);
    assert.equal(material.uniforms.uHabitatFoliageColor.value,color);assert.equal(material.uniforms.uHabitatFoliageAlpha.value,alpha);
    assert.equal(material.uniforms.uHabitatFoliageUV.value,rect);
    shadow.clear();assert.equal(materialDisposals,1);assert.equal(colorDisposals,0);assert.equal(alphaDisposals,0);
    assert.equal(foliage.uHasHabitatFoliage.value,1);assert.equal(foliage.uHabitatFoliageUV.value,rect);
    shadow.prepare(renderer,vegetation,body.light);
    const reactivated=renderer.draw.mesh.material;assert.notEqual(reactivated,material);
    reactivated.addEventListener('dispose',()=>materialDisposals++);
    for(const name of ['uHasHabitatFoliage','uHabitatFoliageColor','uHabitatFoliageAlpha','uHabitatFoliageUV'])assert.equal(reactivated.uniforms[name],foliage[name]);
    vegetation.visible=false;shadow.prepare(renderer,vegetation,body.light);
    assert.equal(materialDisposals,2);assert.equal(colorDisposals,0);assert.equal(alphaDisposals,0);
    shadow.dispose();vegetation.userData.dispose();
    assert.equal(colorDisposals,0);assert.equal(alphaDisposals,0,'neither borrower owns atlas disposal');
  }finally{shadow.dispose();vegetation.userData.dispose();color.dispose();alpha.dispose();}
  assert.equal(colorDisposals,1);assert.equal(alphaDisposals,1,'only the fixture atlas owner releases its textures');
});

test('near cascade has quarter-unit texels, stable snapped projection and independent camera-tile redraws',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  try{
    update();shadow.prepare(renderer,vegetation,body.light);
    const u=shadow.uniforms,farTarget=renderer.draws[0].target,nearTarget=renderer.draws[1].target;
    assert.notEqual(farTarget,nearTarget);assert.equal(shadow.stats.farRenders,1);assert.equal(shadow.stats.nearRenders,1);
    assert.equal(shadow.stats.nearSpan/nearTarget.width,.25);
    const near=u.uVegetationShadowNearMatrix.value,far=u.uVegetationShadowMatrix.value,origin=u.uVegetationShadowOrigin.value;
    const e=near.elements,right=new THREE.Vector3(e[0],e[4],e[8]).normalize();
    const nearPoint=new THREE.Vector3().copy(vegetation.userData.cameraLocal).sub(origin).applyMatrix4(near);
    // Move to the current tile centre, then a fraction of one near-map texel.
    const centred=new THREE.Vector3(.5,.5,nearPoint.z).applyMatrix4(near.clone().invert()).add(origin);
    vegetation.userData.cameraLocal.copy(centred);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),false);
    const nearBytes=near.toArray(),farBytes=far.toArray();
    vegetation.userData.cameraLocal.addScaledVector(right,.125);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),false);assert.deepEqual(near.toArray(),nearBytes);
    const a=new THREE.Vector3().copy(centred).sub(origin),b=a.clone().add(right);
    const nearPixels=a.clone().applyMatrix4(near).distanceTo(b.clone().applyMatrix4(near))*nearTarget.width;
    const farPixels=a.clone().applyMatrix4(far).distanceTo(b.clone().applyMatrix4(far))*farTarget.width;
    assert.ok(Math.abs(nearPixels-4)<1e-9);assert.ok(nearPixels>farPixels*4,'near projection resolves the same real tree much more finely');
    vegetation.userData.cameraLocal.addScaledVector(right,shadow.stats.nearTile);
    assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
    assert.equal(shadow.stats.farRenders,1);assert.equal(shadow.stats.nearRenders,2);assert.equal(renderer.renders,3);
    assert.equal(renderer.draw.target,nearTarget);assert.equal(u.uVegetationShadow.value,farTarget.depthTexture);
    assert.deepEqual(far.toArray(),farBytes);assert.equal(origin,u.uVegetationShadowOrigin.value);
    assert.ok(Math.abs((near.elements[12]-nearBytes[12])+shadow.stats.nearTile/shadow.stats.nearSpan)<1e-12,'one tile is an integer 128-texel projection shift');
  }finally{shadow.dispose();vegetation.userData.dispose();}
});

test('non-ring and empty slots release their map immediately without accumulating targets across long-flight reuse',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  let liveTargets=0,liveMaterials=0,targetDisposals=0,materialDisposals=0,sourceDisposals=0;
  try{
    update();const borrowed=[vegetation.userData.shadowMesh.geometry,...vegetation.userData.shadowCasters.map(mesh=>mesh.geometry)];
    for(const geometry of borrowed)geometry.addEventListener('dispose',()=>sourceDisposals++);
    for(let cycle=0;cycle<12;cycle++){
      body.kind='ring';update();assert.equal(shadow.prepare(renderer,vegetation,body.light),true);
      const {mesh,scene}=renderer.draw;
      for(const draw of renderer.draws.slice(-2)){
        liveTargets++;draw.target.addEventListener('dispose',()=>{targetDisposals++;liveTargets--;});
      }
      liveMaterials++;
      mesh.material.addEventListener('dispose',()=>{materialDisposals++;liveMaterials--;});
      assert.equal(liveTargets,2);assert.equal(liveMaterials,1);
      if(cycle%2===0){body.kind='gas-giant';update();assert.equal(shadow.prepare(renderer,vegetation,body.light),false);}
      else shadow.clear();
      assert.equal(liveTargets,0);assert.equal(liveMaterials,0);assert.equal(scene.children.length,0);
      assert.equal(shadow.uniforms.uVegetationShadow.value,null);assert.equal(shadow.uniforms.uVegetationShadowNear.value,null);assert.equal(shadow.stats.instances,0);
      assert.equal(sourceDisposals,0,'retiring a shadow does not release vegetation-owned geometry');
      body.kind='gas-giant';update();
      const draws=renderer.renders;
      for(let frame=0;frame<100;frame++){
        assert.equal(shadow.prepare(renderer,vegetation,body.light),false);shadow.clear();
        assert.equal(shadow.uniforms.uVegetationShadow.value,null);
      }
      assert.equal(renderer.renders,draws);assert.equal(targetDisposals,(cycle+1)*2);assert.equal(materialDisposals,cycle+1);
    }
    shadow.dispose();shadow.dispose();assert.equal(liveTargets,0);assert.equal(liveMaterials,0);
    body.kind='ring';update();assert.equal(shadow.prepare(renderer,vegetation,body.light),false,'terminal owner cannot allocate again');
    assert.equal(sourceDisposals,0);
  }finally{shadow.dispose();vegetation.userData.dispose();}
  assert.equal(sourceDisposals,4);
});

test('normal and reversed depth preserve body-local light rays, sub-unit receiver offsets and all caster roots',()=>{
  for(const reversed of [false,true]){
    const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows({mapSize:1024}),renderer=new RendererProbe(reversed);
    try{
      update();shadow.prepare(renderer,vegetation,body.light);
      const u=shadow.uniforms,origin=u.uVegetationShadowOrigin.value,matrix=u.uVegetationShadowMatrix.value;
      assert.equal(u.uVegetationShadowReversed.value,Number(reversed));assert.equal(u.uVegetationShadowTexel.value.x,1/1024);
      assert.ok(origin.length()>800000,'actual large-radius habitat fixture');
      const roots=vegetation.userData.shadowMesh.geometry.attributes.iRoot,light=new THREE.Vector3().fromArray(body.light).normalize();
      const caster=new THREE.Vector3(),receiver=new THREE.Vector3(),a=new THREE.Vector3(),b=new THREE.Vector3();
      for(let i=0;i<vegetation.userData.shadowMesh.geometry.instanceCount;i++){
        caster.fromBufferAttribute(roots,i);a.copy(caster).sub(origin).applyMatrix4(matrix);
        assert.ok(a.x>0&&a.x<1&&a.y>0&&a.y<1&&a.z>0&&a.z<1,'all real roots fit the light map');
        receiver.copy(caster).addScaledVector(light,-20);b.copy(receiver).sub(origin).applyMatrix4(matrix);
        assert.ok(Math.abs(a.x-b.x)<1e-12&&Math.abs(a.y-b.y)<1e-12,'a real light ray samples one shadow-map texel');
        assert.ok(b.z>a.z,'receiver behind caster has larger conventional depth');
      }
      caster.fromBufferAttribute(roots,0);receiver.copy(caster);receiver.y+=.125;
      a.copy(caster).sub(origin).applyMatrix4(matrix);b.copy(receiver).sub(origin).applyMatrix4(matrix);
      assert.ok(a.distanceTo(b)>0,'sub-unit surface offsets survive the relative matrix');
      const clip=renderer.draw.mesh.material.uniforms.uShadowClip.value,clipPoint=new THREE.Vector3().copy(caster).sub(origin).applyMatrix4(clip);
      const sampledDepth=reversed?(1-clipPoint.z)*.5:clipPoint.z*.5+.5;
      const decoded=reversed?1-sampledDepth:sampledDepth;
      assert.ok(Math.abs(decoded-a.z)<1e-12,'depth-clip and receiver-matrix conventions agree');
    }finally{shadow.dispose();vegetation.userData.dispose();}
  }
});

test('shadow render restores target, mip, clear, XR and public/actual viewport/scissor on success and failure',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  const previousTarget=new THREE.WebGLRenderTarget(320,240);
  try{
    update();renderer.setRenderTarget(previousTarget,2,1);
    renderer.actualViewport.set(11,13,151,153);renderer.actualScissor.set(17,19,157,159);renderer.actualScissorTest=true;
    const before=renderer.snapshot();
    shadow.prepare(renderer,vegetation,body.light);assert.deepEqual(renderer.snapshot(),before);
    renderer.fail=true;body.light[2]+=.2;
    assert.throws(()=>shadow.prepare(renderer,vegetation,body.light),/shadow render failed/);
    assert.deepEqual(renderer.snapshot(),before);assert.equal(shadow.uniforms.uVegetationShadowEnabled.value,0);
    assert.equal(shadow.stats.renders,2,'failed draw is not accepted as a refreshed map');
    renderer.fail=false;assert.equal(shadow.prepare(renderer,vegetation,body.light),true);assert.deepEqual(renderer.snapshot(),before);
    body.light[0]+=.1;renderer.failAt=renderer.renders+2;
    assert.throws(()=>shadow.prepare(renderer,vegetation,body.light),/shadow render failed/,'near-map failure after far draw');
    assert.deepEqual(renderer.snapshot(),before);assert.equal(shadow.uniforms.uVegetationShadowEnabled.value,0);
    renderer.failAt=undefined;assert.equal(shadow.prepare(renderer,vegetation,body.light),true);assert.deepEqual(renderer.snapshot(),before);
  }finally{shadow.dispose();vegetation.userData.dispose();previousTarget.dispose();}
});

test('dispose releases owned target and material once, retains borrowed tree geometry, and cannot resurrect',()=>{
  const {vegetation,body,update}=fixture(),shadow=createRingHabitatShadows(),renderer=new RendererProbe();
  update();shadow.prepare(renderer,vegetation,body.light);
  const {mesh}=renderer.draw,borrowed=[vegetation.userData.shadowMesh.geometry,...vegetation.userData.shadowCasters.map(mesh=>mesh.geometry)];
  let targetDisposals=0,materialDisposals=0,sourceDisposals=0;
  for(const draw of renderer.draws)draw.target.addEventListener('dispose',()=>targetDisposals++);
  mesh.material.addEventListener('dispose',()=>materialDisposals++);for(const geometry of borrowed)geometry.addEventListener('dispose',()=>sourceDisposals++);
  shadow.dispose();shadow.dispose();
  assert.equal(targetDisposals,2);assert.equal(materialDisposals,1);assert.equal(sourceDisposals,0);
  assert.equal(shadow.uniforms.uVegetationShadow.value,null);assert.equal(shadow.uniforms.uVegetationShadowEnabled.value,0);
  assert.equal(shadow.prepare(renderer,vegetation,body.light),false);assert.equal(renderer.renders,2);
  vegetation.userData.dispose();assert.equal(sourceDisposals,4);
  assert.throws(()=>createRingHabitatShadows({mapSize:4096}),RangeError);
});
