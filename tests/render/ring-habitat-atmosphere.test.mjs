import test from 'node:test';
import assert from 'node:assert/strict';
import {HABITAT_PROCEDURAL_DENSITY_SCALE,HABITAT_PROCEDURAL_CHANNEL_MEANS,HABITAT_PROCEDURAL_WEATHER_MEANS,RING_HABITAT_AIR_GLSL,RING_HABITAT_ATMOSPHERE_GLSL} from '../../src/render/ring-habitat-atmosphere.js';
import {COSMIC_WORLD_SCENE_DEPTH_GLSL} from '../../src/render/cosmic-scene-depth.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;

test('only a measured finite opaque depth can replace the primary physical intersection',()=>{
  const expression=RING_HABITAT_ATMOSPHERE_GLSL.match(/bool clipToBody=([^;]+);/)?.[1];
  const marker=Number(COSMIC_WORLD_SCENE_DEPTH_GLSL.match(/COSMIC_SCENE_DEPTH_UNBOUNDED=([^;]+);/)?.[1]);
  assert.ok(expression);assert.ok(Number.isFinite(marker));
  const requiresBody=Function('uHasSceneDepth','uVisibility','maximum','uBodyRadius','COSMIC_SCENE_DEPTH_UNBOUNDED',`return ${expression};`);
  for(const radius of [100,830383,1e8]){
    for(const distance of [.5,1e4,1e10]){
      assert.equal(requiresBody(1,1,distance/radius,radius,marker),false,'a closer measured opaque hit already bounds this ray');
      assert.equal(requiresBody(0,1,distance/radius,radius,marker),true,'direct rendering has no current snapshot');
      assert.equal(requiresBody(1,.5,distance/radius,radius,marker),true,'partial bodies do not own opaque depth');
    }
    assert.equal(requiresBody(1,1,marker/radius,radius,marker),true,'background or saturated compressed depth cannot prove that no solid exists');
  }
});

// Run the shader's actual scalar optical kernels. This checks finite numeric
// contracts and compositing, without claiming native GLSL/GPU acceptance.
const scalarKernels=new Map();
function kernel(name){
  if(scalarKernels.has(name))return scalarKernels.get(name);
  const match=RING_HABITAT_AIR_GLSL.match(new RegExp(`(?:float|vec4) ${name}\\(([^)]*)\\)\\{([^}]+)\\}`));
  assert.ok(match,name);
  const parameters=match[1].split(',').map(x=>x.trim().split(/\s+/).at(-1));
  const scope={min:Math.min,max:Math.max,exp:Math.exp,pow:Math.pow,sqrt:Math.sqrt,fract:x=>x-Math.floor(x),vec4:(...values)=>values,clamp,smoothstep,mix};
  for(const dependency of match[2].matchAll(/\b(habitat\w+)\(/g))scope[dependency[1]]=kernel(dependency[1]);
  const run=Function(...Object.keys(scope),`return function(${parameters.join(',')}){${match[2].replace(/\b(?:float|vec4)\s+(\w+)/g,'let $1')}}`)(...Object.values(scope));
  scalarKernels.set(name,run);
  return run;
}

function pixelPhaseKernel(){
  // Execute the actual GLSL integer hash with uint32 multiplication/shift
  // semantics, then the actual 24-bit phase conversion. JS doubles cannot
  // substitute ordinary multiplication for the shader's wrapping uints.
  const hashSource=RING_HABITAT_AIR_GLSL.match(/uint habitatCloudSampleHash\(uint value\)\{([^}]+)\}/)?.[1];
  assert.ok(hashSource);
  const hash=Function('value',hashSource
    .replace(/value\^=value>>(\d+);/g,'value=(value^(value>>>$1))>>>0;')
    .replace(/value\*=(0x[\da-f]+)u;/g,'value=Math.imul(value,$1)>>>0;'));
  const phaseSource=RING_HABITAT_AIR_GLSL.match(/float habitatCloudPixelPhase\([^)]*\)\{([^}]+)\}/)?.[1];
  assert.ok(phaseSource);
  const phase=phaseSource
    .replace(/uint seed=([^;]+);/,(_,expression)=>`let seed=(${expression.replace(/uint\(([^)]+)\)\*(\d+)u/g,'Math.imul(Math.trunc($1),$2)')})>>>0;`)
    .replace('float(habitatCloudSampleHash(seed)>>8)','(habitatCloudSampleHash(seed)>>>8)');
  return Function('habitatCloudSampleHash',`return function(pixelX,pixelY,stratum,sampleIndex=0){${phase}}`)(hash);
}

function rayCellKernel(){
  const source=RING_HABITAT_AIR_GLSL.match(/bool habitatRayCell\([^)]*\)\{([^}]+)\}/)?.[1];
  assert.ok(source);
  // GLSL integer division chooses the radial segment. Keep that semantics
  // while executing the actual cell boundaries and branch decisions.
  const body=source.replace(/\bfloat\(([^)]+)\)/g,'($1)')
    .replace(/\b(?:float|int|vec2)\b/g,'let')
    .replace('segment=index/samples','segment=Math.floor(index/samples)')
    .replaceAll('return false;','return null;').replaceAll('return true;','return [lo,hi];');
  const run=Function('habitatCellBoundary',`return function(intervals,count,budget,index){let lo,hi;${body}}`)(kernel('habitatCellBoundary'));
  return (intervals,budget,index)=>run({xy:{x:intervals[0]?.[0]??0,y:intervals[0]?.[1]??0},zw:{x:intervals[1]?.[0]??0,y:intervals[1]?.[1]??0}},intervals.length,budget,index);
}

function condensationKernel(){
  // Execute the final density branch with known procedural condensate and
  // weather inputs. Geometry and weather sampling precede it.
  const start=RING_HABITAT_AIR_GLSL.indexOf('  float local=0.;');
  const end=RING_HABITAT_AIR_GLSL.indexOf('\n}\nfloat habitatCellBoundary',start);
  assert.ok(start>=0&&end>start);
  const source=RING_HABITAT_AIR_GLSL.slice(start,end)
    .replace(/vec3 body=[^;]+;/,'')
    .replace('habitatCloudBillows(body,footprint)','inputChannels')
    .replace(/\b(?:float|vec2|vec4)\s+(\w+)/g,'let $1');
  const means=RING_HABITAT_AIR_GLSL.match(/const vec4 HABITAT_HEIGHT_CHANNEL_MEANS=vec4\(([^)]+)\);/)?.[1].split(',').map(Number);
  const pairs=RING_HABITAT_AIR_GLSL.match(/const vec2 HABITAT_HEIGHT_WEATHER\[4\]=vec2\[4\]\(([^;]+)\);/)?.[1];
  assert.ok(pairs);
  const weather=[...pairs.matchAll(/vec2\(([^)]+)\)/g)].map(m=>m[1].split(',').map(Number));
  assert.deepEqual(means,Array.from(HABITAT_PROCEDURAL_CHANNEL_MEANS));assert.deepEqual(weather,HABITAT_PROCEDURAL_WEATHER_MEANS.map(p=>Array.from(p)));
  const execute=Function('lo','hi','height','weather','envelope','weatherFilter','uHabitatClimate','inputChannels','HABITAT_DENSITY_SCALE','HABITAT_HEIGHT_CHANNEL_MEANS','HABITAT_HEIGHT_WEATHER','habitatHeightWeights','vec4','mix','dot','edge',source);
  const dot=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);
  const weatherPairs=weather.map(([x,y])=>({x,y}));
  return (envelope,weather,footprint,climate,channels,lo=.8,hi=lo,height=1,edge=1)=>execute(lo,hi,height,weather,envelope,smoothstep(.3,1.1,footprint/6500),climate,channels,HABITAT_PROCEDURAL_DENSITY_SCALE,means,weatherPairs,kernel('habitatHeightWeights'),v=>[v,v,v,v],mix,dot,edge);
}

// Point density is the authority. Independent numerical quadrature below
// integrates it without duplicating the shader's analytic primitive.
function referenceHeightWeights(z){return [1,2,3,4].map(k=>kernel('habitatHeightWeight')(z,k));}

