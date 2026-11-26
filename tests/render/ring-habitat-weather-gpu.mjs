// Browser-only check of the production implicit weather and billows.
import * as THREE from 'three';
import {COSMIC_BODY_NOISE_GLSL} from '../../src/render/cosmic-body-noise.js';
import {HABITAT_PROCEDURAL_CHANNEL_MEANS,RING_HABITAT_AIR_GLSL} from '../../src/render/ring-habitat-atmosphere.js';
import {RING_HABITAT_WEATHER_FIELD_GLSL} from '../../src/render/ring-habitat-weather-field.js';

const SIZE=96;
const VERTEX=`in vec3 position;void main(){gl_Position=vec4(position.xy,0.,1.);}`;
const BILLOWS=RING_HABITAT_AIR_GLSL.slice(RING_HABITAT_AIR_GLSL.indexOf('vec4 habitatCloudBillows('),RING_HABITAT_AIR_GLSL.indexOf('vec4 habitatCloudBounds('));
const WEATHER=RING_HABITAT_AIR_GLSL.slice(RING_HABITAT_AIR_GLSL.indexOf('vec3 habitatCloudGeography('),RING_HABITAT_AIR_GLSL.indexOf('float habitatCloudDensity('));
const FRAGMENT=`precision highp float;precision highp int;
uniform vec3 uHabitatWind;
uniform float uBodyRadius,uGroundRadius,uPhase;
uniform int uHabitatClimate;
uniform vec2 uHabitatBand;
uniform bool uSeam;
layout(location=0) out vec4 result;
${COSMIC_BODY_NOISE_GLSL}
${RING_HABITAT_WEATHER_FIELD_GLSL}
const vec4 HABITAT_HEIGHT_CHANNEL_MEANS=vec4(${HABITAT_PROCEDURAL_CHANNEL_MEANS.join(',')});
${BILLOWS}
${WEATHER}
void main(){
  vec2 uv=gl_FragCoord.xy/${SIZE}.;
  float angle=(uv.x-.5)*6.283185307179586;
  if(uSeam)angle=mod(floor(gl_FragCoord.x),2.)==0.?3.14159255:-3.14159255;
  vec3 p=vec3(cos(angle)*uGroundRadius,mix(uHabitatBand.x,uHabitatBand.y,uv.y),sin(angle)*uGroundRadius);
  vec3 seed=habitatWeatherSeed(uPhase);
  vec3 detail=p*uBodyRadius+seed+uHabitatWind;
  result=vec4(habitatCloudWeather(p,uGroundRadius,seed),habitatCloudBillows(detail,20.).w,habitatCloudBillows(detail,1000.).w);
}`;

export function runRingHabitatWeatherGpuChecks({reversedDepthBuffer=false,descriptor}){
  const canvas=document.createElement('canvas'),renderer=new THREE.WebGLRenderer({canvas,antialias:false,reversedDepthBuffer});
  const geometry=new THREE.PlaneGeometry(2,2),scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const target=new THREE.WebGLRenderTarget(SIZE,SIZE,{format:THREE.RGBAFormat,type:THREE.FloatType,depthBuffer:false});
  const uniforms={uBodyRadius:{value:descriptor.bodyRadius},uHabitatClimate:{value:descriptor.climate},uPhase:{value:descriptor.phase},
    uGroundRadius:{value:descriptor.groundRadius},uHabitatWind:{value:new THREE.Vector3()},
    uHabitatBand:{value:new THREE.Vector2(descriptor.minY,descriptor.maxY)},uSeam:{value:false}};
  const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:VERTEX,fragmentShader:FRAGMENT,uniforms,depthTest:false,depthWrite:false});
  const quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const still=new Float32Array(SIZE*SIZE*4),moving=new Float32Array(still.length),seam=new Float32Array(still.length);
  const capture=pixels=>{renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,SIZE,SIZE,pixels);};
  try{
    if(!renderer.extensions.has('EXT_color_buffer_float'))return {supported:false,reason:'EXT_color_buffer_float required',reversedDepthBuffer};
    if(reversedDepthBuffer&&!renderer.capabilities.reversedDepthBuffer)return {supported:false,reason:'EXT_clip_control required',reversedDepthBuffer};
    capture(still);
    uniforms.uHabitatWind.value.set(1400,120,900);capture(moving);
    uniforms.uSeam.value=true;capture(seam);
    let changedWeather=0,changedBillows=0,maxSeamDelta=0;
    for(let i=0;i<still.length;i+=4){
      for(const data of [still,moving,seam])for(let j=0;j<4;j++){
        const value=data[i+j];if(!Number.isFinite(value)||value<0||value>1)throw new Error('Unbounded cloud field');
      }
      if(Math.abs(still[i+1]-moving[i+1])>.01)changedWeather++;
      if(Math.abs(still[i+2]-moving[i+2])>.01)changedBillows++;
      if(Math.abs(still[i+3]-HABITAT_PROCEDURAL_CHANNEL_MEANS[3])>.0001)throw new Error('Unresolved billows did not filter to their mean: '+still[i+3]);
      if(i%8===0)maxSeamDelta=Math.max(maxSeamDelta,Math.abs(seam[i]-seam[i+4]),Math.abs(seam[i+1]-seam[i+5]));
    }
    if(changedWeather===0||changedBillows===0)throw new Error('Wind did not advance weather and billows');
    if(maxSeamDelta>.003)throw new Error('Analytic weather is discontinuous across the ring seam');
    if(renderer.getContext().getError()!==0)throw new Error('Analytic weather GPU check failed');
    return {supported:true,reversedDepthBuffer:renderer.capabilities.reversedDepthBuffer,samples:SIZE*SIZE,changedWeather,changedBillows,maxSeamDelta};
  }finally{
    scene.clear();geometry.dispose();material.dispose();target.dispose();renderer.dispose();renderer.forceContextLoss();canvas.remove();
  }
}
