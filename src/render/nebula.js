import {createAppearanceRandom} from './appearance-random.js';
import * as THREE from 'three';
import { NEBULA_APPEARANCE_FAMILIES } from './nebula-appearance.js';
import { NEBULA_VOLUME } from '../nebula-volume.js';

/** Seeded display silhouette only; never changes bounds or world generation. */
export function describeNebulaColumns({identity,seed=1}={}) {
  const random=createAppearanceRandom(identity ?? seed,seed);
  const count=2+Math.floor(random()*3),dominant=Math.floor(random()*count);
  const columns=[];
  for(let i=0;i<count;i++){
    const x=-.64+1.28*i/(count-1)+(random()-.5)*.09;
    const z=(random()-.5)*.48;
    const top=i===dominant?.66+random()*.14:-.12+random()*.7;
    const width=.205+random()*.05;
    columns.push(Object.freeze({shape:Object.freeze([x,z,top,width]),
      lean:Object.freeze([(random()-.5)*.06,(random()-.5)*.06])}));
  }
  return Object.freeze(columns);
}


/** Independent macro controls; these are display structures, not gas dynamics. */
export function describeNebulaStructure({identity,seed=1,morphology='columns'}={}) {
  const random=createAppearanceRandom(identity ?? seed,seed);
  const axes=morphology==='halo'
    ?[.92+random()*.18,1.38+random()*.38,1.08+random()*.3]
    :[.92+random()*.17,1.03+random()*.24,.92+random()*.17];
  const knots=[];
  const knotCount=2+Math.floor(random()*3);
  for(let i=0;i<knotCount;i++)knots.push(Object.freeze([
    -.5+i/(knotCount-1)+(random()-.5)*.15,
    (i%2?1:-1)*(.12+random()*.25),(random()-.5)*.4,.32+random()*.12]));
  return Object.freeze({
    axes:Object.freeze(axes),radius:.56+random()*.16,thickness:.82+random()*.38,
    knots:Object.freeze(knots),
    curve:Object.freeze([.13+random()*.18,.08+random()*.18,2.5+random()*2,1.8+random()*2]),
    phases:Object.freeze([random()*Math.PI*2,random()*Math.PI*2]),
    rift:Object.freeze([.045+random()*.05,.18+random()*.12,(random()-.5)*.25,.10+random()*.18]),
    streamWing:Object.freeze([.32+random()*.2,(random()-.5)*.4,.8+random()*.4]),
  });
}

const vertexShader = /* glsl */`
out vec3 vLocal;
void main(){
  vLocal=position;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`;

