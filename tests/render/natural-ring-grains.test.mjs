import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {describeCosmicBody} from '../../src/cosmic-bodies.js';
import {NATURAL_RING_GRAIN_LOD,naturalRingVisualSigma} from '../../src/natural-ring.js';
import {NATURAL_RING_GRAINS,createNaturalRingGrains,populateNaturalRingGrainTile,naturalRingGrainWeight,naturalRingGrainScale} from '../../src/render/natural-ring-grains.js';

const config=NATURAL_RING_GRAINS;
const descriptor=describeCosmicBody({x:-30,y:28,z:-21},'lonely-universe-v2');
const closePoint=[-857696.5944049603,279.17005804356694,1082021.6358346054];
function fixture(){
  const body={...descriptor,center:[0,0,0]},camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  camera.position.set(1000,-500,1200);camera.updateMatrixWorld();
  const local=[(Math.floor(closePoint[0]/config.tile)+.4)*config.tile,closePoint[1],(Math.floor(closePoint[2]/config.tile)+.4)*config.tile];
  const frame=body.frame;
  function move(x){local[0]=x;for(let axis=0;axis<3;axis++)body.center[axis]=-(frame[axis*3]*local[0]+frame[axis*3+1]*local[1]+frame[axis*3+2]*local[2]);}
  move(local[0]);return {body,camera,local,move};
}
// The independent reference clips rays against planes derived from actual
// octahedron triangles, not a projected-area or particle-radius opacity formula.
function convexPlanes(geometry){
  const position=geometry.getAttribute('position'),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3();
  const planes=[];
  for(let i=0;i<position.count;i+=3){
    a.fromBufferAttribute(position,i);b.fromBufferAttribute(position,i+1);c.fromBufferAttribute(position,i+2);
    const normal=ab.subVectors(b,a).cross(ac.subVectors(c,a)).normalize();
    planes.push([normal.x,normal.y,normal.z,normal.dot(a)]);
  }
  return planes;
}
function intersectsNormalRay(x,z,grain,planes){
  const dx=x-grain.x,dz=z-grain.z;
  if(dx*dx+dz*dz>=grain.radius*grain.radius)return false;
  const bottom=-config.physicalHalfHeight-1,dy=bottom-grain.y,m=grain.rotation,r=grain.radius;
  const ox=(m[0]*dx+m[3]*dy+m[6]*dz)/r,oy=(m[1]*dx+m[4]*dy+m[7]*dz)/r,oz=(m[2]*dx+m[5]*dy+m[8]*dz)/r;
  const vx=m[3]/r,vy=m[4]/r,vz=m[5]/r;
  let lo=0,hi=2*(config.physicalHalfHeight+1);
  for(const [nx,ny,nz,distance] of planes){
    const numerator=distance-nx*ox-ny*oy-nz*oz,denominator=nx*vx+ny*vy+nz*vz;
    if(denominator>0)hi=Math.min(hi,numerator/denominator);
    else if(denominator<0)lo=Math.max(lo,numerator/denominator);
    else if(numerator<0)return false;
    if(lo>=hi)return false;
  }
  return true;
}

