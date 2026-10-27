import * as THREE from 'three';

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
export const DEEP_SKY_GLSL = /* glsl */`
uniform vec3 uSkyTint;
uniform vec3 uSkyBandNormal;
uniform float uSkyBrightness;
uniform float uSkyBandStrength;
uniform float uSkyStarDensity;
uniform vec3 uSeaWeightsA,uSeaWeightsB;
uniform mat3 uSeaFrame;
uniform float uSeaPhase,uSeaWidth,uSeaQuiet;
uniform sampler2D uSeaDetail;
uniform bool uSeaHasDetail;
uniform vec3 uSeaMorphA,uSeaMorphB,uSeaMorphC,uSeaMorphD,uSeaMorphE,uSeaMorphF;
uniform vec3 uSeaCool,uSeaWarm,uSeaAccent,uSeaOffset;
uniform vec4 uSeaShape,uSeaStructure,uSeaDust,uSeaState;
struct SeaComponent {
  mat3 frame;
  vec3 offset;
  vec4 shape,topology,contour,material,light,spectrum,population;
  vec3 cool,warm;
};
uniform bool uSeaHasLandscape;
uniform SeaComponent uSeaComponents[4];
float skyHash(vec3 p) { p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z); }
float skyNoise(vec3 p) {
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
// GLSL pow has no defined negative-base domain, including exponent 2.0.
float seaSquare(float value) { return value*value; }

// Noise and sparse stars belong to the component's local sky coordinates.
// Their high frequencies fade to their mean when the lens or pixel cannot resolve them.
float seaFilteredNoise(vec3 position) {
  return mix(skyNoise(position),.5,smoothstep(.5,1.4,length(fwidth(position))));
}
float seaStellarPoints(vec3 position,float density) {
  float probability=clamp(density*.004,0.,.04);
  float pointFootprint=length(fwidth(position));
  float resolved=1.-smoothstep(.25,.95,pointFootprint);
  // Integral of exp(-r*r/.065^2) over a unit 2-D stellar cell. Broadening
  // conserves that integral before the unresolved kernel becomes its mean.
  float filtered=${Math.PI * .065 ** 2}*probability;
  if(resolved>0.){
    float value=skyHash(vec3(floor(position.xy),floor(position.z)));
    float densityWidth=min(.0002,probability);
    float population=probability>0.?smoothstep(1.-probability-densityWidth,1.-probability+densityWidth,value):0.;
    vec2 point=fract(position.xy)-.5;
    float variance=.004225+pointFootprint*pointFootprint*.12;
    float spark=exp(-dot(point,point)/variance)*(.004225/variance);
    filtered=mix(filtered,spark*population,resolved);
  }
  return filtered;
}

// The same three sampled fields support different density populations. Their
// mixture is local to a subject, independent of its broad geometric topology.
vec4 seaPopulations(float broad,float middle,float fine,float clump) {
  float mist=.72+broad*.56;
  float cloudBase=max(0.,broad*.58+middle*.42-.22);
  float cloud=.10+cloudBase*cloudBase*8.;
  float strand=max(0.,broad*.35+middle*.6+fine*.05-.4);
  float filaments=.04+strand*strand*12.*(.5+broad);
  float clusterEnvelope=smoothstep(.48,.83,broad*.6+middle*.4);
  float clusters=.025+clusterEnvelope*clusterEnvelope*2.8;
  return vec4(mist,cloud,filaments,clusters);
}

// Four independent directional fields. Slots are ordered far to near by the
// caller; continuous optical composition never sorts or reseeds their contents.
vec4 seaComponent(vec3 direction,SeaComponent component) {
  if(component.light.x<=0.&&component.material.w<=0.)return vec4(0.,0.,0.,1.);
  vec3 q=component.frame*direction;
  vec2 p=q.xy/max(.08,1.+q.z)/max(abs(component.shape.xy),vec2(.01));
  p=clamp(p,vec2(-64.),vec2(64.));
  float front=smoothstep(-.9,-.6,q.z);
  float clump=clamp(component.material.z,0.,1.);
  vec4 populations=max(component.population,vec4(0.));
  populations/=max(.0001,dot(populations,vec4(1.)));
  float anisotropy=max(.1,component.spectrum.w)*(1.+populations.z*.6);
  vec3 textureDirection=vec3(q.x*anisotropy,q.y/anisotropy,q.z);
  vec3 noisePosition=textureDirection*max(.1,component.spectrum.x)+component.offset;
  float broad=seaFilteredNoise(noisePosition);
  // Different octave axes and low-frequency displacement break the visible
  // value-noise lattice without adding a fourth sample or moving the geometry.
  vec3 middleDirection=mat3(.8,.6,0.,-.36,.48,.8,.48,-.64,.6)*textureDirection;
  float middle=seaFilteredNoise(middleDirection*max(.1,component.spectrum.y)+component.offset.yzx
    +vec3(broad,-broad,broad)*3.);
  float fine=seaFilteredNoise(textureDirection.zxy*max(.1,component.spectrum.z)+component.offset.zxy
    +vec3(middle,broad,-middle)*2.);
  // Clumping changes the distribution of light as well as its frequency.
  // Diffuse fields keep broad structure; dense populations expose fine knots.
  float granularity=smoothstep(.12,.92,clump);
  float middleWeight=.30+granularity*.05;
  float fineWeight=.025+granularity*.225;
  float noiseValue=broad*(1.-middleWeight-fineWeight)+middle*middleWeight+fine*fineWeight;
  // Density may have a fine spectrum without folding the whole ellipse into
  // repeated bright ridges. Geometric displacement shrinks with its frequency.
  float contourResolution=min(1.,6./max(1.,component.spectrum.x));
  float middleResolution=min(1.,12./max(1.,component.spectrum.y));
  float warp=(broad-.5)*component.material.x*contourResolution;
  p+=vec2(warp*.35+(middle-.5)*component.material.x*.12*middleResolution,warp);
  // A bounded, nonperiodic bend avoids repeating sinusoidal ribbons.
  float bend=p.x*p.x/(1.+abs(p.x))*(.6+abs(component.contour.y)*.07);
  p.y-=component.contour.x*bend+component.contour.z*p.x;
  float footprint=max(.0001,length(fwidth(p)));
  float radius=length(p),radius2=dot(p,p);
  float hollow=clamp(component.shape.z,0.,1.);
  float rimWidth=max(.01,abs(component.shape.w));
  // Irregular cloud boundaries replace the smooth black circles and razor rims.
  float boundaryDetail=populations.y*.4+populations.z+populations.w*.65;
  float boundaryRadius=radius+(broad-.5)*(.08+boundaryDetail*.22)*contourResolution
    +(middle-.5)*.08*boundaryDetail*middleResolution;
  float boundaryWidth=rimWidth+.045+(middle*.045);
  float filteredWidth=sqrt(boundaryWidth*boundaryWidth+footprint*footprint);
  float opening=mix(1.,smoothstep(hollow-filteredWidth,hollow+filteredWidth,boundaryRadius),smoothstep(0.,.15,hollow));
  float body=exp(-radius2*2.)*opening;
  float ring=exp(-seaSquare((boundaryRadius-(.45+hollow*.65))/filteredWidth))*boundaryWidth/filteredWidth;
  float ridge=clamp(component.contour.w,0.,1.);
  // Width has a world-angular floor, then a pixel footprint. Narrowing a
  // descriptor therefore broadens its field instead of painting a bright needle.
  float minimumStreamWidth=.006/max(.01,abs(component.shape.y));
  float streamWidth=max(minimumStreamWidth,max(.04,rimWidth*(1.-ridge*.5))*(.65+middle*.75));
  float crossFootprint=max(.0001,fwidth(p.y));
  float filteredStream=sqrt(streamWidth*streamWidth+crossFootprint*crossFootprint);
  float streamCoordinate=p.y+(middle-.5)*(.035+granularity*.085)*middleResolution;
  float stream=exp(-seaSquare(streamCoordinate/filteredStream)-p.x*p.x*.7)*streamWidth/filteredStream*opening;
  float theta=radius2>.0000001?atan(p.y,p.x):0.;
  // Mix adjacent INTEGER angular frequencies. Each endpoint is periodic at
  // atan's branch cut, including when the continuous descriptor crosses an integer.
  float armNumber=2.+(.5+.5*sin(component.offset.z*.173))*4.;
  float arms=floor(armNumber);
  float nextArms=min(6.,arms+1.);
  float winding=log(max(radius,.025))*component.contour.y+component.offset.z+(middle-.5)*(1.+abs(component.material.x))*middleResolution;
  float phase=theta*arms+winding;
  float crest=pow(max(0.,.5+.5*cos(phase)),2.+ridge*3.);
  float nextCrest=pow(max(0.,.5+.5*cos(theta*nextArms+winding)),2.+ridge*3.);
  crest=mix(crest,nextCrest,fract(armNumber));
  float phaseFootprint=(nextArms+abs(component.contour.y))*footprint/max(radius,.025);
  crest=mix(.3,crest,1.-smoothstep(.45,1.2,phaseFootprint));
  float spiral=exp(-radius2*.9)*(.5+.5*mix(.3,crest,smoothstep(.025,.12,radius)))*opening;
  float breakup=clamp(component.material.y,0.,1.);
  float erosion=exp(-breakup*seaSquare(1.-noiseValue)*(1.+populations.y*4.+populations.z*2.));
  float population=dot(seaPopulations(broad,middle,fine,clump),populations);
  float density=max(0.,dot(vec4(body,ring,stream,spiral),max(component.topology,vec4(0.))))*front*erosion*population;
  float dustStructure=mix(.55+(1.-broad)*1.1,.15+4.8*seaSquare(1.-middle)*(.3+fine),
    clamp(populations.y+populations.z*.65,0.,1.));
  float opticalDepth=min(40.,density*max(0.,component.material.w)*dustStructure);
  float transmission=exp(-opticalDepth);
  vec2 source=p-component.light.zw;
  float coreWidth=.025+.055*(1.-ridge),coreWidth2=coreWidth*coreWidth;
  float filteredCore=coreWidth2+footprint*footprint;
  float core=exp(-dot(source,source)/filteredCore)*coreWidth2/filteredCore*front*opening;
  vec3 color=mix(component.cool,component.warm,clamp(noiseValue*.7+fine*.3,0.,1.));
  float clusterEnvelope=smoothstep(.48,.83,broad*.6+middle*.4);
  float stellarDensity=density*(.12+populations.w*9.)*mix(.18,3.,clusterEnvelope);
  vec2 stellarPlane=q.xy/max(.08,1.+q.z);
  float stars=seaStellarPoints(vec3(stellarPlane*mix(420.,180.,populations.w),component.offset.z*31.)
    +component.offset*7.1,stellarDensity);
  vec3 starColor=mix(component.cool,component.warm,.65);
  float componentGrain=1.+(fine-.5)*(.08*populations.y+.24*populations.z);
  vec3 emission=(color*density*componentGrain+component.warm*core*max(0.,component.light.y)
    +starColor*stars*(6.+populations.w*20.))
    *max(0.,component.light.x)*exp(-opticalDepth*.5)*uSeaQuiet;
  return vec4(emission,transmission);
}
vec3 stellarLandscape(vec3 direction,vec3 background) {
  float energy=uSeaComponents[0].light.x+uSeaComponents[0].material.w
    +uSeaComponents[1].light.x+uSeaComponents[1].material.w
    +uSeaComponents[2].light.x+uSeaComponents[2].material.w
    +uSeaComponents[3].light.x+uSeaComponents[3].material.w;
  if(energy<=0.)return background;
  vec3 d=uSeaFrame*direction;
  vec3 radiance=background;
  for(int i=0;i<4;i++){
    vec4 layer=seaComponent(d,uSeaComponents[i]);
    radiance=radiance*layer.a+layer.rgb;
  }
  return radiance;
}

// Eighteen spatial building blocks share seeded population, erosion and light.
// Their controls are interpolated in world space, never chosen by a screen or clock.
vec3 stellarSea(vec3 direction) {
  vec3 sumWeights=uSeaMorphA+uSeaMorphB+uSeaMorphC+uSeaMorphD+uSeaMorphE+uSeaMorphF;
  if(dot(sumWeights,vec3(1.))<=.000001)return vec3(0.);
  vec3 d=uSeaFrame*direction;
  vec3 offset=uSeaOffset+vec3(uSeaPhase,1.7,-2.1);
  float broad=skyNoise(d*3.4+offset);
  float middle=skyNoise(d*(10.+uSeaStructure.z*12.)+offset+vec3(broad,-broad,broad)*4.);
  float fine=skyNoise(d*83.+offset+vec3(middle,broad,-middle)*9.);
  float micro=skyNoise(d*331.+offset)*.65+skyNoise(d*811.+offset)*.35;
  micro=mix(micro,.5,smoothstep(.5,1.4,length(fwidth(d*811.))));
  float grain=broad*.34+middle*.3+fine*.22+micro*.14;
  float stellarGrain=.7+micro*.6;
  if(uSeaHasDetail){
    // Borrow only filtered high-frequency stellar grain. The catalogue's
    // recognizable Galactic panorama must never determine another galaxy's shape.
    vec3 galactic=normalize(d+vec3(uSeaOffset.xy*.013,0.));
    vec3 equatorial=mat3(-.05487556,-.87343709,-.48383502,
      .49410943,-.44482963,.74698224,-.86766615,-.19807637,.45598378)*galactic;
    float longitude=dot(equatorial.xy,equatorial.xy)>.0000001?atan(equatorial.y,equatorial.x):0.;
    vec2 uv=vec2(.5-longitude/6.28318530718,asin(clamp(equatorial.z,-1.,1.))/3.14159265359+.5);
    vec2 uvDx=dFdx(uv),uvDy=dFdy(uv);
    uvDx.x-=floor(uvDx.x+.5);
    uvDy.x-=floor(uvDy.x+.5);
    vec3 catalog=textureGrad(uSeaDetail,uv,uvDx,uvDy).rgb;
    float lowFrequency=dot(textureLod(uSeaDetail,uv,5.).rgb,vec3(.2126,.7152,.0722));
    float grainRatio=dot(catalog,vec3(.2126,.7152,.0722))/max(lowFrequency,.003);
    stellarGrain*=mix(.8,1.2,clamp(grainRatio*.5,0.,1.));
  }
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
  float mass=0.,nucleus=0.,birth=0.;
  if(uSeaMorphA.x>0.) { // broad dust river, with a displaced compact bulge
    float bulge=exp(-seaSquare((d.z-asymmetry*.6)/(.28+core))-latitude*latitude*38.)*sideFront;
    mass+=uSeaMorphA.x*(band*(.25+cloud*1.4)+bulge*core*1.5)*transmission;
    nucleus+=uSeaMorphA.x*bulge*core;
  }
  if(uSeaMorphA.y>0.) { // folded asymmetric reflection curtain
    float fold=latitude-warp*sin(d.x*pitch+uSeaPhase)-asymmetry*.4;
    float veil=exp(-fold*fold*(18.+stretch*14.))*(.2+cloud*1.6)*sideFront;
    mass+=uSeaMorphA.y*veil*exp(-eroded*uSeaDust.x*.65);
    birth+=uSeaMorphA.y*veil*.35;
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
    float arc=length((p+vec2(.25,.55))/vec2(1.,.7+spread*.4))-(.58+spread*.28);
    float curve=exp(-arc*arc*(90.+stretch*70.));
    mass+=uSeaMorphB.z*curve*front*(.15+cloud)*transmission;
    birth+=uSeaMorphB.z*curve*front*cloud*.4;
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
    float rim=exp(-shell*shell*(100.+stretch*80.))*(.3+smoothstep(.25,.7,middle));
    mass+=uSeaMorphC.z*rim*sideFront*(.25+cloud*1.5)*exp(-eroded*uSeaDust.x*.4);
    birth+=uSeaMorphC.z*rim*sideFront;
  }
  if(uSeaMorphD.x>0.) { // flowing filaments, separated rather than a solid cloud
    float strands=0.;
    for(int i=0;i<3;i++){
      float k=float(i),fold=latitude-(k-1.)*(.12+spread*.12)-warp*sin(d.x*pitch+k+uSeaPhase);
      strands+=exp(-fold*fold*(180.+k*70.))*(1.-k*.2);
    }
    mass+=uSeaMorphD.x*strands*sideFront*(.15+cloud)*transmission;
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
    float knots=0.;
    for(int i=0;i<5;i++){
      float k=float(i),angle=k*2.399+uSeaPhase;
      vec2 center=vec2(cos(angle),sin(angle))*sqrt(k+.2)*(.1+spread*.12);
      knots+=exp(-dot(p-center,p-center)*(65.+k*24.))*(1.-k*.12);
    }
    mass+=uSeaMorphE.x*knots*front*(.3+cloud*1.5);
    birth+=uSeaMorphE.x*knots*front*1.2;
  }
  if(uSeaMorphE.y>0.) { // tidally pulled clusters joined by a curved, faint bridge
    vec2 a=p-vec2(-.3,asymmetry),b=p-vec2(.35,-asymmetry*.5);
    float pair=exp(-dot(a,a)*25.)+exp(-dot(b,b)*55.)*.65;
    float bridge=exp(-seaSquare(p.y-asymmetry*cos(p.x*3.))*200.-p.x*p.x*3.)*.22;
    mass+=uSeaMorphE.y*(pair+bridge)*front*(.25+cloud)*transmission;
    birth+=uSeaMorphE.y*pair*front*.6;
  }
  if(uSeaMorphE.z>0.) { // braided absorbing columns against scattered light
    float wave=warp*sin(d.z*pitch+uSeaPhase);
    float braid=exp(-seaSquare(side.x-wave)*80.)+exp(-seaSquare(side.x+wave+.22)*120.);
    float backlight=exp(-side.x*side.x*4.-side.y*side.y*3.)*sideFront;
    mass+=uSeaMorphE.z*backlight*(.3+cloud)*exp(-braid*uSeaDust.x*(.6+middle));
    birth+=uSeaMorphE.z*backlight*pow(cloud,3.)*.4;
  }
  if(uSeaMorphF.x>0.) { // an empty molecular eye bounded by illuminated dust
    float eye=length(side/vec2(.6+spread*.3,.3+core*.4))+(broad-.5)*warp;
    float rim=exp(-seaSquare(eye-.75)*32.);
    float opening=exp(-eye*eye*6.);
    mass+=uSeaMorphF.x*rim*sideFront*(.3+cloud*1.2)*exp(-opening*uSeaDust.x*2.);
  }
  if(uSeaMorphF.y>0.) { // a long tidal tail with a fading, uneven taper
    float tail=p.y-warp*sin(p.x*pitch+uSeaPhase)-asymmetry*p.x;
    float stream=exp(-tail*tail*(90.+stretch*80.))*exp(-p.x*p.x*(.5+core));
    mass+=uSeaMorphF.y*stream*front*(.15+cloud)*transmission;
    nucleus+=uSeaMorphF.y*exp(-dot(p+vec2(.35,0.),p+vec2(.35,0.))*90.)*front*core;
  }
  if(uSeaMorphF.z>0.) { // broken annulus with irregular, one-sided tidal debris
    float ring=length(p/vec2(.55+spread*.3,.35+core*.4))-.85+(broad-.5)*warp*.8;
    float fragments=smoothstep(.25,.7,middle+asymmetry*p.x);
    mass+=uSeaMorphF.z*exp(-ring*ring*85.)*fragments*front*(.3+cloud*1.4);
    birth+=uSeaMorphF.z*exp(-ring*ring*85.)*fragments*front*.4;
  }
  float youngKnots=pow(smoothstep(.55,.82,fine),3.)*birth*uSeaState.x;
  vec3 radiance=color*max(0.,mass)*stellarGrain*uSeaDust.w
    +uSeaWarm*nucleus*(.5+core)+uSeaAccent*youngKnots*.65;
  return radiance*uSeaState.y*uSeaState.z*uSeaQuiet;
}
vec3 deepSky(vec3 direction) {
  vec3 d=normalize(direction);
  vec3 sky=uSkyTint*uSkyBrightness*.055;
  if(uSkyBandStrength!=0.){
    float grain=skyNoise(d*11.)*.6+skyNoise(d*31.+17.)*.27+skyNoise(d*79.+29.)*.13;
    float latitude=dot(d,uSkyBandNormal);
    float warpedLatitude=latitude+(grain-.5)*.065;
    float band=exp(-warpedLatitude*warpedLatitude*105.)*uSkyBandStrength;
    // Dark absorbing lanes interrupt a broader stellar population. Noise belongs
    // to the sky direction, so turning or lensing cannot make the dust swim.
    float dustLatitude=(latitude+(grain-.5)*.12)/.023;
    float dust=exp(-dustLatitude*dustLatitude);
    float transmission=exp(-dust*(1.6+grain*2.4));
    float stellarCloud=.55+2.6*smoothstep(.28,.72,grain);
    vec3 stellarTint=mix(vec3(.73,.82,1.),vec3(1.08,.95,.78),smoothstep(.3,.7,grain));
    sky=uSkyTint*uSkyBrightness*(.055+band*stellarCloud*stellarTint*transmission);
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
  if(uSeaHasLandscape)return stellarLandscape(d,sky);
  return sky+stellarSea(d);
}`;

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
const LANDSCAPE_DEFAULTS = {
  offset:[0,0,0],shape:[1,1,0,.1],topology:[0,0,0,0],contour:[0,2,0,0],
  material:[0,0,0,0],light:[0,0,0,0],cool:[0,0,0],warm:[0,0,0],spectrum:[4,27,160,1],population:[0,1,0,0],
};
const LANDSCAPE_FIELDS = Object.entries(LANDSCAPE_DEFAULTS);
function landscapeComponent() {
  return {frame:new THREE.Matrix3(),...Object.fromEntries(Object.entries(LANDSCAPE_DEFAULTS).map(([key,values])=>
    [key,values.length===4?new THREE.Vector4(...values):new THREE.Vector3(...values)]))};
}

