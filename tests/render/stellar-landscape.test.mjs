import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createDeepSky,deepSkyUniforms,setDeepSkyEnvironment,DEEP_SKY_GLSL} from '../../src/render/deep-sky.js';
import {createBlackHole} from '../../src/render/blackhole.js';

const environment={ambientTint:[.3,.4,.5],bandNormal:[0,1,0],skyBrightness:.02,bandStrength:.3,starDensity:.4};
const sea=()=>({weights:[0,0,0,1,0,0,0],frame:new THREE.Matrix3().toArray(),phase:.4,width:1});
function component(i) {
  return {frame:new THREE.Matrix3().set(Math.cos(i),0,Math.sin(i),0,1,0,-Math.sin(i),0,Math.cos(i)).toArray(),
    offset:[i,-i,3+i],shape:[.2+i*.3,.1+i*.15,i*.2,.08],topology:[i*.1,.4,i*.2,.1],
    contour:[i*.15,2+i,-i*.1,.5],material:[.3,.4,.5,i===0?0:1],
    light:[i===3?0:.1+i*.05,i*.3,i*.2,-i*.1],spectrum:[2+i,20+i,120+i,.7+i*.2],population:[.1,.2,.3,.4],cool:[.1+i*.1,.3,.5],warm:[.6,.4,.2+i*.1]};
}
const snapshot=value=>Object.fromEntries(Object.entries(value).map(([key,field])=>[key,field.toArray()]));

test('four ordered independent fields reach sky and lens with copied local transforms, light and absorption',()=>{
  const sky=createDeepSky(),hole=createBlackHole();
  const components=Array.from({length:4},(_,i)=>component(i));
  const descriptor={...sea(),landscape:{revision:1,components}};
  try {
    sky.userData.update({...environment,starSea:descriptor},.5);
    hole.userData.setEnvironment({...environment,starSea:descriptor},.5);
    const views=[sky,hole].map(view=>view.children[0].material.uniforms);
    for(const uniforms of views) {
      assert.equal(uniforms.uSeaHasLandscape.value,true);
      assert.equal(uniforms.uSeaQuiet.value,.925);
      assert.deepEqual(uniforms.uSeaComponents.value.map(snapshot),components);
      assert.equal(uniforms.uSeaComponents.value[0].material.w,0,'emission without absorption is retained');
      assert.equal(uniforms.uSeaComponents.value[3].light.x,0,'foreground absorption without emission is retained');
    }
    assert.notEqual(views[0].uSeaComponents.value,views[1].uSeaComponents.value);
    for(let i=0;i<4;i++) for(const key of Object.keys(components[i])) {
      assert.notEqual(views[0].uSeaComponents.value[i][key],views[1].uSeaComponents.value[i][key]);
      assert.notEqual(views[0].uSeaComponents.value[i][key],views[0].uSeaComponents.value[(i+1)%4][key]);
    }
    components[0].frame.fill(0);components[0].cool.fill(0);components.reverse();
    for(const uniforms of views)assert.deepEqual(snapshot(uniforms.uSeaComponents.value[0]),component(0));
  } finally {sky.userData.dispose();hole.userData.dispose();}
});