function shaderInteger(name){
  const match=RING_HABITAT_AIR_GLSL.match(new RegExp(`const int ${name}=(\\d+);`));
  assert.ok(match,name);
  return Number(match[1]);
}

function actualCellBudget(intervals){
  const match=RING_HABITAT_ATMOSPHERE_GLSL.match(/habitatOpticalColumn\(origin,unitRay,minimum,maximum,clipToBody,0\.,uHabitatSampleIndex,\s*([A-Z_]+),([A-Z_]+),/);
  assert.ok(match,intervals);
  return shaderInteger(match[intervals==='intervals'?1:2]);
}

function densityShortcut(){
  const expression=RING_HABITAT_AIR_GLSL.match(/if\((envelope[^\n]*?)\)return 0\.;/)?.[1];
  assert.ok(expression);
  const run=Function('envelope','weatherFilter','rayFootprint',`return ${expression};`);
  return (envelope,footprint,rayFootprint)=>run(envelope,smoothstep(.3,1.1,footprint/6500),rayFootprint);
}

function replaceBlock(source,marker,replacement){
  const start=source.indexOf(marker);assert.ok(start>=0,marker);
  const open=source.indexOf('{',start);let end=open+1,depth=1;
  for(;depth;end++){
    if(source[end]==='{')depth++;
    else if(source[end]==='}')depth--;
  }
  return source.slice(0,start)+replacement+source.slice(end);
}

function functionBody(name){
  const start=RING_HABITAT_AIR_GLSL.indexOf(` ${name}(`);assert.ok(start>=0,name);
  const open=RING_HABITAT_AIR_GLSL.indexOf('{',start);let end=open+1,depth=1;
  for(;depth;end++){
    if(RING_HABITAT_AIR_GLSL[end]==='{')depth++;
    else if(RING_HABITAT_AIR_GLSL[end]==='}')depth--;
  }
  return RING_HABITAT_AIR_GLSL.slice(open+1,end-1);
}

test('cloud axial and broken-arc boundaries stay empty with a smooth interior feather',()=>{
  const body=functionBody('habitatAirEdge').replace(/\bfloat\s+(\w+)/g,'let $1');
  const edge=Function('point','shell','gap','height','smoothstep','abs','atan','sin','cos',body);
  const expression=functionBody('habitatCloudDensity').match(/float edge=habitatAirEdge\(point,shell,gap,([^;]+)\);/)?.[1];
  assert.ok(expression);
  const cloudHeight=Function('height',`return ${expression};`);
  const shell={x:.9,y:1,z:-.1,w:.1},gap={x:0,y:.2,z:1,w:0},height=.005;
  const at=(y,a,cloud=true)=>edge({x:Math.cos(a),y,z:Math.sin(a)},shell,gap,cloud?cloudHeight(height):height,
    smoothstep,Math.abs,Math.atan2,Math.sin,Math.cos);
  for(const y of [-.11,-.1,.1,.11])assert.equal(at(y,1),0);
  for(const a of [-.19,0,.19])assert.equal(at(0,a),0);
  for(const upper of [false,true]){
    const atDistance=d=>at(upper?shell.w-d:shell.z+d,1),h=1e-5;
    assert.ok(atDistance(h)>0&&atDistance(h/4)/h*4<atDistance(h)/h*.4,'axial derivative tends to zero');
    assert.ok(atDistance(height*.5)<at(upper?shell.w-height*.5:shell.z+height*.5,1,false),'cloud opacity fades before the narrow air edge');
  }
  const h=1e-5;
  assert.ok(at(0,gap.y+h)>0&&at(0,gap.y+h/4)*4<at(0,gap.y+h)*.4,'gap derivative also tends to zero');
  assert.equal(at(0,1),1,'the feather leaves the central volume intact');
  // Sweep both sides of a rotated break, including the wrapped azimuth seam.
  gap.x=Math.PI-.12;gap.z=Math.cos(gap.x);gap.w=Math.sin(gap.x);
  for(const halfAngle of [.2,.74,.76,1.8,3.])for(let i=0;i<=720;i++){
    gap.y=halfAngle;
    const a=-Math.PI+i*Math.PI/360;
    const distance=Math.abs(Math.atan2(Math.sin(a-gap.x),Math.cos(a-gap.x)));
    assert.ok(Math.abs(at(0,a)-smoothstep(halfAngle,halfAngle+2*height,distance))<1e-12);
  }
});

function opticalStreamRule(){
  const start=RING_HABITAT_AIR_GLSL.indexOf('  int airIndex=0,cloudIndex=0;');
  const end=RING_HABITAT_AIR_GLSL.indexOf('  alpha=1.-transmittance;',start);
  assert.ok(start>=0&&end>start);
  let source=RING_HABITAT_AIR_GLSL.slice(start,end);
  source=replaceBlock(source,'if(inAir&&!airLoaded)',
    'if(inAir&&!airLoaded){airExtinction=airSigma;airSource=.2;airLoaded=true;}');
  source=replaceBlock(source,'if(inCloud&&!cloudLoaded)',
    'if(inCloud&&!cloudLoaded){cloudExtinction=cloudSigma;cloudSource=.8;cloudLoaded=true;}');
  const blend=RING_HABITAT_AIR_GLSL.match(/void habitatAirBlend\([^)]*\)\{([^}]+)\}/)?.[1];
  assert.ok(blend);
  source=source
    .replaceAll('bool hasAir=habitatRayCell(intervals,intervalCount,airCells,airIndex,airLo,airHi)',
      '[hasAir,airLo,airHi]=cell(intervals,airCells,airIndex)')
    .replaceAll('hasAir=habitatRayCell(intervals,intervalCount,airCells,airIndex,airLo,airHi)',
      '[hasAir,airLo,airHi]=cell(intervals,airCells,airIndex)')
    .replaceAll('bool hasCloud=habitatRayCell(cloudIntervals,cloudCount,cloudCells,cloudIndex,cloudLo,cloudHi)',
      '[hasCloud,cloudLo,cloudHi]=cell(cloudIntervals,cloudCells,cloudIndex)')
    .replaceAll('hasCloud=habitatRayCell(cloudIntervals,cloudCount,cloudCells,cloudIndex,cloudLo,cloudHi)',
      '[hasCloud,cloudLo,cloudHi]=cell(cloudIntervals,cloudCells,cloudIndex)')
    .replaceAll('vec3(0.)','0.')
    .replace('habitatAirBlend(source,opacity,radiance,transmittance);',`{${blend}}`)
    .replace(/\b(?:float|bool|int|vec3)\b/g,'let')
    .replaceAll('HABITAT_MERGE_EVENTS',String(shaderInteger('HABITAT_MERGE_EVENTS')));
  const execute=Function('intervals','cloudIntervals','airCells','cloudCells','airSigma','cloudSigma','minimum','cell','min','max','habitatOpticalOpacity','habitatSegmentMeanDistance',
    'let hasAir,hasCloud,distance;'+source+'return {radiance,transmittance,hasAir,hasCloud,entry,allMoment,allWeight,cloudMoment,cloudWeight};');
  const actualCell=rayCellKernel();
  const cell=(spans,budget,index)=>{const value=actualCell(spans,budget,index);return value?[true,...value]:[false,1e25,1e25];};
  return (air,cloud)=>execute(air,cloud,actualCellBudget('intervals'),actualCellBudget('cloudIntervals'),.2,.5,0,cell,Math.min,Math.max,kernel('habitatOpticalOpacity'),kernel('habitatSegmentMeanDistance'));
}

