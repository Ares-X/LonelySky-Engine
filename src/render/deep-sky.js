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
uniform vec3 uSeaMorphA,uSeaMorphB,uSeaMorphC,uSeaMorphD,uSeaMorphE,uSeaMorphF;
uniform vec3 uSeaCool,uSeaWarm,uSeaAccent,uSeaOffset;
uniform vec4 uSeaShape,uSeaStructure,uSeaDust,uSeaState;
float skyHash(vec3 p) { p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z); }
float skyNoise(vec3 p) {
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
// Eighteen spatial building blocks share seeded population, erosion and light.
// Their controls are interpolated in world space, never chosen by a screen or clock.
vec3 stellarSea(vec3 direction) {
  vec3 sumWeights=uSeaMorphA+uSeaMorphB+uSeaMorphC+uSeaMorphD+uSeaMorphE+uSeaMorphF;
  if(dot(sumWeights,vec3(1.))<=.000001)return vec3(0.);
  vec3 d=uSeaFrame*direction;
  vec3 offset=uSeaOffset+vec3(uSeaPhase,1.7,-2.1);
  float broad=skyNoise(d*3.4+offset);
  float middle=skyNoise(d*(10.+uSeaStructure.z*12.)+offset+vec3(broad,-broad,broad)*4.);
  float fine=skyNoise(d*83.+offset+vec3(middle,broad,-middle)*9.);
  float micro=skyNoise(d*331.+offset)*.65+skyNoise(d*811.+offset)*.35;
  micro=mix(micro,.5,smoothstep(.5,1.4,length(fwidth(d*811.))));
  float grain=broad*.34+middle*.3+fine*.22+micro*.14;
  float stellarGrain=.7+micro*.6;
  if(uSeaHasDetail){
    // Borrow only filtered high-frequency stellar grain. The catalogue's
    // recognizable Galactic panorama must never determine another galaxy's shape.
    vec3 galactic=normalize(d+vec3(uSeaOffset.xy*.013,0.));
    vec3 equatorial=mat3(-.05487556,-.87343709,-.48383502,
      .49410943,-.44482963,.74698224,-.86766615,-.19807637,.45598378)*galactic;
    float longitude=dot(equatorial.xy,equatorial.xy)>.0000001?atan(equatorial.y,equatorial.x):0.;
    vec2 uv=vec2(.5-longitude/6.28318530718,asin(clamp(equatorial.z,-1.,1.))/3.14159265359+.5);
    vec2 uvDx=dFdx(uv),uvDy=dFdy(uv);
    uvDx.x-=floor(uvDx.x+.5);
    uvDy.x-=floor(uvDy.x+.5);
    vec3 catalog=textureGrad(uSeaDetail,uv,uvDx,uvDy).rgb;
    float lowFrequency=dot(textureLod(uSeaDetail,uv,5.).rgb,vec3(.2126,.7152,.0722));
    float grainRatio=dot(catalog,vec3(.2126,.7152,.0722))/max(lowFrequency,.003);
    stellarGrain*=mix(.8,1.2,clamp(grainRatio*.5,0.,1.));
  }
  float stretch=uSeaShape.x,warp=uSeaShape.y,core=uSeaShape.z,spread=uSeaShape.w;
  float arms=uSeaStructure.x,pitch=uSeaStructure.y,clump=uSeaStructure.z,asymmetry=uSeaStructure.w;
  float width=uSeaWidth*(.65+spread*.5);
  float latitude=d.y/width;
  float warped=latitude+(broad-.5)*warp+sin(d.x*pitch+uSeaPhase)*warp*.3;
  float dustLane=exp(-pow(warped/max(.012,uSeaDust.y),2.));
  float eroded=smoothstep(.28,.78,middle+fine*.18-uSeaDust.z*.18);
  float transmission=exp(-uSeaDust.x*(dustLane*1.5+eroded*.32)*uSeaState.w);
  float cloud=pow(max(0.,broad*.5+middle*.35+fine*.15),1.8+clump)*2.4;
  float band=exp(-latitude*latitude*(16.+28.*stretch));
  float front=smoothstep(-.2,.45,d.z),sideFront=smoothstep(-.2,.45,d.x);
  vec2 p=vec2(d.x-.14-asymmetry*.25,d.y-.10)/max(.35,d.z+.3);
  vec2 side=vec2(d.z+asymmetry*.22,d.y)/max(.3,d.x+.3);
  p.x*=stretch;side.x*=stretch;
  float radius=length(p),sideRadius=length(side);
  vec3 oldColor=mix(uSeaCool,uSeaWarm,(1.-uSeaState.x)*.75);
  vec3 color=mix(oldColor,uSeaCool,smoothstep(.35,.72,grain)*uSeaState.x);
  float mass=0.,nucleus=0.,birth=0.;
  if(uSeaMorphA.x>0.) { // broad dust river, with a displaced compact bulge
    float bulge=exp(-pow((d.z-asymmetry*.6)/(.28+core),2.)-latitude*latitude*38.)*sideFront;
    mass+=uSeaMorphA.x*(band*(.25+cloud*1.4)+bulge*core*1.5)*transmission;
    nucleus+=uSeaMorphA.x*bulge*core;
  }
  if(uSeaMorphA.y>0.) { // folded asymmetric reflection curtain
    float fold=latitude-warp*sin(d.x*pitch+uSeaPhase)-asymmetry*.4;
    float veil=exp(-fold*fold*(18.+stretch*14.))*(.2+cloud*1.6)*sideFront;
    mass+=uSeaMorphA.y*veil*exp(-eroded*uSeaDust.x*.65);
    birth+=uSeaMorphA.y*veil*.35;
  }
  if(uSeaMorphA.z>0.) { // ancient elliptical population
    float ell=length(p/vec2(.5+spread,.28+core*.7));
    float halo=exp(-pow(ell,1.35)*3.2)*front;
    mass+=uSeaMorphA.z*halo*(.3+cloud*.65);
    nucleus+=uSeaMorphA.z*exp(-ell*ell*(18.+core*20.))*front*(1.+core);
  }
  if(uSeaMorphB.x>0.) { // unequal stellar islands with real dark gaps
    float islands=0.;
    for(int i=0;i<3;i++){
      float k=float(i),angle=k*2.3+uSeaPhase*.5;
      vec2 center=vec2(cos(angle),sin(angle))*(.14+k*.15)*spread;
      islands+=exp(-dot(p-center,p-center)*(30.+k*23.)/(.5+spread))*(1.-k*.23);
    }
    mass+=uSeaMorphB.x*islands*front*(.2+cloud*1.6);
    birth+=uSeaMorphB.x*islands*front*cloud;
  }
  if(uSeaMorphB.y>0.) { // wide absorbing rift with irregular banks
    float lane=warped+(middle-.5)*warp*.65;
    float banks=exp(-lane*lane*(8.+stretch*6.));
    float gap=exp(-lane*lane/(.002+uSeaDust.y*.28));
    mass+=uSeaMorphB.y*banks*(.4+cloud*1.3)*exp(-gap*uSeaDust.x*2.4);
  }
  if(uSeaMorphB.z>0.) { // curved tidal arc
    float arc=length((p+vec2(.25,.55))/vec2(1.,.7+spread*.4))-(.58+spread*.28);
    float curve=exp(-arc*arc*(90.+stretch*70.));
    mass+=uSeaMorphB.z*curve*front*(.15+cloud)*transmission;
    birth+=uSeaMorphB.z*curve*front*cloud*.4;
  }
  if(uSeaMorphC.x+uSeaMorphC.y>0.) { // barred / fragmented spiral populations
    float theta=sideRadius>.00001?atan(side.y,side.x):0.;
    float armCount=floor(arms);
    float winding=-log(sideRadius+.07)*pitch+uSeaPhase+(broad-.5)*warp;
    float armA=pow(max(0.,.5+.5*cos(theta*armCount+winding)),4.-clump*1.5);
    float armB=pow(max(0.,.5+.5*cos(theta*(armCount+1.)+winding)),4.-clump*1.5);
    float spiral=mix(.3,mix(armA,armB,fract(arms)),smoothstep(.025,.12,sideRadius));
    float envelope=exp(-pow(sideRadius,1.35)/( .18+spread*.4))*sideFront;
    float bridge=exp(-side.x*side.x/(.05+core*.2)-side.y*side.y*280.);
    mass+=uSeaMorphC.x*envelope*(.1+spiral*(.3+cloud)+bridge*core)*transmission;
    mass+=uSeaMorphC.y*envelope*(spiral*pow(cloud,1.7)*2.+.12)*transmission;
    nucleus+=(uSeaMorphC.x+uSeaMorphC.y)*exp(-sideRadius*sideRadius*120.)*sideFront*(.3+core);
    birth+=(uSeaMorphC.x+uSeaMorphC.y)*envelope*spiral*cloud;
  }
  if(uSeaMorphC.z>0.) { // hollow ionization shell with an eroded bright rim
    float shell=length(side/vec2(.55+spread*.4,.35+core*.5))-.65+(broad-.5)*warp*.8+(middle-.5)*warp*.2;
    float rim=exp(-shell*shell*(100.+stretch*80.))*(.3+smoothstep(.25,.7,middle));
    mass+=uSeaMorphC.z*rim*sideFront*(.25+cloud*1.5)*exp(-eroded*uSeaDust.x*.4);
    birth+=uSeaMorphC.z*rim*sideFront;
  }
  if(uSeaMorphD.x>0.) { // flowing filaments, separated rather than a solid cloud
    float strands=0.;
    for(int i=0;i<3;i++){
      float k=float(i),fold=latitude-(k-1.)*(.12+spread*.12)-warp*sin(d.x*pitch+k+uSeaPhase);
      strands+=exp(-fold*fold*(180.+k*70.))*(1.-k*.2);
    }
    mass+=uSeaMorphD.x*strands*sideFront*(.15+cloud)*transmission;
  }
  if(uSeaMorphD.y>0.) { // flattened stellar lens and faint annular envelope
    float lens=length(p/vec2(.8+spread*.4,.13+core*.16));
    mass+=uSeaMorphD.y*(exp(-lens*2.8)+exp(-pow(lens-.9,2.)*60.)*.3)*front*(.5+cloud*.5);
    nucleus+=uSeaMorphD.y*exp(-lens*lens*12.)*front;
  }
  if(uSeaMorphD.z>0.) { // diffuse asymmetric ellipsoid
    vec2 stretched=p/vec2(.4+core,.4+spread*.5);
    float oval=exp(-pow(length(stretched),1.7)*2.6);
    mass+=uSeaMorphD.z*oval*front*(.25+cloud*.7)*(.7+asymmetry*p.x);
    nucleus+=uSeaMorphD.z*exp(-dot(stretched,stretched)*35.)*front*core;
  }
  if(uSeaMorphE.x>0.) { // starburst: many unequal young knots, no regular outline
    float knots=0.;
    for(int i=0;i<5;i++){
      float k=float(i),angle=k*2.399+uSeaPhase;
      vec2 center=vec2(cos(angle),sin(angle))*sqrt(k+.2)*(.1+spread*.12);
      knots+=exp(-dot(p-center,p-center)*(65.+k*24.))*(1.-k*.12);
    }
    mass+=uSeaMorphE.x*knots*front*(.3+cloud*1.5);
    birth+=uSeaMorphE.x*knots*front*1.2;
  }
  if(uSeaMorphE.y>0.) { // tidally pulled clusters joined by a curved, faint bridge
    vec2 a=p-vec2(-.3,asymmetry),b=p-vec2(.35,-asymmetry*.5);
    float pair=exp(-dot(a,a)*25.)+exp(-dot(b,b)*55.)*.65;
    float bridge=exp(-pow(p.y-asymmetry*cos(p.x*3.),2.)*200.-p.x*p.x*3.)*.22;
    mass+=uSeaMorphE.y*(pair+bridge)*front*(.25+cloud)*transmission;
    birth+=uSeaMorphE.y*pair*front*.6;
  }
  if(uSeaMorphE.z>0.) { // braided absorbing columns against scattered light
    float wave=warp*sin(d.z*pitch+uSeaPhase);
    float braid=exp(-pow(side.x-wave,2.)*80.)+exp(-pow(side.x+wave+.22,2.)*120.);
    float backlight=exp(-side.x*side.x*4.-side.y*side.y*3.)*sideFront;
    mass+=uSeaMorphE.z*backlight*(.3+cloud)*exp(-braid*uSeaDust.x*(.6+middle));
    birth+=uSeaMorphE.z*backlight*pow(cloud,3.)*.4;
  }
  if(uSeaMorphF.x>0.) { // an empty molecular eye bounded by illuminated dust
    float eye=length(side/vec2(.6+spread*.3,.3+core*.4))+(broad-.5)*warp;
    float rim=exp(-pow(eye-.75,2.)*32.);
    float opening=exp(-eye*eye*6.);
    mass+=uSeaMorphF.x*rim*sideFront*(.3+cloud*1.2)*exp(-opening*uSeaDust.x*2.);
  }
  if(uSeaMorphF.y>0.) { // a long tidal tail with a fading, uneven taper
    float tail=p.y-warp*sin(p.x*pitch+uSeaPhase)-asymmetry*p.x;
    float stream=exp(-tail*tail*(90.+stretch*80.))*exp(-p.x*p.x*(.5+core));
    mass+=uSeaMorphF.y*stream*front*(.15+cloud)*transmission;
    nucleus+=uSeaMorphF.y*exp(-dot(p+vec2(.35,0.),p+vec2(.35,0.))*90.)*front*core;
  }
  if(uSeaMorphF.z>0.) { // broken annulus with irregular, one-sided tidal debris
    float ring=length(p/vec2(.55+spread*.3,.35+core*.4))-.85+(broad-.5)*warp*.8;
    float fragments=smoothstep(.25,.7,middle+asymmetry*p.x);
    mass+=uSeaMorphF.z*exp(-ring*ring*85.)*fragments*front*(.3+cloud*1.4);
    birth+=uSeaMorphF.z*exp(-ring*ring*85.)*fragments*front*.4;
  }
  float youngKnots=pow(smoothstep(.55,.82,fine),3.)*birth*uSeaState.x;
  vec3 radiance=color*max(0.,mass)*stellarGrain*uSeaDust.w
    +uSeaWarm*nucleus*(.5+core)+uSeaAccent*youngKnots*.65;
  return radiance*uSeaState.y*uSeaState.z*uSeaQuiet;
}
vec3 deepSky(vec3 direction) {
  vec3 d=normalize(direction);
  float grain=skyNoise(d*11.)*.6+skyNoise(d*31.+17.)*.27+skyNoise(d*79.+29.)*.13;
  float latitude=dot(d,uSkyBandNormal);
  float warpedLatitude=latitude+(grain-.5)*.065;
  float band=exp(-warpedLatitude*warpedLatitude*105.)*uSkyBandStrength;
  // Dark absorbing lanes interrupt a broader stellar population. Noise belongs
  // to the sky direction, so turning or lensing cannot make the dust swim.
  float dustLatitude=(latitude+(grain-.5)*.12)/.023;
  float dust=exp(-dustLatitude*dustLatitude);
  float transmission=exp(-dust*(1.6+grain*2.4));
  float stellarCloud=.55+2.6*smoothstep(.28,.72,grain);
  vec3 stellarTint=mix(vec3(.73,.82,1.),vec3(1.08,.95,.78),smoothstep(.3,.7,grain));
  vec3 sky=uSkyTint*uSkyBrightness*(.055+band*stellarCloud*stellarTint*transmission);
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

// Defaults retain the public pre-profile starSea descriptor contract. New
// callers supply all appearance controls; the renderer only copies their data.
const SEA_PROFILE = {
  cool: [.3,.45,.65], warm: [.8,.55,.32], accent: [.62,.7,.9], offset: [0,0,0],
  shape: [1,.2,.3,.65], structure: [3,2.8,.5,0], dust: [1,.035,.4,1], state: [.4,.15,1,.5],
};
const MORPH_GROUPS = ['A','B','C','D','E','F'];

export function deepSkyUniforms({detailTexture = null} = {}) {
  const uniforms = {uSkyTint:{value:new THREE.Color(.55,.6,.66)},uSkyBandNormal:{value:new THREE.Vector3(0,1,0)},
    uSkyBrightness:{value:.012},uSkyBandStrength:{value:0},uSkyStarDensity:{value:.12},
    uSeaWeightsA:{value:new THREE.Vector3()},uSeaWeightsB:{value:new THREE.Vector3()},
    uSeaFrame:{value:new THREE.Matrix3()},uSeaPhase:{value:0},uSeaWidth:{value:1},uSeaQuiet:{value:1},
    uSeaDetail:{value:detailTexture},uSeaHasDetail:{value:Boolean(detailTexture)}};
  for (const suffix of MORPH_GROUPS) uniforms[`uSeaMorph${suffix}`] = {value:new THREE.Vector3()};
  for (const [name,values] of Object.entries(SEA_PROFILE)) {
    uniforms[`uSea${name[0].toUpperCase()+name.slice(1)}`] = {value:values.length===4?new THREE.Vector4(...values):new THREE.Vector3(...values)};
  }
  return uniforms;
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
  const profile = sea?.appearance;
  for (let group=0;group<MORPH_GROUPS.length;group++) {
    const offset=group*3;
    // Published descriptors without an appearance still address the original
    // six shapes. Clearing an environment also clears every new light source.
    const weights=profile?.morphologyWeights;
    uniforms[`uSeaMorph${MORPH_GROUPS[group]}`].value.set(...[0,1,2].map(i=>weights?.[offset+i]??(offset+i<6?sea?.weights?.[offset+i]??0:0)));
  }
  for (const [name,defaults] of Object.entries(SEA_PROFILE)) {
    uniforms[`uSea${name[0].toUpperCase()+name.slice(1)}`].value.fromArray(profile?.[name]??defaults);
  }
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