test('landscape removal clears every slot and restores published profile and legacy paths',()=>{
  const uniforms=deepSkyUniforms(),defaults=deepSkyUniforms();
  const appearance={morphologyWeights:Array.from({length:18},(_,i)=>i===13?1:0),cool:[.2,.4,.6]};
  const descriptor={...sea(),appearance,landscape:{revision:1,components:Array.from({length:4},(_,i)=>component(i))}};
  setDeepSkyEnvironment(uniforms,{...environment,starSea:descriptor});
  assert.equal(uniforms.uSeaHasLandscape.value,true);
  assert.equal(uniforms.uSeaMorphE.value.y,1,'published appearance is retained independently of the active path');
  delete descriptor.landscape;
  setDeepSkyEnvironment(uniforms,{...environment,starSea:descriptor});
  assert.equal(uniforms.uSeaHasLandscape.value,false);
  assert.equal(uniforms.uSeaMorphE.value.y,1);
  assert.deepEqual(uniforms.uSeaCool.value.toArray(),appearance.cool);
  assert.deepEqual(uniforms.uSeaComponents.value.map(snapshot),defaults.uSeaComponents.value.map(snapshot));
  delete descriptor.appearance;
  setDeepSkyEnvironment(uniforms,{...environment,starSea:descriptor});
  assert.deepEqual(uniforms.uSeaMorphB.value.toArray(),[1,0,0]);
  assert.deepEqual(uniforms.uSeaCool.value.toArray(),defaults.uSeaCool.value.toArray());
  setDeepSkyEnvironment(uniforms,{...environment,starSea:{...descriptor,landscape:{revision:1,components:[component(0)]}}});
  assert.equal(uniforms.uSeaHasLandscape.value,false,'incomplete slot sets cannot leave stale foregrounds active');
  setDeepSkyEnvironment(uniforms,environment);
  assert.equal(uniforms.uSeaHasLandscape.value,false);
  assert.deepEqual(uniforms.uSeaComponents.value.map(snapshot),defaults.uSeaComponents.value.map(snapshot));
  assert.deepEqual(uniforms.uSeaMorphB.value.toArray(),[0,0,0]);
});

test('component axis, fractional crest and zero-width filtering remain in finite scalar domains',()=>{
  const source=DEEP_SKY_GLSL.slice(DEEP_SKY_GLSL.indexOf('vec4 seaComponent('),DEEP_SKY_GLSL.indexOf('vec3 stellarLandscape('));
  const expression=name=>{const match=source.match(new RegExp(`float ${name}=([^;]+);`));assert.ok(match);return match[1];};
  const run=(name,values)=>Function(...Object.keys(values),`return (${expression(name)});`)(...Object.values(values));
  const safeAtan=(y,x)=>y===0&&x===0?NaN:Math.atan2(y,x);
  for(const coordinate of [0,1e-12,1e-6,.1]) {
    const theta=run('theta',{radius2:coordinate*coordinate,p:{x:0,y:coordinate},atan:safeAtan});
    assert.ok(Number.isFinite(theta));
    const winding=run('winding',{radius:coordinate,middle:.5,middleResolution:1,log:Math.log,max:Math.max,abs:Math.abs,component:{contour:{y:8},material:{x:.7},offset:{z:-10}}});
    const phase=run('phase',{theta,arms:6,winding});
    assert.ok(Number.isFinite(phase));
  }
  for(const ridge of [0,.5,1]) for(const cosine of [-1-2**-22,-1,0,1,1+2**-22]) {
    const crest=run('crest',{ridge,phase:0,cos:()=>cosine,pow:(base,power)=>base<0?NaN:Math.pow(base,power),max:Math.max});
    assert.ok(Number.isFinite(crest)&&crest>=0);
  }
  for(const rimWidth of [0,.00001,.1]) for(const footprint of [.0001,.1,10]) {
    const width=run('filteredWidth',{boundaryWidth:rimWidth,footprint,sqrt:Math.sqrt});
    assert.ok(Number.isFinite(width)&&width>0);
  }
  for(const density of [0,1,10000]) for(const opacity of [-1,0,1,10000]) {
    const depth=run('opticalDepth',{density,dustStructure:3,component:{material:{w:opacity}},min:Math.min,max:Math.max});
    assert.ok(Number.isFinite(depth)&&depth>=0);
  }
});


