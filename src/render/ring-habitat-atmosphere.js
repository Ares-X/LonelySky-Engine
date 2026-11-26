import {HABITAT_WEATHER_SCALE,RING_HABITAT_WEATHER_FIELD_GLSL} from './ring-habitat-weather-field.js';

// Rounded spatial means for the analytic weather thresholds and the
// condensation ramp at each knot. Unresolved detail fades to mean density.
export const HABITAT_PROCEDURAL_CHANNEL_MEANS=Object.freeze([.0037,.0304,.159,.4793]);
export const HABITAT_PROCEDURAL_WEATHER_MEANS=Object.freeze([[.175,.772],[.136,.792],[.075,.835],[.234,.744]].map(Object.freeze));
export const HABITAT_PROCEDURAL_DENSITY_SCALE=2.5;

/** Finite inner-ring air and a shared, bounded cloud volume. Coordinates and ray
 * lengths are normalized by body radius; cloud detail and caller footprints
 * use world lengths. These are optical approximations, not fluid dynamics.
 * AIR follows shared noise/intersections and precedes surface/atmosphere code.
 */
export const RING_HABITAT_SAMPLING = Object.freeze({
  airCells:8,
  cloudCells:48,
  mergeEvents:64,
  shadowSamples:8,
  lightSamples:6,
  reflectionAirCells:4,
  reflectionCloudCells:4,
  reflectionLightSamples:2,
});

