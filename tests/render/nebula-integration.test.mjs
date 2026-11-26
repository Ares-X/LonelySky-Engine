import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createNebula} from '../../src/render/nebula.js';

const smoothstep=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
function withShader(check) {
  const nebula=createNebula();
  try {check(nebula.children[0].material.fragmentShader,nebula.children[0].material.uniforms);}
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

// Execute the uploaded node and optical rules, while supplying a sample phase.
function rayNode(shader){
  const expression=shader.match(/float node=([^;]+);/)?.[1];assert.ok(expression);
  return Function('i','phase',`return ${expression.replaceAll('float(i)','i')};`);
}
function opticalRule(shader){
  const expression=shader.match(/float opticalStep=([^;]+);/)?.[1];assert.ok(expression);
  return Function('stepSize','worldDirection','length',`return ${expression.replace('mat3(uLocalToWorld)*rd','worldDirection')};`);
}
function opacityRule(shader){
  const expression=shader.match(/float opacity=([^;]+);/)?.[1];assert.ok(expression);
  return Function('rho','opticalStep','uDensity','uExtinction','exp',`return ${expression};`);
}

test('every stratified phase conserves constant source and Beer extinction over the complete interval',()=>withShader(shader=>{
  const node=rayNode(shader),opacity=opacityRule(shader);
  const rho=.14,density=.8,extinction=1.2,opticalLength=1.7,source=.65;
  const totalTransmission=Math.exp(-rho*opticalLength*density*7.5*extinction);
  for(const steps of [32,64,96])for(const phase of [0,.001,.17,.5,.83,.999999]){
    const points=Array.from({length:steps},(_,i)=>node(i,phase)/steps);
    assert.ok(points.every((p,i)=>p>=i/steps&&p<(i+1)/steps&&(!i||p>points[i-1])));
    let transmission=1,radiance=0;
    for(const point of points){
      const absorbed=opacity(rho,opticalLength/steps,density,extinction,Math.exp);
      radiance+=transmission*absorbed*source;transmission*=1-absorbed;
    }
    assert.ok(Math.abs(transmission-totalTransmission)<2e-14);
    assert.ok(Math.abs(radiance-source*(1-totalTransmission))<2e-14);
  }
}));

test('uploaded screen phase stays in its stratum and does not drift with the animation clock',()=>withShader(shader=>{
  const body=shader.match(/float rayPhase\(vec2 pixel\)\{([^}]+)\}/)?.[1];assert.ok(body);
  // Translate this small uploaded hash's vector operations, then execute its
  // actual scalar arithmetic. No fixture hash replaces the production phase.
  const code=body.replace('vec3 p=','let p=')
    .replace(/vec3\(pixel\.([xy]{3})\)\*([^)]*)/,(_,swizzle,factor)=>`[${[...swizzle].map(axis=>`pixel.${axis}`).join(',')}].map(v=>v*(${factor}))`)
    .replace(/p\+=dot\(p,p\.yzx\+([^)]*)\);/,'p=p.map(v=>v+dot(p,[p[1],p[2],p[0]].map(v=>v+($1))));')
    .replace(/p\.x/g,'p[0]').replace(/p\.y/g,'p[1]').replace(/p\.z/g,'p[2]');
  const fract=value=>Array.isArray(value)?value.map(v=>v-Math.floor(v)):value-Math.floor(value);
  const evaluate=Function('pixel','uTime','fract','dot',code);
  const phaseAt=(pixel,time)=>evaluate(pixel,time,fract,(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0));
  const phases=new Set(),node=rayNode(shader);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    const pixel={x:x+.5,y:y+.5},phase=phaseAt(pixel,0);
    assert.ok(Number.isFinite(phase)&&phase>=0&&phase<1);
    for(const time of [1,123,1e6])assert.equal(phaseAt(pixel,time),phase);
    for(const steps of [32,64,96])for(const i of [0,steps-1]){
      const sample=node(i,phase);assert.ok(sample>=i&&sample<i+1);
    }
    phases.add(phase);
  }
  assert.ok(phases.size>240,'different pixels retain a spatial phase distribution');
}));

