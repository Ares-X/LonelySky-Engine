import * as THREE from 'three';
import {createAppearanceRandom} from './appearance-random.js';
import {GAS_SIGNED_SIMPLEX_GLSL} from './gas-simplex-noise.js';

const TAU = Math.PI * 2;
const STORM_COUNT = 3;
// Belt strength, upper-deck latitude and half-width distinguish the
// equatorial bank, one-sided polar cap and storm-dominated clear deck.
const deckLayouts = [[.88, 0, .27], [.72, .68, .34], [.46, .25, .16]];
const styles = [
  // Deep jet, upper haze, storm condensate, bands, turbulence, storm count.
  [[.22,.099,.046],[.72,.53,.32],[.68,.245,.091],18,.76,2],
  [[.19,.064,.052],[.78,.405,.235],[.53,.125,.069],13,1.2,3],
  [[.052,.154,.17],[.39,.67,.63],[.10,.37,.38],23,.79,2],
  [[.087,.088,.223],[.55,.54,.77],[.25,.206,.52],11,1.02,3],
  [[.27,.30,.36],[.79,.79,.73],[.61,.48,.33],27,.48,1],
];

// Use the full identity and phase when a generated descriptor has no numeric seed.
export function gasMacroProfile(body) {
  const random = createAppearanceRandom(body.id, body.seed ?? body.phase);
  const [deep, upper, condensate, frequency, turbulence, stormCount] = styles[Math.floor(random() * styles.length)];
  const origin = [random() * 64, random() * 64, random() * 64];
  const bands = [frequency * (.85 + random() * .30), random() * TAU, turbulence, random()];
  const jetRates = [.017 + random() * .025, -.012 - random() * .023];
  const storms = [];
  const stormStart = random() * TAU;
  for (let i = 0; i < stormCount; i++) {
    const latitude = i === 0 ? (random() < .5 ? -1 : 1) * (.14 + random() * .29) : (i === 1 ? -.64 : .47) + random() * .16;
    const phase = latitude * bands[0] + bands[1] + Math.sin(latitude * 8) * (1.4 * bands[3]);
    const blend = Math.max(0, Math.min(1, (Math.sin(phase) + .42) / .84));
    const jet = blend * blend * (3 - 2 * blend);
    const width = i === 0 ? .20 + random() * .24 : .09 + random() * .11;
    const height = width * (.35 + random() * .30);
    const strength = i === 0 ? .83 + random() * .17 : .49 + random() * .29;
    const rate = jetRates[0] * jet + jetRates[1] * (1 - jet);
    const spin = (latitude < 0 ? -1 : 1) * (.28 + random() * .42);
    storms.push({longitude: stormStart + i * TAU / stormCount + random() * .30,
      latitude, width, height, strength, rate, spin});
  }
  const microVelocity = [(8 + random() * 16) * (random() < .5 ? -1 : 1), random() * 3 - 1.5, 7 + random() * 12];
  const [beltStrength, latitude, width] = deckLayouts[Math.floor(random() * deckLayouts.length)];
  const deck = [beltStrength, latitude * (random() < .5 ? -1 : 1), width * (.88 + .24 * random())];
  return {origin, bands, deck, jetRates, storms, deep:deep.slice(), upper:upper.slice(), condensate:condensate.slice(), microVelocity};
}

export function gasMacroUniforms() {
  return {
    uGasMacroOrigin:{value:new THREE.Vector3()}, uGasMacroBands:{value:new THREE.Vector4()}, uGasDeck:{value:new THREE.Vector3()},
    uGasDeep:{value:new THREE.Vector3()}, uGasUpper:{value:new THREE.Vector3()}, uGasCondensate:{value:new THREE.Vector3()},
    uGasJetRotations:{value:new THREE.Vector4(1,0,1,0)},
    uGasStormShape:{value:Array.from({length:STORM_COUNT}, () => new THREE.Vector4())},
    uGasStormMotion:{value:Array.from({length:STORM_COUNT}, () => new THREE.Vector4())},
  };
}

