import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {WebGLUniforms} from 'three/src/renderers/webgl/WebGLUniforms.js';
import {createGalaxyHaze} from '../../src/render/galaxy-haze.js';
import {randomFromSeed} from '../../src/random.js';
import {noiseEvaluator,hullInterval,fixedGrid,absorptionRule,functionBody} from '../helpers/nebula-optics.mjs';

const descriptor=(id,theme='blue-nursery')=>({id,seed:`optics:${id}`,kind:'nebula',family:'dust-complex',morphology:'irregular',theme,
  radius:1e7,thickness:.42,arms:3,pitch:.33,bar:false,asymmetry:.37,orientation:[.2,.7,-.3]});
function fixture(seed='nebula-optics-regression',descriptors=[descriptor('a')]){
  const group=createGalaxyHaze({seed,structures:true,supportVisibility:new Float32Array(descriptors.length).fill(1)});
  group.userData.setDescriptors(descriptors);
  return{group,material:group.children[0].material,uniforms:group.children[0].material.uniforms};
}
const dot=(a,b)=>a.reduce((s,v,k)=>s+v*b[k],0);
const digest=data=>createHash('sha256').update(data).digest('hex');

test('all loaded dust complexes share one bounded table across descriptor changes and dispose it once',()=>{
  const descriptors=Array.from({length:27},(_,i)=>descriptor(`body-${i}`,i%2?'old-gold':'blue-nursery'));
  const f=fixture(undefined,descriptors),table=f.uniforms.nebulaSharedCorners.value;
  let disposed=0;table.addEventListener('dispose',()=>disposed++);
  try{
    assert.deepEqual([table.image.width,table.image.height,table.image.depth],[96,96,96]);
    assert.equal(table.image.data.byteLength,14155776);
    assert.equal(table.internalFormat,'RGBA32UI');assert.equal(table.format,THREE.RGBAIntegerFormat);
    assert.equal(table.type,THREE.UnsignedIntType);assert.equal(table.minFilter,THREE.NearestFilter);assert.equal(table.magFilter,THREE.NearestFilter);
    assert.equal(table.generateMipmaps,false);
    const domains=[];
    for(const mesh of f.group.children){
      assert.equal(mesh.material.uniforms.nebulaSharedCorners.value,table);
      assert.equal(mesh.material.blending,THREE.NormalBlending);assert.equal(mesh.material.depthWrite,false);
      domains.push(JSON.stringify(mesh.material.uniforms.nebulaNoisePhase.value.map(v=>v.toArray())));
    }
    assert.equal(new Set(domains).size,27);
    f.group.userData.setDescriptors([]);assert.equal(disposed,0);assert.ok(table.image.data);
    f.group.userData.setDescriptors(descriptors.slice(0,2));assert.equal(disposed,0);
    assert.equal(f.group.children[1].material.uniforms.nebulaSharedCorners.value,table);
    const positions=f.group.children.map(m=>m.material.uniforms.nebulaNoisePhase.value.map(v=>v.toArray()));
    f.group.userData.update({centers:[[100,0,0],[-100,0,0]],cameraPosition:[2,3,4],quality:'high',brightness:1,home:false});
    f.group.userData.update({centers:[[100,0,0],[-100,0,0]],cameraPosition:[200,30,40],quality:'high',brightness:1,home:false});
    assert.deepEqual(f.group.children.map(m=>m.material.uniforms.nebulaNoisePhase.value.map(v=>v.toArray())),positions);
  }finally{f.group.userData.dispose();f.group.userData.dispose();}
  assert.equal(disposed,1);assert.equal(table.image.data,null);
});

test('the first structural upload assigns distinct 2D/depth/unsigned-3D sampler units for every kind',()=>{
  const descriptors=['galaxy','cluster','nebula'].map(kind=>({...descriptor(kind),kind,morphology:kind==='galaxy'?'spiral':'irregular'}));
  const f=fixture(undefined,descriptors),table=f.uniforms.nebulaSharedCorners.value;
  let disposed=0;table.addEventListener('dispose',()=>disposed++);
  try{
    for(const mesh of f.group.children){
      // These are the linked active samplers from the failing startup draw.
      // Exercise Three's real first-upload dispatcher and value filtering.
      const active=[{name:'structureNoise',type:0x8b5e,size:1},{name:'uSceneDepth',type:0x8b5e,size:1},{name:'nebulaSharedCorners',type:0x8dd3,size:1}];
      const assignments=new Map(),bindings=[];
      const gl={getProgramParameter:()=>active.length,getActiveUniform:(_,i)=>active[i],getUniformLocation:(_,name)=>name,uniform1i:(name,unit)=>assignments.set(name,unit)};
      let nextUnit=0;
      const textures={allocateTextureUnit:()=>nextUnit++,setTexture2D:(texture,unit)=>bindings.push({texture,unit,target:'2d'}),setTexture3D:(texture,unit)=>bindings.push({texture,unit,target:'3d'})};
      const uniforms=new WebGLUniforms(gl,{}),values=mesh.material.uniforms;
      WebGLUniforms.upload(gl,WebGLUniforms.seqWithValue(uniforms.seq,values),values,textures);
      assert.equal(assignments.size,3,`${mesh.name} must bind every active sampler on its first draw`);
      assert.equal(new Set(assignments.values()).size,3);
      assert.equal(bindings.find(binding=>binding.target==='3d').texture,table);
    }
  }finally{f.group.userData.dispose();}
  assert.equal(disposed,1,'all structural materials share one owned integer table');
});