test('stratified cubic quadrature has bounded single-phase error and converges across phase ensembles',()=>withShader(shader=>{
  const node=rayNode(shader);
  for(const steps of [32,64,96]){
    // Monotone x^k lies between left/right cell sums, whose difference is 1/N.
    for(const phase of [0,.001,.17,.5,.83,.999999])for(const power of [1,2,3]){
      let integral=0;for(let i=0;i<steps;i++)integral+=(node(i,phase)/steps)**power/steps;
      assert.ok(Math.abs(integral-1/(power+1))<=1/steps+1e-14);
    }
    let previousError=Infinity;
    for(const phases of [4,16,64]){
      let cubic=0;
      // Uniform midpoint phases are an independent ensemble quadrature over
      // the entire phase range; they do not promise any individual pixel exact.
      for(let j=0;j<phases;j++)for(let i=0;i<steps;i++)cubic+=(node(i,(j+.5)/phases)/steps)**3/(steps*phases);
      const error=Math.abs(cubic-.25),bound=1/(8*(steps*phases)**2);
      assert.ok(error<=bound+1e-13,`${steps} cells / ${phases} phases: ${error} > ${bound}`);
      assert.ok(error<previousError/15,'quadrupling phase count retains second-order ensemble convergence');
      previousError=error;
    }
  }
}));

test('local nebula appearance declares only the depth compositor sampler',()=>withShader((shader,uniforms)=>{
  const samplers=[...shader.matchAll(/uniform\s+(?:[a-z]+p\s+)?\w*sampler\w*\s+([^;]+);/g)].map(match=>match[1]);
  assert.deepEqual(samplers,['uSceneDepth']);
  assert.equal(uniforms.uSceneDepth.value,null);
  assert.ok(Object.values(uniforms).every(({value})=>value?.isTexture!==true));
}));

// Execute the uploaded interval control flow. Vector reconstruction is supplied
// by Three's inverse matrix, since this is a numerical boundary check rather
// than a GLSL emulator. In particular, moving stepSize before clipping changes
// the evaluated result and lets the quadrature reach behind the surface.
function intervalRule(shader) {
  const start=shader.indexOf('  float exit='),end=shader.indexOf(';',shader.indexOf('  float stepSize=',start));
  const source=shader.slice(start,end+1)
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

test('every stratified phase stays inside depth-clipped cells and preserves world optical length',()=>withShader(shader=>{
  const interval=intervalRule(shader);
  const node=rayNode(shader),optical=opticalRule(shader),opacity=opacityRule(shader);
  const localToWorld=new THREE.Matrix4().compose(new THREE.Vector3(100,-400,850),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-.15),new THREE.Vector3(7500,6200,3800));
  const camera=new THREE.PerspectiveCamera(55,1,.5,220000);
  const localCamera=new THREE.Vector3(0,0,3),rd=new THREE.Vector3(0,0,-1);
  camera.position.copy(localCamera).applyMatrix4(localToWorld);
  camera.lookAt(new THREE.Vector3().applyMatrix4(localToWorld));camera.updateMatrixWorld();
  const clipToLocal=localToWorld.clone().invert().multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
  const worldDirection=rd.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(localToWorld));
  for(const steps of [32,64,96])for(const stop of [1.5,2.2,2.7,3.9,5]){
    const localSurface=localCamera.clone().addScaledVector(rd,stop);
    const clip=localSurface.clone().applyMatrix4(localToWorld).project(camera);
    const reconstructed=clip.clone().applyMatrix4(clipToLocal).sub(localCamera);
    const ray=interval(4,2,steps,true,clip.z*.5+.5,reconstructed,rd,Math.min,(a,b)=>a.dot(b));
    if(stop<=2){assert.equal(ray,null,'a surface in front of the box excludes all dust');continue}
    const expectedExit=Math.min(4,stop);
    assert.ok(Math.abs(ray.exit-expectedExit)<1e-9);
    for(const phase of [0,.001,.17,.5,.83,.999999]){
      const nodes=Array.from({length:steps},(_,i)=>2+node(i,phase)*ray.stepSize);
      assert.ok(nodes.every((p,i)=>p>=2&&p<expectedExit&&(!i||p>nodes[i-1])),'all density and footprint samples precede the opaque surface');
      const perCell=optical(ray.stepSize,worldDirection,v=>v.length());
      let transmission=1;
      for(const point of nodes)transmission*=1-opacity(.12,perCell,.7,1.1,Math.exp);
      const expected=Math.exp(-.12*(ray.exit-2)*worldDirection.length()/6000*.7*7.5*1.1);
      assert.ok(Math.abs(transmission-expected)<2e-14,'constant extinction is unchanged by depth clipping or sample phase');
    }
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
