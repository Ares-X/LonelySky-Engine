import {gasMacroUniforms} from './gas-cloud-macro.js';
import {NATURAL_RING_GLSL} from '../natural-ring.js';
import {COSMIC_BODY_NOISE_GLSL} from './cosmic-body-noise.js';
export {COSMIC_BODY_NOISE_GLSL} from './cosmic-body-noise.js';
import {RING_HABITAT_ECOLOGY} from '../ring-habitat.js';
import * as THREE from 'three';
import {COSMIC_SPHERE_SURFACE_GLSL} from './cosmic-sphere-surface.js';
import {GAS_CLOUD_MATERIAL_SCALES} from './gas-cloud-material.js';
import {FLAT_DECK_SURFACE_GLSL} from './ring-flat-deck.js';
import {RING_ENGINEERING_MATERIAL_GLSL} from './ring-engineering-material.js';
import {RING_HABITAT_SURFACE_GLSL} from './ring-habitat-surface.js';
import {RING_HABITAT_AIR_GLSL} from './ring-habitat-atmosphere.js';
import {RING_HABITAT_SHADOW_GLSL,createRingHabitatShadowUniforms} from './ring-habitat-shadows.js';
import {RING_HABITAT_GEOMETRY_GLSL,createRingHabitatGeometryTexture,createEmptyRingHabitatGeometryTexture,setRingHabitatGeometry} from './ring-habitat-geometry.js';
import {RING_SURFACE_LATTICE_GLSL} from '../ring-surface-lattice.js';

const RING_SECTION_CAPACITY = 64;

const BODY_KINDS = Object.freeze({ ring: 1, 'gas-giant': 2, 'dark-world': 3, 'stellar-giant': 4, moon: 5, 'icy-moon': 6 });
const PROMINENCE_FOOT = .996, PROMINENCE_HALF_SPAN = 1.12, PROMINENCE_HEIGHT = 1.16;

export function stellarProminenceSupport(width,height){
  return Math.hypot(PROMINENCE_FOOT+height*PROMINENCE_HEIGHT,width*PROMINENCE_HALF_SPAN);
}

