import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGalaxyAppearance } from '../../src/render/galaxy-appearance.js';
import { createGalaxyHaze, galaxyHazeScale } from '../../src/render/galaxy-haze.js';
import { describeMacro, sampleGalaxy } from '../../src/render/cosmos.js';

const families = ['grand-spiral', 'barred-spiral', 'dust-disk', 'ancient-halo', 'tidal-islands', 'stellar-nursery'];
const examples = new Map();
for (let x=-16; x<=16; x++) for (let y=-12; y<=12; y++) for (let z=-8; z<=8; z++) {
  const descriptor=describeMacro({x,y,z},'appearance-fixture');
  if (descriptor) {
    const appearance=describeGalaxyAppearance(descriptor);
    if (!examples.has(appearance.family)) examples.set(appearance.family,descriptor);
  }
}

test('six visual families are deterministic detached additions to existing galaxy streams', () => {
  assert.deepEqual([...examples.keys()].sort(),[...families].sort());
  for (const [family,descriptor] of examples) {
    const before=structuredClone(descriptor),particles=sampleGalaxy(descriptor,128);
    const first=describeGalaxyAppearance(descriptor);
    assert.equal(first.revision,1);assert.equal(first.family,family);
    describeGalaxyAppearance({...descriptor,seed:'another-appearance'});
    const repeat=describeGalaxyAppearance(descriptor);
    assert.deepEqual(first,repeat);assert.notEqual(first,repeat);
    assert.notEqual(first.viewing.offset,repeat.viewing.offset);
    assert.deepEqual(descriptor,before);assert.deepEqual(sampleGalaxy(descriptor,128),particles);
    assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.viewing)&&Object.isFrozen(first.viewing.offset));
    assert.throws(()=>{first.viewing.offset[0]=100;},TypeError);
    const distance=Math.hypot(...first.viewing.offset);
    assert.ok(distance>1.1&&distance<3);
    assert.ok(first.viewing.fov>=45&&first.viewing.fov<=60);
    assert.ok(2*Math.asin(1/distance)*180/Math.PI<first.viewing.fov,'whole support fits the nominated vertical field of view');
    for (const value of Object.values(first)) if (typeof value==='number') assert.ok(Number.isFinite(value)&&value>=0&&value<=6);
    if (family==='barred-spiral') assert.equal(descriptor.bar,true);
    if (family==='grand-spiral'||family==='dust-disk') assert.equal(descriptor.bar,false);
  }
  for (const descriptor of [null,{}, {seed:'x',morphology:'invented'}, {seed:0,morphology:'spiral'}]) assert.throws(()=>describeGalaxyAppearance(descriptor),TypeError);
});

test('families select different structure and composition rather than only tint', () => {
  const get=family=>describeGalaxyAppearance(examples.get(family));
  assert.ok(get('grand-spiral').armStrength/get('grand-spiral').coreStrength>get('dust-disk').armStrength/get('dust-disk').coreStrength*2);
  assert.ok(get('dust-disk').dustStrength>get('grand-spiral').dustStrength*4);
  assert.ok(get('ancient-halo').haloStrength>get('grand-spiral').haloStrength*5);
  assert.ok(get('tidal-islands').bridgeStrength>get('stellar-nursery').bridgeStrength*5);
  assert.ok(get('tidal-islands').knotScale>get('stellar-nursery').knotScale*1.5);
  const elevation=family=>{const p=get(family).viewing.offset;return Math.abs(p[1])/Math.hypot(...p);};
  assert.ok(elevation('grand-spiral')>.7);assert.ok(elevation('dust-disk')<.1);
});