test('continuous arm counts mix periodic integer kernels across the angular seam',()=>{
  const source=DEEP_SKY_GLSL.slice(DEEP_SKY_GLSL.indexOf('vec4 seaComponent('),DEEP_SKY_GLSL.indexOf('vec3 stellarLandscape('));
  const expression=name=>source.match(new RegExp(`float ${name}=([^;]+);`))[1];
  const run=(name,values)=>Function(...Object.keys(values),`return (${expression(name)});`)(...Object.values(values));
  for(const armNumber of [2,2.01,2.5,2.99,3,3.5,4,4.9,5,5.5,6]) {
    const arms=run('arms',{armNumber,floor:Math.floor});
    const nextArms=run('nextArms',{arms,min:Math.min});
    assert.ok(Number.isInteger(arms)&&Number.isInteger(nextArms));
    const kernel=theta=>{
      const phase=run('phase',{theta,arms,winding:2.7});
      const values={phase,theta,nextArms,winding:2.7,ridge:.7,pow:Math.pow,cos:Math.cos,max:Math.max};
      const a=run('crest',values),b=run('nextCrest',values),t=armNumber-Math.floor(armNumber);
      return a*(1-t)+b*t;
    };
    assert.ok(Math.abs(kernel(-Math.PI)-kernel(Math.PI))<1e-12);
    assert.ok(Number.isFinite(kernel(0)));
  }
});

test('unresolved density-coupled stellar points retain finite mean light and vanish at zero density',()=>{
  const source=DEEP_SKY_GLSL.slice(DEEP_SKY_GLSL.indexOf('float seaStellarPoints('),DEEP_SKY_GLSL.indexOf('// Four independent directional fields.'));
  const expression=name=>source.match(new RegExp(`float ${name}=([^;]+);`))[1];
  const run=(name,values)=>Function(...Object.keys(values),`return (${expression(name)});`)(...Object.values(values));
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const smoothstep=(a,b,n)=>{const t=clamp((n-a)/(b-a),0,1);return t*t*(3-2*t);};
  const light=[];
  for(const density of [0,.01,.1,1,3,100]) {
    const probability=run('probability',{density,clamp});
    const mean=run('filtered',{probability});
    const resolved=run('resolved',{pointFootprint:2,smoothstep});
    assert.equal(resolved,0);
    assert.ok(Number.isFinite(mean)&&mean>=0);
    if(density===0)assert.equal(mean,0);
    light.push(mean);
  }
  assert.deepEqual(light,[...light].sort((a,b)=>a-b));
});


test('stellar point footprints broaden finite kernels while conserving their two-dimensional integral',()=>{
  const source=DEEP_SKY_GLSL.slice(DEEP_SKY_GLSL.indexOf('float seaStellarPoints('),DEEP_SKY_GLSL.indexOf('// Four independent directional fields.'));
  const expression=name=>source.match(new RegExp(`float ${name}=([^;]+);`))[1];
  const run=(name,values)=>Function(...Object.keys(values),`return (${expression(name)});`)(...Object.values(values));
  const integral=Math.PI*.065**2;
  let previous=Infinity;
  for(const pointFootprint of [0,.01,.1,.3,.6,1,10]) {
    const variance=run('variance',{pointFootprint});
    const peak=run('spark',{variance,point:0,dot:()=>0,exp:Math.exp,pow:Math.pow});
    assert.ok(Number.isFinite(peak)&&peak>=0&&peak<=previous);
    assert.ok(Math.abs(peak*Math.PI*variance-integral)<1e-12);
    previous=peak;
  }
});