// Every length in the shader is divided by the descriptor radius. The solid
// catalogue, rather than a second rendering model, owns all slab dimensions.
export const COSMIC_BODY_INTERSECTIONS_GLSL = /* glsl */`
uniform int uBodyKind,uSectionCount,uHabitatClimate;
uniform float uBodyRadius,uSphereRadius,uPhase,uRayMinimum,uVisibility,uPixelAngle;
uniform vec3 uBodyOrigin,uLight,uTint,uHabitatEcology,uRingVoid,uRingCore;
uniform mat3 uBodyFrame;
uniform vec4 uSections[${RING_SECTION_CAPACITY}];
// xy holds the gap. zw holds double-computed squared radial clearances for camera rays.
uniform vec4 uGaps[${RING_SECTION_CAPACITY}];
uniform highp sampler2D uRingLattices;
uniform bool uRinged;
uniform vec3 uPlasmaAxes[3];
uniform vec2 uPlasmaRadii[3];
const float BODY_TAU=6.28318530718;
bool solidArc(vec3 p,vec2 gap){
  return gap.y<=0.||abs(atan(sin(atan(p.z,p.x)-gap.x),cos(atan(p.z,p.x)-gap.x)))>=gap.y;
}
void acceptSurface(float t,vec3 p,vec3 n,vec3 ray,bool shadowRay,float minimum,inout float nearest,inout vec3 point,inout vec3 normal){
  // A rounded primary point can leave a sun ray just beneath its source
  // wall. Its outward exit cannot cast a shadow; a later entry still can.
  if(t>minimum&&t<nearest&&(!shadowRay||dot(n,ray)<0.)){nearest=t;point=p;normal=n;}
}
bool sectionCast(vec3 origin,vec3 ray,vec4 bounds,vec2 gap,vec2 cameraWallC,bool useCameraClearance,bool shadowRay,float minimum,out vec3 point,out vec3 normal,out float nearest){
  nearest=1.e25;point=vec3(0.);normal=vec3(0.);
  float planar=dot(ray.xz,ray.xz),along=dot(origin.xz,ray.xz);
  if(planar>1.e-12)for(int wall=0;wall<2;wall++){
    float radius=wall==0?bounds.x:bounds.y;
    // Near a cylinder wall the radial clearance is far smaller than either
    // squared radius. Use the camera's double-computed c and the product of
    // the roots to retain both a shallow grazing hit and a short downward hit.
    float c=cameraWallC[wall];
    bool nearWall=useCameraClearance&&abs(c)<.25*radius*radius;
    float crossDistance=origin.x*ray.z-origin.z*ray.x;
    float discriminant=nearWall?along*along-planar*c:planar*radius*radius-crossDistance*crossDistance;
    if(discriminant<0.)continue;
    float root=sqrt(discriminant);
    vec2 roots;
    if(nearWall){
      float q=-along-(along>=0.?root:-root);
      roots=vec2(q/planar,q==0.?0.:c/q);
    }else{
      // Far views and surface-origin shadow rays use their own closest
      // approach, preserving the silhouette without subtracting large squares.
      roots=(vec2(-root,root)-along)/planar;
    }
    for(int side=0;side<2;side++){
      float t=roots[side];vec3 p=origin+ray*t;
      if(p.y>=bounds.z&&p.y<=bounds.w&&solidArc(p,gap))
        acceptSurface(t,p,normalize(vec3(p.x,0.,p.z))*(wall==0?-1.:1.),ray,shadowRay,minimum,nearest,point,normal);
    }
  }
  if(abs(ray.y)>1.e-10)for(int side=0;side<2;side++){
    float t=((side==0?bounds.z:bounds.w)-origin.y)/ray.y;vec3 p=origin+ray*t;
    float r=length(p.xz);
    if(r>=bounds.x&&r<=bounds.y&&solidArc(p,gap))
      acceptSurface(t,p,vec3(0.,side==0?-1.:1.,0.),ray,shadowRay,minimum,nearest,point,normal);
  }
  if(gap.y>0.)for(int end=0;end<2;end++){
    float angle=gap.x+(end==0?-1.:1.)*gap.y;
    vec3 radial=vec3(cos(angle),0.,sin(angle)),tangent=vec3(-radial.z,0.,radial.x);
    float denominator=dot(ray,tangent);if(abs(denominator)<1.e-10)continue;
    float t=-dot(origin,tangent)/denominator;vec3 p=origin+ray*t;float r=dot(p,radial);
    if(r>=bounds.x&&r<=bounds.y&&p.y>=bounds.z&&p.y<=bounds.w)
      acceptSurface(t,p,tangent*(end==0?1.:-1.),ray,shadowRay,minimum,nearest,point,normal);
  }
  return nearest<1.e24;
}
${RING_SURFACE_LATTICE_GLSL}
${RING_HABITAT_GEOMETRY_GLSL}
bool ringGeometryOverflow=false,ringTerrainHit=false,ringExteriorHit=false;
vec3 ringTerrainMaterialNormal=vec3(0.);
float ringTerrainRockCoverage=0.;
bool rayClearsRingVoid(vec3 origin,vec3 ray,float minimum){
  if(uHabitatGroupCount>0||abs(ray.y)<1.e-6)return false;
  // The part catalogue bounds the axial span of every hull surface. If
  // both endpoints of the ray there are inside the empty inner cylinder,
  // the entire interval misses by convexity. No geometric detail is dropped.
  vec2 heights=(uRingVoid.yz-origin.y)/ray.y;
  float start=max(minimum,min(heights.x,heights.y)),end=max(heights.x,heights.y);
  if(end<start)return true;
  vec2 a=origin.xz+start*ray.xz,b=origin.xz+end*ray.xz;
  return max(dot(a,a),dot(b,b))<uRingVoid.x*uRingVoid.x;
}
// The first three habitat courses share the same inner floor cylinder.
// A ray from the open interior that reaches this cylinder inside its
// unobstructed axial span cannot have touched an enclosing exterior part.
bool ringInnerFloor(vec3 origin,vec3 ray,float minimum,bool cameraRay,out vec3 point,out float distance){
  point=vec3(0.);distance=1.e25;
  float radius=uRingCore.x;
  float clearance=cameraRay?-uGaps[0].z:radius*radius-dot(origin.xz,origin.xz);
  if(uHabitatGroupCount>0||radius<=0.||clearance<=0.
    ||origin.y<=uRingCore.y||origin.y>=uRingCore.z)return false;
  float a=dot(ray.xz,ray.xz);
  if(a<1.e-12)return false;
  float b=dot(origin.xz,ray.xz), c=clearance;
  float root=sqrt(b*b+a*c);
  // The rationalized root avoids subtracting nearly equal positive terms
  // for an orbit-skimming camera next to the cylinder and looking outward.
  float hit=b>=0.?c/max(root+b,1.e-20):(root-b)/a;
  if(hit<=minimum)return false;
  vec3 p=origin+ray*hit;
  if(p.y<=uRingCore.y||p.y>=uRingCore.z)return false;
  for(int i=0;i<3;i++){
    vec4 section=uSections[i];
    if (p.y>section.z+.000001 && p.y<section.w-.000001 && solidArc(p,uGaps[i].xy)){
      point=p;distance=hit;return true;
    }
  }
  return false;
}
const int RING_CAMERA_RAY=0,RING_SHADOW_RAY=1,RING_REFLECTED_RAY=2;
bool ringCast(vec3 origin,vec3 ray,float minimum,int rayKind,out vec3 point,out vec3 normal,out float nearest){
  bool cameraRay=rayKind==RING_CAMERA_RAY,shadowRay=rayKind==RING_SHADOW_RAY;
  ringTerrainHit=false;ringExteriorHit=false;ringTerrainRockCoverage=0.;nearest=1.e25;point=vec3(0.);normal=vec3(0.);
  if(rayClearsRingVoid(origin,ray,minimum))return false;
  if(ringInnerFloor(origin,ray,minimum,cameraRay,point,nearest)){
    normal=-normalize(vec3(point.x,0.,point.z));return true;
  }
  // Wide courses surround the empty interior. Their support sphere includes
  // that hole, so cull against the entire raised annular slab before visiting
  // its caps, gap edges and plate lattice. Keep ambiguous grazing rays in the
  // exact path. The allowance scales with float32 ray reconstruction distance.
  float shellPad=1.e-5*max(1.,length(origin));
  bool clipCourses=abs(ray.y)>1.e-6&&dot(ray.xz,ray.xz)>1.e-6;
  for(int part=0;part<${RING_SECTION_CAPACITY};part++){
    if(part>=uSectionCount)break;
    // A short buttress occupies a small part of the full ring. Its catalogue
    // support sphere rejects rays before the analytic slab intersections;
    // it never substitutes for the actual curved solid or writes depth.
    vec4 support=texelFetch(uRingLattices,ivec2(part,1),0);
    vec3 relative=origin-support.xyz;
    float along=dot(relative,ray),perp2=dot(cross(relative,ray),cross(relative,ray));
    float disc=support.w*support.w-perp2;
    if(disc<0.||-along+sqrt(max(disc,0.))<=minimum)continue;
    vec3 p,n;float t;
    vec4 lattice=texelFetch(uRingLattices,ivec2(part,0),0);
    if(clipCourses&&uGaps[part].y<=1.57079632679){
      vec4 shell=uSections[part]+vec4(-shellPad,lattice.w+shellPad,-shellPad,shellPad);
      shell.x=max(0.,shell.x);
      vec4 intervals;int count;
      if(!ringLatticeIntervals(origin,ray,shell,vec2(minimum,nearest),intervals,count))continue;
    }
    // Negative metadata tags one I-sector: exactly three catalogue-owned
    // closed slabs inside its unchanged support. No new uniform or mesh.
    for(int member=0;member<3;member++){
      if(member>0&&lattice.x>=0.)break;
      vec4 bounds=uSections[part];vec2 gap=uGaps[part].xy;
      if(lattice.x<0.){
        if(member==0)bounds.z=bounds.w-lattice.y;
        else if(member==1)gap.y=lattice.z;
        else bounds.w=bounds.z+lattice.y;
      }
      if(sectionCast(origin,ray,bounds,gap,uGaps[part].zw,cameraRay,shadowRay,minimum,p,n,t)&&t<nearest){
        nearest=t;point=p;normal=n;ringExteriorHit=part>=6;
        if(shadowRay)return true;
      }
    }
    if(lattice.x>0.){
      int packed=int(lattice.x),columns=packed/128,rows=packed-columns*128;
      int admitted=int(lattice.z),first=admitted/4096,last=admitted-first*4096;
      vec4 shell=vec4(uSections[part].y,uSections[part].y+lattice.w,uSections[part].zw);
      bool overflow,tiered=lattice.y<0.;
      uint seed=uint(tiered?-lattice.y-1.:lattice.y);
      if(ringLatticeCast(origin,ray,shell,uGaps[part].xy,ivec2(columns,rows),seed,ivec2(first,last),tiered,shadowRay,minimum,nearest,p,n,t,overflow)&&t<nearest){
        nearest=t;point=p;normal=n;ringExteriorHit=part>=6;
        if(shadowRay)return true;
      }
      if(overflow){ringGeometryOverflow=true;nearest=max(minimum+1.e-6,min(nearest,1.));point=origin+ray*nearest;normal=-ray;return true;}
    }
  }
  vec3 terrainPoint,terrainNormal;float terrainDistance;
  if(habitatTerrainCast(origin,ray,shadowRay,minimum,nearest,terrainPoint,terrainNormal,terrainDistance)){
    nearest=terrainDistance;point=terrainPoint;normal=terrainNormal;ringTerrainHit=true;ringTerrainMaterialNormal=habitatTerrainShadingNormal;ringTerrainRockCoverage=habitatTerrainRockCoverage;
  }
  if(habitatTerrainOverflow>.5){ringGeometryOverflow=true;nearest=max(minimum+1.e-6,min(nearest,1.));point=origin+ray*nearest;normal=-ray;return true;}
  return nearest<1.e24;
}
bool bodyCast(vec3 origin,vec3 ray,float minimum,out vec3 point,out vec3 normal,out float distance){
  if(uBodyKind==1)return ringCast(origin,ray,minimum,RING_CAMERA_RAY,point,normal,distance);
  float along=dot(origin,ray),perpendicular2=dot(cross(origin,ray),cross(origin,ray));
  float discriminant=uSphereRadius*uSphereRadius-perpendicular2;
  point=vec3(0.);normal=vec3(0.);distance=1.e25;
  if(discriminant<0.)return false;
  float root=sqrt(discriminant);distance=-along-root;
  if(distance<=minimum)distance=-along+root;
  if(distance<=minimum)return false;
  point=origin+ray*distance;normal=point/uSphereRadius;return true;
}
${NATURAL_RING_GLSL}
float gasRingCast(vec3 origin,vec3 ray,out vec3 point,out float distance){
  point=vec3(0.);distance=1.e25;
  if(!uRinged)return 0.;
  vec3 lit;float alpha=naturalRingColumn(origin,ray,uRayMinimum,1.e15,false,distance,lit);
  if(alpha>0.)point=origin+ray*distance;
  return alpha;
}
float prominenceThread(float offset,float width,float footprint){
  float band=length(vec2(width,footprint*.55));
  float d=offset/band;
  return exp(-d*d)*width/band;
}
float plasmaCast(vec3 origin,vec3 ray,float minimum,float maximum,out float nearest,out vec3 spectrum){
  nearest=1.e25;float emission=0.;spectrum=vec3(0.);
  float hot=step(uTint.r,uTint.b);
  for(int loop=0;loop<3;loop++){
    vec3 anchor=uPlasmaAxes[loop];if(dot(anchor,anchor)<.5)continue;
    vec3 reference=abs(anchor.y)<.95?vec3(0.,1.,0.):vec3(1.,0.,0.);
    vec3 meridian=normalize(reference-anchor*dot(reference,anchor));
    float phase=uPhase+float(loop)*2.399963;
    float twist=.40*sin(phase);
    vec3 tangent=meridian*cos(twist)+cross(anchor,meridian)*sin(twist);
    vec3 plane=cross(anchor,tangent);
    float denominator=dot(ray,plane);if(abs(denominator)<1.e-8)continue;
    vec3 center=anchor*${PROMINENCE_FOOT};float t=dot(center-origin,plane)/denominator;
    if(t<=minimum||t>=maximum)continue;
    vec3 delta=origin+ray*t-center;
    vec2 size=uPlasmaRadii[loop];
    vec2 p=vec2(dot(delta,tangent),dot(delta,anchor))/size;
    if(abs(p.x)>${PROMINENCE_HALF_SPAN}||p.y<0.||p.y>${PROMINENCE_HEIGHT})continue;

    // Inclined sheets of emission rise from paired feet. The broad spine and
    // its two finer threads share a bend while opening a dark space between them.
    float skew=.26*sin(phase*1.3),x=p.x;
    float dome=sqrt(max(0.,1.-x*x));
    float ridge=dome*(.85+skew*x+.04*sin(x*8.+phase));
    float projectedPixel=t*uPixelAngle/(min(size.x,size.y)*max(abs(denominator),.05));
    float separation=dome*(.085+.045*hot);
    float core=prominenceThread(p.y-ridge,.019,projectedPixel);
    float filament=prominenceThread(p.y-ridge+separation,.011,projectedPixel);
    float skirt=prominenceThread(p.y-ridge+separation*1.8,.035,projectedPixel);
    float ribbon=(.68*core+.30*filament+.12*skirt)
      *smoothstep(0.,.08,p.y)*(1.-smoothstep(.94,${PROMINENCE_HALF_SPAN},abs(x)));
    ribbon*=.56+.44*smoothstep(-.6,.8,sin(x*11.+phase)+.33*sin(x*24.-phase));
    if(ribbon>.002){
      nearest=min(nearest,t);
      emission+=ribbon;
      vec3 color=mix(mix(vec3(1.,.22,.055),vec3(1.42,.65,.26),core),
        mix(vec3(.17,.35,1.),vec3(.59,.92,1.4),core),hot);
      spectrum+=ribbon*color;
    }
  }
  if(emission>0.)spectrum/=emission;
  return emission;
}
`;


