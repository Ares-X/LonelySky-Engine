import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {acquireHabitatCloudNoise,HABITAT_CLOUD_NOISE_SIZE,HABITAT_CLOUD_NOISE_PERIOD,HABITAT_CONDENSATION_NORMALIZER,HABITAT_HEIGHT_CHANNEL_MEANS,HABITAT_HEIGHT_WEATHER} from '../../src/render/ring-habitat-cloud-noise.js';

function sample(texture,p,channel=0){
  const {data,width:n}=texture.image;
  const q=p.map(x=>x/HABITAT_CLOUD_NOISE_PERIOD*n-.5),i=q.map(Math.floor),f=q.map((x,k)=>x-i[k]);
  const wrap=x=>(x%n+n)%n;
  let value=0;
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){
    const weight=(x?f[0]:1-f[0])*(y?f[1]:1-f[1])*(z?f[2]:1-f[2]);
    value+=data[(wrap(i[0]+x)+n*(wrap(i[1]+y)+n*wrap(i[2]+z)))*4+channel]/255*weight;
  }
  return value;
}

test('one bounded RGBA8 tile stores four ordered density knots with a joint normalizer',()=>{
  const lease=acquireHabitatCloudNoise();
  try{
    const texture=lease.texture,{data,width,height,depth}=texture.image;
    assert.deepEqual([width,height,depth],[HABITAT_CLOUD_NOISE_SIZE,HABITAT_CLOUD_NOISE_SIZE,HABITAT_CLOUD_NOISE_SIZE]);
    assert.equal(data.byteLength,128**3*4,'one shared real tile has a bounded 8 MiB RGBA8 base level');
    assert.equal(texture.format,THREE.RGBAFormat);assert.equal(texture.internalFormat,'RGBA8');
    assert.equal(texture.colorSpace,THREE.NoColorSpace);
    assert.equal(texture.generateMipmaps,true);assert.equal(texture.minFilter,THREE.LinearMipmapLinearFilter);
    assert.equal(texture.magFilter,THREE.LinearFilter);
    assert.deepEqual([texture.wrapS,texture.wrapT,texture.wrapR],[THREE.RepeatWrapping,THREE.RepeatWrapping,THREE.RepeatWrapping]);
    const totals=[0,0,0,0];let empty=0,dense=0;
    for(let i=0;i<data.length;i+=4){
      assert.ok(data[i]<=data[i+1]&&data[i+1]<=data[i+2]&&data[i+2]<=data[i+3],'density is monotone in the condensation control');
      for(let k=0;k<4;k++)totals[k]+=data[i+k];
      if(data[i+3]===0)empty++;if(data[i+3]===255)dense++;
    }
    assert.ok(empty>0&&dense>0,'the full knot retains empty pores and finite dense interiors');
    assert.ok(totals.every((sum,k)=>sum>0&&(k===0||sum>=totals[k-1])));
    assert.equal(lease.normalizer,HABITAT_CONDENSATION_NORMALIZER);
    assert.equal('mean' in lease,false,'the calibration denominator must not masquerade as a raw texture mean');
    assert.ok(Number.isFinite(lease.normalizer)&&lease.normalizer>0);
    assert.ok(totals.every(sum=>Math.abs(sum/(255*128**3)-lease.normalizer)>.01),'channel means and joint calibration have different semantics');
    for(let k=0;k<4;k++)assert.ok(Math.abs(totals[k]/(255*128**3)-HABITAT_HEIGHT_CHANNEL_MEANS[k])<1e-12,'coarse density consumes actual linear mip channel means');
    for(const delta of [[256,0,0],[0,256,0],[0,0,256]]){
      let variation=0;
      for(let i=0;i<40;i++){
        const p=[i*137.1+31,i*71.3-41,i*51.7+211],b=p.map((v,k)=>v+delta[k]);
        variation+=Math.abs(sample(texture,p,3)-sample(texture,b,3));
      }
      assert.ok(variation>.5,'density must vary along all three body axes');
    }
  }finally{lease.release();}
});

