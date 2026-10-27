import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {createNebula} from '../../src/render/nebula.js';

const smoothstep=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
function withShader(check) {
  const nebula=createNebula();
  try {check(nebula.children[0].material.fragmentShader,nebula.children[0].material.uniforms.uNoise.value);}
  finally {nebula.userData.dispose();}
}

test('cloud support vanishes before every bounding face and stays continuous inside',()=>withShader(shader=>{
  const expression=shader.match(/float support=([^;]+);/)?.[1];assert.ok(expression);
  const support=Function('edge','smoothstep',`return ${expression};`);
  for(const axis of [0,1,2]) for(const sign of [-1,1]) for(const other of [-1,-.5,0,.5,1]) {
    const p=[other,other,other];p[axis]=sign;
    assert.equal(support(Math.max(...p.map(Math.abs)),smoothstep),0,'no density may reach a hard geometry face');
  }
  let previous=1;
  for(let i=0;i<=1000;i++) {
    const value=support(i/1000,smoothstep);
    assert.ok(Number.isFinite(value)&&value>=0&&value<=previous+1e-12);
    assert.ok(previous-value<.01,'the support fade cannot create another density cliff');previous=value;
  }
}));

test('paired ray cells conserve constant light and integrate cubic variation exactly',()=>withShader(shader=>{
  const expression=shader.match(/float node=([^;]+);/)?.[1];assert.ok(expression);
  const node=Function('i','floor','mod',`return ${expression.replaceAll('float(i)','i')};`);
  for(const steps of [16,32,48]) {
    const points=Array.from({length:steps},(_,i)=>node(i,Math.floor,(a,b)=>a-b*Math.floor(a/b))/steps);
    assert.ok(points.every((p,i)=>p>0&&p<1&&(!i||p>points[i-1])));
    for(const power of [0,1,2,3]) {
      const integral=points.reduce((sum,p)=>sum+p**power/steps,0);
      assert.ok(Math.abs(integral-1/(power+1))<1e-10,'known polynomial integrals protect the uploaded ray rule');
    }
  }
}));

test('shared cloud noise retains a bounded mip chain for pixel and ray filtering',()=>withShader((shader,texture)=>{
  assert.equal(texture.image.width,64);assert.equal(texture.image.height,64);assert.equal(texture.image.depth,64);
  assert.equal(texture.image.data.byteLength,64**3);
  assert.equal(texture.generateMipmaps,true);assert.equal(texture.minFilter,THREE.LinearMipmapLinearFilter);
  assert.equal(texture.magFilter,THREE.LinearFilter);
}));

test('first-owner noise optimization preserves every approved candidate tile byte',()=>withShader((shader,texture)=>{
  // Captured from the original uncached 64³ algorithm at the fixed tile seed
  // 0x51a7d05. The complete tile protects periodic seams and all three octaves;
  // caller seeds still select offsets in this same shared stationary texture.
  assert.equal(createHash('sha256').update(texture.image.data).digest('hex'),
    'cd0198eda09bb72ded74028c817b5253fab8f298d231ac4cfee51b4ef535b17a');
}));