test('deterministic bounded grain cells reproduce finite octahedral coverage near the declared ensemble',()=>{
  const cx=Math.floor(closePoint[0]/config.tile),cz=Math.floor(closePoint[2]/config.tile),records=[],out={};
  const first=[],second=[];
  populateNaturalRingGrainTile(descriptor,cx,cz,(...record)=>first.push(record),out);
  populateNaturalRingGrainTile(descriptor,cx,cz,(...record)=>second.push(record),out);
  assert.deepEqual(second,first);assert.ok(first.length>0&&first.length<=config.capacity);
  assert.equal(config.share,NATURAL_RING_GRAIN_LOD.share);
  assert.equal(naturalRingGrainWeight(NATURAL_RING_GRAIN_LOD.fadeStart),NATURAL_RING_GRAIN_LOD.share);
  assert.equal(naturalRingGrainWeight(NATURAL_RING_GRAIN_LOD.fadeEnd),0);
  for(let iz=cz-1;iz<=cz+1;iz++)for(let ix=cx-1;ix<=cx+1;ix++){
    populateNaturalRingGrainTile(descriptor,ix,iz,(at,x,y,z,radius,qx,qy,qz,qw)=>{
      assert.ok(x>=0&&x<config.tile&&z>=0&&z<config.tile);
      assert.ok(Math.abs(y)<=config.centerHalfHeight&&[4,12].includes(radius));
      assert.ok(Math.abs(qx*qx+qy*qy+qz*qz+qw*qw-1)<1e-12);
      records.push({x:ix*config.tile+x,y,z:iz*config.tile+z,radius,rotation:[
        1-2*(qy*qy+qz*qz),2*(qx*qy-qz*qw),2*(qx*qz+qy*qw),
        2*(qx*qy+qz*qw),1-2*(qx*qx+qz*qz),2*(qy*qz-qx*qw),
        2*(qx*qz-qy*qw),2*(qy*qz+qx*qw),1-2*(qx*qx+qy*qy)]});
    },out);
    assert.ok(out.count<=config.capacity);
  }
  const geometry=new THREE.OctahedronGeometry(1,0);
  try{
    const planes=convexPlanes(geometry);assert.equal(planes.length,config.trianglesPerGrain);
    let hits=0,ensemble=0;const side=48;
    for(let iz=0;iz<side;iz++)for(let ix=0;ix<side;ix++){
      const x=(cx+(ix+.5)/side)*config.tile,z=(cz+(iz+.5)/side)*config.tile;
      const tau=naturalRingVisualSigma(x,0,z,descriptor.radius,descriptor.phase)*16*config.centerHalfHeight/15;
      ensemble+=1-Math.exp(-NATURAL_RING_GRAIN_LOD.share*tau);
      if(records.some(grain=>intersectsNormalRay(x,z,grain,planes)))hits++;
    }
    // A fixed finite static population is not pointwise equal to a continuum.
    // This 2304-ray fixture permits its sampling/finite-population discrepancy.
    assert.ok(Math.abs(hits/side**2-ensemble/side**2)<.04,`geometry alpha ${hits/side**2}, ensemble alpha ${ensemble/side**2}`);
  }finally{geometry.dispose();}
});

test('small moves keep buffers and uploads stable while one cell crossing rebuilds one strip',()=>{
  const f=fixture(),group=createNaturalRingGrains();
  try{
    group.userData.update(f);
    assert.equal(group.children.length,config.tiles);
    const buffers=group.children.map(mesh=>[mesh.instanceMatrix.array,mesh.instanceColor.array]);
    const versions=group.children.map(mesh=>[mesh.instanceMatrix.version,mesh.instanceColor.version]);
    const initialBuilds=group.userData.stats.tileBuilds,initialX=f.local[0];
    for(let frame=1;frame<=100;frame++){f.move(initialX+frame*.01);group.userData.update(f);}
    assert.equal(group.userData.stats.tileBuilds,initialBuilds);
    for(let i=0;i<group.children.length;i++){
      const mesh=group.children[i];assert.equal(mesh.instanceMatrix.array,buffers[i][0]);assert.equal(mesh.instanceColor.array,buffers[i][1]);
      assert.equal(mesh.instanceMatrix.version,versions[i][0]);assert.equal(mesh.instanceColor.version,versions[i][1]);
    }
    f.move(initialX+config.tile);group.userData.update(f);
    assert.equal(group.userData.stats.tileBuilds-initialBuilds,config.diameter);
    assert.equal(group.children.filter((mesh,i)=>mesh.instanceMatrix.version!==versions[i][0]).length,config.diameter);
    for(let i=0;i<group.children.length;i++)assert.equal(group.children[i].instanceMatrix.array,buffers[i][0]);
  }finally{group.userData.dispose();}
});