function orderedCloudCellRule(){
  const marker=RING_HABITAT_AIR_GLSL.indexOf('if(inCloud&&!cloudLoaded)');
  assert.ok(marker>=0);
  const open=RING_HABITAT_AIR_GLSL.indexOf('{',marker);let end=open+1,depth=1;
  for(;depth;end++){
    if(RING_HABITAT_AIR_GLSL[end]==='{')depth++;
    else if(RING_HABITAT_AIR_GLSL[end]==='}')depth--;
  }
  const blend=RING_HABITAT_AIR_GLSL.match(/void habitatAirBlend\([^)]*\)\{([^}]+)\}/)?.[1];
  assert.ok(blend);
  // Execute the uploaded cell loop, its sample positions, extinction, opacity
  // and inout blend algebra. Only density/source queries become scalar test
  // fields (equivalent RGB channels), isolating transport from cloud authoring.
  const source=RING_HABITAT_AIR_GLSL.slice(open+1,end-1)
    .replace('vec3 p=origin+unitRay*t;','float p=t;')
    .replace(/habitatCloudDensity\([^;]+\)/,'densityAt(p)')
    .replace(/habitatCloudSource\([^;]+\)/,'sourceAt(p)')
    .replace('habitatAirBlend(sampleSource,habitatOpticalOpacity(extinction,(cloudHi-cloudLo)*.5),cloudSource,cellT);',
      '{float source=sampleSource,opacity=habitatOpticalOpacity(extinction,(cloudHi-cloudLo)*.5);'+blend.replaceAll('radiance','cloudSource').replaceAll('transmittance','cellT')+'}')
    .replaceAll('vec3(0.)','0.')
    .replace(/\bfloat\(([^)]+)\)/g,'($1)')
    .replace(/\b(?:float|int|vec3)\b/g,'let');
  const run=Function('cloudLo','cloudHi','densityAt','sourceAt','habitatCloudIntegrationPoint','habitatCloudExtinction','habitatOpticalOpacity','max',
    'let cloudExtinction,cloudSource,cloudLoaded=false;const cloudIndex=0,cloudPhase=[.123,.456],samplingIndex=-1,originFootprint=0,uPixelAngle=0,uBodyRadius=1,height=1;'+source+'return {extinction:cloudExtinction,source:cloudSource};');
  return (length,densityAt,sourceAt)=>run(0,length,densityAt,sourceAt,kernel('habitatCloudIntegrationPoint'),kernel('habitatCloudExtinction'),kernel('habitatOpticalOpacity'),Math.max);
}

test('inner habitat air thickness stays within the finite axial ecology band',()=>{
  const thickness=kernel('habitatAirThickness');
  for(const width of [.00001,.001,.01,.02,.05,1]){
    const height=thickness(width);
    assert.ok(height>0&&height<=.005&&height<=width*.25);
    assert.ok(width-2*height*.75>0,'the two soft axial edges leave a central atmosphere');
  }
});

test('air density fades continuously to an empty inward boundary',()=>{
  const density=kernel('habitatAirDensity'),height=.005;
  let previous=1;
  for(let i=0;i<=1000;i++){
    const value=density(height*i/1000,height);
    assert.ok(Number.isFinite(value)&&value>=0&&value<=previous);
    previous=value;
  }
  assert.equal(density(0,height),1);
  assert.equal(density(height,height),0);
  assert.equal(density(height*2,height),0);
  assert.ok(density(height*(1-1e-5),height)<1e-9,'no hard optical edge at the shell boundary');
});

test('shared air/cloud Beer-Lambert transmission composes across integration cells',()=>{
  const opacity=kernel('habitatOpticalOpacity');
  for(const extinction of [0,.001,.1,1,100,1000])for(const length of [0,.00001,.001,.03,1]){
    const whole=opacity(extinction,length);
    assert.ok(Number.isFinite(whole)&&whole>=0&&whole<=1);
    for(const fraction of [0,.1,.5,.9,1]){
      const a=opacity(extinction,length*fraction),b=opacity(extinction,length*(1-fraction));
      assert.ok(Math.abs((1-a)*(1-b)-(1-whole))<1e-14);
    }
  }
  assert.ok(opacity(3.4,.1)>opacity(3.4,.001),'long horizons scatter more than nearby surfaces');
});

test('ordered cloud half-paths attenuate a bright rear layer and differ when reversed',()=>{
  const run=orderedCloudCellRule(),opacity=kernel('habitatOpticalOpacity');
  const length=2,sigma=[4,4],source=[.02,1];
  function evaluate(values){
    const probes=[];
    const actual=run(length,t=>{probes.push(t);return sigma[t<1?0:1]/24;},t=>values[t<1?0:1]);
    const alpha=opacity(actual.extinction,length);
    const expected=values[0]*(-Math.expm1(-sigma[0]))+Math.exp(-sigma[0])*values[1]*(-Math.expm1(-sigma[1]));
    assert.equal(probes.length,2);assert.ok(probes[0]<1&&probes[1]>1);
    assert.equal(actual.extinction,4,'the original average extinction remains authoritative');
    assert.ok(Math.abs(actual.source*alpha-expected)<1e-14);
    return actual.source*alpha;
  }
  const darkFront=evaluate(source),brightFront=evaluate(source.slice().reverse());
  assert.ok(darkFront<.04&&brightFront>.98,'the front optical depth must hide the strong rear source');
  const unordered=(source[0]+source[1])*.5*opacity(4,length);
  assert.ok(unordered>darkFront*10,'the former source average would actually leak rear light in this fixture');
});

test('constant-source cloud transport retains the same Beer opacity across heterogeneous half-paths',()=>{
  const run=orderedCloudCellRule(),opacity=kernel('habitatOpticalOpacity');
  for(const length of [.0001,.7,2])for(const [front,rear] of [[0,0],[0,3],[3,0],[.1,8],[8,.1],[100,100]]){
    const source=.37,actual=run(length,t=>(t<length*.5?front:rear)/24,()=>source);
    const alpha=opacity(actual.extinction,length),expectedAlpha=-Math.expm1(-(front+rear)*length*.5);
    assert.ok(Math.abs(alpha-expectedAlpha)<1e-14);
    assert.ok(Number.isFinite(actual.source));
    if(alpha===0)assert.equal(actual.source,0,'zero opacity has no source contribution and needs no denominator fallback');
    else assert.ok(Math.abs(actual.source-source)<1e-12);
    assert.ok(Math.abs(actual.source*alpha-source*expectedAlpha)<1e-13);
  }
});

test('transparent and optically thin cloud halves have finite source limits without fabricated contribution',()=>{
  const run=orderedCloudCellRule(),opacity=kernel('habitatOpticalOpacity');
  let sourceQueries=0;
  const empty=run(1,()=>0,()=>{sourceQueries++;return 1e6;});
  assert.deepEqual(empty,{extinction:0,source:0});assert.equal(sourceQueries,0);
  for(const sigma of [1e-8,1e-6,1e-4]){
    const actual=run(1,()=>sigma/24,t=>t<.5?.1:.9),alpha=opacity(actual.extinction,1);
    const expected=.1*(-Math.expm1(-sigma*.5))+Math.exp(-sigma*.5)*.9*(-Math.expm1(-sigma*.5));
    assert.ok(Number.isFinite(actual.source)&&actual.source>=.1&&actual.source<=.9);
    assert.ok(Math.abs(actual.source*alpha-expected)<1e-15);
    assert.ok(Math.abs(actual.source-.5)<sigma+.000001,'the thin limit approaches the source average continuously');
  }
});

test('finite cloud clumps have sparse smooth ends and an interior dense body',()=>{
  const weight=kernel('habitatHeightWeight');let peak=0;
  const mean=z=>referenceHeightWeights(z).reduce((sum,w,k)=>sum+w*HABITAT_PROCEDURAL_CHANNEL_MEANS[k],0);
  for(let i=0;i<=2000;i++){
    const z=i/2000,actual=referenceHeightWeights(z),sum=actual.reduce((a,b)=>a+b,0);
    assert.ok(actual.every(v=>Number.isFinite(v)&&v>=0));
    assert.ok(sum/HABITAT_PROCEDURAL_DENSITY_SCALE<=1,'unit channels cannot produce unbounded normalized density');
    assert.ok(actual.filter(v=>v>0).length<=2,'condensed knot interpolation uses adjacent density channels');peak=Math.max(peak,mean(z));
  }
  for(const z of [-1,0,1,2])assert.deepEqual([1,2,3,4].map(k=>weight(z,k)),[0,0,0,0]);
  assert.ok(peak>.1&&peak>100*mean(.05)&&peak>100*mean(.95),'a clump grows into its body instead of starting as a dense basal carpet');
  for(const upper of [false,true]){
    const h=1e-4,at=e=>mean(upper?1-e:e)/e;
    assert.ok(at(h)>0);assert.ok(at(h/4)<at(h)*.4,'density derivative tends to zero at each finite end');
  }
});

