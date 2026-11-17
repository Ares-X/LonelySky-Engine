import * as THREE from 'three';
import { gasCloudGLSL } from './gas-clouds.js';

const BODY_KINDS = Object.freeze({ ring: 1, 'gas-giant': 2, 'dark-world': 3, 'stellar-giant': 4, moon: 5 });

// Every length in the shader is divided by the descriptor radius. The solid
// catalogue, rather than a second rendering model, owns all slab dimensions.
export const COSMIC_BODY_INTERSECTIONS_GLSL = /* glsl */`
uniform int uBodyKind,uSectionCount;
uniform float uBodyRadius,uSphereRadius,uPhase,uRayMinimum,uVisibility;
uniform vec3 uBodyOrigin,uLight,uTint;
uniform mat3 uBodyFrame;
uniform vec4 uSections[6];
uniform vec2 uGaps[6],uCameraWallC[6];
uniform bool uRinged;
uniform vec3 uPlasmaAxes[3];
uniform vec2 uPlasmaRadii[3];
const float BODY_TAU=6.28318530718;
bool solidArc(vec3 p,vec2 gap){
  return gap.y<=0.||abs(atan(sin(atan(p.z,p.x)-gap.x),cos(atan(p.z,p.x)-gap.x)))>=gap.y;
}
void acceptSurface(float t,vec3 p,vec3 n,vec3 ray,bool cameraRay,float minimum,inout float nearest,inout vec3 point,inout vec3 normal){
  // A rounded primary point can leave a sun ray just beneath its source
  // wall. Its outward exit cannot cast a shadow; a later entry still can.
  if(t>minimum&&t<nearest&&(cameraRay||dot(n,ray)<0.)){nearest=t;point=p;normal=n;}
}
bool sectionCast(vec3 origin,vec3 ray,vec4 bounds,vec2 gap,vec2 cameraWallC,bool cameraRay,float minimum,out vec3 point,out vec3 normal,out float nearest){
  nearest=1.e25;point=vec3(0.);normal=vec3(0.);
  float planar=dot(ray.xz,ray.xz),along=dot(origin.xz,ray.xz);
  if(planar>1.e-12)for(int wall=0;wall<2;wall++){
    float radius=wall==0?bounds.x:bounds.y;
    // Near a cylinder wall the radial clearance is far smaller than either
    // squared radius. Use the camera's double-computed c and the product of
    // the roots to retain both a shallow grazing hit and a short downward hit.
    float c=cameraWallC[wall];
    bool nearWall=cameraRay&&abs(c)<.25*radius*radius;
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
        acceptSurface(t,p,normalize(vec3(p.x,0.,p.z))*(wall==0?-1.:1.),ray,cameraRay,minimum,nearest,point,normal);
    }
  }
  if(abs(ray.y)>1.e-10)for(int side=0;side<2;side++){
    float t=((side==0?bounds.z:bounds.w)-origin.y)/ray.y;vec3 p=origin+ray*t;
    float r=length(p.xz);
    if(r>=bounds.x&&r<=bounds.y&&solidArc(p,gap))
      acceptSurface(t,p,vec3(0.,side==0?-1.:1.,0.),ray,cameraRay,minimum,nearest,point,normal);
  }
  if(gap.y>0.)for(int end=0;end<2;end++){
    float angle=gap.x+(end==0?-1.:1.)*gap.y;
    vec3 radial=vec3(cos(angle),0.,sin(angle)),tangent=vec3(-radial.z,0.,radial.x);
    float denominator=dot(ray,tangent);if(abs(denominator)<1.e-10)continue;
    float t=-dot(origin,tangent)/denominator;vec3 p=origin+ray*t;float r=dot(p,radial);
    if(r>=bounds.x&&r<=bounds.y&&p.y>=bounds.z&&p.y<=bounds.w)
      acceptSurface(t,p,tangent*(end==0?1.:-1.),ray,cameraRay,minimum,nearest,point,normal);
  }
  return nearest<1.e24;
}
bool ringCast(vec3 origin,vec3 ray,bool cameraRay,float minimum,out vec3 point,out vec3 normal,out float nearest){
  nearest=1.e25;point=vec3(0.);normal=vec3(0.);
  for(int part=0;part<6;part++){
    if(part>=uSectionCount)break;
    vec3 p,n;float t;
    if(sectionCast(origin,ray,uSections[part],uGaps[part],uCameraWallC[part],cameraRay,minimum,p,n,t)&&t<nearest){nearest=t;point=p;normal=n;}
  }
  return nearest<1.e24;
}
bool bodyCast(vec3 origin,vec3 ray,float minimum,out vec3 point,out vec3 normal,out float distance){
  if(uBodyKind==1)return ringCast(origin,ray,true,minimum,point,normal,distance);
  float along=dot(origin,ray),perpendicular2=dot(cross(origin,ray),cross(origin,ray));
  float discriminant=uSphereRadius*uSphereRadius-perpendicular2;
  point=vec3(0.);normal=vec3(0.);distance=1.e25;
  if(discriminant<0.)return false;
  float root=sqrt(discriminant);distance=-along-root;
  if(distance<=minimum)distance=-along+root;
  if(distance<=minimum)return false;
  point=origin+ray*distance;normal=point/uSphereRadius;return true;
}
float gasRingCast(vec3 origin,vec3 ray,out vec3 point,out float distance){
  point=vec3(0.);distance=1.e25;
  if(!uRinged||abs(ray.y)<1.e-10)return 0.;
  distance=-origin.y/ray.y;point=origin+ray*distance;
  if(distance<=uRayMinimum)return 0.;
  float r=length(point.xz);
  // The ray-plane derivative diverges at the horizon. It cannot extend the
  // finite annulus into a false screen-wide line beyond the physical support.
  if(r<1.25||r>2.1)return 0.;
  float aa=clamp(fwidth(r),.000002,.02);
  float support=smoothstep(1.25-aa,1.25+aa,r)*(1.-smoothstep(2.1-aa,2.1+aa,r));
  float band=.62+.15*sin(r*330.)*(1.-smoothstep(.3,1.2,fwidth(r*330.)));
  float gap=(r-1.65)/.025;
  return support*band*(1.-.8*exp(-gap*gap))*.72;
}
float plasmaCast(vec3 origin,vec3 ray,out float nearest){
  nearest=1.e25;float opacity=0.;
  for(int loop=0;loop<3;loop++){
    vec3 anchor=uPlasmaAxes[loop];if(dot(anchor,anchor)<.5)continue;
    // Branch only on the fixed anchor. Avoid a degenerate meridian at poles.
    vec3 reference=abs(anchor.y)<.95?vec3(0.,1.,0.):vec3(1.,0.,0.);
    vec3 tangent=normalize(reference-anchor*dot(reference,anchor)),plane=cross(anchor,tangent);
    float denominator=dot(ray,plane);if(abs(denominator)<1.e-8)continue;
    vec3 center=anchor*.996;float t=dot(center-origin,plane)/denominator;
    if(t<=uRayMinimum)continue;
    vec3 delta=origin+ray*t-center;
    vec2 p=vec2(dot(delta,tangent),dot(delta,anchor))/uPlasmaRadii[loop];
    float angle=dot(p,p)>1.e-12?atan(p.y,p.x):0.,r=length(p),aa=clamp(fwidth(r),.003,.08);
    float offset=r-1.-sin(angle*7.+uPhase)*.014;
    float width=.016+aa;
    float alpha=exp(-offset*offset/(width*width))*.43*smoothstep(0.,.07,p.y);
    alpha*=.55+.45*sin(angle*11.+uPhase)*sin(angle*11.+uPhase);
    if(alpha>.002&&t<nearest){nearest=t;opacity=alpha;}
  }
  return opacity;
}
`;

