/** Fixed, sparse natural-ring solids and a finite unresolved-micrograin layer.
 * STATIC_NO_ORBIT: no orbit/gravity evolution, no shader motion. Lengths are L.
 */
import {SolidQueryFailure as NaturalRingQueryFailure} from './solid-geometry.js';
export {SolidQueryFailure as NaturalRingQueryFailure} from './solid-geometry.js';
import {hashSeed,randomFromSeed} from './random.js';
import {buildTerrainMesh} from './mesh-terrain.js';
import {cosmicSolidsInBounds} from './cosmic-bodies.js';

export const NATURAL_RING = Object.freeze({revision:1,mode:'STATIC_NO_ORBIT',tile:512,slots:8,
  inner:1.25,outer:2.1,gap:1.65,gapWidth:.025,halfHeight:64,maxRockRadius:32,
  visibleTiles:81,visibleCapacity:648,queryTiles:256,queryCapacity:2048,cacheTiles:256,
  fadeStart:1400,fadeEnd:1800,maxParentRadius:1200000});
const RADII=[3,8,18,32],WEIGHTS=[.45,.32,.18,.05];
const TAU=Math.PI*2;
const faces=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
function randomFrame(random){
  // Uniform unit quaternion, converted to the shared world-to-local frame.
  const u=random(),a=random()*TAU,b=random()*TAU;
  const x=Math.sqrt(1-u)*Math.sin(a),y=Math.sqrt(1-u)*Math.cos(a),z=Math.sqrt(u)*Math.sin(b),w=Math.sqrt(u)*Math.cos(b);
  return [1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)];
}
function makePrototypes(){
  const t=(1+Math.sqrt(5))/2;
  const unit=[[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]];
  return RADII.map((radius,type)=>{
    const random=randomFromSeed(`natural-ring-v1:prototype:${type}`);
    const vertices=unit.map(p=>{const k=radius*(.87+random()*.13)/Math.hypot(...p);return p.map(v=>v*k);});
    const normals=vertices.map(p=>{const k=1/Math.hypot(...p);return p.map(v=>v*k);});
    return buildTerrainMesh({center:[0,0,0],radius,vertices,normals,faces:faces.map(f=>f.slice())});
  });
}
// Tiny immutable shared shapes, not one BVH/geometry per rock or visited body.
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const NATURAL_RING_PROTOTYPES=freeze(makePrototypes());
let meanProjectedArea=0;
for(let k=0;k<4;k++){
  let area=0;const mesh=NATURAL_RING_PROTOTYPES[k];
  for(const f of mesh.faces){const a=mesh.vertices[f[0]],b=mesh.vertices[f[1]],c=mesh.vertices[f[2]];
    const x=b[0]-a[0],y=b[1]-a[1],z=b[2]-a[2],u=c[0]-a[0],v=c[1]-a[1],w=c[2]-a[2];
    area+=Math.hypot(y*w-z*v,z*u-x*w,x*v-y*u)*.5;}
  meanProjectedArea+=WEIGHTS[k]*area*.25;
}
// Expected projected coarse coverage for isotropic orientations before admission.
// A small mean subtraction, not exact per-pixel optical energy conservation.
export const NATURAL_RING_COARSE_COLUMN=NATURAL_RING.slots*meanProjectedArea/NATURAL_RING.tile**2;
// The resolved optical population and residual medium share one LOD policy.
// These grains are static display microstructure, not collision/orbit bodies.
export const NATURAL_RING_GRAIN_LOD=Object.freeze({share:.95,fadeStart:450,fadeEnd:700});
export function naturalRingReferenceAlpha(r){
  if(r<NATURAL_RING.inner||r>NATURAL_RING.outer)return 0;
  const gap=(r-NATURAL_RING.gap)/NATURAL_RING.gapWidth;
  return (.62+.15*Math.sin(r*330))*(1-.8*Math.exp(-gap*gap))*.72;
}
export function naturalRingMicroTau(r,nearWeight=0){
  const alpha=naturalRingReferenceAlpha(r);
  return -Math.log1p(-alpha)-NATURAL_RING_COARSE_COLUMN*alpha*nearWeight;
}
export function describeNaturalRing(body){
  if(body.kind!=='gas-giant'||body.ringed!==true)return null;
  if(!(Number.isFinite(body.radius)&&body.radius>0&&body.radius<=NATURAL_RING.maxParentRadius)
    ||typeof body.id!=='string'||!Array.isArray(body.frame)||body.frame.length!==9||!body.frame.every(Number.isFinite))
    throw new RangeError('Invalid natural ring parent radius/frame');
  return {parentId:body.id,radius:body.radius,inner:body.radius*NATURAL_RING.inner,
    outer:body.radius*NATURAL_RING.outer,halfHeight:NATURAL_RING.halfHeight,mode:NATURAL_RING.mode};
}
function radialInterval(ox,oz,dx,dz,radius,minimum,maximum,out){
  const a=dx*dx+dz*dz,b=ox*dx+oz*dz,c=ox*ox+oz*oz-radius*radius;
  if(a===0){if(c>=0)return false;out[0]=minimum;out[1]=maximum;return true;}
  const cross=ox*dz-oz*dx,disc=a*radius*radius-cross*cross;
  if(disc<=0)return false;
  const root=Math.sqrt(disc),q=-b-(b>=0?root:-root);
  const first=q/a,second=c/q;
  out[0]=Math.max(minimum,Math.min(first,second));out[1]=Math.min(maximum,Math.max(first,second));
  return out[1]>out[0];
}
export function createNaturalRingOpticalWorkspace(solar=false){return {outer:new Float64Array(2),inner:new Float64Array(2),intervals:new Float64Array(4),point:new Float64Array(3),direction:new Float64Array(3),material:{response:0,albedo:1,resolvedWeight:0},sun:solar?null:createNaturalRingOpticalWorkspace(true),result:{alpha:0,opticalDepth:0,nearest:Infinity,intervalCount:0,transmission:1,radiance:0}};}
/** At most two exact finite annular-slab intervals; directions need not be unit. */
export function naturalRingIntervals(origin,ray,radius,minimum,maximum,w){
  if(!(Array.isArray(origin)||ArrayBuffer.isView(origin))||!(Array.isArray(ray)||ArrayBuffer.isView(ray))||origin.length!==3||ray.length!==3||!origin.every(Number.isFinite)||!ray.every(Number.isFinite)
    ||Math.hypot(ray[0],ray[1],ray[2])===0||!Number.isFinite(radius)||radius<=0||!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<0||maximum<minimum)throw new RangeError('Invalid natural ring optical ray interval');
  const out=w.intervals;out.fill(0);w.result.intervalCount=0;let lo=minimum,hi=maximum;
  if(ray[1]===0){if(Math.abs(origin[1])>=NATURAL_RING.halfHeight)return 0;}
  else {const a=(-NATURAL_RING.halfHeight-origin[1])/ray[1],b=(NATURAL_RING.halfHeight-origin[1])/ray[1];lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));}
  if(hi<=lo||!radialInterval(origin[0],origin[2],ray[0],ray[2],radius*NATURAL_RING.outer,lo,hi,w.outer))return 0;
  lo=w.outer[0];hi=w.outer[1];
  if(!radialInterval(origin[0],origin[2],ray[0],ray[2],radius*NATURAL_RING.inner,lo,hi,w.inner)){
    out[0]=lo;out[1]=hi;w.result.intervalCount=1;return 1;
  }
  let count=0;
  if(w.inner[0]>lo){out[0]=lo;out[1]=w.inner[0];count++;}
  if(w.inner[1]<hi){out[count*2]=w.inner[1];out[count*2+1]=hi;count++;}
  w.result.intervalCount=count;return count;
}
/** Static artistic optical field in L, independent of the unchanged v1 rock
 * placement. Its vertical integral is the declared local normal optical depth.
 * No self-gravity, orbital evolution, multiple scattering or grain-resolved
 * shadowing is modeled. CPU and GLSL share the point field and finite transport;
 * far complete thin columns additionally use positive subpixel T/C quadrature. */
