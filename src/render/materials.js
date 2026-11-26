import * as THREE from 'three';
import { gasCloudGLSL } from './gas-clouds.js';
import { describePlanetAppearance } from './planet-appearance.js';
import { stellarLightingUniforms, planetRingShadowUniforms, stellarLightingGLSL, planetRingShadowGLSL, ringDensityGLSL } from './stellar-lighting.js';
export { setStellarLighting, setPlanetRingShadow } from './stellar-lighting.js';

const noise = /* glsl */`
float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float n=0.,a=.5;for(int i=0;i<5;i++){n+=noise3(p)*a;p=p*2.03+vec3(5.2,1.3,2.8);a*=.5;}return n;}
`;
const sphereVertex = /* glsl */`
varying vec3 vLocal,vNormalWorld,vWorld,vCenter;varying vec2 vUV;
void main(){vLocal=position;vUV=uv;vNormalWorld=normalize(mat3(modelMatrix)*normal);vWorld=(modelMatrix*vec4(position,1.)).xyz;vCenter=modelMatrix[3].xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}
`;
// No shared body layer writes depth or colour at zero coverage.
const visibilityDiscard = /* glsl */`
uniform float visibility;
void applyVisibility(){
  if(visibility<=0.)discard;
}
`;

export function planetMaterial(planet,{textures={},lightDirection=new THREE.Vector3(-1,.4,.35),skylight=null}={}){
  const appearance=describePlanetAppearance(planet);
  const kinds={gas:0,ocean:1,ice:2,rock:3,lava:4};
  const textureKey=appearance || planet.proceduralSurface ? null : planet.texture || (planet.kind==='gas' ? (planet.seed%2?'jupiter':'saturn') : planet.kind==='ocean'?'earth':planet.kind==='ice'||planet.kind==='rock'?'moon':null);
  const surfaceMap=textureKey?textures[textureKey]:null;
  const regolithMap=appearance?.family==='cratered'?textures.moon:null;
  // Legacy texture identifiers also specify the visual family when the host
  // supplies no image. Saved home worlds retain their own recorded palette.
  const nativeStyles={gas:1,ocean:4,ice:6,rock:8,lava:10};
  const nativeStyle=planet.texture==='moon'?8:planet.texture==='saturn'?2:nativeStyles[planet.kind]??1;
  const homeSurface=Boolean(planet.proceduralSurface || (!surfaceMap && (planet.home || planet.homeId)));
  const style=appearance?.surfaceStyle ?? (surfaceMap||homeSurface?0:nativeStyle);
  // Three exactly representable integer coordinates retain every bit of the
  // 32-bit saved seed in the material domain.
  const surfaceSeed=planet.seed>>>0;
  const seedOffset=new THREE.Vector3(surfaceSeed&2047,(surfaceSeed>>>11)&2047,surfaceSeed>>>22);
  return new THREE.ShaderMaterial({
    defines:{...(surfaceMap||regolithMap?{PLANET_SURFACE_MAP:1}:{}),...(skylight?{PLANET_SKYLIGHT:1}:{})},
    uniforms:{...skylight,...stellarLightingUniforms(),...planetRingShadowUniforms(),cloudTime:{value:0},weatherPhase:{value:0},hasRegolithMap:{value:Boolean(regolithMap)},surfaceStyle:{value:style},detailScale:{value:appearance?.detailScale ?? 1},appearanceA:{value:new THREE.Color(appearance?.colorA ?? planet.colorA)},appearanceB:{value:new THREE.Color(appearance?.colorB ?? planet.colorB)},visibility:{value:1},surface:{value:surfaceMap??regolithMap??null},hasSurface:{value:Boolean(surfaceMap)},proceduralSurface:{value:homeSurface},seedOffset:{value:seedOffset},bodyRadius:{value:planet.radius},paletteMix:{value:planet.paletteMix || 0},colorA:{value:new THREE.Color(planet.colorA)},colorB:{value:new THREE.Color(planet.colorB)},kind:{value:kinds[planet.kind]??0},seed:{value:planet.seed%1000},lightDir:{value:lightDirection.clone().normalize()}},
    vertexShader:sphereVertex,
    fragmentShader:/* glsl */`
      #ifdef PLANET_SKYLIGHT
        uniform vec3 skyIrradiance,skyBandNormal;
      #endif
      uniform int surfaceStyle;uniform float detailScale;uniform vec3 appearanceA,appearanceB;
      uniform bool hasSurface,proceduralSurface;uniform vec3 colorA,colorB,lightDir,seedOffset;uniform int kind;uniform float seed,paletteMix,bodyRadius,cloudTime,weatherPhase;
      #ifdef PLANET_SURFACE_MAP
        uniform sampler2D surface;uniform bool hasRegolithMap;
      #endif
      varying vec3 vLocal,vNormalWorld,vWorld,vCenter;varying vec2 vUV;${noise}${gasCloudGLSL}${visibilityDiscard}${stellarLightingGLSL}${planetRingShadowGLSL}
      #include <alphahash_pars_fragment>
      vec3 geologicalNormal(float height,vec3 normal){
        vec3 sx=dFdx(vWorld),sy=dFdy(vWorld);
        vec3 bx=cross(sy,normal),by=cross(normal,sx);
        float det=dot(sx,bx);
        vec3 gradient=sign(det)*bodyRadius*(dFdx(height)*bx+dFdy(height)*by);
        vec3 result=abs(det)*normal-gradient;
        return dot(result,result)>1e-20?normalize(result):normal;
      }
      void main(){
        applyVisibility();
        // Streaming visibility is subpixel coverage of an opaque surface.
        // Kept samples own depth, including the depth snapshot used by clouds.
        if(visibility<1.&&visibility<getAlphaHashThreshold(vLocal))discard;
        vec3 p=normalize(vLocal),n=normalize(vNormalWorld),view=normalize(cameraPosition-vWorld);
        float surfaceFootprint=max(length(dFdx(p)),length(dFdy(p)));
        vec3 base;float molten=0.;float oceanMask=kind==1?1.:0.;vec3 moltenColor=vec3(0.);
        if(surfaceStyle>0){
          // 3D local coordinates keep all patterns stationary and seam-free.
          vec3 terrain=p*4.5*detailScale+seedOffset;
          float broad=fbm(terrain),fine=noise3(terrain*7.3);
          float altitude=max(0.,length(cameraPosition-vCenter)-bodyRadius)/max(bodyRadius,1.);
          float closeDetail=1.-smoothstep(.035,.65,altitude);
          if(surfaceStyle<=3){
            base=gasClouds(p,seedOffset,appearanceA,appearanceB,surfaceStyle,cloudTime,surfaceFootprint);
          }else if(surfaceStyle<=5){
            float coastline=broad+fine*.018;
            float shoreWidth=max(.005,fwidth(coastline)*.5);
            float land=smoothstep(.516-shoreWidth,.516+shoreWidth,coastline);
            oceanMask=1.-land;
            float shelf=smoothstep(.49,.513,broad)-land;
            vec3 sea=appearanceA*(.8+fine*.3);
            base=mix(sea,appearanceB,broad*.32);
            if(surfaceStyle==4){
              float geology=noise3(terrain*18.3);
              float ridges=1.-abs(geology*2.-1.);
              float upland=smoothstep(.62,.75,broad);
              float dry=clamp(.18+abs(p.y)*.35+(fine-.5)*.55,0.,1.);
              vec3 lowland=mix(vec3(.095,.18,.075),vec3(.29,.22,.125),dry);
              float mountainMask=upland*smoothstep(.78,.94,ridges)*.62;
              vec3 mountain=mix(vec3(.21,.22,.205),vec3(.35,.34,.30),fine);
              vec3 ground=mix(lowland,mountain,mountainMask);
              ground*=.82+fine*.24;
              // Resolved rock strata stay fixed to the world. Filter each scale
              // before adding relief so orbital pixels do not shimmer.
              float strata=0.,grit=0.,strataWeight=0.,gritWeight=0.;
              // Camera altitude is constant for this body's draw. Keep screen
              // derivatives in this uniform branch, never a per-pixel land branch.
              if(closeDetail>0.){
                vec3 strataPoint=p*64.+seedOffset,gritPoint=p*256.+seedOffset;
                float strataFootprint=max(length(dFdx(strataPoint)),length(dFdy(strataPoint)));
                float gritFootprint=max(length(dFdx(gritPoint)),length(dFdy(gritPoint)));
                strataWeight=(1.-smoothstep(.25,.8,strataFootprint))*closeDetail;
                gritWeight=(1.-smoothstep(.25,.8,gritFootprint))*closeDetail;
                strata=1.-abs(noise3(strataPoint)*2.-1.);
                grit=noise3(gritPoint)-.5;
                ground*=1.+(strata-.5)*.3*strataWeight+grit*.12*gritWeight;
              }
              float snow=smoothstep(.89,.97,abs(p.y));
              ground=mix(ground,vec3(.78,.82,.81),snow);
              base=mix(sea,ground,land)+vec3(.035,.09,.065)*shelf;
              float height=land*(upland*ridges*ridges*.00007+geology*.000018);
              if(closeDetail>0.)height+=land*(strata*.0005*strataWeight+grit*.00008*gritWeight);
              n=geologicalNormal(height,n);
            }
            float clouds=smoothstep(.62,.77,fbm(terrain*2.6+vec3(14.)));
            base=mix(base,vec3(.82,.87,.88),clouds*(surfaceStyle==5?.48:.19));
          }else if(surfaceStyle==6){
            // Mineral-filled narrow faults fade into granular, ridged old ice.
            float fracture=min(abs(sin(p.x*17.+broad*5.)),abs(sin(p.z*21.+broad*7.)));
            float fault=(1.-smoothstep(.006,.034,fracture))*(.35+fine*.45);
            float grain=noise3(terrain*34.);
            float frost=smoothstep(.28,.72,broad*.7+fine*.3);
            base=mix(appearanceA,appearanceB,.35+frost*.48)*(.86+fine*.16+grain*.12);
            base=mix(base,vec3(.33,.32,.28),fault*.43);
            n=geologicalNormal(grain*.00008+fine*.00016-fault*.00016,n);
          }else if(surfaceStyle==7){
            float ice=smoothstep(.37,.67,broad+abs(p.y)*.15);
            float strata=.5+.5*sin(p.y*84.+broad*12.);
            base=mix(appearanceA,appearanceB,ice)*(.83+strata*.12+fine*.13);
          }else if(surfaceStyle==8){
            // Low-lying basalt plains and brighter rough highlands share a
            // terrain field. Impacts disturb this rock beneath the local light.
            vec3 basinPoint=p;
            basinPoint.xz=cloudRotation(seedOffset.x*.31)*basinPoint.xz;
            basinPoint.yz=cloudRotation(seedOffset.y*.19)*basinPoint.yz;
            float basinA=dot(basinPoint,vec3(.87,.44,.22));
            float basinB=dot(basinPoint,vec3(.49,-.22,.843));
            float basinC=dot(basinPoint,vec3(-.69,.65,-.317));
            float basinRim=max(basinA-.73,max(basinB-.83,basinC-.88));
            float mare=smoothstep(-.043,.055,basinRim+(broad-.5)*.16+(fine-.5)*.018);
            base=mix(appearanceA,appearanceB,.32+broad*.42)*(.87+broad*.15+fine*.15)*(1.-.35*mare);
            #ifdef PLANET_SURFACE_MAP
            if(hasRegolithMap){
              // Reuse the already loaded lunar map for resolved regolith and
              // varied impacts, with an independent stable longitudinal phase.
              vec2 regolithUV=vec2(fract(vUV.x+seedOffset.x/2048.+seedOffset.z/1048576.),vUV.y);
              vec3 regolith=textureGrad(surface,regolithUV,dFdx(vUV),dFdy(vUV)).rgb;
              vec3 mineralTint=mix(vec3(.94),appearanceB*1.3,.32);
              base=regolith*mineralTint*(.88+broad*.24);
            }
            #endif
            vec3 craterGradient=vec3(0.);vec3 q=p*12.+seedOffset;
            vec3 cell=floor(q);float ejecta=0.;
            for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)for(int z=-1;z<=1;z++){
              vec3 key=cell+vec3(float(x),float(y),float(z));
              float h=hash(key);vec3 center=key+vec3(hash(key+1.),hash(key+2.),hash(key+3.));
              vec3 delta=q-center;float d=length(delta),r=.1+h*.36;
              float bowlPhase=clamp((d-r*.35)/(r*.65),0.,1.);
              float bowlSlope=6.*bowlPhase*(1.-bowlPhase)/(r*.65);
              float rimDistance=(d-r)/.045;float rim=exp(-rimDistance*rimDistance);
              float radialSlope=-.0024*2.*rimDistance*rim/.045+.0045*bowlSlope;
              float erosion=.3+.7*clamp(fine*.65+h*.35,0.,1.);
              ejecta+=rim*(.04+.09*h)*(1.-mare*.4)-.055*(1.-bowlPhase)*h;
              craterGradient+=delta/max(d,.0001)*radialSlope*12.*.15*erosion;
            }
            // Convert the local height gradient into world-space relief using
            // the sphere's screen basis: the same rim is bright on one side and
            // sheltered on the other, under the actual stellar light direction.
            vec3 sigmaX=dFdx(vWorld),sigmaY=dFdy(vWorld);
            vec3 basisX=cross(sigmaY,n),basisY=cross(n,sigmaX);
            float determinant=dot(sigmaX,basisX);
            float heightX=dot(craterGradient,dFdx(p))*bodyRadius;
            float heightY=dot(craterGradient,dFdy(p))*bodyRadius;
            vec3 reliefGradient=sign(determinant)*(heightX*basisX+heightY*basisY);
            vec3 reliefNormal=abs(determinant)*n-reliefGradient;
            if(dot(reliefNormal,reliefNormal)>1e-20)n=normalize(reliefNormal);
            base*=1.+ejecta+closeDetail*(noise3(terrain*38.)-.5)*.1;
          }else if(surfaceStyle==9){
            float basin=smoothstep(.33,.7,broad);
            float dunes=.5+.5*sin(p.x*120.+p.z*42.+broad*17.);
            base=mix(appearanceA,appearanceB,basin)*(.83+fine*.18+dunes*(.035+closeDetail*.09));
          }else{
            // Disconnected active flows widen into pools; most crust is cold.
            float flowNoise=noise3(terrain*3.8+vec3(fine*.35));
            float crack=abs(sin(broad*23.+flowNoise*2.));
            float width=.045+fine*fine*.27;
            float channel=(1.-smoothstep(width*.2,width,crack))*smoothstep(.42,.7,flowNoise);
            float pool=smoothstep(.65,.77,broad)*smoothstep(.44,.7,fine);
            molten=clamp(channel*.65+pool,0.,1.);
            float grain=noise3(terrain*31.);
            vec3 crust=mix(vec3(.055,.06,.065),vec3(.19,.16,.145),broad)*(.58+fine*.48+grain*.22);
            moltenColor=mix(vec3(.65,.035,.006),vec3(1.,.28,.025),smoothstep(.56,.86,fine));
            base=mix(crust,moltenColor*.3,molten);
            n=geologicalNormal(fine*.00023+grain*.00007-molten*.00008,n);
          }
        }
        else if(proceduralSurface){
          // Saved palette and seed define each home. Its crust is body-fixed;
          // only the weather domain advances on the flight weather clock.
          float weatherAngle=weatherPhase+cloudTime*.006;
          vec3 terrain=p*5.1+seedOffset;
          if(kind==1){
            float land=fbm(terrain)+.12*(noise3(terrain*3.1)-.5);
            float shore=smoothstep(.48,.55,land);
            float shelf=smoothstep(.40,.49,land)*(1.-shore);
            float bed=noise3(terrain*2.2);
            float ridgeField=noise3(terrain*3.7);
            float divide=1.-abs(2.*ridgeField-1.);
            float spine=divide*divide*smoothstep(.52,.68,land);
            vec3 sea=colorA*(.55+.37*bed)+shelf*(colorA*.23+vec3(.014,.059,.038));
            vec3 ground=colorB*(.66+.40*ridgeField+.32*spine);
            base=mix(sea,ground,shore);
            n=geologicalNormal(spine*.0021+land*shore*.0004,n);
            vec3 drift=vec3(sin(weatherAngle),0.,cos(weatherAngle))*.64;
            vec3 air=p*vec3(8.,15.,8.)+seedOffset+drift;
            float front=noise3(air+vec3(bed*1.4,bed*.55,0.));
            float veil=smoothstep(.50,.80,front)*smoothstep(.36,.76,noise3(air*2.+vec3(front*2.)));
            base=mix(base,vec3(.82,.86,.87),veil*.37);
            oceanMask=(1.-shore)*(1.-veil*.78);
          }else if(kind==0){
            float warp=fbm(terrain*.85)-.5;
            vec3 drift=vec3(sin(weatherAngle+p.y*5.),0.,cos(weatherAngle+p.y*5.));
            float shear=noise3(terrain*2.8+drift*.74)-.5;
            float fine=noise3(terrain*8.6+drift*1.32)-.5;
            float latitude=p.y*36.+warp*5.+shear*2.2;
            float belts=sin(latitude+sin(latitude*.44)*.6)*.5+.5;
            float jets=pow(max(0.,sin(latitude*2.7+fine*2.)*.5+.5),9.);
            float wisps=noise3(vec3(p.x*22.,p.y*118.,p.z*22.)+seedOffset+drift+vec3(warp*3.));
            base=mix(colorA,colorB,clamp(.1+belts*.66+shear*.22+jets*.16+fine*.13,0.,1.))*(.82+.26*wisps);
            float longitude=seedOffset.x*.073+seedOffset.z*.017;
            vec3 east=vec3(cos(longitude),0.,-sin(longitude));
            vec3 center=normalize(vec3(sin(longitude),sin(seedOffset.y*.11)*.32,cos(longitude)));
            vec3 north=cross(center,east);
            vec2 vortex=vec2(dot(p,east)*5.4,dot(p,north)*12.);
            vortex.y+=.18*vortex.x*vortex.x+shear*.16;
            float radius=length(vortex);
            float envelope=(1.-smoothstep(.48,1.25,radius))*smoothstep(.85,.94,dot(p,center));
            float wrap=sin(radius*12.+vortex.y/(.17+radius)*2.+wisps*2.+weatherAngle);
            base=mix(base,mix(colorA*.72,colorB*1.32,smoothstep(-.74,.85,wrap)),envelope*.68);
          }else if(kind==2){
            float cap=fbm(terrain*1.7);
            float drift=noise3(terrain*5.3);
            vec3 seams=p*vec3(7.,12.,7.)+seedOffset+vec3(cap*2.3,drift*.4,cap);
            float seamField=noise3(seams);
            float distanceToSeam=abs(seamField-.50);
            float width=max(.027,fwidth(seamField));
            float fissure=1.-smoothstep(.0,width*2.,distanceToSeam);
            float glacier=smoothstep(.38,.73,cap+abs(p.y)*.15);
            base=mix(colorA,colorB,.19+glacier*.69)*(.78+.26*drift);
            base=mix(base,colorA*.52,fissure*(.23+.42*glacier));
            n=geologicalNormal(cap*.0015-fissure*.0009,n);
          }else{
            float crust=fbm(terrain*1.7);
            float debris=noise3(terrain*5.3);
            float strata=p.y*3.1+p.x*.8+crust*2.4;
            float ledgeField=sin(strata*8.);
            float width=max(.16,fwidth(ledgeField));
            float ledge=(1.-smoothstep(0.,width,abs(ledgeField)))*smoothstep(.35,.62,crust);
            float highland=smoothstep(.42,.70,crust);
            base=mix(colorA,colorB,.19+.49*highland+.14*debris)*(.76+.38*debris+.16*ledge);
            n=geologicalNormal(crust*.0038+ledge*.00048+debris*.00031,n);
          }
        }
        #ifdef PLANET_SURFACE_MAP
        else if(hasSurface){base=texture2D(surface,vUV).rgb;if(kind==1)oceanMask=smoothstep(.015,.12,base.b-max(base.r,base.g)*.85);if(kind==2)base=mix(base,base*vec3(.78,.9,1.1),.45);}
        #endif
        else{base=colorA;}
        // Narrow cloud filaments become visible on approach.
        if(kind==0){
          float altitude=max(0.,length(cameraPosition-vCenter)-bodyRadius)/max(bodyRadius,1.);
          float nearDetail=1.-smoothstep(.025,.4,altitude);
          if(nearDetail>0.){
            float flow=fbm(p*31.+seed);
            vec3 cloud=p*vec3(170.,580.,170.)+vec3(flow*7.,seed,flow*4.);
            float curl=noise3(cloud)*.65+noise3(cloud*3.07)*.35;
            float ribbons=sin(p.y*430.+flow*11.+seed)*.5+.5;
            base*=1.+nearDetail*((curl-.5)*.22+(ribbons-.5)*.075);
          }
        }
        if(hasSurface&&!proceduralSurface&&paletteMix>0.){float level=dot(base,vec3(.2126,.7152,.0722));vec3 tinted=mix(colorA,colorB,smoothstep(.08,.7,level))*(.4+level*1.3);base=mix(base,tinted,paletteMix);}
        float light=dot(n,normalize(lightDir));float day=surfaceStyle>0?smoothstep(-.035,.065,dot(normalize(vNormalWorld),normalize(lightDir))):smoothstep(-.1,.16,light);
        float diffuse=max(light,0.);vec3 color=base*(.0025+day*(.045+pow(diffuse,.8)*1.15));
        if(stellarLighting){
          color=vec3(0.);vec3 point=vWorld-vCenter;vec3 geometricNormal=normalize(vNormalWorld);
          #ifdef PLANET_SKYLIGHT
            // Integrated distant starlight across the galactic band. It adds
            // diffuse energy with no invented local sun, glint or shadow.
            float axisCos=dot(n,skyBandNormal);
            float bandExposure=sqrt(max(0.,1.-axisCos*axisCos));
            color=base*skyIrradiance*(.45+.65*bandExposure);
          #endif
          for(int i=0;i<2;i++)if(i<stellarCount){
            vec3 direction=safeDirection(stellarOffsets[i]-point);
            float angularRadius=stellarAngularRadius(point,i);
            float horizon=stellarDay(dot(geometricNormal,direction),angularRadius);
            // Every reflected, specular and atmospheric-limb term below is
            // multiplied by horizon. Retain the partial finite disc at h>0;
            // the fully dark hemisphere needs no eclipse/ring ray queries.
            if(horizon<=0.)continue;
            float diffuse=stellarDiffuse(dot(n,direction),angularRadius);
            float transmission=stellarTransmission(point,i)*planetRingTransmission(point,i,bodyRadius,surfaceFootprint);
            vec3 radiance=stellarColors[i]*stellarIntensities[i]*transmission;
            color+=base*radiance*horizon*(.045+pow(diffuse,.8)*1.15);
            if(kind==1){
              float specular=pow(clamp(dot(reflect(-direction,n),view),0.,1.),75.);
              color+=radiance*specular*.32*horizon*oceanMask;
            }
            float stellarLimb=pow(1.-clamp(dot(n,view),0.,1.),4.5)*horizon;
            if(kind==1||kind==0)color+=radiance*vec3(.13,.27,.39)*stellarLimb*.5;
          }
        }else{
          if(kind==1){float spec=pow(max(dot(reflect(-normalize(lightDir),n),view),0.),75.);color+=spec*.12*day*oceanMask;}
          // Normalized float vectors can still produce a dot slightly above one.
          float limb=pow(1.-clamp(dot(n,view),0.,1.),4.5)*day;
          if(kind==1||kind==0)color+=vec3(.13,.27,.39)*limb*.5;
        }
        if(surfaceStyle==10)color+=moltenColor*molten*.85;
        if(surfaceStyle==0&&kind==4&&!hasSurface)color+=colorB*pow(1.-abs(sin(fbm(p*5.+seed)*32.)),23.)*.3;
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `, transparent:false, depthWrite:true, alphaHash:true,
  });
}