test('profiles share bounded volumes, shader, texture and quadrature without extra draw calls', () => {
  const descriptors=[...examples.values()],haze=createGalaxyHaze();
  haze.userData.setDescriptors(descriptors);
  const original=haze.children[0],geometry=original.geometry,noise=original.material.uniforms.structureNoise.value;
  let geometryReleases=0,noiseReleases=0,materialReleases=0;
  geometry.addEventListener('dispose',()=>geometryReleases++);noise.addEventListener('dispose',()=>noiseReleases++);
  for (const [i,mesh] of haze.children.entries()) {
    mesh.material.addEventListener('dispose',()=>materialReleases++);
    assert.equal(mesh.geometry,geometry);assert.equal(mesh.material.uniforms.structureNoise.value,noise);
    assert.equal(mesh.material.fragmentShader,original.material.fragmentShader);
    assert.ok(galaxyHazeScale(descriptors[i]).every(n=>n>0&&n<=1));
    assert.deepEqual(mesh.userData.appearance,describeGalaxyAppearance(descriptors[i]));
    for (const name of ['armStrength','coreStrength','dustStrength','haloStrength','bridgeStrength','knotScale','youngStrength','emissionStrength']) {
      assert.equal(mesh.material.uniforms[name].value,mesh.userData.appearance[name]);
    }
  }
  const centers=descriptors.map(()=>[0,0,-180000]);
  for (const [quality,count] of [['low',16],['auto',32],['high',48]]) {
    assert.equal(haze.userData.update({centers,cameraPosition:[0,0,0],quality,brightness:1,home:false}),6);
    assert.equal(haze.children.length,6);
    assert.ok(haze.children.every(mesh=>mesh.material.uniforms.steps.value===count));
  }
  haze.userData.setDescriptors(descriptors);
  assert.equal(materialReleases,6);assert.equal(geometryReleases,0);assert.equal(noiseReleases,0);
  haze.userData.dispose();haze.userData.dispose();
  assert.equal(geometryReleases,1);assert.equal(noiseReleases,1);
});

test('actual dust column stays finite, agrees with numerical integration and darkens the plane', () => {
  const haze=createGalaxyHaze();haze.userData.setDescriptors([examples.get('dust-disk')]);
  const source=haze.children[0].material.fragmentShader;
  // Evaluate the actual scalar branches uploaded to WebGL. The independent
  // midpoint integral below is the dust density along the camera segment.
  const grazing=source.match(/if\(abs\(direction.y\)<.0001\) column=([^;]+);/)?.[1];
  const crossing=source.match(/else column=([^;]+);/)?.[1];
  assert.ok(grazing&&crossing);
  const support=source.match(/float supportReach=([^;]+);/)?.[1];
  assert.ok(support);
  const supportExit=Function('p','direction','b','dot','max','sqrt',`return ${support};`);
  const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
  for (const p of [[0,0,0],[.2,.01,.4],[-.9,0,0]]) for (const direction of [[1,0,0],[0,1,0],[0,0,-1]]) {
    const exit=supportExit(p,direction,dot(p,direction),dot,Math.max,Math.sqrt);
    assert.ok(Number.isFinite(exit)&&exit>=0&&exit<=2);
    assert.ok(Math.abs(Math.hypot(...p.map((n,i)=>n+direction[i]*exit))-1)<1e-12);
  }
  const run=expression=>Function('p','camera','direction','reach','sheet','atan',`return ${expression};`);
  const integrate=(height,cameraHeight,reach,sheet)=>{
    const direction={y:(cameraHeight-height)/reach};
    return run(Math.abs(direction.y)<.0001?grazing:crossing)({y:height},{y:cameraHeight},direction,reach,sheet,Math.atan);
  };
  for (const sheet of [.008,.012,.024]) for (const height of [-.4,-.02,0,.02,.4]) for (const cameraHeight of [-.2,height,height+1e-7,.18]) {
    const reach=2.7,column=integrate(height,cameraHeight,reach,sheet);
    let reference=0;const count=4096;
    for(let i=0;i<count;i++){const y=height+(cameraHeight-height)*(i+.5)/count;reference+=reach/count/(1+(y/sheet)**2);}
    assert.ok(Number.isFinite(column)&&column>=0&&column<=reach+1e-10);
    assert.ok(Math.abs(column-reference)<.00002);
    const transmittance=Math.exp(-Math.max(0,Math.min(12,column*1.65*6)));
    assert.ok(transmittance>0&&transmittance<=1);
  }
  assert.ok(integrate(0,0,2.7,.012)>integrate(.2,.2,2.7,.012)*100);
  haze.userData.dispose();
});