export const NATURAL_RING_OPTICS=Object.freeze({viewSteps:32,sunSteps:8,albedo:.84,incidentIrradiance:1.05*Math.PI,ambientRadiance:.035,tailTransmission:1e-4});
// Shared gain preserves the annular area-weighted normal optical mass while
// replacing deep diagonal pores with weak static angular clumps.
// Frozen static optical morphology; 64 unequal radial plateaus, not orbital evolution.
export const NATURAL_RING_ART_PROFILE=Object.freeze([[0,0.004813426014838339,0.20334330561161043,0.0007701481623741342,0.8493400011979975,0],[0.004813426014838339,0.024575949954227908,0.31167324409782887,0.0012,0.8331885614036583,0.37],[0.024575949954227908,0.05234778896699518,0.13521751318573955,0.0012,0.8471825631638058,0.74],[0.05234778896699518,0.05857608399236566,0,0.0009965272040592776,0.834652710154187,1.1099999999999999],[0.05857608399236566,0.06913515777639229,0.22279366825819016,0.0012,0.9440021447674372,1.48],[0.06913515777639229,0.0771888498089287,0.31804433361589907,0.0012,0.878202812706586,1.85],[0.0771888498089287,0.10570243980818785,0.2713007213294506,0.0012,0.8480599855375476,2.2199999999999998],[0.10570243980818785,0.1307564575251849,0.2862346119850874,0.0012,0.8599517283099704,2.59],[0.1307564575251849,0.13480690499200929,0.22025329184532166,0.0006480715946919035,0.8837403337308206,2.96],[0.13480690499200929,0.13959613696224749,0.2602941939622164,0.000766277115238112,0.9299023537500761,3.33],[0.13959613696224749,0.1620859797746248,0.9838902006093412,0.0012,0.7110323744895869,1.91],[0.1620859797746248,0.19118688195655292,1.09213994397223,0.0012,0.747142891662661,2.28],[0.19118688195655292,0.21876275126193234,0.6363462003674358,0.0012,0.7196548361866736,2.65],[0.21876275126193234,0.22302613498990087,1.107380908858031,0.0006821413964749646,0.7068507535685785,3.0199999999999996],[0.22302613498990087,0.22928525982675907,0.5308230845797807,0.0010014599738973119,0.618523864268791,3.3899999999999997],[0.22928525982675907,0.24848185972897613,0.7033032630160452,0.0012,0.6604379597888329,3.76],[0.24848185972897613,0.26513491058303523,0.5030661449562759,0.0012,0.6875224977335893,4.13],[0.26513491058303523,0.2849331745083536,0,0.0012,0.6947225735825487,4.5],[0.2849331745083536,0.30257438147440413,0.985650736073032,0.0012,0.6691793062794023,4.87],[0.30257438147440413,0.32797190517998254,0.7013719906806946,0.0012,0.7111564091243782,5.24],[0.32797190517998254,0.33525132567628707,1.1881461787559093,0.0011647072794087254,0.269703257586807,3.82],[0.33525132567628707,0.34207199286145673,1.402011247139424,0.0010913067496271455,0.24741645605769008,4.1899999999999995],[0.34207199286145673,0.35055406995458543,1.4979819662459193,0.0012,0.3503248252812773,4.56],[0.35055406995458543,0.3600117736729571,1.5249372351728379,0.0012,0.29078877564985306,4.93],[0.3600117736729571,0.37292361720807743,1.9929925443567336,0.0012,0.29900947254151106,5.3],[0.37292361720807743,0.3971503616797374,0,0.0012,0.5855255783046596,5.7299999999999995],[0.3971503616797374,0.4036549543061769,0,0.0010407348202303268,0.4918856671289541,6.1],[0.4036549543061769,0.4226869548225179,0.12,0.0012,0.5689398752502166,6.47],[0.4226869548225179,0.43609846876820246,0,0.0012,0.5457487079990097,6.84],[0.43609846876820246,0.44245829675153625,0,0.001017572477333406,0.5610903616505676,7.209999999999999],[0.44245829675153625,0.48657982389421967,0.7779816357791426,0.0012,0.1737410756223835,7.64],[0.48657982389421967,0.5047896155178007,1.0955507095195354,0.0012,0.1883796697645448,8.01],[0.5047896155178007,0.5232409096567443,1.1337188272550704,0.0012,0.18995617925422265,8.379999999999999],[0.5232409096567443,0.5315614622796088,1.3883564287535848,0.0012,0.07677967843366787,8.75],[0.5315614622796088,0.5371107727638348,0,0.0008878896774761636,0.18918388983467593,9.12],[0.5371107727638348,0.5822506219109586,1.420325783837587,0.0012,0.0654322401783429,9.49],[0.5822506219109586,0.5905118042143733,1.0031551632508637,0.0012,0.06555123058380559,9.86],[0.5905118042143733,0.6078496225549612,1.4065185224674643,0.0012,0.17270515809534118,10.23],[0.6078496225549612,0.6169951400828477,0.7043386713266373,0.0012,0.05296546001220122,10.6],[0.6169951400828477,0.6459210502344271,1.2144628066457808,0.0012,0.093927561880555,10.969999999999999],[0.6459210502344271,0.6741708346688972,0.844121633924544,0.0012,0.18496209438191724,11.34],[0.6741708346688972,0.6842201438461956,0.8777553103379907,0.0012,0.15633070372743532,11.71],[0.6842201438461956,0.7041493208865995,1.1002071855813267,0.0012,0.04532441454241053,12.079999999999998],[0.7041493208865995,0.7201965410569712,0,0.0012,0.11436961360042915,12.45],[0.7201965410569712,0.7269363635746524,0.883738798968494,0.0010783716028289982,0.1430682071414776,12.82],[0.7269363635746524,0.7324319578577699,1.376863255377859,0.0008792950852988035,0.0627693638834171,13.19],[0.7324319578577699,0.7556437711450386,0.16123474126160142,0.0012,0.4296409731288441,9.549999999999999],[0.7556437711450386,0.7671807790841985,0.13845006949156521,0.0012,0.5095017408276908,9.919999999999998],[0.7671807790841985,0.7889913830907362,0.09927523121237754,0.0012,0.4730150009528734,10.29],[0.7889913830907362,0.8003863037752413,0.0706293793514371,0.0012,0.5335706374398432,10.659999999999998],[0.8003863037752413,0.8264177333096369,0.6580025650370868,0.0012,0.18457446574931965,11.459999999999999],[0.8264177333096369,0.8580946460707249,0.66218419245407,0.0012,0.23428009347291665,11.829999999999998],[0.8580946460707249,0.8838414002518573,0.7014382679011674,0.0012,0.213401594448369,12.2],[0.8838414002518573,0.8879201131797629,0.5694117531865835,0.0006525940684649001,0.25756578393513335,12.569999999999999],[0.8879201131797629,0.8932638645264687,0.9526732007328421,0.0008550002154729164,0.22748868150403723,12.94],[0.8932638645264687,0.9255984620854166,0.6031421252198518,0.0012,0.20615177675383164,13.309999999999999],[0.9255984620854166,0.9329570553980785,0.5584137487631292,0.0011773749300258984,0.2670010916586034,13.68],[0.9329570553980785,0.9369674661113105,0.3850393735334278,0.0006416657141171278,0.17390512353042142,14.049999999999999],[0.9369674661113105,0.9633607939486746,0.7138452919740231,0.0012,0.18351986195659264,14.419999999999998],[0.9633607939486746,0.9682653327067938,0,0.0007847262012990796,0.1458555574459024,14.79],[0.9682653327067938,0.978713593579182,0.5016410429891199,0.0012,0.19859577889321373,15.16],[0.978713593579182,0.9915433737893978,0.7654068020105363,0.0012,0.25945953134680166,15.53],[0.9915433737893978,0.9959911509790065,0.7164810412142426,0.0007116443503373838,0.19799681493779644,15.899999999999999],[0.9959911509790065,1,0.40976837202087046,0.0006414158433589634,0.24804199020611123,16.27]].map(Object.freeze));
const RING_ART_AREA=2.8475000000000001,RING_ART_MASS=.675,RING_ART_A=0.62566479482165216,RING_ART_B=-0.0092195573698334293,RING_ART_C=-0.0058282297546845925;
function ringArtIndex(u){let low=0,high=63;for(let i=0;i<6;i++){const middle=(low+high)>>1;if(u<NATURAL_RING_ART_PROFILE[middle][1])high=middle;else low=middle+1;}return low;}
function ringArtGain(phase){const p=phase*6.283185307179586;return RING_ART_MASS/(RING_ART_A+RING_ART_B*Math.sin(p)+RING_ART_C*Math.cos(p));}
// Each adaptive cell has an odd compact quintic lobe: integral zero,
// endpoint value/derivative zero, absolute value <=1. Unequal splits are
// body-fixed and need no lookup texture or growing cache.
function ringArtLobe(s,seed,levels,footprint=0){
  if(s<=0||s>=1)return 0;let q=s,key=seed,width=1;
  for(let level=0;level<levels;level++){
    const h=key*.7548776662466927+.569840290998;const cut=.28+.44*(h-Math.floor(h));
    if(q<cut){q/=cut;width*=cut;key=key*1.324717957244746+1.1;}
    else{q=(q-cut)/(1-cut);width*=1-cut;key=key*1.324717957244746+2.7;}
  }
  const h=key*.569840290998+.438578026081;const weight=.65+.35*(h-Math.floor(h));
  const keep=1-opticalSmooth(.5,1.5,footprint/width);
  return 55.90169943749474*q*q*(1-q)*(1-q)*(2*q-1)*weight*keep;
}
export function naturalRingArtTint(r,phase,out,footprintR=0){
  const u=clamp01((r*r-1.5625)/RING_ART_AREA),row=NATURAL_RING_ART_PROFILE[ringArtIndex(u)];
  const core=row[1]-row[0]-2*row[3],s=(u-row[0]-row[3])/core,seed=row[5]+phase*.137;
  const footprint=footprintR*2*r/RING_ART_AREA/core;
  const coarse=ringArtLobe(s,seed,1,footprint),fine=ringArtLobe(s,seed+17.319,2,footprint);
  const dust=clamp01(row[4]+.05*Math.sin(phase*6.283185307179586+row[5])+.06*coarse+.03*fine);
  const reflectance=1+.06*coarse+.04*fine;
  out[0]=(.76+.31*dust)*reflectance;out[1]=(.92-.14*dust)*reflectance;out[2]=(1.12-.56*dust)*reflectance;return out;
}

