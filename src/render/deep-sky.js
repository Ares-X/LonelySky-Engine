import * as THREE from 'three';
import {DISTANT_SKY_FIELD_GLSL, distantSkyFieldUniforms, setDistantSkyField} from './distant-sky-field.js';

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
export const deepSkyShader = (mapped = false) => /* glsl */`
uniform vec3 uSkyTint;
uniform vec3 uSkyBandNormal;
uniform float uSkyBrightness;
uniform float uSkyBandStrength;
uniform float uSkyStarDensity;
uniform mat3 uSkyContinuumFrame;
uniform vec3 uSkyContinuumOrigin,uSkyContinuumOffset,uSkyContinuumTint;
uniform vec4 uSkyContinuumShape;
uniform vec2 uSkyContinuumArms;
uniform float uSkyContinuumStrength;
uniform float uDistantMedium;
uniform vec3 uSeaWeightsA,uSeaWeightsB;
uniform mat3 uSeaFrame;
uniform float uSeaPhase,uSeaWidth,uSeaQuiet;
${mapped ? 'uniform sampler2D uSeaDetail; uniform bool uSeaHasDetail;' : ''}
uniform mat3 uSkyPanoramaFrame;
uniform float uSkyPanoramaStrength;
uniform vec3 uSeaMorphA,uSeaMorphB,uSeaMorphC,uSeaMorphD,uSeaMorphE,uSeaMorphF;
uniform vec3 uSeaCool,uSeaWarm,uSeaAccent,uSeaOffset;
uniform vec4 uSeaShape,uSeaStructure,uSeaDust,uSeaState;
${DISTANT_SKY_FIELD_GLSL}
// GLSL pow has no defined negative-base domain, including exponent 2.0.
float seaSquare(float value) { return value*value; }
${mapped ? /* glsl */`vec2 skyCatalogUv(vec3 galactic) {
  vec3 equatorial=mat3(-.05487556,-.87343709,-.48383502,
    .49410943,-.44482963,.74698224,-.86766615,-.19807637,.45598378)*galactic;
  float longitude=dot(equatorial.xy,equatorial.xy)>.0000001?atan(equatorial.y,equatorial.x):0.;
  return vec2(.5-longitude/6.28318530718,asin(clamp(equatorial.z,-1.,1.))/3.14159265359+.5);
}
vec3 skyCatalog(vec3 galactic) {
  vec2 uv=skyCatalogUv(galactic),uvDx=dFdx(uv),uvDy=dFdy(uv);
  uvDx.x-=floor(uvDx.x+.5);uvDy.x-=floor(uvDy.x+.5);
  return textureGrad(uSeaDetail,uv,uvDx,uvDy).rgb;
}` : ''}

// Galactic +X faces the central bulge and +Z is north. Nearby dusty arms
// cross older stars along the plane, with knots seen through irregular gaps.
// Fixed cube-face star cells. Widen a Gaussian with the projected pixel
// footprint, conserving its energy; unresolved cells converge to a mean.
float classicStars(vec2 plane,float face,float scale,float pixel,float population){
  vec2 grid=plane*scale;
  vec3 cell=vec3(floor(grid),face+scale);
  float pick=skyHash(cell);
  vec2 center=.16+.68*vec2(skyHash(cell+7.1),skyHash(cell+19.7));
  vec2 v=fract(grid)-center;
  float radius=.022+.048*skyHash(cell+11.2);
  float variance=radius*radius;
  float filterWidth=pixel*scale;
  float filtered=variance+filterWidth*filterWidth*.11;
  float individual=step(1.-population,pick)*exp(-dot(v,v)/(2.*filtered))*variance/filtered;
  return mix(individual,6.28318*.002308*population,smoothstep(.55,1.3,filterWidth));
}
vec3 classicMilkyWay(vec3 d){
  vec3 q=d+vec3(1.71,4.08,2.63);
  float grain=skyNoise(q*4.9);
  float cloud=skyNoise(q*15.+grain*2.8);
  float filaments=skyNoise(q*48.+vec3(cloud,grain,-cloud)*3.1);
  float pixel=length(fwidth(d));
  float midplane=d.z+.032*d.y+.024*(grain-.5);
  float towardCore=max(d.x,0.);
  float core=exp(-5.2*(1.-d.x)-seaSquare((d.z+.015)/.23));
  float disc=exp(-abs(midplane)/(.068+.047*towardCore));
  float envelope=exp(-seaSquare(midplane/(.23+.09*towardCore)));
  float terrain=skyNoise(q*38.+vec3(cloud,grain,cloud)*5.);
  float detail=skyNoise(q*94.+terrain*3.4);
  float wisps=skyNoise(q*244.+detail*2.8);
  wisps=mix(wisps,.5,smoothstep(.35,1.1,pixel*244.));
  float matter=.38*grain+.27*cloud+.19*terrain+.10*detail+.06*wisps;
  float lane=midplane-.024-(grain-.5)*.13-(cloud-.5)*.072-(terrain-.5)*.038-(detail-.5)*.016;
  float fork=lane-.056-.045*d.y-(cloud-.5)*.09-(filaments-.5)*.043;
  float mainRift=exp(-seaSquare(lane/(.017+.033*grain)));
  float splitRift=exp(-seaSquare(fork/(.009+.023*cloud)));
  float clump=.38*cloud+.29*terrain+.21*detail+.12*wisps;
  float broken=smoothstep(.24,.73,clump);
  float depth=((mainRift+splitRift*.74)*(.26+4.4*broken)
    +envelope*smoothstep(.45,.71,matter)*1.9)*(.45+.55*towardCore);
  float pockets=skyNoise(q*107.+vec3(filaments,terrain,cloud)*5.);
  depth*=.64+.48*pockets+.43*wisps;
  vec3 extinction=exp(-vec3(.84,1.06,1.3)*depth);
  float starCloud=.22+2.45*smoothstep(.25,.75,matter);
  float knots=disc*smoothstep(.46,.74,cloud)*smoothstep(.45,.76,filaments);
  vec3 absD=abs(d);
  vec2 plane;float face;
  if(absD.x>absD.y&&absD.x>absD.z){plane=d.yz/absD.x;face=sign(d.x);}
  else if(absD.y>absD.z){plane=d.zx/absD.y;face=3.*sign(d.y);}
  else{plane=d.xy/absD.z;face=5.*sign(d.z);}
  float footprint=pixel/max(absD.x,max(absD.y,absD.z));
  float population=.055+.53*disc+.20*core;
  float stars=classicStars(plane,face,78.,footprint,population)*.87
    +classicStars(plane,face,248.,footprint,population)*1.15;
  float speck=skyNoise(q*620.);
  speck=mix(speck,.5,smoothstep(.5,1.7,pixel*620.));
  vec3 oldStars=vec3(.47,.31,.20)*core*(.62+.78*matter);
  vec3 arms=mix(vec3(.115,.137,.168),vec3(.29,.247,.203),towardCore)*disc*starCloud;
  vec3 light=(oldStars+arms+vec3(.18,.19,.21)*knots)*extinction*(.68+.64*speck);
  float cluster=smoothstep(.47,.82,.53*pockets+.31*wisps+.16*speck);
  light*=.82+.35*wisps+.16*(pockets-.5);
  light+=vec3(.12,.14,.18)*disc*cluster*extinction;
  vec3 unresolved=vec3(.009,.011,.015)*envelope*starCloud;
  vec3 points=vec3(1.,.94,.88)*stars*mix(vec3(.16),extinction,.84);
  return vec3(.0016,.0021,.0034)+light+unresolved+points;
}

// A short column through the host disk in host-radius units. The spiral
// phase matches the winding of its resolved stars. Broaden unresolved arm
// crossings towards the full-period mean instead of sampling a sharp ridge
// at four isolated points. This is a radiance approximation.
float youngArmColumn(vec3 origin,vec3 ray,float thickness) {
  vec3 scale=vec3(1.,1./(2.7*thickness),1.);
  vec3 o=origin*scale, d=ray*scale;
  float dd=dot(d,d), od=dot(o,d);
  float disc=od*od-dd*(dot(o,o)-1.);
  if(disc<=0.) return 0.;
  float root=sqrt(disc);
  float enter=max(0.,(-od-root)/dd), leave=(-od+root)/dd;
  if(leave<=enter) return 0.;
  float stepLength=(leave-enter)*.25;
  vec3 p=origin+(enter+.5*stepLength)*ray;
  float column=0.;
  for(int i=0;i<4;++i){
    float radius=max(.003,length(p.xz));
    float angle=dot(p.xz,p.xz)>1.e-8 ? atan(p.z,p.x) : 0.;
    float phase=uSkyContinuumArms.x*(angle-log(radius+.06)*uSkyContinuumArms.y);
    float slope=(p.x*ray.z-p.z*ray.x)/(radius*radius)
      -dot(p.xz,ray.xz)*uSkyContinuumArms.y/(radius*(radius+.06));
    float span=abs(slope*uSkyContinuumArms.x)*stepLength;
    float ridge=mix(exp(-3.6*(1.-cos(phase))),.22,smoothstep(.45,3.7,span));
    float layer=exp(-abs(p.y)/(.46*thickness*(.4+radius)));
    column+=ridge*layer*max(0.,1.-radius)*smoothstep(.02,.20,radius);
    p+=stepLength*ray;
  }
  return stepLength*column;
}

// Directional light beyond the individually resolved stars. Coarse emission
// and dust define the silhouette, while derivatives filter the finest grain.
// The game supplies the host frame and observer offset in host-radius units.
vec3 regionalStellarContinuum(vec3 direction) {
  vec3 d=uSkyContinuumFrame*direction;
  vec3 origin=uSkyContinuumOrigin;
  float form=uSkyContinuumShape.x;
  float thickness=uSkyContinuumShape.y;
  float skew=uSkyContinuumShape.z*2.-1.;
  float variation=uSkyContinuumShape.w;
  float phase=variation*6.28318530718;
  float towardCenter=dot(d,-origin)*inversesqrt(dot(origin,origin)+.08);
  float innerLight=smoothstep(-.55,.93,towardCenter);
  vec3 seed=uSkyContinuumOffset+origin*1.4;
  float broad=skyNoise(d*5.+seed);
  float cloud=skyNoise(d*17.+seed+vec3(.7,-1.2,.9)*broad*4.);
  float grain=skyNoise(d*67.+seed+vec3(broad,cloud,-broad)*4.);
  float strands=skyNoise(d*205.+seed+vec3(grain,broad,cloud)*3.);
  strands=mix(strands,.5,smoothstep(.38,1.25,length(fwidth(d*205.))));
  float knotted=smoothstep(.29,.75,broad*.43+cloud*.37+grain*.20);
  float stars=.25+1.55*knotted*(.3+1.3*smoothstep(.27,.81,grain*.73+strands*.27));
  float latitude=d.y+origin.y*.72;
  float intensity;
  vec3 tint=uSkyContinuumTint;
  if(form<2.5){
    // Folded disk with an asymmetric bulge. The seeded ridge and narrow
    // branches are independent of the broader luminous ridge.
    float diskLatitude=latitude+.025*sin(d.x*4.+phase)+(broad-.5)*(.07+.065*variation);
    float width=.035+.69*thickness+.075*innerLight;
    float ridge=exp(-seaSquare(diskLatitude/width));
    float shoulder=exp(-seaSquare((diskLatitude-.075*skew)/(width*2.1)));
    float rift=exp(-seaSquare((diskLatitude+(cloud-.5)*.083)/(.014+.009*variation)));
    float broken=smoothstep(.42,.72,cloud*.55+grain*.29+strands*.16);
    float extinction=rift*(.8+2.7*cloud)+shoulder*broken*(.3+2.9*strands);
    if(form>1.5){
      // A dust-dominated disk gets two irregular banks and a wider dark cleft.
      extinction+=exp(-seaSquare((diskLatitude+.012)/(width*.53)))*(1.2+2.3*broad);
      ridge+=.48*exp(-seaSquare((diskLatitude-.13*skew-.03)/(width*.65)));
    } else if(form>.5){
      // A barred host has a wider, warmer wash toward its inner disk.
      shoulder*=1.+1.3*innerLight;
    }
    intensity=(ridge*(.11+.96*innerLight)+shoulder*.17)*stars*exp(-extinction)*.13;
    tint*=mix(vec3(.64,.78,1.17),vec3(1.18,.97,.73),innerLight*.85+broad*.15);
    if(uSkyContinuumArms.x>0.){
      float arm=youngArmColumn(origin,d,thickness);
      // Old disk light remains warm. Young concentrations share the host's
      // lanes; the absorbing midplane cuts through those same sightlines.
      float young=1.-exp(-8.*arm);
      float armLane=exp(-seaSquare((diskLatitude+.019+(cloud-.5)*.065)/(.023+.025*width)));
      intensity*=1.-.48*young*armLane;
      float litCloud=knotted*(.28+.72*cloud)*(.56+.44*grain);
      intensity+=.15*young*litCloud*(1.-.78*armLane);
      tint=mix(tint,vec3(.64,.83,1.14),young*.63);
    }
  } else if(form<3.5){
    // Old stellar light forms a gradual falloff, with only a soft partial
    // shell and fine grain. Coarse absorption belongs to dusty hosts.
    float halo=smoothstep(-.67,.81,towardCenter*.9+d.z*.22);
    float shellArc=exp(-seaSquare((towardCenter-.18+skew*d.y*.25)/(.21+.09*variation)));
    float shellSweep=smoothstep(-.32,.84,d.z+.25*skew);
    intensity=(halo*halo*.028+shellArc*shellSweep*.006)*(.84+.32*(grain*.42+strands*.58));
    tint*=mix(vec3(.91,.99,1.12),vec3(1.08,1.02,.94),halo);
  } else {
    // Two asymmetric ridges, broken into separated clouds. Tidal hosts
    // stretch a long stream; nurseries keep a shorter, more porous rim.
    float tide=step(form,4.5);
    float curve=d.y+.18*origin.y-.22*sin(d.x*(2.5+variation*2.)+phase)-.31*skew*d.z;
    float filament=exp(-seaSquare((curve+(broad-.5)*.34)/mix(.19,.077,tide)));
    float fragment=exp(-seaSquare((d.y+skew*.28+.25*cos(d.z*4.+phase))/mix(.18,.14,tide)));
    float window=smoothstep(.06,.77,.5+.5*d.z+broad*.36-.18);
    float cluster=smoothstep(.36,.68,broad*.56+cloud*.32+grain*.12);
    intensity=(filament*window+fragment*(1.-window)*.56)*cluster*stars*.095;
    tint*=mix(vec3(.61,.77,1.22),vec3(1.13,.70,.91),smoothstep(.47,.77,cloud)*mix(.8,.45,tide));
  }
  // Even above the disk a line of sight crosses some unresolved stars.
  // Keep dust lanes directional and let the old stellar halo fall off more gently.
  vec3 offPlane=mix(vec3(.006,.012,.025),vec3(.020,.026,.043),broad*.65+cloud*.35);
  return (offPlane+tint*intensity*2.6)*uSkyContinuumStrength*(.65+uSeaQuiet*.35);
}

// Eighteen spatial building blocks share seeded population, erosion and light.
// Their controls are interpolated in world space, never chosen by a screen or clock.
vec3 stellarSea(vec3 direction, out float skyTransmission, out float streamPopulation) {
  skyTransmission=1.;
  streamPopulation=0.;
  vec3 sumWeights=uSeaMorphA+uSeaMorphB+uSeaMorphC+uSeaMorphD+uSeaMorphE+uSeaMorphF;
  if(dot(sumWeights,vec3(1.))<=.000001)return vec3(0.);
  vec3 d=uSeaFrame*direction;
  vec3 offset=uSeaOffset+vec3(uSeaPhase,1.7,-2.1);
  float broad=skyNoise(d*3.4+offset);
  float middle=skyNoise(d*(10.+uSeaStructure.z*12.)+offset+vec3(broad,-broad,broad)*4.);
  // Resolve grains in the dust's own frame. Advecting this octave with a
  // higher-contrast fold field draws sharp little loops across diffuse light.
  vec3 grainCoord=d*83.+offset;
  if(uDistantMedium==0.)grainCoord+=vec3(middle,broad,-middle)*9.;
  float fine=skyNoise(grainCoord);
  float micro=skyNoise(d*331.+offset)*.65+skyNoise(d*811.+offset)*.35;
  micro=mix(micro,.5,smoothstep(.5,1.4,length(fwidth(d*811.))));
  float grain=broad*.34+middle*.3+fine*.22+micro*.14;
  float stellarGrain=.7+micro*.6;
  ${mapped ? /* glsl */`if(uSeaHasDetail && uDistantMedium==0.){
    // Borrow only filtered high-frequency stellar grain. The catalogue's
    // recognizable Galactic panorama must never determine another galaxy's shape.
    vec3 galactic=normalize(d+vec3(uSeaOffset.xy*.013,0.));
    vec2 uv=skyCatalogUv(galactic);
    vec3 catalog=skyCatalog(galactic);
    float lowFrequency=dot(textureLod(uSeaDetail,uv,5.).rgb,vec3(.2126,.7152,.0722));
    float grainRatio=dot(catalog,vec3(.2126,.7152,.0722))/max(lowFrequency,.003);
    stellarGrain*=mix(.8,1.2,clamp(grainRatio*.5,0.,1.));
  }` : ''}
  float stretch=uSeaShape.x,warp=uSeaShape.y,core=uSeaShape.z,spread=uSeaShape.w;
  float arms=uSeaStructure.x,pitch=uSeaStructure.y,clump=uSeaStructure.z,asymmetry=uSeaStructure.w;
  float width=uSeaWidth*(.65+spread*.5);
  float latitude=d.y/width;
  float warped=latitude+(broad-.5)*warp+sin(d.x*pitch+uSeaPhase)*warp*.3;
  float dustLane=exp(-seaSquare(warped/max(.012,uSeaDust.y)));
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
  float mass=0.,nucleus=0.,birth=0.,opticalDepth=0.;
  if(uSeaMorphA.x>0.) { // broad dust river, with a displaced compact bulge
    float bulge=exp(-seaSquare((d.z-asymmetry*.6)/(.28+core))-latitude*latitude*38.)*sideFront;
    mass+=uSeaMorphA.x*(band*(.25+cloud*1.4)+bulge*core*1.5)*transmission;
    nucleus+=uSeaMorphA.x*bulge*core;
  }
  if(uSeaMorphA.y>0.) { // folded asymmetric reflection curtain
    if(uDistantMedium>0.) {
      float x=side.x+asymmetry*.25;
      float fold=side.y-.20+x*(.30+asymmetry*.33)+.43*x*x
        +(broad-.5)*(.16+warp*.12)+(middle-.5)*.10;
      float pleat=.5+.5*cos(x*(11.+pitch)+uSeaPhase+(middle-.5)*1.8);
      float face=smoothstep(-.32,-.10,fold)*(1.-smoothstep(-.016,.024,fold));
      float crest=exp(-seaSquare((fold+.030)/(.019+.025*middle)));
      float endFade=exp(-seaSquare((x+.12)/(.56+.20*spread)));
      float curtain=uSeaMorphA.y*sideFront*endFade;
      mass+=curtain*(face*(.14+.77*pleat*pleat)+crest*(.16+.39*pleat))*(.42+.58*eroded);
      birth+=curtain*crest*.22;
    } else {
      float fold=latitude-warp*sin(d.x*pitch+uSeaPhase)-asymmetry*.4;
      float veil=exp(-fold*fold*(18.+stretch*14.))*(.2+cloud*1.6)*sideFront;
      mass+=uSeaMorphA.y*veil*exp(-eroded*uSeaDust.x*.65);
      birth+=uSeaMorphA.y*veil*.35;
    }
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
    vec2 orbit=(p+vec2(.25,.55))/vec2(1.,.7+spread*.4);
    float arc=length(orbit)-(.58+spread*.28);
    if(uDistantMedium>0.) {
      float reach=smoothstep(-.55,.29,orbit.x+.23*orbit.y);
      float gap=smoothstep(.24,.67,middle*.57+fine*.29+broad*.14);
      arc+=(broad-.5)*.10+(middle-.5)*.045;
      float curve=exp(-seaSquare(arc/(.024+.045*reach)));
      float fork=exp(-seaSquare((arc-.17*reach)/(.025+.050*reach)));
      float arcDensity=uSeaMorphB.z*front*gap*(curve*(.25+.65*reach)+fork*.49*reach);
      mass+=arcDensity*(.37+.60*cloud);
      streamPopulation+=arcDensity;
    } else {
      float curve=exp(-arc*arc*(90.+stretch*70.));
      mass+=uSeaMorphB.z*curve*front*(.15+cloud)*transmission;
      birth+=uSeaMorphB.z*curve*front*cloud*.4;
    }
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
    // Light only the exposed wall. The opposite edge dissolves into the
    // ambient medium, leaving a recognisable cavity rather than a drawn rim.
    float facingLight=smoothstep(-.32,.49,side.x*.61+side.y*(.68+asymmetry)+(broad-.5)*1.05);
    float porosity=smoothstep(.30,.67,middle*.7+broad*.3);
    float rim=exp(-shell*shell*(100.+stretch*80.))*facingLight*(.12+.88*porosity);
    mass+=uSeaMorphC.z*rim*sideFront*(.25+cloud*1.5)*exp(-eroded*uSeaDust.x*.4);
    birth+=uSeaMorphC.z*rim*sideFront;
  }
  if(uSeaMorphD.x>0.) { // flowing filaments, separated rather than a solid cloud
    float strands=0.;
    for(int i=0;i<3;i++){
      float k=float(i), along=side.x-.16*k+asymmetry*.18;
      float sweep=along*(.18+k*.11)+along*along*(warp*.4-.12);
      float branch=(k*k*.044-.15)+along*(k-1.)*.08;
      float crosswise=side.y-sweep-branch+(broad-.5)*(.19+k*.035)+(middle-.5)*.065;
      float width=.012+.019*middle+.016*abs(along);
      float extent=exp(-seaSquare((along+.12*k)/(.43+.16*k)));
      float breakup=smoothstep(.20,.75,middle*.63+fine*.17+broad*.20+along*(k-1.)*.14);
      float strand=exp(-.5*seaSquare(crosswise/width));
      float veil=exp(-.5*seaSquare((crosswise-.02)/(width*3.)));
      strands+=extent*breakup*(strand+.25*veil)*(1.-.16*k);
    }
    mass+=uSeaMorphD.x*strands*sideFront*(.23+cloud)*transmission;
  }
  if(uSeaMorphD.y>0.) { // flattened stellar lens and faint annular envelope
    float lens=length(p/vec2(.8+spread*.4,.13+core*.16));
    mass+=uSeaMorphD.y*(exp(-lens*2.8)+exp(-seaSquare(lens-.9)*60.)*.3)*front*(.5+cloud*.5);
    nucleus+=uSeaMorphD.y*exp(-lens*lens*12.)*front;
  }
  if(uSeaMorphD.z>0.) { // diffuse asymmetric ellipsoid
    vec2 stretched=p/vec2(.4+core,.4+spread*.5);
    float oval=exp(-pow(length(stretched),1.7)*2.6);
    mass+=uSeaMorphD.z*oval*front*(.25+cloud*.7)*(.7+asymmetry*p.x);
    nucleus+=uSeaMorphD.z*exp(-dot(stretched,stretched)*35.)*front*core;
  }
  if(uSeaMorphE.x>0.) { // starburst: many unequal young knots, no regular outline
    float knots=0., cores=0.;
    for(int i=0;i<5;i++){
      float k=float(i),angle=k*2.399+uSeaPhase+.55*sin(k*3.7+uSeaPhase);
      vec2 center=vec2(cos(angle),sin(angle))*sqrt(k+.15)*(.082+spread*.11);
      vec2 displacement=p-center;
      float stretchY=.54+.62*(.5+.5*cos(angle+1.4));
      displacement.y+=.34*sin(angle)*displacement.x;
      displacement.y*=stretchY;
      float r2=dot(displacement,displacement);
      float radius=.046+.047*(.5+.5*sin(k*4.2+uSeaPhase));
      float group=exp(-r2/(radius*radius));
      float mantle=exp(-r2/(radius*radius*5.));
      float brilliance=1./(1.+k*.41);
      knots+=(.38*group+.48*mantle*(.15+cloud))*brilliance;
      cores+=exp(-r2/(radius*radius*.07))*brilliance;
    }
    mass+=uSeaMorphE.x*knots*front*(.26+cloud*.85);
    birth+=uSeaMorphE.x*knots*front;
    nucleus+=uSeaMorphE.x*cores*front*.55;
  }
  if(uSeaMorphE.y>0.) { // tidally pulled clusters joined by a curved, faint bridge
    float halfSpan=mix(.325,.46,uDistantMedium);
    float fromX=.025-halfSpan,toX=.025+halfSpan;
    vec2 a=p-vec2(fromX,asymmetry),b=p-vec2(toX,-asymmetry*.5);
    float t=clamp((p.x-fromX)/(toX-fromX),0.,1.);
    // Anchor the centreline to both concentrations at every inclination.
    // A displaced, porous middle can now bow without detaching either end.
    float waist=4.*t*(1.-t);
    float spine=mix(asymmetry,-.5*asymmetry,t)
      +waist*((warp-.45)*.23+.14*uDistantMedium+(broad-.5)*.16+(middle-.5)*.034);
    float width=mix(.060,.038,t)+.027*waist;
    float across=(p.y-spine)/sqrt(1.+seaSquare(1.5*asymmetry/(toX-fromX)));
    float bridge=exp(-.5*seaSquare(across/width));
    float reach=smoothstep(fromX-.12,fromX+.04,p.x)*(1.-smoothstep(toX-.04,toX+.11,p.x));
    float oldCluster=exp(-dot(a,a)*mix(37.,55.,uDistantMedium));
    b.y+=.24*b.x;
    float youngCluster=exp(-64.*b.x*b.x-118.*b.y*b.y);
    float debris=reach*bridge*(.10+.45*cloud);
    if(uDistantMedium>0.) {
      float breakers=smoothstep(.24,.70,middle*.53+fine*.33+broad*.14);
      float offshoot=exp(-seaSquare((across+waist*.14)/(width*.52)));
      debris=reach*breakers*(bridge*.57+offshoot*waist*.34);
      streamPopulation+=uSeaMorphE.y*front*(oldCluster*.71+youngCluster*.70+debris);
    }
    mass+=uSeaMorphE.y*(oldCluster*.76+youngCluster*.70+debris)*front*(.38+cloud)*transmission;
    nucleus+=uSeaMorphE.y*oldCluster*oldCluster*front*.36;
    birth+=uSeaMorphE.y*youngCluster*front;
  }
  if(uSeaMorphE.z>0.) { // braided absorbing columns against scattered light
    // Two finite, tilted fingers rise from the cloud bank. Their heads catch
    // the light, their bases widen into the same reservoir of extinction.
    float uneven=(broad-.5)*.20+(middle-.5)*.07;
    float hA=.23+asymmetry*.15-side.y+uneven*.38;
    float hB=.025-asymmetry*.21-side.y+uneven*.50;
    float a=max(0.,hA), b=max(0.,hB);
    float xA=side.x+.16+.21*a+.32*a*a+uneven;
    float xB=side.x-.16+.36*b-.20*b*b+uneven*.62;
    float wA=.026+.12*min(a,.7), wB=.021+.085*min(b,.9);
    float fingerA=exp(-.5*seaSquare(xA/wA))*smoothstep(-.026,.029,hA);
    float fingerB=exp(-.5*seaSquare(xB/wB))*smoothstep(-.019,.030,hB);
    float bank=smoothstep(.2,.56,-side.y+uneven*1.8);
    float column=1.9*fingerA+2.3*fingerB+bank*1.5;
    float opacity=column*uSeaDust.x;
    float backlight=exp(-side.x*side.x*4.-seaSquare(side.y-.10)*3.)*sideFront;
    float tips=exp(-seaSquare(xA/(wA*1.6))-seaSquare(hA/.044))
      +.64*exp(-seaSquare(xB/(wB*1.7))-seaSquare(hB/.032));
    float edge=0.;
    if(uDistantMedium>0.) {
      // Absorbing fingers cover the angular stellar continuum behind them as
      // well as the local reflection glow. Only the lit side gets a thin edge.
      opticalDepth+=uSeaMorphE.z*backlight*column*uSeaDust.x*2.6;
      float edgeA=exp(-seaSquare((xA-wA*1.18)/(wA*.38)))*smoothstep(-.008,.055,hA);
      float edgeB=exp(-seaSquare((xB-wB*1.18)/(wB*.42)))*smoothstep(-.008,.042,hB);
      edge=(edgeA+.67*edgeB)*(.14+.34*eroded);
    }
    mass+=uSeaMorphE.z*backlight*((.12+cloud*.75)*exp(-opacity)+.19*tips+edge);
    birth+=uSeaMorphE.z*backlight*cloud*.25*exp(-opacity);
  }
  if(uSeaMorphF.x>0.) { // an empty molecular eye bounded by illuminated dust
    vec2 cavity=side/vec2(.6+spread*.3,.3+core*.4);
    cavity.y+=cavity.x*(.14+asymmetry*.25);
    float eye=length(cavity);
    float lightSide=cavity.y*.65-cavity.x*.56;
    if(uDistantMedium>0.) {
      eye+=(broad-.5)*warp*.49+(middle-.5)*.12;
      float litWall=smoothstep(-.17,.53,lightSide+(broad-.5)*.37);
      float rim=exp(-seaSquare((eye-.81)/(.073+.060*middle)));
      float shelf=exp(-seaSquare((eye-.98)/.21));
      float nearWall=exp(-seaSquare((eye-.96)/.23))*(1.-litWall)*(.57+.43*eroded);
      // The dark near lip extinguishes the unresolved sky behind it. The hole
      // opens onto that sky, while three-dimensional foreground stars keep their light.
      opticalDepth+=uSeaMorphF.x*sideFront*nearWall*uSeaDust.x*2.2;
      float exposed=(rim*(.24+.76*eroded)+shelf*.44)*litWall;
      mass+=uSeaMorphF.x*sideFront*(exposed*(.46+cloud*.57)+rim*.055);
    } else {
      eye+=(broad-.5)*warp*.72+(middle-.5)*.14;
      float litWall=smoothstep(-.31,.55,lightSide+(broad-.5)*.53);
      mass+=uSeaMorphF.x*sideFront*exp(-seaSquare(eye-.75)*42.)*(.07+.93*litWall)*(.27+cloud*1.16);
    }
  }
  if(uSeaMorphF.y>0.) { // a long tidal tail with a fading, uneven taper
    float stream;
    if(uDistantMedium>0.) {
      // A debris tail starts at a compact population, fans out and fragments
      // downstream. Limit its extent so an oblique sightline never turns it
      // into a uniformly bright line across an unrelated foreground object.
      float along=p.x+.35;
      float reach=max(0.,along);
      float spine=.16+along*(.21+asymmetry*.39)+reach*reach*(warp*.32-.09);
      float across=p.y-spine+(broad-.5)*(.05+.24*reach)+(middle-.5)*.045;
      float width=.031+.075*reach;
      float coreTail=exp(-seaSquare(across/width));
      float split=reach*(.16+.15*reach);
      float fan=exp(-seaSquare((across-split)/(width*1.22)));
      float debris=smoothstep(.20,.71,broad*.23+middle*.51+fine*.26);
      float feather=exp(-seaSquare((across+split*.58)/(width*.49)));
      stream=(coreTail*(.18+.82*debris)+fan*.62*debris+feather*.24*eroded)
        *smoothstep(-.16,.025,along)*exp(-1.55*reach)*(.39+.61*debris);
      streamPopulation+=uSeaMorphF.y*stream*front;
    } else {
      float tail=p.y-warp*sin(p.x*pitch+uSeaPhase)-asymmetry*p.x;
      stream=exp(-tail*tail*(90.+stretch*80.))*exp(-p.x*p.x*(.5+core));
    }
    mass+=uSeaMorphF.y*stream*front*(.15+cloud+.39*uDistantMedium)*transmission;
    vec2 head=p+vec2(.35,mix(0.,-.16,uDistantMedium));
    float concentration=uSeaMorphF.y*exp(-dot(head,head)*90.)*front;
    if(uDistantMedium>0.)streamPopulation+=concentration*.68;
    nucleus+=concentration*core*mix(1.,(.39+.64*eroded)*(.74+.26*micro),uDistantMedium);
  }
  if(uSeaMorphF.z>0.) { // broken annulus with irregular, one-sided tidal debris
    vec2 q=p/vec2(.55+spread*.3,.35+core*.4);
    q.y+=q.x*(asymmetry*.26+.12);
    float ring=length(q)-.81+(broad-.5)*warp*.56+(middle-.5)*.12;
    float litSide=smoothstep(-.36,.46,q.y*.68-q.x*(.5+asymmetry*.32)+(broad-.5)*.44);
    float fragments=smoothstep(.27,.72,middle*.58+fine*.27+broad*.15);
    float crest=exp(-seaSquare(ring/(.042+.053*middle)));
    float skirt=exp(-seaSquare((ring-.085)/.18));
    // Debris peels off tangentially where the shell tears. Its widening
    // width and diminishing density separate it from the intact wall.
    float along=(q.x+q.y)*.7071;
    float reach=max(0.,along);
    float drift=(q.y-q.x)*.7071-.81+.12*reach*reach+(middle-.5)*(.08+.14*reach);
    float spray=exp(-seaSquare(drift/(.038+.13*reach)))
      *smoothstep(-.12,.24,along)*exp(-1.85*reach)*fragments;
    float strands=litSide*((.16+.56*fragments)*crest+.18*skirt*fragments)+.56*spray;
    mass+=uSeaMorphF.z*strands*front*(.14+cloud);
    birth+=uSeaMorphF.z*crest*litSide*fragments*front*.29;
  }
  skyTransmission=exp(-opticalDepth*uSeaState.z);
  float knotLight;
  if(uDistantMedium>0.){
    float clumps=smoothstep(.32,.79,middle*.63+fine*.37);
    knotLight=.36*clumps*clumps;
  } else {
    knotLight=pow(smoothstep(.55,.82,fine),3.);
  }
  float youngKnots=knotLight*birth*uSeaState.x;
  vec3 radiance=color*max(0.,mass)*stellarGrain*uSeaDust.w
    +uSeaWarm*nucleus*(.5+core)+uSeaAccent*youngKnots*.65;
  return radiance*uSeaState.y*uSeaState.z*uSeaQuiet;
}
// Compact angular glints from the same unresolved population. The center and
// luminosity stay keyed to direction. The footprint spreads pixel energy as
// the glint gets smaller, and the kernel falls to zero before a cell edge.
float distantStarGlint(vec3 lattice,float footprint,float field,float knots) {
  vec3 cell=floor(lattice);
  float chance=.17+.35*field+.20*knots;
  float draw=distantStarRank(skyHash(cell+vec3(19.,-3.,11.)));
  float selection=smoothstep(1.-chance-.01,1.-chance+.01,draw);
  if(selection==0.)return 0.;
  vec3 center=.27+.46*vec3(skyHash(cell+7.),skyHash(cell-13.),skyHash(cell+31.));
  vec3 offset=fract(lattice)-center;
  float radius2=dot(offset,offset);
  float power=skyHash(cell+vec3(11.,3.,-7.));
  float intrinsic=.074+.037*power;
  float width2=intrinsic*intrinsic+.15*footprint*footprint;
  float energy=exp(-.5*radius2/width2)*(intrinsic*intrinsic/width2);
  return selection*energy*(1.-smoothstep(.07,.14,radius2))*(.13+2.1*pow(power,6.));
}

// Light scattered by distant dust and the stars behind it, in a fixed world
// frame. A narrower absorbing lane can split the broad disk into two banks.
// Young associations instead light folded sheets. An outer halo has a thin,
// low-contrast stream even when there is no nearby star-forming material.
vec3 distantStellarRadiance(vec3 ray,float streamPopulation) {
  vec3 axis=uDistantFieldPlane.xyz, forward=uDistantFieldFacing.xyz;
  vec3 q=vec3(dot(ray,forward),dot(ray,axis),dot(ray,cross(forward,axis)));
  float associationStrength=uDistantFieldStyle.x;
  float islands=uDistantFieldFacing.w;
  float phase=uDistantFieldStyle.z;
  vec3 seed=vec3(phase,3.7-phase*.48,phase*.76);
  float broad=skyNoise(q*3.2+seed);
  vec3 warp=vec3(broad-.5,.5-broad,broad-.5);
  float folds=skyNoise(q*9.3+seed.zxy+warp*3.);
  float fine=skyNoise(q*31.+seed.yxz+vec3(folds,broad,-folds)*3.4);
  float grain=skyNoise(q*102.+vec3(fine,-folds,broad)*4.);
  grain=mix(grain,.5,smoothstep(.4,1.25,length(fwidth(q*102.))));
  float billows=broad*.48+folds*.31+fine*.15+grain*.06;
  float corrugation=(broad-.5)*.41+(folds-.5)*.14+(fine-.5)*.048+(grain-.5)*.011;
  float textureLight=.36+1.55*smoothstep(.23,.78,billows);
  float depth=.37+.63*smoothstep(-.78,.84,q.x+broad*.37);
  vec3 night=mix(vec3(.002,.005,.013),vec3(.015,.028,.047),
    smoothstep(.18,.77,billows+q.y*.09));
  vec3 radiance=mix(night,night*vec3(1.18,.80,1.19),1.-associationStrength);
  float population=0.,clusterGain=0.;
  float diskWeight=associationStrength*(1.-islands);
  if(diskWeight>0.){
    float latitude=q.y+.10*q.x+uDistantFieldStyle.w*(q.x*q.x-.38)+corrugation;
    float width=.12+uDistantFieldPlane.w*.68;
    float ridge=exp(-seaSquare(latitude/width));
    float shoulders=exp(-seaSquare(latitude/(width*2.85)));
    float rift=exp(-seaSquare((latitude+.025+.035*q.z)/(.035+.05*folds)));
    float fork=exp(-seaSquare((latitude-.11*q.z+.09*(broad-.5))/.030))
      *smoothstep(-.5,.68,q.z)*smoothstep(.32,.66,billows);
    float dust=rift*(1.0+2.5*folds)+fork*1.65;
    vec3 warm=mix(vec3(.58,.55,.64),vec3(1.26,.80,.43),.30+.63*depth);
    float clouds=.34*ridge+.095*shoulders;
    radiance+=diskWeight*warm*clouds*depth*textureLight*exp(-dust*vec3(.73,1.,1.28));
    population+=diskWeight*shoulders*depth;
  }
  float associationWeight=associationStrength*islands;
  if(associationWeight>0.){
    float cavity=q.z+.42*q.x-.16+(.5-broad)*.87+(folds-.5)*.37+(fine-.5)*.105;
    float sheet=exp(-seaSquare((cavity+.035*q.y)/(.075+.10*folds)));
    float fan=exp(-seaSquare((cavity-.23*q.y-.20)/.35));
    float scatter=.18+.82*smoothstep(-.64,.72,-q.x*.58+q.y*.64+broad*.34);
    // Stretch dust along the sheet's tangent. The crossing coordinate varies
    // slowly along it, so a strand can fray and end without tracing a contour.
    float along=q.x-.42*q.z;
    float bending=.62*along*q.y+.43*(q.y*q.y-along*along)+.19*(broad-.5);
    float across=q.z+.42*q.x+bending;
    vec3 drift=vec3(along,across,q.y);
    float plume=skyNoise(drift*vec3(6.5,20.,9.)+seed.zxy);
    vec3 filaments=vec3(along*.85+q.y*.48,across-.19*q.y+.13*(plume-.5),q.y-along*.31);
    float threads=skyNoise(filaments*vec3(17.,62.,20.)+seed.yzx);
    float wisps=smoothstep(.28,.82,.61*plume+.39*threads);
    float angle=phase-.62;
    vec2 orbit=vec2(cos(angle),sin(angle));
    vec2 companion=vec2(-.68*orbit.x-.733*orbit.y,.733*orbit.x-.68*orbit.y);
    vec3 delta=q-normalize(vec3(orbit,.16-.42*orbit.x));
    vec3 delta2=q-normalize(vec3(companion,.16-.42*companion.x));
    float r2=dot(delta,delta),s2=dot(delta2,delta2);
    float cluster=exp(-r2*49.)+.62*exp(-s2*81.);
    float pocket=smoothstep(.30,.74,folds*.6+fine*.4);
    float light=(sheet*(.085+.105*wisps)+fan*(.025+.046*pocket))*scatter*textureLight;
    vec3 reflection=mix(vec3(.085,.21,.57),vec3(.43,.85,1.06),smoothstep(.27,.82,billows+wisps*.20));
    vec3 association=reflection*(light*(.63+1.75*cluster)+cluster*(.026+.064*wisps));
    float clusterCore=exp(-r2/.000009)+.58*exp(-s2/.000006);
    association+=vec3(.64,.87,1.2)*(2.3*clusterCore+.16*exp(-r2/.00016)+.08*exp(-s2/.00011));
    radiance+=associationWeight*association;
    population+=associationWeight*clamp(sheet+fan*.4+cluster,0.,1.)*scatter;
    clusterGain=associationWeight*cluster;
  }
  float haloWeight=1.-associationStrength;
  if(haloWeight>0.){
    // Dispersed stars occupy a widening swath. Only concentrations within
    // that envelope produce visible haze; gaps open all the way through it.
    float along=q.z*(.7+.3*uDistantFieldStyle.y)+q.x*(.3-uDistantFieldStyle.y);
    float spread=smoothstep(-.63,.72,along);
    float latitude=q.y-.23+.33*q.x*q.z+corrugation*.72;
    float width=.13+.19*spread;
    float envelope=exp(-seaSquare(latitude/width));
    float gaps=smoothstep(.31,.66,.33*broad+.67*folds);
    float knots=smoothstep(.38,.74,.52*folds+.39*fine+.09*grain);
    float debris=envelope*gaps*(.22+.78*knots);
    vec3 halo=vec3(.09,.105,.235)*(.031+.026*textureLight);
    halo+=mix(vec3(.21,.255,.40),vec3(.58,.43,.34),depth)
      *.14*debris*(.34+.66*depth)*textureLight;
    radiance+=haloWeight*halo;
    population+=haloWeight*(.10+.95*debris);
    clusterGain+=haloWeight*debris*knots;
  }
  // An off-axis view still receives light scattered by the local medium.
  // The directional glow follows its illumination; denser banks and cavities
  // above this continuum use the same spectrum in stellarSea().
  if(uDistantMedium>0.){
    vec3 illuminant=mix(uSeaCool,uSeaWarm,depth);
    // The more coherent structures stand off against the stellar continuum,
    // which retains its shape but contributes less light outside those features.
    float tidal=uSeaMorphB.z+uSeaMorphE.y+uSeaMorphF.y;
    float silhouette=min(1.,tidal+uSeaMorphA.y+uSeaMorphE.z+uSeaMorphF.x);
    float glow=(.0018+.013*textureLight)*(.30+.70*depth);
    radiance=radiance*(.36+1.06*illuminant)*(1.-silhouette*.58)
      +glow*illuminant*(1.-silhouette*.74);
    // Sightlines between younger groups see less scattered light. Keep the
    // reflection colour in the luminous edge instead of washing out its cavity.
    float groups=uSeaMorphB.x+uSeaMorphE.x;
    radiance*=1.-groups*.38*(1.-smoothstep(.28,.68,billows));

  }
  vec3 lattice=ray*298.;
  streamPopulation=min(streamPopulation,1.);
  float field=max(population,streamPopulation);
  float glint=distantStarGlint(lattice,length(fwidth(lattice)),field,field*fine);
  vec3 stars=mix(vec3(.75,.88,1.12),vec3(1.14,.94,.75),grain);
  return radiance+stars*glint*(.62+1.85*population+4.*clusterGain+2.3*streamPopulation);
}

vec3 deepSky(vec3 direction) {
  vec3 d=normalize(direction);
  float skyTransmission,streamPopulation;
  vec3 mediumLight=stellarSea(d,skyTransmission,streamPopulation);
  vec3 sky=uSkyTint*uSkyBrightness*.055;
  if(uDistantFieldBlend>0.)sky+=distantStellarRadiance(d,streamPopulation)*uDistantFieldBlend*uSeaQuiet;
  if(uSkyContinuumStrength>=0.){
    if(uSkyContinuumStrength>0.)sky+=regionalStellarContinuum(d);
  } else if(uSkyBandStrength!=0.){
    // QA candidate: directional visual approximation, not a gas/dust solver.
    // Preserve the existing world-oriented band and its regional population.
    // Resolve structure across angular scales instead of brightening a smooth fog.
    float broad=skyNoise(d*11.);
    float middle=skyNoise(d*31.+17.);
    float fine=skyNoise(d*79.+29.);
    float grain=broad*.6+middle*.27+fine*.13;
    float latitude=dot(d,uSkyBandNormal);
    float warpedLatitude=latitude+(grain-.5)*.065;
    float band=exp(-warpedLatitude*warpedLatitude*105.)*uSkyBandStrength;
    float dustLatitude=(latitude+(grain-.5)*.12)/.023;
    float dust=exp(-dustLatitude*dustLatitude);
    vec3 dustWarp=d*227.+vec3(middle,broad,fine)*3.;
    float splinters=skyNoise(dustWarp);
    float threads=skyNoise(d*683.+vec3(fine,middle,broad)*5.);
    // Derivative filtering applies to subpixel grains only; broad dark lanes
    // retain their shape and contrast under a camera turn or black-hole lens.
    threads=mix(threads,.5,smoothstep(.65,1.6,length(fwidth(d*683.))));
    float branches=smoothstep(.43,.67,middle*.42+fine*.33+splinters*.25);
    float tornEdges=smoothstep(.36,.7,splinters*.72+threads*.28);
    float branchEnvelope=exp(-warpedLatitude*warpedLatitude*30.);
    float opticalDepth=dust*(1.8+fine*2.1)
      +branchEnvelope*branches*(.35+tornEdges*2.8);
    vec3 transmission=exp(-opticalDepth*vec3(.82,1.02,1.28));
    float stellarCloud=.18+2.4*smoothstep(.22,.76,grain)
      *(.32+1.05*smoothstep(.25,.78,fine*.65+splinters*.35));
    float stellarGrain=.65+threads*.7;
    ${mapped ? /* glsl */`if(uSeaHasDetail){
      // Observational catalogue supplies only local high-frequency star grain.
      // Its large-scale Milky Way silhouette never becomes another galaxy.
      vec2 uv=skyCatalogUv(d);
      float observed=dot(skyCatalog(d),vec3(.2126,.7152,.0722));
      float localMean=dot(textureLod(uSeaDetail,uv,3.).rgb,vec3(.2126,.7152,.0722));
      stellarGrain*=.3+.7*clamp(observed/max(localMean,.003),.18,4.);
    }` : ''}
    vec3 stellarTint=mix(vec3(.60,.74,1.),vec3(1.12,.94,.70),smoothstep(.3,.7,broad));
    // Emission stays confined to the existing band; black intergalactic sky and
    // the existing regional/foreground star populations keep their owners.
    sky+=uSkyTint*uSkyBrightness*band*stellarCloud*stellarTint*transmission*stellarGrain*5.;
  }
  // Very faint unresolved points keep a lens from showing a painted photograph.
  float probability=clamp(uSkyStarDensity,0.,1.)*.009;
  // Filter only unresolved spark detail. Clouds and the stellar band retain
  // their directional radiance; no clock or screen-space random pattern enters.
  float footprint=length(fwidth(d*720.));
  float resolved=1.-smoothstep(${DEEP_SKY_SPARK_FILTER.resolvedFootprint},${DEEP_SKY_SPARK_FILTER.unresolvedFootprint},footprint);
  float filteredSpark=${DEEP_SKY_SPARK_FILTER.mean}*probability;
  if(resolved!=0.){
    vec3 cell=floor(d*720.); float star=skyHash(cell);
    float spark=pow(max(0.,1.-length(fract(d*720.)-.5)*2.1),10.);
    float densityWidth=min(${DEEP_SKY_SPARK_FILTER.densityWidth},probability);
    float population=probability>0.?smoothstep(1.-probability-densityWidth,1.-probability+densityWidth,star):0.;
    filteredSpark=mix(${DEEP_SKY_SPARK_FILTER.mean}*probability,spark*population,resolved);
  }
  sky+=vec3(.55,.63,.7)*filteredSpark*.22;
  sky=sky*skyTransmission+mediumLight;
  if(uSkyPanoramaStrength>0.){
    vec3 galactic=normalize(uSkyPanoramaFrame*d);
    vec3 classic=${mapped ? 'uSeaHasDetail ? skyCatalog(galactic) : ' : ''}classicMilkyWay(galactic);
    sky=mix(sky,classic,uSkyPanoramaStrength);
  }
  return sky;
}`;