test('dispose releases the owned instance meshes, materials and shared geometry exactly once',()=>{
  const f=fixture(),group=createNaturalRingGrains();
  try{
    group.userData.update(f);
  const meshes=group.children.slice(),materials=new Set(meshes.map(mesh=>mesh.material)),geometries=new Set(meshes.map(mesh=>mesh.geometry));
  assert.equal(meshes.length,config.tiles);assert.equal(materials.size,config.tiles);assert.equal(geometries.size,1);
  let meshDisposals=0,materialDisposals=0,geometryDisposals=0;
  for(const mesh of meshes)mesh.addEventListener('dispose',()=>meshDisposals++);
  for(const material of materials)material.addEventListener('dispose',()=>materialDisposals++);
  for(const geometry of geometries)geometry.addEventListener('dispose',()=>geometryDisposals++);
    group.userData.dispose();group.userData.dispose();group.userData.update(f);
    assert.equal(meshDisposals,config.tiles);assert.equal(materialDisposals,config.tiles);assert.equal(geometryDisposals,1);
    assert.equal(group.children.length,0);assert.equal(group.userData.stats.instanceBytes,0);assert.equal(group.userData.stats.disposed,true);
  }finally{group.userData.dispose();}
});


test('borrowed scanned medium morphs from the convex hull, selects by camera pixels, and uploads only changed membership',()=>{
  const f=fixture(),frame=f.body.frame;
  f.camera.up.set(frame[2],frame[5],frame[8]);
  f.camera.lookAt(f.camera.position.clone().add(new THREE.Vector3(-frame[1],-frame[4],-frame[7]).multiplyScalar(1000)));
  f.camera.updateMatrixWorld();f.viewportHeight=1000;f.pixelRatio=1;
  const coarse=new THREE.OctahedronGeometry(3,0),medium=new THREE.OctahedronGeometry(3,2),map=new THREE.Texture(),normalMap=new THREE.Texture();
  const material=new THREE.MeshStandardMaterial({map,normalMap,roughness:.82}),assets={coarse:[coarse],medium:[medium],material};
  const originalPosition=medium.attributes.position.array.slice(),group=createNaturalRingGrains({assets});
  let borrowedGeometryDisposals=0,borrowedMaterialDisposals=0,borrowedTextureDisposals=0;
  coarse.addEventListener('dispose',()=>borrowedGeometryDisposals++);medium.addEventListener('dispose',()=>borrowedGeometryDisposals++);
  material.addEventListener('dispose',()=>borrowedMaterialDisposals++);map.addEventListener('dispose',()=>borrowedTextureDisposals++);normalMap.addEventListener('dispose',()=>borrowedTextureDisposals++);
  try{
    group.userData.update(f);
    const middle=group.children.find(mesh=>mesh.geometry.attributes.coarsePosition),base=group.children.find(mesh=>!mesh.geometry.attributes.coarsePosition);
    let ownedMediumDisposals=0;middle.geometry.addEventListener('dispose',()=>ownedMediumDisposals++);
    assert.ok(middle&&middle.count>0);assert.equal(middle.material.map,null);assert.equal(middle.material.normalMap,normalMap);
    assert.equal(middle.material.vertexColors,false);
    assert.equal(base.material.normalMap,null,'convex proxy cannot consume the scan atlas tangent normals');
    assert.equal(material.normalMap,normalMap,'the borrowed source material remains unchanged');
    assert.notEqual(middle.geometry,medium);assert.deepEqual(medium.attributes.position.array,originalPosition);
    const planes=convexPlanes(base.geometry),points=middle.geometry.attributes.coarsePosition;
    for(let at=0;at<points.count;at++){
      const x=points.getX(at),y=points.getY(at),z=points.getZ(at);let boundaryDistance=Infinity;
      for(const [nx,ny,nz,distance] of planes){const gap=distance-nx*x-ny*y-nz*z;assert.ok(gap>=-1e-6);boundaryDistance=Math.min(boundaryDistance,Math.abs(gap));}
      assert.ok(boundaryDistance<1e-6,'morph starts on the actual convex coarse boundary');
    }
    const matrixArray=middle.instanceMatrix.array,colorArray=middle.instanceColor.array,version=middle.instanceMatrix.version,initialCount=middle.count,initialUploads=group.userData.stats.mediumUploads,initialSelections=group.userData.stats.selectionUpdates;
    for(let i=0;i<100;i++)group.userData.update(f);
    assert.equal(group.userData.stats.mediumUploads,initialUploads);assert.equal(group.userData.stats.selectionUpdates,initialSelections);assert.equal(middle.instanceMatrix.version,version);
    f.camera.rotateY(1e-9);f.camera.updateMatrixWorld();group.userData.update(f);
    assert.equal(group.userData.stats.selectionUpdates,initialSelections+1);assert.equal(group.userData.stats.mediumUploads,initialUploads);
    f.pixelRatio=2;group.userData.update(f);
    assert.ok(middle.count>initialCount,'higher pixel density resolves more grains within the unchanged view');
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    const originalNormalChunk=THREE.ShaderChunk.normal_fragment_maps;
    middle.material.onBeforeCompile(shader);const focal=shader.uniforms.uFocalPixels.value,selections=group.userData.stats.selectionUpdates;
    const coarseShader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    base.material.onBeforeCompile(coarseShader);
    const tint=shader.uniforms.uIceTint.value;
    assert.equal(coarseShader.uniforms.uIceTint.value,tint);
    assert.deepEqual(tint.toArray(),f.body.tint);
    const colorVersion=base.instanceColor.version;f.body.tint=[.2,.4,.8];group.userData.update(f);
    assert.equal(shader.uniforms.uIceTint.value,tint);assert.deepEqual(tint.toArray(),f.body.tint);
    assert.equal(base.instanceColor.version,colorVersion,'body tint does not change the stable per-grain palette buffer');
    assert.equal(THREE.ShaderChunk.normal_fragment_maps,originalNormalChunk,'normal morph is local to this material');
    f.camera.fov=25;f.camera.updateProjectionMatrix();group.userData.update(f);
    assert.ok(shader.uniforms.uFocalPixels.value>focal);assert.equal(group.userData.stats.selectionUpdates,selections+1);
    assert.equal(middle.instanceMatrix.array,matrixArray);assert.equal(middle.instanceColor.array,colorArray);
    assert.equal(group.userData.stats.tileBuilds,config.tiles);
    group.userData.dispose();group.userData.dispose();
    assert.equal(ownedMediumDisposals,1,'the clipped medium owns and releases one geometry');
    assert.equal(borrowedGeometryDisposals,0);assert.equal(borrowedMaterialDisposals,0);assert.equal(borrowedTextureDisposals,0);
    assert.equal(material.map,map);assert.equal(material.normalMap,normalMap);
  }finally{group.userData.dispose();coarse.dispose();medium.dispose();material.dispose();map.dispose();normalMap.dispose();}
});

