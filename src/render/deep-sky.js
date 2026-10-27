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
uniform vec3 uSeaWeightsA,uSeaWeightsB;
uniform mat3 uSeaFrame;
uniform float uSeaPhase,uSeaWidth,uSeaQuiet;
uniform sampler2D uSeaDetail;
uniform bool uSeaHasDetail;
float skyHash(vec3 p) { p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z); }
float skyNoise(vec3 p) {
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
vec3 stellarSea(vec3 direction) {
  if(dot(uSeaWeightsA+uSeaWeightsB,vec3(1.))<=.000001)return vec3(0.);
  vec3 d=uSeaFrame*direction;
  vec3 offset=vec3(uSeaPhase,1.7,-2.1);
  float broad=skyNoise(d*3.4+offset);
  float middle=skyNoise(d*14.+offset);
  float fine=skyNoise(d*47.+offset);
  float micro=skyNoise(d*153.+offset)*.65+skyNoise(d*461.+offset)*.35;
  float grain=broad*.3+middle*.24+fine*.24+micro*.22;
  float detail=1.;
  float stellarGrain=.7+micro*.6;
  vec3 observed=vec3(0.);
  if(uSeaHasDetail){
    // Caller-provided celestial-coordinate map supplies resolved stellar/dust
    // detail. The sea frame lays its Galactic plane along this local equator.
    // Shape the detail field with each region's geometry, not just its palette.
    float wave=.22*sin(d.x*3.+uSeaPhase);
    float arcLatitude=length(d.xy-vec2(-.35,-.55))-.9;
    float warpedLatitude=d.y-uSeaWeightsA.y*(wave+.2)
      +uSeaWeightsB.z*(arcLatitude-d.y)*.85;
    vec3 galactic=vec3(d.x,d.z,warpedLatitude);
    galactic*=inversesqrt(max(dot(galactic,galactic),.000001));
    vec3 equatorial=mat3(-.05487556,-.87343709,-.48383502,
      .49410943,-.44482963,.74698224,-.86766615,-.19807637,.45598378)*galactic;
    float longitude=dot(equatorial.xy,equatorial.xy)>.0000001?atan(equatorial.y,equatorial.x):0.;
    vec2 uv=vec2(.5-longitude/6.28318530718,asin(clamp(equatorial.z,-1.,1.))/3.14159265359+.5);
    // Longitude wraps at the meridian. Its implicit derivative spans almost
    // the whole map there, selecting a dark coarse mip in 2x2 fragment quads.
    // Keep the short, periodic footprint while retaining latitude filtering.
    vec2 uvDx=dFdx(uv),uvDy=dFdy(uv);
    uvDx.x-=floor(uvDx.x+.5);
    uvDy.x-=floor(uvDy.x+.5);
    vec3 catalog=textureGrad(uSeaDetail,uv,uvDx,uvDy).rgb;
    observed=catalog;
    float lowFrequency=dot(textureLod(uSeaDetail,uv,6.).rgb,vec3(.2126,.7152,.0722));
    stellarGrain=clamp(dot(catalog,vec3(.2126,.7152,.0722))/max(lowFrequency,.002),.12,3.);
    detail=.45+micro*.65+min(2.,dot(catalog,vec3(.2126,.7152,.0722))*4.);
  }
  float latitude=d.y/uSeaWidth;
  float lane=latitude+(broad-.5)*.17+sin(d.x*4.+uSeaPhase)*.035;
  float dust=exp(-lane*lane*1700.)*(.6+.4*middle);
  float band=exp(-latitude*latitude*32.);
  vec2 bulgePoint=vec2((d.x-.2)/.72,latitude/.23);
  float bulge=exp(-dot(bulgePoint,bulgePoint))*(.3+.7*smoothstep(-.5,.8,d.z));
  vec3 river=mix(vec3(.34,.42,.55),vec3(.88,.66,.4),smoothstep(.3,.7,broad));
  river*=((band*.035+bulge*.04)*(.35+1.5*grain))*(1.-dust*.96)*detail;
  river+=observed*1.15;
  // A folded, asymmetric blue veil; illuminated rim around dark molecular dust.
  float fold=latitude-.2*sin(d.x*3.+uSeaPhase)-.2;
  float veil=exp(-fold*fold*22.)*smoothstep(.25,.72,grain)*(.3+.7*smoothstep(-.8,.5,d.z));
  float vein=smoothstep(.4,.68,middle)*(1.-smoothstep(.38,.64,fine*.6+micro*.4));
  vec3 blue=mix(vec3(.035,.13,.23),vec3(.26,.53,.68),smoothstep(.4,.7,grain));
  blue*=veil*(1.-vein*.86)*.22*detail;
  blue+=observed*vec3(.35,.65,1.)*.45*exp(-fold*fold*8.);
  // Ancient elliptical populations form a broad oval, rather than another band.
  vec3 axis=normalize(vec3(.35,.2,1.));float angle=1.-dot(d,axis);
  float halo=exp(-angle*5.)+exp(-angle*24.)*.65;
  vec3 gold=vec3(1.,.72,.4)*halo*(.018+grain*.055)*stellarGrain;
  // Broken star islands have separated, unequal envelopes and dark gaps.
  float island=exp(-(1.-dot(d,normalize(vec3(-.65,.25,1.))))*17.)
    +.65*exp(-(1.-dot(d,normalize(vec3(.65,-.18,1.))))*28.)
    +.35*exp(-(1.-dot(d,normalize(vec3(.2,.7,.6))))*40.);
  vec3 islands=mix(vec3(.18,.21,.3),vec3(.41,.53,.64),smoothstep(.42,.67,grain));
  islands*=island*(.025+grain*.16)*stellarGrain*(1.-vein*.25);
  // Backlit rift: a broad opaque silhouette splits illuminated banks.
  float rift=latitude+(broad-.5)*.4;
  float banks=exp(-rift*rift*15.)*(1.-exp(-rift*rift*220.)*.98);
  vec3 dark=vec3(.55,.37,.2)*banks*(.025+grain*.12)*detail;
  dark+=observed*vec3(.95,.76,.57)*(1.-exp(-rift*rift*160.)*.9)*1.2;
  // A tidal arc has curvature and a second thinner, offset filament.
  float arc=length(d.xy-vec2(-.35,-.55))-.9;
  float secondArc=arc+.14;
  float filaments=exp(-arc*arc*110.)+.3*exp(-secondArc*secondArc*390.);
  vec3 tide=mix(vec3(.16,.2,.32),vec3(.52,.57,.65),grain);
  tide*=filaments*(.04+grain*.12)*smoothstep(-.25,.5,d.z)*detail;
  tide+=observed*vec3(.75,.8,1.)*filaments*.9;
  return (river*uSeaWeightsA.x+blue*uSeaWeightsA.y+gold*uSeaWeightsA.z
    +islands*uSeaWeightsB.x+dark*uSeaWeightsB.y+tide*uSeaWeightsB.z)*uSeaQuiet;
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
  return sky+stellarSea(d);
}`;

export function deepSkyUniforms({detailTexture = null} = {}) {
  return {uSkyTint:{value:new THREE.Color(.55,.6,.66)},uSkyBandNormal:{value:new THREE.Vector3(0,1,0)},
    uSkyBrightness:{value:.012},uSkyBandStrength:{value:0},uSkyStarDensity:{value:.12},
    uSeaWeightsA:{value:new THREE.Vector3()},uSeaWeightsB:{value:new THREE.Vector3()},
    uSeaFrame:{value:new THREE.Matrix3()},uSeaPhase:{value:0},uSeaWidth:{value:1},uSeaQuiet:{value:1},
    uSeaDetail:{value:detailTexture},uSeaHasDetail:{value:Boolean(detailTexture)}};
}
export function setDeepSkyEnvironment(uniforms, environment, quiet = 0) {
  if (!environment) return;
  uniforms.uSkyTint.value.fromArray(environment.ambientTint);
  uniforms.uSkyBandNormal.value.fromArray(environment.bandNormal);
  uniforms.uSkyBrightness.value = environment.skyBrightness * (1 - Math.max(0,Math.min(1,quiet))*.35);
  uniforms.uSkyBandStrength.value = environment.bandStrength;
  uniforms.uSkyStarDensity.value = environment.starDensity;
  const sea = environment.starSea;
  uniforms.uSeaWeightsA.value.fromArray(sea?.weights ?? [0,0,0]);
  if (sea) uniforms.uSeaWeightsB.value.fromArray(sea.weights,3);
  else uniforms.uSeaWeightsB.value.set(0,0,0);
  if (sea) {uniforms.uSeaFrame.value.fromArray(sea.frame);uniforms.uSeaPhase.value=sea.phase;uniforms.uSeaWidth.value=sea.width;}
  uniforms.uSeaQuiet.value=1-Math.max(0,Math.min(1,quiet))*.15;
}
export function createDeepSky({detailTexture = null} = {}) {
  const geometry = new THREE.SphereGeometry(100000,32,20);
  const material = new THREE.ShaderMaterial({uniforms:deepSkyUniforms({detailTexture}),
    vertexShader:'varying vec3 skyDirection;void main(){skyDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`varying vec3 skyDirection;${DEEP_SKY_GLSL}\nvoid main(){gl_FragColor=vec4(deepSky(skyDirection),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
    side:THREE.BackSide,depthWrite:false,depthTest:false});
  const group=new THREE.Group(),mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=-1000;mesh.frustumCulled=false;group.add(mesh);
  let disposed=false;
  group.userData.update=(environment,quiet)=>{if(!disposed)setDeepSkyEnvironment(material.uniforms,environment,quiet);};
  group.userData.dispose=()=>{if(disposed)return;disposed=true;geometry.dispose();material.dispose();};
  return group;
}