test('packed corners reproduce periodic integer hashes and the world seed deterministically',()=>{
  const f=fixture(),table=f.uniforms.nebulaSharedCorners.value,data=table.image.data;
  const random=randomFromSeed('nebula-optics-regression:nebula-shared-lattice-v1'),seed=Math.floor(random()*4294967296)>>>0;
  const hash=(x,y,z)=>{let h=(Math.imul(x,0x8da6b343)^Math.imul(y,0xd8163841)^Math.imul(z,0xcb1ab31f)^seed)>>>0;h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);return(h^(h>>>16))>>>0;};
  let expected;
  try{
    for(const x of [0,1,47,94,95])for(const y of [0,1,47,94,95])for(const z of [0,1,47,94,95])for(let c=0;c<4;c++)
      assert.equal(data[(x+96*(y+96*z))*4+c],hash((x+(c&1))%96,(y+(c>>1))%96,z));
    expected=digest(data);
  }finally{f.group.userData.dispose();}
  for(const [seed,equal]of [['nebula-optics-regression',true],['another-nebula-world',false]]){
    const repeat=fixture(seed);try{assert.equal(digest(repeat.uniforms.nebulaSharedCorners.value.image.data)===expected,equal);}finally{repeat.group.userData.dispose();}
  }
});

test('uploaded noise derivatives follow the same corners, domain transform and filtered value',()=>{
  const f=fixture(),shader=f.material.fragmentShader,vector=noiseEvaluator(shader,f.uniforms),scalar=noiseEvaluator(shader,f.uniforms,true),random=randomFromSeed('gradient-points');
  try{
    for(let n=0;n<48;n++)for(let level=0;level<3;level++){
      const p=[random()*2-1,random()*2-1,random()*2-1],frequency=[6.8,21.2,46.8][level],fp=random()*.003,evaluate=level===0?vector:scalar;
      const sample=evaluate(p,frequency,level,fp),epsilon=1e-6/frequency;
      for(let axis=0;axis<3;axis++){
        const lo=p.slice(),hi=p.slice();lo[axis]-=epsilon;hi[axis]+=epsilon;
        const a=evaluate(lo,frequency,level,fp),b=evaluate(hi,frequency,level,fp);
        for(let channel=0;channel<sample.value.length;channel++){
          assert.ok(Math.abs((b.value[channel]-a.value[channel])/(2*epsilon)-sample.gradient[axis*3+channel])<2e-5);
          assert.ok(Number.isFinite(sample.value[channel])&&Math.abs(sample.value[channel])<=1);
        }
      }
      const matrix=f.uniforms.nebulaNoiseDomain.value[level].elements;
      // Shift by one period along a transformed domain axis, including negative coordinates.
      const shifted=p.map((v,axis)=>v+96/frequency*matrix[axis*3]);
      const periodic=evaluate(shifted,frequency,level,fp);
      for(let channel=0;channel<sample.value.length;channel++)assert.ok(Math.abs(sample.value[channel]-periodic.value[channel])<1e-12);
    }
  }finally{f.group.userData.dispose();}
});

test('AABB grazing cannot relocate existing hull nodes or create the observed diagonal seam',()=>{
  const f=fixture();try{
    const nodes=fixedGrid(f.material.fragmentShader),entry=0,exit=1.1812840851859994;
    // Native inside witness: the basal AABB first intersects at1.1770346R,
    // extending the dust envelope from.9093082R to the hull end. The previous
    //61+3 allocation moved every earlier node and caused a.00933 radiance jump.
    const ion={x:0,y:1.062921383468917},oldDust={x:0,y:.9093082454279164},grazedDust={x:0,y:exit};
    const a=nodes(entry,exit,oldDust,ion),b=nodes(entry,exit,grazedDust,ion);
    assert.ok(a.length<b.length);assert.ok(b.length<=128);
    assert.deepEqual(a.filter(n=>n.distance<oldDust.y).map(n=>n.distance),b.filter(n=>n.distance<oldDust.y).map(n=>n.distance));
    const integrate=points=>{let C=0,T=1;for(const n of points){const rho=n.distance<.88?(.8+.2*Math.cos(n.distance*13)):0,tau=24*rho*n.weight,S=.3+.1*Math.sin(n.distance*7),absorbed=-Math.expm1(-tau);C+=T*absorbed*S;T*=Math.exp(-tau);}return{C,T};};
    assert.deepEqual(integrate(a),integrate(b),'empty support appearance cannot change earlier optical transfer');
    assert.ok(a.every(n=>n.distance>entry&&n.distance<exit));
  }finally{f.group.userData.dispose();}
});