function endpointReference(geometry){
  const position=geometry.attributes.position,normal=geometry.attributes.normal,uv=geometry.attributes.uv,index=geometry.index,count=index?index.count:position.count,faces=[];
  for(let face=0;face<count;face+=3){
    const ids=[0,1,2].map(k=>index?index.getX(face+k):face+k);
    faces.push({triangle:new THREE.Triangle(...ids.map(i=>new THREE.Vector3().fromBufferAttribute(position,i))),
      normals:ids.map(i=>new THREE.Vector3().fromBufferAttribute(normal,i)),uv:uv?ids.map(i=>new THREE.Vector2().fromBufferAttribute(uv,i)):null});
  }
  return faces;
}
function verifyEndpoint(geometry,positionName,normalName,reference){
  const positions=geometry.attributes[positionName],normals=geometry.attributes[normalName],uv=positionName==='position'?geometry.attributes.uv:null;
  const vertices=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()],field=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()];
  const closest=new THREE.Vector3(),point=new THREE.Vector3(),bary=new THREE.Vector3(),wanted=new THREE.Vector3(),actual=new THREE.Vector3();
  let maxPosition=0,maxNormal=0,maxUV=0,area=0,samples=0;
  for(let at=0;at<positions.count;at+=3){
    for(let k=0;k<3;k++){vertices[k].fromBufferAttribute(positions,at+k);field[k].fromBufferAttribute(normals,at+k);}
    let selected=null,error=Infinity;
    for(const face of reference){let distance=0;for(const vertex of vertices){face.triangle.closestPointToPoint(vertex,closest);distance=Math.max(distance,closest.distanceTo(vertex));}if(distance<error){error=distance;selected=face;}}
    assert.ok(error<2e-6,`${positionName}: one authoritative face must contain every output triangle (${error})`);maxPosition=Math.max(maxPosition,error);
    area+=new THREE.Triangle(...vertices).getArea();
    for(let i=0;i<=6;i++)for(let j=0;j<=6-i;j++){
      const weights=[i/6,j/6,1-(i+j)/6];point.set(0,0,0);actual.set(0,0,0);
      for(let k=0;k<3;k++){point.addScaledVector(vertices[k],weights[k]);actual.addScaledVector(field[k],weights[k]);}
      selected.triangle.getBarycoord(point,bary);wanted.copy(selected.normals[0]).multiplyScalar(bary.x).addScaledVector(selected.normals[1],bary.y).addScaledVector(selected.normals[2],bary.z);
      maxNormal=Math.max(maxNormal,actual.distanceTo(wanted));
      if(uv){const u=weights.reduce((sum,w,k)=>sum+w*uv.getX(at+k),0),v=weights.reduce((sum,w,k)=>sum+w*uv.getY(at+k),0);
        const wantedUV=new THREE.Vector2().copy(selected.uv[0]).multiplyScalar(bary.x).addScaledVector(selected.uv[1],bary.y).addScaledVector(selected.uv[2],bary.z);maxUV=Math.max(maxUV,Math.hypot(u-wantedUV.x,v-wantedUV.y));}
      samples++;
    }
  }
  assert.ok(maxNormal<2e-5,`${normalName}: dense raw normal-field error ${maxNormal}`);assert.ok(maxUV<2e-5,`dense UV error ${maxUV}`);
  return {maxPosition,maxNormal,maxUV,area,samples};
}