test('resolved density uses the same height weights and leaves genuine empty pores and clear geography empty',()=>{
  const run=condensationKernel(),channels=[.01,.15,.4,.8],base=kernel('habitatCloudBase');
  for(const weather of [.64,.8,1])for(const z of [-.1,0,.03,.09,.2,.5,.8,1,1.2]){
    const h=base(weather)+z*1.10,w=referenceHeightWeights(z),expected=w.reduce((sum,v,k)=>sum+v*channels[k],0)/HABITAT_PROCEDURAL_DENSITY_SCALE;
    assert.ok(Math.abs(run(1,weather,0,0,channels,h)-expected)<1e-14);
    assert.equal(run(1,weather,0,0,[0,0,0,0],h),0);
    assert.equal(run(0,weather,0,0,channels,h),0);
    assert.ok(Math.abs(run(.3,weather,0,0,channels,h, h,1,.5)-expected*.15)<1e-14);
  }
});

test('unresolved weather uses area and condensation means through the same height operator',()=>{
  const run=condensationKernel(),heightWeights=kernel('habitatHeightWeights');
  for(let climate=0;climate<4;climate++)for(const h of [.5,.65,.8,1,1.3,1.6,1.8])for(const envelope of [0,.2,1]){
    const [area,raw]=HABITAT_PROCEDURAL_WEATHER_MEANS[climate],w=heightWeights(h,h,1,raw);
    const expected=area*w.reduce((sum,v,k)=>sum+v*HABITAT_PROCEDURAL_CHANNEL_MEANS[k],0)/HABITAT_PROCEDURAL_DENSITY_SCALE;
    for(const channels of [[0,0,0,0],[.1,.3,.6,1]]){
      const actual=run(envelope,.5,100000,climate,channels,h);
      assert.ok(Number.isFinite(actual)&&actual>=0);assert.ok(Math.abs(actual-expected)<1e-14);
    }
  }
});

test('resolved-weather shortcut retains directional coverage and the transition toward unresolved mean',()=>{
  const skip=densityShortcut(),run=condensationKernel(),channels=[.1,.3,.6,1];
  for(const footprint of [0,1949.999,1950,1950.001,5000,100000])for(const ray of [0,1950,1950.001,100000]){
    assert.equal(skip(0,footprint,ray),footprint<=1950&&ray<=1950);
    assert.equal(skip(.01,footprint,ray),false,'positive coverage cannot be erased by its separate raw channel');
  }
  for(let climate=0;climate<4;climate++){
    assert.equal(run(0,.8,1950,climate,channels),0);
    assert.ok(run(0,.8,1950.001,climate,channels)>0);
    assert.ok(run(0,.8,100000,climate,channels)>0);
    assert.ok(run(.01,.5,0,climate,channels)>0,'positive coverage survives even below the raw threshold');
  }
});

test('the physical scene-depth maximum cannot be extended by a farther ring floor',()=>{
  const expression=RING_HABITAT_AIR_GLSL.match(/\bmaximum=([^;]+);/)?.[1];
  assert.ok(expression);
  const clip=Function('maximum','solidDistance','min',`return ${expression};`);
  const radius=830000,ship=180/radius,floor=60000/radius;
  assert.equal(clip(ship,floor,Math.min),ship,'a foreground ship clips the entire column before the distant floor');
  assert.equal(clip(floor,ship,Math.min),ship,'a closer body solid also clips the column');
  assert.equal(clip(1e24,floor,Math.min),floor,'a clear scene still respects the physical body');
  const cell=rayCellKernel(),point=kernel('habitatCloudStratifiedPoint');
  const budget=actualCellBudget('cloudIntervals');
  for(let i=0;i<budget;i++){
    const [lo,hi]=cell([[.5/radius,ship]],budget,i);
    for(const stratum of [0,1])for(const phase of [0,.5,1-2**-24])
      assert.ok(point(lo,hi,i,stratum,phase)<ship,'no cloud sample can run behind the clipped foreground');
  }
});

test('the same optical compositor retains clouds above and outside the original air shell',()=>{
  const run=opticalStreamRule();
  for(const [air,cloud] of [[[[0,1]],[[.5,3]]],[[],[[2,3]]],[[[0,1],[5,6]],[[.3,2],[4,5.7]]],[[[1,2]],[]]]){
    const actual=run(air,cloud);
    const bounds=[...new Set([...air.flat(),...cloud.flat()])].sort((a,b)=>a-b);
    let radiance=0,transmittance=1;
    for(let i=0;i<bounds.length-1;i++){
      const lo=bounds[i],hi=bounds[i+1],mid=(lo+hi)*.5;
      const a=air.some(([x,y])=>mid>x&&mid<y)?.2:0,c=cloud.some(([x,y])=>mid>x&&mid<y)?.5:0;
      if(a+c===0)continue;
      const opacity=1-Math.exp(-(a+c)*(hi-lo)),source=(a*.2+c*.8)/(a+c);
      radiance+=source*opacity*transmittance;transmittance*=1-opacity;
    }
    assert.ok(Math.abs(actual.radiance-radiance)<1e-12);
    assert.ok(Math.abs(actual.transmittance-transmittance)<1e-12);
    assert.equal(actual.hasAir,false);assert.equal(actual.hasCloud,false);
  }
});

test('temporal representative depths follow the actual attenuated compositor and prefer cloud scattering',()=>{
  const run=opticalStreamRule(),rawMean=kernel('habitatSegmentMeanDistance'),opacity=kernel('habitatOpticalOpacity');
  const mean=(lo,hi,sigma)=>rawMean(lo,hi,sigma,opacity(sigma,hi-lo));
  const selection=RING_HABITAT_AIR_GLSL.match(/habitatColumnMeanDistance=(cloudWeight[^;]+);/)?.[1];
  assert.ok(selection);
  const choose=Function('cloudWeight','cloudMoment','allMoment','allWeight',`return ${selection};`);
  for(const spans of [[[[1,3]],[]],[[],[[1,3]]],[[[1,3]],[[1,3]]]]){
    const actual=run(...spans),sigma=(spans[0].length?.2:0)+(spans[1].length?.5:0);
    const distance=choose(actual.cloudWeight,actual.cloudMoment,actual.allMoment,actual.allWeight);
    assert.ok(Math.abs(distance-mean(1,3,sigma))<1e-10,'splitting the same constant-density column cannot move its representative depth');
    assert.ok(Math.abs(actual.allWeight-(1-actual.transmittance))<1e-12);
    assert.equal(actual.entry,1,'depth carrier remains entry, independently of the representative mean');
  }
  const mixed=run([[1,2]],[[5,6]]);
  const representative=choose(mixed.cloudWeight,mixed.cloudMoment,mixed.allMoment,mixed.allWeight);
  assert.ok(representative>5&&representative<6,'front air does not pull the cloud reprojection anchor in front of its actual volume');
  assert.ok(mixed.allMoment/mixed.allWeight<representative);
  for(const tau of [0,1e-8,1e-4,.00999,.01,.1,1,10,100,1000]){
    const actual=mean(3,4,tau);
    assert.ok(Number.isFinite(actual)&&actual>=3&&actual<=3.5);
    if(tau===0)assert.equal(actual,3.5);
  }
});

test('height-conditioned support stays within the conservative shell and above the near ship',()=>{
  const base=kernel('habitatCloudBase'),heightWeights=kernel('habitatHeightWeights'),radius=830000,height=.005;
  const cameraAltitude=1800/radius,shipOffset=180/radius;
  const bounds=kernel('habitatCloudBounds')({y:1,z:-.02,w:.02},height);
  const minimumAltitude=1-bounds[1],maximumAltitude=1-bounds[0];
  assert.deepEqual(bounds.slice(2),[-.02,.02]);
  for(const weather of [0,.64,.8,1]){
    const bottom=base(weather),top=bottom+1.10;
    assert.ok(bottom*height>=minimumAltitude&&top*height<=maximumAltitude,'actual conservative shell contains the entire conditioned support');
    assert.ok(height*bottom-cameraAltitude>shipOffset);
    for(const h of [.54,bottom,top,1.8])assert.deepEqual(heightWeights(h*height,h*height,height,weather),[0,0,0,0]);
    for(let i=0;i<=2000;i++){
      const w=heightWeights(height*i/1000,height*i/1000,height,weather);
      assert.ok(w.every(v=>Number.isFinite(v)&&v>=0));assert.ok(w.reduce((sum,v)=>sum+v,0)/HABITAT_PROCEDURAL_DENSITY_SCALE<=1);
    }
  }
  assert.notEqual(base(.64),base(1),'the fixed weather still shifts condensation altitude');
});

