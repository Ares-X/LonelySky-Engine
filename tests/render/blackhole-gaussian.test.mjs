import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createBlackHole} from '../../src/render/blackhole.js';

// Execute the owning shader's scalar transport code. The reference below is
// numerical quadrature, independent of its erf/chord implementation.
const fixture=createBlackHole({radius:1});
const source=fixture.children[0].material.fragmentShader;
fixture.userData.dispose();
function bracedBody(start){
  let cursor=source.indexOf('{',start),depth=1,begin=++cursor;
  assert.ok(begin>0);
  while(depth){const c=source[cursor++];if(c==='{')depth++;if(c==='}')depth--;assert.ok(cursor<=source.length);}
  return source.slice(begin,cursor-1);
}
const js=text=>text.replace(/\bfloat\b|\bbool\b|\bint\b/g,'let');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>a+(b-a)*t;
const smoothstep=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
const environment={smoothstep,abs:Math.abs,sign:Math.sign,exp:Math.exp,log:Math.log,sqrt:Math.sqrt,min:Math.min,max:Math.max,PI:Math.PI,clamp,mix};
function compile(args,body,extra={}){const values={...environment,...extra};return Function(...Object.keys(values),`return (${args})=>{${js(body)}}`)(...Object.values(values));}
const erf=compile('x',bracedBody(source.indexOf('float gaussianErf(')));
const inverse=compile('value',bracedBody(source.indexOf('float gaussianInverseErf(')),{gaussianErf:erf});
const fraction=compile('opticalFraction,height0,heightDelta,thickness,erfStart,erfEnd,nearFraction,farFraction,tangent',bracedBody(source.indexOf('float gaussianChordFraction(')),{gaussianInverseErf:inverse});
const profileStart=source.indexOf('    float opticalDepth = 0.0;');
const profileEnd=source.indexOf('    if (opticalDepth > 0.0)',profileStart);
const profileCode=source.slice(profileStart,profileEnd);
const profileFunction=compile('oldHeight,heightDelta,middleHeight,thickness,segmentLength,window',profileCode+'\nreturn {opticalDepth,nearFraction,farFraction,erfStart,erfEnd,tangent};',{gaussianErf:erf});
function profile({h0,h1,thickness=.06,length=.3,window=1}){
  return {...profileFunction(h0,h1-h0,(h0+h1)*.5,thickness,length,window),h0,dh:h1-h0,thickness,length,window};
}
const opacityExpression=source.match(/float opacity = ([^;]+);/)[1];
const opacity=compile('opticalDepth',`return opticalDepth>0 ? ${opacityExpression}:0;`);
const depthStart=source.indexOf('      if (firstDiskDistance < 0.0 && 1.0 - transmission');
const depthBody=bracedBody(depthStart);
const conditionStart=source.indexOf('(',depthStart),conditionEnd=source.indexOf('{',conditionStart);
const depthCondition=source.slice(conditionStart,conditionEnd).trim();
const encounter=compile('firstDiskDistance,transmission,opacity,opticalDepth,oldHeight,heightDelta,thickness,erfStart,erfEnd,nearFraction,farFraction,tangent,traveled,segmentLength',`if${depthCondition}{${depthBody}} return firstDiskDistance;`,{gaussianChordFraction:fraction});
function depth(p,{first=-1,transmission=1,traveled=0}={}){
  return encounter(first,transmission,opacity(p.opticalDepth),p.opticalDepth,p.h0,p.dh,p.thickness,p.erfStart,p.erfEnd,p.nearFraction,p.farFraction,p.tangent,traveled,p.length);
}
function reference(p){
  const count=32768;let sum=0;
  for(let i=0;i<count;i++){
    const h=p.h0+p.dh*(i+.5)/count;
    if(Math.abs(h)<2.5*p.thickness)sum+=Math.exp(-h*h/(p.thickness*p.thickness));
  }
  return sum/count*p.length*p.window/p.thickness*1.15;
}

test('finite Gaussian chords agree with positive numerical mass and reverse traversal',()=>{
  for(const [h0,h1] of [[-.3,.3],[-.13,.1],[.2,-.1],[-.14,-.08],[0,.04]]){
    const p=profile({h0,h1}),reverse=profile({h0:h1,h1:h0});
    assert.ok(p.opticalDepth>0&&Number.isFinite(p.opticalDepth));
    assert.ok(Math.abs(p.opticalDepth-reference(p))<2e-5);
    assert.ok(Math.abs(p.opticalDepth-reverse.opticalDepth)<1e-12);
    assert.ok(p.nearFraction>=0&&p.farFraction<=1&&p.nearFraction<p.farFraction);
  }
});