test('face-cone subdivision retains both endpoint surfaces and their raw normal/UV fields',()=>{
  const hull=new THREE.OctahedronGeometry(1,0),positions=[],normals=[];
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),centre=new THREE.Vector3(),centreNormal=new THREE.Vector3();
  try{
    // Coplanar subfaces have different affine normal fields; original face
    // edges also deliberately retain distinct duplicated-corner normals.
    for(let face=0;face<hull.attributes.position.count;face+=3){
      a.fromBufferAttribute(hull.attributes.position,face);b.fromBufferAttribute(hull.attributes.position,face+1);c.fromBufferAttribute(hull.attributes.position,face+2);
      centre.copy(a).add(b).add(c).multiplyScalar(1/3);centreNormal.copy(centre).normalize();
      for(const [p0,p1] of [[a,b],[b,c],[c,a]])for(const point of [p0,p1,centre]){
        positions.push(...point.toArray());normals.push(...point.clone().normalize().addScaledVector(centreNormal,.25).normalize().toArray());
      }
    }
    for(const indexed of [false,true]){
      const coarse=new THREE.BufferGeometry(),medium=new THREE.OctahedronGeometry(1,2),material=new THREE.MeshStandardMaterial();
      coarse.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));coarse.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      if(indexed)coarse.setIndex(Array.from({length:positions.length/3},(_,i)=>i));
      medium.rotateX(.31);medium.rotateY(.27);medium.rotateZ(.19);
      const originalPosition=medium.attributes.position.array.slice(),originalNormal=medium.attributes.normal.array.slice(),originalUV=medium.attributes.uv.array.slice();
      const group=createNaturalRingGrains({assets:{coarse:[coarse],medium:[medium],material}}),f=fixture();f.viewportHeight=1000;
      let sourceCoarse=null,sourceMedium=null;
      try{
        group.userData.update(f);
        const base=group.children[0],mesh=group.children.find(mesh=>mesh.geometry.attributes.coarsePosition),geometry=mesh.geometry;
        const areaScale=new THREE.Vector3().fromBufferAttribute(base.geometry.attributes.position,0).length()/new THREE.Vector3().fromBufferAttribute(coarse.attributes.position,0).length();
        sourceCoarse=coarse.clone().scale(areaScale,areaScale,areaScale);sourceMedium=medium.clone().scale(areaScale,areaScale,areaScale);
        const start=verifyEndpoint(geometry,'coarsePosition','coarseNormal',endpointReference(sourceCoarse)),end=verifyEndpoint(geometry,'position','normal',endpointReference(sourceMedium));
        assert.ok(geometry.attributes.position.count>medium.attributes.position.count,'rotated source triangles cross coarse face cones and must subdivide');
        assert.ok(Math.abs(start.area-endpointReference(sourceCoarse).reduce((sum,f)=>sum+f.triangle.getArea(),0))<2e-5,'coarse endpoint covers its original hull');
        assert.ok(Math.abs(end.area-endpointReference(sourceMedium).reduce((sum,f)=>sum+f.triangle.getArea(),0))<2e-5,'medium endpoint only subdivides the original surface');
        const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};mesh.material.onBeforeCompile(shader);
        assert.ok(shader.vertexShader.includes('objectNormal=mix(coarseNormal,normal,grainMorph);'));assert.ok(shader.vertexShader.includes('vNormal = transformedNormal;'));
        assert.equal(mesh.material.flatShading,false);assert.equal(base.material.flatShading,false);
        assert.deepEqual(medium.attributes.position.array,originalPosition);assert.deepEqual(medium.attributes.normal.array,originalNormal);assert.deepEqual(medium.attributes.uv.array,originalUV);
      }finally{group.userData.dispose();sourceCoarse?.dispose();sourceMedium?.dispose();coarse.dispose();medium.dispose();material.dispose();}
    }
  }finally{hull.dispose();}
});