test('analytic joint height weights match independent fine integration across all knots and support boundaries',()=>{
  const average=kernel('habitatHeightWeightAverage'),heightWeights=kernel('habitatHeightWeights'),base=kernel('habitatCloudBase');
  const intervals=[[-1,2],[0,1],[0,.09],[.03,.08],[.249,.751],[-.1,.04],[.98,1.2],[.3,.30000001]];
  for(let i=1;i<=48;i++){const a=i*.027-.3;intervals.push([a,a+.00011+(i%11)*.071]);}
  for(const [a,b] of intervals){
    const reference=[0,0,0,0],n=32768;
    for(let i=0;i<n;i++){const w=referenceHeightWeights(a+(b-a)*(i+.5)/n);for(let k=0;k<4;k++)reference[k]+=w[k]/n;}
    for(let k=1;k<=4;k++){
      const actual=average(a,b,k);assert.ok(Number.isFinite(actual)&&actual>=0&&actual<=HABITAT_PROCEDURAL_DENSITY_SCALE);
      assert.ok(Math.abs(actual-reference[k-1])<2e-8,`interval ${a},${b} channel ${k}`);
    }
    for(const weather of [.64,.8,1]){
      const h=.005,lo=h*(base(weather)+a*1.10),hi=h*(base(weather)+b*1.10),actual=heightWeights(lo,hi,h,weather);
      for(let k=0;k<4;k++)assert.ok(Math.abs(actual[k]-reference[k])<2e-8,'radial-height units map to the same joint integral');
    }
  }
});

test('height primitives have constant tails and additive bounded column mass before footprint averaging',()=>{
  const primitive=kernel('habitatHeightWeightPrimitive'),average=kernel('habitatHeightWeightAverage'),full=[0,0,0,0];
  for(let i=0;i<65536;i++){const w=referenceHeightWeights((i+.5)/65536);for(let k=0;k<4;k++)full[k]+=w[k]/65536;}
  for(let k=1;k<=4;k++){
    assert.equal(primitive(-2,k),0);assert.equal(primitive(0,k),0);
    assert.equal(primitive(1,k),primitive(2,k));assert.equal(average(-2,-1,k),0);assert.equal(average(2,3,k),0);
    assert.ok(Math.abs(primitive(1,k)-full[k-1])<2e-8);
    const split=average(-.2,.43,k)*.63+average(.43,1.3,k)*.87;
    assert.ok(Math.abs(split-average(-.2,1.3,k)*1.5)<1e-14);
  }
  const channels=[.03,.2,.5,.9],total=full.reduce((sum,w,k)=>sum+w*channels[k],0);
  let reference=0;
  for(let i=0;i<65536;i++){const w=referenceHeightWeights((i+.5)/65536);reference+=w.reduce((sum,v,k)=>sum+v*channels[k],0)/65536;}
  assert.ok(Math.abs(total-reference)<1e-9);
  const calibratedMass=full.reduce((sum,w,k)=>sum+w*HABITAT_PROCEDURAL_CHANNEL_MEANS[k],0);
  assert.ok(calibratedMass>.08&&calibratedMass<.10,'the procedural calibration retains the full-layer optical mass');
});

test('long-cell weather filtering averages coverage after thresholding and preserves its area',()=>{
  const run=kernel('habitatWeatherCoverage');
  const coverage=(center,before,after,span,low,high)=>run(smoothstep(low,high,center),smoothstep(low,high,before),smoothstep(low,high,after),span);
  assert.equal(coverage(0,1,1,0,.64,.73),0,'a resolved short ray uses its actual point weather');
  assert.equal(coverage(0,1,1,100000,.64,.73),1,'a long cell cannot discard occupied weather beyond a clear midpoint');
  assert.equal(coverage(0,0,1,100000,.64,.73),.5,'partial clear/covered cells do not threshold their raw mean into the wrong state');
  const field=Array.from({length:256},(_,i)=>(Math.sin(i*.47)+1)*.5);
  for(const span of [0,1950,4000,8000]){
    let reference=0,filtered=0;
    for(let i=0;i<field.length;i++){
      reference+=smoothstep(.64,.73,field[i]);
      filtered+=coverage(field[i],field[(i+17)%256],field[(i+239)%256],span,.64,.73);
    }
    assert.ok(Math.abs(reference-filtered)<1e-12,'directional filtering redistributes covered area without globally adding haze');
  }
});

test('radial height footprint includes the interior grazing minimum, not only cell endpoints',()=>{
  const minimum=kernel('habitatCloudRadialMinimum'),heightWeights=kernel('habitatHeightWeights');
  const radius=.9911,half=.03,near=minimum(radius,0,0,1,half),far=Math.hypot(radius,half);
  assert.equal(near,radius);
  assert.ok(far>near);
  assert.deepEqual(heightWeights(1-radius,1-radius,.005,.8),[0,0,0,0],'the central grazing sample alone misses cloud support');
  assert.ok(heightWeights(1-far,1-near,.005,.8).some(v=>v>0),'its actual cell-height range includes occupied condensation knots');
  for(const [px,pz,dx,dz,span] of [[1,.1,0,1,.2],[1,.3,0,1,.1],[.8,-.6,.3,.7,.01],[.8,-.6,0,0,.1]]){
    const actual=minimum(px,pz,dx,dz,span);
    let sampled=Infinity;
    for(let i=0;i<=2000;i++){
      const t=-span+2*span*i/2000;
      sampled=Math.min(sampled,Math.hypot(px+dx*t,pz+dz*t));
    }
    assert.ok(actual<=sampled+1e-14);
    assert.ok(sampled-actual<1e-7);
  }
});

test('cloud self-shadowing uses finite optical thickness instead of sheet incidence',()=>{
  const extinction=kernel('habitatCloudExtinction'),opacity=kernel('habitatOpticalOpacity'),height=.005;
  for(const density of [0,.1,.32,.8,1]){
    const sigma=extinction(density,height);
    assert.ok(Number.isFinite(sigma)&&sigma>=0);
    assert.equal(opacity(sigma,0),0);
    assert.ok(opacity(sigma,height*.38)>=opacity(sigma,height*.05));
    assert.ok(opacity(sigma,height*3)<=1);
  }
  const sigma=extinction(.6,height);
  assert.ok(1-opacity(sigma,height*.3)<1-opacity(sigma,height*.02),'the underside receives less direct light than a thin cloud edge');
});

test('one cloud optical scale separates transmitting thin edges from shadowed thick interiors',()=>{
  const extinction=kernel('habitatCloudExtinction'),opacity=kernel('habitatOpticalOpacity');
  const radius=830000,height=.005;
  const edgeTransmission=1-opacity(extinction(.20,height),50/radius);
  const interiorTransmission=1-opacity(extinction(.35,height),1000/radius);
  assert.ok(edgeTransmission>.9,'a 50-unit thin edge retains most direct light');
  assert.ok(interiorTransmission>.05&&interiorTransmission<.2,'a kilometre-scale interior attenuates direct light without a hard black clamp');
  assert.ok(edgeTransmission/interiorTransmission>4);
});

test('body-fixed cloud frame preserves full 3D wavelengths, including the radial direction',()=>{
  const expression=RING_HABITAT_AIR_GLSL.match(/const mat3 HABITAT_CLOUD_FRAME=mat3\(([^)]+)\);/)?.[1];
  assert.ok(expression);
  const matrix=expression.split(',').map(Number);
  assert.equal(matrix.length,9);
  const transform=v=>[0,1,2].map(row=>v[0]*matrix[row]+v[1]*matrix[row+3]+v[2]*matrix[row+6]);
  for(const v of [[1,0,0],[0,1,0],[0,0,1],[.8,0,-.6],[.2,.7,-.4]]){
    assert.ok(Math.abs(Math.hypot(...transform(v))-Math.hypot(...v))<1e-14);
  }
  const radial=[.8,0,-.6],mapped=transform(radial);
  assert.ok(Math.hypot(...mapped)>.999,'vertical cloud thickness is not flattened into ground coordinates');
});