export const COSMIC_BODY_SURFACE_GLSL = /* glsl */`
#ifdef GAS_OBSERVED_CLOUDS
  uniform sampler2D uClouds;
  uniform vec3 uCloudColorMean;
#endif
#ifdef OBSERVED_STELLAR_SURFACE
  uniform sampler2D uStellar;
  uniform bool uHasStellar,uHasStellarPhotosphere;
  uniform vec4 uPhotosphereUV;
  uniform vec3 uPhotosphereParameters;
#endif
#ifdef SCANNED_ROCK_SURFACE
  uniform sampler2D uHabitatRockColor,uHabitatRockNormal;
  uniform bool uHasHabitatMaterials;
  uniform vec2 uHabitatMaterialTileSize;
  uniform vec3 uHabitatRockColorMean,uHabitatRockPhase;
#endif
${COSMIC_BODY_NOISE_GLSL}
float plateSeam(float p,float footprint){
  float edge=min(fract(p),1.-fract(p));
  return mix(1.-smoothstep(.003,.014+footprint,edge),.018,smoothstep(.12,.6,footprint));
}
vec2 bodyUV(vec3 n){
  float longitude=dot(n.xz,n.xz)>1.e-12?atan(n.z,n.x):0.;
  return vec2(longitude/BODY_TAU+uPhase,.5+asin(clamp(n.y,-1.,1.))/3.14159265359);
}
vec3 bodyMap(sampler2D map,vec2 uv){
  vec2 dx=dFdx(uv),dy=dFdy(uv);dx.x-=floor(dx.x+.5);dy.x-=floor(dy.x+.5);
  return textureGrad(map,uv,dx,dy).rgb;
}
#ifdef HABITAT_SURFACE_MAP
uniform sampler2D uSurface;
float habitatSurfaceTextureGain(vec3 point){
  vec2 uv=vec2(atan(point.z,point.x),point.y)*uBodyRadius/6500.+uPhase;
  float geological=dot(bodyMap(uSurface,uv),vec3(.2126,.7152,.0722));
  return 1.+(geological-.35)*.2;
}
#endif
// Value and analytic spatial derivative of the same cubic-interpolated field.
// The height and its material normal therefore cannot invent separate ridges.
vec4 ringNoiseGradient(vec3 p){
  vec3 i=floor(p),f=fract(p),s=f*f*(3.-2.*f),ds=6.*f*(1.-f);
  float a=bodyHash(i),b=bodyHash(i+vec3(1,0,0)),c=bodyHash(i+vec3(0,1,0)),d=bodyHash(i+vec3(1,1,0));
  float e=bodyHash(i+vec3(0,0,1)),g=bodyHash(i+vec3(1,0,1)),h=bodyHash(i+vec3(0,1,1)),j=bodyHash(i+vec3(1,1,1));
  float x00=mix(a,b,s.x),x10=mix(c,d,s.x),x01=mix(e,g,s.x),x11=mix(h,j,s.x);
  float z0=mix(x00,x10,s.y),z1=mix(x01,x11,s.y);
  return vec4(mix(z0,z1,s.z),
    mix(mix(b-a,d-c,s.y),mix(g-e,j-h,s.y),s.z)*ds.x,
    mix(x10-x00,x11-x01,s.z)*ds.y,(z1-z0)*ds.z);
}
vec4 ringWorldField(vec3 world,float scale,float footprint,bool ridge){
  float ratio=footprint/scale,mean=ridge?.55:.5;
  if(ratio>=1.1)return vec4(mean,0.,0.,0.);
  vec4 field=ringNoiseGradient(world/scale);
  if(ridge){
    float crest=1.-abs(field.x*2.-1.);
    field.yzw*=-4.*crest*sign(field.x-.5);
    field.x=crest*crest;
  }
  // Fade unresolved *heights and slopes*, without moving the field or changing
  // its phase. The ridge mean is applied after the nonlinear ridge transform.
  field=mix(field,vec4(mean,0.,0.,0.),smoothstep(.3,1.1,ratio));
  field.yzw/=scale;
  return field;
}
vec4 ringRockRidge(vec3 world,float scale,float footprint){
  // One fixed anisotropic geological frame stretches and shears the ranges.
  // Transform the derivative back with the same Jacobian, not an unrelated
  // normal perturbation. The footprint bound includes that fixed stretch.
  vec3 a=vec3(.77,.16,.64),b=vec3(-.18,1.6,.27),c=vec3(-.41,.23,.49);
  vec4 field=ringWorldField(vec3(dot(world,a),dot(world,b),dot(world,c)),scale,footprint*2.,true);
  field.yzw=a*field.y+b*field.z+c*field.w;
  return field;
}
float ringDirectLight(vec3 point,vec3 geometricNormal,vec3 materialNormal){
  if(dot(geometricNormal,uLight)<=0.)return 0.;
  float diffuse=max(dot(materialNormal,uLight),0.);
  if(diffuse>.02){vec3 blocker,bn;float t;
    if(ringCast(point+geometricNormal*max(.35/uBodyRadius,1.e-7),uLight,max(.2/uBodyRadius,1.e-7),RING_SHADOW_RAY,blocker,bn,t))diffuse*=.06;
  }
  return diffuse;
}
${RING_HABITAT_AIR_GLSL}
${RING_HABITAT_SHADOW_GLSL}
${RING_ENGINEERING_MATERIAL_GLSL}
${RING_HABITAT_SURFACE_GLSL}
${FLAT_DECK_SURFACE_GLSL}
vec3 ringSurface(vec3 point,vec3 geometricNormal,vec3 ray,float distance){
  vec3 radial=normalize(vec3(point.x,0.,point.z));
  bool inside=ringTerrainHit||(!ringExteriorHit&&dot(geometricNormal,radial)<-.5);
  #ifdef HABITAT_PORT_MAP
  vec4 picture=vec4(0.);
  if(inside&&uHasHabitatPort&&uHasHabitatMap){
    picture=habitatPortPicture(habitatDeckPoint(point));
    if(picture.a>=1.)return picture.rgb;
  }
  #endif
  vec3 color;
  if(uFlatHabitatDeck)color=flatDeckSurface(point,geometricNormal,ray,distance);
  else if(inside)color=habitatSurface(point,geometricNormal,ray,distance,uSections[0].x,ringTerrainHit?ringTerrainMaterialNormal:geometricNormal,ringTerrainRockCoverage);
  else color=engineeringSurface(point,geometricNormal,ray,distance);
  #ifdef HABITAT_PORT_MAP
  color=mix(color,picture.rgb,picture.a);
  #endif
  return color;
}
${COSMIC_SPHERE_SURFACE_GLSL}
`;

