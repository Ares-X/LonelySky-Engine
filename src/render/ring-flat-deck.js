// Material for published annular-slab habitats whose coast is painted on
// the analytic inner cylinder. Raised mesh habitats use their own solid heights.
export const FLAT_DECK_SURFACE_GLSL = /* glsl */`
uniform bool uFlatHabitatDeck,uHasHabitatPort;
uniform float uHabitatTerrainReferenceRadius;
uniform vec2 uHabitatPort;
#ifdef HABITAT_PORT_MAP
uniform sampler2D uHabitatMap;
uniform bool uHasHabitatMap;
uniform vec2 uHabitatPortAxes,uHabitatSize;
vec4 habitatPortPicture(vec2 habitatPoint){
  mat2 mapFrame=mat2(uHabitatPortAxes.x,-uHabitatPortAxes.y,uHabitatPortAxes.y,uHabitatPortAxes.x);
  vec2 h=mapFrame*(habitatPoint-uHabitatPort);
  vec2 uv=.5+vec2(h.x,-h.y)/uHabitatSize;
  vec2 dx=dFdx(uv),dy=dFdy(uv),edge=min(uv,1.-uv);
  float feather=smoothstep(0.,.075,min(edge.x,edge.y));
  if(feather<=0.)return vec4(0.);
  vec4 picture=textureGrad(uHabitatMap,uv,dx,dy);
  picture.a*=feather;
  return picture;
}
#endif
vec2 habitatDeckPoint(vec3 point){
  float angle=atan(point.z,point.x)-uPhase-3.14159265359;
  return vec2(atan(sin(angle),cos(angle)),point.y)*uBodyRadius;
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
vec3 flatDeckSurface(vec3 point,vec3 geometricNormal,vec3 ray,float distance){
  float radius=length(point.xz),angle=atan(point.z,point.x),pixel=distance*uPixelAngle;
  vec3 radial=vec3(point.x/radius,0.,point.z/radius),tangent=vec3(-radial.z,0.,radial.x);
  bool inner=dot(geometricNormal,radial)<-.5;
  float pixelMetres=pixel*uBodyRadius;
  // Surface derivatives include the stretched footprint of a grazing view.
  // This is material filtering only; the analytic solid still owns every hit.
  float terrainFootprint=max(pixelMetres,max(length(dFdx(point)),length(dFdy(point)))*uBodyRadius);
  vec3 halfVector=uLight-ray;float halfSquared=dot(halfVector,halfVector);
  if(inner){
    vec2 habitatPoint=habitatDeckPoint(point);
    float portLandscape=uHasHabitatPort?1.-smoothstep(15000.,25000.,length(habitatPoint-uHabitatPort)):0.;

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
    #ifdef HABITAT_SURFACE_MAP
    soil*=habitatSurfaceTextureGain(point);
    #endif
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
    return color;
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
  if(uHasHabitatPort && uSectionCount>3 && uSections[3].w>0. && dot(geometricNormal,radial)>.5){
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
`;