// Execute the uploaded interval control flow. Vector reconstruction is supplied
// by Three's inverse matrix, since this is a numerical boundary check rather
// than a GLSL emulator. In particular, moving stepSize before clipping changes
// the evaluated result and lets the quadrature reach behind the surface.
function intervalRule(shader) {
  const source=shader.slice(shader.indexOf('  float exit='),shader.indexOf('  vec3 color='))
    .replace(/#ifdef USE_REVERSED_DEPTH_BUFFER[\s\S]*?#else([\s\S]*?)#endif/g,'$1')
    .replace(/(?:bool|float) (hasSurface|surfaceClipDepth)=/g,'let $1=')
    .replace(/float exit=[^;]+;/,'let exit=boxExit;')
    .replace(/vec2 uv=[^;]+;/,'')
    .replace(/float surfaceDepth=[^;]+;/,'')
    .replace(/vec4 surface=[^;]+;/,'')
    .replace('surface.xyz/surface.w-uCamera','surfaceOffset')
    .replace('float stepSize=','const stepSize=')
    .replaceAll('float(uSteps)','uSteps')
    .replaceAll('discard;','return null;');
  return Function('boxExit','entry','uSteps','uHasSceneDepth','surfaceDepth','surfaceOffset','rd','min','dot',
    source+'\nreturn {exit,stepSize};');
}

test('scene-depth-truncated Gauss cells and world optical weights stop at embedded surfaces',()=>withShader(shader=>{
  const interval=intervalRule(shader);
  const nodeExpression=shader.match(/float node=([^;]+);/)?.[1];assert.ok(nodeExpression);
  const node=Function('i','floor','mod',`return ${nodeExpression.replaceAll('float(i)','i')};`);
  const opticalExpression=shader.match(/float opticalStep=([^;]+);/)?.[1];assert.ok(opticalExpression);
  const optical=Function('stepSize','worldDirection','length',`return ${opticalExpression.replace('mat3(uLocalToWorld)*rd','worldDirection')};`);
  const localToWorld=new THREE.Matrix4().compose(new THREE.Vector3(100,-400,850),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-.15),new THREE.Vector3(7500,6200,3800));
  const camera=new THREE.PerspectiveCamera(55,1,.5,220000);
  const localCamera=new THREE.Vector3(0,0,3),rd=new THREE.Vector3(0,0,-1);
  camera.position.copy(localCamera).applyMatrix4(localToWorld);
  camera.lookAt(new THREE.Vector3().applyMatrix4(localToWorld));camera.updateMatrixWorld();
  const clipToLocal=localToWorld.clone().invert().multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
  const worldDirection=rd.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(localToWorld));
  for(const steps of [16,32,48])for(const stop of [1.5,2.2,2.7,3.9,5]){
    const localSurface=localCamera.clone().addScaledVector(rd,stop);
    const clip=localSurface.clone().applyMatrix4(localToWorld).project(camera);
    const reconstructed=clip.clone().applyMatrix4(clipToLocal).sub(localCamera);
    const ray=interval(4,2,steps,true,clip.z*.5+.5,reconstructed,rd,Math.min,(a,b)=>a.dot(b));
    if(stop<=2){assert.equal(ray,null,'a surface in front of the box excludes all dust');continue}
    const expectedExit=Math.min(4,stop);
    assert.ok(Math.abs(ray.exit-expectedExit)<1e-9);
    const nodes=Array.from({length:steps},(_,i)=>2+node(i,Math.floor,(a,b)=>a-b*Math.floor(a/b))*ray.stepSize);
    assert.ok(nodes.every((p,i)=>p>2&&p<expectedExit&&(!i||p>nodes[i-1])),'all density and footprint samples precede the opaque surface');
    const totalOptical=steps*optical(ray.stepSize,worldDirection,v=>v.length());
    assert.ok(Math.abs(totalOptical-(expectedExit-2)*worldDirection.length()/6000)<1e-9,
      'clipped quadrature weights conserve the actual foreground world distance');
  }
  const clear=interval(4,2,32,true,1,new THREE.Vector3(),rd,Math.min,(a,b)=>a.dot(b));
  assert.equal(clear.exit,4,'clear depth retains the complete interval');
}));

test('supernova source colour stays finite on the shell polar axis',()=>withShader(shader=>{
  const expression=shader.match(/float azimuth=([^;]+);/)?.[1];assert.ok(expression);
  const azimuth=Function('p','dot','atan',`return ${expression};`);
  const atan=(y,x)=>y===0&&x===0?NaN:Math.atan2(y,x);
  for(const [x,z] of [[0,0],[1e-10,0],[0,-1e-10],[.2,.3],[-.3,.2]]){
    const value=azimuth({x,z,xz:[x,z]},(a,b)=>a[0]*b[0]+a[1]*b[1],atan);
    assert.ok(Number.isFinite(value));
    if(Math.hypot(x,z)>.0001)assert.equal(value,Math.atan2(z,x));
  }
}));
