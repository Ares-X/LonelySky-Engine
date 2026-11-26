import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {RING_HABITAT_SHADOW_GLSL as GLSL} from '../../src/render/ring-habitat-shadow-receiver.js';
import {createRingHabitatRegions} from '../../src/ring-habitat-regions.js';

// Run the actual GLSL PCF/control flow and triangle kernel with small vector
// helpers, as the existing terrain-kernel tests do. This is numeric execution,
// not a GLSL compiler or GPU/raster/Float32 precision acceptance.
function vec(size,...values){const a=values.flat();if(a.length===1)while(a.length<size)a.push(a[0]);return new Proxy(a,{get(a,key){if(typeof key==='string'&&/^[xyzwrgba]{1,4}$/.test(key)){const indices=[...key].map(k=>'xyzw'.indexOf(k)>=0?'xyzw'.indexOf(k):'rgba'.indexOf(k));return indices.length===1?a[indices[0]]:vec(indices.length,...indices.map(i=>a[i]));}return a[key];}});}
const V2=(...a)=>vec(2,...a),V3=(...a)=>vec(3,...a),V4=(...a)=>vec(4,...a);
const pair=(a,b,fn)=>Array.isArray(a)?vec(a.length,...a.map((v,i)=>fn(v,Array.isArray(b)?b[i]:b))):Array.isArray(b)?vec(b.length,...b.map(v=>fn(a,v))):fn(a,b);
const add=(a,b)=>pair(a,b,(x,y)=>x+y),sub=(a,b)=>pair(a,b,(x,y)=>x-y),mul=(a,b)=>pair(a,b,(x,y)=>x*y),div=(a,b)=>pair(a,b,(x,y)=>x/y),dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0),mix=(a,b,t)=>add(mul(a,1-t),mul(b,t));
const matmul=(m,v)=>V3(...[0,1,2].map(row=>m.reduce((n,column,i)=>n+column[row]*v[i],0)));
const columns=(m,size)=>Array.from({length:size},(_,i)=>vec(size,...m.elements.slice(i*size,i*size+size)));
function compile(name,env){
  const match=GLSL.match(new RegExp('(?:float|vec[234]) '+name+'\\(([^)]*)\\)\\{([\\s\\S]*?)\\n\\}'));assert.ok(match,`missing shader kernel ${name}`);
  const params=match[1].split(',').map(p=>p.trim().split(/\s+/).at(-1));let body=match[2].replace(/\/\/[^\n]*/g,'');
  body=body.replace(/\(([abc])v\.xyz-receiverHi\)\+\(habitatShadowResidual\(\1v\)-receiverLo\)-receiverSmall/g,'sub(add(sub($1v.xyz,receiverHi),sub(habitatShadowResidual($1v),receiverLo)),receiverSmall)')
    .replace(/habitatShadowTriangleVertex\((first(?:\+[12])?)\)-receiver/g,'sub(habitatShadowTriangleVertex($1),receiver)')
    .replace(/([abc])\.xy-(receiver|tapDelta)\.xy/g,'sub($1.xy,$2.xy)')
    .replace('projected.xy/uVegetationShadowTexel-.5','sub(div(projected.xy,uVegetationShadowTexel),.5)')
    .replace('(floor(pixel)+.5)*uVegetationShadowTexel','mul(add(floor(pixel),.5),uVegetationShadowTexel)')
    .replace(/base\+vec2\((uVegetationShadowTexel\.[xy],0\.|0\.,uVegetationShadowTexel\.[xy])\)/g,'add(base,vec2($1))')
    .replace(/base\+uVegetationShadowTexel/g,'add(base,uVegetationShadowTexel)')
    .replace(/base-projected\.xy/g,'sub(base,projected.xy)')
    .replace(/return -vec2\(([^;]+)\)\*reciprocal;/g,'return mul(vec2($1),-reciprocal);')
    .replace(/uVegetationShadowTriangleBasis\*\(x\/dot\(x,x\)\+z\*\(planeGradient.x\/dot\(z,z\)\)\)/g,'matmul(uVegetationShadowTriangleBasis,add(div(x,dot(x,x)),mul(z,planeGradient.x/dot(z,z))))')
    .replace(/uVegetationShadowTriangleBasis\*\(y\/dot\(y,y\)\+z\*\(planeGradient.y\/dot\(z,z\)\)\)/g,'matmul(uVegetationShadowTriangleBasis,add(div(y,dot(y,y)),mul(z,planeGradient.y/dot(z,z))))')
    .replace('uVegetationShadowTexel/vec2(length(x),length(y))','div(uVegetationShadowTexel,vec2(length(x),length(y)))')
    .replace('stepX*(base.x-projected.x)+stepY*(base.y-projected.y)','add(mul(stepX,base.x-projected.x),mul(stepY,base.y-projected.y))')
    .replace('stepX*uVegetationShadowTexel.x','mul(stepX,uVegetationShadowTexel.x)')
    .replace('stepY*uVegetationShadowTexel.y','mul(stepY,uVegetationShadowTexel.y)')
    .replace('firstDelta+deltaX+deltaY','add(add(firstDelta,deltaX),deltaY)')
    .replace(/firstDelta\+(delta[XY])/g,'add(firstDelta,$1)')
    .replace(/\b(?:float|int|vec[234]|mat[34]|bool)\s+/g,'let ').replace(/\bint\(/g,'Math.trunc(');
  return new Function(...Object.keys(env),...params,body).bind(null,...Object.values(env));
}
function shader(triangles,basis,texture,reversed){
  const env={sqrt:Math.sqrt,max:Math.max,length:a=>Math.hypot(...a),normalize:a=>div(a,Math.hypot(...a)),uVegetationShadowLight:V3(basis.elements[2],basis.elements[5],basis.elements[8]),vec2:V2,vec3:V3,vec4:V4,add,sub,mul,div,dot,mix,matmul,texture,floor:a=>vec(a.length,...a.map(Math.floor)),fract:a=>vec(a.length,...a.map(v=>v-Math.floor(v))),step:(a,b)=>b<a?0:1,
    habitatShadowTriangleVertex:index=>V4(...triangles[Math.floor(index/3)][index%3],0),habitatShadowResidual:()=>V3(0),uVegetationShadowTriangleBasis:columns(basis,3),uVegetationShadowWorldBias:.12,uVegetationShadowReversed:Number(reversed),uVegetationShadowTexel:V2(1/2048,1/2048)};
  for(const name of ['habitatShadowTerrainVisibility','habitatShadowTapVisibility','habitatReceiverPlaneGradient','habitatVegetationPCF'])env[name]=compile(name,env);
  return env;
}
const recipe={version:'halo-field-v1',siteIndex:0,innerRadius:10000,depth:100,minAngle:0,maxAngle:.08,minY:0,maxY:600};
function createField(r){return{statistics:{accountedBytes:1024},innerRadius:r.innerRadius,minAngle:r.minAngle,minY:r.minY,hmin:40,hmax:100,bounds:{minX:0,minY:0,maxX:800,maxY:600},position(x,y,p){const a=x/r.innerRadius,radius=r.innerRadius-40-.03*x-.02*y;p[0]=radius*Math.cos(a);p[1]=y;p[2]=radius*Math.sin(a);return p;},normal(x,y,n){const a=x/r.innerRadius,q=1-(40+.03*x+.02*y)/r.innerRadius,nx=-Math.cos(a)+Math.sin(a)*.03/q,nz=-Math.sin(a)-Math.cos(a)*.03/q,k=Math.hypot(nx,.02,nz);n[0]=nx/k;n[1]=-.02/k;n[2]=nz/k;return n;}};}

test('PCF uses each tap physical receiver ray across neighbouring caster faces, silhouette and self plane',async t=>{
  const body={id:'tap-projection-fixture',habitat:{terrainRecipes:[recipe]}},registry=createRingHabitatRegions({parentsInBounds:()=>[],createField});let lease;
  try{
    lease=await registry.prepareRegions(body,[{siteIndex:0,tileX:0,tileY:0}]);const mesh=lease.regions[0].mesh,g=mesh.topGrid,col=Math.floor((g.columns-1)/2),row=Math.floor((g.rows-1)/2),first=(row*(g.columns-1)+col)*2;
    const bodyTriangles=mesh.faces.slice(first,first+2).map(face=>face.map(i=>new THREE.Vector3(...mesh.vertices[i]))),light=new THREE.Vector3(-.7,.3,.64).normalize(),rotation=new THREE.Matrix4().lookAt(light,new THREE.Vector3(),new THREE.Vector3(0,1,0)),basis=new THREE.Matrix3().setFromMatrix4(rotation).transpose(),triangles=bodyTriangles.map(t=>t.map(v=>v.clone().applyMatrix3(basis).toArray())),normal=new THREE.Vector3().crossVectors(bodyTriangles[0][1].clone().sub(bodyTriangles[0][0]),bodyTriangles[0][2].clone().sub(bodyTriangles[0][0])).normalize();
    const camera=new THREE.OrthographicCamera(-256,256,256,-256,.1,2000);camera.position.copy(light).multiplyScalar(1000);camera.lookAt(new THREE.Vector3());camera.updateMatrixWorld(true);
    const matrix=new THREE.Matrix4().set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse),inverse=matrix.clone().invert(),m=columns(matrix,4),ray=new THREE.Ray(),a=new THREE.Vector3(),end=new THREE.Vector3(),point=new THREE.Vector3();let sampledIds;
    // Independent physical ray/triangle oracle supplies the atlas ID. It does
    // not reuse the shader's finite-inside test or its receiver-plane mapping.
    const oracle=uv=>{a.set(uv[0],uv[1],0).applyMatrix4(inverse);end.set(uv[0],uv[1],1).applyMatrix4(inverse);ray.set(a,end.sub(a).normalize());let nearest=Infinity,id=0,depth=1;for(let i=0;i<bodyTriangles.length;i++){const t=bodyTriangles[i];if(ray.intersectTriangle(...t,false,point)){const distance=point.distanceTo(a);if(distance<nearest){nearest=distance;id=i+1;depth=point.clone().applyMatrix4(matrix).z;}}}return{id,depth};};
    let crossing=0,clear=0,self=0,mixed=0;
    for(const reversed of [false,true]){
      const texture=(_map,uv)=>{const hit=oracle(uv);sampledIds.add(hit.id);return V2(reversed?1-hit.depth:hit.depth,hit.id);},env=shader(triangles,basis,texture,reversed),gradient=env.habitatReceiverPlaneGradient(m,V3(...normal.toArray()));
      const evaluate=receiver=>{const p=receiver.clone().applyMatrix4(matrix),r=receiver.clone().applyMatrix3(basis);sampledIds=new Set();const value=env.habitatVegetationPCF(null,V3(...p.toArray()),p.z-.12/(camera.far-camera.near),gradient,V3(...r.toArray()),V3(0),V3(0),m,V3(...normal.toArray()),true);return{value,p,ids:sampledIds};};
      // Physical shared diagonal, with receiver30L behind the actual caster.
      const edgeA=bodyTriangles[0][1],edgeB=bodyTriangles[0][2];
      for(let i=1;i<32;i++){const caster=edgeA.clone().lerp(edgeB,i/32),result=evaluate(caster.clone().addScaledVector(light,-30));if(result.ids.has(1)&&result.ids.has(2)){crossing++;assert.ok(result.value<1e-10,'neighbouring tap IDs must continuously block the same receiver surface');}}
      for(const t of bodyTriangles){const center=t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1/3);const result=evaluate(center);self++;assert.ok(result.value>1-1e-9,'the receiver plane is not its own blocker');}
      const center=bodyTriangles[0][0].clone().add(bodyTriangles[0][1]).add(bodyTriangles[0][2]).multiplyScalar(1/3).addScaledVector(light,-30);
      for(let i=-192;i<=192;i++){const receiver=center.clone().addScaledVector(new THREE.Vector3(1,0,0).applyMatrix3(basis.clone().transpose()),i*.125),result=evaluate(receiver),p=result.p,texel=1/2048,x=(Math.floor(p.x/texel-.5)+.5)*texel,y=(Math.floor(p.y/texel-.5)+.5)*texel,u=(p.x-x)/texel,v=(p.y-y)/texel;let expected=0;
        for(const[dx,dy,weight]of[[0,0,(1-u)*(1-v)],[texel,0,u*(1-v)],[0,texel,(1-u)*v],[texel,texel,u*v]])expected+=weight*(oracle([x+dx,y+dy]).id===0?1:0);
        assert.ok(Math.abs(result.value-expected)<1e-9,'finite caster silhouette follows the four actual tap rays');if(expected===1)clear++;if(expected>0&&expected<1)mixed++;
      }
    }
    t.diagnostic(JSON.stringify({crossing,clear,self,mixed}));
    assert.ok(crossing>10&&clear>10&&self===4&&mixed>0,'fixture exercises shared IDs, clear space, self plane and silhouette filtering');
  }finally{lease?.release();registry.dispose();assert.equal(registry.stats.accountedBytes,0);assert.equal(registry.stats.pinnedFields,0);assert.equal(registry.stats.pinnedRegions,0);assert.equal(registry.stats.pendingJobs,0);}
});

