import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createCosmicBodies} from '../../src/render/cosmic-bodies.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';

const frame=[1,0,0,0,1,0,0,0,1],sun=[0,0,1];
const normalize=values=>values.map(value=>value/Math.hypot(...values));
function atmosphere(group){return group.children[0].children.find(object=>object.name==='Cosmic optical atmosphere');}
function actualShader(){
  const group=createCosmicBodies();
  try{return atmosphere(group).material.fragmentShader;}finally{group.userData.dispose();}
}
const shader=actualShader();

// Mechanically execute ONLY these actual scalar/vector helper bodies. This
// strips declarations and supplies dot/cross/vec2 builtins, not a GLSL compiler
// or a second implementation of the interval/Beer rules. GPU precision and
// shader compilation remain separate native acceptance boundaries.
function helper(name,light=sun){
  const match=shader.match(new RegExp(`(?:float|vec2) ${name}\\(([^)]*)\\)\\{`));assert.ok(match,name);
  const start=match.index+match[0].length;let end=start,depth=1;
  while(depth){const char=shader[end++];if(char==='{')depth++;else if(char==='}')depth--;}
  const parameters=match[1].split(',').map(parameter=>parameter.trim().split(/\s+/).at(-1));
  const body=shader.slice(start,end-1).replace(/\b(?:float|vec2|vec3)\s+(\w+)/g,'let $1');
  const scope={uLight:light,vec2:(x,y)=>({x,y}),
    dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
    cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
    min:Math.min,max:Math.max,sqrt:Math.sqrt,exp:Math.exp,clamp:(value,lo,hi)=>Math.max(lo,Math.min(hi,value))};
  return Function(...Object.keys(scope),`return function(${parameters.join(',')}){${body}}`)(...Object.values(scope));
}
const interval=helper('gasAtmosphereShadowInterval'),litAbsorbed=helper('gasAtmosphereLitAbsorbed');

// Independent point query: a sunward ray reaches the sphere's projected disk
// only when its closest approach lies ahead of the point. No interval roots
// or candidate helper are used by this dense reference quadrature.
function denseLitAbsorbed(origin,ray,light,radius,lo,hi,extinction,samples=131072){
  const step=(hi-lo)/samples;let integral=0;
  for(let index=0;index<samples;index++){
    const t=lo+(index+.5)*step,x=origin[0]+ray[0]*t,y=origin[1]+ray[1]*t,z=origin[2]+ray[2]*t;
    const toward=x*light[0]+y*light[1]+z*light[2],closestSquared=x*x+y*y+z*z-toward*toward;
    const blocked=toward<0&&closestSquared<radius*radius;
    if(!blocked)integral+=extinction*Math.exp(-extinction*(t-lo))*step;
  }
  return integral;
}
const cases=[
  {name:'night-side cylinder crossing',origin:[-2,0,-2],ray:[1,0,0],lo:0,hi:4,expected:[1,3]},
  {name:'parallel toward sun clips the anti-sun halfspace',origin:[.5,0,-2],ray:[0,0,1],lo:0,hi:4,expected:[0,2]},
  {name:'parallel away from sun enters the anti-sun halfspace',origin:[.5,0,2],ray:[0,0,-1],lo:0,hi:4,expected:[2,4]},
  {name:'exact cylinder tangent has no shadow-interior length',origin:[-2,1,-2],ray:[1,0,0],lo:0,hi:4,expected:[0,0]},
  {name:'axial ray on cylinder boundary has no shadow interior',origin:[1,0,-2],ray:[0,0,1],lo:0,hi:4,expected:[0,0]},
  {name:'day halfspace excludes a cylinder crossing',origin:[-2,0,2],ray:[1,0,0],lo:0,hi:4,expected:[0,0]},
  {name:'halfspace ends before cylinder entry',origin:[-2,0,-.5],ray:normalize([1,0,1]),lo:0,hi:4,expected:[0,0]},
  {name:'halfspace truncates an actual cylinder interval',origin:[-2,0,-2],ray:normalize([1,0,1]),lo:0,hi:4,expected:[Math.SQRT2,2*Math.SQRT2]},
  {name:'near axial ray remains finite',origin:[-.9999999,0,-1],ray:normalize([1.e-7,0,1]),lo:0,hi:2,expected:[0,1]},
  {name:'camera inside shell reaches partial shadow before the solid',origin:[1.003,0,-.04],ray:normalize([-.3,0,1]),lo:0,hi:.0118,expected:[.003/(-normalize([-.3,0,1])[0]),.0118]},
];