test('height channel means and climate weather-area calibration are finite immutable owner data',()=>{
  assert.equal(HABITAT_HEIGHT_CHANNEL_MEANS.length,4);
  assert.ok(HABITAT_HEIGHT_CHANNEL_MEANS.every((value,k)=>Number.isFinite(value)&&value>0&&value<=1&&(k===0||value>=HABITAT_HEIGHT_CHANNEL_MEANS[k-1])));
  assert.equal(HABITAT_HEIGHT_WEATHER.length,4);
  for(const [area,weightedRaw] of HABITAT_HEIGHT_WEATHER){
    assert.ok(Number.isFinite(area)&&area>0&&area<1);
    assert.ok(Number.isFinite(weightedRaw)&&weightedRaw>0&&weightedRaw<1);
  }
  for(const values of [HABITAT_HEIGHT_CHANNEL_MEANS,HABITAT_HEIGHT_WEATHER,...HABITAT_HEIGHT_WEATHER]){
    assert.throws(()=>{values[0]=0;},TypeError);
    assert.throws(()=>values.push(1),TypeError);
  }
});

test('linear mip averaging commutes with knot interpolation after nonlinear density baking',()=>{
  const clamp=x=>Math.max(0,Math.min(1,x)),smooth=x=>{const t=clamp(x/.08);return t*t*(3-2*t);};
  // Independent piecewise interpolation reference, including the zero knot.
  function interpolate(channels,c){
    const position=c*4,index=Math.min(3,Math.floor(position)),fraction=position-index;
    if(position>=4)return channels[3];
    return (index===0?0:channels[index-1])*(1-fraction)+channels[index]*fraction;
  }
  const potentials=[.2,.8],baked=potentials.map(b=>[.25,.5,.75,1].map(c=>smooth(b+c-1)));
  const meanChannels=baked[0].map((value,k)=>(value+baked[1][k])*.5);
  for(let i=0;i<=100;i++){
    const c=i/100,filteredFirst=interpolate(meanChannels,c),interpolatedFirst=(interpolate(baked[0],c)+interpolate(baked[1],c))*.5;
    assert.ok(Math.abs(filteredFirst-interpolatedFirst)<1e-14);
  }
  assert.equal(interpolate(meanChannels,.5),.5);
  assert.equal(smooth((potentials[0]+potentials[1])*.5+.5-1),0,'thresholding the mean raw potential would erase this half-covered voxel');
});

test('repeating density interpolation remains continuous at all fixed world-tile seams',()=>{
  const lease=acquireHabitatCloudNoise();
  try{
    for(const axis of [0,1,2])for(const position of [31.7,2199.3,5701.1])for(let channel=0;channel<4;channel++){
      const p=[position,position*.71,position*.39],copy=p.slice();copy[axis]+=HABITAT_CLOUD_NOISE_PERIOD;
      assert.ok(Math.abs(sample(lease.texture,p,channel)-sample(lease.texture,copy,channel))<1e-12);
      const a=p.slice(),b=p.slice();a[axis]=-.001;b[axis]=.001;
      assert.ok(Math.abs(sample(lease.texture,a,channel)-sample(lease.texture,b,channel))<.0001);
    }
  }finally{lease.release();}
});

test('empty and real leases share independently, release once, and recreate deterministic bytes after retirement',()=>{
  const empty=acquireHabitatCloudNoise({empty:true}),emptyB=acquireHabitatCloudNoise({empty:true});
  const a=acquireHabitatCloudNoise(),b=acquireHabitatCloudNoise();
  let replacement;
  try{
    assert.equal(empty.texture,emptyB.texture);assert.notEqual(empty.texture,a.texture);
    assert.equal(empty.texture.image.data.byteLength,4);assert.deepEqual(Array.from(empty.texture.image.data),[0,0,0,0]);
    assert.equal(empty.normalizer,1);assert.equal('mean' in empty,false);assert.equal(empty.texture.generateMipmaps,false);
    assert.equal(a.texture,b.texture);
    const digest=createHash('sha256').update(a.texture.image.data).digest('hex');
    let releases=0,emptyReleases=0;
    a.texture.addEventListener('dispose',()=>releases++);
    empty.texture.addEventListener('dispose',()=>emptyReleases++);
    a.release();a.release();
    assert.equal(releases,0);assert.ok(b.texture.image.data instanceof Uint8Array);
    empty.release();empty.release();assert.equal(emptyReleases,0);
    b.release();assert.equal(releases,1);assert.equal(b.texture.image.data,null);
    assert.ok(emptyB.texture.image.data instanceof Uint8Array);
    replacement=acquireHabitatCloudNoise();
    assert.notEqual(replacement.texture,b.texture);
    assert.equal(createHash('sha256').update(replacement.texture.image.data).digest('hex'),digest);
    a.release();b.release();assert.equal(releases,1,'an old released lease cannot retire the new generation');
    emptyB.release();assert.equal(emptyReleases,1);assert.equal(emptyB.texture.image.data,null);
  }finally{a.release();b.release();empty.release();emptyB.release();replacement?.release();}
});