export const cosmicBodySurfaceShader = ({surfaceTexture,cloudTexture,stellarTexture,habitatTexture} = {}) => /* glsl */`
${surfaceTexture ? 'uniform sampler2D uSurface;' : ''}
${cloudTexture ? 'uniform sampler2D uClouds;' : ''}
${stellarTexture ? 'uniform sampler2D uStellar;' : ''}
uniform bool uHasSurface,uHasClouds,uHasStellar;
uniform float uPixelAngle,uCloudTime;
uniform bool uHasHabitatPort;
uniform float uHabitatTerrainReferenceRadius;
uniform vec2 uHabitatPort,uHabitatPortAxes,uHabitatSize;
${habitatTexture ? 'uniform sampler2D uHabitatMap;' : ''}
uniform bool uHasHabitatMap;
float bodyHash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float bodyNoise(vec3 p){
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(bodyHash(i),bodyHash(i+vec3(1,0,0)),f.x),mix(bodyHash(i+vec3(0,1,0)),bodyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(bodyHash(i+vec3(0,0,1)),bodyHash(i+vec3(1,0,1)),f.x),mix(bodyHash(i+vec3(0,1,1)),bodyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float filteredBodyNoise(vec3 p,float footprint){return mix(bodyNoise(p),.5,smoothstep(.3,1.1,footprint));}
float plateSeam(float p,float footprint){
  float edge=min(fract(p),1.-fract(p));
  return mix(1.-smoothstep(.003,.014+footprint,edge),.018,smoothstep(.12,.6,footprint));
}
${surfaceTexture || cloudTexture || stellarTexture ? /* glsl */`vec2 bodyUV(vec3 n){
  float longitude=dot(n.xz,n.xz)>1.e-12?atan(n.z,n.x):0.;
  return vec2(longitude/BODY_TAU+uPhase,.5+asin(clamp(n.y,-1.,1.))/3.14159265359);
}
vec3 bodyMap(sampler2D map,vec2 uv){
  vec2 dx=dFdx(uv),dy=dFdy(uv);dx.x-=floor(dx.x+.5);dy.x-=floor(dy.x+.5);
  return textureGrad(map,uv,dx,dy).rgb;
}` : ''}
#define noise3 bodyNoise
${gasCloudGLSL}
#undef noise3
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
  // Avoid evaluating fields whose complete footprint is unresolved.
  float mean=ridge?.55:.5;
  if(footprint>=scale*1.1)return vec4(mean,0.,0.,0.);
  vec4 field=ringNoiseGradient(world/scale);
  if(ridge){
    float crest=1.-abs(field.x*2.-1.);
    field.yzw*=-4.*crest*sign(field.x-.5);
    field.x=crest*crest;
  }
  // Fade unresolved *heights and slopes*, without moving the field or changing
  // its phase. The ridge mean is applied after the nonlinear ridge transform.
  field=mix(field,vec4(mean,0.,0.,0.),smoothstep(.3,1.1,footprint/scale));
  field.yzw/=scale;
  return field;
}
vec4 ringCoastalField(vec3 localWorld,vec3 broadWorld,float scale,float footprint,float broadScale,float weight,vec3 weightGradient){
  if(weight<=0.)return ringWorldField(localWorld,scale,footprint,false);
  vec4 broad=ringWorldField(broadWorld,scale,footprint*broadScale,false);
  broad.yzw*=broadScale;
  if(weight>=1.)return broad;
  vec4 local=ringWorldField(localWorld,scale,footprint,false);
  vec4 blended=mix(local,broad,weight);
  blended.yzw+=(broad.x-local.x)*weightGradient;
  return blended;
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
    if(ringCast(point+geometricNormal*max(.35/uBodyRadius,1.e-7),uLight,false,max(.2/uBodyRadius,1.e-7),blocker,bn,t))diffuse*=.06;
  }
  return diffuse;
}
vec3 ringSurface(vec3 point,vec3 geometricNormal,vec3 ray,float distance){
  float radius=length(point.xz),angle=atan(point.z,point.x),pixel=distance*uPixelAngle;
  vec3 radial=vec3(point.x/radius,0.,point.z/radius),tangent=vec3(-radial.z,0.,radial.x);
  float inner=step(.5,-dot(geometricNormal,radial));
  float pixelMetres=pixel*uBodyRadius;
  // Surface derivatives include the stretched footprint of a grazing view.
  // This is material filtering only; the analytic solid still owns every hit.
  float terrainFootprint=max(pixelMetres,max(length(dFdx(point)),length(dFdy(point)))*uBodyRadius);
  vec3 halfVector=uLight-ray;float halfSquared=dot(halfVector,halfVector);
  if(inner>.5){
    float habitatAngle=atan(sin(angle-uPhase-3.14159265359),cos(angle-uPhase-3.14159265359));
    vec2 habitatPoint=vec2(habitatAngle*uBodyRadius,point.y*uBodyRadius);
    float portLandscape=uHasHabitatPort?1.-smoothstep(15000.,25000.,length(habitatPoint-uHabitatPort)):0.;
    vec4 portPicture=vec4(0.);
    ${habitatTexture ? /* glsl */`if(uHasHabitatPort&&uHasHabitatMap){
      mat2 mapFrame=mat2(uHabitatPortAxes.x,-uHabitatPortAxes.y,uHabitatPortAxes.y,uHabitatPortAxes.x);
      vec2 h=mapFrame*(habitatPoint-uHabitatPort);
      vec2 uv=.5+vec2(h.x,-h.y)/uHabitatSize;
      vec2 dx=dFdx(uv),dy=dFdy(uv);
      vec2 edge=min(uv,1.-uv);
      float feather=smoothstep(0.,.075,min(edge.x,edge.y));
      if(feather>0.){
        portPicture=textureGrad(uHabitatMap,uv,dx,dy);
        portPicture.a*=feather;
        // Opaque features have baked surface lighting.
        if(portPicture.a>=1.)return portPicture.rgb;
      }
    }` : ''}
    // The circular embedding is continuous at longitude +/-pi. Every scale is
    // in world units, with no camera-relative terrain translation or UV zoom.
    vec3 world=vec3(radial.x,point.y,radial.z)*uBodyRadius+uPhase*vec3(19013.,7301.,11027.);
    if(uHasHabitatPort){
      // Keep the authored coast at the port when the physical ring is resized,
      // while retaining world-metre detail scales and a continuous embedding.
      float anchorAngle=uPhase+3.14159265359+uHabitatPort.x/uBodyRadius;
      world.xz+=vec2(cos(anchorAngle),sin(anchorAngle))*(uHabitatTerrainReferenceRadius-uBodyRadius);
    }
    // Far from the authored port, preserve the original continent's angular
    // scale on a larger ring. Blend the fields (including their derivatives)
    // over a physical distance, leaving the complete local shore unchanged.
    vec2 portDelta=habitatPoint-uHabitatPort;
    float portDistance=length(portDelta);
    float broadMix=uHasHabitatPort?smoothstep(30000.,80000.,portDistance):0.;
    float broadScale=1.;
    vec3 broadWorld=world,blendGradient=vec3(0.);
    if(broadMix>0.){
      broadScale=uHabitatTerrainReferenceRadius/uBodyRadius;
      float anchorAngle=uPhase+3.14159265359+uHabitatPort.x/uBodyRadius;
      vec3 anchorWorld=vec3(cos(anchorAngle)*uHabitatTerrainReferenceRadius,uHabitatPort.y,sin(anchorAngle)*uHabitatTerrainReferenceRadius)
        +uPhase*vec3(19013.,7301.,11027.);
      broadWorld=anchorWorld+(world-anchorWorld)*broadScale;
      if(broadMix<1.){
        float t=(portDistance-30000.)/50000.;
        vec2 direction=portDelta/portDistance;
        blendGradient=(tangent*direction.x+vec3(0.,direction.y,0.))*6.*t*(1.-t)/50000.;
      }
    }
    vec4 continent=ringCoastalField(world,broadWorld,68000.,terrainFootprint,broadScale,broadMix,blendGradient);
    vec4 region=ringCoastalField(world+vec3(17000.,31000.,11000.),broadWorld+vec3(17000.,31000.,11000.),23000.,terrainFootprint,broadScale,broadMix,blendGradient);
    vec4 coastDetail=ringCoastalField(world+vec3(4700.,1300.,3100.),broadWorld+vec3(4700.,1300.,3100.),7100.,terrainFootprint,broadScale,broadMix,blendGradient);
    vec4 coast=continent*.61+region*.27+coastDetail*.12;
    vec4 broadCoast=coast;
    vec4 ridge=ringRockRidge(world+vec3(9000.,13000.,7000.),3100.,terrainFootprint);
    vec4 crag=ringRockRidge(world+vec3(1300.,3700.,2300.),850.,terrainFootprint);
    vec4 ledge=ringRockRidge(world+vec3(700.,1700.,3100.),170.,terrainFootprint);
    vec4 ground=ringWorldField(world+vec3(210.,730.,430.),48.,terrainFootprint,false);
    vec4 stone=ringWorldField(world+vec3(11.,37.,53.),12.,terrainFootprint,false);
    vec4 canopy=ringWorldField(world+vec3(83.,59.,109.),3.2,terrainFootprint,false);
    vec4 grit=ringWorldField(world+vec3(71.,17.,43.),.8,terrainFootprint,false);
    // Reuse the resolved regional rock fields to notch a coast at hundreds of
    // metres. No new high-frequency field can independently repaint a biome.
    coast+=vec4((crag.x-.55)*.0024+(ledge.x-.55)*.0012,crag.yzw*.0024+ledge.yzw*.0012);
    float elevation=coast.x,seaLevel=.47;
    vec2 coastGradient=vec2(dot(coast.yzw,tangent)/radius,coast.z);
    float coastSlope=length(coastGradient),shoreAA=max(.00004,coastSlope*terrainFootprint);
    float land=smoothstep(seaLevel-shoreAA,seaLevel+shoreAA,elevation);
    float inland=clamp((elevation-.486)/.13,0.,1.);
    float mountain=inland*inland*(3.-2.*inland);
    vec3 mountainGradient=coast.yzw*(6.*inland*(1.-inland)/.13);
    float ridgeHeight=ridge.x*480.+crag.x*80.+ledge.x*12.;
    vec3 heightGradient=coast.yzw*2600.*step(seaLevel,elevation)
      +mountain*(ridge.yzw*480.+crag.yzw*80.+ledge.yzw*12.)+mountainGradient*ridgeHeight
      +ground.yzw*2.4+stone.yzw*1.9+canopy.yzw*.24+grit.yzw*.075;
    vec2 slope=vec2(dot(heightGradient,tangent)/radius,heightGradient.y);
    // The inhabited coast has softer material relief. This does not displace
    // the shared sea-level field or change the analytic collision surface.
    slope*=mix(1.,.18,portLandscape);
    vec3 landNormal=normalize(geometricNormal-tangent*slope.x-vec3(0.,slope.y,0.));
    float steep=length(slope),rock=smoothstep(.1,.55,steep)*(.25+mountain*.75);
    // Muted fertile lowlands, dry uplands, then exposed stone. Bright mineral
    // faces are sparse and acquire their shape from the height-field normal.
    vec3 soil=mix(vec3(.035,.064,.029),vec3(.14,.126,.077),smoothstep(.32,.72,region.x)*(.45+mountain*.55));
    vec3 coastalForest=mix(vec3(.021,.046,.034),vec3(.048,.063,.045),mountain*.55);
    soil=mix(soil,coastalForest,portLandscape*.9);
    float weathering=.67+stone.x*.38+grit.x*.28-pow(1.-grit.x,4.)*.2;
    // Resolved vegetation patches and canopy texture add smaller spatial
    // structure without altering the large-scale land/sea boundary.
    float vegetation=mix(.78,1.18,ground.x)*mix(.87,1.13,canopy.x);
    soil*=(.88+coastDetail.x*.18)*weathering*vegetation;
    vec3 bedrock=mix(vec3(.105,.108,.098),vec3(.19,.175,.142),region.x);
    bedrock=mix(bedrock,vec3(.09,.103,.102),portLandscape*.8);
    // Thin mineral bedding follows the same height field. Unlike biome paint,
    // its colour changes are small, resolved and subordinate to face lighting.
    float visualHeight=max(0.,elevation-seaLevel)*2600.+mountain*ridgeHeight;
    float bedding=(.5+.5*sin(visualHeight*.095+region.x*3.))
      *(1.-smoothstep(.4,1.6,terrainFootprint*steep*.095));
    bedrock*=weathering*(.86+bedding*.17*(1.-portLandscape));
    soil=mix(soil,bedrock,rock);
    float beachWidth=max(shoreAA,coastSlope*24.);
    float beach=1.-smoothstep(shoreAA,shoreAA+beachWidth,abs(elevation-seaLevel));
    soil=mix(soil,vec3(.19,.174,.129),beach*.65);
    ${surfaceTexture ? /* glsl */`if(uHasSurface){
      vec2 uv=vec2(angle*uBodyRadius,point.y*uBodyRadius)/6500.+uPhase;
      float geological=dot(bodyMap(uSurface,uv),vec3(.2126,.7152,.0722));
      soil*=1.+(geological-.35)*.2;
    }` : ''}
    // Shoreline notches must not make kilometre-wide bathymetric colour bands
    // flicker with their much finer derivatives. Keep the actual coast above,
    // and use its original broad field for the inhabited bay's water depth cue.
    vec2 broadCoastGradient=vec2(dot(broadCoast.yzw,tangent)/radius,broadCoast.z);
    float waterSlope=mix(coastSlope,length(broadCoastGradient),portLandscape);
    float waterElevation=mix(elevation,broadCoast.x,portLandscape);
    float shallow=smoothstep(seaLevel-max(.004,waterSlope*1800.),seaLevel,waterElevation);
    vec3 deepSea=mix(vec3(.004,.016,.024),vec3(.008,.025,.038),portLandscape);
    vec3 shallowSea=mix(vec3(.014,.055,.063),vec3(.025,.13,.12),portLandscape);
    vec3 sea=mix(deepSea,shallowSea,shallow);
    // Decimetre-height optical ripples are fixed in object/world coordinates.
    // They supply a sea material normal, not a moving or collidable sea mesh.
    vec3 waveA=vec3(.18,.12,.09),waveB=vec3(.57,-.31,.38);
    vec3 waterGradient=waveA*cos(dot(world,waveA))*mix(.3,.025,portLandscape)*(1.-smoothstep(.4,1.6,terrainFootprint*length(waveA)))
      +waveB*cos(dot(world,waveB))*mix(.05,.006,portLandscape)*(1.-smoothstep(.4,1.6,terrainFootprint*length(waveB)));
    vec3 waterNormal=normalize(geometricNormal-tangent*dot(waterGradient,tangent)/radius-vec3(0.,waterGradient.y,0.));
    vec3 normal=normalize(mix(waterNormal,landNormal,land));
    float diffuse=ringDirectLight(point,geometricNormal,normal);
    float valley=mountain*(1.-ridge.x),occlusion=1.-valley*.26;
    vec3 landColor=soil*(.075*occlusion+diffuse*1.22);
    float facing=clamp(dot(waterNormal,-ray),0.,1.),fresnel=.02+.98*pow(1.-facing,5.);
    vec3 seaColor=sea*(.055+diffuse*.38)+vec3(.064,.105,.125)*fresnel*.23;
    if(halfSquared>1.e-12){
      vec3 halfDirection=halfVector*inversesqrt(halfSquared);
      float waterGlint=pow(max(dot(waterNormal,halfDirection),0.),180.);
      seaColor+=vec3(.72,.8,.83)*waterGlint*diffuse*(.08+fresnel*.5);
      landColor+=bedrock*pow(max(dot(landNormal,halfDirection),0.),38.)*diffuse*rock*.12;
    }
    vec3 color=mix(seaColor,landColor,land);
    float air=(1.-exp(-distance*.6))*.18;
    air=max(air,portLandscape*(1.-exp(-distance*uBodyRadius/42000.))*.09);
    color=mix(color,vec3(.063,.095,.12)*(.35+diffuse*.65),air);
    return mix(color,portPicture.rgb,portPicture.a);
  }
  // Steel plate dimensions are world lengths. Close seams and roughness fade
  // to their area average as their spacing becomes smaller than a pixel.
  vec2 metres=vec2(angle*uBodyRadius,point.y*uBodyRadius);
  float radialFace=abs(dot(geometricNormal,radial));
  if(abs(geometricNormal.y)>.5)metres.y=(radius-1.)*uBodyRadius;
  else if(radialFace<.5)metres.x=(radius-1.)*uBodyRadius;
  vec2 plate=metres/vec2(640.,280.);
  float seams=max(plateSeam(plate.x,pixelMetres/640.),plateSeam(plate.y,pixelMetres/280.));
  float coarse=filteredBodyNoise(vec3(metres*.00038,uPhase),pixelMetres*.00038);
  float grain=filteredBodyNoise(point*uBodyRadius*.23,pixelMetres*.23);
  vec3 steel=mix(vec3(.085,.11,.125),uTint*.25,.32)*(.82+coarse*.28)*(1.-seams*.65);
  // The outer face of a habitat reads in three scales: service trunks around
  // the belt, banks of radiator louvers, then the physical plates above.
  if(uHasHabitatPort && dot(geometricNormal,radial)>.5){
    float turns=angle/BODY_TAU+.5;
    vec2 dd=vec2(dFdx(turns),dFdy(turns));
    float phasePixel=length(dd-floor(dd+.5));
    float beltY=point.y/uSections[3].w;
    float yPixel=max(fwidth(beltY),.0001);
    float module=turns*48.+step(0.,beltY)*.37;
    float phase=fract(module);
    float variation=bodyHash(vec3(mod(floor(module),48.),step(0.,beltY),floor(uPhase*46.)));
    float bankY=abs(beltY)-mix(.49,.61,variation);
    float frameDistance=max(abs(phase-.5)-(.34+.08*variation),
      abs(bankY)*1.45-.29+abs(phase-.5)*.19);
    float edgePixel=max(.003,phasePixel*48.+yPixel*1.45);
    float bank=(1.-smoothstep(-edgePixel,edgePixel,frameDistance))*
      (1.-smoothstep(.32,.80,edgePixel));
    float louverPhase=dot(vec2(phase,bankY),vec2(23.,1.5));
    float louver=.5+.5*cos(BODY_TAU*louverPhase);
    louver=mix(louver,.5,smoothstep(.18,.56,phasePixel*1104.+yPixel*1.5));
    vec3 radiator=mix(vec3(.026,.043,.050),vec3(.070,.102,.111),louver);
    steel=mix(steel,radiator*(1.-.35*seams),bank*.92);
    float rail=1.-smoothstep(.022,.042+yPixel,abs(abs(beltY)-.82));
    float braces=1.-smoothstep(.016,.032+phasePixel*48.,abs(phase-.10));
    steel=mix(steel,vec3(.22,.22,.18),rail*.72);
    steel=mix(steel,vec3(.18,.124,.090),braces*step(.70,variation)*.54);
  }
  vec3 normal=geometricNormal;
  float resolved=1.-smoothstep(.5,2.,pixelMetres*.23);
  normal=normalize(normal+(tangent*(grain-.5)+vec3(0.,filteredBodyNoise(point*uBodyRadius*.19+31.,pixelMetres*.19)-.5,0.))*resolved*.055);
  float diffuse=ringDirectLight(point,geometricNormal,normal);
  vec3 color=steel*(.045+diffuse*1.2);
  float gloss=halfSquared>1.e-12?pow(max(dot(normal,halfVector*inversesqrt(halfSquared)),0.),mix(54.,120.,1.-grain)):0.;
  color+=steel*.9*gloss*diffuse*.5;
  return color;
}
vec3 sphereSurface(vec3 point,vec3 normal,vec3 ray,float distance){
  float facing=clamp(dot(normal,-ray),0.,1.),ndl=dot(normal,uLight),pixel=distance*uPixelAngle;
  vec3 seed=sin(vec3(17.17,31.7,47.1)*uPhase)*31.;
  float broad=filteredBodyNoise(normal*5.+seed,pixel*5.);
  if(uBodyKind==5){
    vec4 basin=ringWorldField(normal*uBodyRadius+seed*170.,1700.,pixel*uBodyRadius,true);
    vec4 rock=ringWorldField(normal*uBodyRadius+seed*13.,130.,pixel*uBodyRadius,true);
    vec4 grain=ringWorldField(normal*uBodyRadius+seed,3.,pixel*uBodyRadius,false);
    vec3 gradient=basin.yzw*130.+rock.yzw*11.+grain.yzw*.09;
    vec3 materialNormal=normalize(normal-(gradient-normal*dot(normal,gradient)));
    vec3 albedo=uTint*(.65+basin.x*.22+rock.x*.2+grain.x*.13);
    return albedo*(.018+max(dot(materialNormal,uLight),0.)*1.05);
  }
  if(uBodyKind==4){
    float granule=filteredBodyNoise(normal*340.+seed,pixel*340.);
    float fine=filteredBodyNoise(normal*920.+seed,pixel*920.);
    float activeRegion=smoothstep(.74,.88,filteredBodyNoise(normal*13.+seed,pixel*13.));
    float textureDetail=1.;
    ${stellarTexture ? /* glsl */`if(uHasStellar){
      // Chromospheric source supplies restrained luminance only. Its false
      // colour never becomes the visible photosphere's red/yellow marbling.
      vec3 observed=bodyMap(uStellar,bodyUV(normal));
      textureDetail=.94+dot(observed,vec3(.2126,.7152,.0722))*.12;
    }` : ''}
    float hot=step(uTint.r,uTint.b);
    vec3 white=mix(vec3(1.03,.86,.64),vec3(.72,.86,1.06),hot);
    return white*(.88+granule*.16+fine*.045-activeRegion*.19)*textureDetail*(.27+.73*pow(facing,.43));
  }
  if(uBodyKind==2){
    vec3 albedo=gasClouds(normal,seed,uTint*vec3(.32,.29,.26),mix(uTint*.73,vec3(.57,.52,.46),.42),1,uCloudTime,pixel);
    ${cloudTexture ? /* glsl */`if(uHasClouds){
      vec3 observed=bodyMap(uClouds,bodyUV(normal));
      albedo=mix(albedo,observed*.48,.54);
    }` : ''}
    float shadow=0.;
    if(uRinged){vec3 hit;float t;shadow=gasRingCast(point+normal*.000001,uLight,hit,t);}
    return albedo*(.014+pow(max(ndl,0.),.9)*1.12)*(1.-shadow*.8)+uTint*pow(1.-facing,5.)*max(ndl,0.)*.025;
  }
  float relief=filteredBodyNoise(normal*19.+seed,pixel*19.)*.7+filteredBodyNoise(normal*83.+seed,pixel*83.)*.3;
  vec3 albedo=uTint*(.17+relief*.12+broad*.04);
  return albedo*(.018+max(ndl,0.)*.7)+uTint*pow(1.-facing,7.)*smoothstep(-.1,.25,ndl)*.035;
}
`;

