import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildTerrainMesh} from '../../src/mesh-terrain.js';
import {createRingHabitat} from '../../src/ring-habitat.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';
import { HABITAT_MESH_VERTEX_CAPACITY as TERRAIN_MESH_VERTEX_CAPACITY,HABITAT_MESH_FACE_CAPACITY as TERRAIN_MESH_FACE_CAPACITY,HABITAT_MESH_NODE_CAPACITY as TERRAIN_MESH_NODE_CAPACITY, RING_HABITAT_GEOMETRY_GLSL as GLSL, createRingHabitatGeometryTexture, createEmptyRingHabitatGeometryTexture, setRingHabitatGeometry } from '../../src/render/ring-habitat-geometry.js';

// Independent expected transport offsets, including the final padded row.
const f = Math.fround, VERTEX_BASE = 128, FACE_BASE = 131200, NODE_BASE = 262272, TEXELS = 393728, USED_TEXELS = 393344;
const near = (actual, expected, epsilon = 1e-5) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const sub = (a, b) => a.map((value, i) => value - b[i]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const normalize = a => { const length = Math.hypot(...a); return a.map(n => n / length); };

function box(center = [0, 0, 0], scale = 1) {
  const vertices = [[-2,-3,-4],[2,-3,-4],[2,3,-4],[-2,3,-4],[-2,-3,4],[2,-3,4],[2,3,4],[-2,3,4]].map(p => p.map(n => n * scale));
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  return buildTerrainMesh({ center, radius: Math.hypot(2,3,4) * scale, vertices, faces, normals: vertices.map(normalize) });
}
const fixture = () => [box([830000, 2000, 1000], 100), box([-640000, 3000, 510000], 200)];

function withTexture(groups, radius, callback) {
  const texture = createRingHabitatGeometryTexture();
  try { setRingHabitatGeometry(texture, groups, radius);callback(texture); } finally { texture.dispose(); }
}

test('empty sampler uses sixteen bytes, retains its storage on empty updates and rejects meshes before mutation', () => {
  const texture = createEmptyRingHabitatGeometryTexture();
  try {
    assert.equal(texture.image.width, 1);assert.equal(texture.image.height, 1);
    assert.equal(texture.image.data.byteLength, 16);assert.equal(texture.userData.isHabitatFull, false);
    assert.equal(texture.format, THREE.RGBAFormat);assert.equal(texture.type, THREE.FloatType);
    assert.equal(texture.internalFormat, 'RGBA32F');assert.equal(texture.minFilter, THREE.NearestFilter);
    assert.equal(texture.magFilter, THREE.NearestFilter);assert.equal(texture.generateMipmaps, false);
    for (const field of ['habitatGroupCount','habitatVertexCount','habitatFaceCount','habitatNodeCount']) assert.equal(texture.userData[field], 0);
    const data = texture.image.data, buffer = data.buffer, version = texture.version;
    for (let i = 0; i < 24; i++) {
      assert.equal(setRingHabitatGeometry(texture, undefined, 1000+i), 0);
      assert.equal(setRingHabitatGeometry(texture, [], 1000+i), 0);
    }
    assert.equal(texture.image.data, data);assert.equal(data.buffer, buffer);assert.equal(texture.version, version);
    assert.deepEqual([...data], [0,0,0,0]);assert.equal(texture.image.width, 1);assert.equal(texture.image.height, 1);
    const state = {...texture.userData};
    const unreadableMesh = Object.defineProperty({}, 'vertices', {get(){throw new Error('Empty texture inspected a mesh');}});
    assert.throws(() => setRingHabitatGeometry(texture, [unreadableMesh], 1234), /requires a full geometry texture/);
    assert.deepEqual(texture.userData, state);assert.equal(texture.version, version);assert.equal(texture.image.data, data);
    assert.deepEqual([...data], [0,0,0,0]);
    const result = shaderCast(texture, [0,0,0], [1,0,0]);
    assert.equal(result.hit, false);assert.equal(result.overflow, 0);
  } finally { texture.dispose(); }
});

test('fixed texture packs exact shared vertices, smooth normals, ordered faces and local BVH ranges', () => {
  const groups = fixture(), radius = 830383.1183351576;
  withTexture(groups, radius, texture => {
    assert.equal(texture.userData.isHabitatFull, true);
    assert.equal(texture.image.width, 512);assert.equal(texture.image.height, 769);
    assert.equal(texture.format, THREE.RGBAFormat);assert.equal(texture.type, THREE.FloatType);
    assert.equal(texture.internalFormat, 'RGBA32F');assert.equal(texture.minFilter, THREE.NearestFilter);
    assert.equal(texture.magFilter, THREE.NearestFilter);assert.equal(texture.generateMipmaps, false);
    const data = texture.image.data;
    assert.ok(data instanceof Float32Array);assert.equal(data.length, TEXELS * 4);assert.equal(data.byteLength,6299648);
    let firstVertex = 0, firstFace = 0, firstNode = 0;
    for (let i = 0; i < groups.length; i++) {
      const patch = groups[i];
      assert.deepEqual([...data.slice(i*16, i*16+4)], [...patch.center, patch.radius].map(n => f(n/radius)));
      assert.deepEqual([...data.slice(i*16+4,i*16+8)], [firstVertex,patch.vertices.length,firstFace,patch.faces.length]);
      assert.deepEqual([...data.slice(i*16+8,i*16+12)], [firstNode,patch.nodes.length,0,0]);
      for (let j = 0; j < patch.vertices.length; j++) {
        const offset = (VERTEX_BASE + (firstVertex+j)*2)*4;
        assert.deepEqual([...data.slice(offset,offset+4)], [...patch.vertices[j].map(n => f(n/radius)),0]);
        assert.deepEqual([...data.slice(offset+4,offset+8)], [...patch.normals[j].map(f),0]);
      }
      for (let j = 0; j < patch.faces.length; j++) {
        const offset = (FACE_BASE+firstFace+j)*4;
        assert.deepEqual([...data.slice(offset,offset+4)], [...patch.faces[patch.triangleOrder[j]].map(n => n+firstVertex),0]);
      }
      for (let j = 0; j < patch.nodes.length; j++) {
        const node = patch.nodes[j], offset = (NODE_BASE+(firstNode+j)*2)*4;
        assert.deepEqual([...data.slice(offset,offset+4)], [...node.min.map(n => f(n/radius)),node.count>0?firstFace+node.start:firstNode+node.left]);
        assert.deepEqual([...data.slice(offset+4,offset+8)], [...node.max.map(n => f(n/radius)),node.count>0?-node.count:firstNode+node.right]);
      }
      firstVertex+=patch.vertices.length;firstFace+=patch.faces.length;firstNode+=patch.nodes.length;
    }
    assert.ok(data.slice(USED_TEXELS*4).every(n => n === 0));
  });
});

test('immutable warm updates skip descriptor scans; equal replacements preserve backing storage and uploads', () => {
  const groups = fixture(), radius = 830383.1183351576;
  withTexture(groups, radius, texture => {
    const data = texture.image.data, buffer = data.buffer, version = texture.version;
    const original = groups[0].vertices;
    Object.defineProperty(groups[0], 'vertices', { get() { throw new Error('Immutable warm descriptor was rescanned'); }, configurable: true });
    for (let i = 0; i < 24; i++) setRingHabitatGeometry(texture, groups, radius);
    Object.defineProperty(groups[0], 'vertices', { value: original, configurable: true });
    setRingHabitatGeometry(texture, fixture(), radius);
    assert.equal(texture.version, version);assert.equal(texture.image.data, data);assert.equal(data.buffer, buffer);
    setRingHabitatGeometry(texture, groups, radius * 2);assert.equal(texture.version, version + 1);
    setRingHabitatGeometry(texture, groups, radius * 2);assert.equal(texture.version, version + 1);
  });
});

test('shrinking and absent meshes clear retired sections without disturbing another rendering slot', () => {
  const groups = fixture(), a = createRingHabitatGeometryTexture(), b = createRingHabitatGeometryTexture();
  try {
    setRingHabitatGeometry(a, groups, 1e6);setRingHabitatGeometry(b, groups, 5e5);
    const data = a.image.data, other = b.image.data.slice(), otherVersion = b.version;
    setRingHabitatGeometry(a, [groups[1]], 1e6);
    assert.ok(data.slice(16,32).every(n=>n===0));
    assert.ok(data.slice((VERTEX_BASE+16)*4,(VERTEX_BASE+32)*4).every(n=>n===0));
    assert.ok(data.slice((FACE_BASE+12)*4,(FACE_BASE+24)*4).every(n=>n===0));
    assert.ok(data.slice((NODE_BASE+14)*4,(NODE_BASE+28)*4).every(n=>n===0));
    setRingHabitatGeometry(a, undefined, 1e6);assert.ok(data.every(n=>n===0));
    const version = a.version;
    setRingHabitatGeometry(a, undefined, 1e6);assert.equal(a.version, version);
    setRingHabitatGeometry(a, groups, 1e6);assert.equal(a.image.data, data);
    assert.deepEqual(b.image.data, other);assert.equal(b.version, otherVersion);
  } finally { a.dispose();b.dispose(); }
});

test('surface kinds reuse normal alpha, upload numeric changes and clear back to legacy or retired mesh state', () => {
  const legacy=box(),surfaceKinds=legacy.vertices.map((_,i)=>i/(legacy.vertices.length-1));
  const rocky={...legacy,surfaceKinds};
  withTexture([legacy],1,texture=>{
    const data=texture.image.data,buffer=data.buffer,before=data.slice(),version=texture.version;
    setRingHabitatGeometry(texture,[rocky],1);
    assert.equal(texture.version,version+1);assert.equal(texture.image.data,data);assert.equal(data.buffer,buffer);
    for(let i=0;i<surfaceKinds.length;i++){
      const offset=(VERTEX_BASE+i*2+1)*4;
      assert.deepEqual([...data.slice(offset,offset+4)],[...legacy.normals[i].map(f),f(surfaceKinds[i])]);
    }
    for(let i=0;i<data.length;i++){
      const isKind=i>=(VERTEX_BASE+1)*4+3&&i<(VERTEX_BASE+legacy.vertices.length*2)*4&&i%8===7;
      if(!isKind)assert.equal(data[i],before[i]);
    }
    setRingHabitatGeometry(texture,[{...legacy,surfaceKinds:[...surfaceKinds]}],1);
    assert.equal(texture.version,version+1);
    const noNormals={...rocky};delete noNormals.normals;
    setRingHabitatGeometry(texture,[noNormals],1);
    assert.deepEqual([...data.slice((VERTEX_BASE+3)*4,(VERTEX_BASE+4)*4)],[0,0,0,f(surfaceKinds[1])]);
    setRingHabitatGeometry(texture,[legacy],1);assert.deepEqual(data,before);
    setRingHabitatGeometry(texture,[rocky],1);
    setRingHabitatGeometry(texture,undefined,1);assert.ok(data.every(n=>n===0));
  });
});

test('invalid optional surface kinds reject all patches before changing texture bytes, upload state or descriptor cache', () => {
  const patch=box(),valid=patch.vertices.map(()=>.5);
  withTexture([patch],1,texture=>{
    const before=texture.image.data.slice(),version=texture.version,state={...texture.userData};
    const badValues=[new Float32Array(valid),valid.slice(1),[...valid,0],valid.map((n,i)=>i===3?NaN:n),valid.map((n,i)=>i===3?Infinity:n),valid.map((n,i)=>i===3?-.1:n),valid.map((n,i)=>i===3?1.1:n)];
    for(const surfaceKinds of badValues){
      const changedFirst={...patch,center:[20,30,40],surfaceKinds:valid};
      assert.throws(()=>setRingHabitatGeometry(texture,[changedFirst,{...patch,surfaceKinds}],1),RangeError);
      assert.deepEqual(texture.image.data,before);assert.equal(texture.version,version);assert.deepEqual(texture.userData,state);
    }
  });
});

test('all 32 patch slots fit and each representation limit rejects before mutation', () => {
  const patch = box(), groups = Array.from({length:32},()=>patch);
  withTexture(groups, 1e6, texture => {
    const before = texture.image.data.slice(), version = texture.version;
    assert.equal(texture.userData.habitatGroupCount,32);
    const last=(31*4+2)*4;
    assert.deepEqual([...before.slice(last,last+4)],[31*7,7,0,0]);
    assert.throws(()=>setRingHabitatGeometry(texture,[...groups,patch],1e6),RangeError);
    for (const [field,limit] of [['vertices',TERRAIN_MESH_VERTEX_CAPACITY],['faces',TERRAIN_MESH_FACE_CAPACITY],['nodes',TERRAIN_MESH_NODE_CAPACITY]]) {
      const invalid = {...patch,[field]:new Array(limit+1)};
      assert.throws(()=>setRingHabitatGeometry(texture,[patch,invalid],1e6),RangeError);
    }
    assert.deepEqual(texture.image.data,before);assert.equal(texture.version,version);
  });
});

test('a closed mesh at both expanded capacities packs every slot within the explicit BVH node budget',()=>{
  // A 32x64 torus reaches 2048 vertices / 4096 faces exactly. Its independent
  // periodic topology is closed and outward, rather than padded fake records.
  const columns=32,rows=64,vertices=[],normals=[],faces=[];
  for(let column=0;column<columns;column++)for(let row=0;row<rows;row++){
    const u=column*Math.PI*2/columns,v=row*Math.PI*2/rows,radial=3+.75*Math.cos(v);
    vertices.push([radial*Math.cos(u),.75*Math.sin(v),radial*Math.sin(u)]);
    normals.push([Math.cos(v)*Math.cos(u),Math.sin(v),Math.cos(v)*Math.sin(u)]);
  }
  for(let column=0;column<columns;column++)for(let row=0;row<rows;row++){
    const a=column*rows+row,b=((column+1)%columns)*rows+row,c=column*rows+(row+1)%rows,d=((column+1)%columns)*rows+(row+1)%rows;
    faces.push([a,c,b],[b,c,d]);
  }
  const patch=buildTerrainMesh({center:[0,0,0],radius:3.75,vertices,faces,normals});
  assert.equal(patch.vertices.length,TERRAIN_MESH_VERTEX_CAPACITY);
  assert.equal(patch.faces.length,TERRAIN_MESH_FACE_CAPACITY);
  assert.equal(patch.nodes.length,2047);assert.equal(TERRAIN_MESH_NODE_CAPACITY,2048);
  const groups=Array.from({length:32},()=>patch);
  withTexture(groups,1,texture=>{
    const data=texture.image.data,firstVertex=31*2048,firstFace=31*4096,firstNode=31*2047;
    assert.deepEqual([...data.slice(31*16+4,31*16+8)],[firstVertex,2048,firstFace,4096]);
    assert.deepEqual([...data.slice(31*16+8,31*16+12)],[firstNode,2047,0,0]);
    assert.equal(texture.userData.habitatVertexCount,32*2048);assert.equal(texture.userData.habitatFaceCount,32*4096);
    assert.equal(texture.userData.habitatNodeCount,32*2047);
    const lastFace=(FACE_BASE+32*4096-1)*4;
    assert.deepEqual([...data.slice(lastFace,lastFace+4)],[...patch.faces[patch.triangleOrder.at(-1)].map(i=>firstVertex+i),0]);
    const unusedNodes=(NODE_BASE+32*2047*2)*4;
    assert.ok(data.slice(unusedNodes).every(value=>value===0),'remaining node capacity and texture padding stay empty');
    // Execute the packed traversal and compare original faces independently,
    // including a real torus hole miss and an inside-to-outside surface hit.
    for(const [origin,ray]of [[[-10,.2,0],[1,0,0]],[[0,0,0],[0,1,0]],[[3,0,0],[0,1,0]],[[0,0,10],[0,0,-1]]]){
      const actual=shaderCast(texture,origin,ray),expected=referenceRay(origin,ray,patch);
      assert.equal(actual.overflow,0);assert.equal(actual.hit,expected.nearest<100);near(actual.nearest,expected.nearest,1e-5);
    }
  });
});

// Execute the actual scalar triangle/slab kernels and traversal control flow.
// Vector operations below model their float32 results; this is a numeric shader
// harness, not shader compilation, a complete GPU emulator or pixel acceptance.
function vector(...values) {
  const result = values.map(f);
  for (const [i,key] of ['x','y','z','w'].entries()) result[key]=result[i];
  result.xyz=result;return result;
}
const vsub=(a,b)=>vector(...sub(a,b));
const vadd=(a,b)=>vector(...a.map((n,i)=>n+b[i]));
const vmul=(a,b)=>vector(...a.map(n=>n*b));
const vnormalize=a=>vector(...normalize(a));
const vcross=(a,b)=>vector(...cross(a,b));
function scalarFunction(name, helpers = {}) {
  const match=GLSL.match(new RegExp('(?:float|vec[234]|bool) '+name+'\\(([^)]*)\\)\\{([\\s\\S]*?)\\n\\}'));
  const names=match[1].split(',').map(a=>a.trim().replace(/^(float|int|bool|vec3) /,''));
  let body=match[2].replace(/float (\w+)=([^;]+);/g,'let $1=f($2);').replace(/\b(int|vec[234]|bool) /g,'let ');
  body=body.replace('float root=sqrt(discriminant),along=dot(relative,ray);','let root=f(sqrt(discriminant)),along=f(dot(relative,ray));');
  return new Function('f','vec2','vec4','habitatAxis','abs','min','max',...Object.keys(helpers),...names,body)
    .bind(null,f,vector,vector,(x,y,z,axis)=>axis===0?x:(axis===1?y:z),Math.abs,Math.min,Math.max,...Object.values(helpers));
}
const triangleKernel=scalarFunction('habitatTriangleRayHit');
const boxKernel=scalarFunction('habitatBoxInterval');

function shaderCast(texture, origin, ray, minimum=0, maximum=100, shadowRay=false) {
  const data=texture.image.data;
  const fetch=index=>vector(...data.slice(index*4,index*4+4));
  const nodeInterval=(node,relative,ray,min,max)=>boxKernel(...relative,...ray,...fetch(NODE_BASE+node*2).slice(0,3),...fetch(NODE_BASE+node*2+1).slice(0,3),min,max);
  const bound=scalarFunction('habitatBoundIntersects');
  const match=GLSL.match(/bool habitatTerrainCast\([^]*?out float nearest\)\{([^]*?)\n\}/);
  let body=match[1].replace('float raySquared=dot(ray,ray);','let raySquared=f(dot(ray,ray));').replace('int stack[32];float stackNear[32];','let stack=new Int32Array(32);let stackNear=new Float32Array(32);')
    .replace('vec3 relative=origin-bounds.xyz;','let relative=vsub(origin,bounds.xyz);')
    .replace('point=origin+ray*nearest;normal=normalize(cross(b-a,c-a));','point=vadd(origin,vmul(ray,nearest));normal=normalize(cross(vsub(b,a),vsub(c,a)));')
    .replace(/vec3 smoothNormal=([^;]+);/,'let smoothNormal=vadd(vadd(vmul(na.xyz,hit.y),vmul(nb.xyz,hit.z)),vmul(nc.xyz,hit.w));')
    .replace(/\b(int|float|vec[234]|bool) /g,'let ').replace(/\bint\(/g,'Math.trunc(')
    .replace(/vec3\(0\.\)/g,'vector(0,0,0)')
    .replace(/habitatTerrainRockCoverage=([^;]+);/g,'habitatTerrainRockCoverage=f($1);')
    .replace('return nearest<maximum;','return {hit:nearest<maximum,nearest,point,normal,shadingNormal:habitatTerrainShadingNormal,overflow:habitatTerrainOverflow,rockCoverage:habitatTerrainRockCoverage};');
  const execute=new Function('f','origin','ray','minimum','maximum','shadowRay','uHabitatGroupCount','habitatTerrainTexel','habitatTriangleRayHit','habitatNodeInterval','habitatBoundIntersects','vsub','vadd','vmul','normalize','cross','dot','vector',
    'let nearest,point,normal,habitatTerrainShadingNormal,habitatTerrainOverflow,habitatTerrainRockCoverage;'+body);
  return execute(f,vector(...origin),vector(...ray),f(minimum),f(maximum),shadowRay,texture.userData.habitatGroupCount,fetch,triangleKernel,nodeInterval,bound,vsub,vadd,vmul,vnormalize,vcross,dot,vector);
}

// Independent Moller-Trumbore oracle visits original faces, without packed order,
// BVH/slab admission or the shader's dominant-axis shear construction.
function referenceRay(origin,ray,patch,minimum=0,maximum=100) {
  let nearest=maximum,normal,bestFace;
  const relative=sub(origin,patch.center);
  for(const face of patch.faces){
    const [a,b,c]=face.map(i=>patch.vertices[i]),e1=sub(b,a),e2=sub(c,a),p=cross(ray,e2),det=dot(e1,p);
    if(Math.abs(det)<1e-15)continue;
    const tvec=sub(relative,a),u=dot(tvec,p)/det;if(u< -1e-10||u>1+1e-10)continue;
    const q=cross(tvec,e1),v=dot(ray,q)/det;if(v< -1e-10||u+v>1+1e-10)continue;
    const t=dot(e2,q)/det;
    if(t>minimum&&t<nearest){nearest=t;normal=normalize(cross(e1,e2));bestFace=face;}
  }
  return {nearest,normal,face:bestFace};
}

test('actual shader traversal matches original closed mesh faces and returns geometric rather than smooth normals',()=>{
  const patch=box();
  withTexture([patch],1,texture=>{
    const cases=[ [[-20,1,1],[1,0,0]],[[20,0,0],[-1,0,0]],[[0,-20,0],[0,1,0]],[[0,0,20],[0,0,-1]],[[0,0,0],[1,0,0]], [[-20,15,0],[1,0,0]], [[-20,-10,8],normalize([20,10,-8])] ];
    for(const [origin,ray] of cases){
      const actual=shaderCast(texture,origin,ray),expected=referenceRay(origin,ray,patch);
      assert.equal(actual.overflow,0);near(actual.nearest,expected.nearest,1e-5);
      if(actual.hit)for(let axis=0;axis<3;axis++)near(actual.normal[axis],expected.normal[axis],1e-6);
    }
    const result=shaderCast(texture,[-20,1,1],[1,0,0]);
    assert.ok(Math.abs(result.shadingNormal[1])>.05);assert.equal(result.normal[1],0);
  });
});

test('real hit barycentrics carry the rock transition and nearest replacement keeps coverage with that same triangle',()=>{
  const patch=box();patch.surfaceKinds=[0,0,0,0,0,1,1,0];
  withTexture([patch],1,texture=>{
    for(const [x,expected] of [[-1,.25],[0,.5],[1,.75]]){
      const actual=shaderCast(texture,[x,.8,20],[0,0,-1]);
      near(actual.nearest,16,0);near(actual.rockCoverage,expected,1e-6);
      assert.deepEqual(actual.normal.slice(0,3),[0,0,1]);assert.equal(actual.overflow,0);
    }
    assert.equal(shaderCast(texture,[20,20,20],[0,0,-1]).rockCoverage,0);
  });
  const far=box([15,0,0]),close=box();
  far.surfaceKinds=far.vertices.map(()=>1);close.surfaceKinds=close.vertices.map(()=>.25);
  for(const groups of [[far,close],[close,far]])withTexture(groups,1,texture=>{
    const actual=shaderCast(texture,[-20,0,0],[1,0,0]);
    near(actual.nearest,18,0);near(actual.rockCoverage,.25,1e-6);assert.equal(actual.overflow,0);
  });
  withTexture([box()],1,texture=>assert.equal(shaderCast(texture,[-20,0,0],[1,0,0]).rockCoverage,0));
});

test('shared edges, inside exits, parallel slabs, nonunit rays and strict interval clipping retain exact mesh hits',()=>{
  const patch=box();
  withTexture([patch],1,texture=>{
    const cases=[ [[-20,0,0],[2,0,0],0,100], [[-20,0,0],[1,0,0],19,100], [[-20,0,0],[1,0,0],0,17], [[-20,0,0],[1,0,0],18,100], [[-20,3,0],[1,0,0],0,100], [[-20,3.001,0],[1,0,0],0,100], [[0,0,0],[0,1,0],0,100], [[0,0,20],[0,0,-1],0,100] ];
    for(const [origin,ray,min,max] of cases){
      const actual=shaderCast(texture,origin,ray,min,max);assert.equal(actual.overflow,0);
      near(actual.nearest,referenceRay(origin,ray,patch,min,max).nearest,1e-6);
    }
  });
});

test('a packed corner hit survives downward sphere-radius rounding and cross-discriminant roundoff',()=>{
  const patch=box(),origin=[-7.284766674041748,5.228343963623047,6.971125602722168];
  const ray=[.9284766908852594,-.22283440581246225,-.297112541083283];
  withTexture([patch],1,texture=>{
    const packedRadius=texture.image.data[3],ray32=vector(...ray),origin32=vector(...origin);
    assert.ok(packedRadius<Math.hypot(2,3,4));
    const across=vcross(origin32,ray32),raySquared=f(dot(ray32,ray32));
    assert.ok(f(raySquared*packedRadius*packedRadius-dot(across,across))<0,'unbounded float32 sphere discriminator rejects the actual corner');
    let packedNearest=100;
    for(const face of patch.faces){
      const [a,b,c]=face.map(i=>patch.vertices[i]);
      packedNearest=Math.min(packedNearest,triangleKernel(...origin32,...ray32,...a,...b,...c,false,0,100)[0]);
    }
    near(packedNearest,9.999999046325684,1e-6);
    const actual=shaderCast(texture,origin,ray);
    assert.equal(actual.overflow,0);assert.equal(actual.hit,true);
    near(actual.nearest,packedNearest,0);
    // Admission tolerance belongs to the sphere only. A nearby line that
    // misses every original packed face must still produce no terrain hit.
    const missOrigin=vector(origin[0],origin[1]+1e-5,origin[2]+1e-5);
    assert.equal(scalarFunction('habitatBoundIntersects')(missOrigin,ray32,raySquared,packedRadius),true);
    assert.equal(shaderCast(texture,missOrigin,ray).hit,false);
  });
});

test('later patches clip the current nearest hit and absent smooth normals use the exact face only for lighting',()=>{
  const far=box([15,0,0]),close=box([0,0,0]);delete close.normals;
  withTexture([far,close],1,texture=>{
    const result=shaderCast(texture,[-20,0,0],[1,0,0]);
    near(result.nearest,18,0);assert.deepEqual(result.shadingNormal,result.normal);assert.equal(result.overflow,0);
  });
});

test('float32 body-relative mesh at 830k retains close outer and inner wall intersections',()=>{
  const radius=830383.1183351576,patch=box([830000.383,1200.513,-2000.274],100);
  withTexture([patch],radius,texture=>{
    for(const [local,ray] of [[[-200.4,20,30],[1,0,0]],[[-199.6,20,30],[-1,0,0]],[[0,0,400.4],[0,0,-1]],[[0,0,399.6],[0,0,1]]]){
      const origin=local.map((n,i)=>n+patch.center[i]),normalized=origin.map(n=>f(n/radius));
      const actual=shaderCast(texture,normalized,ray,0,.02),expected=referenceRay(origin,ray,patch,0,.02*radius);
      assert.ok(actual.hit);assert.equal(actual.overflow,0);near(actual.nearest*radius,expected.nearest,.1);
    }
  });
});

test('stack and visit exhaustion set explicit overflow instead of reporting a complete terrain cast',()=>{
  const deep=box(),min=[-2,-3,-4],max=[2,3,4];deep.nodes=[];
  for(let i=0;i<34;i++)deep.nodes.push({min,max,left:i+1,right:35+i,start:0,count:0});
  deep.nodes.push({min,max,left:-1,right:-1,start:0,count:1});
  for(let i=0;i<34;i++)deep.nodes.push({min,max,left:-1,right:-1,start:0,count:1});
  withTexture([deep],1,texture=>assert.equal(shaderCast(texture,[-20,0,0],[1,0,0]).overflow,1));
  const cycle=box();cycle.nodes=[{min,max,left:0,right:1,start:0,count:0},{min:[100,100,100],max:[101,101,101],left:-1,right:-1,start:0,count:1}];
  withTexture([cycle],1,texture=>assert.equal(shaderCast(texture,[-20,0,0],[1,0,0]).overflow,1));
});

test('production continuous heightgrid/BVH packs the full landscape and retains sampled top, buried base and sidewall triangles',()=>{
  const options={radius:830383.1183351576,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'mesh-render-oracle'};
  options.parts=cosmicRingParts(options);
  const groups=createRingHabitat(options).terrainGroups;
  assert.ok(groups.length>0&&groups.length<=32);
  for(const patch of groups){assert.ok(patch.vertices.length<=TERRAIN_MESH_VERTEX_CAPACITY);assert.ok(patch.faces.length<=TERRAIN_MESH_FACE_CAPACITY);assert.ok(patch.nodes.length<=TERRAIN_MESH_NODE_CAPACITY);}
  withTexture(groups,options.radius,texture=>{
    assert.equal(texture.userData.habitatVertexCount,groups.reduce((sum,patch)=>sum+patch.vertices.length,0));
    assert.equal(texture.userData.habitatFaceCount,groups.reduce((sum,patch)=>sum+patch.faces.length,0));
    let rockSamples=0;
    // Every sample executes the real source traversal across all packed patches.
    // Offsets straddle top, curved bottom and stitched sidewall face ranges.
    for(const patchIndex of [0,Math.floor(groups.length/2),groups.length-1]){
      const patch=groups[patchIndex];
      const rockFaces=patch.refinedFaces.flatMap(refined=>[refined.faces[0],refined.faces.at(-1)]);
      for(const faceIndex of [0,127,255,511,777,1023,1024,1100,patch.faces.length-1,...rockFaces]){
        const [a,b,c]=patch.faces[faceIndex].map(i=>patch.vertices[i]);
        const normal=normalize(cross(sub(b,a),sub(c,a)));
        const local=a.map((n,i)=>(n+b[i]+c[i])/3+normal[i]*2);
        const origin=local.map((n,i)=>n+patch.center[i]),ray=normal.map(n=>-n);
        const expected=referenceRay(origin,ray,patch,0,100);
        const actual=shaderCast(texture,origin.map(n=>f(n/options.radius)),ray,0,100/options.radius);
        assert.equal(actual.overflow,0);assert.ok(actual.hit,`patch ${patchIndex} face ${faceIndex}`);
        near(actual.nearest*options.radius,expected.nearest,.15);
        if(rockFaces.includes(faceIndex)){
          // A face centroid carries the mean of its three vertex kinds. This
          // also exercises real mixed natural/rock faces and all-rock terraces.
          const expectedCoverage=patch.faces[faceIndex].reduce((sum,index)=>sum+patch.surfaceKinds[index],0)/3;
          near(actual.rockCoverage,expectedCoverage,.005);rockSamples++;
        }
        // The geometric normal belongs to the actual float32 packed face.
        // Thin buried walls amplify quantization relative to a double normal.
        const [pa,pb,pc]=expected.face.map(i=>vector(...patch.vertices[i].map(n=>f(n/options.radius))));
        const packedNormal=vnormalize(vcross(vsub(pb,pa),vsub(pc,pa)));
        for(let axis=0;axis<3;axis++)near(actual.normal[axis],packedNormal[axis],1e-6);
      }
    }
    assert.ok(rockSamples>0,'production rock faces were actually intersected');
  });
});

test('an outward light ray skips the source terrain exit and retains a later terrain entry', () => {
  withTexture([box(), box([10,0,0])],1,texture=>{
    const origin=[1.99,0,0], ray=[1,0,0];
    near(shaderCast(texture,origin,ray).nearest,.01);
    near(shaderCast(texture,origin,ray,0,100,true).nearest,6.01);
    assert.equal(shaderCast(texture,origin,ray,0,5,true).hit,false);
  });
});