// cloudColorMean is copied numeric metadata, validated at createCosmicBodies.
// Its unit default preserves low-level callers with uncalibrated modulation maps.
export function cosmicBodyUniforms({ surfaceTexture = null, cloudTexture = null, cloudColorMean = [1,1,1], stellarTexture = null, photosphereMaterial = null, habitatTexture = null, habitatMaterials = null } = {}) {
  // This optional set is borrowed from the embedding app. The public engine
  // retains its procedural material path without game-owned image assets.
  // The slot owns this numeric metadata texture. Its three materials share it;
  // image maps remain borrowed. Row 0 stores catalogue lattice integers/depth;
  // row 1 stores normalized support spheres, outside uniform-vector storage.
  const habitatTerrain=createEmptyRingHabitatGeometryTexture();
  const ringLattices = new THREE.DataTexture(new Float32Array(RING_SECTION_CAPACITY * 2 * 4), RING_SECTION_CAPACITY, 2, THREE.RGBAFormat, THREE.FloatType);
  ringLattices.name = 'Cosmic ring lattice metadata';
  ringLattices.minFilter = THREE.NearestFilter;
  ringLattices.magFilter = THREE.NearestFilter;
  ringLattices.generateMipmaps = false;
  ringLattices.needsUpdate = true;
  return {
    ...createRingHabitatShadowUniforms(),
    uFlatHabitatDeck:{value:false},
    uHasHabitatPort: { value: false }, uHabitatTerrainReferenceRadius: { value: 1 }, uHabitatPort: { value: new THREE.Vector2() }, uHabitatPortAxes: { value: new THREE.Vector2(1, 0) },
    uHabitatSize: { value: new THREE.Vector2() }, uHabitatMap: { value: habitatTexture }, uHasHabitatMap: { value: false },

    uHaloNearDepth:{value:null},uHaloNearDepthEnabled:{value:0},uHaloNearDepthSize:{value:new THREE.Vector2(1,1)},uHaloNearDepthCamera:{value:new THREE.Vector2(.5,220000)},
    uHabitatWind:{value:new THREE.Vector3()},
    uRingVoid:{value:new THREE.Vector3()},
    uRingCore:{value:new THREE.Vector3()},
    uHabitatSampleIndex:{value:0},
    uHasHabitatMaterials:{value:habitatMaterials!==null},
    uHabitatRockColor:{value:habitatMaterials===null?null:habitatMaterials.rockColor},
    uHabitatRockNormal:{value:habitatMaterials===null?null:habitatMaterials.rockNormal},
    uHabitatGroundColor:{value:habitatMaterials?.groundColor??null},
    uHabitatGroundNormal:{value:habitatMaterials?.groundNormal??null},
    uHabitatMaterialTileSize:{value:new THREE.Vector2(habitatMaterials===null?1:habitatMaterials.rockTileSize,habitatMaterials?.groundTileSize??1)},
    uHabitatRockPhase:{value:new THREE.Vector3()},uHabitatGroundPhase:{value:new THREE.Vector3()},
    uHabitatRockColorMean:{value:new THREE.Vector3().fromArray(habitatMaterials===null?[1,1,1]:habitatMaterials.rockColorMean)},
    uHabitatGroundColorMean:{value:new THREE.Vector3().fromArray(habitatMaterials?.groundColorMean??[1,1,1])},
    uHabitatClimate: {value:0}, uHabitatEcology:{value:new THREE.Vector3(RING_HABITAT_ECOLOGY[0].forestCeiling,RING_HABITAT_ECOLOGY[0].snowLine,RING_HABITAT_ECOLOGY[0].treeDensity)}, uHabitatTerrain:{value:habitatTerrain},uHabitatGroupCount:{value:0},
    uBodyKind: { value: 0 }, uBodyRadius: { value: 1 }, uSphereRadius: { value: 1 }, uPhase: { value: 0 }, uRayMinimum: { value: 0 }, uVisibility: { value: 1 },
    uBodyOrigin: {value:new THREE.Vector3()}, uBodyCenter: { value: new THREE.Vector3() }, uBodyFrame: { value: new THREE.Matrix3() },
    ...gasMacroUniforms(),
    uGasNoiseCells:{value:GAS_CLOUD_MATERIAL_SCALES.map(()=>new THREE.Vector3())},
    uGasNoiseFractions:{value:GAS_CLOUD_MATERIAL_SCALES.map(()=>new THREE.Vector3())},
    uNaturalRingGrainResolved:{value:false},
    uLight: { value: new THREE.Vector3() }, uTint: { value: new THREE.Color() }, uRinged: { value: false },
    uRingLattices: { value: ringLattices }, uSectionCount: { value: 0 }, uSections: { value: Array.from({ length: RING_SECTION_CAPACITY }, () => new THREE.Vector4()) }, uGaps: { value: Array.from({ length: RING_SECTION_CAPACITY }, () => new THREE.Vector4()) },
    uPlasmaAxes: { value: Array.from({ length: 3 }, () => new THREE.Vector3()) }, uPlasmaRadii: { value: Array.from({ length: 3 }, () => new THREE.Vector2(1, 1)) },
    uSurface: { value: surfaceTexture }, uHasSurface: { value: Boolean(surfaceTexture) },
    uClouds: { value: cloudTexture },
    uCloudColorMean: { value: new THREE.Vector3().fromArray(cloudColorMean) },
    uStellar: { value: stellarTexture }, uHasStellar: { value: Boolean(stellarTexture) },
    uHasStellarPhotosphere:{value:photosphereMaterial!==null},
    uPhotosphereUV:{value:new THREE.Vector4().fromArray(photosphereMaterial===null?[0,0,1,1]:photosphereMaterial.uvRect)},
    uPhotosphereParameters:{value:new THREE.Vector3(photosphereMaterial===null?1:photosphereMaterial.linearLumaMean,photosphereMaterial===null?1:photosphereMaterial.tileGranules,photosphereMaterial===null?0:photosphereMaterial.maxLod)},
  };
}