const fragmentShader = /* glsl */`
precision highp int;
in vec3 vLocal;
out vec4 nebulaColor;
#define gl_FragColor nebulaColor
uniform vec3 uCamera,uColorA,uColorB,uRimColor,uNoiseOffset;
uniform mat4 uLocalToWorld,projectionMatrix;
uniform sampler2D uSceneDepth;
uniform vec2 uSceneDepthSize;
uniform mat4 uClipToLocal;
uniform bool uHasSceneDepth;
uniform float uVisibility,uDensity,uTime;
uniform int uSteps,uMorphology,uAppearance,uColumnCount;
uniform vec4 uColumns[4];
uniform vec2 uColumnLean[4];
uniform vec3 uShapeAxes,uStreamWing;
uniform float uShapeRadius,uShapeThickness;
uniform vec4 uKnots[4],uCurve,uRift;
uniform vec2 uShapePhases;
uniform int uKnotCount;
uniform vec3 uLightDirection;
uniform float uEmission,uScattering,uExcitation,uRimStrength,uExtinction,uPhase;
const vec3 LIGHT=vec3(-0.650945,0.650945,0.390567);

// The original 4/8/16-cell periodic field is evaluated at its seeded world
// coordinates. Hash two sets of four corners together before cubic interpolation.
vec4 cloudCornerHash(uvec4 key){
  uvec4 hash=(key^(key>>13u))*1274126177u;
  return vec4(hash^(hash>>16u))*(1./4294967295.);
}
float cloudNoiseBand(vec3 p, float footprint, float frequency, uint mask, float mean){
  float resolved=1.-smoothstep(.30,1.2,footprint*frequency);
  if(resolved<=0.)return 0.;
  vec3 q=p*frequency;
  uvec3 low=uvec3(ivec3(floor(q)))&uvec3(mask),high=(low+1u)&uvec3(mask);
  vec3 f=fract(q);f=f*f*(3.-2.*f);
  uvec4 yz=uvec4(low.y,high.y,low.y,high.y)*668265263u
    ^uvec4(low.z,low.z,high.z,high.z)*2147483647u^0x51a7d05u;
  vec4 x0=cloudCornerHash(yz^uvec4(low.x*374761393u));
  vec4 x1=cloudCornerHash(yz^uvec4(high.x*374761393u));
  vec4 yzValue=mix(x0,x1,f.x);
  float value=mix(mix(yzValue.x,yzValue.y,f.y),mix(yzValue.z,yzValue.w,f.y),f.z);
  return (value-mean)*resolved;
}
// The continuous field reproduces the former texel-centre coordinates. At a
// broad footprint each octave fades to its integrated mean independently.
// Density and lighting retain the same field, pixel cone, and ray cell widths.
float cloudNoise(vec3 point,float footprint){
  vec3 p=point-vec3(.00390625);
  float field=.50740581;
  field+=.57*cloudNoiseBand(p,footprint,4.,3u,.50640506);
  field+=.29*cloudNoiseBand(p,footprint,8.,7u,.51146480);
  field+=.14*cloudNoiseBand(p,footprint,16.,15u,.50307237);
  return clamp(.5+(field-.5)*1.25,0.,1.);
}
const vec3 CLOUD_FINE_SCALE=vec3(3.7,3.1,2.4);
const vec3 CLOUD_MICRO_SCALE=vec3(10.5,8.3,3.3);
float cloudMicrostructure(vec3 p,float broad,float shear,float fine,float footprint){
  vec3 flowPoint=p+vec3(broad-0.5,shear-0.5,fine-0.5)*0.32;
  mat3 dustFrame=mat3(0.8,0.0,-0.6,0.36,0.8,0.48,0.48,-0.6,0.64);
  return cloudNoise(dustFrame*(flowPoint*CLOUD_MICRO_SCALE)+uNoiseOffset+vec3(0.63,0.11,0.29),footprint);
}
float fineDustNoise(vec3 p,vec4 footprint){return cloudNoise(p*CLOUD_FINE_SCALE+uNoiseOffset+vec3(0.17,0.37,0.63),footprint.y);}
float fieldSample(vec3 p,vec4 footprint,out vec4 cues){
  cues=vec4(0.);
  float edge=max(abs(p.x),max(abs(p.y),abs(p.z)));
  float support=1.0-smoothstep(0.76,0.99,edge);
  float envelope=support*(1.0-smoothstep(0.68,1.0,length(p*vec3(0.83,0.84,0.92))));
  if(envelope<=0.001)return 0.0;
  // Its displacement is bounded by the two noise amplitudes. Skip the cost
  // of evaluating the field in the empty cavity and outside the outer surface.
  bool halo=uMorphology==1&&uAppearance==4,shock=uMorphology==4&&uAppearance==5;
  float shellDelta=0.;
  if(halo||shock){
    shellDelta=length(p*uShapeAxes)-uShapeRadius;
    float outerWidth=halo?.065:.06;
    float maxOffset=halo?.0285:.021;
    if(abs(shellDelta)>outerWidth*uShapeThickness+maxOffset)return 0.;
  }
  float broad=cloudNoise(p*0.48+uNoiseOffset,footprint.x);
  // Medium folds change the dust field locally, with an independent warp
  // and footprint for the finest erosion.
  // The seeded knot and fold support depends only on broad and shear.
  // Its zero-density exit can precede fine noise on view and light rays.
  bool deferFine=uMorphology==2&&uAppearance==2;
  float fine=0.;
  if(!deferFine)fine=fineDustNoise(p,footprint);
  // These existing shell factors do not depend on shear or microstructure.
  // An exact zero cannot contribute density, including along the light rays.
  float shellGate=1.0;
  if(halo){
    float shellOffset=(broad-0.5)*0.045+(fine-0.5)*0.012;
    shellGate=1.0-smoothstep(0.015*uShapeThickness,0.065*uShapeThickness,abs(shellDelta+shellOffset));
  }else if(shock){
    float sectors=smoothstep(0.46,0.64,broad);
    float ridge=smoothstep(0.49,0.63,fine);
    float shockOffset=(broad-0.5)*0.032+(fine-0.5)*0.01;
    float front=1.0-smoothstep(0.012*uShapeThickness,0.06*uShapeThickness,abs(shellDelta+shockOffset));
    shellGate=front*sectors*ridge;
  }
  if(shellGate==0.0)return 0.0;
  float shear=cloudNoise(p*0.57+uNoiseOffset+vec3(0.31,0.73,0.19),footprint.z);
  vec3 q=p+vec3(broad-0.5,shear-0.5,broad-shear)*0.31;
  if(uAppearance!=0){
    // Seeded shear and nested erosion break the repeated geometric silhouette.
    // All displacement is local and stationary, including while flying inside.
    q+=vec3((shear-0.5)*0.22+sin(uPhase)*p.y*0.12,
      (broad-0.5)*0.28,(broad-0.5)*0.12+cos(uPhase)*p.y*0.1);
  }
  if(uMorphology!=0){
    // Solve macroscopic support first. Microstructure contributes only inside
    // these analytic bounds, including in the shifted illumination samples.
    float base=0.,erosionWeight=0.,microWeight=0.;
    if(uMorphology==1){
      if(uAppearance==4){
        base=shellGate*.52;
        erosionWeight=shellGate*.3;
      }else{
        float radius=length(q*uShapeAxes);
        float shell=1.0-smoothstep(0.055*uShapeThickness,0.23*uShapeThickness,abs(radius-uShapeRadius));
        base=shell*.36;erosionWeight=shell*.64;
      }
    }else if(uMorphology==2){
      float knots=0.,fold=0.;
      for(int i=0;i<4;i++)if(i<uKnotCount){
        vec4 knot=uKnots[i];
        vec3 delta=q-knot.xyz;
        if(uAppearance==2){
          // Compressed dust on one folded sheet. Adjacent seeded condensations
          // share a thinner, less dense span cut from the same eroded volume.
          delta.y+=.30*delta.x;
          delta*=vec3(.86,1.45,.94);
          if(i+1<uKnotCount){
            vec4 nextKnot=uKnots[i+1];
            if(q.x>=knot.x&&q.x<=nextKnot.x){
              float along=smoothstep(knot.x,nextKnot.x,q.x);
              vec2 centre=mix(knot.yz,nextKnot.yz,along);
              vec2 crossSection=q.yz-centre;
              float width=mix(knot.w,nextKnot.w,along);
              float distanceToFold=length(crossSection*vec2(1.65,.90))/width;
              fold=1.-smoothstep(.12,.86,distanceToFold);
            }
          }
        }
        knots=max(knots,1.-smoothstep(knot.w*.3,knot.w,length(delta)));
      }
      base=max(knots*.25,fold*.075);
      erosionWeight=max(knots,fold*.46);
    }else if(uMorphology==3){
      float sheet=1.0-smoothstep(0.045*uShapeThickness,0.29*uShapeThickness,abs(q.y+uCurve.x*sin(q.x*uCurve.z+uShapePhases.x)));
      float split=smoothstep(uRift.x,uRift.y,abs(q.x+uRift.z+uRift.w*sin(q.z*uCurve.w+uShapePhases.y)));
      float rift=sheet*split;
      base=rift*.2;erosionWeight=rift*.9;
    }else if(uMorphology==4){
      if(uAppearance==5){
        base=shellGate*.58;microWeight=shellGate*.5;
      }else{
        float shell=1.0-smoothstep(0.026*uShapeThickness,0.12*uShapeThickness,abs(length(q*uShapeAxes)-uShapeRadius));
        float sectors=smoothstep(0.38,0.65,broad+fine*0.13);
        float broken=shell*sectors;
        base=broken*.34;erosionWeight=broken*.7;
      }
    }else if(uMorphology==5){
      float stream=length(vec2(q.y-uCurve.x*sin(q.x*uCurve.z+uShapePhases.x),q.z+uCurve.y*cos(q.x*uCurve.w+uShapePhases.y)));
      float crest=1.0-smoothstep(0.045*uShapeThickness,0.2*uShapeThickness,stream);
      float wing=1.0-smoothstep(0.025*uStreamWing.z,0.09*uStreamWing.z,abs(q.y+uStreamWing.x+q.x*uStreamWing.y));
      base=crest*.24;erosionWeight=crest+wing*.14;
    }else{
      float wisps=smoothstep(0.5,0.73,broad*0.7+fine*0.3);
      base=wisps*.20;microWeight=wisps*.24;
    }
    if(base+erosionWeight+microWeight<=.025)return 0.;
    if(deferFine)fine=fineDustNoise(p,footprint);
    float micro=cloudMicrostructure(p,broad,shear,fine,footprint.w);
    float eroded=smoothstep(0.27,0.72,broad*0.48+fine*0.34+micro*0.18);
    return max(0.,base+erosionWeight*eroded+microWeight*micro-.025)*envelope;
  }
  // Unequal tapered stems and front/back layers follow the identity recipe.
  // The same erosion field and light queries serve each seeded column.
  float stems=0.0,wideStems=0.0,micro=.5;
  bool hasMicro=false;
  vec2 surfaceNormal=vec2(0.);
  for(int i=0;i<4;i++)if(i<uColumnCount){
    vec4 column=uColumns[i];
    float height=clamp((q.y+0.9)/(column.z+0.9),0.0,1.0);
    float radius=column.w*(1.0-0.35*height);
    vec2 center=column.xy+uColumnLean[i]*(q.y+0.8);
    vec2 radialVector=q.xz-center;float radial=length(radialVector);
    float edgeBase=radius+(fine-.5)*.018,topBase=column.z+(fine-.5)*.10;
    // The micro field is in [0,1]. These are the furthest positive edge and
    // top of each trunk; outside them only broad wisps can contribute.
    if(radial<edgeBase+.0275&&q.y<topBase+.025){
      if(!hasMicro){micro=cloudMicrostructure(p,broad,shear,fine,footprint.w);hasMicro=true;}
      float edgeRadius=edgeBase+(micro-.5)*.025,top=topBase+(micro-.5)*.05;
      float trunk=(1.0-smoothstep(edgeRadius-.015,edgeRadius+.015,radial))
        *(1.0-smoothstep(top-.04,top,q.y));
      if(trunk>stems)surfaceNormal=radial>0.?radialVector/radial:vec2(1.,0.);
      stems=max(stems,trunk);
    }
    float wide=(1.-smoothstep(radius,radius+.045,radial))*(1.-smoothstep(column.z-.10,column.z+.05,q.y));
    wideStems=max(wideStems,wide);
  }
  stems*=smoothstep(-1.0,-0.78,q.y);
  cues=vec4(stems,max(0.,wideStems-stems),surfaceNormal);
  float wisps=smoothstep(0.49,0.73,broad*0.65+fine*0.35)*0.40;
  float base=smoothstep(0.38,0.68,broad)*0.25*(1.0-smoothstep(-0.55,-0.1,q.y));
  float erosion=smoothstep(0.29,0.66,broad*0.45+fine*0.35+micro*0.2);
  float material=stems*(0.25+erosion*1.1)+wisps*0.45+base*0.6;
  if(uAppearance!=0){
    // Dense knots, thin eroded edges and porous channels instead of solid tubes.
    float filaments=smoothstep(0.34,0.68,micro*0.65+fine*0.35);
    material=stems*(.6+erosion*3.2)*(.8+filaments*.4)+wisps*.55+base*.9;
  }
  return max(0.0,(material-0.08)*envelope);
}

float field(vec3 p,vec4 footprint){vec4 cues;return fieldSample(p,footprint,cues);}
float rayPhase(vec2 pixel){vec3 p=fract(vec3(pixel.xyx)*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
void main(){
  if(uVisibility<=0.0||uDensity<=0.0)discard;
  vec3 rd=normalize(vLocal-uCamera);
  float pixelCone=max(length(dFdx(rd)),length(dFdy(rd)));
  vec3 inv=sign(rd+vec3(0.0000001))/max(abs(rd),vec3(0.000001));
  vec3 t0=(-vec3(1.0)-uCamera)*inv,t1=(vec3(1.0)-uCamera)*inv;
  vec3 lo=min(t0,t1),hi=max(t0,t1);
  float entry=max(0.0,max(max(lo.x,lo.y),lo.z));
  float exit=min(min(hi.x,hi.y),hi.z);
  if(uHasSceneDepth){
    vec2 uv=gl_FragCoord.xy/uSceneDepthSize;
    float surfaceDepth=texture(uSceneDepth,uv).r;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      bool hasSurface=surfaceDepth>0.0;
      float surfaceClipDepth=surfaceDepth;
    #else
      bool hasSurface=surfaceDepth<1.0;
      float surfaceClipDepth=surfaceDepth*2.0-1.0;
    #endif
    if(hasSurface){
      vec4 surface=uClipToLocal*vec4(uv*2.0-1.0,surfaceClipDepth,1.0);
      // Integrate only the dust between the camera and the actual opaque
      // surface. A first-cloud depth alone also blends dust behind that surface.
      exit=min(exit,dot(surface.xyz/surface.w-uCamera,rd));
    }
  }
  if(exit<=entry)discard;
  float stepSize=(exit-entry)/float(uSteps);
  vec4 rayCellWidths=.5*stepSize*vec4(.48,length(rd*CLOUD_FINE_SCALE),.57,length(rd*CLOUD_MICRO_SCALE));
  vec3 color=vec3(0.0);
  float transmission=1.0;
  float firstCloud=-1.0;
  float phase=rayPhase(gl_FragCoord.xy);
  for(int i=0;i<96;i++){
    if(i>=uSteps)break;
    // Stable stratified ray phase, as in the reference, decorrelates slice contours.
    float node=float(i)+phase;
    float distance=entry+node*stepSize;
    vec3 p=uCamera+rd*distance;
    float pixelFootprint=pixelCone*distance;
    vec4 footprint=max(pixelFootprint*vec4(.48,3.7,.57,10.5),rayCellWidths);
    vec4 fieldCues;
    float rho=fieldSample(p,footprint,fieldCues);
    if(uAppearance==4||uAppearance==5){
      vec3 shellNormal=normalize(p*uShapeAxes*uShapeAxes+vec3(0.000001));
      float limb=1.0-abs(dot(shellNormal,rd));
      // Suppress front/back haze so the empty shell reads through its centre.
      rho*=0.06+0.94*limb*limb;
    }
    if(rho>0.012){
      if(firstCloud<0.0)firstCloud=distance;
      vec3 lightDirection=uAppearance==0?LIGHT:uLightDirection;
      float towardLight=field(p+lightDirection*0.13,footprint);
      float lightColumn=towardLight;
      if(uAppearance!=0)lightColumn=0.65*towardLight+0.55*field(p+lightDirection*0.32,footprint);
      float illumination=0.015+0.985*exp(-lightColumn*12.0);
      float rim=clamp((rho-towardLight)*4.0,0.0,1.0);
      float structure=cloudNoise(p*2.3+uNoiseOffset+vec3(0.11),max(pixelFootprint*2.3,stepSize*1.15));
      vec3 tint=mix(uColorA,uColorB,smoothstep(0.3,0.75,structure)*0.62);
      vec3 source=tint*(0.025+illumination*1.3);
      source+=vec3(0.09,0.29,0.37)*rim*illumination*0.6;
      source+=vec3(0.62,0.29,0.07)*pow(rim,2.0)*0.15;
      if(uAppearance==0){
        // Keep legacy source modulation when no descriptor is supplied.
        source*=0.97+0.03*sin(uTime*0.035+structure*6.0);
      }else{
        // Bounded display cues reuse density, rim and the existing structure sample.
        // They suggest excitation and directional dust illumination, not transport.
        float directional=0.3+0.7*pow(max(0.0,dot(-rd,uLightDirection)),2.0);
        float excitation=0.65+uExcitation*smoothstep(0.32,0.76,structure);
        float filament=uAppearance==5?0.5+0.5*smoothstep(0.38,0.7,structure+rim*0.16):1.0;
        if(uAppearance==5){
          // The shell can cross its polar axis, where GLSL atan(0,0) is
          // undefined even though the density and optical path are finite.
          float azimuth=dot(p.xz,p.xz)>0.00000001?atan(p.z,p.x):0.0;
          float thermal=smoothstep(-0.2,0.35,sin(azimuth*2.0+uPhase)+(structure-0.5));
          tint=mix(uColorA,uColorB,thermal);
        }
        float exposed=exp(-rho*2.4);
        vec3 emissionTint=uAppearance==1?uColorA:tint;
        source=emissionTint*uEmission*excitation*filament*(0.08+exposed*0.55);
        vec3 reflection=uAppearance==1?uColorB:tint;
        float reflectedSky=uAppearance==1?0.2*exposed*smoothstep(-0.35,0.55,dot(p,uLightDirection)):0.0;
        source+=reflection*uScattering*(illumination*directional+reflectedSky);
        source+=uRimColor*rim*uRimStrength*illumination;
        // A narrow ionized skin is warmer and brighter than the dusty interior.
        // Reflection and dark-cloud families keep their own scattering contracts.
        if(uAppearance==1&&uMorphology==0){
          // Cold dust absorbs the background; a separate ionized skin emits.
          // Colour cues come from the same seeded stems used by optical density.
          float dust=clamp(fieldCues.x,0.,1.);
          vec3 columnNormal=normalize(vec3(fieldCues.z,0.,fieldCues.w)+vec3(.000001));
          float grazing=pow(1.-abs(dot(columnNormal,rd)),2.5);
          float skin=clamp(fieldCues.y*2.+rim*.3,0.,1.)*grazing;
          vec3 gas=uColorB*(.35+structure*.65);
          vec3 coldDust=uColorA*.012*(.4+illumination*.6);
          source=mix(gas,coldDust,dust);
          source+=uRimColor*skin*(.65+illumination*.8);
        }else if(uAppearance==1)source+=uRimColor*rim*illumination*uRimStrength*1.7;
        // Thin shell fronts occupy few ray samples. A fixed bounded source gain
        // reveals their muted colours without thickening or filling the cavity.
        source*=uAppearance==5?3.0:uAppearance==4?2.0:1.0;
        source*=0.99+0.01*sin(uTime*0.018+uPhase+structure*3.0);
      }
      float opticalStep=stepSize*length(mat3(uLocalToWorld)*rd)/6000.0;
      float opacity=1.0-exp(-rho*opticalStep*uDensity*7.5*uExtinction);
      color+=transmission*opacity*source;
      transmission*=1.0-opacity;
      if(transmission<0.025)break;
    }
  }
  float alpha=(1.0-transmission)*uVisibility;
  if(alpha<0.002)discard;
  // Return straight alpha because Three's normal blending premultiplies RGB.
  gl_FragColor=vec4(color/max(1.0-transmission,0.0001),alpha);
  vec3 depthPoint=uCamera+rd*max(entry,firstCloud);
  // Consume the renderer's active projection, including its first reversed
  // draw, rather than an application update from before camera initialization.
  vec4 clip=projectionMatrix*(viewMatrix*(uLocalToWorld*vec4(depthPoint,1.0)));
  #ifdef USE_REVERSED_DEPTH_BUFFER
    gl_FragDepth=clamp(clip.z/max(clip.w,0.0001),0.0,1.0);
  #else
    gl_FragDepth=clamp(0.5*clip.z/max(clip.w,0.0001)+0.5,0.0,1.0);
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Bounded artistic dust/emission volume, fixed in the caller's floating origin. */
export function createNebula({ colorA = 0x254689, colorB = 0x42a5b3, density = 1, seed = 1, identity = seed, morphology = 'columns', appearance = null } = {}) {
  const profile = appearance && Object.hasOwn(NEBULA_APPEARANCE_FAMILIES, appearance.family)
    ? NEBULA_APPEARANCE_FAMILIES[appearance.family] : null;
  const bounded = (key, fallback, min, max) => Number.isFinite(appearance?.[key])
    ? Math.max(min, Math.min(max, appearance[key])) : fallback;
  const lightDirection = new THREE.Vector3(-0.650945, 0.650945, 0.390567);
  if (profile && Array.isArray(appearance.lightDirection) && appearance.lightDirection.length === 3
    && appearance.lightDirection.every(Number.isFinite) && appearance.lightDirection.some(value => value !== 0)) {
    // Scaling before normalization also keeps very large finite caller input finite.
    const scale = Math.max(...appearance.lightDirection.map(Math.abs));
    lightDirection.fromArray(appearance.lightDirection.map(value => value / scale)).normalize();
  }
  const palette = key => profile && Number.isInteger(appearance[key]) && appearance[key] >= 0 && appearance[key] <= 0xffffff
    ? appearance[key] : profile?.[key] ?? (key === 'colorA' ? colorA : colorB);
  const group = new THREE.Group();
  group.name = 'Structured interstellar dust columns';
  const numericSeed = typeof seed === 'number' ? seed >>> 0 : [...String(seed)]
    .reduce((hash, letter) => Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const morphologyIndex = Math.max(0, ['columns', 'halo', 'knots', 'rift', 'shell', 'stream', 'wisps'].indexOf(morphology));
  const columns = morphologyIndex === 0 ? describeNebulaColumns({identity, seed}) : [];
  const structure=describeNebulaStructure({identity,seed,morphology});
  const uniforms = {
    uColumnCount: {value:columns.length},
    uShapeAxes: {value:new THREE.Vector3().fromArray(structure.axes)},
    uShapeRadius: {value:structure.radius},uShapeThickness: {value:structure.thickness},
    uCurve: {value:new THREE.Vector4().fromArray(structure.curve)},
    uRift: {value:new THREE.Vector4().fromArray(structure.rift)},
    uShapePhases: {value:new THREE.Vector2().fromArray(structure.phases)},
    uStreamWing: {value:new THREE.Vector3().fromArray(structure.streamWing)},
    uKnotCount: {value:structure.knots.length},
    uKnots: {value:Array.from({length:4},(_,i)=>structure.knots[i]?new THREE.Vector4().fromArray(structure.knots[i]):new THREE.Vector4())},
    uColumns: {value:Array.from({length:4},(_,i)=>columns[i]?new THREE.Vector4().fromArray(columns[i].shape):new THREE.Vector4())},
    uColumnLean: {value:Array.from({length:4},(_,i)=>columns[i]?new THREE.Vector2().fromArray(columns[i].lean):new THREE.Vector2())},
    uCamera: { value: new THREE.Vector3() },
    uColorA: { value: new THREE.Color(palette('colorA')) },
    uColorB: { value: new THREE.Color(palette('colorB')) },
    uRimColor: { value: new THREE.Color(palette('rimColor')) },
    uNoiseOffset: { value: new THREE.Vector3((numericSeed % 251) / 251, (numericSeed % 241) / 241, (numericSeed % 239) / 239) },
    uLocalToWorld: { value: new THREE.Matrix4() },
    uSceneDepth: { value: null },
    uSceneDepthSize: { value: new THREE.Vector2(1, 1) },
    uClipToLocal: { value: new THREE.Matrix4() },
    uHasSceneDepth: { value: false },
    uDensity: { value: Number.isFinite(density) ? Math.max(0, Math.min(2, density)) : 1 },
    uVisibility: { value: 1 },
    uSteps: { value: 64 },
    uMorphology: { value: morphologyIndex },
    uTime: { value: 0 },
    uAppearance: { value: profile?.code ?? 0 },
    uLightDirection: { value: lightDirection },
    uEmission: { value: profile ? bounded('emission', profile.emission, 0, .6) : 0 },
    uScattering: { value: profile ? bounded('scattering', profile.scattering, 0, 1) : 0 },
    uExcitation: { value: profile ? bounded('excitation', profile.excitation, 0, .6) : 0 },
    uRimStrength: { value: profile ? bounded('rimStrength', profile.rimStrength, 0, .5) : 0 },
    uExtinction: { value: profile ? bounded('extinction', profile.extinction, .5, 2) : 1 },
    uPhase: { value: profile ? bounded('phase', 0, 0, Math.PI * 2) : 0 },
  };
  if (profile?.code === 3) {
    uniforms.uEmission.value = 0; uniforms.uExcitation.value = 0;
    uniforms.uScattering.value = Math.min(.035, uniforms.uScattering.value);
    uniforms.uRimStrength.value = Math.min(.015, uniforms.uRimStrength.value);
  }
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms, vertexShader, fragmentShader,
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true,
  });
  const volume = new THREE.Mesh(geometry, material);
  volume.position.fromArray(NEBULA_VOLUME.center);
  volume.scale.fromArray(NEBULA_VOLUME.halfExtents);
  // The compositor binds a depth snapshot, never the attachment currently being
  // rendered into. Keep direct createNebula/render callers backward compatible.
  volume.userData.setSceneDepth = (depth, width, height, camera) => {
    uniforms.uHasSceneDepth.value = depth !== null;
    uniforms.uSceneDepth.value = depth;
    if (depth === null) return;
    uniforms.uSceneDepthSize.value.set(width, height);
    volume.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    uniforms.uClipToLocal.value.copy(volume.matrixWorld).invert()
      .multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
  };
  group.add(volume);
  let disposed = false;
  const cameraPosition = new THREE.Vector3();
  const boundsPoint = new THREE.Vector3();
  const localBounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const worldBounds = new THREE.Box3(), frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
  group.userData.isInView = camera => {
    volume.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    worldBounds.copy(localBounds).applyMatrix4(volume.matrixWorld);
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem, camera.reversedDepth);
    return frustum.intersectsBox(worldBounds);
  };
  // Fade from the transformed cloud volume, not its caller's chunk origin.
  // The nearest point on this oriented box remains zero everywhere inside it.
  group.userData.distanceToVolume = worldPosition => {
    volume.updateWorldMatrix(true, false);
    boundsPoint.copy(worldPosition);
    volume.worldToLocal(boundsPoint).clampScalar(-1, 1);
    return volume.localToWorld(boundsPoint).distanceTo(worldPosition);
  };
  group.userData.stats = { steps: 64, morphology, bounds: [9000, 6700, 16300], opticalApproximation: true };
  group.userData.update = (camera, time, { quality = 'auto', visibility = 1 } = {}) => {
    if (disposed || !camera) return;
    group.updateWorldMatrix(true, true);
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(cameraPosition);
    uniforms.uCamera.value.copy(cameraPosition);
    volume.worldToLocal(uniforms.uCamera.value);
    uniforms.uLocalToWorld.value.copy(volume.matrixWorld);
    uniforms.uTime.value = Number.isFinite(time) ? time : 0;
    uniforms.uVisibility.value = Number.isFinite(visibility) ? Math.max(0, Math.min(1, visibility)) : 0;
    uniforms.uSteps.value = quality === 'low' ? 32 : quality === 'high' ? 96 : 64;
    group.userData.stats.steps = uniforms.uSteps.value;
  };
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    geometry.dispose();
    material.dispose();
  };
  return group;
}