test('continuous density populations have different frequency responses and finite positive light',()=>{
  const body=DEEP_SKY_GLSL.match(/vec4 seaPopulations\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  const evaluate=Function('broad','middle','fine','clump','exp','max','seaSquare','smoothstep','vec4',body.replace(/\bfloat\b/g,'let'));
  const smoothstep=(a,b,n)=>{const t=Math.max(0,Math.min(1,(n-a)/(b-a)));return t*t*(3-2*t);};
  const run=(b,m,f)=>evaluate(b,m,f,.8,Math.exp,Math.max,x=>x*x,smoothstep,(...v)=>v);
  const center=run(.6,.5,.5),gap=run(.6,.15,.5),peak=run(.9,.9,.5);
  assert.equal(center[0],gap[0],'mist ignores middle-frequency fibers');
  assert.ok(run(.6,.8,.5)[2]>gap[2]*3,'filaments emphasize anisotropic middle-scale condensations');
  assert.ok(peak[3]>center[3]*5,'stellar associations concentrate into selected coarse/middle peaks');
  assert.ok(peak[1]>gap[1],'clouds retain large-scale density variation');
  for(const b of [0,.2,.5,.8,1])for(const m of [0,.2,.5,.8,1])for(const f of [0,.5,1])
    assert.ok(run(b,m,f).every(n=>Number.isFinite(n)&&n>=0));
});

test('stream widths retain an angular floor and remain filtered across narrow descriptor scales',()=>{
  const source=DEEP_SKY_GLSL.slice(DEEP_SKY_GLSL.indexOf('vec4 seaComponent('),DEEP_SKY_GLSL.indexOf('vec3 stellarLandscape('));
  const expression=name=>source.match(new RegExp(`float ${name}=([^;]+);`))[1];
  const run=(name,values)=>Function(...Object.keys(values),`return (${expression(name)});`)(...Object.values(values));
  for(const scale of [.001,.01,.025,.05,.1,.5,1]) for(const ridge of [0,.5,1]) for(const rimWidth of [0,.01,.1]) {
    const minimumStreamWidth=run('minimumStreamWidth',{component:{shape:{y:scale}},max:Math.max,abs:Math.abs});
    const streamWidth=run('streamWidth',{minimumStreamWidth,rimWidth,ridge,middle:.1,max:Math.max});
    assert.ok(streamWidth*Math.max(.01,scale)>=.006-1e-12);
    for(const crossFootprint of [.0001,.01,.1,1]) {
      const filtered=run('filteredStream',{streamWidth,crossFootprint,sqrt:Math.sqrt});
      assert.ok(Number.isFinite(filtered)&&filtered>=streamWidth&&filtered>=crossFootprint);
    }
  }
});


test('older landscape descriptors receive defined population defaults without aliasing them',()=>{
  const uniforms=deepSkyUniforms(),components=Array.from({length:4},(_,i)=>component(i));
  for(const value of components){delete value.spectrum;delete value.population;}
  setDeepSkyEnvironment(uniforms,{...environment,starSea:{...sea(),landscape:{revision:1,components}}});
  for(const value of uniforms.uSeaComponents.value){
    assert.deepEqual(value.spectrum.toArray(),[4,27,160,1]);
    assert.deepEqual(value.population.toArray(),[0,1,0,0]);
  }
  uniforms.uSeaComponents.value[0].population.set(1,0,0,0);
  assert.deepEqual(uniforms.uSeaComponents.value[1].population.toArray(),[0,1,0,0]);
});


test('uniform cloud slabs agree with independent depth quadrature and stay monotonic as density rises',()=>{
 const body=DEEP_SKY_GLSL.match(/float seaSlabIntegral\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
 const integral=Function('opticalDepth','transmission',body);
 const quadrature=tau=>{const n=10000,h=1/n;let sum=0;for(let i=0;i<n;i++)sum+=Math.exp(-tau*(i+.5)*h);return sum*h;};
 for(const tau of [0,1e-8,1e-5,.0005,.001,.01,.1,1,2,5,10,40,80]){
  const actual=integral(tau,Math.exp(-Math.min(40,tau))),expected=quadrature(tau);
  assert.ok(Number.isFinite(actual)&&actual>=0);
  assert.ok(Math.abs(actual-expected)<4e-8,`${tau}: analytic slab agrees with depth samples`);
 }
 for(const extinction of [0,.1,1,5]){
  let previous=-1;
  for(const rho of [0,1e-8,.0001,.01,.1,.5,1,2,4,8,16,40,80,256]){
   const tau=rho*extinction,value=rho*integral(tau,Math.exp(-Math.min(40,tau)));
   assert.ok(value>=previous-1e-12,'distributed emission saturates rather than darkening at high density');previous=value;
  }
 }
 assert.ok(16*Math.exp(-16*.5)<2*Math.exp(-2*.5),'the old midpoint source falsely darkened above its maximum');
});