test('tangent, missed and endpoint-clipped chords remain finite without invented path length',()=>{
  const tangent=profile({h0:.03,h1:.03,length:.5});
  assert.equal(tangent.tangent,true);
  assert.ok(Math.abs(tangent.opticalDepth-.5/.06*1.15*Math.exp(-.25))<1e-12);
  for(const [h0,h1] of [[.16,.16],[.2,.3],[-.3,-.2]])assert.equal(profile({h0,h1}).opticalDepth,0);
  assert.equal(profile({h0:0,h1:0,window:0}).opticalDepth,0);
  const clipped=profile({h0:-.3,h1:0});
  assert.ok(clipped.nearFraction>0&&clipped.farFraction===1);
  assert.ok(Math.abs(clipped.opticalDepth-reference(clipped))<2e-5);
  const shorter=profile({h0:.03,h1:.03,length:.25});
  assert.ok(Math.abs(shorter.opticalDepth*2-tangent.opticalDepth)<1e-12);
});

test('positive absorbed-mass source nodes stay inside their finite chords and conserve constant emission',()=>{
  for(const [h0,h1] of [[-.3,.3],[.2,-.1],[0,0],[.149,.149]]){
    const p=profile({h0,h1,length:.65}),alpha=opacity(p.opticalDepth);let previous=-1;
    for(const u of [.211324865405187,.788675134594813]){
      const q=-Math.log(1-u*alpha)/p.opticalDepth;
      const s=fraction(q,p.h0,p.dh,p.thickness,p.erfStart,p.erfEnd,p.nearFraction,p.farFraction,p.tangent);
      assert.ok(Number.isFinite(s)&&s>=p.nearFraction&&s<=p.farFraction&&s>previous);previous=s;
    }
    for(const c of [0,.4,1.6])assert.ok(Math.abs(alpha*.5*(c+c)+(1-alpha)*c-c)<1e-15);
  }
  for(const tau of [0,1e-9,.1,1,20,100]){
    const alpha=opacity(tau);assert.ok(Number.isFinite(alpha)&&alpha>=0&&alpha<=1);
    assert.ok(1-alpha>=0);assert.ok(Math.abs(alpha+(1-alpha)-1)<1e-15);
  }
});

test('cumulative 8 percent encounter is stable when individually faint segments are split',()=>{
  const extinction=1.15/.06,length=-Math.log(.95)/extinction;
  const piece=profile({h0:0,h1:0,length});
  assert.ok(opacity(piece.opticalDepth)<.08);
  assert.equal(depth(piece),-1);
  const split=depth(piece,{transmission:.95,traveled:length});
  const combined=depth(profile({h0:0,h1:0,length:length*2}));
  assert.ok(split>length&&split<length*2);
  assert.ok(Math.abs(split-(-Math.log(.92)/extinction))<1e-12);
  assert.ok(Math.abs(split-combined)<1e-12);
  assert.equal(depth(piece,{first:split,transmission:.5,traveled:10}),split,'a later chord cannot replace the first positive encounter');
});

test('Gaussian inversion remains finite at both clipped endpoints and across its near-zero seed',()=>{
  for(const v of [-erf(2.5),-.99,-.011,-.009,-1e-8,0,1e-8,.009,.011,.99,erf(2.5)]){
    const x=inverse(v);assert.ok(Number.isFinite(x));assert.ok(Math.abs(erf(x)-v)<1e-6);
  }
});

test('phase filtering is bounded and monotone while unresolved symmetric material returns to its mean',()=>{
  const band=compile('phaseFootprint',bracedBody(source.indexOf('float diskBandWeight(')));
  const contrast=compile('value',bracedBody(source.indexOf('float diskLaneContrast(')));
  assert.equal(band(0),1);assert.equal(band(100),0);
  let previous=1;
  for(let i=0;i<=400;i++){
    const retention=band(i/100);
    assert.ok(Number.isFinite(retention)&&retention>=0&&retention<=previous);previous=retention;
  }
  for(let i=0;i<=100;i++){
    const value=i/100,signal=contrast(value);
    assert.ok(Number.isFinite(signal)&&Math.abs(signal)<=1);
    assert.ok(Math.abs(signal+contrast(1-value))<1e-14);
    assert.ok(signal*band(100)===0,'a fully unresolved source contributes no contrast');
  }
});

test('black hole retains bounded quality steps, tone behavior and owned-resource disposal',()=>{
  const hole=createBlackHole(),mesh=hole.children[0],uniforms=mesh.material.uniforms,counts={geometry:0,material:0};
  mesh.geometry.addEventListener('dispose',()=>counts.geometry++);mesh.material.addEventListener('dispose',()=>counts.material++);
  const camera=new THREE.PerspectiveCamera(65,1.6,.1,50000),storage=uniforms.uCamera.value;camera.position.set(8,3,16);
  try{
    for(const [quality,steps,scale] of [['low',72,.12],['auto',120,.075],['high',144,.06]]){
      hole.userData.update(camera,0,{quality});assert.equal(hole.userData.stats.steps,steps);assert.equal(uniforms.uStepScale.value,scale);
    }
    assert.equal(uniforms.uCamera.value,storage);assert.equal(mesh.material.toneMapped,true);assert.equal(mesh.material.depthWrite,true);
  }finally{hole.userData.dispose();hole.userData.dispose();}
  assert.deepEqual(counts,{geometry:1,material:1});
});