export function bindGasMacroIdentity(entry, body) {
  const seed = body.seed ?? body.phase;
  if (entry.gasMacroId === body.id && entry.gasMacroSeed === seed) return;
  const profile = gasMacroProfile(body), u = entry.uniforms;
  u.uGasMacroOrigin.value.fromArray(profile.origin);
  u.uGasMacroBands.value.fromArray(profile.bands);
  u.uGasDeck.value.fromArray(profile.deck);
  u.uGasDeep.value.fromArray(profile.deep);
  u.uGasUpper.value.fromArray(profile.upper);
  u.uGasCondensate.value.fromArray(profile.condensate);
  for (let i = 0; i < STORM_COUNT; i++) {
    const shape = u.uGasStormShape.value[i];
    if (i >= profile.storms.length) { shape.set(0,0,0,0); continue; }
    const storm = profile.storms[i];
    shape.set(storm.latitude, 1 / storm.width, 1 / storm.height, storm.strength);
  }
  entry.gasMacroId = body.id;
  entry.gasMacroSeed = seed;
  entry.gasMacroProfile = profile;
  entry.gasMacroTime = NaN;
}

// Reduce each angle by its own actual period before conversion to shader floats.
// Saved far-future clocks retain their small increments and wrapping is continuous.
function gasPhase(time, rate) {
  return rate === 0 ? 0 : (time % (TAU / Math.abs(rate))) * rate;
}

export function bindGasMacroTime(entry, time) {
  if (entry.gasMacroTime === time) return;
  entry.gasMacroTime = time;
  const {jetRates, storms} = entry.gasMacroProfile, u = entry.uniforms;
  const east = gasPhase(time, -jetRates[0]), west = gasPhase(time, -jetRates[1]);
  u.uGasJetRotations.value.set(Math.cos(east), Math.sin(east), Math.cos(west), Math.sin(west));
  for (let i = 0; i < storms.length; i++) {
    const storm = storms[i];
    const longitude = storm.longitude + gasPhase(time, storm.rate), spin = gasPhase(time, -storm.spin);
    u.uGasStormMotion.value[i].set(Math.cos(longitude), Math.sin(longitude), Math.cos(spin), Math.sin(spin));
  }
}

