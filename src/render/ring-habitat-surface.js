/** Living inner ring surface. Geography retains the established world-fixed
 * continental fields. Actual solid height and geometric slope own mountains,
 * cliffs and snow placement. Canopy, stone and water normals are shallow
 * material relief; they add neither trees nor collidable terrain geometry.
 * Atmosphere and clouds belong to the separate optical layer.
 */
// Shared material decision: near groundcover consumes the same rock threshold
// as the visible slope, rather than planting into a visibly exposed rock face.
export const RING_HABITAT_ROCK_SLOPE_START=.22,RING_HABITAT_ROCK_SLOPE_END=.65;
export const RING_HABITAT_MEADOW_PALETTES=Object.freeze([
  {low:[.039,.051,.027],high:[.112,.122,.068]},
  {low:[.105,.135,.055],high:[.18,.205,.10]},
  {low:[.21,.20,.087],high:[.34,.285,.135]},
  {low:[.065,.145,.032],high:[.15,.235,.05]},
].map(palette=>Object.freeze({low:Object.freeze(palette.low),high:Object.freeze(palette.high)})));
export const RING_HABITAT_SURFACE_GLSL = /* glsl */`
#ifdef HALO_RIVER
uniform float uHaloRiverTime;
float ringRiverCoverage=0.;
vec4 ringRiverSample=vec4(0.);
#endif
vec3 habitatGroundGradient(vec3 gradient,vec3 tangent,float radius){
  return tangent*dot(gradient,tangent)/radius+vec3(0.,gradient.y,0.);
}
float habitatCoverage(float value,float low,float high,float scale,float footprint,float mean){
  return mix(smoothstep(low,high,value),mean,smoothstep(.35,1.2,footprint/scale));
}
// Project tangent perturbations onto the real base plane. Flat GL normals
// return n on every slope, including blends between signed projection axes.
vec3 habitatTriplanarNormal(vec3 n,vec3 w,vec3 side,vec3 nx,vec3 ny,vec3 nz){
  vec3 perturb=vec3(w.y*ny.x+w.z*side.z*nz.x,w.x*nx.y+w.z*nz.y,
    -w.x*side.x*nx.x-w.y*side.y*ny.y);
  float along=dot(perturb,n),z=dot(w,vec3(nx.z,ny.z,nz.z));
  return normalize(vec3(perturb.x+n.x*(z-along),perturb.y+n.y*(z-along),perturb.z+n.z*(z-along)));
}
void habitatScan(sampler2D colors,sampler2D normals,vec3 offset,vec3 n,vec3 worldDx,vec3 worldDy,float tile,vec3 phase,float footprint,out vec3 color,out vec3 normal){
  vec3 side=step(vec3(0.),n)*2.-1.,w=pow(abs(n),vec3(4.));w/=w.x+w.y+w.z;
  vec3 p=offset/tile+phase,dx=worldDx/tile,dy=worldDy/tile;
  // Preserve measured anisotropy, with the ray/pixel footprint as a minimum
  // world-space filter. UV phase depends only on body-fixed position.
  float filterWidth=max(length(dx),length(dy));
  float filterScale=max(1.,footprint/tile/max(filterWidth,1.e-8));dx*=filterScale;dy*=filterScale;
  vec2 ux=vec2(-side.x*p.z,p.y),uy=vec2(p.x,-side.y*p.z),uz=vec2(side.z*p.x,p.y);
  vec2 xx=vec2(-side.x*dx.z,dx.y),xy=vec2(-side.x*dy.z,dy.y);
  vec2 yx=vec2(dx.x,-side.y*dx.z),yy=vec2(dy.x,-side.y*dy.z);
  vec2 zx=vec2(side.z*dx.x,dx.y),zy=vec2(side.z*dy.x,dy.y);
  color=textureGrad(colors,ux,xx,xy).rgb*w.x+textureGrad(colors,uy,yx,yy).rgb*w.y+textureGrad(colors,uz,zx,zy).rgb*w.z;
  vec3 nx=textureGrad(normals,ux,xx,xy).rgb*2.-1.,ny=textureGrad(normals,uy,yx,yy).rgb*2.-1.,nz=textureGrad(normals,uz,zx,zy).rgb*2.-1.;
  normal=habitatTriplanarNormal(n,w,side,nx,ny,nz);
}
vec3 habitatSeaGradient(vec3 p, vec3 tangent, float footprint) {
  // Moving, filtered world-space wave slopes. The wind phase shares the
  // continuous periodic clock used by the cloud column.
  vec3 q=p+uHabitatWind*vec3(.42,.56,.36);
  vec4 swell=ringWorldField(q+vec3(31.,7.,41.),128.,footprint,false);
  vec4 ripple=ringWorldField(q+vec3(51.,237.,17.),28.,footprint,false);
  vec3 slope=swell.yzw*6.8+ripple.yzw*1.45;
  return tangent*dot(slope,tangent)+vec3(0.,slope.y,0.);
}
vec3 habitatWaterColor(vec3 point,vec3 geometricNormal,vec3 waterNormal,vec3 ray,
    float footprint,vec3 water,float waterLight,vec3 halfVector,float halfSquared,
    float roughness,float waterVariance) {
  float nv=max(dot(waterNormal,-ray),.0001),fresnel=.02+.98*pow(1.-nv,5.);
  vec3 reflected=reflect(ray,normalize(mix(waterNormal,geometricNormal,.28)));
  // The same finite atmospheric field supplies the water's directional sky
  // reflection. This is a low-order optical reflection, not a scene mirror.
  vec3 reflectedSky=habitatReflectedSky(point,geometricNormal,reflected,footprint);
  vec3 waterColor=water*(vec3(.13,.17,.21)+vec3(1.04,.99,.86)*waterLight)*(1.-fresnel)
    +reflectedSky*fresnel;
  if(halfSquared>1.e-12){
    vec3 halfDirection=halfVector*inversesqrt(halfSquared);
    float nh=max(dot(waterNormal,halfDirection),0.),vh=max(dot(-ray,halfDirection),0.);
    float alpha=roughness*roughness,a2=min(1.,alpha*alpha+waterVariance);
    float denominator=nh*nh*(a2-1.)+1.;
    float distribution=a2/(3.14159265359*denominator*denominator);
    float nl=max(dot(waterNormal,uLight),0.);
    float smithV=2.*nv/(nv+sqrt(a2+(1.-a2)*nv*nv));
    float smithL=2.*nl/max(nl+sqrt(a2+(1.-a2)*nl*nl),.0001);
    float lightFresnel=.02+.98*pow(1.-vh,5.);
    float reflection=distribution*smithV*smithL*lightFresnel/max(4.*nv*nl,.0001);
    waterColor+=vec3(1.35,1.29,1.13)*reflection*waterLight;
  }
  return waterColor;
}
float habitatSurfaceLight(vec3 point, vec3 geometricNormal, vec3 materialNormal, vec3 ray,
    float distance, float groundRadius, float footprint) {
  float light=ringDirectLight(point,geometricNormal,materialNormal);
  light*=1.-habitatCloudShadow(point,groundRadius,footprint);
  light*=uVegetationShadowTriangleAware>.5?habitatVegetationVisibilityCameraRelative(ray*(distance*uBodyRadius),geometricNormal):habitatVegetationVisibility(point*uBodyRadius,geometricNormal);
  return light;
}
vec3 habitatSurface(vec3 point,vec3 geometricNormal,vec3 ray,float distance,float groundRadius,vec3 shadingNormal,float rockCoverage){
  float radius=length(point.xz);
  vec3 radial=vec3(point.x,0.,point.z)/radius,tangent=vec3(-radial.z,0.,radial.x),up=-radial;
  float actualHeight=max(0.,(groundRadius-radius)*uBodyRadius);
  float footprint=max(distance*uPixelAngle,max(length(dFdx(point)),length(dFdy(point))))*uBodyRadius;
  vec3 seed=uPhase*vec3(19013.,7301.,11027.);
  // Circular embedding keeps the existing regional moisture continuous at
  // +/-pi. Land coverage comes from the retained physical terrain below.
  vec3 geography=vec3(radial.x,point.y,radial.z)*uBodyRadius+seed;
  vec3 surface=point*uBodyRadius+seed;
  // Marine land and its tidal margin follow actual shared mesh height. The
  // old-gold desert remains dry; no separate flat continental mask is painted.
  float heightAA=max(1.,fwidth(actualHeight));
  float hillLand=smoothstep(2.-heightAA,12.+heightAA,actualHeight);
  float land=uHabitatClimate==2?1.:hillLand;
  #ifdef HALO_RIVER
  float riverBlend=land*ringRiverCoverage;
  #endif
  vec3 waterGradient=habitatSeaGradient(surface,tangent,footprint);
  // Open ocean touches neither vegetation nor exposed stone. Keep the same
  // water optics without evaluating an entire hidden land material.
  if(land<=0.){
    vec3 waterNormal=normalize(geometricNormal-waterGradient);
    vec3 dx=dFdx(waterNormal),dy=dFdy(waterNormal);
    float variance=.5*(dot(dx,dx)+dot(dy,dy));
    vec3 halfVector=uLight-ray;
    vec3 deepWater=vec3(.003,.018,.033);
    if(uHabitatClimate==1)deepWater=vec3(.004,.016,.031);
    if(uHabitatClimate==3)deepWater=vec3(.002,.021,.036);
    float light=habitatSurfaceLight(point,geometricNormal,waterNormal,ray,distance,groundRadius,footprint);
    return habitatWaterColor(point,geometricNormal,waterNormal,ray,footprint,deepWater,light,halfVector,
      dot(halfVector,halfVector),.19,variance);
  }
  vec4 region=ringWorldField(geography+vec3(17000.,31000.,11000.),23000.,footprint,false);
  vec4 coastDetail=ringWorldField(geography+vec3(4700.,1300.,3100.),7100.,footprint,false);
  // Ecology averages the neighbouring mesh slopes, while the exact face
  // normal remains authoritative for ray hits, shadow offsets and collisions.
  float upright=clamp(dot(shadingNormal,up),0.,1.);
  float steepness=sqrt(max(0.,1.-upright*upright))/max(upright,.08);
  // Palettes are linear reflectances. Climate changes ecology and snow line,
  // while the same geography, true solid normals and key light remain owners.
  vec3 meadowLow=vec3(${RING_HABITAT_MEADOW_PALETTES[0].low.join(',')}),meadowHigh=vec3(${RING_HABITAT_MEADOW_PALETTES[0].high.join(',')});
  vec3 forestLow=vec3(.015,.028,.018),forestHigh=vec3(.044,.063,.034);
  vec3 soil=vec3(.128,.099,.060),rockLow=vec3(.094,.104,.101),rockHigh=vec3(.255,.240,.204);
  vec3 sand=vec3(.34,.305,.205),snowColor=vec3(.64,.71,.75);
  vec3 deepWater=vec3(.003,.018,.033),shoalWater=vec3(.018,.085,.075);
  float moisture=.56,snowLine=uHabitatEcology.y,forestCeiling=uHabitatEcology.x;
  if(uHabitatClimate==1){
    meadowLow=vec3(${RING_HABITAT_MEADOW_PALETTES[1].low.join(',')});meadowHigh=vec3(${RING_HABITAT_MEADOW_PALETTES[1].high.join(',')});
    forestLow=vec3(.018,.047,.030);forestHigh=vec3(.043,.092,.052);
    rockLow=vec3(.26,.285,.29);rockHigh=vec3(.41,.425,.41);
    deepWater=vec3(.004,.016,.031);shoalWater=vec3(.025,.075,.080);
    moisture=.44;
  }else if(uHabitatClimate==2){
    meadowLow=vec3(${RING_HABITAT_MEADOW_PALETTES[2].low.join(',')});meadowHigh=vec3(${RING_HABITAT_MEADOW_PALETTES[2].high.join(',')});
    forestLow=vec3(.083,.11,.036);forestHigh=vec3(.15,.19,.061);
    soil=vec3(.34,.235,.125);rockLow=vec3(.31,.235,.17);rockHigh=vec3(.48,.37,.24);
    sand=vec3(.48,.39,.235);shoalWater=vec3(.018,.073,.062);
    moisture=.16;
  }else if(uHabitatClimate==3){
    meadowLow=vec3(${RING_HABITAT_MEADOW_PALETTES[3].low.join(',')});meadowHigh=vec3(${RING_HABITAT_MEADOW_PALETTES[3].high.join(',')});
    forestLow=vec3(.013,.061,.026);forestHigh=vec3(.034,.125,.046);
    soil=vec3(.28,.205,.115);rockLow=vec3(.23,.265,.23);rockHigh=vec3(.37,.385,.30);
    sand=vec3(.48,.43,.29);deepWater=vec3(.002,.021,.036);shoalWater=vec3(.018,.11,.085);
    moisture=.76;
  }
  vec4 forestMass=ringWorldField(geography+vec3(1753.,701.,3121.),3400.,footprint,false);
  vec4 woodland=ringWorldField(surface+vec3(137.,431.,271.),420.,footprint,false);
  vec4 canopy=ringWorldField(surface+vec3(17.,79.,113.),18.,footprint,false);
  vec4 stone=ringWorldField(surface+vec3(11.,37.,53.),12.,footprint,false);
  vec4 grit=ringWorldField(surface+vec3(71.,17.,43.),.8,footprint,false);
  // Broad, ordinary value fields provide restrained rock variation. Avoid a
  // ridge transform: its folded level sets would paint a cellular white web.
  // These are material fields, not an erosion or terrain-formation solver.
  vec4 rockBroad=ringWorldField(surface+vec3(491.,1171.,733.),800.,footprint,false);
  vec4 rockMedium=ringWorldField(surface+vec3(121.,379.,617.),240.,footprint,false);
  vec4 rockFine=ringWorldField(surface+vec3(317.,103.,577.),64.,footprint,false);
  vec4 rockField=rockBroad*.15+rockMedium*.35+rockFine*.50;
  vec4 fractures=ringWorldField(surface+vec3(71.,193.,43.),9.,footprint,false);
  float wetness=clamp(moisture+(region.x-.5)*.65+(coastDetail.x-.5)*.2,0.,1.);
  float forestMean=clamp((wetness-.08)*1.3,0.,.9);
  // Thousand-unit connected stands own the grouping. The 420-unit field
  // only roughens their boundaries, rather than scattering bright clearings.
  float standValue=forestMass.x*.86+woodland.x*.14+wetness*.32;
  float forest=habitatCoverage(standValue,.56,.75,3400.,footprint,forestMean);
  forest*=1.-smoothstep(forestCeiling-100.,forestCeiling+90.,actualHeight);
  // The retained broad landscape mesh expresses escarpments, not
  // vertical individual rock faces. Expose mixed bedrock on its sustained
  // 12--33 degree slopes rather than requiring an almost absent 33--56 degree
  // cliff before any geology can appear.
  forest*=1.-smoothstep(.35,.8,steepness);
  forest*=1.-rockCoverage;
  float exposedRock=smoothstep(${RING_HABITAT_ROCK_SLOPE_START},${RING_HABITAT_ROCK_SLOPE_END},steepness);
  exposedRock=max(exposedRock,smoothstep(forestCeiling+40.,forestCeiling+210.,actualHeight)*.48);
  exposedRock=max(exposedRock,rockCoverage);
  // Height, geometric slope and a fixed prevailing wind own snow coverage.
  // Only a small 800-unit variation remains; fine rock fields never gate snow.
  vec3 prevailingWind=tangent*.83+vec3(0.,.557763,0.);
  float windExposure=dot(geometricNormal,prevailingWind);
  float snowAA=max(45.,heightAA*2.);
  float snowAltitude=snowLine+(region.x-.5)*140.+windExposure*95.+(rockBroad.x-.5)*35.;
  float retention=.74-.18*windExposure+(rockBroad.x-.5)*.08;
  float snow=smoothstep(snowAltitude-snowAA,snowAltitude+snowAA,actualHeight)
    *smoothstep(.38,.88,upright)*retention;
  vec3 meadow=mix(meadowLow,meadowHigh,clamp(wetness*.5+region.x*.5,0.,1.));
  meadow=mix(soil,meadow,smoothstep(.12,.36,wetness));
  // Hundred-unit soil/vegetation organisation bridges the regional ecology
  // and craft-scale leaves. These continuous variations stay inside each
  // biome; they never cut another high-contrast set of map-shaped patches.
  float groundMoisture=clamp(wetness+(woodland.x-.5)*.32+(rockBroad.x-.5)*.18,0.,1.);
  float coverVariation=(rockMedium.x-.5)*.65+(rockFine.x-.5)*.34;
  meadow=mix(meadow*vec3(1.18,1.05,.84),meadow*vec3(.56,.75,.68),groundMoisture);
  meadow*=.95+coverVariation+(woodland.x-.5)*.35;
  // Soil, moss and dry stems vary within the same slope. The former single
  // green interpolation left hundreds of world units looking like felt.
  float exposedSoil=smoothstep(.42,.77,woodland.x*.55+rockMedium.x*.45)
    *(.18+(1.-groundMoisture)*.46);
  meadow=mix(meadow,soil*(.66+stone.x*.3),exposedSoil);
  vec3 forestColor=mix(forestLow,forestHigh,.25+forestMass.x*.4)
    *( .87+canopy.x*.20+(woodland.x-.5)*.20+(rockMedium.x-.5)*.12);
  // Needle litter and broken canopy colour belong below forests too. These
  // are material-scale variations; actual tree shadows are sampled below.
  vec3 litter=mix(soil*vec3(.48,.43,.37),forestColor,clamp(woodland.x*.7+wetness*.3,0.,1.));
  litter*=.78+stone.x*.40+grit.x*.14;
  vec3 groundColor=mix(meadow,litter,forest*.78);
  vec3 rock=mix(rockLow,rockHigh,region.x);
  vec4 mineral=ringWorldField(surface+vec3(53.,127.,211.),3.,footprint,false);
  // Unit-scale mineral grains bridge the 12-unit stone and sub-unit grit.
  // Continuous mineral variation never thresholds a whole noise cell black.
  float mineralValue=(stone.x-.5)*.30+(mineral.x-.5)*.28+(grit.x-.5)*.16;
  rock*=.78+rockField.x*.44+mineralValue;
  rock*=mix(vec3(.93,.97,1.04),vec3(1.08,1.01,.90),mineral.x);
  // Warped strata follow real height; both colours and shallow optical relief
  // use this phase. They do not move the mesh, silhouette or collision surface.
  float beddingPhase=actualHeight*.16+rockBroad.x*2.4+rockMedium.x*.6;
  vec3 beddingGradient=up*.16+rockBroad.yzw*2.4+rockMedium.yzw*.6;
  float beddingFade=1.-smoothstep(.45,1.6,fwidth(beddingPhase));
  float bedding=sin(beddingPhase)*beddingFade;
  float laminaPhase=beddingPhase*7.+stone.x*.7;
  vec3 laminaGradient=beddingGradient*7.+stone.yzw*.7;
  float laminaFade=1.-smoothstep(.45,1.6,fwidth(laminaPhase));
  rock*=1.+bedding*.115+sin(laminaPhase)*laminaFade*.055;
  // A warped directional seam has narrow support, unlike dark low-value
  // noise blobs. Broken segments and pixel filtering prevent a painted web.
  vec3 jointAxis=vec3(.137,.193,-.109);
  float jointPhase=dot(surface,jointAxis)+(fractures.x-.5)*2.5;
  vec3 jointGradient=jointAxis+fractures.yzw*2.5;
  float jointSine=sin(jointPhase),jointDistance=abs(jointSine);
  float jointWidth=.02,jointAA=max(.008,fwidth(jointPhase));
  float jointLow=max(0.,jointWidth-jointAA),jointHigh=jointWidth+jointAA;
  float jointT=clamp((jointDistance-jointLow)/(jointHigh-jointLow),0.,1.);
  float jointProfile=1.-jointT*jointT*(3.-2.*jointT);
  vec3 jointProfileGradient=-6.*jointT*(1.-jointT)/(jointHigh-jointLow)
    *sign(jointSine)*cos(jointPhase)*jointGradient;
  float breakT=clamp((stone.x-.32)/.30,0.,1.);
  float jointBreak=breakT*breakT*(3.-2.*breakT);
  vec3 breakGradient=6.*breakT*(1.-breakT)/.30*stone.yzw;
  float jointFade=1.-smoothstep(.35,1.3,footprint);
  float joint=jointProfile*jointBreak*jointFade;
  vec3 jointReliefGradient=(jointProfileGradient*jointBreak+jointProfile*breakGradient)*jointFade;
  rock*=1.-joint*.12;
  groundColor=mix(groundColor,rock,exposedRock);
  float beach=uHabitatClimate==2?0.:hillLand*(1.-smoothstep(12.,40.,actualHeight));
  beach*=1.-smoothstep(.3,.85,steepness);
  groundColor=mix(groundColor,sand,beach*.32);
  vec3 settledSnow=snowColor*(.93+(rockBroad.x-.5)*.10+(stone.x-.5)*.025);
  groundColor=mix(groundColor,settledSnow,snow);
  #ifdef HABITAT_SURFACE_MAP
  groundColor*=habitatSurfaceTextureGain(point);
  #endif
  // At most a few units of canopy/stone relief; all mountain-scale form and
  // cliff lighting comes from geometricNormal. Filter values AND derivatives.
  vec4 rockLedge=ringRockRidge(geography+vec3(700.,1700.,3100.),170.,footprint);
  vec3 materialGradient=stone.yzw*.48+grit.yzw*.026;
  materialGradient+=canopy.yzw*(forest*1.5*(1.-exposedRock)*(1.-snow));
  materialGradient+=(woodland.yzw*5.+rockMedium.yzw*1.8)*(1.-exposedRock)*(1.-snow);
  materialGradient+=habitatGroundGradient(rockLedge.yzw,tangent,radius)*.7*exposedRock;
  // Continuous sub-unit relief: broad mineral wear, individual grains,
  // stratification and recessed joints. This is material normal relief only.
  vec3 rockRelief=rockBroad.yzw*3.+rockMedium.yzw*2.+rockFine.yzw*2.5
    +stone.yzw*.65+mineral.yzw*.24+grit.yzw*.10;
  rockRelief+=beddingGradient*(.65*cos(beddingPhase)*beddingFade)
    +laminaGradient*(.065*cos(laminaPhase)*laminaFade)-jointReliefGradient*.025;
  materialGradient+=rockRelief*exposedRock*(1.-snow*.75);
  materialGradient+=rockBroad.yzw*.3*snow;
  materialGradient-=shadingNormal*dot(materialGradient,shadingNormal);
  vec3 landNormal=normalize(shadingNormal-materialGradient);

  #ifdef HALO_RIVER
  float riverRipples=0.;
  if(riverBlend>0.){
    vec3 downstream=tangent*ringRiverSample.z+vec3(0.,ringRiverSample.w,0.);
    downstream/=max(length(downstream),1.e-4);
    // The chart sets travel direction. Use the visible triangle's own grade
    // to suppress moving crests over flat and adverse relief.
    float moving=smoothstep(.0,.075,dot(geometricNormal,downstream));
    float along=ringRiverSample.y;
    vec2 grain=vec2(fractures.x,rockFine.x)-.5;
    vec2 phase=vec2(along/64.,along/24.)+vec2(.28,-.49)*ringRiverSample.x+.46*grain;
    vec2 rate=vec2(3./32.,1./4.);
    vec2 aa=1.-smoothstep(vec2(.17),vec2(.53),footprint/vec2(64.,24.));
    vec2 still=sin(6.28318530718*phase);
    vec2 advected=sin(6.28318530718*(phase-rate*uHaloRiverTime));
    float ripple=dot(mix(still,advected,moving),aa*vec2(.64,.36));
    waterGradient=mix(waterGradient,waterGradient*.55+downstream*ripple*.023,riverBlend);
    riverRipples=smoothstep(.60,.96,ripple)*moving*smoothstep(.39,.72,fractures.x);
  }
  land-=riverBlend;
  #endif
  // Land's interpolated normals blend neighbouring mountain slopes into flat
  // submerged triangles. Water owns the actual surface plane; its unchanged
  // optical wave slopes must not inherit that unrelated land tilt.
  vec3 waterNormal=normalize(geometricNormal-waterGradient);
  // A pixel covers a finite range of wave slopes. Broaden the GGX lobe by
  // that measured normal variance so unresolved sun glints do not alias into
  // isolated white pixels. This filters optical roughness, not wave geometry.
  vec3 waterDx=dFdx(waterNormal),waterDy=dFdy(waterNormal);
  float waterVariance=.5*(dot(waterDx,waterDx)+dot(waterDy,waterDy));
  // One geometric shadow query for the visible material, including a shoreline
  // pixel's coverage blend, rather than casting twice for hidden alternatives.
  float groundLight=habitatSurfaceLight(point,geometricNormal,normalize(mix(waterNormal,landNormal,land)),ray,
    distance,groundRadius,footprint);
  float canopyOcclusion=1.-forest*.25*(1.-canopy.x);
  // Cool sky bounce is reflected incident light, never surface emission.
  float microOcclusion=mix(.76,1.,clamp(stone.x*.65+grit.x*.35,0.,1.));
  vec3 skyBounce=vec3(.055,.075,.099)*( .65+.35*upright)*canopyOcclusion*microOcclusion;
  vec3 landColor=groundColor*(skyBounce+vec3(1.32,1.25,1.10)*groundLight);
  vec3 halfVector=uLight-ray;
  float halfSquared=dot(halfVector,halfVector);
  if(halfSquared>1.e-12){
    vec3 halfDirection=halfVector*inversesqrt(halfSquared);
    float sheen=pow(max(dot(landNormal,halfDirection),0.),mix(24.,48.,snow));
    landColor+=vec3(.055,.059,.059)*sheen*groundLight*(exposedRock*.35+snow*.65);
  }
  // Exactly covered land has no water contribution. Do not trace a hidden
  // reflected atmospheric column for every forest, cliff and dry slope.
  if(land==1.)return landColor;
  // A narrow height-based optical shore tint, without a bathymetry model.
  float shallow=hillLand;
  vec3 water=mix(deepWater,shoalWater,shallow);
  #ifdef HALO_RIVER
  vec3 riverWater=mix(vec3(.018,.053,.049),vec3(.035,.098,.078),smoothstep(.1,1.,ringRiverSample.x));
  water=mix(water,riverWater,riverBlend/max(1.-land,1.e-5));
  water+=vec3(.050,.082,.077)*riverRipples*riverBlend;
  #endif
  float waterLight=groundLight;
  float roughness=.19+(stone.x-.5)*.035;
  #ifdef HALO_RIVER
  roughness=mix(roughness,.24,riverBlend);
  #endif
  vec3 waterColor=habitatWaterColor(point,geometricNormal,waterNormal,ray,footprint,water,waterLight,
    halfVector,halfSquared,roughness,waterVariance);
  return mix(waterColor,landColor,land);
}
`;