test('cone crossings rounded onto an outside endpoint retain the source surface area',()=>{
  const coarse=new THREE.OctahedronGeometry(1,0);coarse.rotateX(1.025);coarse.rotateY(1.205);coarse.rotateZ(1.2349999999999999);
  const positions=[],normals=[],a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),plane=new THREE.Vector3();
  const p=coarse.attributes.position;
  for(let face=0;face<p.count;face+=3)for(let edge=0;edge<3;edge++){
    a.fromBufferAttribute(p,face+edge);b.fromBufferAttribute(p,face+(edge+1)%3);c.fromBufferAttribute(p,face+(edge+2)%3);
    plane.crossVectors(a,b).normalize();if(plane.dot(c)<0)plane.negate();
    // The third vertex is exactly a cone-edge endpoint. Normalized cross/dot
    // arithmetic can classify it just outside while t still rounds to one.
    for(const point of [a.clone().multiplyScalar(.7).addScaledVector(b,.3).addScaledVector(plane,-.08),a.clone().multiplyScalar(.5).addScaledVector(b,.5).addScaledVector(plane,.08),a]){
      positions.push(...point.toArray());normals.push(0,1,0);
    }
  }
  const medium=new THREE.BufferGeometry(),material=new THREE.MeshStandardMaterial();medium.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));medium.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  const group=createNaturalRingGrains({assets:{coarse:[coarse],medium:[medium],material}}),f=fixture();f.viewportHeight=1000;
  let reference=null;
  try{
    group.userData.update(f);
    const base=group.children[0].geometry,target=group.children.find(mesh=>mesh.geometry.attributes.coarsePosition).geometry,scale=new THREE.Vector3().fromBufferAttribute(base.attributes.position,0).length()/new THREE.Vector3().fromBufferAttribute(p,0).length();
    reference=medium.clone().scale(scale,scale,scale);const sourceFaces=endpointReference(reference),proof=verifyEndpoint(target,'position','normal',sourceFaces);
    assert.ok(Math.abs(proof.area-sourceFaces.reduce((sum,face)=>sum+face.triangle.getArea(),0))<2e-6,'a rounded outside endpoint cannot discard a nonzero clipped polygon');
  }finally{group.userData.dispose();reference?.dispose();coarse.dispose();medium.dispose();material.dispose();}
});