// Artist-directed inverse transport. Independent counterflow jets and drifting
// storm centres carry cloud parcels; this is a visual model with no fluid solver.
export const GAS_CLOUD_MACRO_GLSL = /* glsl */`
${GAS_SIGNED_SIMPLEX_GLSL}
uniform vec3 uGasMacroOrigin,uGasDeep,uGasUpper,uGasCondensate,uGasDeck;
uniform vec4 uGasMacroBands,uGasJetRotations,uGasStormShape[${STORM_COUNT}],uGasStormMotion[${STORM_COUNT}];
vec2 gasRotate(vec2 p,vec2 rotation){
  return vec2(rotation.x*p.x-rotation.y*p.y,rotation.y*p.x+rotation.x*p.y);
}
float gasBeltWave(float phase,float pixelFrequency){
  return .5+.5*sin(phase)*(1.-smoothstep(.5,1.8,pixelFrequency));
}
float gasBeltPhase(float latitude){
  return latitude*uGasMacroBands.x+uGasMacroBands.y+sin(latitude*8.)*(1.4*uGasMacroBands.w);
}
vec3 gasMacroFlow(vec3 normal,float footprint,out vec3 stormField){
  vec3 flow=normal;
  stormField=vec3(0.);
  for(int i=0;i<${STORM_COUNT};i++){
    vec4 shape=uGasStormShape[i],motion=uGasStormMotion[i];
    float vertical=(normal.y-shape.x)*shape.z;
    if(shape.w<=0.||abs(vertical)>=1.4||dot(normal.xz,motion.xy)<=0.)continue;
    vec2 tangent=vec2(-motion.y,motion.x);
    vec2 offset=vec2(dot(normal.xz,tangent)*shape.y,vertical);
    float radius=length(offset);
    if(radius>=1.4)continue;
    float mask=1.-smoothstep(.22,1.4,radius);
    float turn=(1.-smoothstep(.02,1.4,radius))*3.4;
    vec2 wound=gasRotate(offset,vec2(cos(turn),sin(turn)));
    // The outer vortex shears and entrains the same belts that own coverage.
    flow.xz+=tangent*((wound.x-offset.x)/shape.y)*mask*shape.w;
    flow.y+=((wound.y-offset.y)/shape.z)*mask*shape.w;
    // Clouds orbit in the vortex frame. Spiralling feeder filaments fade into
    // the band flow; the low-contrast centre is covered by neighbouring decks.
    vec2 spiral=gasRotate(wound,motion.zw);
    float armPhase=spiral.y*10.+radius*13.+sin(spiral.x*5.+radius*3.)*.5;
    float arms=gasBeltWave(armPhase,footprint*max(shape.y,shape.z)*22.);
    float perimeter=smoothstep(.12,.42,radius)*(1.-smoothstep(.66,1.37,radius));
    float strength=mask*shape.w*(1.-smoothstep(.08,.38,footprint*shape.z));
    if(strength>stormField.x)stormField=vec3(strength,arms,perimeter);
  }
  return flow;
}
float gasJetWeight(float phase){return smoothstep(-.42,.42,sin(phase));}
vec3 gasJetPoint(vec3 p,vec2 rotation,vec2 scale,vec3 offset){
  vec2 xz=gasRotate(p.xz,rotation);
  return vec3(xz.x*scale.x,p.y*scale.y,xz.y*scale.x)+offset;
}
float gasJetWarp(vec3 p,float footprint){
  float weight=gasJetWeight(gasBeltPhase(p.y));
  vec2 scale=vec2(4.,17.);
  float east=weight>0.?filteredBodyNoise(gasJetPoint(p,uGasJetRotations.xy,scale,uGasMacroOrigin),footprint*17.):0.;
  float west=weight<1.?filteredBodyNoise(gasJetPoint(p,uGasJetRotations.zw,scale,uGasMacroOrigin+19.3),footprint*17.):0.;
  return mix(west,east,weight)-.5;
}
// Shared by the atmospheric column and visible deck reflectance.
float gasDeckCover(float latitude,float belt){
  float bank=1.-smoothstep(uGasDeck.z*.42,uGasDeck.z*1.36,abs(latitude-uGasDeck.y));
  float belts=.41+(belt-.5)*.61*uGasDeck.x;
  return mix(belts,.75,bank*(1.-.27*belt));
}
float gasMacroCoverage(vec3 normal,float footprint){
  vec3 storm;
  vec3 flow=gasMacroFlow(normal,footprint,storm);
  float broad=gasJetWarp(flow,footprint);
  float latitude=flow.y+broad*.17*uGasMacroBands.z;
  float belt=gasBeltWave(gasBeltPhase(latitude),footprint*uGasMacroBands.x);
  return clamp(gasDeckCover(latitude,belt)+broad*.22+storm.x*(.14+storm.y*.12*storm.z),0.,1.);
}
float gasJetFilaments(vec3 q,float detail){
  float strands=gmSimplex(q);
  float folds=detail>0.?gmSimplex(q*2.07):0.;
  return strands*.76+folds*.24*detail;
}
float gasFilaments(vec3 flow,float footprint){
  float resolved=1.-smoothstep(.20,.85,footprint*52.);
  if(resolved<=0.)return 0.;
  float weight=gasJetWeight(gasBeltPhase(flow.y));
  vec2 scale=vec2(9.,52.);
  float detail=1.-smoothstep(.23,.88,footprint*110.);
  float east=weight>0.?gasJetFilaments(gasJetPoint(flow,uGasJetRotations.xy,scale,uGasMacroOrigin+57.1),detail):0.;
  float west=weight<1.?gasJetFilaments(gasJetPoint(flow,uGasJetRotations.zw,scale,uGasMacroOrigin+92.4),detail):0.;
  return mix(west,east,weight)*resolved;
}
vec3 gasMacroAlbedo(vec3 normal,float footprint){
  vec3 storm;
  vec3 flow=gasMacroFlow(normal,footprint,storm);
  float warp=gasJetWarp(flow,footprint);
  float latitude=flow.y+warp*.17*uGasMacroBands.z;
  float phase=gasBeltPhase(latitude), scale=footprint*uGasMacroBands.x;
  float cloud=gasBeltWave(phase,scale), streak=gasBeltWave(2.4*phase+latitude*4.,scale*2.6);
  float strands=gasFilaments(flow,footprint);
  float cover=gasDeckCover(latitude,cloud)+(streak-.5)*.13+warp*.3+strands*.27;
  vec3 albedo=mix(uGasDeep,uGasUpper,smoothstep(.10,.95,cover));
  vec3 vortex=mix(uGasCondensate,uGasUpper,clamp(.26+storm.y*.44+strands*.5,0.,1.));
  albedo=mix(albedo,vortex,storm.x*(.34+storm.z*.34));
  albedo*=1.+.14*strands+.12*warp;
  return albedo*(.85+.24*uTint);
}
`;