export function deepSkyUniforms({detailTexture = null} = {}) {
  const uniforms = {uSkyTint:{value:new THREE.Color(.55,.6,.66)},uSkyBandNormal:{value:new THREE.Vector3(0,1,0)},
    uSkyBrightness:{value:.012},uSkyBandStrength:{value:0},uSkyStarDensity:{value:.12},
    uSeaWeightsA:{value:new THREE.Vector3()},uSeaWeightsB:{value:new THREE.Vector3()},
    uSeaFrame:{value:new THREE.Matrix3()},uSeaPhase:{value:0},uSeaWidth:{value:1},uSeaQuiet:{value:1},
    uSeaDetail:{value:detailTexture},uSeaHasDetail:{value:Boolean(detailTexture)},
    uSeaHasLandscape:{value:false},uSeaComponents:{value:Array.from({length:4},landscapeComponent)}};
  for (const suffix of MORPH_GROUPS) uniforms[`uSeaMorph${suffix}`] = {value:new THREE.Vector3()};
  for (const [name,values] of Object.entries(SEA_PROFILE)) {
    uniforms[`uSea${name[0].toUpperCase()+name.slice(1)}`] = {value:values.length===4?new THREE.Vector4(...values):new THREE.Vector3(...values)};
  }
  return uniforms;
}
export function setDeepSkyEnvironment(uniforms, environment, quiet = 0) {
  if (!environment) return;
  uniforms.uSkyTint.value.fromArray(environment.ambientTint);
  uniforms.uSkyBandNormal.value.fromArray(environment.bandNormal);
  uniforms.uSkyBrightness.value = environment.skyBrightness * (1 - Math.max(0,Math.min(1,quiet))*.35);
  uniforms.uSkyBandStrength.value = environment.bandStrength;
  uniforms.uSkyStarDensity.value = environment.starDensity;
  const sea = environment.starSea;
  if (sea) uniforms.uSeaWeightsA.value.fromArray(sea.weights);
  else uniforms.uSeaWeightsA.value.set(0,0,0);
  if (sea) uniforms.uSeaWeightsB.value.fromArray(sea.weights,3);
  else uniforms.uSeaWeightsB.value.set(0,0,0);
  if (sea) {uniforms.uSeaFrame.value.fromArray(sea.frame);uniforms.uSeaPhase.value=sea.phase;uniforms.uSeaWidth.value=sea.width;}
  const landscape=sea?.landscape;
  uniforms.uSeaHasLandscape.value=landscape?.revision===1&&landscape.components?.length===4;
  for(let i=0;i<4;i++) {
    const target=uniforms.uSeaComponents.value[i],source=uniforms.uSeaHasLandscape.value?landscape.components[i]:null;
    if(source?.frame)target.frame.fromArray(source.frame);else target.frame.identity();
    for(const [key,defaults] of LANDSCAPE_FIELDS)target[key].fromArray(source?.[key]??defaults);
  }
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
  uniforms.uSeaQuiet.value=1-Math.max(0,Math.min(1,quiet))*.15;
}
export function createDeepSky({detailTexture = null} = {}) {
  const geometry = new THREE.SphereGeometry(100000,32,20);
  const material = new THREE.ShaderMaterial({uniforms:deepSkyUniforms({detailTexture}),
    vertexShader:'varying vec3 skyDirection;void main(){skyDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`varying vec3 skyDirection;${DEEP_SKY_GLSL}\nvoid main(){gl_FragColor=vec4(deepSky(skyDirection),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
    side:THREE.BackSide,depthWrite:false,depthTest:false});
  const group=new THREE.Group(),mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=-1000;mesh.frustumCulled=false;group.add(mesh);
  let disposed=false;
  group.userData.update=(environment,quiet)=>{if(!disposed)setDeepSkyEnvironment(material.uniforms,environment,quiet);};
  group.userData.dispose=()=>{if(disposed)return;disposed=true;geometry.dispose();material.dispose();};
  return group;
}