test('terrain discretization band does not alter normal/reversed tree depth shadows',()=>{
 const basis=new THREE.Matrix3(),matrix=new THREE.Matrix4().makeScale(1/512,1/512,-1/10000),m=columns(matrix,4);
 for(const reversed of[false,true]){const depth=.4,env=shader([],basis,()=>V2(reversed?1-depth:depth,0),reversed),v=env.habitatVegetationPCF(null,V3(.5,.5,.5),.5,V2(0),V3(0),V3(0),V3(0),m,V3(.8,0,.6),true);assert.equal(v,0);}
});

test('finite planar caster edge has a bounded geometry plus filter displacement and converges',t=>{
  const triangle=[[-100,-100,0],[100,-100,0],[0,100,0]],normal=V3(.8,0,.6),matrix=new THREE.Matrix4().set(1/512,0,0,.5,0,1/512,0,.5,0,0,-1/10000,.5,0,0,0,1),m=columns(matrix,4),ray=new THREE.Ray(),a=new THREE.Vector3(),hit=new THREE.Vector3(),vertices=triangle.map(v=>new THREE.Vector3(...v));
  let previousShift=Infinity;
  for(const resolution of[2048,4096]){
    const env=shader([triangle],new THREE.Matrix3(),(_map,uv)=>{a.set((uv[0]-.5)*512,(uv[1]-.5)*512,100);ray.set(a,new THREE.Vector3(0,0,-1));return ray.intersectTriangle(...vertices,false,hit)?V2(.5,1):V2(1,0);},false);env.uVegetationShadowTexel[0]=env.uVegetationShadowTexel[1]=1/resolution;
    const gradient=env.habitatReceiverPlaneGradient(m,normal),thresholds=[];
    for(const useBand of[false,true]){let lastClear=null;for(let i=-512;i<=512;i++){const x=i/1024,receiver=V3(x,0,-x*normal.x/normal.z),p=new THREE.Vector3(...receiver).applyMatrix4(matrix),visibility=env.habitatVegetationPCF(null,V3(...p.toArray()),p.z,gradient,receiver,V3(0),V3(0),m,normal,useBand);if(visibility>=.5)lastClear=x;}assert.notEqual(lastClear,null);thresholds.push(lastClear);}
    const arcShift=(thresholds[1]-thresholds[0])/normal.z,texelDiagonal=Math.hypot(512/resolution,512/resolution);const filterQuantization=512/resolution/normal.z;assert.ok(arcShift>0&&arcShift<=texelDiagonal+filterQuantization+2/1024/normal.z,'actual kernel/finite-ray edge stays within the continuous geometric band plus one PCF texel projected along this receiver');t.diagnostic(JSON.stringify({resolution,arcShift,texelDiagonal,filterQuantization}));assert.ok(arcShift<previousShift,'higher resolution reduces the actual edge displacement');previousShift=arcShift;
  }
});