const HABITAT_AIR_HELPERS_GLSL = /* glsl */`
uniform vec3 uHabitatWind;
uniform int uHabitatSampleIndex;
// Optical representative depths for temporal reconstruction only, in
// body-normalized lengths. They are not positions of physical entities.
float habitatColumnMeanDistance=0.;
float habitatColumnMaximum=0.;
bool habitatColumnValid=false;
const int HABITAT_AIR_VIEW_CELLS=${RING_HABITAT_SAMPLING.airCells};
const int HABITAT_CLOUD_VIEW_CELLS=${RING_HABITAT_SAMPLING.cloudCells};
const int HABITAT_MERGE_EVENTS=${RING_HABITAT_SAMPLING.mergeEvents};
const int HABITAT_SHADOW_SAMPLES=${RING_HABITAT_SAMPLING.shadowSamples};
const int HABITAT_LIGHT_SAMPLES=${RING_HABITAT_SAMPLING.lightSamples};
const int HABITAT_REFLECTION_AIR_CELLS=${RING_HABITAT_SAMPLING.reflectionAirCells};
const int HABITAT_REFLECTION_CLOUD_CELLS=${RING_HABITAT_SAMPLING.reflectionCloudCells};
const int HABITAT_REFLECTION_LIGHT_SAMPLES=${RING_HABITAT_SAMPLING.reflectionLightSamples};
// An orthonormal body-fixed frame retains world wavelengths and keeps the
// value-noise lattice away from the ring's vertical/latitude directions.
const mat3 HABITAT_CLOUD_FRAME=mat3(.8,0.,-.6,.36,.8,.48,.48,-.6,.64);
${RING_HABITAT_WEATHER_FIELD_GLSL}
float habitatAirThickness(float width){return min(.005,width*.25);}
float habitatAirDensity(float altitude,float height){
  return exp(-max(0.,altitude)/(height*.24))*(1.-smoothstep(height*.75,height,altitude));
}
float habitatOpticalOpacity(float extinction,float path){return 1.-exp(-extinction*path);}
bool habitatAirBounds(out vec4 shell,out vec4 gap,out float height){
  shell=vec4(0.);gap=vec4(0.);height=0.;
  if(uSectionCount<3)return false;
  height=habitatAirThickness(uSections[2].w-uSections[0].z);
  shell=vec4(uSections[0].x-height,uSections[0].x,uSections[0].z,uSections[2].w);
  float center=uGaps[0].x,halfAngle=max(uGaps[0].y,max(uGaps[1].y,uGaps[2].y));
  // Published rings use one turn. For unwrapped external descriptors, the
  // shader's original atan(position)-center subtraction owns its rounding.
  vec2 axis=abs(center)<=6.283186?vec2(cos(center),sin(center)):vec2(0.);
  gap=vec4(center,halfAngle,axis);
  return true;
}
float habitatAirEdge(vec3 point,vec4 shell,vec4 gap,float height){
  if(point.y<=shell.z||point.y>=shell.w)return 0.;
  float edge=smoothstep(shell.z,shell.z+height*.75,point.y)
    *(1.-smoothstep(shell.w-height*.75,shell.w,point.y));
  if(gap.y>0.){
    float featherEnd=gap.y+height/shell.y;
    // Beyond 45 degrees the angular feather of a narrow break is exactly
    // one. Its .75-radian limit leaves >.035 radians of rounding margin.
    float along=point.x*gap.z+point.z*gap.w;
    float across=point.z*gap.z-point.x*gap.w;
    if(featherEnd<=.75&&abs(across)>along)return edge;
    float delta=atan(point.z,point.x)-gap.x;
    float angle=abs(atan(sin(delta),cos(delta)));
    edge*=smoothstep(gap.y,featherEnd,angle);
  }
  return edge;
}
// Threshold the resolved field first. Each unresolved octave returns to the
// next coarser coverage, then to a climate's area mean, never threshold(.5).
float habitatWeatherCoverage(float center,float before,float after,float rayFootprint){
  return mix(center,(before+after)*.5,smoothstep(.3,1.1,rayFootprint/${HABITAT_WEATHER_SCALE}.));
}
const vec4 HABITAT_HEIGHT_CHANNEL_MEANS=vec4(${HABITAT_PROCEDURAL_CHANNEL_MEANS.join(',')});
const vec2 HABITAT_HEIGHT_WEATHER[4]=vec2[4](${HABITAT_PROCEDURAL_WEATHER_MEANS.map(v=>'vec2('+v.join(',')+')').join(',')});
const float HABITAT_DENSITY_SCALE=${HABITAT_PROCEDURAL_DENSITY_SCALE};

float habitatCloudBase(float weather){return .61+(weather-.5)*.08;}
// QA morphology: condensation grows from a sparse curved underside into a
// dense central body, then recedes through the upper billows. The old profile
// started at C=1 directly above one nearly constant cloud-base cylinder.
// Quadratic ends have zero density derivative. The four knots shape an
// artistic stratified clump with a thinner base and a dense centre.
float habitatCloudKnotPositive(float u,float knot){
  float a=knot<=0.?0.:knot==1.?.5:knot==2.?.7071067811865476:knot==3.?.8660254037844386:1.;
  float v=max(clamp(u,0.,1.),a);
  return (4./3.)*(v*v*v-a*a*a)-knot*(v-a);
}
float habitatCloudKnotPrimitive(float u,float knot){
  return habitatCloudKnotPositive(u,knot-1.)-2.*habitatCloudKnotPositive(u,knot)+habitatCloudKnotPositive(u,knot+1.);
}
float habitatHeightWeight(float z,float knot){
  if(z<=0.||z>=1.)return 0.;
  float u=z<.42?z/.42:(1.-z)/.58,c=u*u;
  return (clamp(4.*c-knot+1.,0.,1.)-clamp(4.*c-knot,0.,1.))*1.455228342976771;
}
float habitatHeightWeightPrimitive(float z,float knot){
  float t=clamp(z,0.,1.),u=t<.42?t/.42:(1.-t)/.58;
  float partial=habitatCloudKnotPrimitive(u,knot),total=habitatCloudKnotPrimitive(1.,knot);
  return (t<.42?.42*partial:total-.58*partial)*1.455228342976771;
}
float habitatHeightWeightAverage(float lo,float hi,float knot){
  if(hi-lo<=.0001)return habitatHeightWeight((lo+hi)*.5,knot);
  return max(0.,(habitatHeightWeightPrimitive(hi,knot)-habitatHeightWeightPrimitive(lo,knot))/(hi-lo));
}
vec4 habitatHeightWeights(float lo,float hi,float height,float weather){
  float base=habitatCloudBase(weather);
  float a=(lo/height-base)/1.10,b=(hi/height-base)/1.10;
  return vec4(habitatHeightWeightAverage(a,b,1.),habitatHeightWeightAverage(a,b,2.),
    habitatHeightWeightAverage(a,b,3.),habitatHeightWeightAverage(a,b,4.));
}
float habitatCloudRadialMinimum(float px,float pz,float dx,float dz,float halfSpan){
  float planar=dx*dx+dz*dz;
  float closest=planar>0.?clamp(-(px*dx+pz*dz)/planar,-halfSpan,halfSpan):0.;
  float x=px+dx*closest,z=pz+dz*closest;
  return sqrt(x*x+z*z);
}
// One optical scale for view transmission, cloud self-shadow and ground
// shadow. At H=4150 world units, mean density .35 over 1000 units has tau
// about 2.02; a density .20 edge over 50 units has tau only .058. Thick
// interiors can therefore lose direct light while the same thin edge remains
// transmissive. This is an artistic cloud optical depth, not fluid physics.
float habitatCloudExtinction(float density,float height){return density*24./height;}
vec4 habitatCloudBillows(vec3 body,float footprint){
  const float lobeScale=850.;
  float octaveFade=smoothstep(.3,1.1,footprint/lobeScale);
  if(octaveFade==1.)return HABITAT_HEIGHT_CHANNEL_MEANS;
  vec3 p=body/lobeScale;
  float bulk=bodyNoise(p);
  float detail=1.-smoothstep(.25,.85,footprint/(lobeScale/3.1));
  float billow=bulk;
  if(detail>0.)billow=mix(bulk,bodyNoise(p*3.1+vec3(19.,23.,17.)),.18*detail);
  // Filter the resulting density instead of smoothing every distant pore
  // toward a threshold. The finer octave is only evaluated when resolved.
  vec4 knots=smoothstep(vec4(.79,.68,.54,.35),vec4(1.,.93,.81,.67),vec4(billow));
  return mix(knots,HABITAT_HEIGHT_CHANNEL_MEANS,octaveFade);
}
vec4 habitatCloudBounds(vec4 shell,float height){
  return vec4(shell.y-height*1.80,shell.y-height*.54,shell.z,shell.w);
}
vec3 habitatCloudGeography(vec3 point,float groundRadius,vec3 seed){
  vec3 radial=vec3(point.x,0.,point.z)/length(point.xz);
  return vec3(radial.x*groundRadius,point.y,radial.z*groundRadius)*uBodyRadius+seed;
}
vec2 habitatCloudWeather(vec3 point,float groundRadius,vec3 seed){
  vec3 geography=habitatCloudGeography(point,groundRadius,seed)+uHabitatWind;
  return habitatWeatherField(geography,uHabitatClimate);
}
float habitatCloudDensity(vec3 point,vec3 unitRay,float footprint,float rayFootprint,vec4 shell,vec4 gap,float height){
  // Wider C1 cloud feather inside the same exact axial/gap support.
  float edge=habitatAirEdge(point,shell,gap,height*2.);
  if(edge<=0.)return 0.;
  float weatherFilter=smoothstep(.3,1.1,footprint/${HABITAT_WEATHER_SCALE}.);
  vec3 seed=habitatWeatherSeed(uPhase);
  float weather=0.,envelope=0.;
  if(weatherFilter<1.){
    vec2 values=habitatCloudWeather(point,shell.y,seed);
    weather=values.x;envelope=values.y;
  }
  if(envelope<=0.&&weatherFilter==0.&&rayFootprint/${HABITAT_WEATHER_SCALE}.<=.3)return 0.;
  if(weatherFilter<1.&&rayFootprint/${HABITAT_WEATHER_SCALE}.>.3){
    vec3 delta=unitRay*(rayFootprint/uBodyRadius*.2886751345948129);
    vec2 before=habitatCloudWeather(point-delta,shell.y,seed),after=habitatCloudWeather(point+delta,shell.y,seed);
    envelope=habitatWeatherCoverage(envelope,before.y,after.y,rayFootprint);
    weather=mix(weather,(before.x+after.x)*.5,smoothstep(.3,1.1,rayFootprint/${HABITAT_WEATHER_SCALE}.));
  }
  if(envelope<=0.&&weatherFilter==0.)return 0.;
  // Height/C is the sole vertical owner. Average its joint weights over the
  // actual radial-height box before evaluating its procedural condensate.
  float lo=shell.y-length(point.xz),hi=lo;
  if(rayFootprint>0.){
    float halfSpan=rayFootprint*.5/uBodyRadius;
    float nearRadius=habitatCloudRadialMinimum(point.x,point.z,unitRay.x,unitRay.z,halfSpan);
    float farRadius=max(length(point.xz-unitRay.xz*halfSpan),length(point.xz+unitRay.xz*halfSpan));
    lo=shell.y-farRadius;hi=shell.y-nearRadius;
  }
  float local=0.;
  if(envelope>0.&&weatherFilter<1.){
    vec4 massWeights=habitatHeightWeights(lo,hi,height,weather);
    if(dot(massWeights,vec4(1.))>0.){
      vec3 body=HABITAT_CLOUD_FRAME*(point*uBodyRadius+seed+uHabitatWind);
      local=envelope*dot(habitatCloudBillows(body,footprint),massWeights);
    }
  }
  float farMean=0.;
  if(weatherFilter>0.){
    vec2 weatherMean=HABITAT_HEIGHT_WEATHER[uHabitatClimate];
    vec4 farWeights=habitatHeightWeights(lo,hi,height,weatherMean.y);
    farMean=weatherMean.x*dot(HABITAT_HEIGHT_CHANNEL_MEANS,farWeights);
  }
  return edge*mix(local,farMean,weatherFilter)/HABITAT_DENSITY_SCALE;
}
float habitatCellBoundary(float lo,float hi,float index,float samples){
  return index>=samples?hi:lo+(hi-lo)*index/samples;
}
uint habitatCloudSampleHash(uint value){
  value^=value>>16;
  value*=0x7feb352du;
  value^=value>>15;
  value*=0x846ca68bu;
  value^=value>>16;
  return value;
}
float habitatCloudPixelPhase(float pixelX,float pixelY,float stratum,float sampleIndex){
  uint seed=uint(pixelX)*1597334677u^uint(pixelY)*3812015801u^uint(stratum)*2798796415u^uint(sampleIndex)*747796405u;
  return float(habitatCloudSampleHash(seed)>>8)*(1./16777216.);
}
float habitatCloudStratifiedPoint(float lo,float hi,float cell,float stratum,float pixelPhase){
  // Independent screen-pixel phases for the two half-strata, advanced by
  // a low-discrepancy cell shift. No time or cloud coordinates enter this
  // phase: only integration locations change, never the body-fixed field.
  float phase=fract(pixelPhase+cell*.6180339887498948);
  return mix(lo,hi,(stratum+phase)*.5);
}
float habitatCloudIntegrationPoint(float lo,float hi,float cell,float stratum,float pixelPhase,float samplingIndex){
  // Negative index is a separate deterministic integral for reflections,
  // which have no temporal history. Two equally weighted Gauss points retain
  // the same query budget and exactly integrate polynomials through degree 3.
  return samplingIndex<0.?mix(lo,hi,.5+(stratum*2.-1.)*.2886751345948129)
    :habitatCloudStratifiedPoint(lo,hi,cell,stratum,pixelPhase);
}
float habitatLightBoundary(float lo,float hi,float index,float samples){
  float f=index/samples;
  return mix(lo,hi,f*f);
}
bool habitatRayCell(vec4 intervals,int count,int budget,int index,out float lo,out float hi){
  lo=1.e25;hi=1.e25;
  if(count==0||index>=budget)return false;
  int samples=count==1?budget:budget/2,segment=index/samples,local=index-segment*samples;
  vec2 interval=segment==0?intervals.xy:intervals.zw;
  lo=habitatCellBoundary(interval.x,interval.y,float(local),float(samples));
  hi=habitatCellBoundary(interval.x,interval.y,float(local+1),float(samples));
  return true;
}
// The ground and the visible volume sample this exact same geographic density.
// The ground's existing geometric light query owns solid/terrain occlusion.
float habitatCloudShadow(vec3 point,float groundRadius,float footprint){
  vec4 shell;vec4 gap;float height;
  if(!habitatAirBounds(shell,gap,height))return 0.;
  shell.y=groundRadius;shell.x=groundRadius-height;
  float minimum=max(.2/uBodyRadius,1.e-8);
  vec4 intervals;int count;
  if(!ringLatticeIntervals(point,uLight,habitatCloudBounds(shell,height),vec2(minimum,1.e24),intervals,count))return 0.;
  float opticalDepth=0.;int samples=count==1?HABITAT_SHADOW_SAMPLES:HABITAT_SHADOW_SAMPLES/2;
  for(int segment=0;segment<2;segment++){
    if(segment>=count)break;
    float lo=segment==0?intervals.x:intervals.z,hi=segment==0?intervals.y:intervals.w;
    float stepSize=(hi-lo)/float(samples);
    for(int step=0;step<HABITAT_SHADOW_SAMPLES;step++){
      if(step>=samples)break;
      vec3 p=point+uLight*(lo+(float(step)+.5)*stepSize);
      opticalDepth+=habitatCloudExtinction(habitatCloudDensity(p,uLight,footprint,stepSize*uBodyRadius,shell,gap,height),height)*stepSize;
    }
  }
  return habitatOpticalOpacity(opticalDepth,1.);
}
void habitatAirBlend(vec3 source,float opacity,inout vec3 radiance,inout float transmittance){
  radiance+=source*opacity*transmittance;
  transmittance*=1.-opacity;
}
vec3 habitatAirSource(vec3 point,vec3 unitRay){
  vec3 up=-vec3(point.x,0.,point.z)/length(point.xz);
  float sun=smoothstep(-.1,.22,dot(up,uLight));
  float phase=.75*(1.+dot(unitRay,uLight)*dot(unitRay,uLight));
  vec3 sky=vec3(.20,.38,.67);
  if(uHabitatClimate==1)sky=vec3(.22,.40,.66);
  else if(uHabitatClimate==2)sky=vec3(.31,.36,.46);
  else if(uHabitatClimate==3)sky=vec3(.19,.39,.64);
  return sky*(.025+sun*.75*(.65+.35*phase));
}
float habitatCloudSolarDepth(vec3 point,float footprint,vec4 shell,vec4 gap,float height,int lightSamples){
  // A bounded solar column consumes the exact density used for view opacity
  // and the ground shadow. The view uses six cells, the reflected view two;
  // this is single scattering with cloud self-shadow, not fluid simulation.
  vec4 intervals;int count;
  if(!ringLatticeIntervals(point,uLight,habitatCloudBounds(shell,height),vec2(0.,height*3.),intervals,count))return 0.;
  int samples=count==1?lightSamples:lightSamples/2;float opticalDepth=0.;
  for(int segment=0;segment<2;segment++){
    if(segment>=count)break;
    float lo=segment==0?intervals.x:intervals.z,hi=segment==0?intervals.y:intervals.w;
    for(int step=0;step<HABITAT_LIGHT_SAMPLES;step++){
      if(step>=samples)break;
      // Spend more of the fixed solar budget near the visible lobe. Uniform
      // long grazing cells can otherwise miss its entire local optical mass.
      float start=habitatLightBoundary(lo,hi,float(step),float(samples));
      float end=habitatLightBoundary(lo,hi,float(step+1),float(samples));
      float stepSize=end-start;
      vec3 probe=point+uLight*((start+end)*.5);
      float density=habitatCloudDensity(probe,uLight,footprint,stepSize*uBodyRadius,shell,gap,height);
      opticalDepth+=habitatCloudExtinction(density,height)*stepSize;
    }
  }
  return opticalDepth;
}
float habitatCloudHenyeyGreenstein(float cosine,float anisotropy){
  // Relative HG = 4*pi times the solid-angle PDF: its angular average is 1,
  // matching the former isotropic direct multiplier without a global gain.
  float denominator=1.+anisotropy*anisotropy-2.*anisotropy*cosine;
  return (1.-anisotropy*anisotropy)/(denominator*sqrt(denominator));
}
float habitatCloudPhase(float cosine){
  // Explicit artistic forward/back lobes; not a droplet-size/Mie solve or
  // Guerrilla's silver-lining max model. Positive g peaks toward the sun.
  return .8*habitatCloudHenyeyGreenstein(cosine,.65)
    +.2*habitatCloudHenyeyGreenstein(cosine,-.25);
}
vec3 habitatCloudSource(vec3 point,vec3 unitRay,float footprint,vec4 shell,vec4 gap,float height,int lightSamples){
  vec3 up=-vec3(point.x,0.,point.z)/length(point.xz);
  float sun=smoothstep(-.1,.22,dot(up,uLight));
  float altitude=shell.y-length(point.xz);
  vec3 ambient=mix(vec3(.095,.12,.16),vec3(.16,.19,.22),smoothstep(height*.62,height*.96,altitude));
  ambient*=.02+.98*sun;
  if(sun<=0.)return ambient;
  float solarDepth=habitatCloudSolarDepth(point,footprint,shell,gap,height,lightSamples);
  float sunlight=exp(-solarDepth);
  // Reuse the same measured solar column for a bounded diffuse-fill proxy.
  // Thick cores retain less sky fill; no extra density queries or fake normal
  // light are introduced, and direct light still follows Beer transmission.
  ambient*=.35+.65*sqrt(sunlight);
  // Incoming propagation is -uLight and outgoing-to-camera is -unitRay;
  // their scattering cosine therefore has this positive dot-product sign.
  return ambient+vec3(.62,.61,.58)*sun*sunlight*habitatCloudPhase(clamp(dot(unitRay,uLight),-1.,1.));
}
`;