// Raw GLSL supports caller-supplied detail maps in custom materials.
export const DEEP_SKY_GLSL = deepSkyShader(true);

// Defaults retain the public pre-profile starSea descriptor contract. New
// callers supply all appearance controls; the renderer only copies their data.
const SEA_PROFILE = {
  cool: [.3,.45,.65], warm: [.8,.55,.32], accent: [.62,.7,.9], offset: [0,0,0],
  shape: [1,.2,.3,.65], structure: [3,2.8,.5,0], dust: [1,.035,.4,1], state: [.4,.15,1,.5],
};
const MORPH_GROUPS = ['A','B','C','D','E','F'];
const MORPH_UNIFORMS = MORPH_GROUPS.map(suffix => `uSeaMorph${suffix}`);
const PROFILE_UNIFORMS = Object.entries(SEA_PROFILE).map(([key, defaults]) => ({key, defaults, uniform: `uSea${key[0].toUpperCase()+key.slice(1)}`}));
const morphWeight = (profile, sea, index) => profile?.[index] ?? (index < 6 ? sea?.[index] ?? 0 : 0);

export function deepSkyUniforms({detailTexture = null} = {}) {
  const uniforms = {...distantSkyFieldUniforms(),uSkyTint:{value:new THREE.Color(.55,.6,.66)},uSkyBandNormal:{value:new THREE.Vector3(0,1,0)},
    uSkyBrightness:{value:.012},uSkyBandStrength:{value:0},uSkyStarDensity:{value:.12},
    uDistantMedium:{value:0},uSkyContinuumFrame:{value:new THREE.Matrix3()},uSkyContinuumStrength:{value:-1},uSkyContinuumOrigin:{value:new THREE.Vector3()},
    uSkyContinuumArms:{value:new THREE.Vector2()},
    uSkyContinuumOffset:{value:new THREE.Vector3()},uSkyContinuumTint:{value:new THREE.Vector3(1,1,1)},uSkyContinuumShape:{value:new THREE.Vector4()},
    uSeaWeightsA:{value:new THREE.Vector3()},uSeaWeightsB:{value:new THREE.Vector3()},
    uSeaFrame:{value:new THREE.Matrix3()},uSeaPhase:{value:0},uSeaWidth:{value:1},uSeaQuiet:{value:1},
    uSeaDetail:{value:detailTexture},uSeaHasDetail:{value:Boolean(detailTexture)},
    uSkyPanoramaFrame:{value:new THREE.Matrix3()},uSkyPanoramaStrength:{value:0}};
  for (const suffix of MORPH_GROUPS) uniforms[`uSeaMorph${suffix}`] = {value:new THREE.Vector3()};
  for (const [name,values] of Object.entries(SEA_PROFILE)) {
    uniforms[`uSea${name[0].toUpperCase()+name.slice(1)}`] = {value:values.length===4?new THREE.Vector4(...values):new THREE.Vector3(...values)};
  }
  return uniforms;
}
export function setDeepSkyEnvironment(uniforms, environment, quiet = 0) {
  if (!environment) return;
  setDistantSkyField(uniforms, environment.distantSkyField);
  uniforms.uSkyTint.value.fromArray(environment.ambientTint);
  uniforms.uSkyBandNormal.value.fromArray(environment.bandNormal);
  uniforms.uSkyBrightness.value = environment.skyBrightness * (1 - Math.max(0,Math.min(1,quiet))*.35);
  uniforms.uSkyBandStrength.value = environment.bandStrength;
  uniforms.uSkyStarDensity.value = environment.starDensity;
  const continuum = environment.skyContinuum;
  uniforms.uSkyContinuumStrength.value = continuum?.strength ?? -1;
  if (continuum && continuum.strength > 0) {
    uniforms.uSkyContinuumFrame.value.fromArray(continuum.frame);
    uniforms.uSkyContinuumOrigin.value.fromArray(continuum.origin);
    uniforms.uSkyContinuumOffset.value.fromArray(continuum.offset);
    uniforms.uSkyContinuumTint.value.fromArray(continuum.tint);
    uniforms.uSkyContinuumShape.value.fromArray(continuum.shape);
    if(continuum.arms) uniforms.uSkyContinuumArms.value.fromArray(continuum.arms);
    else uniforms.uSkyContinuumArms.value.set(0,0);
  }
  uniforms.uSkyPanoramaStrength.value=environment.classicSkyStrength??0;
  if(environment.classicSkyFrame)uniforms.uSkyPanoramaFrame.value.fromArray(environment.classicSkyFrame);
  else uniforms.uSkyPanoramaFrame.value.identity();
  const field = environment.distantSkyField;
  const medium = field?.blend > 0 && !environment.starSea ? field.medium : null;
  const sea = environment.starSea ?? medium;
  uniforms.uDistantMedium.value = medium ? 1 : 0;
  if (sea) uniforms.uSeaWeightsA.value.fromArray(sea.weights);
  else uniforms.uSeaWeightsA.value.set(0,0,0);
  if (sea) uniforms.uSeaWeightsB.value.fromArray(sea.weights,3);
  else uniforms.uSeaWeightsB.value.set(0,0,0);
  if (sea) {uniforms.uSeaFrame.value.fromArray(sea.frame);uniforms.uSeaPhase.value=sea.phase;uniforms.uSeaWidth.value=sea.width;}
  const profile = sea?.appearance;
  for (let group=0;group<MORPH_GROUPS.length;group++) {
    const offset=group*3;
    // Published descriptors without an appearance still address the original
    // six shapes. Clearing an environment also clears every new light source.
    const weights=profile?.morphologyWeights;
    uniforms[MORPH_UNIFORMS[group]].value.set(morphWeight(weights,sea?.weights,offset),
      morphWeight(weights,sea?.weights,offset+1),morphWeight(weights,sea?.weights,offset+2));
  }
  for (const {key,defaults,uniform} of PROFILE_UNIFORMS) {
    uniforms[uniform].value.fromArray(profile?.[key]??defaults);
  }
  if (medium) uniforms.uSeaState.value.z *= field.blend;
  uniforms.uSeaQuiet.value=1-Math.max(0,Math.min(1,quiet))*.15;
}
export function createDeepSky({detailTexture = null} = {}) {
  const geometry = new THREE.SphereGeometry(100000,32,20);
  const material = new THREE.ShaderMaterial({uniforms:deepSkyUniforms({detailTexture}),
    vertexShader:'varying vec3 skyDirection;void main(){skyDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`varying vec3 skyDirection;${deepSkyShader(Boolean(detailTexture))}\nvoid main(){gl_FragColor=vec4(deepSky(skyDirection),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
    side:THREE.BackSide,depthWrite:false,depthTest:false});
  const group=new THREE.Group(),mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=-1000;mesh.frustumCulled=false;group.add(mesh);
  let disposed=false;
  group.userData.update=(environment,quiet)=>{if(!disposed)setDeepSkyEnvironment(material.uniforms,environment,quiet);};
  group.userData.dispose=()=>{if(disposed)return;disposed=true;geometry.dispose();material.dispose();};
  return group;
}