function solarColumnRule(){
  const start=RING_HABITAT_AIR_GLSL.indexOf('float habitatCloudSolarDepth(');
  assert.ok(start>=0);
  const begin=RING_HABITAT_AIR_GLSL.indexOf('{',start);
  let end=begin+1,depth=1;
  for(;depth>0;end++){
    if(RING_HABITAT_AIR_GLSL[end]==='{')depth++;
    else if(RING_HABITAT_AIR_GLSL[end]==='}')depth--;
  }
  const body=RING_HABITAT_AIR_GLSL.slice(begin+1,end-1)
    .replace('vec4 intervals;int count;','')
    .replace(/if\(!ringLatticeIntervals\([^;]+return 0\.;/,'')
    .replace(/vec3 probe=point\+uLight\*\(([^;]+)\);/,'float probeDistance=($1);')
    .replace(/float density=habitatCloudDensity\([^;]+;/,'float density=densityAt(probeDistance,stepSize);')
    .replace(/\bfloat\(([^)]+)\)/g,'($1)')
    .replace(/\b(?:float|int)\b/g,'let')
    .replaceAll('HABITAT_LIGHT_SAMPLES',String(shaderInteger('HABITAT_LIGHT_SAMPLES')));
  const run=Function('intervals','count','height','lightSamples','densityAt','habitatCloudExtinction','habitatLightBoundary',body);
  return (...args)=>run(...args,kernel('habitatLightBoundary'));
}

test('view and reflected cloud lighting integrate bounded columns of the same density',()=>{
  const run=solarColumnRule(),extinction=kernel('habitatCloudExtinction'),height=.005;
  for(const samples of [shaderInteger('HABITAT_LIGHT_SAMPLES'),shaderInteger('HABITAT_REFLECTION_LIGHT_SAMPLES')]){
    for(const spans of [[[0,.001]],[[0,.0003],[.0007,.001]]]){
      const intervals={x:spans[0][0],y:spans[0][1],z:spans[1]?.[0]??0,w:spans[1]?.[1]??0};
      let queries=0;
      const depth=run(intervals,spans.length,height,samples,t=>{
        queries++;assert.ok(spans.some(([a,b])=>t>a&&t<b));return .35;
      },extinction);
      assert.equal(queries,samples);
      const length=spans.reduce((sum,[a,b])=>sum+b-a,0);
      assert.ok(Math.abs(depth-extinction(.35,height)*length)<1e-12);
    }
  }
  const queries=[];
  const depth=run({x:0,y:height*.4,z:0,w:0},1,height,6,t=>{
    queries.push(t);return t<height*.14||t>height*.28?.7:0;
  },extinction);
  assert.equal(queries.length,6);
  assert.ok(depth>4,'separated near and far lobes are both shadowed even when the old outer probe lay in clear air');
});

test('finite clump view density, solar extinction and ground shadow retain the same integrated column',()=>{
  const source=functionBody('habitatCloudShadow');
  const begin=source.indexOf('  float opticalDepth=');assert.ok(begin>=0);
  const body=source.slice(begin)
    .replace(/vec3 p=point\+uLight\*\(([^;]+)\);/,'float probeDistance=($1);')
    .replace(/habitatCloudDensity\(p,uLight,footprint,stepSize\*uBodyRadius,shell,gap,height\)/,'densityAt(probeDistance,stepSize)')
    .replace(/\bfloat\(([^)]+)\)/g,'($1)').replace(/\b(?:float|int)\b/g,'let')
    .replaceAll('HABITAT_SHADOW_SAMPLES',String(shaderInteger('HABITAT_SHADOW_SAMPLES')));
  const ground=Function('intervals','count','height','densityAt','habitatCloudExtinction','habitatOpticalOpacity',body);
  const density=condensationKernel(),solar=solarColumnRule(),extinction=kernel('habitatCloudExtinction'),opacity=kernel('habitatOpticalOpacity');
  const channels=[.01,.12,.4,.8],weather=.8,base=kernel('habitatCloudBase')(weather),length=1.10;
  const intervals={x:base,y:base+length,z:0,w:0};
  const average=(t,span)=>density(.7,weather,0,0,channels,t-span*.5,t+span*.5);
  let mass=0;const count=65536;
  for(let i=0;i<count;i++)mass+=average(base+(i+.5)*length/count,0)*length/count;
  const expectedDepth=extinction(mass,1);
  for(const samples of [shaderInteger('HABITAT_LIGHT_SAMPLES'),shaderInteger('HABITAT_REFLECTION_LIGHT_SAMPLES')]){
    const actual=solar(intervals,1,1,samples,average,extinction);
    assert.ok(Math.abs(actual-expectedDepth)<1e-7,'different solar partitions integrate the same point-density mass');
  }
  const shadow=ground(intervals,1,1,average,extinction,opacity);
  assert.ok(Math.abs(shadow-opacity(expectedDepth,1))<1e-8);
  assert.ok(shadow>0&&shadow<1,'the same finite mass casts a transmitting ground shadow');
});

test('cloud diffuse fill follows its existing solar column without another light query',()=>{
  const source=functionBody('habitatCloudSource');
  const start=source.indexOf('  float solarDepth='),end=source.indexOf('  // Incoming',start);
  assert.ok(start>=0&&end>start);
  const body=source.slice(start,end).replace(/habitatCloudSolarDepth\([^;]+\)/,'solarDepthQuery()')
    .replace(/\bfloat\s+(\w+)/g,'let $1');
  const run=Function('solarDepthQuery','exp','sqrt',`let ambient=1;${body}return {ambient,sunlight};`);
  let previous=1;
  for(const depth of [0,.01,.1,1,3,10,100]){
    let queries=0;
    const result=run(()=>{queries++;return depth;},Math.exp,Math.sqrt);
    assert.equal(queries,1);assert.equal(result.sunlight,Math.exp(-depth));
    assert.ok(result.ambient>0&&result.ambient<=previous,'thicker cores retain less positive diffuse fill');
    previous=result.ambient;
  }
});

test('relative HG lobes and their cloud mixture are positive and normalized over solid angle',()=>{
  const hg=kernel('habitatCloudHenyeyGreenstein'),phase=kernel('habitatCloudPhase');
  const count=65536;
  for(const g of [-.25,0,.65]){
    let mass=0,moment=0;
    for(let i=0;i<count;i++){
      const cosine=-1+(i+.5)*2/count,value=hg(cosine,g);
      assert.ok(Number.isFinite(value)&&value>0);
      mass+=value/count;moment+=cosine*value/count;
    }
    // For an azimuth-symmetric relative phase, integral(P dOmega)/(4*pi)
    // equals integral(P(mu) dmu)/2. The first moment is independently g.
    assert.ok(Math.abs(mass-1)<1e-7);
    assert.ok(Math.abs(moment-g)<1e-7);
    assert.ok(Number.isFinite(hg(-1,g))&&Number.isFinite(hg(1,g)));
    if(g===0)assert.equal(hg(.37,g),1);
  }
  let mass=0,moment=0;
  for(let i=0;i<count;i++){
    const cosine=-1+(i+.5)*2/count,value=phase(cosine);
    assert.ok(Number.isFinite(value)&&value>0);
    mass+=value/count;moment+=cosine*value/count;
  }
  assert.ok(Math.abs(mass-1)<1e-7,'angle redistribution must not introduce a global direct-light gain');
  assert.ok(Math.abs(moment-.47)<1e-7,'forward/back mixture retains its specified asymmetry');
});

test('the actual direct-source expression follows the viewing angle with correct forward sign and unchanged solar attenuation',()=>{
  const phase=kernel('habitatCloudPhase');
  const expression=RING_HABITAT_AIR_GLSL.match(/return ambient\+vec3\(\.62,\.61,\.58\)\*([^;]+);/)?.[1];
  assert.ok(expression);
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
  const scale=Function('sun','sunlight','unitRay','uLight','habitatCloudPhase','clamp','dot',`return ${expression};`);
  const light=[0,0,1],rays=[[0,0,1],[1,0,0],[0,0,-1]];
  const values=rays.map(ray=>scale(1,1,ray,light,phase,clamp,dot));
  assert.ok(values[0]>values[2]&&values[2]>values[1]);
  assert.ok(values[0]>10&&values[1]>.4&&values[1]<.5,'sunward thin edges brighten while transverse clouds receive less direct light');
  // Both physical propagation vectors point opposite these query vectors.
  // Their dot product must agree; negating only the view would swap lobes.
  for(const ray of rays){
    assert.equal(dot(ray,light),dot(ray.map(v=>-v),light.map(v=>-v)));
    const whole=scale(.7,1,ray,light,phase,clamp,dot);
    assert.ok(Math.abs(scale(.7,.2,ray,light,phase,clamp,dot)-whole*.2)<1e-12);
    assert.equal(scale(0,1,ray,light,phase,clamp,dot),0);
    assert.equal(scale(1,0,ray,light,phase,clamp,dot),0);
  }
  const roundedUnit=[0,0,1+1e-7];
  assert.equal(scale(1,1,roundedUnit,light,phase,clamp,dot),values[0],'unit-vector dot roundoff remains on the finite angular endpoint');
});

test('finite reflected sky uses a smaller optical budget and cloud ambient follows night illumination',()=>{
  const reflected=RING_HABITAT_AIR_GLSL.slice(RING_HABITAT_AIR_GLSL.indexOf('vec3 habitatReflectedSky('));
  const match=reflected.match(/habitatOpticalColumn\(origin,unitRay,[\s\S]+?footprint,-1,\s*([A-Z_]+),([A-Z_]+),([A-Z_]+),/);
  assert.ok(match);
  const air=shaderInteger(match[1]),cloud=shaderInteger(match[2]),light=shaderInteger(match[3]);
  assert.ok(air+cloud<=8);
  assert.ok(cloud*2<actualCellBudget('cloudIntervals')*2);
  assert.equal(light,2);
  const expression=RING_HABITAT_AIR_GLSL.match(/ambient\*=([^;]+);/)?.[1];
  assert.ok(expression);
  const illumination=Function('sun',`return ${expression};`);
  assert.equal(illumination(1),1);
  assert.ok(illumination(0)<.03);
});

test('secondary reflection origin uses a finite float32-scale allowance with geometric ray-side selection',()=>{
  const error=kernel('habitatReflectionOriginError'),radius=830383.1183351576;
  assert.ok(error(1)*radius>.39&&error(1)*radius<.40);
  assert.equal(error(.5),error(1));assert.equal(error(8),error(1)*8);
  const sideExpression=RING_HABITAT_AIR_GLSL.match(/float side=([^;]+);/)?.[1];
  assert.ok(sideExpression);
  const side=Function('geometricNormal','unitRay','dot',`return ${sideExpression};`);
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
  assert.equal(side([0,1,0],[1,.03,0],dot),1);
  assert.equal(side([0,1,0],[1,-.03,0],dot),-1);
  assert.equal(side([0,1,0],[1,0,0],dot),1,'exactly tangent rays use the outward geometric side');
});

test('float32 grazing reflections escape rounded core self-hits without sending negative rays into the sky',()=>{
  const f=Math.fround,error=kernel('habitatReflectionOriginError'),radius=830383.1183351576,ground=f(.9994211),minimum=.2/radius;
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
  const expression=RING_HABITAT_AIR_GLSL.match(/float side=([^;]+);/)?.[1];
  const side=Function('geometricNormal','unitRay','dot',`return ${expression};`);
  function spawn(p,n,ray){
    const magnitude=Math.max(...p.map(Math.abs)),distance=f(error(magnitude)*side(n,ray,dot));
    return p.map((v,i)=>f(v+f(n[i]*distance)));
  }
  // Float32 version of the actual cylinder's cross-product discriminant.
  // It reproduces the secondary-ray failure numerically, not via a GPU claim.
  function hit(p,d){
    const planar=f(f(d[0]*d[0])+f(d[2]*d[2])),along=f(f(p[0]*d[0])+f(p[2]*d[2]));
    const cross=f(f(p[0]*d[2])-f(p[2]*d[0]));
    const disc=f(f(planar*f(ground*ground))-f(cross*cross));
    if(disc<0)return Infinity;
    const root=f(Math.sqrt(disc));
    const near=f(f(-along-root)/planar),far=f(f(-along+root)/planar);
    return near>minimum?near:far>minimum?far:Infinity;
  }
  let oldNearHits=0;
  for(let i=0;i<64;i++)for(const rounding of [-(2**-23),0,2**-23]){
    const angle=i*Math.PI/32,c=Math.cos(angle),s=Math.sin(angle);
    const n=[f(-c),0,f(-s)],tangent=[-s,0,c];
    const p=[f((ground+rounding)*c),0,f((ground+rounding)*s)];
    const positive=tangent.map((v,k)=>f(v*Math.sqrt(1-.03**2)+n[k]*.03));
    if(hit(p,positive)*radius<100)oldNearHits++;
    assert.ok(hit(spawn(p,n,positive),positive)*radius>1000,'the same grazing ray must retain its distant physical floor hit');
    const negative=tangent.map((v,k)=>f(v*Math.sqrt(1-.03**2)-n[k]*.03));
    const insideCore=spawn(p,n,negative);
    assert.ok(Math.hypot(insideCore[0],insideCore[2])>ground,'negative rays keep their opaque side');
    assert.ok(dot(insideCore,negative)>0,'negative outgoing rays move farther from the inner air cylinder');
  }
  assert.ok(oldNearHits>0,'the unoffset float32 fixture must actually exhibit secondary self-hit acne');
});

test('mixed clear air and cloud transmission has no independent coplanar sheet',()=>{
  const opacity=kernel('habitatOpticalOpacity'),cloudExtinction=kernel('habitatCloudExtinction');
  const air=.1*.17/.005,cloud=cloudExtinction(.4,.005),path=.002;
  const mixedTransmission=1-opacity(air+cloud,path);
  const independentTransmission=(1-opacity(air,path))*(1-opacity(cloud,path));
  assert.ok(Math.abs(mixedTransmission-independentTransmission)<1e-14);
  assert.equal(opacity(air+cloudExtinction(0,.005),path),opacity(air,path));
});

test('the fixed 96 cloud samples stay in their half-strata and exact clipped intervals',()=>{
  const cell=rayCellKernel(),point=kernel('habitatCloudStratifiedPoint'),phase=pixelPhaseKernel();
  const budget=actualCellBudget('cloudIntervals'),airBudget=actualCellBudget('intervals');
  const events=RING_HABITAT_AIR_GLSL.match(/for\(int event=0;event<([A-Z_]+);/)?.[1];
  const strata=Number(RING_HABITAT_AIR_GLSL.match(/for\(int stratum=0;stratum<(\d+);/)?.[1]);
  assert.ok(events);
  assert.equal(budget%2,0,'two radial segments receive complete integer sample budgets');
  assert.equal(budget*strata,96,'the actual view loop keeps its density-query budget');
  assert.equal(airBudget%2,0);
  assert.ok(shaderInteger(events)>=airBudget+budget+4,'merge budget covers both independent streams and all four radial entries');
  for(const intervals of [[[20,21]],[[20,21],[80,82]]]){
    let covered=0,queries=0;
    for(let i=0;i<budget;i++){
      const [lo,hi]=cell(intervals,budget,i);
      for(let stratum=0;stratum<strata;stratum++){
        const t=point(lo,hi,i,stratum,phase(123.5,456.5,stratum));queries++;
        assert.ok(t>=mix(lo,hi,stratum*.5)&&t<mix(lo,hi,(stratum+1)*.5));
        assert.ok(intervals.some(([a,b])=>lo>=a&&hi<=b&&t>=a&&t<b));
      }
      covered+=hi-lo;
    }
    assert.ok(Math.abs(covered-intervals.reduce((sum,[a,b])=>sum+b-a,0))<1e-13);
    assert.equal(queries,96);
    assert.equal(cell(intervals,budget,budget),null);
  }
});

test('fixed pixel phases decorrelate adjacent rays and cover each half-stratum without moving the cloud field',()=>{
  const phase=pixelPhaseKernel(),point=kernel('habitatCloudStratifiedPoint');
  const bins=Array.from({length:2},()=>Array(16).fill(0));
  let sum=0,product=0,sumSquare=0;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const a=phase(x+.5,y+.5,0),b=phase(x+1.5,y+.5,0);
    assert.equal(a,phase(x+.5,y+.5,0),'fixed pixel phases never consume a clock or mutable RNG');
    sum+=a;sumSquare+=a*a;product+=(a-.5)*(b-.5);
    for(const stratum of [0,1]){
      const p=phase(x+.5,y+.5,stratum);
      assert.ok(p>=0&&p<1);
      bins[stratum][Math.floor(p*16)]++;
      for(const cell of [0,1,17,47]){
        const t=point(0,1,cell,stratum,p);
        assert.ok(t>=stratum*.5&&t<(stratum+1)*.5);
      }
    }
  }
  assert.ok(Math.abs(sum/4096-.5)<.015);
  assert.ok(Math.abs(sumSquare/4096-1/3)<.015);
  assert.ok(Math.abs(product/4096)<.006,'adjacent pixels do not retain the same integration phase');
  for(const histogram of bins)for(const count of histogram)assert.ok(count>190&&count<320);
});

test('raw draw sample index changes only the deterministic integration phases',()=>{
  const phase=pixelPhaseKernel(),point=kernel('habitatCloudStratifiedPoint');
  const phases=new Set();
  for(let sampleIndex=0;sampleIndex<32;sampleIndex++){
    const p=phase(123.5,456.5,0,sampleIndex);phases.add(p);
    assert.equal(p,phase(123.5,456.5,0,sampleIndex));
    for(let cell=0;cell<48;cell++)for(const stratum of [0,1]){
      const t=point(0,1,cell,stratum,phase(123.5,456.5,stratum,sampleIndex));
      assert.ok(t>=stratum*.5&&t<(stratum+1)*.5);
    }
  }
  assert.equal(phases.size,32);
  // Phase zero remains the V4 diagnostic distribution. Positive draw phases
  // never enter the density function; reflected columns select a separate
  // deterministic integration mode rather than borrowing these view phases.
  assert.equal(phase(123.5,456.5,0,0),phase(123.5,456.5,0));
});

test('deterministic reflection pairs exactly integrate constant through cubic columns within the same eight probes',()=>{
  const cell=rayCellKernel(),point=kernel('habitatCloudIntegrationPoint');
  const budget=shaderInteger('HABITAT_REFLECTION_CLOUD_CELLS');
  const strata=Number(RING_HABITAT_AIR_GLSL.match(/for\(int stratum=0;stratum<(\d+);/)?.[1]);
  assert.equal(budget*strata,8);
  for(const intervals of [[[.3,2.7]],[[.3,.9],[1.7,2.7]]])for(let degree=0;degree<=3;degree++){
    let integral=0,queries=0;
    for(let i=0;i<budget;i++){
      const [lo,hi]=cell(intervals,budget,i);
      for(let stratum=0;stratum<strata;stratum++){
        const t=point(lo,hi,i,stratum,.123,-1);queries++;
        assert.ok(t>lo&&t<hi);
        assert.ok(intervals.some(([a,b])=>t>a&&t<b),'reflection probes cannot cross finite gaps or opaque interval ends');
        integral+=t**degree*(hi-lo)*.5;
      }
    }
    const reference=intervals.reduce((sum,[lo,hi])=>sum+(hi**(degree+1)-lo**(degree+1))/(degree+1),0);
    assert.ok(Math.abs(integral-reference)<1e-12);
    assert.equal(queries,8);
  }
});

test('reflection integration is isolated from screen phases while the temporal view retains its stratified samples',()=>{
  const point=kernel('habitatCloudIntegrationPoint'),view=kernel('habitatCloudStratifiedPoint'),phase=pixelPhaseKernel();
  for(const stratum of [0,1]){
    const fixed=point(.1,.9,0,stratum,0,-1);
    for(let sampleIndex=0;sampleIndex<32;sampleIndex++)for(const cell of [0,1,3,47]){
      const p=phase(123.5,456.5,stratum,sampleIndex);
      assert.equal(point(.1,.9,cell,stratum,p,-1),fixed,'reflection never consumes pixel or cell random phase');
      assert.equal(point(.1,.9,cell,stratum,p,sampleIndex),view(.1,.9,cell,stratum,p),'view 96-sample path is unchanged');
    }
  }
  const gate=RING_HABITAT_AIR_GLSL.match(/if\((samplingIndex[^)]+)\)\{\s*cloudPhase=vec2\(habitatCloudPixelPhase/)?.[1];
  assert.ok(gate);
  const hashes=Function('samplingIndex',`return ${gate};`);
  assert.equal(hashes(-1),false,'the reflection column does not evaluate screen hashes');
  for(let sampleIndex=0;sampleIndex<32;sampleIndex++)assert.equal(hashes(sampleIndex),true);
});

test('multi-phase stratified integration conserves optical mass for smooth, thin and rapidly varying cloud columns',()=>{
  const cell=rayCellKernel(),point=kernel('habitatCloudStratifiedPoint'),phase=pixelPhaseKernel();
  const budget=actualCellBudget('cloudIntervals'),heightWeights=kernel('habitatHeightWeights');
  const fields=[()=>1,t=>heightWeights(.54+1.26*t,.54+1.26*t,1,.8).reduce((sum,v)=>sum+v,0),
    t=>t>.443&&t<.448?1:0,
    t=>.6+.3*Math.sin(t*913)+.1*Math.cos(t*2179)];
  for(const value of fields){
    let estimate=0,reference=0;
    for(let i=0;i<131072;i++)reference+=value((i+.5)/131072)/131072;
    for(let pixel=0;pixel<2048;pixel++){
      const phases=[phase(pixel%64+.5,Math.floor(pixel/64)+.5,0),phase(pixel%64+.5,Math.floor(pixel/64)+.5,1)];
      for(let i=0;i<budget;i++){
        const [lo,hi]=cell([[0,1]],budget,i);
        for(const stratum of [0,1])estimate+=value(point(lo,hi,i,stratum,phases[stratum]))*(hi-lo)*.5/2048;
      }
    }
    assert.ok(Math.abs(estimate-reference)<.0015,`ensemble mass ${estimate} reference ${reference}`);
  }
});

test('cloud pixel footprint is independent of integration-cell length',()=>{
  const expression=RING_HABITAT_AIR_GLSL.match(/float footprint=([^;]+);/)?.[1];
  assert.ok(expression);
  const footprint=Function('t','uPixelAngle','uBodyRadius','stepSize','originFootprint','max',`return ${expression};`);
  const a=footprint(.5,.0015,830000,.0001,0,Math.max),b=footprint(.5,.0015,830000,.1,0,Math.max);
  assert.equal(a,622.5);
  assert.equal(a,b,'long cells do not turn a narrow resolved pixel into mean cloud density');
  const density=condensationKernel();
  assert.equal(density(0,.8,a,0,[.1,.3,.6,1]),0,'resolved clear macro geography remains clear');
  assert.equal(footprint(.001,.0015,830000,.1,100,Math.max),100,'reflection starts with its actual surface footprint');
  const billows=RING_HABITAT_AIR_GLSL.match(/vec4 habitatCloudBillows\([^)]*\)\{([\s\S]+?)\n\}/)?.[1];
  assert.ok(billows);
  const filterCode=[...billows.matchAll(/(?:const )?float (lobeScale|octaveFade|detail)=([^;]+);/g)]
    .map(([,name,value])=>`const ${name}=${value};`).join('');
  const octaves=Function('footprint','smoothstep',`${filterCode}return [octaveFade,detail];`);
  assert.deepEqual(octaves(0,smoothstep),[0,1]);
  assert.deepEqual(octaves(250,smoothstep),[0,0],'unresolved erosion skips the finer octave');
  assert.deepEqual(octaves(1000,smoothstep),[1,0],'unresolved billows skip both noise evaluations');
});