const HABITAT_COLUMN_GLSL = /* glsl */`
float habitatSegmentMeanDistance(float lo,float hi,float extinction,float opacity){
  // Exact first moment of this constant-extinction segment. The small-tau
  // series avoids cancellation as its scattering distribution becomes flat.
  float tau=(hi-lo)*extinction;
  float fraction=tau<.01?.5-tau/12.:1./tau-(1.-opacity)/opacity;
  return mix(lo,hi,fraction);
}
bool habitatOpticalColumn(vec3 origin,vec3 unitRay,float minimum,float maximum,bool clipToBody,float originFootprint,
 int samplingIndex,int airCells,int cloudCells,int lightSamples,out vec3 color,out float alpha,out float distance){
  color=vec3(0.);alpha=0.;distance=0.;
  habitatColumnMeanDistance=0.;habitatColumnMaximum=0.;habitatColumnValid=false;
  if(maximum<=minimum)return false;
  vec4 shell;vec4 gap;float height;
  if(!habitatAirBounds(shell,gap,height))return false;
  vec4 cloudShell=habitatCloudBounds(shell,height),intervals,cloudIntervals;
  int intervalCount,cloudCount;
  bool intersectsAir=ringLatticeIntervals(origin,unitRay,shell,vec2(minimum,maximum),intervals,intervalCount);
  bool intersectsCloud=ringLatticeIntervals(origin,unitRay,cloudShell,vec2(minimum,maximum),cloudIntervals,cloudCount);
  // An opaque hit can only shorten this ray. A miss of both finite media
  // stays transparent regardless of the hull, including for reflected rays.
  if(!intersectsAir&&!intersectsCloud)return false;
  if(clipToBody){
    vec3 solidPoint,solidNormal;float solidDistance;
    // The deterministic reflected column starts on the water and cannot use
    // radial clearances calculated for the primary camera origin.
    int rayKind=samplingIndex>=0?RING_CAMERA_RAY:RING_REFLECTED_RAY;
    if(ringCast(origin,unitRay,minimum,rayKind,solidPoint,solidNormal,solidDistance)&&solidDistance<maximum){
      maximum=min(maximum,solidDistance);
      if(intersectsAir)intersectsAir=ringLatticeIntervals(origin,unitRay,shell,vec2(minimum,maximum),intervals,intervalCount);
      if(intersectsCloud)intersectsCloud=ringLatticeIntervals(origin,unitRay,cloudShell,vec2(minimum,maximum),cloudIntervals,cloudCount);
    }
  }
  habitatColumnMaximum=maximum;
  if(!intersectsAir)intervalCount=0;
  if(!intersectsCloud)cloudCount=0;
  if(intervalCount==0&&cloudCount==0)return false;
  // A legal empty Monte Carlo sample still belongs to the temporal history.
  // Alpha, and therefore the bool result, do not establish geometric validity.
  habitatColumnValid=true;
  // View: hash twice per column, not per density/solar query. Reflections
  // take a deterministic paired integral and never consume a screen hash.
  vec2 cloudPhase=vec2(0.);
  if(samplingIndex>=0){
    cloudPhase=vec2(habitatCloudPixelPhase(gl_FragCoord.x,gl_FragCoord.y,0.,float(samplingIndex)),
      habitatCloudPixelPhase(gl_FragCoord.x,gl_FragCoord.y,1.,float(samplingIndex)));
  }
  int airIndex=0,cloudIndex=0;
  float airLo,airHi,cloudLo,cloudHi;
  bool hasAir=habitatRayCell(intervals,intervalCount,airCells,airIndex,airLo,airHi);
  bool hasCloud=habitatRayCell(cloudIntervals,cloudCount,cloudCells,cloudIndex,cloudLo,cloudHi);
  bool airLoaded=false,cloudLoaded=false;
  float cursor=min(airLo,cloudLo),airExtinction=0.,cloudExtinction=0.;
  distance=cursor;
  vec3 airSource=vec3(0.),cloudSource=vec3(0.),radiance=vec3(0.);
  float transmittance=1.,entry=1.e25;
  float allMoment=0.,allWeight=0.,cloudMoment=0.,cloudWeight=0.;
  // Merge the two ordered cell streams. At most ${RING_HABITAT_SAMPLING.airCells} air ends, ${RING_HABITAT_SAMPLING.cloudCells} cloud ends and
  // 4 segment starts occur. Air retains its original H and samples; clouds
  // can extend inward above that air shell. Their interleaving owns composition;
  // separate fog/cloud passes would put the whole fog column in the wrong place.
  for(int event=0;event<HABITAT_MERGE_EVENTS;event++){
    // The remaining ray can increase opacity by at most .002 after this cut.
    if((!hasAir&&!hasCloud)||transmittance<.002)break;
    if(hasAir&&airHi<=cursor){
      airIndex++;hasAir=habitatRayCell(intervals,intervalCount,airCells,airIndex,airLo,airHi);
      airLoaded=false;continue;
    }
    if(hasCloud&&cloudHi<=cursor){
      cloudIndex++;hasCloud=habitatRayCell(cloudIntervals,cloudCount,cloudCells,cloudIndex,cloudLo,cloudHi);
      cloudLoaded=false;continue;
    }
    bool inAir=hasAir&&airLo<=cursor&&airHi>cursor;
    if(inAir&&!airLoaded){
      vec3 p=origin+unitRay*(airLo+airHi)*.5;
      float density=habitatAirDensity(shell.y-length(p.xz),height)*habitatAirEdge(p,shell,gap,height);
      airExtinction=density*.17/height;airSource=habitatAirSource(p,unitRay);
      airLoaded=true;
    }
    bool inCloud=hasCloud&&cloudLo<=cursor&&cloudHi>cursor;
    if(inCloud&&!cloudLoaded){
      cloudExtinction=0.;cloudSource=vec3(0.);
      float cellT=1.;
      // The view uses two uniform half-strata with temporal reconstruction;
      // reflections use a fixed paired Gauss rule without pixel noise.
      // Only the low-order reflected integral averages the path segment;
      // both modes retain their existing pixel-cone filtering.
      // ${RING_HABITAT_SAMPLING.cloudCells} cells * 2 points + ${RING_HABITAT_SAMPLING.airCells} air points = ${RING_HABITAT_SAMPLING.cloudCells * 2 + RING_HABITAT_SAMPLING.airCells} view samples maximum.
      for(int stratum=0;stratum<2;stratum++){
        float t=habitatCloudIntegrationPoint(cloudLo,cloudHi,float(cloudIndex),float(stratum),cloudPhase[stratum],float(samplingIndex));
        vec3 p=origin+unitRay*t;
        // Along-ray filtering is independent of the pixel-cone footprint.
        float footprint=max(originFootprint,t*uPixelAngle*uBodyRadius);
        // MC view points already sample the path interval. Filtering each
        // point by that interval again would convolve weather and height a
        // second time, filling resolved openings near a grazing horizon.
        // Deterministic low-order reflections retain their segment average.
        float rayFootprint=samplingIndex>=0?0.:(cloudHi-cloudLo)*uBodyRadius*.5;
        float density=habitatCloudDensity(p,unitRay,footprint,rayFootprint,shell,gap,height);
        float extinction=habitatCloudExtinction(density,height);
        cloudExtinction+=extinction*.5;
        if(density>0.){
          vec3 sampleSource=habitatCloudSource(p,unitRay,footprint,shell,gap,height,lightSamples);
          // Ordered half-path transport: a bright rear sample must pass
          // through the front half's transmission before reaching the eye.
          habitatAirBlend(sampleSource,habitatOpticalOpacity(extinction,(cloudHi-cloudLo)*.5),cloudSource,cellT);
        }
      }
      float cellOpacity=1.-cellT;
      // No opacity means no radiance contribution; leave the zero source.
      // Otherwise this effective source reproduces the ordered cloud-only
      // cell radiance while retaining its original average extinction.
      // Interleaved air still uses the existing uniform-cell approximation.
      if(cellOpacity>0.)cloudSource/=cellOpacity;
      cloudLoaded=true;
    }
    float next=1.e25;
    if(hasAir)next=min(next,inAir?airHi:airLo);
    if(hasCloud)next=min(next,inCloud?cloudHi:cloudLo);
    float activeAir=inAir?airExtinction:0.,activeCloud=inCloud?cloudExtinction:0.,extinction=activeAir+activeCloud;
    if(extinction>0.&&next>cursor){
      vec3 source=(airSource*activeAir+cloudSource*activeCloud)/extinction;
      float opacity=habitatOpticalOpacity(extinction,next-cursor);
      float weight=opacity*transmittance,cloudPart=weight*activeCloud/extinction;
      float meanDistance=habitatSegmentMeanDistance(cursor,next,extinction,opacity);
      allMoment+=meanDistance*weight;allWeight+=weight;
      cloudMoment+=meanDistance*cloudPart;cloudWeight+=cloudPart;
      habitatAirBlend(source,opacity,radiance,transmittance);
      entry=min(entry,cursor);
    }
    cursor=next;
    if(hasCloud&&cursor>=cloudHi){
      cloudIndex++;hasCloud=habitatRayCell(cloudIntervals,cloudCount,cloudCells,cloudIndex,cloudLo,cloudHi);
      cloudLoaded=false;
    }
    if(hasAir&&cursor>=airHi){
      airIndex++;hasAir=habitatRayCell(intervals,intervalCount,airCells,airIndex,airLo,airHi);
      airLoaded=false;
    }
  }
  alpha=1.-transmittance;
  if(alpha<=.001)return false;
  color=radiance/alpha;
  habitatColumnMeanDistance=cloudWeight>0.?cloudMoment/cloudWeight:allMoment/allWeight;
  // With the whole volume physically clipped by scene depth, its own entry
  // is the depth carrier. No opacity threshold, far endpoint or bias decides
  // whether the entire column happens to pass an unrelated opaque depth test.
  distance=entry;
  return true;
}
`;