// Orthographic projection of actual triangles after the same local morph,
// uniform area scale, rotation and radius scale used by the renderer.
function projectedTriangleArea(geometry,morph,size,model,view){
  const position=geometry.attributes.position,coarse=geometry.attributes.coarsePosition,index=geometry.index,count=index?index.count:position.count;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3();let area=0;
  function point(out,corner){const at=index?index.getX(corner):corner;out.fromBufferAttribute(position,at);
    if(coarse){out.multiplyScalar(morph);out.x+=(1-morph)*coarse.getX(at);out.y+=(1-morph)*coarse.getY(at);out.z+=(1-morph)*coarse.getZ(at);}
    return out.multiplyScalar(size).applyMatrix4(model);
  }
  for(let face=0;face<count;face+=3){point(a,face);point(b,face+1);point(c,face+2);area+=Math.max(0,ab.subVectors(b,a).cross(ac.subVectors(c,a)).dot(view))*.5;}
  return area;
}

test('geometric fade follows the shared optical area weight for coarse and morphed medium without moving instance centres',()=>{
  const f=fixture();f.viewportHeight=1000;f.pixelRatio=1;
  const coarse=new THREE.OctahedronGeometry(3,0),medium=new THREE.OctahedronGeometry(3,2),material=new THREE.MeshStandardMaterial();
  const group=createNaturalRingGrains({assets:{coarse:[coarse],medium:[medium],material}});
  try{
    group.userData.update(f);
    const geometries=[group.children.find(mesh=>!mesh.geometry.attributes.coarsePosition).geometry,group.children.find(mesh=>mesh.geometry.attributes.coarsePosition).geometry];
    const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(.2,.5,.7).normalize(),.9);
    const model=new THREE.Matrix4().compose(new THREE.Vector3(23,42,-51),rotation,new THREE.Vector3(12,12,12));
    const centre=new THREE.Vector3().applyMatrix4(model),viewDirections=[new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(.3,.4,Math.sqrt(.75))];
    assert.equal(naturalRingGrainScale(NATURAL_RING_GRAIN_LOD.fadeStart-1),1);
    assert.equal(naturalRingGrainScale(NATURAL_RING_GRAIN_LOD.fadeEnd+1),0);
    for(const geometry of geometries)for(const morph of [0,.5,1])for(const view of viewDirections){
      const full=projectedTriangleArea(geometry,morph,1,model,view);let previous=full;
      for(let step=0;step<=32;step++){
        const distance=NATURAL_RING_GRAIN_LOD.fadeStart+(NATURAL_RING_GRAIN_LOD.fadeEnd-NATURAL_RING_GRAIN_LOD.fadeStart)*step/32;
        const size=naturalRingGrainScale(distance),expected=naturalRingGrainWeight(distance)/NATURAL_RING_GRAIN_LOD.share;
        const area=projectedTriangleArea(geometry,morph,size,model,view);
        assert.ok(Math.abs(area/full-expected)<1e-12);assert.ok(area<=previous+1e-10);previous=area;
        assert.deepEqual(new THREE.Vector3().multiplyScalar(size).applyMatrix4(model).toArray(),centre.toArray());
      }
    }
    // Same population/cell again: geometry fade never mutates stored centres,
    // rotations, radii or independent palette draws.
    const matrices=group.children.map(mesh=>mesh.instanceMatrix.array.slice()),colors=group.children.map(mesh=>mesh.instanceColor.array.slice());
    group.userData.update(f);
    for(let at=0;at<group.children.length;at++){assert.deepEqual(group.children[at].instanceMatrix.array,matrices[at]);assert.deepEqual(group.children[at].instanceColor.array,colors[at]);}
    assert.ok(group.children.every(mesh=>mesh.material.alphaToCoverage===false));
  }finally{group.userData.dispose();coarse.dispose();medium.dispose();material.dispose();}
});
