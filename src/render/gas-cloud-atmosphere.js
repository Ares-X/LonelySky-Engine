import {GAS_CLOUD_MATERIAL_GLSL} from './gas-cloud-material.js';

/** Procedurally advected display clouds and optical depth in a bounded shell.
 * L is the game's length unit. A body-fixed density field bounds the actual
 * optical volume; view and solar extinction consume that same field. The
 * inherited art-light diffuse source is an approximation to multiple scattering.
 * The body-seeded procedural field supplies macro arrangement. Brightness is an
 * artistic coverage proxy, never measured elevation.
 */
export const GAS_CLOUD_ATMOSPHERE_GLSL=/* glsl */`
#ifdef GAS_OBSERVED_CLOUDS
  uniform sampler2D uClouds;
  uniform vec3 uCloudColorMean;
#endif
${GAS_CLOUD_MATERIAL_GLSL}
float gasCloudShellHeight(){return min(4200.,.005*uSphereRadius*uBodyRadius);}
float gasCloudInterior(vec3 relative,vec3 point,float footprint){
  float radial=length(point),altitude=(radial-uSphereRadius)*uBodyRadius;
  float height=gasCloudShellHeight();
  vec3 normal=point/radial;
  #ifdef GAS_OBSERVED_CLOUDS
  float longitude=dot(normal.xz,normal.xz)>1.e-12?atan(normal.z,normal.x):0.;
  vec2 uv=vec2(longitude/6.28318530718+uPhase,.5+asin(clamp(normal.y,-1.,1.))/3.14159265359);
  vec3 observed=textureLod(uClouds,uv,2.).rgb;
  float macro=clamp((dot(observed,vec3(.2126,.7152,.0722))-.06)/.3,0.,1.);
  #else
  float macro=gasMacroCoverage(normal,footprint/uBodyRadius);
  #endif
  vec3 cloud=gasCloudShape(relative,normal,footprint);
  float lowTop=height*(.12+.10*macro);
  float low=min(altitude-height*.025,lowTop-altitude);
  // The upper condensate is a detached, rounded 3-D deck. A hole exposes the
  // darker lower deck, while an occupied front lobe actually occludes it.
  // This field is sampled identically by viewing and directional extinction.
  float vertical=(altitude-height*.62)/(height*.27);
  float high=height*.38*(cloud.x-.46+(macro-.5)*.6+cloud.z*.55)-height*.27*vertical*vertical;
  return max(low,high);
}
float gasCloudProfilePrimitive(float x){
  if(x<=0.)return 0.;
  if(x>=1.)return x-.5;
  return x*x*x*(1.-.5*x);
}
// Exact positive integral of smoothstep(0,width,F) when the signed cloud
// interior F is linear over a cell. Crossing a cloud top cannot quantize its
// whole optical mass to the midpoint's binary inside/outside classification.
float gasCloudProfileAverage(float first,float last,float width){
  float a=first/width,b=last/width;
  if(abs(b-a)<.0001)return smoothstep(0.,1.,(a+b)*.5);
  return (gasCloudProfilePrimitive(b)-gasCloudProfilePrimitive(a))/(b-a);
}
// Locate the source in the SAME positive optical mass used for extinction.
// A constant-density half-cell offset slides across a soft top in discrete
// altitude bands. Inverting this cell CDF keeps its solar sample on the cloud.
float gasCloudSourceFraction(float first,float last,float width,float airSigma,float stepL,float extinction){
  float target=extinction<.02?extinction*(.5-extinction/12.):
    (extinction>16.?1.:1.-extinction/(exp(extinction)-1.));
  float lower=0.,upper=1.;
  float start=first<0.?clamp(-first/(last-first),0.,1.):0.;
  float x=first<0.?mix(start,1.,pow(target/extinction,.25)):target/extinction;
  if(first>0.&&last<0.)x=min(x,.5*first/(first-last));
  for(int j=0;j<6;j++){
    float field=mix(first,last,x);
    float cumulative=stepL*x*(airSigma+.009*gasCloudProfileAverage(first,field,width));
    float difference=cumulative-target;
    if(abs(difference)<max(1.e-6,target*1.e-5))break;
    if(difference<0.)lower=x;else upper=x;
    float derivative=stepL*(airSigma+.009*smoothstep(0.,width,field));
    float candidate=x-difference/max(derivative,1.e-8);
    x=candidate>lower&&candidate<upper?candidate:(lower+upper)*.5;
  }
  return x;
}
float gasCloudViewBoundary(int index,float lo,float hi,vec2 support){
  if(support.y<=support.x){float x=float(index)/48.;return mix(lo,hi,x*x);}
  if(index<=4)return mix(lo,support.x,float(index)/4.);
  if(index>=44)return mix(support.y,hi,float(index-44)/4.);
  float x=float(index-4)/40.;
  return mix(support.x,support.y,x*x);
}
float gasCloudSun(vec3 relative,vec3 point,float footprint){
  float along=dot(point,uLight),perpendicular2=dot(cross(point,uLight),cross(point,uLight));
  if(along<0.&&perpendicular2<uSphereRadius*uSphereRadius)return 0.;
  float outer=uSphereRadius+gasCloudShellHeight()/uBodyRadius;
  float span=(-along+sqrt(max(0.,outer*outer-perpendicular2)))*uBodyRadius;
  float opticalDepth=0.;
  float previous=gasCloudInterior(relative,point,footprint);
  for(int j=0;j<6;j++){
    float a=float(j)/6.,b=float(j+1)/6.;
    // The first mean free path carries most of a dense cloud's source. Cubic
    // spacing resolves that neighbourhood even for a long grazing solar ray.
    float lo=a*a*a*span,hi=b*b*b*span;
    float next=gasCloudInterior(relative+uLight*hi,point+uLight*(hi/uBodyRadius),footprint);
    opticalDepth+=.009*gasCloudProfileAverage(previous,next,max(180.,footprint*.65))*(hi-lo);
    previous=next;
    if(opticalDepth>12.)break;
  }
  return exp(-opticalDepth);
}
vec3 gasCloudMacro(vec3 normal,float footprint){
  #ifdef GAS_OBSERVED_CLOUDS
  float longitude=dot(normal.xz,normal.xz)>1.e-12?atan(normal.z,normal.x):0.;
  vec2 uv=vec2(longitude/6.28318530718+uPhase,.5+asin(clamp(normal.y,-1.,1.))/3.14159265359);
  float mapSize=float(textureSize(uClouds,0).x);
  float lod=max(0.,log2(max(1.,footprint*mapSize/(6.28318530718*uBodyRadius))));
  vec3 observed=textureLod(uClouds,uv,lod).rgb;
  vec3 macroMean=uTint*vec3(.3227605356,.3084033633,.2940461910)+vec3(.0915005634,.0856601019,.0739791789);
  return observed*.48*(vec3(.62)+.38*macroMean/uCloudColorMean);
  #else
  return gasMacroAlbedo(normal,footprint/uBodyRadius);
  #endif
}
bool gasCloudColumn(vec3 origin,vec3 ray,float minimum,float maximum,
  out vec3 radiance,out float transmission,out vec3 metadata){
  radiance=vec3(0.);transmission=1.;metadata=vec3(0.);
  float airHeight=.006*uSphereRadius,outer=uSphereRadius+airHeight;
  float along=dot(origin,ray),perpendicular2=dot(cross(origin,ray),cross(origin,ray));
  float discriminant=outer*outer-perpendicular2;
  if(discriminant<=0.)return false;
  float root=sqrt(discriminant),lo=max(minimum,-along-root),hi=min(maximum,-along+root);
  float solidDiscriminant=uSphereRadius*uSphereRadius-perpendicular2;
  if(solidDiscriminant>=0.){float front=-along-sqrt(solidDiscriminant);if(front>minimum)hi=min(hi,front);}
  if(hi<=lo)return false;
  // The opaque body owns the distant cloud deck. Resolve volumetric detail
  // only as its projected footprint becomes visible;
  // blend complete positive C/T representations, never their density fields.
  float resolvedDetail=1.-smoothstep(50.,150.,lo*uBodyRadius*uPixelAngle);
  vec3 macroRadiance=vec3(0.);float macroTransmission=1.;
  if(resolvedDetail<1.){
    float stepSize=(hi-lo)/8.,phaseCos=dot(ray,uLight),phase=.75*(1.+phaseCos*phaseCos);
    vec2 shadow=gasAtmosphereShadowInterval(origin,ray,uSphereRadius,lo,hi);
    vec3 tint=mix(uTint*vec3(.57,.67,.86),vec3(.21,.36,.62),.35);
    for(int i=0;i<8;i++){
      float begin=lo+float(i)*stepSize,end=begin+stepSize;
      float radial=length(origin+ray*((begin+end)*.5));
      float extinction=exp(-max(0.,radial-uSphereRadius)/(airHeight*.2))*stepSize/airHeight*.3;
      float absorbed=1.-exp(-extinction),lit=gasAtmosphereLitAbsorbed(begin,end,extinction,absorbed,shadow);
      macroRadiance+=tint*(.01*absorbed+phase*lit)*macroTransmission;macroTransmission*=1.-absorbed;
    }
    if(resolvedDetail<=0.){
      radiance=macroRadiance*uVisibility;transmission=1.-(1.-macroTransmission)*uVisibility;
      metadata=vec3(lo,(lo+hi)*.5,hi)*uBodyRadius;return true;
    }
  }
  // Spend the view budget on the actual bounded condensate, rather than mostly
  // on the taller clear-air shell. Four cells remain on each clear-air side.
  float cloudOuter=uSphereRadius+gasCloudShellHeight()/uBodyRadius;
  float cloudDiscriminant=cloudOuter*cloudOuter-perpendicular2;
  vec2 cloudSupport=vec2(0.);
  if(cloudDiscriminant>0.){
    float cloudRoot=sqrt(cloudDiscriminant);
    cloudSupport=vec2(max(lo,-along-cloudRoot),min(hi,-along+cloudRoot));
  }
  vec2 shadow=gasAtmosphereShadowInterval(origin,ray,uSphereRadius,lo,hi);
  float phaseCos=dot(ray,uLight),phase=.75*(1.+phaseCos*phaseCos);
  vec3 cloudRadiance=vec3(0.);float cloudWeight=0.,cloudMoment=0.,meanWeight=0.,meanMoment=0.;
  vec3 airTint=mix(uTint*vec3(.57,.67,.86),vec3(.21,.36,.62),.35);
  float filteredFootprint=max(lo*uBodyRadius*uPixelAngle,1.);
  float previous=gasCloudInterior(ray*(lo*uBodyRadius),origin+ray*lo,filteredFootprint);
  for(int i=0;i<48;i++){
    float begin=gasCloudViewBoundary(i,lo,hi,cloudSupport);
    float end=gasCloudViewBoundary(i+1,lo,hi,cloudSupport);
    float t=(begin+end)*.5,stepL=(end-begin)*uBodyRadius;
    vec3 relative=ray*(t*uBodyRadius),point=origin+ray*t;
    float radius=length(point),footprint=max(t*uBodyRadius*uPixelAngle,1.);
    float next=gasCloudInterior(ray*(end*uBodyRadius),origin+ray*end,footprint);
    float airSigma=exp(-max(0.,radius-uSphereRadius)/(airHeight*.2))/(airHeight*uBodyRadius)*.3;
    float profileWidth=max(180.,footprint*.65);
    float cloudSigma=.009*gasCloudProfileAverage(previous,next,profileWidth),sigma=airSigma+cloudSigma;
    float extinction=sigma*stepL,absorbed=1.-exp(-extinction),weight=transmission*absorbed;
    if(weight>0.){
      float cloudShare=cloudSigma/sigma,airShare=1.-cloudShare;
      float lit=gasAtmosphereLitAbsorbed(begin,end,extinction,absorbed,shadow)/absorbed;
      radiance+=airTint*(.01+phase*lit)*airShare*weight;
      if(cloudSigma>0.){
        float sampleFraction=gasCloudSourceFraction(previous,next,profileWidth,airSigma,stepL,extinction);
        float cloudT=mix(begin,end,sampleFraction);
        vec3 cloudRelative=ray*(cloudT*uBodyRadius),cloudPoint=origin+ray*cloudT;
        float solar=gasCloudSun(cloudRelative,cloudPoint,footprint);
        vec3 normal=normalize(cloudPoint);
        float resolved=1.-smoothstep(150.,450.,footprint);
        float illumination=mix(.009,.045,resolved)+pow(max(dot(normal,uLight),0.),1.12)*1.18*mix(1.,solar,resolved);
        cloudRadiance+=gasCloudMacro(normal,footprint)*illumination*cloudShare*weight;
        cloudWeight+=cloudShare*weight;cloudMoment+=cloudT*uBodyRadius*cloudShare*weight;
      }
      meanWeight+=weight;meanMoment+=t*uBodyRadius*weight;
      transmission*=1.-absorbed;
    }
    previous=next;
    if(transmission<.0001)break;
  }
  if(cloudWeight>0.){
    float distance=cloudMoment/cloudWeight;
    vec3 relative=ray*distance,point=origin+relative/uBodyRadius;
    cloudRadiance*=gasCloudReflectance(relative,normalize(point),distance*uPixelAngle);
  }
  radiance+=cloudRadiance;
  if(resolvedDetail<1.){radiance=mix(macroRadiance,radiance,resolvedDetail);transmission=mix(macroTransmission,transmission,resolvedDetail);}
  metadata=vec3(lo*uBodyRadius,meanWeight>0.?meanMoment/meanWeight:(lo+hi)*.5*uBodyRadius,hi*uBodyRadius);
  radiance*=uVisibility;transmission=1.-(1.-transmission)*uVisibility;
  return true;
}
`;