export function atmosphereMaterial(color,lightDirection=new THREE.Vector3(-1,.4,.35)){
  return new THREE.ShaderMaterial({uniforms:{...stellarLightingUniforms(),visibility:{value:1},tint:{value:new THREE.Color(color).lerp(new THREE.Color(0x72bded),.15)},lightDir:{value:lightDirection.clone().normalize()}},vertexShader:sphereVertex,
    fragmentShader:/* glsl */`
      varying vec3 vNormalWorld,vWorld,vCenter;uniform vec3 tint,lightDir;uniform float visibility;${stellarLightingGLSL}
      void main(){
        vec3 n=normalize(vNormalWorld);float facing=clamp(abs(dot(n,normalize(cameraPosition-vWorld))),0.,1.);float optical=pow(1.-facing,4.);float day=smoothstep(-.2,.4,dot(n,lightDir));
        vec3 glow=tint*(.4+day*.8);float alpha=optical*day*.18*visibility;
        if(stellarLighting){
          glow=vec3(0.);vec3 point=vWorld-vCenter;
          for(int i=0;i<2;i++)if(i<stellarCount){
            vec3 direction=safeDirection(stellarOffsets[i]-point);
            float sunward=smoothstep(-.2,.4,dot(n,direction));
            glow+=tint*stellarColors[i]*stellarIntensities[i]*stellarTransmission(point,i)*sunward*(.4+sunward*.8);
          }
          alpha=optical*.18*visibility;
        }
        gl_FragColor=vec4(glow,alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,side:THREE.BackSide,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false});
}

export function ringMaterial(color,seed,{texture=null,procedural=false,planetRadius=1,lightDirection=new THREE.Vector3(-1,.4,.35)}={}){
  return new THREE.ShaderMaterial({defines:procedural?{PROCEDURAL_RING_DENSITY:1}:texture?{RING_SURFACE_MAP:1}:{},uniforms:{...stellarLightingUniforms(),visibility:{value:1},tint:{value:new THREE.Color(color)},ringMap:{value:texture},useMap:{value:Boolean(texture)},seed:{value:seed%(procedural?16777213:100)},ringRotation:{value:new THREE.Vector2()},planetCenter:{value:new THREE.Vector3()},planetRadius:{value:planetRadius},lightDir:{value:lightDirection.clone().normalize()}},
    vertexShader:/* glsl */`varying vec3 localPoint,worldPoint,ringNormalWorld;void main(){localPoint=position;ringNormalWorld=normalize(mat3(modelMatrix)*normal);worldPoint=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(worldPoint,1.);}`,
    fragmentShader:/* glsl */`
      varying vec3 localPoint,worldPoint,ringNormalWorld;
      #ifdef RING_SURFACE_MAP
      uniform sampler2D ringMap;
      #endif
      uniform vec3 tint,planetCenter,lightDir;uniform float seed,planetRadius,visibility;
      uniform vec2 ringRotation;
      ${stellarLightingGLSL}${ringDensityGLSL}
      void main(){
        float r=length(localPoint.xy),v=(r-1.18)/1.08;
        vec3 color=tint;
        #ifdef PROCEDURAL_RING_DENSITY
          float pixel=max(fwidth(r),1.e-6);
          float alpha=proceduralRingDensity(r,seed,pixel);
          // Fine optical dust shears faster on the inner orbits. It slightly
          // changes albedo; the radial opacity used by the shadow stays shared.
          float angle=atan(localPoint.y,localPoint.x);
          float wisps=sin((angle-ringRotation.x)*13.+v*64.+ringPattern(seed,7.)*6.2831853)
                     *sin((angle-ringRotation.y)*17.-v*109.);
          color*=1.+.15*wisps*(1.-smoothstep(.004,.026,pixel));
        #else
          float alpha=ringDensity(r,seed,fwidth(r));
          color*=mix(vec3(.68,.65,.64),vec3(1.14,1.12,1.07),smoothstep(.20,.82,alpha));
          #ifdef RING_SURFACE_MAP
            vec4 art=texture2D(ringMap,vec2(v,.5));
            color=art.rgb;alpha*=art.a;
          #endif
        #endif
        vec3 p=worldPoint-planetCenter;vec3 illumination=vec3(0.);
        if(stellarLighting){
          for(int i=0;i<2;i++)if(i<stellarCount){
            vec3 direction=safeDirection(stellarOffsets[i]-p);
            float shadow=sphereTransmission(p,stellarOffsets[i],stellarRadii[i],vec3(0.),planetRadius)*stellarTransmission(p,i);
            // Ice and dust scatter on both faces. Grazing light remains visible,
            // with a broad inclination response rather than edge-on flicker.
            float inclination=.3+.7*sqrt(clamp(abs(dot(normalize(ringNormalWorld),direction)),0.,1.));
            illumination+=stellarColors[i]*stellarIntensities[i]*shadow*inclination*.9;
          }
        }else{
          float t=dot(-p,lightDir);float shadow=1.;
          if(t>0.)shadow=smoothstep(planetRadius*.98,planetRadius*1.03,length(p+lightDir*t));
          illumination=vec3(.035+shadow*.72);
        }
        gl_FragColor=vec4(color*illumination,alpha*visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,transparent:true,side:THREE.DoubleSide,depthWrite:false});
}

export function starMaterial(color){
  return new THREE.ShaderMaterial({uniforms:{visibility:{value:1},tint:{value:new THREE.Color(color)},time:{value:0}},vertexShader:sphereVertex,
    fragmentShader:/* glsl */`
      varying vec3 vLocal,vNormalWorld,vWorld;uniform vec3 tint;uniform float time;${noise}${visibilityDiscard}
      void main(){applyVisibility();vec3 p=normalize(vLocal);float n=fbm(p*24.+time*.04);float cells=noise3(p*95.+n*2.);float view=pow(max(dot(normalize(vNormalWorld),normalize(cameraPosition-vWorld)),0.),.3);vec3 surface=tint*(1.9+n*1.4+cells*.3)*(.32+view*.68);gl_FragColor=vec4(surface,visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,transparent:true,depthWrite:true});
}
