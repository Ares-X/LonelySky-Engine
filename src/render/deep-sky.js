import * as THREE from 'three';

// The compact power-ten spark kernel has this mean over a unit lattice cell:
// 4*pi*integral(r^2 * (1 - 2.1*r)^10, r=0..1/2.1).
export const DEEP_SKY_SPARK_FILTER = Object.freeze({
  mean: 8 * Math.PI / (2.1 ** 3 * 11 * 12 * 13),
  densityWidth: .0002,
  resolvedFootprint: .06,
  unresolvedFootprint: .3,
});

// Shared directional radiance for the sky and black-hole lens. World geometry
// owns its orientation and density; time and camera turning never reseed it.
export const DEEP_SKY_GLSL = /* glsl */`
uniform vec3 uSkyTint;
uniform vec3 uSkyBandNormal;
uniform float uSkyBrightness;
uniform float uSkyBandStrength;
uniform float uSkyStarDensity;
float skyHash(vec3 p) { p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z); }
float skyNoise(vec3 p) {
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
vec3 deepSky(vec3 direction) {
  vec3 d=normalize(direction);
  float grain=skyNoise(d*11.)*.6+skyNoise(d*31.+17.)*.27+skyNoise(d*79.+29.)*.13;
  float latitude=abs(dot(d,uSkyBandNormal));
  float band=exp(-latitude*latitude*105.)*uSkyBandStrength;
  float dust=smoothstep(.26,.74,grain);
  vec3 sky=uSkyTint*uSkyBrightness*(.11+band*(1.2+3.8*dust));
  // Very faint unresolved points keep a lens from showing a painted photograph.
  vec3 cell=floor(d*720.); float star=skyHash(cell);
  float spark=pow(max(0.,1.-length(fract(d*720.)-.5)*2.1),10.);
  float probability=clamp(uSkyStarDensity,0.,1.)*.009;
  float densityWidth=min(${DEEP_SKY_SPARK_FILTER.densityWidth},probability);
  float population=probability>0.?smoothstep(1.-probability-densityWidth,1.-probability+densityWidth,star):0.;
  // Filter only unresolved spark detail. Clouds and the stellar band retain
  // their directional radiance; no clock or screen-space random pattern enters.
  float footprint=length(fwidth(d*720.));
  float resolved=1.-smoothstep(${DEEP_SKY_SPARK_FILTER.resolvedFootprint},${DEEP_SKY_SPARK_FILTER.unresolvedFootprint},footprint);
  float filteredSpark=mix(${DEEP_SKY_SPARK_FILTER.mean}*probability,spark*population,resolved);
  sky+=vec3(.55,.63,.7)*filteredSpark*.22;
  return sky;
}`;

export function deepSkyUniforms() {
  return {uSkyTint:{value:new THREE.Color(.55,.6,.66)},uSkyBandNormal:{value:new THREE.Vector3(0,1,0)},
    uSkyBrightness:{value:.012},uSkyBandStrength:{value:0},uSkyStarDensity:{value:.12}};
}
export function setDeepSkyEnvironment(uniforms, environment, quiet = 0) {
  if (!environment) return;
  uniforms.uSkyTint.value.fromArray(environment.ambientTint);
  uniforms.uSkyBandNormal.value.fromArray(environment.bandNormal);
  uniforms.uSkyBrightness.value = environment.skyBrightness * (1 - Math.max(0,Math.min(1,quiet))*.35);
  uniforms.uSkyBandStrength.value = environment.bandStrength;
  uniforms.uSkyStarDensity.value = environment.starDensity;
}
export function createDeepSky() {
  const geometry = new THREE.SphereGeometry(100000,32,20);
  const material = new THREE.ShaderMaterial({uniforms:deepSkyUniforms(),
    vertexShader:'varying vec3 skyDirection;void main(){skyDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`varying vec3 skyDirection;${DEEP_SKY_GLSL}\nvoid main(){gl_FragColor=vec4(deepSky(skyDirection),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
    side:THREE.BackSide,depthWrite:false,depthTest:false});
  const group=new THREE.Group(),mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=-1000;mesh.frustumCulled=false;group.add(mesh);
  let disposed=false;
  group.userData.update=(environment,quiet)=>{if(!disposed)setDeepSkyEnvironment(material.uniforms,environment,quiet);};
  group.userData.dispose=()=>{if(disposed)return;disposed=true;geometry.dispose();material.dispose();};
  return group;
}