const clamp01=x=>Math.max(0,Math.min(1,x));
function opticalSmooth(a,b,x){const t=clamp01((x-a)/(b-a));return t*t*(3-2*t);}
export function naturalRingVisualSigma(x,y,z,radius,phase=0){
  const r=Math.hypot(x,z)/radius,h=NATURAL_RING.halfHeight;
  if(r<=NATURAL_RING.inner||r>=NATURAL_RING.outer||Math.abs(y)>=h)return 0;
  const u=(r*r-1.5625)/RING_ART_AREA,row=NATURAL_RING_ART_PROFILE[ringArtIndex(u)];
  const feather=opticalSmooth(0,row[3],u-row[0])*opticalSmooth(0,row[3],row[1]-u);
  const s=(u-row[0]-row[3])/(row[1]-row[0]-2*row[3]),seed=row[5]+phase*.137;
  const detail=.23*ringArtLobe(s,seed,1)+.14*ringArtLobe(s,seed+17.319,2);
  const tau=ringArtGain(phase)*row[2]*(1+.12*Math.sin(phase*6.283185307179586+row[5]))*feather*(1+detail);
  const vertical=1-y*y/(h*h);
  return tau*15/(16*h)*vertical*vertical;
}
function opticalTau(origin,ray,radius,minimum,maximum,phase,steps,w,resolvedNear=false,grainsResolved=false){
  const count=naturalRingIntervals(origin,ray,radius,minimum,maximum,w);let tau=0;
  const speed=Math.hypot(ray[0],ray[1],ray[2]);
  for(let segment=0;segment<count;segment++){
    const lo=w.intervals[segment*2],span=w.intervals[segment*2+1]-lo;
    for(let i=0;i<steps;i++){const t=lo+(i+.5)*span/steps;
      const allocation=1-(resolvedNear?NATURAL_RING_COARSE_COLUMN*(1-opticalSmooth(NATURAL_RING.fadeStart,NATURAL_RING.fadeEnd,t*speed)):0)
        -(grainsResolved?NATURAL_RING_GRAIN_LOD.share*(1-opticalSmooth(NATURAL_RING_GRAIN_LOD.fadeStart,NATURAL_RING_GRAIN_LOD.fadeEnd,t*speed)):0);
      tau+=naturalRingVisualSigma(origin[0]+ray[0]*t,origin[1]+ray[1]*t,origin[2]+ray[2]*t,radius,phase)*allocation*span*speed/steps;}
  }return tau;
}
export function naturalRingOpticalDepth(origin,ray,radius,minimum,maximum,resolvedNear,w,grainsResolved=false){
  const tau=opticalTau(origin,ray,radius,minimum,maximum,0,NATURAL_RING_OPTICS.viewSteps,w,resolvedNear,grainsResolved),out=w.result;
  out.alpha=-Math.expm1(-tau);out.opticalDepth=tau;out.nearest=w.result.intervalCount?w.intervals[0]:Infinity;
  out.transmission=Math.exp(-tau);out.radiance=0;return out;
}
export function naturalRingSunTransmission(point,light,radius,phase,w,steps=NATURAL_RING_OPTICS.sunSteps){
  const along=point[0]*light[0]+point[1]*light[1]+point[2]*light[2];
  if(along<0&&point[0]*point[0]+point[1]*point[1]+point[2]*point[2]-along*along<radius*radius)return 0;
  return Math.exp(-opticalTau(point,light,radius,0,1e15,phase,steps,w));
}
/** HG probability per steradian. Near Lambert uses E=1.05PI, hence its
 * unit-albedo normal radiance is E/PI=1.05. Both consumers share that E. */
export function naturalRingPhase(cosine){
  const g=-.28;return (1-g*g)/(4*Math.PI*Math.pow(1+g*g-2*g*cosine,1.5));
}
// Smooth, body-fixed optical flake material. These lobes describe unresolved
// ice reflection; they create no particles, density, collision or shadow solids.
function materialHash(x,z,phase){
  let a=x*.1031-Math.floor(x*.1031),b=z*.1031-Math.floor(z*.1031),c=phase*.1031-Math.floor(phase*.1031);
  const d=a*(b+33.33)+b*(c+33.33)+c*(a+33.33);a+=d;b+=d;c+=d;
  const value=(a+b)*c;return value-Math.floor(value);
}
function materialNoise(x,z,phase){
  const ix=Math.floor(x),iz=Math.floor(z);let fx=x-ix,fz=z-iz;
  fx=fx*fx*(3-2*fx);fz=fz*fz*(3-2*fz);
  const a=materialHash(ix,iz,phase),b=materialHash(ix+1,iz,phase),c=materialHash(ix,iz+1,phase),d=materialHash(ix+1,iz+1,phase);
  return (a+(b-a)*fx)*(1-fz)+(c+(d-c)*fx)*fz;
}
function flakeResponse(point,ray,light,phase,scale,power){
  const r=Math.hypot(point[0],point[2]),rx=point[0]/r,rz=point[2]/r;
  const sr=(materialNoise(point[0]/scale,point[2]/scale,phase+17)*2-1)*.7;
  const st=(materialNoise(point[0]/scale,point[2]/scale,phase+47)*2-1)*.24;
  let nx=rx*sr-rz*st,ny=.8,nz=rz*sr+rx*st;
  const inverse=1/Math.hypot(nx,ny,nz);nx*=inverse;ny*=inverse;nz*=inverse;
  let nL=nx*light[0]+ny*light[1]+nz*light[2];
  if(nL<0){nx=-nx;ny=-ny;nz=-nz;nL=-nL;}
  const cosine=Math.max(0,-((2*nL*nx-light[0])*ray[0]+(2*nL*ny-light[1])*ray[1]+(2*nL*nz-light[2])*ray[2]));
  return nL*(power+1)/(2*Math.PI)*cosine**power;
}
/** A two-scale material evaluated at the absorption-weighted column centroid.
 * This is a reconstruction of unresolved reflection, not resolved volume grains.
 * footprint is the largest physical pixel derivative there. Unresolved lobes
 * become the normalized HG mean, so hidden detail cannot retain fake directions. */
export function naturalRingMaterial(point,ray,light,phase,footprint,out){
  const coarse=1-opticalSmooth(.5,1.5,footprint/384),fine=1-opticalSmooth(.5,1.5,footprint/96);
  const w0=.12*coarse,w1=.08*fine,base=naturalRingPhase(ray[0]*light[0]+ray[1]*light[1]+ray[2]*light[2]);
  if(coarse===0){out.response=base;out.albedo=.85;out.resolvedWeight=0;return out;}
  out.response=base*(1-w0-w1)+w0*flakeResponse(point,ray,light,phase,384,16);
  if(fine>0)out.response+=w1*flakeResponse(point,ray,light,phase,96,28);
  out.albedo=.70+.30*(.5+(materialNoise(point[0]/384,point[2]/384,phase+83)-.5)*coarse);
  out.resolvedWeight=w0+w1;return out;
}
export function naturalRingTransfer(origin,ray,radius,minimum,maximum,phase,light,resolvedNear,w,viewSteps=NATURAL_RING_OPTICS.viewSteps,sunSteps=NATURAL_RING_OPTICS.sunSteps,footprint=Infinity,grainsResolved=false){
  const count=naturalRingIntervals(origin,ray,radius,minimum,maximum,w),out=w.result;
  out.intervalCount=count;out.nearest=count?w.intervals[0]:Infinity;
  let T=1,solarPower=0,cx=0,cy=0,cz=0;const speed=Math.hypot(ray[0],ray[1],ray[2]);
  const point=w.point,sun=w.sun,unitRay=w.direction;
  for(let axis=0;axis<3;axis++)unitRay[axis]=ray[axis]/speed;
  for(let segment=0;segment<count;segment++){
    const lo=w.intervals[segment*2],span=w.intervals[segment*2+1]-lo;
    for(let i=0;i<viewSteps;i++){
      // Cubic spacing resolves the first illuminated mean-free-path on long
      // grazing chords instead of sampling its distant midpoint first.
      const a=i/viewSteps,b=(i+1)/viewSteps,start=lo+span*a*a*a,end=lo+span*b*b*b,t=(start+end)*.5;
      for(let k=0;k<3;k++)point[k]=origin[k]+ray[k]*t;
      let sigma=naturalRingVisualSigma(point[0],point[1],point[2],radius,phase);
      const coarseShare=resolvedNear?NATURAL_RING_COARSE_COLUMN*(1-opticalSmooth(NATURAL_RING.fadeStart,NATURAL_RING.fadeEnd,t*speed)):0;
      const grainShare=grainsResolved?NATURAL_RING_GRAIN_LOD.share*(1-opticalSmooth(NATURAL_RING_GRAIN_LOD.fadeStart,NATURAL_RING_GRAIN_LOD.fadeEnd,t*speed)):0;
      sigma*=1-coarseShare-grainShare;
      const absorbed=-Math.expm1(-sigma*(end-start)*speed);
      const weight=T*absorbed;
      solarPower+=weight*naturalRingSunTransmission(point,light,radius,phase,sun,sunSteps);
      cx+=weight*point[0];cy+=weight*point[1];cz+=weight*point[2];T*=1-absorbed;
      if(T<NATURAL_RING_OPTICS.tailTransmission)break;
    }
    if(T<NATURAL_RING_OPTICS.tailTransmission)break;
  }
  const alpha=1-T;let C=0;
  if(alpha>0){point[0]=cx/alpha;point[1]=cy/alpha;point[2]=cz/alpha;
    const material=naturalRingMaterial(point,unitRay,light,phase,footprint,w.material);
    C=NATURAL_RING_OPTICS.albedo*material.albedo*(NATURAL_RING_OPTICS.ambientRadiance*alpha+NATURAL_RING_OPTICS.incidentIrradiance*material.response*solarPower);
  }
  out.transmission=T;out.radiance=C;out.alpha=alpha;out.opticalDepth=-Math.log(T);return out;
}
function makeRecord(){return {id:'',parentId:'',role:'natural-ring-debris',mode:NATURAL_RING.mode,
  position:[0,0,0],frame:new Array(9).fill(0),localPosition:[0,0,0],localFrame:new Array(9).fill(0),
  boundsRadius:0,prototype:0,shape:null};}
