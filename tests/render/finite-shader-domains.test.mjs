import test from 'node:test';
import assert from 'node:assert/strict';
import {planetMaterial, atmosphereMaterial} from '../../src/render/materials.js';
import {createGalaxyHaze} from '../../src/render/galaxy-haze.js';

const f = Math.fround;
const dot = (a,b) => f(f(f(a[0]*b[0])+f(a[1]*b[1]))+f(a[2]*b[2]));
const normalize = value => {const length=f(Math.sqrt(dot(value,value)));return value.map(n=>f(n/length));};
const clamp = (value,low,high) => Math.max(low,Math.min(high,value));
// GLSL pow does not define negative bases, even for an integral exponent.
const pow = (base,exponent) => base<0 ? NaN : Math.pow(base,exponent);

// Evaluate the material's actual scalar expressions, rather than duplicating
// the repaired formulas. This is a numerical domain check, not a GPU emulator.
function expression(shader,name) {
  const match=shader.match(new RegExp(`float\\s+${name}\\s*=\\s*([^;]+);`));
  assert.ok(match,`shader exposes ${name}'s scalar calculation`);
  return match[1];
}
function evaluate(source,values={}) {
  const scope={pow,clamp,dot,normalize,abs:Math.abs,exp:Math.exp,...values};
  return Function(...Object.keys(scope),`return (${source});`)(...Object.values(scope));
}

test('planet limb and atmosphere remain finite at float32 facing extrema', () => {
  const planet=planetMaterial({kind:'gas',seed:1,radius:1750,colorA:0xb9a078,colorB:0xf2dfbc});
  const atmosphere=atmosphereMaterial(0x72bded);
  try {
    // Opening Saturn's world-space direction. The rounded self dot exceeds one.
    const n=normalize([-1700,800,4800]);
    assert.equal(dot(n,n),1.0000001192092896);
    assert.ok(Number.isNaN(pow(f(1-dot(n,n)),4.5)),'fixture reaches the old invalid pow domain');
    const limb=expression(planet.fragmentShader,'limb');
    const facing=expression(atmosphere.fragmentShader,'facing');
    const optical=expression(atmosphere.fragmentShader,'optical');
    for(const sign of [1,-1]) {
      const view=n.map(value=>value*sign);
      const result=evaluate(limb,{n,view,day:1});
      assert.equal(result,sign===1?0:1);
      const face=evaluate(facing,{n,cameraPosition:0,vWorld:0,normalize:()=>view});
      assert.equal(face,1);
      assert.equal(evaluate(optical,{facing:face}),0);
    }
    // Ordinary angular response is retained between the extrema.
    for(const cosine of [-1,-.5,0,.25,.5,.9,1]) {
      const values={n:[1,0,0],view:[cosine,Math.sqrt(1-cosine*cosine),0],day:.7};
      assert.ok(Math.abs(evaluate(limb,values)-Math.pow(1-Math.max(cosine,0),4.5)*.7)<1e-7);
      const face=evaluate(facing,{n:values.n,cameraPosition:0,vWorld:0,normalize:()=>values.view});
      assert.ok(Math.abs(evaluate(optical,{facing:face})-Math.pow(1-Math.abs(cosine),4))<1e-7);
    }
  } finally {planet.dispose();atmosphere.dispose();}
});

function galaxyShader() {
  const haze=createGalaxyHaze();
  haze.userData.setDescriptors([{id:'domain-fixture',seed:'domain-fixture',morphology:'spiral',
    radius:55000,thickness:.1,arms:3,pitch:.33,bar:true,asymmetry:.37,orientation:[.2,.8,.1]}]);
  const shader=haze.children[0].material.fragmentShader;
  haze.userData.dispose();
  return shader;
}

test('galaxy vertical density is finite and north-south symmetric', () => {
  const shader=galaxyShader(),verticalExpression=expression(shader,'vertical'),diskExpression=expression(shader,'disk');
  for(const thickness of [.025,.1,.28]) for(const r of [0,.000001,.03,.2,.8]) {
    for(const height of [0,.000001,.01,.1,.5]) {
      const samples=[1,-1].map(sign=>{
        const values={p:{y:f(height*sign)},r:f(r),thickness:f(thickness)};
        const vertical=f(evaluate(verticalExpression,values));
        return evaluate(diskExpression,{...values,vertical});
      });
      assert.ok(samples.every(value=>Number.isFinite(value)&&value>=0&&value<=1));
      assert.equal(samples[0],samples[1]);
      const expected=Math.exp(-f(r)*2.8)*Math.exp(-.5*(f(height)/(f(thickness)*(.4+f(r))))**2);
      assert.ok(Math.abs(samples[0]-expected)<1e-7,'density agrees with the symmetric Gaussian');
    }
  }
});

test('galaxy arm axis returns finite light before the undefined atan phase', () => {
  const shader=galaxyShader();
  // Run the actual scalar prelude through theta. Stop before the vector-valued
  // Gaussian lobes: the axis must return before it asks atan(0,0) for a phase.
  const prelude=shader.match(/float armDensity\([^)]*\)\s*\{([\s\S]*?float theta=[^;]+;)/)?.[1];
  assert.ok(prelude);
  const atan=(y,x)=>y===0&&x===0 ? NaN : Math.atan2(y,x);
  const run=Function('p','width','arms','length','atan',prelude.replace(/\bfloat\b/g,'let')+'\nreturn theta;');
  for(const arms of [2,3,4,6]) for(const width of [.085,.12,.185]) {
    for(const p of [[0,0],[1e-12,0],[0,-1e-8]]) {
      const value=run({x:p[0],y:p[1]},width,arms,v=>Math.hypot(v.x,v.y),atan);
      assert.ok(Number.isFinite(value));
      assert.ok(Math.abs(value-width*arms/Math.sqrt(2*Math.PI))<1e-10,'axis uses the circumferential mean');
    }
    const theta=run({x:0,y:1e-4},width,arms,v=>Math.hypot(v.x,v.y),atan);
    assert.equal(theta,Math.PI/2,'resolved off-axis rays retain their angular phase');
  }
});