export const RING_HABITAT_AIR_GLSL=HABITAT_AIR_HELPERS_GLSL+HABITAT_COLUMN_GLSL+/* glsl */`
float habitatReflectionOriginError(float magnitude){
  return 4.*1.1920928955078125e-7*max(magnitude,1.);
}
vec3 habitatReflectedSky(vec3 point,vec3 geometricNormal,vec3 unitRay,float footprint){
  vec3 color;float alpha,distance;
  // Body-normalized float32 hit reconstruction can place adjacent pixels on
  // opposite sides of the same surface. Move only this secondary-ray origin
  // by a finite epsilon-scaled allowance, using the true geometric normal.
  // The side follows the ray; below-ground rays are not forced into the sky.
  float magnitude=max(max(abs(point.x),abs(point.y)),abs(point.z));
  float side=dot(geometricNormal,unitRay)>=0.?1.:-1.;
  vec3 origin=point+geometricNormal*(habitatReflectionOriginError(magnitude)*side);
  // Low-order finite-volume reflection: it excludes reflected terrain/stars
  // and multiple scattering. The reflected ray owns a fresh physical body
  // clip; primary-camera scene depth cannot clip this different direction.
  if(!habitatOpticalColumn(origin,unitRay,max(.2/uBodyRadius,1.e-8),1.e24,true,footprint,-1,
    HABITAT_REFLECTION_AIR_CELLS,HABITAT_REFLECTION_CLOUD_CELLS,HABITAT_REFLECTION_LIGHT_SAMPLES,
    color,alpha,distance))return vec3(0.);
  return color*alpha;
}
`;

export const RING_HABITAT_ATMOSPHERE_GLSL=/* glsl */`
bool habitatAtmosphere(vec3 origin,vec3 unitRay,float minimum,float maximum,out vec3 color,out float alpha,out float distance){
  // A finite depth sample already bounds this primary ray, including the
  // fully opaque body. An unbounded sample cannot prove absence of a distant
  // solid after compressed-depth quantization. Those rays, partial bodies and
  // reflections retain their own physical intersection.
  bool clipToBody=uHasSceneDepth<.5||uVisibility<1.||maximum>=COSMIC_SCENE_DEPTH_UNBOUNDED/uBodyRadius;
  return habitatOpticalColumn(origin,unitRay,minimum,maximum,clipToBody,0.,uHabitatSampleIndex,
    HABITAT_AIR_VIEW_CELLS,HABITAT_CLOUD_VIEW_CELLS,HABITAT_LIGHT_SAMPLES,color,alpha,distance);
}
`;