export function createNaturalRingQueryWorkspace(capacity=NATURAL_RING.queryCapacity){
  if(!Number.isInteger(capacity)||capacity<1||capacity>NATURAL_RING.queryCapacity)throw new RangeError('Invalid natural ring result capacity');
  return {records:Array.from({length:capacity},makeRecord),results:[],localMin:[0,0,0],localMax:[0,0,0],
    count:0,tiles:0};
}
function matrixProduct(a,b,out){for(let col=0;col<3;col++)for(let row=0;row<3;row++)out[col*3+row]=a[row]*b[col*3]+a[3+row]*b[col*3+1]+a[6+row]*b[col*3+2];}
function copyRecord(body,record,out){
  out.id=record.id;out.parentId=body.id;out.prototype=record.prototype;out.boundsRadius=record.radius;out.shape=record.shape;
  const f=body.frame,p=record.position;
  for(let axis=0;axis<3;axis++){
    out.position[axis]=body.position[axis]+f[axis*3]*p[0]+f[axis*3+1]*p[1]+f[axis*3+2]*p[2];
    out.localPosition[axis]=p[axis];
  }
  for(let i=0;i<9;i++)out.localFrame[i]=record.frame[i];
  matrixProduct(record.frame,body.frame,out.frame);
}
function toLocalBounds(body,bounds,min,max){
  for(let axis=0;axis<3;axis++){min[axis]=Infinity;max[axis]=-Infinity;}
  const f=body.frame;
  for(let corner=0;corner<8;corner++){
    const x=(corner&1?bounds.max[0]:bounds.min[0])-body.position[0];
    const y=(corner&2?bounds.max[1]:bounds.min[1])-body.position[1];
    const z=(corner&4?bounds.max[2]:bounds.min[2])-body.position[2];
    for(let axis=0;axis<3;axis++){const value=f[axis]*x+f[3+axis]*y+f[6+axis]*z;min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value);}
  }
}
function intersectsRecord(body,record,bounds){
  const f=body.frame,p=record.position,r=record.radius;
  for(let axis=0;axis<3;axis++){
    const value=body.position[axis]+f[axis*3]*p[0]+f[axis*3+1]*p[1]+f[axis*3+2]*p[2];
    if(value+r<bounds.min[axis]||value-r>bounds.max[axis])return false;
  }
  return true;
}
function finiteBounds(b){if(!b||!Array.isArray(b.min)||!Array.isArray(b.max)||b.min.length!==3||b.max.length!==3)return false;for(let i=0;i<3;i++)if(!Number.isFinite(b.min[i])||!Number.isFinite(b.max[i])||b.min[i]>b.max[i])return false;return true;}
/** Instance-owned bounded tile cache and query work. Public snapshots are separate. */
export function createNaturalRingField({seed='lonelysky',parentsInBounds=cosmicSolidsInBounds,admitTile=null,prototypes=NATURAL_RING_PROTOTYPES,renderAssets=null}={}){
  if(!Array.isArray(prototypes)||prototypes.length!==4||prototypes.some((mesh,i)=>mesh.radius!==RADII[i]||!Array.isArray(mesh.nodes)||!Array.isArray(mesh.faces)))throw new TypeError('Natural ring requires four validated borrowed terrain prototypes at radii 3/8/18/32');
  if(typeof seed!=='string'||typeof parentsInBounds!=='function')throw new TypeError('Natural ring seed/provider required');
  const parents=new Map(),queue=new Array(NATURAL_RING.cacheTiles);let head=0,size=0,disposed=false,revision=0;
  let discoveryIndex=null,discovery=[];
  const discoveryBounds={min:[0,0,0],max:[0,0,0]},discoveryOptions={sectorIndex:0,bounds:discoveryBounds,seed};
  const stats={mode:NATURAL_RING.mode,tileBuilds:0,cacheTiles:0,cacheRecords:0,queries:0,lastQueryTiles:0,lastQueryCount:0,revision:0,disposed:false};
  function clear(){parents.clear();queue.fill(undefined);head=0;size=0;stats.cacheTiles=0;stats.cacheRecords=0;discoveryIndex=null;discovery=[];revision++;stats.revision=revision;}
  function getTile(body,ix,iz,sectorIndex){
    if(ix< -8192||ix>=8192||iz< -8192||iz>=8192)throw new NaturalRingQueryFailure('natural-ring-tile-address','Ring tile outside supported radius contract');
    let map=parents.get(body.id);if(!map){map=new Map();parents.set(body.id,map);}
    const key=(ix+8192)*16384+iz+8192;
    const old=map.get(key);if(old)return old;
    const random=randomFromSeed(hashSeed(`${seed}:${body.id}:natural-ring-debris-v1:${ix},${iz}`));
    const records=[];
    for(let slot=0;slot<8;slot++){
      const x=(ix+(slot%4+.5)/4)*512+(random()-.5)*48;
      const z=(iz+(Math.floor(slot/4)+.5)/2)*512+(random()-.5)*48;
      const y=(random()-.5)*64,r=Math.hypot(x,z)/body.radius,accept=random();
      const typeRoll=random();let type=0,total=WEIGHTS[0];while(type<3&&typeRoll>=total)total+=WEIGHTS[++type];
      const frame=randomFrame(random);
      // Reject whole rocks outside finite support, rather than clipping their mesh.
      const radius=RADII[type];
      if(accept>=naturalRingReferenceAlpha(r)||Math.hypot(x,z)-radius<body.radius*NATURAL_RING.inner
        ||Math.hypot(x,z)+radius>body.radius*NATURAL_RING.outer)continue;
      records.push({id:`${body.id}:natural-ring-v1:${ix},${iz}:${slot}`,prototype:type,position:[x,y,z],frame,radius,
        shape:freeze({type:'compound',parts:[],terrainGroups:[prototypes[type]]})});
    }
    if(admitTile)admitTile(body,ix,iz,sectorIndex,records);
    const tile={map,key,bodyId:body.id,records};
    if(size===NATURAL_RING.cacheTiles){const retired=queue[head];retired.map.delete(retired.key);stats.cacheRecords-=retired.records.length;
      if(retired.map.size===0&&retired.bodyId!==body.id)parents.delete(retired.bodyId);
      queue[head]=tile;head=(head+1)%NATURAL_RING.cacheTiles;
    }else{queue[(head+size)%NATURAL_RING.cacheTiles]=tile;size++;}
    map.set(key,tile);stats.tileBuilds++;stats.cacheTiles=size;stats.cacheRecords+=records.length;
    return tile;
  }
  function findParents(sectorIndex,bounds){
    const cached=bounds.min[0]>=-40000&&bounds.min[1]>=-40000&&bounds.min[2]>=-40000&&bounds.max[0]<=40000&&bounds.max[1]<=40000&&bounds.max[2]<=40000;
    if(cached&&discoveryIndex===sectorIndex)return discovery;
    const reach=NATURAL_RING.maxParentRadius*NATURAL_RING.outer+NATURAL_RING.halfHeight;
    for(let i=0;i<3;i++){discoveryBounds.min[i]=(cached?-40000:bounds.min[i])-reach;discoveryBounds.max[i]=(cached?40000:bounds.max[i])+reach;}
    discoveryOptions.sectorIndex=sectorIndex;
    const found=parentsInBounds(discoveryOptions);
    for(const body of found)describeNaturalRing(body);
    if(cached){discovery=found;discoveryIndex=sectorIndex;}return found;
  }
  function append(body,record,w){
    if(w.count===w.records.length)throw new NaturalRingQueryFailure('natural-ring-query-capacity','Natural ring query could not return every candidate');
    const index=w.count++,out=w.records[index];copyRecord(body,record,out);w.results[index]=out;
  }
  function query(sectorIndex,bounds,w){
    if(disposed)throw new Error('Natural ring field disposed');
    if(!finiteBounds(bounds))throw new TypeError('Natural ring query requires finite ordered bounds');
    w.count=0;w.tiles=0;stats.queries++;
    for(const body of findParents(sectorIndex,bounds)){
      if(body.kind!=='gas-giant'||body.ringed!==true)continue;
      const inner=body.radius*NATURAL_RING.inner,outer=body.radius*NATURAL_RING.outer;
      toLocalBounds(body,bounds,w.localMin,w.localMax);
      if(w.localMin[1]>64||w.localMax[1]<-64)continue;
      const nearX=Math.max(w.localMin[0],Math.min(0,w.localMax[0])),nearZ=Math.max(w.localMin[2],Math.min(0,w.localMax[2]));
      if(Math.hypot(nearX,nearZ)>outer||Math.max(Math.hypot(w.localMin[0],w.localMin[2]),Math.hypot(w.localMin[0],w.localMax[2]),Math.hypot(w.localMax[0],w.localMin[2]),Math.hypot(w.localMax[0],w.localMax[2]))<inner)continue;
      const minX=Math.floor((w.localMin[0]-32)/512),maxX=Math.floor((w.localMax[0]+32)/512);
      const minZ=Math.floor((w.localMin[2]-32)/512),maxZ=Math.floor((w.localMax[2]+32)/512);
      if(w.tiles+(maxX-minX+1)*(maxZ-minZ+1)>256)throw new NaturalRingQueryFailure('natural-ring-query-budget','Natural ring swept query exceeds 256 tiles; no partial result is valid');
      for(let ix=minX;ix<=maxX;ix++)for(let iz=minZ;iz<=maxZ;iz++){
        w.tiles++;const tile=getTile(body,ix,iz,sectorIndex);
        for(const record of tile.records)if(intersectsRecord(body,record,bounds))append(body,record,w);
      }
    }
    stats.lastQueryTiles=w.tiles;stats.lastQueryCount=w.count;w.results.length=w.count;return w.results;
  }
  /** Planning-only conservative occupancy, never exposed as a collider. */
  function hazardsInBounds(sectorIndex,bounds){
    if(disposed)throw new Error('Natural ring field disposed');
    if(!finiteBounds(bounds))throw new TypeError('Natural ring hazard query requires finite ordered bounds');
    const result=[];
    for(const body of findParents(sectorIndex,bounds)){
      const ring=describeNaturalRing(body);if(!ring)continue;
      const bound=Math.hypot(ring.outer,ring.halfHeight);let squared=0;
      for(let axis=0;axis<3;axis++){const d=Math.max(bounds.min[axis]-body.position[axis],0,body.position[axis]-bounds.max[axis]);squared+=d*d;}
      if(squared>bound*bound)continue;
      result.push({id:`${body.id}:natural-ring-navigation-v1`,parentId:body.id,role:'natural-ring-hazard',mode:NATURAL_RING.mode,
        position:body.position.slice(),frame:body.frame.slice(),boundsRadius:bound,
        shape:{type:'compound',parts:[{type:'annular-sector-slab',innerRadius:ring.inner,outerRadius:ring.outer,minY:-ring.halfHeight,maxY:ring.halfHeight,gapCenter:0,gapHalfAngle:0}]}});
    }
    return result;
  }
  function visible(body,cameraLocal,sectorIndex,w){
    if(disposed)throw new Error('Natural ring field disposed');
    w.count=0;w.tiles=0;w.results.length=0;
    const ring=describeNaturalRing(body);if(!ring)return w.results;
    if(Math.abs(cameraLocal[1])>64+1800)return w.results;
    const radius=Math.hypot(cameraLocal[0],cameraLocal[2]);if(radius<ring.inner-1800||radius>ring.outer+1800)return w.results;
    const cx=Math.floor(cameraLocal[0]/512),cz=Math.floor(cameraLocal[2]/512);
    for(let ix=cx-4;ix<=cx+4;ix++)for(let iz=cz-4;iz<=cz+4;iz++){
      w.tiles++;for(const record of getTile(body,ix,iz,sectorIndex).records)append(body,record,w);
    }
    w.results.length=w.count;return w.results;
  }
  return {query,visible,hazardsInBounds,clear,stats,get prototypes(){return prototypes;},get renderAssets(){return renderAssets;},get revision(){return revision;},dispose(){if(disposed)return;clear();disposed=true;prototypes=null;renderAssets=null;stats.disposed=true;}};
}

