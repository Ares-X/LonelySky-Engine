import {GAS_CLOUD_MATERIAL_GLSL} from './gas-cloud-material.js';

/** Existing macro appearance plus body-local world-unit close-detail bands.
 * Bands filter their value and derivative together. Rock detail is material
 * relief; the shared analytic sphere and collision surface are not displaced.
 * Cloud and photospheric structure are visual approximations, not fluid physics.
 */
export const COSMIC_SPHERE_SURFACE_GLSL = /* glsl */`
// Bounded fixed-body photospheric radiance. No convection simulation.
// Camera-relative samples and body-fixed integer cells retain close precision.
// The periodic hash is only a material tile, not a coordinate/world boundary.
${GAS_CLOUD_MATERIAL_GLSL}
float photosphericCellRadiance(vec3 p,float q,out float interiorWeight){
  const float meanRadiance=.659;
  interiorWeight=0.;
  if(q>=.075)return meanRadiance;
  vec3 address=floor(p),local=fract(p);
  float first=10.,second=10.,brightness=.5;
  // Each center stays within +/- .12 of its cell midpoint. The second nearest
  // included center is at most 1.133 away; excluded centers are >=1.38 away.
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec3 offset=vec3(float(x),float(y),float(z)),key=address+offset;
    vec3 random=vec3(bodyHash(key),bodyHash(key+31.7),bodyHash(key+79.3));
    vec3 delta=offset+.5+(random-.5)*.24-local;
    float squared=dot(delta,delta);
    if(squared<first){second=first;first=squared;brightness=random.z;}
    else second=min(second,squared);
  }
  float edge=sqrt(second)-sqrt(first);
  float center=exp(-first*2.8);
  float lanes=1.-exp(-edge*edge/.09);
  // Random brightness belongs to a particular center, so it must vanish on
  // every F1 tie. lanes is O(edge^2), retaining value and first-order continuity.
  float raw=.12+center*.58+lanes*.44+center*lanes*(brightness-.5)*.20;
  float resolved=1.-smoothstep(.035,.075,q);
  interiorWeight=(center*.75+lanes*.25)*resolved;
  return meanRadiance+(raw-.595551)*resolved;
}
#ifdef OBSERVED_STELLAR_SURFACE
// Optional body-fixed stellar intensity supplied by the engine caller.
float photosphereProjection(vec2 p,vec2 screenX,vec2 screenY){
  vec2 mirrored=1.-abs(fract(p*.5)*2.-1.);
  vec2 uv=mix(uPhotosphereUV.xy,uPhotosphereUV.zw,mirrored);
  vec2 texelScale=(uPhotosphereUV.zw-uPhotosphereUV.xy)*vec2(textureSize(uStellar,0));
  // Mirror signs preserve derivative lengths, even at a reflection turn.
  // The crop Jacobian and each actual plane projection are included here.
  float texelFootprint=max(length(screenX*texelScale),length(screenY*texelScale));
  float lod=clamp(log2(max(texelFootprint,1.)),0.,uPhotosphereParameters.z);
  return dot(textureLod(uStellar,uv,lod).rgb,vec3(.2126,.7152,.0722));
}
float photosphereLocalRadiance(vec3 world,vec3 normal,vec3 screenX,vec3 screenY,float footprint,vec3 seed,float cellSize){
  float q=footprint/cellSize;
  if(q>=.075)return .659;
  float tileSize=cellSize*uPhotosphereParameters.y;
  vec3 p=(world+seed*(170.*cellSize/3200.))/tileSize;
  vec3 dx=screenX/tileSize,dy=screenY/tileSize;
  vec3 weights=abs(normal);weights*=weights;weights*=weights;weights*=weights;
  weights/=weights.x+weights.y+weights.z;
  float intensity=weights.x*photosphereProjection(p.yz,dx.yz,dy.yz)
    +weights.y*photosphereProjection(p.zx,dx.zx,dy.zx)
    +weights.z*photosphereProjection(p.xy,dx.xy,dy.xy);
  float resolved=1.-smoothstep(.035,.075,q);
  return mix(.659,.659*intensity/uPhotosphereParameters.x,resolved);
}
#endif
vec3 sphereSurface(vec3 point,vec3 normal,vec3 ray,float distance){
  float facing=clamp(dot(normal,-ray),0.,1.),ndl=dot(normal,uLight),pixel=distance*uPixelAngle;
  float footprint=max(pixel,max(length(dFdx(point)),length(dFdy(point))))*uBodyRadius;
  vec3 world=point*uBodyRadius;
  vec3 seed=sin(vec3(17.17,31.7,47.1)*uPhase)*31.;
  float broad=filteredBodyNoise(normal*5.+seed,pixel*5.);
  if(uBodyKind==6){
    // A few broad plates split along irregular old sutures. Younger faults
    // cross only the brittle provinces. Frosted highlands scatter more light
    // than the darker exposed ice; all patterns stay fixed to this satellite.
    float pitch=footprint/uBodyRadius;
    vec4 crust=ringWorldField(normal+seed*.12,.31,pitch,false);
    vec3 strike=normalize(vec3(-.26,.83,.39)+seed*.017);
    vec4 blocks=ringWorldField(normal+strike*dot(normal,strike)*.85-seed*.16,.22,pitch*1.85,false);
    vec3 blocksSlope=blocks.yzw+strike*dot(blocks.yzw,strike)*.85;
    float oldField=crust.x-.52+dot(normal,strike)*.095;
    vec3 oldGradient=crust.yzw+strike*.095;
    float width=.031+broad*.022;
    float depth=oldField/width;
    float seam=exp(-depth*depth);
    float oldWeight=(1.-smoothstep(.009,.092,pitch*length(oldGradient)))*(.45+.55*blocks.x);
    float youngField=blocks.x-.48;
    float cut=youngField/.033;
    float fault=exp(-cut*cut);
    float youngWeight=smoothstep(.39,.66,crust.x)*(1.-smoothstep(.012,.077,pitch*length(blocksSlope)));
    vec4 frost=ringWorldField(normal+seed*.08,.060,pitch,false);
    vec3 gradient=oldGradient*(.0034*2.*depth*seam/width)*oldWeight
                 +blocksSlope*(.0017*2.*cut*fault/.033)*youngWeight+frost.yzw*.0013;
    vec3 materialNormal=normalize(normal-(gradient-normal*dot(normal,gradient)));
    float oldIce=smoothstep(.36,.66,crust.x*.63+blocks.x*.37);
    vec3 ice=uTint*mix(vec3(.77,.89,.99),vec3(1.27,1.22,1.14),oldIce)*(.82+broad*.22+frost.x*.20);
    ice*=mix(vec3(1.),vec3(.56,.72,.84),seam*oldWeight)* (1.-.17*fault*youngWeight);
    return ice*(.018+max(dot(materialNormal,uLight),0.)*1.05);
  }
  if(uBodyKind==5){
    vec4 basin=ringWorldField(normal*uBodyRadius+seed*170.,1700.,footprint,true);
    vec4 rock=ringWorldField(normal*uBodyRadius+seed*13.,130.,footprint,true);
    vec4 grain=ringWorldField(normal*uBodyRadius+seed,3.,footprint,false);
    // A large province of flooded basins interrupts the rough bright highlands.
    // The same body-fixed rim slopes affect direct light on both hemispheres.
    float pitch=footprint/uBodyRadius;
    vec4 province=ringWorldField(normal+seed*.09,.35,pitch,false);
    float level=province.x+(broad-.5)*.08;
    float mare=smoothstep(.52,.69,level);
    float rimDistance=(province.x-.604)/.064;
    float rim=exp(-rimDistance*rimDistance);
    float rimSlope=-2.*rimDistance*rim/.064;
    vec3 gradient=basin.yzw*mix(130.,54.,mare)+rock.yzw*11.+grain.yzw*.09;
    gradient+=province.yzw*(.0028*rimSlope-.013*mare*(1.-mare));
    vec3 materialNormal=normalize(normal-(gradient-normal*dot(normal,gradient)));
    vec3 albedo=uTint*(.68+basin.x*.22+rock.x*.20+grain.x*.13);
    albedo*=mix(vec3(1.10,1.06,1.02),vec3(.57,.61,.65),mare)*(1.+rim*.095);
    return albedo*(.018+max(dot(materialNormal,uLight),0.)*1.05);
  }
  if(uBodyKind==4){
    float hot=step(uTint.r,uTint.b);
    float pitch=footprint/uBodyRadius;
    float radiance=.659;
    // Solar-relative artistic cell size, constant for this body, never the view.
    float cellSize=uBodyRadius*.00145,bandScale=cellSize/3200.;
    // Base footprint is retained in the final footprint. Beyond this threshold
    // detail is exactly at its mean, so the entire fine-domain work can stop.
    // Analytic chain derivatives below also avoid derivatives in divergent flow.
    vec3 screenX=dFdx(world),screenY=dFdy(world);
    #ifdef OBSERVED_STELLAR_SURFACE
    if(uHasStellarPhotosphere){
      radiance=photosphereLocalRadiance(world,normal,screenX,screenY,footprint,seed,cellSize);
    }else
    #endif
    if(footprint<cellSize*.075){
      vec3 fixedWorld=world+seed*(170.*bandScale);
      vec4 a=ringNoiseGradient(fixedWorld/(1900.*bandScale));
      vec4 b=ringNoiseGradient(fixedWorld/(2300.*bandScale)+31.7);
      vec4 c=ringNoiseGradient(fixedWorld/(1700.*bandScale)+79.3);
      vec3 domain=fixedWorld+(vec3(a.x,b.x,c.x)-.5)*(1350.*bandScale);
      vec3 dx=screenX+vec3(dot(a.yzw,screenX)/(1900.*bandScale),dot(b.yzw,screenX)/(2300.*bandScale),dot(c.yzw,screenX)/(1700.*bandScale))*(1350.*bandScale);
      vec3 dy=screenY+vec3(dot(a.yzw,screenY)/(1900.*bandScale),dot(b.yzw,screenY)/(2300.*bandScale),dot(c.yzw,screenY)/(1700.*bandScale))*(1350.*bandScale);
      vec4 d=ringNoiseGradient(domain/(500.*bandScale));
      vec4 e=ringNoiseGradient(domain/(610.*bandScale)+31.7);
      vec4 f=ringNoiseGradient(domain/(430.*bandScale)+79.3);
      domain+=(vec3(d.x,e.x,f.x)-.5)*(280.*bandScale);
      vec3 finalDx=dx+vec3(dot(d.yzw,dx)/(500.*bandScale),dot(e.yzw,dx)/(610.*bandScale),dot(f.yzw,dx)/(430.*bandScale))*(280.*bandScale);
      vec3 finalDy=dy+vec3(dot(d.yzw,dy)/(500.*bandScale),dot(e.yzw,dy)/(610.*bandScale),dot(f.yzw,dy)/(430.*bandScale))*(280.*bandScale);
      float domainFootprint=max(footprint,max(length(finalDx),length(finalDy)));
      float interiorWeight;
      radiance=photosphericCellRadiance(domain/cellSize,domainFootprint/cellSize,interiorWeight);
      // Fixed internal fragments split the otherwise smooth bright cores.
      // The fine band's value is filtered AFTER the nonlinear contrast shape.
      float internalRaw=bodyNoise((domain+seed*13.)/(420.*bandScale));
      float internal=(smoothstep(.24,.76,internalRaw)-.5)*(1.-smoothstep(.3,1.1,domainFootprint/(420.*bandScale)));
      float flecks=filteredBodyNoise((domain+seed)/(80.*bandScale),domainFootprint/(80.*bandScale))-.5;
      radiance+=interiorWeight*(internal*.55+flecks*.18);
    }
    // Convective lanes set the warm giants' broad forms; the cool-white
    // photospheres show thinner sheared streams. The fine surface remains in
    // world units and resolves independently while flying toward the limb.
    float lane,macroRadiance;
    if(hot<.5){
      // Oblique plumes break the three axial planes of the value lattice.
      vec3 plume=vec3(dot(normal,vec3(.80,.36,-.48)),
        dot(normal,vec3(-.60,.48,-.64)),dot(normal,vec3(0.,.80,.60)));
      lane=filteredBodyNoise(plume*8.+seed*.82+vec3(broad*2.6,-broad*1.4,broad),pitch*8.);
      vec3 crests=plume*vec3(35.,49.,39.)+seed*2.+vec3(lane*3.,broad*3.8,-lane);
      float cells=filteredBodyNoise(crests,pitch*49.);
      macroRadiance=(broad-.5)*.24+(lane-.5)*.31+(cells-.5)*(.11+.09*lane);
    }else{
      lane=filteredBodyNoise(vec3(normal.x*17.,normal.y*48.+broad*5.,normal.z*17.)-seed,pitch*48.);
      float threads=filteredBodyNoise(normal*vec3(68.,178.,68.)+vec3(0.,lane*3.5,broad*2.)+seed*4.,pitch*178.);
      macroRadiance=(broad-.5)*.12+(lane-.5)*.24+(threads-.5)*.14;
    }
    float activity=0.;
    for(int loop=0;loop<3;loop++){
      float anchor=dot(normal,uPlasmaAxes[loop]);
      activity=max(activity,smoothstep(.948,.992,anchor));
    }
    float spot=smoothstep(.43,.63,lane)*activity;
    radiance+=macroRadiance-spot*mix(.23,.14,hot);
    float textureDetail=1.;
    #ifdef OBSERVED_STELLAR_SURFACE
    if(uHasStellar&&!uHasStellarPhotosphere){
      // Chromospheric source supplies restrained luminance only. Its false
      // colour never becomes the visible photosphere's red/yellow marbling.
      vec3 observed=bodyMap(uStellar,bodyUV(normal));
      textureDetail=.94+dot(observed,vec3(.2126,.7152,.0722))*.12;
    }
    #endif
    vec3 amber=mix(vec3(1.10,.58,.29),vec3(1.07,.91,.71),smoothstep(.36,.80,radiance));
    vec3 blue=mix(vec3(.47,.65,1.09),vec3(.77,.91,1.08),smoothstep(.47,.78,radiance));
    vec3 white=mix(amber,blue,hot);
    float oblique=1.-facing;
    // Quadratic optical limb-darkening approximation, I(1)=1 and I(0)=.25.
    // No external illumination term: the photospheric layer emits radiance.
    float limb=1.-.55*oblique-.20*oblique*oblique;
    return white*radiance*1.35*textureDetail*limb;
  }
  if(uBodyKind==2){
    vec3 albedo;
    #ifdef GAS_OBSERVED_CLOUDS
    {
      vec2 uv=bodyUV(normal);
      vec3 observed=bodyMap(uClouds,uv);
      vec2 uvDx=dFdx(uv),uvDy=dFdy(uv);
      uvDx.x-=floor(uvDx.x+.5);uvDy.x-=floor(uvDy.x+.5);
      vec2 mapSize=vec2(textureSize(uClouds,0));
      float mapFootprint=max(length(uvDx*mapSize),length(uvDy*mapSize));
      vec3 coarse=textureLod(uClouds,uv,max(3.,log2(max(mapFootprint,1.)))).rgb;
      float cloudLuminance=dot(observed,vec3(.2126,.7152,.0722));
      float edge=cloudLuminance-dot(coarse,vec3(.2126,.7152,.0722));
      // The map owns macro belts/vortices; retain the former procedural
      // palette's body-area phase-ensemble mean in a fixed tint-dependent gain.
      // The host owns the map's mean after .48 scaling and edge response;
      // this finite reference is not exact conservation at every phase/LOD.
      vec3 macroMean=uTint*vec3(0.3227605356,0.3084033633,0.2940461910)+vec3(0.0915005634,0.0856601019,0.0739791789);
      vec3 mapGain=vec3(.62)+.38*macroMean/uCloudColorMean;
      albedo=observed*.48*exp(edge*1.6)*mapGain;
    }
    #else
    albedo=gasMacroAlbedo(normal,footprint/uBodyRadius);
    #endif
    vec3 relativeCloud=ray*(distance*uBodyRadius);
    albedo*=gasCloudReflectance(relativeCloud,normal,footprint);
    float cloudLight=ndl>0.?ndl:0.;
    float shadow=0.;
    if(uRinged){vec3 hit;float t;shadow=gasRingCast(point+normal*.000001,uLight,hit,t);}
    return albedo*(.009+pow(cloudLight,1.12)*1.18)*(1.-shadow*.8)+uTint*pow(1.-facing,5.)*max(ndl,0.)*.018;
  }
  // Resolved regolith material, not displaced terrain. The previous strong
  // 130 L ridged normal made the entire sphere resemble embossed rubber.
  // Shallow grains and optional scanned cracks stay subordinate to real rocks.
  vec4 surfaceRock=ringWorldField(world+seed*13.,130.,footprint,false);
  vec4 surfaceGrain=ringWorldField(world+seed,1.2,footprint,false);
  // Long scarps border basalt shelves. Fine regolith comes into view within
  // each shelf, while the surface remains charcoal under the scene light.
  vec3 strike=normalize(vec3(.72,.28,-.51)+seed*.014);
  vec4 shelf=ringWorldField(normal+seed*.16,.26,footprint/uBodyRadius,false);
  float shear=dot(normal,strike)*2.2+shelf.x*.72;
  float riftDistance=(shear-.18)/.15;
  float rift=exp(-riftDistance*riftDistance);
  float riftSlope=-2.*riftDistance*rift/.15;
  vec3 gradient=surfaceRock.yzw*.7+surfaceGrain.yzw*.008;
  gradient+=(strike*2.2+shelf.yzw*.72)*(-.0048*riftSlope);
  vec3 materialNormal=normalize(normal-(gradient-normal*dot(normal,gradient)));
  float rubble=filteredBodyNoise(normal*83.+seed,pixel*83.);
  vec3 albedo=uTint*(.145+shelf.x*.13+broad*.04+rubble*.047);
  albedo*=mix(vec3(1.),vec3(.58,.62,.67),rift)*(.88+surfaceRock.x*.24);
  #ifdef SCANNED_ROCK_SURFACE
  vec3 scanOffset=ray*(distance*uBodyRadius);
  vec3 scanDx=dFdx(scanOffset),scanDy=dFdy(scanOffset);
  if(uHasHabitatMaterials){
    float detail=1.-smoothstep(.08,.4,footprint/uHabitatMaterialTileSize.x);
    if(detail>0.){
      vec3 scanColor,scanNormal;
      habitatScan(uHabitatRockColor,uHabitatRockNormal,scanOffset,materialNormal,
        scanDx,scanDy,uHabitatMaterialTileSize.x,uHabitatRockPhase,
        footprint,scanColor,scanNormal);
      albedo*=mix(vec3(1.),scanColor/uHabitatRockColorMean,detail*.65);
      materialNormal=normalize(mix(materialNormal,scanNormal,detail*.65));
    }
  }
  #endif
  float contactVisibility=1.;
  #ifdef ROCKY_CONTACT_SHADOW
    contactVisibility=rockyContactVisibility(world);
  #endif
  return albedo*(.018+max(dot(materialNormal,uLight),0.)*.7*contactVisibility)+uTint*pow(1.-facing,7.)*smoothstep(-.1,.25,ndl)*.035;
}
`;