for(const fixture of cases)test(`actual gas shadow kernel: ${fixture.name}`,()=>{
  const {origin,ray,lo,hi,expected}=fixture,shadow=interval(origin,ray,1,lo,hi);
  assert.ok(Math.abs(shadow.x-expected[0])<1.e-10,`entry ${shadow.x} != ${expected[0]}`);
  assert.ok(Math.abs(shadow.y-expected[1])<1.e-10,`exit ${shadow.y} != ${expected[1]}`);
  for(const extinction of [.03,.37,3]){
    const tau=extinction*(hi-lo),absorbed=1-Math.exp(-tau),actual=litAbsorbed(lo,hi,tau,absorbed,shadow);
    const reference=denseLitAbsorbed(origin,ray,sun,1,lo,hi,extinction);
    assert.ok(Number.isFinite(actual)&&actual>=0&&actual<=absorbed);
    assert.ok(Math.abs(actual-reference)<1.e-5,`${extinction}: ${actual} differs from independent dense shadow integral ${reference}`);
  }
});

test('actual Beer-weighted cell preserves front-lit versus back-lit ordering',()=>{
  const extinction=.7,lo=0,hi=4,tau=extinction*(hi-lo),absorbed=1-Math.exp(-tau);
  const front={origin:[.5,0,2],ray:[0,0,-1]},back={origin:[.5,0,-2],ray:[0,0,1]};
  const frontLit=litAbsorbed(lo,hi,tau,absorbed,interval(front.origin,front.ray,1,lo,hi));
  const backLit=litAbsorbed(lo,hi,tau,absorbed,interval(back.origin,back.ray,1,lo,hi));
  assert.ok(frontLit>backLit,'equal lit lengths have different Beer weights');
  assert.ok(Math.abs(frontLit-denseLitAbsorbed(front.origin,front.ray,sun,1,lo,hi,extinction))<1.e-9);
  assert.ok(Math.abs(backLit-denseLitAbsorbed(back.origin,back.ray,sun,1,lo,hi,extinction))<1.e-9);
  assert.equal(litAbsorbed(lo,hi,0,0,{x:1,y:3}),0,'a transparent cell cannot generate solar light');
});

test('actual shadow kernel is invariant under a rigid body-frame rotation',()=>{
  const rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(.34,-.61,.18));
  const rotate=values=>new THREE.Vector3(...values).applyQuaternion(rotation).toArray(),rotatedSun=rotate(sun),rotatedInterval=helper('gasAtmosphereShadowInterval',rotatedSun);
  const fixture=cases[7],origin=rotate(fixture.origin),ray=rotate(fixture.ray),shadow=rotatedInterval(origin,ray,1,fixture.lo,fixture.hi);
  assert.ok(Math.abs(shadow.x-fixture.expected[0])<1.e-12);assert.ok(Math.abs(shadow.y-fixture.expected[1])<1.e-12);
  const extinction=.37,tau=extinction*(fixture.hi-fixture.lo),actual=litAbsorbed(fixture.lo,fixture.hi,tau,1-Math.exp(-tau),shadow);
  assert.ok(Math.abs(actual-denseLitAbsorbed(origin,ray,rotatedSun,1,fixture.lo,fixture.hi,extinction))<1.e-5);
});

test('the direct optical consumer enables gas, stellar limbs and complete habitats',()=>{
  const group=createCosmicBodies(),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  camera.updateMatrixWorld();
  const body={id:'atmosphere-consumer',radius:1000000,center:[0,0,-4000000],frame,light:sun,tint:[.5,.58,.64],phase:.3};
  try{
    for(const kind of ['gas-giant','dark-world','moon','stellar-giant']){
      group.userData.update({body:{...body,kind,shape:{type:'sphere',radius:body.radius}},camera,viewportHeight:1000,pixelRatio:1});
      assert.equal(atmosphere(group).visible,kind==='gas-giant'||kind==='stellar-giant',kind);
      assert.equal(atmosphere(group).material.blending,kind==='stellar-giant'?THREE.AdditiveBlending:THREE.NormalBlending);
    }
    const parts=cosmicRingParts({...body,halfWidth:.02,thickness:.0005,broken:false,theme:'silver-dust',seed:'atmosphere-consumer'});
    group.userData.update({body:{...body,kind:'ring',shape:{type:'compound',parts}},camera,viewportHeight:1000,pixelRatio:1});
    assert.equal(atmosphere(group).visible,true);
    group.userData.update({body:{...body,kind:'ring',shape:{type:'compound',parts:parts.slice(0,2)}},camera,viewportHeight:1000,pixelRatio:1});
    assert.equal(atmosphere(group).visible,false,'an incomplete habitat does not enable the ring optical layer');
  }finally{group.userData.dispose();}
});