// Radius-normalized GLSL counterpart. Constants come from this same owner.
export const NATURAL_RING_GLSL=/* glsl */`
uniform bool uNaturalRingGrainResolved;
bool naturalRingRadial(vec2 origin,vec2 ray,float radius,float minimum,float maximum,out vec2 interval){
  interval=vec2(0.);float a=dot(ray,ray),b=dot(origin,ray),c=dot(origin,origin)-radius*radius;
  if(a==0.){if(c>=0.)return false;interval=vec2(minimum,maximum);return true;}
  float crossDistance=origin.x*ray.y-origin.y*ray.x;
  float disc=a*radius*radius-crossDistance*crossDistance;if(disc<=0.)return false;
  float root=sqrt(disc),q=-b-(b>=0.?root:-root);
  vec2 roots=vec2(q/a,c/q);interval=vec2(max(minimum,min(roots.x,roots.y)),min(maximum,max(roots.x,roots.y)));
  return interval.y>interval.x;
}
int naturalRingIntervals(vec3 origin,vec3 ray,float minimum,float maximum,out vec4 intervals){
  intervals=vec4(0.);float h=${NATURAL_RING.halfHeight.toFixed(1)}/uBodyRadius;
  float lo=minimum,hi=maximum;
  if(ray.y==0.){if(abs(origin.y)>=h)return 0;}
  else{vec2 caps=(vec2(-h,h)-origin.y)/ray.y;lo=max(lo,min(caps.x,caps.y));hi=min(hi,max(caps.x,caps.y));}
  vec2 outer,inner;
  if(hi<=lo||!naturalRingRadial(origin.xz,ray.xz,${NATURAL_RING.outer},lo,hi,outer))return 0;
  lo=outer.x;hi=outer.y;
  if(!naturalRingRadial(origin.xz,ray.xz,${NATURAL_RING.inner},lo,hi,inner)){intervals.xy=vec2(lo,hi);return 1;}
  int count=0;
  if(inner.x>lo){intervals.xy=vec2(lo,inner.x);count=1;}
  if(inner.y<hi){if(count==0)intervals.xy=vec2(inner.y,hi);else intervals.zw=vec2(inner.y,hi);count++;}
  return count;
}
// Static, area-normalized non-equidistant optical families.
const vec4 ringArtBands[64]=vec4[](vec4(0.0000000000000000,0.0048134260148383389,0.20334330561161043,0.00077014816237413423),vec4(0.0048134260148383389,0.024575949954227908,0.31167324409782887,0.0011999999999999999),vec4(0.024575949954227908,0.052347788966995178,0.13521751318573955,0.0011999999999999999),vec4(0.052347788966995178,0.058576083992365663,0.0000000000000000,0.00099652720405927759),vec4(0.058576083992365663,0.069135157776392286,0.22279366825819016,0.0011999999999999999),vec4(0.069135157776392286,0.077188849808928706,0.31804433361589907,0.0011999999999999999),vec4(0.077188849808928706,0.10570243980818785,0.27130072132945060,0.0011999999999999999),vec4(0.10570243980818785,0.13075645752518489,0.28623461198508737,0.0011999999999999999),vec4(0.13075645752518489,0.13480690499200929,0.22025329184532166,0.00064807159469190353),vec4(0.13480690499200929,0.13959613696224749,0.26029419396221642,0.00076627711523811202),vec4(0.13959613696224749,0.16208597977462480,0.98389020060934118,0.0011999999999999999),vec4(0.16208597977462480,0.19118688195655292,1.0921399439722299,0.0011999999999999999),vec4(0.19118688195655292,0.21876275126193234,0.63634620036743583,0.0011999999999999999),vec4(0.21876275126193234,0.22302613498990087,1.1073809088580311,0.00068214139647496455),vec4(0.22302613498990087,0.22928525982675907,0.53082308457978067,0.0010014599738973119),vec4(0.22928525982675907,0.24848185972897613,0.70330326301604518,0.0011999999999999999),vec4(0.24848185972897613,0.26513491058303523,0.50306614495627588,0.0011999999999999999),vec4(0.26513491058303523,0.28493317450835359,0.0000000000000000,0.0011999999999999999),vec4(0.28493317450835359,0.30257438147440413,0.98565073607303200,0.0011999999999999999),vec4(0.30257438147440413,0.32797190517998254,0.70137199068069456,0.0011999999999999999),vec4(0.32797190517998254,0.33525132567628707,1.1881461787559093,0.0011647072794087254),vec4(0.33525132567628707,0.34207199286145673,1.4020112471394239,0.0010913067496271455),vec4(0.34207199286145673,0.35055406995458543,1.4979819662459193,0.0011999999999999999),vec4(0.35055406995458543,0.36001177367295711,1.5249372351728379,0.0011999999999999999),vec4(0.36001177367295711,0.37292361720807743,1.9929925443567336,0.0011999999999999999),vec4(0.37292361720807743,0.39715036167973738,0.0000000000000000,0.0011999999999999999),vec4(0.39715036167973738,0.40365495430617693,0.0000000000000000,0.0010407348202303268),vec4(0.40365495430617693,0.42268695482251789,0.12000000000000000,0.0011999999999999999),vec4(0.42268695482251789,0.43609846876820246,0.0000000000000000,0.0011999999999999999),vec4(0.43609846876820246,0.44245829675153625,0.0000000000000000,0.0010175724773334061),vec4(0.44245829675153625,0.48657982389421967,0.77798163577914259,0.0011999999999999999),vec4(0.48657982389421967,0.50478961551780066,1.0955507095195354,0.0011999999999999999),vec4(0.50478961551780066,0.52324090965674430,1.1337188272550704,0.0011999999999999999),vec4(0.52324090965674430,0.53156146227960877,1.3883564287535848,0.0011999999999999999),vec4(0.53156146227960877,0.53711077276383479,0.0000000000000000,0.00088788967747616360),vec4(0.53711077276383479,0.58225062191095855,1.4203257838375869,0.0011999999999999999),vec4(0.58225062191095855,0.59051180421437333,1.0031551632508637,0.0011999999999999999),vec4(0.59051180421437333,0.60784962255496122,1.4065185224674643,0.0011999999999999999),vec4(0.60784962255496122,0.61699514008284773,0.70433867132663730,0.0011999999999999999),vec4(0.61699514008284773,0.64592105023442714,1.2144628066457808,0.0011999999999999999),vec4(0.64592105023442714,0.67417083466889716,0.84412163392454398,0.0011999999999999999),vec4(0.67417083466889716,0.68422014384619556,0.87775531033799070,0.0011999999999999999),vec4(0.68422014384619556,0.70414932088659954,1.1002071855813267,0.0011999999999999999),vec4(0.70414932088659954,0.72019654105697117,0.0000000000000000,0.0011999999999999999),vec4(0.72019654105697117,0.72693636357465241,0.88373879896849405,0.0010783716028289982),vec4(0.72693636357465241,0.73243195785776993,1.3768632553778590,0.00087929508529880349),vec4(0.73243195785776993,0.75564377114503856,0.16123474126160142,0.0011999999999999999),vec4(0.75564377114503856,0.76718077908419846,0.13845006949156521,0.0011999999999999999),vec4(0.76718077908419846,0.78899138309073624,0.099275231212377538,0.0011999999999999999),vec4(0.78899138309073624,0.80038630377524134,0.070629379351437094,0.0011999999999999999),vec4(0.80038630377524134,0.82641773330963686,0.65800256503708676,0.0011999999999999999),vec4(0.82641773330963686,0.85809464607072494,0.66218419245407001,0.0011999999999999999),vec4(0.85809464607072494,0.88384140025185731,0.70143826790116737,0.0011999999999999999),vec4(0.88384140025185731,0.88792011317976294,0.56941175318658355,0.00065259406846490014),vec4(0.88792011317976294,0.89326386452646866,0.95267320073284212,0.00085500021547291638),vec4(0.89326386452646866,0.92559846208541663,0.60314212521985178,0.0011999999999999999),vec4(0.92559846208541663,0.93295705539807849,0.55841374876312921,0.0011773749300258984),vec4(0.93295705539807849,0.93696746611131054,0.38503937353342782,0.00064166571411712777),vec4(0.93696746611131054,0.96336079394867458,0.71384529197402313,0.0011999999999999999),vec4(0.96336079394867458,0.96826533270679382,0.0000000000000000,0.00078472620129907964),vec4(0.96826533270679382,0.97871359357918197,0.50164104298911993,0.0011999999999999999),vec4(0.97871359357918197,0.99154337378939783,0.76540680201053635,0.0011999999999999999),vec4(0.99154337378939783,0.99599115097900648,0.71648104121424261,0.00071164435033738377),vec4(0.99599115097900648,1.0000000000000000,0.40976837202087046,0.00064141584335896339));
const vec2 ringArtMaterials[64]=vec2[](vec2(0.84934000119799746,0.0000000000000000),vec2(0.83318856140365827,0.37000000000000000),vec2(0.84718256316380580,0.73999999999999999),vec2(0.83465271015418696,1.1099999999999999),vec2(0.94400214476743716,1.4800000000000000),vec2(0.87820281270658596,1.8500000000000001),vec2(0.84805998553754758,2.2199999999999998),vec2(0.85995172830997035,2.5899999999999999),vec2(0.88374033373082062,2.9600000000000000),vec2(0.92990235375007613,3.3300000000000001),vec2(0.71103237448958689,1.9099999999999999),vec2(0.74714289166266101,2.2799999999999998),vec2(0.71965483618667359,2.6499999999999999),vec2(0.70685075356857852,3.0199999999999996),vec2(0.61852386426879102,3.3899999999999997),vec2(0.66043795978883291,3.7599999999999998),vec2(0.68752249773358931,4.1299999999999999),vec2(0.69472257358254874,4.5000000000000000),vec2(0.66917930627940225,4.8700000000000001),vec2(0.71115640912437816,5.2400000000000002),vec2(0.26970325758680702,3.8199999999999998),vec2(0.24741645605769008,4.1899999999999995),vec2(0.35032482528127729,4.5599999999999996),vec2(0.29078877564985306,4.9299999999999997),vec2(0.29900947254151106,5.2999999999999998),vec2(0.58552557830465957,5.7299999999999995),vec2(0.49188566712895410,6.0999999999999996),vec2(0.56893987525021661,6.4699999999999998),vec2(0.54574870799900965,6.8399999999999999),vec2(0.56109036165056758,7.2099999999999991),vec2(0.17374107562238350,7.6399999999999997),vec2(0.18837966976454479,8.0099999999999998),vec2(0.18995617925422265,8.3799999999999990),vec2(0.076779678433667869,8.7500000000000000),vec2(0.18918388983467593,9.1199999999999992),vec2(0.065432240178342899,9.4900000000000002),vec2(0.065551230583805589,9.8599999999999994),vec2(0.17270515809534118,10.230000000000000),vec2(0.052965460012201218,10.600000000000000),vec2(0.093927561880554997,10.969999999999999),vec2(0.18496209438191724,11.340000000000000),vec2(0.15633070372743532,11.710000000000001),vec2(0.045324414542410527,12.079999999999998),vec2(0.11436961360042915,12.449999999999999),vec2(0.14306820714147761,12.820000000000000),vec2(0.062769363883417098,13.190000000000000),vec2(0.42964097312884408,9.5499999999999989),vec2(0.50950174082769084,9.9199999999999982),vec2(0.47301500095287341,10.289999999999999),vec2(0.53357063743984323,10.659999999999998),vec2(0.18457446574931965,11.459999999999999),vec2(0.23428009347291665,11.829999999999998),vec2(0.21340159444836901,12.199999999999999),vec2(0.25756578393513335,12.569999999999999),vec2(0.22748868150403723,12.940000000000000),vec2(0.20615177675383164,13.309999999999999),vec2(0.26700109165860342,13.680000000000000),vec2(0.17390512353042142,14.049999999999999),vec2(0.18351986195659264,14.419999999999998),vec2(0.14585555744590240,14.789999999999999),vec2(0.19859577889321373,15.160000000000000),vec2(0.25945953134680166,15.529999999999999),vec2(0.19799681493779644,15.899999999999999),vec2(0.24804199020611123,16.270000000000000));
int naturalRingArtIndex(float u){int low=0,high=63;for(int i=0;i<6;i++){int middle=(low+high)/2;if(u<ringArtBands[middle].y)high=middle;else low=middle+1;}return low;}
float naturalRingArtLobe(float s,float seed,int levels,float footprint){
  if(s<=0.||s>=1.)return 0.;float q=s,key=seed,width=1.;
  for(int level=0;level<2;level++){
    if(level>=levels)break;
    float cut=.28+.44*fract(key*.7548776662466927+.569840290998);
    if(q<cut){q/=cut;width*=cut;key=key*1.324717957244746+1.1;}
    else{q=(q-cut)/(1.-cut);width*=1.-cut;key=key*1.324717957244746+2.7;}
  }
  float weight=.65+.35*fract(key*.569840290998+.438578026081);
  float keep=1.-smoothstep(.5,1.5,footprint/width);
  return 55.90169943749474*q*q*(1.-q)*(1.-q)*(2.*q-1.)*weight*keep;
}
vec3 naturalRingArtTint(float r,float phase,float footprintR){
  int index=naturalRingArtIndex(clamp((r*r-1.5625)/2.8475000000000001,0.,1.));
  vec4 row=ringArtBands[index];vec2 material=ringArtMaterials[index];
  float core=row.y-row.x-2.*row.w,s=((r*r-1.5625)/2.8475-row.x-row.w)/core,seed=material.y+phase*.137;
  float footprint=footprintR*2.*r/2.8475/core;
  float coarse=naturalRingArtLobe(s,seed,1,footprint),fine=naturalRingArtLobe(s,seed+17.319,2,footprint);
  float dust=clamp(material.x+.05*sin(phase*6.283185307179586+material.y)+.06*coarse+.03*fine,0.,1.);
  return mix(vec3(.76,.92,1.12),vec3(1.07,.78,.56),dust)*(1.+.06*coarse+.04*fine);
}
float naturalRingSigma(vec3 point){
  float r=length(point.xz),h=64.,y=point.y*uBodyRadius;
  if(r<=1.25||r>=2.1||abs(y)>=h)return 0.;
  float u=(r*r-1.5625)/2.8475000000000001;int index=naturalRingArtIndex(u);vec4 row=ringArtBands[index];
  float p=uPhase*6.283185307179586;
  float gain=.675/(0.62566479482165216+-0.0092195573698334293*sin(p)+-0.0058282297546845925*cos(p));
  float feather=smoothstep(0.,row.w,u-row.x)*smoothstep(0.,row.w,row.y-u);
  float s=(u-row.x-row.w)/(row.y-row.x-2.*row.w),seed=ringArtMaterials[index].y+uPhase*.137;
  float detail=.23*naturalRingArtLobe(s,seed,1,0.)+.14*naturalRingArtLobe(s,seed+17.319,2,0.);
  float tau=gain*row.z*(1.+.12*sin(p+ringArtMaterials[index].y))*feather*(1.+detail);
  float vertical=1.-y*y/(h*h);return tau*15./(16.*h)*vertical*vertical;
}
// Finite annular solar column, eight fixed cells per connected interval.
// This is single scattering in a static artistic medium, not a grain ray trace.
float naturalRingSunTransmission(vec3 point){
  float along=dot(point,uLight);
  if(along<0.&&dot(point,point)-along*along<1.)return 0.;
  vec4 intervals;int count=naturalRingIntervals(point,uLight,0.,1.e15,intervals);float tau=0.;
  for(int segment=0;segment<2;segment++){
    if(segment>=count)break;
    vec2 span=segment==0?intervals.xy:intervals.zw;
    float stepSize=(span.y-span.x)/${NATURAL_RING_OPTICS.sunSteps.toFixed(1)};
    for(int i=0;i<${NATURAL_RING_OPTICS.sunSteps};i++){
      vec3 samplePoint=point+uLight*(span.x+(float(i)+.5)*stepSize);
      tau+=naturalRingSigma(samplePoint)*stepSize*uBodyRadius;
    }
  }
  return exp(-tau);
}
float naturalRingPhase(float cosine){
  const float g=-.28;return (1.-g*g)/(12.566370614359172*pow(1.+g*g-2.*g*cosine,1.5));
}
float naturalRingMaterialHash(vec2 cell,float phase){
  vec3 p=fract(vec3(cell,phase)*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);
}
float naturalRingMaterialNoise(vec2 point,float phase){
  vec2 cell=floor(point),f=fract(point);f=f*f*(3.-2.*f);
  return mix(mix(naturalRingMaterialHash(cell,phase),naturalRingMaterialHash(cell+vec2(1,0),phase),f.x),
    mix(naturalRingMaterialHash(cell+vec2(0,1),phase),naturalRingMaterialHash(cell+vec2(1,1),phase),f.x),f.y);
}
float naturalRingFlake(vec3 point,vec3 ray,float scale,float power){
  vec2 radial=normalize(point.xz),tangent=vec2(-radial.y,radial.x);
  float sr=(naturalRingMaterialNoise(point.xz/scale,uPhase+17.)*2.-1.)*.7;
  float st=(naturalRingMaterialNoise(point.xz/scale,uPhase+47.)*2.-1.)*.24;
  vec2 slope=radial*sr+tangent*st;vec3 normal=normalize(vec3(slope.x,.8,slope.y));
  float nL=dot(normal,uLight);if(nL<0.){normal=-normal;nL=-nL;}
  return nL*(power+1.)/6.283185307179586*pow(max(0.,dot(reflect(-uLight,normal),-ray)),power);
}
// A filtered body-fixed optical material at the absorption-weighted centroid.
// It does not create individual grains or alter density/solar transport.
void naturalRingMaterial(vec3 point,vec3 ray,float footprint,out float response,out float albedo){
  float coarse=1.-smoothstep(.5,1.5,footprint/384.),fine=1.-smoothstep(.5,1.5,footprint/96.);
  float w0=.12*coarse,w1=.08*fine,base=naturalRingPhase(dot(ray,uLight));
  if(coarse==0.){response=base;albedo=.85;return;}
  response=base*(1.-w0-w1)+w0*naturalRingFlake(point,ray,384.,16.);
  if(fine>0.)response+=w1*naturalRingFlake(point,ray,96.,28.);
  albedo=.70+.30*(.5+(naturalRingMaterialNoise(point.xz/384.,uPhase+83.)-.5)*coarse);
}

// Positive pixel-cone quadrature over the same body-fixed point density that
// admits optical grains. Average T/C, never exp(average optical depth).
const float ringPixelNodes8[8]=float[](0.48014492824876814,0.39833323870681342,0.26276620495816450,0.091717321247824890,-0.091717321247824890,-0.26276620495816450,-0.39833323870681342,-0.48014492824876814);
const float ringPixelWeights8[8]=float[](0.050614268145188393,0.11119051722668723,0.15685332293894369,0.18134189168918100,0.18134189168918100,0.15685332293894369,0.11119051722668723,0.050614268145188393);
const float ringPixelNodes16[16]=float[](0.49470046749582497,0.47228751153661630,0.43281560119391588,0.37770220417750150,0.30893812220132189,0.22900838882861368,0.14080177538962946,0.047506254918818720,-0.047506254918818720,-0.14080177538962946,-0.22900838882861368,-0.30893812220132189,-0.37770220417750150,-0.43281560119391588,-0.47228751153661630,-0.49470046749582497);
const float ringPixelWeights16[16]=float[](0.013576229705875926,0.031126761969323888,0.047579255841246448,0.062314485627766973,0.074797994408288410,0.084578259697501212,0.091301707522461806,0.094725305227534237,0.094725305227534237,0.091301707522461806,0.084578259697501212,0.074797994408288410,0.062314485627766973,0.047579255841246448,0.031126761969323888,0.013576229705875926);
float naturalRingLinearRadiance(float alpha,float solarPower,float response,float albedo){
  return ${NATURAL_RING_OPTICS.albedo}*albedo*(${NATURAL_RING_OPTICS.ambientRadiance}*alpha+${NATURAL_RING_OPTICS.incidentIrradiance.toPrecision(17)}*response*solarPower);
}
float naturalRingExpRelative(float z){
  // Used only for abs(z)<.05: the coincident-slope limit avoids cancellation.
  return 1.-z*.5+z*z/6.-z*z*z/24.+z*z*z*z/120.;
}
// Observer-only artistic projected coverage of the unresolved far medium.
// The original density, Sun transfer, endpoints and near contribution stay intact.
float naturalRingNearHandoff(vec3 origin){
  float radial=length(origin.xz)*uBodyRadius;
  float radialDistance=max(max(${NATURAL_RING.inner}*uBodyRadius-radial,radial-${NATURAL_RING.outer}*uBodyRadius),0.);
  float verticalDistance=max(abs(origin.y)*uBodyRadius-${NATURAL_RING.halfHeight.toFixed(1).replace(/\.0$/,'.')},0.);
  float distanceToLayer=length(vec2(radialDistance,verticalDistance));
  float handoff=1.-smoothstep(${NATURAL_RING_GRAIN_LOD.fadeStart.toFixed(1).replace(/\.0$/,'.')},${NATURAL_RING_GRAIN_LOD.fadeEnd.toFixed(1).replace(/\.0$/,'.')},distanceToLayer);
  return handoff;
}
bool naturalRingPixelColumn(vec3 origin,vec3 ray,vec3 rayDx,vec3 rayDy,float minimum,float maximum,
  out float alpha,out vec3 radianceShare,out float nearest,out float blend){
  alpha=0.;radianceShare=vec3(0.);nearest=1.e25;blend=0.;
  float muEye=abs(ray.y),muSun=abs(uLight.y);
  if(muEye==0.||muSun==0.)return false;
  float planeDistance=-origin.y/ray.y,halfLayer=${NATURAL_RING.halfHeight.toFixed(1)}/uBodyRadius;
  if(planeDistance<=0.)return false;
  vec3 planePoint=origin+ray*planeDistance;
  float radius=length(planePoint.xz);
  if(radius<=${NATURAL_RING.inner}||radius>=${NATURAL_RING.outer})return false;
  vec3 planeDx=planeDistance*(rayDx-ray*(rayDx.y/ray.y)),planeDy=planeDistance*(rayDy-ray*(rayDy.y/ray.y));
  vec2 radial=planePoint.xz/radius;
  float width=(abs(dot(radial,planeDx.xz))+abs(dot(radial,planeDy.xz)))*uBodyRadius;
  float quarterPeriod=0.0027196652777385921*uBodyRadius*.25;
  if(width<=quarterPeriod)return false;
  float viewWalk=${(2*NATURAL_RING.halfHeight).toFixed(1)}*abs(dot(radial,ray.xz))/muEye;
  float sunWalk=${(2*NATURAL_RING.halfHeight).toFixed(1)}*abs(dot(radial,uLight.xz))/muSun;
  float thinRatio=(viewWalk+sunWalk)/width;
  if(thinRatio>=.3)return false;
  float minMu=muEye-.5*(abs(rayDx.y)+abs(rayDy.y));
  if(minMu<=0.)return false;
  float distanceSpan=planeDistance*.5*(abs(rayDx.y)+abs(rayDy.y))/muEye;
  float lo=planeDistance-halfLayer/muEye,hi=planeDistance+halfLayer/muEye;
  if(lo-distanceSpan-halfLayer/minMu<=minimum||hi+distanceSpan+halfLayer/minMu>=maximum)return false;
  // The approximation owns complete thin columns only. Annular/foreground
  // edge pixels retain the original finite ray integral.
  float support=.5*(length(planeDx.xz)+length(planeDy.xz))*uBodyRadius+viewWalk*.5;
  if(min(radius-${NATURAL_RING.inner},${NATURAL_RING.outer}-radius)*uBodyRadius<=support)return false;
  if(lo*uBodyRadius<=${NATURAL_RING.fadeEnd.toFixed(1)})return false;
  blend=smoothstep(quarterPeriod,2.*quarterPeriod,width)*(1.-smoothstep(.2,.3,thinRatio));
  if(blend<=0.)return false;
  float nearHandoff=naturalRingNearHandoff(origin);
  int level=width>1.5*0.0027196652777385921*uBodyRadius?16:8;
  float transmission=0.;vec3 radiance=vec3(0.);
  float materialFootprint=max(length(planeDx.xz),length(planeDy.xz))*uBodyRadius;
  for(int rowIndex=0;rowIndex<16;rowIndex++){
    if(rowIndex>=level)break;
    float oy=level==16?ringPixelNodes16[rowIndex]:ringPixelNodes8[rowIndex];
    float wy=level==16?ringPixelWeights16[rowIndex]:ringPixelWeights8[rowIndex];
    for(int columnIndex=0;columnIndex<16;columnIndex++){
      if(columnIndex>=level)break;
      float ox=level==16?ringPixelNodes16[columnIndex]:ringPixelNodes8[columnIndex];
      float wx=level==16?ringPixelWeights16[columnIndex]:ringPixelWeights8[columnIndex];
      vec3 qRay=normalize(ray+ox*rayDx+oy*rayDy);
      float qDistance=-origin.y/qRay.y;vec3 qPoint=origin+qRay*qDistance;
      float sigmaColumn=naturalRingSigma(vec3(qPoint.x,0.,qPoint.z))*${(NATURAL_RING.halfHeight*16/15).toPrecision(17)};
      float qMu=abs(qRay.y),qT=exp(-sigmaColumn/qMu),solarPower;
      if(qRay.y*uLight.y<0.)solarPower=(1.-exp(-sigmaColumn*(1./qMu+1./muSun)))/(1.+qMu/muSun);
      else{
        float slope=sigmaColumn*(1./qMu-1./muSun);
        // Only the coincident-slope limit uses exprel: the difference of
        // nonpositive exponentials avoids inf*0 for grazing solar columns.
        if(abs(slope)<.05)solarPower=exp(-sigmaColumn/muSun)*(sigmaColumn/qMu)*naturalRingExpRelative(slope);
        else solarPower=(exp(-sigmaColumn/muSun)-qT)/(1.-qMu/muSun);
      }
      float along=dot(qPoint,uLight);
      if(along<0.&&dot(qPoint,qPoint)-along*along<1.)solarPower=0.;
      float response,albedo;naturalRingMaterial(qPoint*uBodyRadius,qRay,materialFootprint,response,albedo);
      float weight=wx*wy;
      float coverage=mix(1.,abs(qRay.y),nearHandoff);
      // This path admits only complete columns beyond 1800L: all is far.
      float displayT=coverage<1.?1.-coverage*(1.-qT):qT;
      transmission+=weight*displayT;radiance+=weight*coverage*naturalRingLinearRadiance(1.-qT,solarPower,response,albedo)*naturalRingArtTint(length(qPoint.xz),uPhase,width/uBodyRadius);
    }
  }
  alpha=1.-transmission;radianceShare=alpha>0.?radiance/alpha:vec3(0.);nearest=lo;
  return true;
}
float naturalRingFiniteColumn(vec3 origin,vec3 ray,float minimum,float maximum,bool resolvedNear,
  out float nearest,out vec3 radianceShare){
  nearest=1.e25;radianceShare=vec3(0.);vec4 intervals;
  int count=naturalRingIntervals(origin,ray,minimum,maximum,intervals);
  if(count==0)return 0.;nearest=intervals.x;
  float transmission=1.,solarPower=0.;vec3 centroidSum=vec3(0.);
  float coverage=mix(1.,abs(ray.y),naturalRingNearHandoff(origin)),nearAbsorption=0.,nearSolar=0.;
  for(int segment=0;segment<2;segment++){
    if(segment>=count)break;
    vec2 span=segment==0?intervals.xy:intervals.zw;
    for(int i=0;i<${NATURAL_RING_OPTICS.viewSteps};i++){
      float a=float(i)/${NATURAL_RING_OPTICS.viewSteps.toFixed(1)},b=float(i+1)/${NATURAL_RING_OPTICS.viewSteps.toFixed(1)};
      float start=span.x+(span.y-span.x)*a*a*a,end=span.x+(span.y-span.x)*b*b*b;
      float t=(start+end)*.5;vec3 point=origin+ray*t;
      float sigma=naturalRingSigma(point);
      float nearWeight=resolvedNear?1.-smoothstep(${NATURAL_RING.fadeStart.toFixed(1)},${NATURAL_RING.fadeEnd.toFixed(1)},t*uBodyRadius):0.;
      float grainWeight=uNaturalRingGrainResolved?${NATURAL_RING_GRAIN_LOD.share}*(1.-smoothstep(${NATURAL_RING_GRAIN_LOD.fadeStart.toFixed(1)},${NATURAL_RING_GRAIN_LOD.fadeEnd.toFixed(1)},t*uBodyRadius)):0.;
      sigma*=1.-${NATURAL_RING_COARSE_COLUMN.toPrecision(17)}*nearWeight-grainWeight;
      float absorbed=1.-exp(-sigma*(end-start)*uBodyRadius);
      float weight=transmission*absorbed;
      float sunTransmission=naturalRingSunTransmission(point);
      solarPower+=weight*sunTransmission;
      if(coverage<1.){
        // Split this existing constant-sigma cell exactly at 700L. No new
        // density/Sun queries, sample positions, endpoints or loop iterations.
        float nearLength=max(0.,min(end,${NATURAL_RING_GRAIN_LOD.fadeEnd.toFixed(1).replace(/\.0$/,'.')}/uBodyRadius)-start);
        float nearWeight=transmission*(1.-exp(-sigma*nearLength*uBodyRadius));
        nearAbsorption+=nearWeight;nearSolar+=nearWeight*sunTransmission;
      }
      centroidSum+=weight*point;transmission*=1.-absorbed;
      // Remaining opacity/solar-column error <=1e-4. The filtered flake
      // response is reconstructed once after integration, not sampled 32 times.
      if(transmission<${NATURAL_RING_OPTICS.tailTransmission})break;
    }
    if(transmission<${NATURAL_RING_OPTICS.tailTransmission})break;
  }
  float alpha=1.-transmission;
  if(alpha>0.){
    vec3 weightedPoint=centroidSum/alpha,physicalPoint=weightedPoint*uBodyRadius;
    // Derivatives of the actual reconstructed body point, including its
    // grazing ray/column mapping; no fixed screen-space grain overlay.
    vec2 dx=dFdx(physicalPoint.xz),dy=dFdy(physicalPoint.xz);
    float xx=dot(dx,dx),xy=dot(dx,dy),yy=dot(dy,dy);
    float footprint=sqrt(.5*(xx+yy+sqrt((xx-yy)*(xx-yy)+4.*xy*xy)));
    float response,albedo;naturalRingMaterial(physicalPoint,ray,footprint,response,albedo);
    float radiance=naturalRingLinearRadiance(alpha,solarPower,response,albedo);
    vec2 radial=normalize(physicalPoint.xz);float radialFootprint=abs(dot(radial,dx))+abs(dot(radial,dy));
    if(coverage<1.){
      // Positive mixture: original near transfer + covered/uncovered far.
      // Material reconstruction stays at the original absorption centroid.
      float nearRadiance=naturalRingLinearRadiance(nearAbsorption,nearSolar,response,albedo);
      radiance=nearRadiance+coverage*(radiance-nearRadiance);
      alpha=nearAbsorption+coverage*(alpha-nearAbsorption);
    }
    radianceShare=alpha>0.?naturalRingArtTint(length(weightedPoint.xz),uPhase,radialFootprint/uBodyRadius)*radiance/alpha:vec3(0.);
  }
  return alpha;
}
float naturalRingColumn(vec3 origin,vec3 ray,float minimum,float maximum,bool resolvedNear,
  out float nearest,out vec3 radianceShare){
  // Derivatives are evaluated before any divergent interval/edge return.
  vec3 rayDx=dFdx(ray),rayDy=dFdy(ray);
  // Keep the finite integral on every lane so its material derivatives remain
  // coherent at filtered/unfiltered boundaries. The thin pixel cone adds
  // 64/256 density queries; this is filtering, not a GPU cost reduction.
  vec3 pointShare;float pointAlpha=naturalRingFiniteColumn(origin,ray,minimum,maximum,resolvedNear,nearest,pointShare);
  vec3 coneShare;float coneAlpha,coneNearest,blend;
  if(!naturalRingPixelColumn(origin,ray,rayDx,rayDy,minimum,maximum,coneAlpha,coneShare,coneNearest,blend)){radianceShare=pointShare;return pointAlpha;}
  if(blend>=1.){nearest=coneNearest;radianceShare=coneShare;return coneAlpha;}
  float alpha=mix(pointAlpha,coneAlpha,blend);
  radianceShare=alpha>0.?mix(pointAlpha*pointShare,coneAlpha*coneShare,blend)/alpha:vec3(0.);return alpha;
}

`;

/** Same finite Sun transport for ordinary near-grain geometry. The caller owns
 * uRadius/uRingPhase and supplies body-local normalized positions. */
export const NATURAL_RING_SURFACE_LIGHT_GLSL=`
#define uBodyRadius uRadius
#define uPhase uRingPhase
${NATURAL_RING_GLSL}
#undef uBodyRadius
#undef uPhase
`;