export function cosmicBodyUniforms({ surfaceTexture = null, cloudTexture = null, stellarTexture = null, habitatTexture = null } = {}) {
  return {
    uCloudTime: {value: 0}, uBodyKind: { value: 0 }, uBodyRadius: { value: 1 }, uSphereRadius: { value: 1 }, uPhase: { value: 0 }, uRayMinimum: { value: 0 }, uVisibility: { value: 1 },
    uBodyOrigin: { value: new THREE.Vector3() }, uBodyFrame: { value: new THREE.Matrix3() },
    uLight: { value: new THREE.Vector3() }, uTint: { value: new THREE.Color() }, uRinged: { value: false },
    uCameraWallC: { value: Array.from({ length: 6 }, () => new THREE.Vector2()) },
    uSectionCount: { value: 0 }, uSections: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uGaps: { value: Array.from({ length: 6 }, () => new THREE.Vector2()) },
    uPlasmaAxes: { value: Array.from({ length: 3 }, () => new THREE.Vector3()) }, uPlasmaRadii: { value: Array.from({ length: 3 }, () => new THREE.Vector2(1, 1)) },
    uSurface: { value: surfaceTexture }, uHasSurface: { value: Boolean(surfaceTexture) },
    uClouds: { value: cloudTexture }, uHasClouds: { value: Boolean(cloudTexture) },
    uStellar: { value: stellarTexture }, uHasStellar: { value: Boolean(stellarTexture) },
    uHasHabitatPort: { value: false }, uHabitatTerrainReferenceRadius: { value: 1 }, uHabitatPort: { value: new THREE.Vector2() }, uHabitatPortAxes: { value: new THREE.Vector2(1, 0) },
    uHabitatSize: { value: new THREE.Vector2() }, uHabitatMap: { value: habitatTexture }, uHasHabitatMap: { value: false },
  };
}