test('inside, outside and opaque-clipped physical intervals bound every positive transfer sample',()=>{
  const f=fixture();try{
    const shader=f.material.fragmentShader,interval=hullInterval(shader),nodes=fixedGrid(shader),absorb=absorptionRule(shader);
    for(const scale of [1,.4,2])for(const stop of [1.5,2,2.75,4,8]){
      const ray=interval([0,0,3],[0,0,-1],scale,10000,()=>stop*scale*10000,dot,Math.sqrt,Math.max,Math.min);
      if(stop<=2){assert.equal(ray,null);continue;}
      assert.equal(ray.entry,2);assert.equal(ray.exit,Math.min(4,stop));
      const samples=nodes(ray.entry,ray.exit,{x:ray.entry,y:ray.exit},null);
      assert.equal(samples.length,128);assert.ok(samples.every(n=>n.distance>ray.entry&&n.distance<ray.exit));
      let C=0,T=1;const rho=.35,S=.7;
      for(const n of samples){const tau=24*rho*scale*n.weight;C+=T*absorb(tau,Math.exp)*S;T*=Math.exp(-tau);}
      const expected=Math.exp(-24*rho*scale*(ray.exit-ray.entry));
      assert.ok(Math.abs(T-expected)<1e-13);assert.ok(Math.abs(C-S*(1-expected))<1e-12);
    }
    const inside=interval([0,0,.2649473605668919],[1,0,0],1,10000,()=>1e15,dot,Math.sqrt,Math.max,Math.min);
    assert.equal(inside.entry,0);assert.ok(inside.exit>0);
    assert.equal(interval([0,0,3],[0,0,1],1,10000,()=>1e15,dot,Math.sqrt,Math.max,Math.min),null);
    for(const tau of [0,1e-16,1e-10,.000999,.001,1,20,100]){
      const value=absorb(tau,Math.exp);assert.ok(Number.isFinite(value)&&value>=0&&value<=1);
      assert.ok(Math.abs(value+Math.expm1(-tau))<5e-14);
    }
  }finally{f.group.userData.dispose();}
});

test('positive dust extinction always has positive source-mixture weight and finite normalized theme colour',()=>{
  const f=fixture(undefined,[descriptor('neutral','other'),descriptor('warm','old-gold'),descriptor('cool','blue-nursery')]);try{
    const body=functionBody(f.material.fragmentShader,'nebulaDust'),content=Function('pillar','wall','nebulaMatter',`return ${body.match(/float content=([^,;]+),rho=/)[1]};`),random=randomFromSeed('density-mixture');
    for(let i=0;i<256;i++){
      const profiles=Array.from({length:12},()=>random()<.7?0:random()),pillar=Math.max(...profiles),wall=random()<.5?0:random(),density=content(pillar,wall,{y:1}),weight=1.5*profiles.reduce((a,b)=>a+b,0)+.85*wall*(1-.7*pillar);
      assert.ok(Number.isFinite(density)&&density>=0&&density<=1.755);
      if(density>0)assert.ok(weight>0);
    }
    const denominator=functionBody(f.material.fragmentShader,'nebulaDensity').match(/tint\/vec3\(([^)]+)\)/)[1].split(',').map(Number);
    const scales=f.group.children.map(m=>m.material.uniforms.tint.value.toArray().map((v,k)=>v/denominator[k]));
    assert.deepEqual(scales[0],[1,1,1]);assert.ok(scales[1][2]<scales[1][0]);assert.ok(scales[2][2]>scales[2][0]);
    assert.ok(scales.flat().every(v=>Number.isFinite(v)&&v>0&&v<1.1));
    const expression=body.match(/vec3 component=excitation\*\(([^;]+?)\*nebulaWarm/)[1];
    const warm=Function('excite0','warm','sqrt',`return ${expression};`);
    for(const E of [0,.01,.25,.5,.99,1]){
      let integral=0;const n=128,a=Math.sqrt(1-E);
      for(let k=0;k<n;k++){const mu=(k+.5)/n,value=warm(E,a*mu,Math.sqrt);assert.ok(Number.isFinite(value)&&value>=0&&value<=.711112);integral+=value/n;}
      assert.ok(Math.abs(integral-2.4*E*(1-E)**2)<1e-12,'diffuse angular kernel preserves the original hemisphere integral');
    }
  }finally{f.group.userData.dispose();}
});