export function setCosmicBody(uniforms, body, gasWeatherTime = 0, gasVelocity = null) {
  const habitatImage = uniforms.uHabitatMap.value?.image;
  uniforms.uHasHabitatMap.value = Boolean(habitatImage && habitatImage.width > 0 && habitatImage.height > 0);
  uniforms.uHasHabitatPort.value = Boolean(body.habitatPort);
  if (body.habitatPort) {
    uniforms.uHabitatPort.value.set(body.habitatPort.along, body.habitatPort.across);
    uniforms.uHabitatTerrainReferenceRadius.value = body.habitatPort.terrainReferenceRadius ?? body.radius;
    uniforms.uHabitatSize.value.fromArray(body.habitatPort.size);
    const angle = body.habitatPort.angle ?? 0;
    uniforms.uHabitatPortAxes.value.set(Math.cos(angle), Math.sin(angle));
  }
  const radius = body.radius;
  uniforms.uHabitatClimate.value=body.habitat?.climate??0; // Legacy bare rings use the temperate palette.
  const ecology=body.habitat?body.habitat.ecology:RING_HABITAT_ECOLOGY[0];
  uniforms.uHabitatEcology.value.set(ecology.forestCeiling,ecology.snowLine,ecology.treeDensity);
  const groups=body.shape.type==='compound'?body.shape.terrainGroups:undefined;
  const needsTerrain=Boolean(groups?.length),previousTerrain=uniforms.uHabitatTerrain.value;
  if(previousTerrain.userData.isHabitatFull!==needsTerrain){
    uniforms.uHabitatTerrain.value=needsTerrain?createRingHabitatGeometryTexture():createEmptyRingHabitatGeometryTexture();
    previousTerrain.dispose();
  }
  uniforms.uHabitatGroupCount.value=setRingHabitatGeometry(uniforms.uHabitatTerrain.value,groups,radius);
  const ringLattices = uniforms.uRingLattices.value, latticeData = ringLattices.image.data;
  const previousSectionCount = uniforms.uSectionCount.value;
  let latticeChanged = false;
  uniforms.uBodyKind.value = BODY_KINDS[body.kind === 'moon' && body.family === 'ice' ? 'icy-moon' : body.kind];
  uniforms.uBodyRadius.value = radius;
  uniforms.uBodyCenter.value.fromArray(body.center).divideScalar(radius);
  const frame=uniforms.uBodyFrame.value.fromArray(body.frame);
  const origin=uniforms.uBodyOrigin.value.fromArray(body.center).applyMatrix3(frame).multiplyScalar(-1/radius);
  uniforms.uFlatHabitatDeck.value=body.kind==='ring' && !body.habitat && !groups && body.shape.parts.length<=6;
  if(uniforms.uHasHabitatMaterials.value){
    // Reduce the camera origin to a tile phase before float32 upload. The
    // shader adds the ray hit offset, retaining the same body-fixed texture.
    const c=body.center,f=body.frame,phase=body.phase;
    const x=-(f[0]*c[0]+f[3]*c[1]+f[6]*c[2])+phase*19013;
    const y=-(f[1]*c[0]+f[4]*c[1]+f[7]*c[2])+phase*7301;
    const z=-(f[2]*c[0]+f[5]*c[1]+f[8]*c[2])+phase*11027;
    const tiles=uniforms.uHabitatMaterialTileSize.value,rx=x/tiles.x,ry=y/tiles.x,rz=z/tiles.x;
    const gx=x/tiles.y,gy=y/tiles.y,gz=z/tiles.y;
    uniforms.uHabitatRockPhase.value.set(rx-Math.floor(rx),ry-Math.floor(ry),rz-Math.floor(rz));
    uniforms.uHabitatGroundPhase.value.set(gx-Math.floor(gx),gy-Math.floor(gy),gz-Math.floor(gz));
  }
  if(body.kind==='gas-giant'){
    const f=body.frame,c=body.center;
    const x=-(f[0]*c[0]+f[3]*c[1]+f[6]*c[2]);
    const y=-(f[1]*c[0]+f[4]*c[1]+f[7]*c[2]);
    const z=-(f[2]*c[0]+f[5]*c[1]+f[8]*c[2]);
    const sx=Math.sin(17.17*body.phase)*31,sy=Math.sin(31.7*body.phase)*31,sz=Math.sin(47.1*body.phase)*31;
    const driftX=gasVelocity===null?0:-gasVelocity[0]*gasWeatherTime;
    const driftY=gasVelocity===null?0:-gasVelocity[1]*gasWeatherTime;
    const driftZ=gasVelocity===null?0:-gasVelocity[2]*gasWeatherTime;
    for(let i=0;i<GAS_CLOUD_MATERIAL_SCALES.length;i++){
      const scale=GAS_CLOUD_MATERIAL_SCALES[i];
      const phase=1.7*64000/scale+.31+(i+1)*.17;
      const period=scale*256;
      const px=(x+driftX%period)/scale+sx*phase;
      const py=(y+driftY%period)/scale+sy*phase;
      const pz=(z+driftZ%period)/scale+sz*phase;
      const ix=Math.floor(px),iy=Math.floor(py),iz=Math.floor(pz);
      uniforms.uGasNoiseCells.value[i].set(((ix%256)+256)%256,((iy%256)+256)%256,((iz%256)+256)%256);
      uniforms.uGasNoiseFractions.value[i].set(px-ix,py-iy,pz-iz);
    }
  }
  uniforms.uLight.value.fromArray(body.light).normalize();
  uniforms.uTint.value.fromArray(body.tint);
  uniforms.uPhase.value = body.phase;
  uniforms.uVisibility.value = body.visibility ?? 1;
  uniforms.uRinged.value = body.ringed === true;
  uniforms.uSectionCount.value = body.shape.type === 'compound' ? body.shape.parts.length : 0;
  let minRadius=Infinity,minAxial=Infinity,maxAxial=-Infinity;
  const parts=body.shape.parts;
  const floor=parts?.[0]?.innerRadius??0;
  const sharedFloor=parts?.length>=3 && parts[1].innerRadius===floor && parts[2].innerRadius===floor;
  let coreMin=sharedFloor?parts[0].minY:0,coreMax=sharedFloor?parts[2].maxY:0;
  if (body.shape.type === 'sphere') uniforms.uSphereRadius.value = body.shape.radius / radius;
  const rho=uniforms.uSectionCount.value?Math.hypot(origin.x,origin.z):0;
  for (let i = 0; i < uniforms.uSectionCount.value; i++) {
    const part = body.shape.parts[i];
    uniforms.uSections.value[i].set(part.innerRadius / radius, part.outerRadius / radius, part.minY / radius, part.maxY / radius);
    minRadius=Math.min(minRadius,part.innerRadius);
    minAxial=Math.min(minAxial,part.minY);
    maxAxial=Math.max(maxAxial,part.maxY);
    if(sharedFloor&&i>=3&&part.innerRadius<=floor){
      if(part.maxY<=0)coreMin=Math.max(coreMin,part.maxY);
      else if(part.minY>=0)coreMax=Math.min(coreMax,part.minY);
      else coreMin=coreMax=0;
    }
    const lattice=part.surfaceLattice;
    const bounds=uniforms.uSections.value[i];
    uniforms.uGaps.value[i].set(part.gapCenter,part.gapHalfAngle,(rho-bounds.x)*(rho+bounds.x),(rho-bounds.y)*(rho+bounds.y));
    // Generated rings use <4096 columns, <128 rows and 24-bit seeds. Both
    // packed integers therefore survive float32 upload exactly. In particular
    // the admitted endpoints must not be recomputed from the rounded gap.
    const sections=part.sections;
    const offset = i * 4, counts = sections ? -1 : lattice ? lattice.columns * 128 + lattice.rows : 0;
    // A negative seed word carries the tier bit. -seed-1 also represents a
    // tiered zero seed; both ends of the 24-bit range remain exact float32.
    const seed = sections ? Math.fround((sections[0].maxY-sections[0].minY)/radius) : lattice ? (lattice.tiered ? -lattice.seed-1 : lattice.seed) : 0;
    const admitted = sections ? Math.fround(sections[1].gapHalfAngle) : lattice ? lattice.firstColumn * 4096 + lattice.lastColumn : 0;
    const depth = lattice ? Math.fround((lattice.outerRadius - lattice.innerRadius) / radius) : 0;
    if (latticeData[offset] !== counts || latticeData[offset + 1] !== seed || latticeData[offset + 2] !== admitted || latticeData[offset + 3] !== depth) {
      latticeData[offset] = counts; latticeData[offset + 1] = seed; latticeData[offset + 2] = admitted; latticeData[offset + 3] = depth;
      latticeChanged = true;
    }
    const outerRadius=lattice?lattice.outerRadius:part.outerRadius;
    const middleY = (part.minY + part.maxY) * .5;
    let supportX=0,supportZ=0,supportRadius;
    if (part.gapHalfAngle > Math.PI * .5) {
      const angle = part.gapCenter + Math.PI, halfAngle = Math.PI - part.gapHalfAngle;
      const middleRadius = (part.innerRadius + outerRadius) * .5;
      const radialReach = (outerRadius - part.innerRadius) * .5 + outerRadius * (1 - Math.cos(halfAngle));
      const tangentReach = outerRadius * Math.sin(halfAngle);
      supportX=Math.cos(angle)*middleRadius/radius;supportZ=Math.sin(angle)*middleRadius/radius;
      supportRadius=Math.hypot(radialReach,tangentReach,(part.maxY-part.minY)*.5)/radius;
    } else {
      supportRadius=Math.hypot(outerRadius,(part.maxY-part.minY)*.5)/radius;
    }
    // Match the former uniform upload's float32 values. Comparing the rounded
    // values avoids scheduling another texture upload for unchanged doubles.
    supportX=Math.fround(supportX);supportZ=Math.fround(supportZ);
    const supportY=Math.fround(middleY/radius);supportRadius=Math.fround(supportRadius);
    const supportOffset=RING_SECTION_CAPACITY*4+offset;
    if(latticeData[supportOffset]!==supportX||latticeData[supportOffset+1]!==supportY||
      latticeData[supportOffset+2]!==supportZ||latticeData[supportOffset+3]!==supportRadius){
      latticeData[supportOffset]=supportX;latticeData[supportOffset+1]=supportY;
      latticeData[supportOffset+2]=supportZ;latticeData[supportOffset+3]=supportRadius;latticeChanged=true;
    }
  }
  if(uniforms.uSectionCount.value>0){
    const pad=Math.max(.25,radius*1.e-6);
    uniforms.uRingVoid.value.set(Math.max(0,minRadius-pad)/radius,(minAxial-pad)/radius,(maxAxial+pad)/radius);
    uniforms.uRingCore.value.set(floor/radius,(coreMin+pad)/radius,(coreMax-pad)/radius);
  }
  // Clear only retired sections when a slot changes shape, rather than
  // scanning every texel or uploading an unchanged recipe on every frame.
  for (let i = uniforms.uSectionCount.value * 4; i < previousSectionCount * 4; i++) {
    if(latticeData[i]!==0){latticeData[i]=0;latticeChanged=true;}
    const supportOffset=RING_SECTION_CAPACITY*4+i;
    if(latticeData[supportOffset]!==0){latticeData[supportOffset]=0;latticeChanged=true;}
  }
  if (latticeChanged) ringLattices.needsUpdate = true;
  for (let i = 0; i < 3; i++) {
    const prominence = body.prominences?.[i];
    if (prominence) {
      uniforms.uPlasmaAxes.value[i].fromArray(prominence.axis);
      uniforms.uPlasmaRadii.value[i].fromArray(prominence.radii);
    } else uniforms.uPlasmaAxes.value[i].set(0, 0, 0);
  }
}