export function setCosmicBody(uniforms, body) {
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
  uniforms.uBodyKind.value = BODY_KINDS[body.kind];
  uniforms.uBodyRadius.value = radius;
  const frame = uniforms.uBodyFrame.value.fromArray(body.frame);
  const origin = uniforms.uBodyOrigin.value.fromArray(body.center).applyMatrix3(frame).multiplyScalar(-1 / radius);
  uniforms.uLight.value.fromArray(body.light).normalize();
  uniforms.uTint.value.fromArray(body.tint);
  uniforms.uPhase.value = body.phase;
  uniforms.uVisibility.value = body.visibility ?? 1;
  uniforms.uRinged.value = body.ringed === true;
  uniforms.uSectionCount.value = body.shape.type === 'compound' ? body.shape.parts.length : 0;
  if (body.shape.type === 'sphere') uniforms.uSphereRadius.value = body.shape.radius / radius;
  else {
    const rho = Math.hypot(origin.x, origin.z);
    for (let i = 0; i < body.shape.parts.length; i++) {
      const part = body.shape.parts[i], inner = part.innerRadius / radius, outer = part.outerRadius / radius;
      uniforms.uSections.value[i].set(inner, outer, part.minY / radius, part.maxY / radius);
      uniforms.uGaps.value[i].set(part.gapCenter, part.gapHalfAngle);
      uniforms.uCameraWallC.value[i].set((rho - inner) * (rho + inner), (rho - outer) * (rho + outer));
    }
  }
  for (let i = 0; i < 3; i++) {
    const prominence = body.prominences?.[i];
    if (prominence) {
      uniforms.uPlasmaAxes.value[i].fromArray(prominence.axis);
      uniforms.uPlasmaRadii.value[i].fromArray(prominence.radii);
    } else uniforms.uPlasmaAxes.value[i].set(0, 0, 0);
  }
}