test('spiral stellar envelope remains connected, tapered and finite through dust and noise extrema', () => {
  const haze=createGalaxyHaze();haze.userData.setDescriptors([examples.get('grand-spiral')]);
  const source=haze.children[0].material.fragmentShader;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const smoothstep=(a,b,n)=>{const t=clamp((n-a)/(b-a),0,1);return t*t*(3-2*t);};
  const scalar=(name,values)=>{
    const expression=source.match(new RegExp(`float ${name}=([^;]+);`))?.[1];
    assert.ok(expression);
    const scope={clamp,smoothstep,exp:Math.exp,...values};
    return Function(...Object.keys(scope),`return ${expression};`)(...Object.values(scope));
  };
  let minArm=Infinity,maxArm=0;
  for(const coarse of [0,.25,.5,.75,1]) for(const fine of [0,.25,.5,.75,1]) for(const lane of [0,.5,1]) {
    const mottling=scalar('mottling',{fine}),laneShadow=scalar('laneShadow',{lane,coarse});
    const armLight=scalar('armLight',{arm:.5,coarse,mottling,laneShadow,r:.5});
    minArm=Math.min(minArm,armLight);maxArm=Math.max(maxArm,armLight);
    assert.ok(Number.isFinite(armLight)&&armLight>0,'dust and mottling cannot cut resolved arms into disconnected beads');
    for(const r of [0,.03,.2,.5,.8,1]) for(const y of [-.4,-.01,0,.01,.4]) for(const thickness of [.035,.08]) {
      const height=scalar('height',{p:{y},thickness});
      const taper=scalar('taper',{r,height}),interarm=scalar('interarm',{coarse});
      assert.ok(Number.isFinite(taper)&&taper>=0&&taper<=1);
      const amount=scalar('amount',{edge:r===1?0:1,disk:.5,taper,interarm,armStrength:3.6,armLight,r,q:0,dustTransmission:()=>.5});
      assert.ok(Number.isFinite(amount)&&amount>=0);
      if(r===1)assert.equal(amount,0,'existing support edge still ends all added emission');
    }
  }
  assert.ok(maxArm/minArm<5,'multiscale texture changes detail without high-contrast coarse gates');
  const center=scalar('taper',{r:0,height:0}),outer=scalar('taper',{r:.9,height:0});
  assert.ok(outer<center*.4,'edge-on stellar disk narrows and fades toward its ends');
  assert.ok(scalar('interarm',{coarse:0})>0,'a continuous faint population joins otherwise separated arms');
  haze.userData.dispose();
});

test('elliptical core concentrates light, the local stellar bar is elongated and irregular islands are unequal', () => {
  const haze=createGalaxyHaze();haze.userData.setDescriptors([examples.get('ancient-halo')]);
  const source=haze.children[0].material.fragmentShader;
  const scalar=(name,values)=>{
    const expression=source.match(new RegExp(`float ${name}=([^;]+);`))?.[1];assert.ok(expression);
    const scope={exp:Math.exp,cos:Math.cos,sin:Math.sin,dot:(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0),...values};
    return Function(...Object.keys(scope),`return ${expression};`)(...Object.values(scope));
  };
  const profile=describeGalaxyAppearance(examples.get('ancient-halo'));
  const core=r=>scalar('compactCore',{stellarRadius:r,coreStrength:profile.coreStrength});
  assert.ok(core(0)>core(.5)*50,'elliptical light concentrates toward a small center');
  let previous=Infinity;
  for(let r=0;r<=1;r+=.01){
    const envelope=scalar('envelope',{stellarRadius:r,haloStrength:profile.haloStrength});
    assert.ok(Number.isFinite(envelope)&&envelope>=0&&envelope<=previous);
    assert.ok(envelope<core(0)*.01,'the large envelope cannot become a bright opaque-looking plate');
    previous=envelope;
  }
  const bar=p=>scalar('stellarBar',{bar:1,barMetric:p.map((n,i)=>n/[.36,.055,.07][i])});
  assert.ok(bar([.3,0,0])>bar([0,0,.3])*100,'local x-long bar differs structurally from a round bulge');
  assert.equal(scalar('stellarBar',{bar:0,barMetric:[0,0,0]}),0);
  for(const asymmetry of [0,.25,.5,.75,1]){
    const scales=[0,1,2].map(k=>scalar('individuality',{k,asymmetry}));
    const weights=[0,1,2].map(k=>scalar('islandWeight',{k,asymmetry}));
    assert.ok(scales.every(n=>Number.isFinite(n)&&n>=.56&&n<=1));
    assert.ok(weights.every(n=>Number.isFinite(n)&&n>=.3&&n<=1));
    assert.ok(Math.max(...scales)-Math.min(...scales)>.1);
    assert.ok(Math.max(...weights)-Math.min(...weights)>.2);
  }
  haze.userData.dispose();
});
