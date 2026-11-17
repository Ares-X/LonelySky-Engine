import {COSMIC_SCENE_DEPTH_GLSL} from './cosmic-scene-depth.js';
import * as THREE from 'three';
import { hashSeed, randomFromSeed } from '../random.js';
import { describeGalaxyAppearance } from './galaxy-appearance.js';
import { COSMIC_VIEW_FADE_START, COSMIC_VIEW_FAR, COSMIC_DEPTH_GLSL } from '../cosmic-structures.js';

// A bounded emission integral through a real ellipsoid, not a camera-facing
// painted galaxy. All materials share the same shader program and geometry.
// Two-point Gauss cells integrate a bin instead of sampling one coherent plane.
// Arrays are reused by every volume and quality update; no frame allocations.
const integrationRules = Object.fromEntries([4, 8, 12, 16, 24].map(cells => {
  const nodes = [];
  for (let i = 0; i < cells; i++) for (const sign of [-1, 1])
    nodes.push(new THREE.Vector2((i + .5 + sign / Math.sqrt(12)) / cells, .5 / cells));
  while (nodes.length < 48) nodes.push(new THREE.Vector2(0, 0));
  return [cells * 2, nodes];
}));

const vertexShader = /* glsl */`
  ${COSMIC_DEPTH_GLSL}
  varying vec3 localExit;
  void main(){
    localExit=position;
    vec3 world=(modelMatrix*vec4(position,1.)).xyz;
    vec3 relative=world-cameraPosition;float distanceToCamera=length(relative);
    float drawDistance=distanceToCamera<=160000.?distanceToCamera:160000.+40000.*(1.-exp(-(distanceToCamera-160000.)/180000.));
    vec3 proxy=cameraPosition+relative*(drawDistance/max(distanceToCamera,.001));
    #ifdef COSMIC_STRUCTURES
      // This back face only supplies ray coverage. Preserve physical x/y/w
      // for interpolation, but keep its unused raster depth away from clip
      // planes: ordinary float32 z≈w loses the far-plane gap at 100M scales.
      // Actual opaque occlusion is applied to the physical integral below.
      vec4 physicalClip=projectionMatrix*viewMatrix*vec4(world,1.);
      physicalClip.z=physicalClip.w*.5;
      gl_Position=physicalClip;
    #else
      gl_Position=projectionMatrix*viewMatrix*vec4(proxy,1.);
    #endif
  }
`;
const fragmentShader = /* glsl */`
  ${COSMIC_DEPTH_GLSL}
  varying vec3 localExit;
  uniform vec3 localCamera;uniform vec3 shapeScale;uniform vec3 tint;
  uniform float radius;uniform float thickness;uniform float arms;uniform float pitch;
  uniform float morphology;uniform float asymmetry;uniform float bar;uniform float brightness;
  uniform float armStrength;uniform float coreStrength;uniform float dustStrength;uniform float haloStrength;
  uniform float bridgeStrength;uniform float knotScale;uniform float youngStrength;uniform float emissionStrength;
  uniform highp uint dustSeed;uniform vec2 noiseOffset;
  // Jump directly to each corner of the seeded 64-wide random sequence.
  // Four lanes follow randomFromSeed's uint32 operations for the old field.
  float broadDust(vec2 uv){
    vec2 point=uv*4.,f=fract(point);
    uvec2 cell=uvec2(point),next=(cell+1u)&3u;
    uvec4 index=uvec4(cell.x,next.x,cell.x,next.x)+64u*uvec4(cell.yy,next.yy);
    uvec4 state=dustSeed+(index+1u)*0x6d2b79f5u;
    uvec4 h=(state^(state>>15u))*(state|1u);
    h^=h+(h^(h>>7u))*(h|61u);
    vec4 corners=vec4(h^(h>>14u))*(1./4294967296.)-.5;
    f=f*f*(3.-2.*f);
    vec2 row=mix(corners.xz,corners.yw,f.x);
    return mix(row.x,row.y,f.y);
  }
  mediump vec2 dustWave(mediump vec2 turns){
    mediump vec2 x=1.-4.*abs(fract(turns)-.5);
    return x*(1.5-.5*x*x);
  }
  float dustField(vec2 p,float footprint){
    if(footprint>=.25)return .5;
    vec2 uv=fract(p-vec2(1./128.));
    mediump vec4 weight=(1.-smoothstep(vec4(.25),vec4(1.),footprint*vec4(4.,8.,16.,32.)))*vec4(.52,.28,.14,.06);
    float broad=broadDust(uv);
    mediump vec2 mid=dustWave(vec2(dot(uv,vec2(3.,-2.)),dot(uv,vec2(1.,4.)))+broad*1.7);
    mediump vec2 fine=dustWave(vec2(dot(uv,vec2(-3.,5.)),dot(uv,vec2(6.,2.)))+.33*mid.yx);
    mediump vec2 grain=dustWave(vec2(dot(uv,vec2(11.,4.)),dot(uv,vec2(-7.,13.)))+.35*fine.yx);
    mediump vec4 bands=vec4(broad,dot(mid,vec2(.23,.19)),dot(fine,vec2(.19,.23)),dot(grain,vec2(.23,.19)));
    return clamp(.5+1.65*dot(bands,weight),0.,1.);
  }
  #ifdef COSMIC_STRUCTURES
    ${COSMIC_SCENE_DEPTH_GLSL}
  #endif
  #ifdef COSMIC_SUPPORT_FADE
    uniform float structureVisibility;
  #endif
  uniform int steps;uniform vec2 quadrature[48];uniform vec2 coreQuadrature[48];
  float armLobe(float angularOffset,float width,float angularVariance,float period){
    float sigma=sqrt(width*width+angularVariance);
    // Adjacent periods keep the convolution continuous at the phase seam.
    // Scaling by width/sigma preserves the original arm's integrated light.
    vec3 offsets=vec3(angularOffset-period,angularOffset,angularOffset+period)/sigma;
    vec3 lobes=exp(-.5*offsets*offsets);
    float filtered=dot(lobes,vec3(1.))*width/sigma;
    float mean=width*arms*.3989422804;
    return mix(filtered,mean,smoothstep(.3,.55,sigma/period));
  }
  vec2 armDensities(vec2 p,float width,float footprint){
    float r=length(p);
    // The axis has no angular phase; its disk contribution is masked below.
    if(r<=.000001) return vec2(width*arms*.3989422804,width*.24*arms*.3989422804);
    float theta=atan(p.y,p.x);
    // Exact centre phase used by sampleGalaxy: theta=arm*TAU/arms+log(r+.06)/pitch.
    float phase=(theta-log(r+.06)/pitch)*arms;
    float angularOffset=atan(sin(phase),cos(phase))/arms;
    // Approximate the ray/pixel box footprint by a Gaussian of equal variance.
    // The logarithmic radial and angular gradients are orthogonal.
    float radialSlope=pitch*(r+.06);
    float angularVariance=footprint*footprint*(1./max(r*r,.000001)+1./(radialSlope*radialSlope))/12.;
    float period=6.28318530718/arms;
    // The former mat2(cos(a),-sin(a),sin(a),cos(a)) rotates by -a.
    // Rotation preserves r and its footprint; only the wrapped phase shifts.
    float laneOffset=angularOffset-.075;
    laneOffset-=floor(laneOffset/period+.5)*period;
    return vec2(armLobe(angularOffset,width,angularVariance,period),armLobe(laneOffset,width*.24,angularVariance,period));
  }
  // Analytic column through a finite dust sheet, modulated by filtered clouds.
  // The Lorentzian column has a stable grazing limit and needs no extra ray steps.
  // Only this volume's emission is absorbed; empty sky remains untouched.
  float dustTransmission(vec3 q,float footprint){
    if(dustStrength<=0.) return 1.;
    #ifdef COSMIC_STRUCTURES
      // Attenuate this emitter's world-fixed dusty pocket. A full flat sheet
      // column created an opaque ruler across every V3 edge-on stellar disc.
      vec3 p=q*shapeScale;
      vec2 dustPlane=p.xz+p.y*vec2(.37,.71);
      float cloud=dustField(dustPlane*1.43+noiseOffset,footprint*1.43);
      float warpedHeight=p.y/thickness+(cloud-.5)*1.7;
      float pocketVertical=exp(-.5*warpedHeight*warpedHeight);
      float r=length(p.xz);
      float radial=smoothstep(.025,.13,r)*(1.-smoothstep(.72,1.,r));
      float pocket=smoothstep(.38,.68,cloud);
      return exp(-dustStrength*2.4*pocketVertical*radial*pocket);
    #else
    vec3 p=q*shapeScale,camera=localCamera*shapeScale;
    vec3 delta=camera-p;float reach=length(delta);
    vec3 direction=delta/max(reach,.000001);
    // The sheet ends at the existing support sphere. Moving the observer
    // farther along the same external ray cannot add fictitious foreground dust.
    float b=dot(p,direction);
    float supportReach=max(0.,-b+sqrt(max(0.,b*b+1.-dot(p,p))));
    reach=min(reach,supportReach);camera=p+direction*reach;
    float sheet=max(thickness*.3,.008);
    float column;
    if(abs(direction.y)<.0001) column=reach/(1.+(p.y/sheet)*(p.y/sheet));
    else column=sheet*(atan(camera.y/sheet)-atan(p.y/sheet))/direction.y;
    float crossing=abs(direction.y)<.0001?reach*.5:clamp(-p.y/direction.y,0.,reach);
    vec3 sheetPoint=p+direction*crossing;
    float radial=exp(-length(sheetPoint.xz)*2.2);
    float dustCloud=dustField(sheetPoint.xz*.73+noiseOffset,footprint*.73);
    radial*=.22+2.8*smoothstep(.32,.69,dustCloud);
    return exp(-clamp(max(0.,column)*radial*dustStrength*6.,0.,12.));
    #endif
  }
  vec3 islandCenter(float k){
    float theta=k*2.1+asymmetry;
    return vec3(cos(theta)*(.2+k*.17),(k-1.)*.12,sin(theta)*(.2+k*.17));
  }
  #ifdef COSMIC_STRUCTURES
  uniform vec4 nebulaBranchRoot[12],nebulaBranchTip[12],nebulaBranchBend[12];
  uniform vec4 nebulaBoundsMin[14],nebulaBoundsMax[14];
  uniform highp uint nebulaSeed;
  uniform vec3 nebulaWarm,nebulaCool,nebulaAmbient,nebulaLight;
  uniform vec3 nebulaMatter;
  uniform mat3 nebulaNoiseDomain[3];uniform ivec3 nebulaNoisePhase[3];
  const vec3 NEBULA_COOL_LIGHT=vec3(-.5,.6,.75);
  float nebulaSmoothDerivative(float lo,float hi,float x){
    if(x<=lo||x>=hi)return 0.;float t=(x-lo)/(hi-lo);return 6.*t*(1.-t)/(hi-lo);
  }
  // Keep the 96-cell periodic field, including its corner bits and gradients.
  // Adjacent XY products feed both Z planes without per-sample table reads.
  uvec4 nebulaCornerPlane(uvec4 xy,uint z){
    uvec4 h=xy^(z*0xcb1ab31fu)^nebulaSeed;
    h=(h^(h>>16u))*0x7feb352du;
    h=(h^(h>>15u))*0x846ca68bu;
    return h^(h>>16u);
  }
  void nebulaCorners(ivec3 cell,out uvec4 lower,out uvec4 upper){
    uvec3 c=uvec3(mod(vec3(cell),96.)),n=(c+1u)*uvec3(lessThan(c,uvec3(95u)));
    uvec4 xy=uvec4(c.x,n.x,c.x,n.x)*0x8da6b343u^uvec4(c.yy,n.yy)*0xd8163841u;
    lower=nebulaCornerPlane(xy,c.z);
    upper=nebulaCornerPlane(xy,n.z);
  }
  vec3 nebulaDecodeCorner(uint h){return vec3(float(h&1023u),float((h>>10)&1023u),float((h>>20)&1023u))*(2./1023.)-1.;}
  float nebulaDecodeScalar(uint h){return float(h&1023u)*(2./1023.)-1.;}
  vec3 nebulaNoiseVector(vec3 p,float frequency,int level,float footprint,out mat3 gradient){
    mat3 domain=nebulaNoiseDomain[level];vec3 point=domain*(p*frequency);
    ivec3 cell=ivec3(floor(point))+nebulaNoisePhase[level];vec3 f=fract(point),u=f*f*(3.-2.*f),d=6.*f*(1.-f);
    uvec4 xy0,xy1;nebulaCorners(cell,xy0,xy1);
    vec3 a=nebulaDecodeCorner(xy0.r),b=nebulaDecodeCorner(xy0.g),c=nebulaDecodeCorner(xy0.b),e=nebulaDecodeCorner(xy0.a);
    vec3 g=nebulaDecodeCorner(xy1.r),h=nebulaDecodeCorner(xy1.g),j=nebulaDecodeCorner(xy1.b),k=nebulaDecodeCorner(xy1.a);
    vec3 ab=mix(a,b,u.x),ce=mix(c,e,u.x),gh=mix(g,h,u.x),jk=mix(j,k,u.x),lower=mix(ab,ce,u.y),upper=mix(gh,jk,u.y);
    float width=frequency*footprint,attenuation=exp(-1.64493406685*width*width);
    gradient=mat3(mix(mix(b-a,e-c,u.y),mix(h-g,k-j,u.y),u.z)*d.x,mix(ce-ab,jk-gh,u.z)*d.y,(upper-lower)*d.z)*domain*(frequency*attenuation);
    return mix(lower,upper,u.z)*attenuation;
  }
  float nebulaNoiseScalar(vec3 p,float frequency,int level,float footprint,out vec3 gradient){
    mat3 domain=nebulaNoiseDomain[level];vec3 point=domain*(p*frequency);
    ivec3 cell=ivec3(floor(point))+nebulaNoisePhase[level];vec3 f=fract(point),u=f*f*(3.-2.*f),d=6.*f*(1.-f);
    uvec4 xy0,xy1;nebulaCorners(cell,xy0,xy1);
    float a=nebulaDecodeScalar(xy0.r),b=nebulaDecodeScalar(xy0.g),c=nebulaDecodeScalar(xy0.b),e=nebulaDecodeScalar(xy0.a);
    float g=nebulaDecodeScalar(xy1.r),h=nebulaDecodeScalar(xy1.g),j=nebulaDecodeScalar(xy1.b),k=nebulaDecodeScalar(xy1.a);
    float ab=mix(a,b,u.x),ce=mix(c,e,u.x),gh=mix(g,h,u.x),jk=mix(j,k,u.x),lower=mix(ab,ce,u.y),upper=mix(gh,jk,u.y);
    float width=frequency*footprint,attenuation=exp(-1.64493406685*width*width);
    gradient=transpose(domain)*vec3(mix(mix(b-a,e-c,u.y),mix(h-g,k-j,u.y),u.z)*d.x,mix(ce-ab,jk-gh,u.z)*d.y,(upper-lower)*d.z)*(frequency*attenuation);
    return mix(lower,upper,u.z)*attenuation;
  }
  // Boundary value first. Derivatives and warp/erosion chain only for positive profile.
  float nebulaTubeLit(vec3 p,vec3 root,vec3 tip,vec3 bend,float rootWidth,float tipWidth,float erosion,vec3 erosionGradient,mat3 coarseGradient,float footprint,out vec3 gradient,out float boundary){
    vec3 span=tip-root;float spanSquared=dot(span,span),raw=dot(p-root,span)/spanSquared,along=clamp(raw,0.,1.);
    vec3 center=mix(root,tip,along)+bend*sin(3.14159265359*along);
    float neck=1.-.45*smoothstep(.12,.60,along),h0=(along-.92)/.16,h1=(along-.70)/.10,e0=exp(-h0*h0),e1=exp(-h1*h1);
    float head=.55*e0+.16*e1,radius=mix(rootWidth,tipWidth,along),base=radius*neck+tipWidth*head;
    float factor=1.+.10*sin(along*13.+root.x*7.)+.06*sin(along*29.+root.y*9.);
    float width=base*factor;vec3 radial=p-center;float radialLength=length(radial);
    boundary=radialLength-width*(1.-erosion);
    float profile=1.-smoothstep(-.012,.012+footprint,boundary);
    gradient=vec3(0.);if(profile<=0.)return profile;
    vec3 alongGradient=raw>0.&&raw<1.?span/spanSquared:vec3(0.);
    vec3 centerDerivative=span+3.14159265359*bend*cos(3.14159265359*along);
    float neckDerivative=-.45*nebulaSmoothDerivative(.12,.60,along),headDerivative=-2.*(.55*h0/.16*e0+.16*h1/.10*e1);
    float baseDerivative=(tipWidth-rootWidth)*neck+radius*neckDerivative+tipWidth*headDerivative;
    float factorDerivative=1.3*cos(along*13.+root.x*7.)+1.74*cos(along*29.+root.y*9.);
    float widthDerivative=baseDerivative*factor+base*factorDerivative;
    vec3 n=radialLength>0.?radial/radialLength:vec3(0.);
    vec3 localGradient=n-alongGradient*(dot(n,centerDerivative)+widthDerivative*(1.-erosion));
    gradient=localGradient+.075*transpose(coarseGradient)*localGradient+width*erosionGradient;
    return profile;
  }
  // Existing boxes contain every allowed eroded sphere plus .012R and warp.
  // Their signed infinity distance is a lower bound for branch F-.012.
  // Expand by .0001R only for conservative floating arithmetic; not geometry.
  float nebulaPointBoxGap(int index,vec3 point){
    vec3 gap=max(nebulaBoundsMin[index].xyz-point,point-nebulaBoundsMax[index].xyz);
    return max(gap.x,max(gap.y,gap.z))-.0001;
  }
  vec4 nebulaDust(vec3 q,float footprint,vec3 rayDirection,float raySpan){
    float qlength=length(q),edge=1.-smoothstep(.8,1.,qlength);if(edge<=0.)return vec4(0.);
    vec3 p=q*shapeScale,voidCenter=vec3((noiseOffset.x-.5)*.45,.025,(noiseOffset.y-.5)*.45);
    vec3 boundPoint=p-voidCenter;bool dustPointPossible=false;
    for(int box=0;box<13;box++)if(nebulaPointBoxGap(box,boundPoint)<=footprint*nebulaBoundsMin[box].w){dustPointPossible=true;break;}
    if(!dustPointPossible)return vec4(0.); // rho=0: even noncompact skin tails have zero transfer.
    // Value pass: no matrices or branch gradients until a source can contribute.
    mat3 coarseGradient;vec3 midGradient,fineGradient;
    vec3 coarse=nebulaNoiseVector(p,6.8,0,footprint,coarseGradient);
    float midValue=nebulaNoiseScalar(p,21.2,1,footprint,midGradient);
    float fineValue=nebulaNoiseScalar(p,46.8,2,footprint,fineGradient);
    float mi=inversesqrt(midValue*midValue+.137),fi=inversesqrt(fineValue*fineValue+.137);
    float erosion=.45*midValue*mi+.12*fineValue*fi;
    vec3 erosionGradient=.45*.137*mi*mi*mi*midGradient+.12*.137*fi*fi*fi*fineGradient;
    vec3 w=p-voidCenter+.075*coarse;
    vec3 baseMetric=(w-vec3(-.12,.08,-.58))/vec3(.62,.38,.15);float baseLength=length(baseMetric);
    float shellDistance=.15*(baseLength-1.)+.15*erosion;
    float gateArgument=coarse.x+.3*coarse.y,wallGate=smoothstep(-.20,.15,gateArgument);
    float wallProfile=1.-smoothstep(-.015,.025+footprint,shellDistance),wall=wallProfile*wallGate;
    // Artistic finite excitation into dust, not a measured optical distance.
    // F is the unchanged implicit branch boundary, in units of body radius.
    // exp(-24*max(-F,0)) has a 1/24 R interior scale and no F=0 narrow peak.
    vec3 light0=p-(voidCenter+nebulaLight),light1=p-(voidCenter+NEBULA_COOL_LIGHT);
    float excite0=.16/(.16+dot(light0,light0)),excite1=.09/(.09+dot(light1,light1));
    vec3 litSum=vec3(0.);float sourceWeight=0.,pillar=0.;
    // One branch value query supplies both unchanged max density and source.
    for(int k=0;k<12;k++){
      vec4 root=nebulaBranchRoot[k],tip=nebulaBranchTip[k],bend=nebulaBranchBend[k];
      float lowerBoundary=nebulaPointBoxGap(k,w)+.087;
      if((1.-smoothstep(-.012,.012+footprint,lowerBoundary))*bend.w<=0.)continue;
      float erosionScale=k%2==0?1.:.65,boundary;vec3 gradient;
      float profile=nebulaTubeLit(w,root.xyz,tip.xyz,bend.xyz,root.w,tip.w,erosion*erosionScale,erosionGradient*erosionScale,coarseGradient,footprint,gradient,boundary)*bend.w;
      if(profile>pillar)pillar=profile;
      if(profile<=0.)continue;
      float gradientLength=length(gradient);vec3 normal=gradientLength>0.?gradient/gradientLength:vec3(0.);
      float excitation=exp(-24.*max(0.,-boundary))*bend.w;
      float warm=max(0.,dot(normal,-light0)/sqrt(dot(light0,light0)+.16));
      float cool=max(0.,dot(normal,-light1)/sqrt(dot(light1,light1)+.09));
      vec3 component=excitation*(4.8*excite0*warm*(1.-excite0)*sqrt(1.-excite0)*nebulaWarm+.25*excite1*cool*cool*nebulaCool);
      float weight=1.5*profile;litSum+=weight*component;sourceWeight+=weight;
    }
    float content=1.5*pillar+.85*nebulaMatter.y*wall*(1.-.7*pillar),rho=edge*content*nebulaMatter.x;
    if(rho<=0.)return vec4(0.);
    vec2 detailPlane=p.xz+p.y*vec2(.37,.71);
    float detail=dustField(detailPlane*5.3+noiseOffset,footprint*5.3*1.3)*2.-1.;
    float fine=dustField(detailPlane*11.7+noiseOffset.yx,footprint*11.7*1.3)*2.-1.;
    float crag=.72+.18*detail+.10*fine;vec3 coreSource=crag*nebulaAmbient;
    float wallWeight=.85*nebulaMatter.y*wall*(1.-.7*pillar);
    if(wallWeight>0.){
      vec3 localGradient=baseLength>0.?.15*baseMetric/(vec3(.62,.38,.15)*baseLength):vec3(0.);
      vec3 gradient=localGradient+.075*transpose(coarseGradient)*localGradient+.15*erosionGradient;
      float gradientLength=length(gradient);vec3 normal=gradientLength>0.?gradient/gradientLength:vec3(0.);
      float excitation=exp(-24.*max(0.,-shellDistance))*wallGate;
      float warm=max(0.,dot(normal,-light0)/sqrt(dot(light0,light0)+.16));
      float cool=max(0.,dot(normal,-light1)/sqrt(dot(light1,light1)+.09));
      vec3 component=excitation*(4.8*excite0*warm*(1.-excite0)*sqrt(1.-excite0)*nebulaWarm+.25*excite1*cool*cool*nebulaCool);
      litSum+=wallWeight*component;sourceWeight+=wallWeight;
    }
    return vec4(coreSource+litSum/sourceWeight,rho);
  }
  vec4 nebulaDensity(vec3 q,float footprint,vec3 rayDirection,float raySpan,bool dustPossible){
    vec3 p=q*shapeScale,origin=vec3((noiseOffset.x-.5)*.45,.025,(noiseOffset.y-.5)*.45);
    float edge=1.-smoothstep(.8,1.,length(q));
    if(edge<=0.)return vec4(0.);
    vec4 dust=dustPossible?nebulaDust(q,footprint,rayDirection,raySpan):vec4(0.);
    // Compact C1 ionized-region envelope; no whole-hull opacity skirt.
    vec3 ionMetric=(p-origin-vec3(.05,.20,.20))/vec3(.78,.55,.72);
    float envelope=max(0.,1.-dot(ionMetric,ionMetric));
    float ion=edge*envelope*envelope*(1.-smoothstep(.05,.6,dust.a));
    vec3 light1=p-(origin+NEBULA_COOL_LIGHT);
    float excite1=.09/(.09+dot(light1,light1));
    vec3 ionSource=nebulaCool*vec3(1.,1.3125,1.2)*(.4+.6*excite1);
    // sigmaD=24*rho/R; sigmaI=.6*ion/R. Mix j and sigma, not output RGB.
    float ionRho=.025*ion*nebulaMatter.z,totalRho=dust.a+ionRho;
    if(totalRho<=0.)return vec4(0.);
    return vec4((dust.rgb*dust.a+ionSource*ionRho)/totalRho*(tint/vec3(.55201140150344,.5394794890033748,.48514994004665124)),totalRho);
  }
  vec2 nebulaBoundInterval(int index,vec3 origin,vec3 direction,float entry,float exit,float footprint){
    vec4 lower=nebulaBoundsMin[index],upper=nebulaBoundsMax[index];
    vec3 lo=lower.xyz-vec3(lower.w*footprint),hi=upper.xyz+vec3(lower.w*footprint);
    float first=entry,last=exit;
    for(int axis=0;axis<3;axis++){
      if(direction[axis]==0.){
        if(origin[axis]<lo[axis]||origin[axis]>hi[axis])return vec2(1.,-1.);
      }else{
        float a=(lo[axis]-origin[axis])/direction[axis],b=(hi[axis]-origin[axis])/direction[axis];
        first=max(first,min(a,b));last=min(last,max(a,b));
      }
    }
    return vec2(first,last);
  }
  #endif
  vec4 density(vec3 q,float footprint,float dustFootprint){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(edge<=0.) return vec4(0.);
    vec3 p=q*shapeScale;

    if(morphology<.5){
      float r=length(p.xz);
      // Resolved stellar mottling lies inside a continuous arm envelope. The
      // former low-frequency multiplicative gates broke arms into large beads.
      // Each field is filtered in world coordinates.
      float coarse=dustField(p.xz*.31+noiseOffset,footprint*.31);
      float fine=dustField(p.xz*1.71+noiseOffset.yx+vec2(.37,.19),footprint*1.71);
      float grain=dustField(p.xz*6.1+noiseOffset+vec2(.13,.47),footprint*6.1);
      // Correlated structure bends the arm spine gently; resolved star particles
      // still sit in the same arm envelope and retain their original positions.
      float angleWarp=(coarse-.5)*.13,radialWarp=1.+(fine-.5)*.045;
      mat2 warp=mat2(cos(angleWarp),-sin(angleWarp),sin(angleWarp),cos(angleWarp));
      vec2 armPoint=warp*p.xz*radialWarp;
      float width=.20+.14*clamp((coarse-.25)*2.,0.,1.);
      #ifdef COSMIC_STRUCTURES
        width=.075+.07*clamp((coarse-.25)*2.,0.,1.);
      #endif
      float vertical=p.y/(thickness*(.4+r));
      float disk=exp(-r*2.8)*exp(-.5*vertical*vertical);
      vec2 armPair=armDensities(armPoint,width,footprint*radialWarp);
      if(bar>.5){
        vec2 unbarred=armPoint/vec2(1.6,.45);
        float inside=1.-smoothstep(.27,.31,length(unbarred));
        if(inside>0.) armPair=mix(armPair,armDensities(unbarred,width,footprint*radialWarp/.45),inside);
      }
      float arm=armPair.x,lane=armPair.y;
      float mottling=.78+.4*smoothstep(.26,.73,fine);
      float laneShadow=1.-.58*clamp(lane,0.,1.)*(.65+.35*coarse);
      float armLight=arm*(.86+.28*coarse)*mottling*laneShadow*(1.-smoothstep(.63,.98,r));
      // A dim inter-arm population joins the arms without lifting empty sky.
      // Additional taper avoids thick, equally bright edges in grazing views.
      float height=p.y/(thickness*.65);
      float taper=exp(-r*r*1.5)*exp(-.5*height*height);
      float interarm=.38*(.85+.15*coarse);
      #ifdef COSMIC_STRUCTURES
        // Sparse arms and real black inter-arm gaps; no uniform glowing disk.
        interarm*=.035;
        armLight*=smoothstep(.28,.61,coarse*.65+fine*.35);
      #endif
      // Dust complexes absorb starlight within the arms at several scales.
      // Keep a positive transmission floor through optical depth rather than
      // cutting disconnected holes into the stellar population.
      #ifndef COSMIC_STRUCTURES
        float cloudTransmission=exp(-dustStrength*(.4+lane*2.)*smoothstep(.35,.68,coarse)*smoothstep(.4,.65,grain)*2.8);
      #else
        // V3 disc and core share the same local dusty-pocket owner above.
        float cloudTransmission=1.;
      #endif
      float amount=edge*disk*taper*(interarm+armStrength*armLight)*smoothstep(.025,.08,r)*cloudTransmission*dustTransmission(q,dustFootprint);
      float core=exp(-r*9.);
      float cool=smoothstep(.42,.64,fine)*smoothstep(.16,.5,r)*youngStrength;
      vec3 population=mix(vec3(1.03,.99,.91),vec3(.52,.76,1.3),cool);
      population=mix(population,vec3(1.12,.94,.74),core);
      // Sparse H-II regions follow dusty arms, between the cool young clusters.
      // This is a display palette inspired by Hubble, not an infrared sky map.
      float ionized=smoothstep(.64,.82,grain)*smoothstep(.48,.68,fine)*arm*youngStrength;
      population+=vec3(.85,.14,.23)*ionized*1.6;
      return vec4(tint*population,amount);
    }
    if(morphology<1.5) return vec4(0.);
    // Project physical height into the dust plane to vary pockets off the midplane.
    vec2 dustPlane=p.xz+p.y*vec2(.37,.71);
    float cloud=dustField(dustPlane*.9+noiseOffset,footprint*.9);
    float grain=dustField(dustPlane*2.7+noiseOffset.yx+vec2(.23,.61),footprint*2.7);
    cloud=clamp((cloud-.5)*2.8+.5,0.,1.);
    grain=clamp((grain-.5)*4.+.5,0.,1.);
    float structure=.2+1.25*smoothstep(.35,.65,cloud*.55+grain*.45);
    float pockets=1.-.72*smoothstep(.51,.68,cloud)*(1.-smoothstep(.37,.57,grain));
    float result=0.;float knots=0.;
    for(int knot=0;knot<3;knot++){
      float k=float(knot);vec3 center=islandCenter(k);
      float individuality=.78+.22*cos(k*2.4+asymmetry*2.);
      float islandWeight=.65+.35*sin(k*2.3+asymmetry*4.);
      vec3 delta=(p-center)/(vec3(.17,thickness*.5,.19)*knotScale*individuality);
      delta.x+=.28*sin(delta.z*2.1+k);
      float island=exp(-.5*dot(delta,delta));
      knots+=island;
      // An offset dense subcluster gives the smaller nursery knots internal
      // asymmetry. Its envelope stays bounded by the same support sphere.
      vec3 subcluster=delta-vec3(.7*cos(k*2.7),.4*sin(k*1.3),.6);
      float detail=exp(-dot(subcluster,subcluster)*2.2)*youngStrength;
      result+=(island+detail)*islandWeight*.85*structure*pockets/sqrt(knotScale);
      if(knot<2){
        vec3 next=islandCenter(k+1.);vec3 span=next-center;
        float along=clamp(dot(p-center,span)/max(dot(span,span),.000001),0.,1.);
        vec3 bridge=(p-center-span*along)/vec3(.035,.045,.035);
        result+=bridgeStrength*exp(-.5*dot(bridge,bridge))*max(0.,sin(along*3.14159265359));
      }
    }
    result+=haloStrength*exp(-dot(p,p)*5.)*.035;
    vec3 population=mix(vec3(1.08,.96,.84),vec3(.64,.85,1.32),clamp(knots*youngStrength,0.,1.));
    #ifdef COSMIC_STRUCTURES
      if(structureKind>.5&&structureKind<1.5) result*=.06;
    #endif
    return vec4(tint*population,edge*result);
  }
  vec3 coreEmission(vec3 q,float footprint,float dustFootprint){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(morphology>.5){
      float stellarRadius=length(q);
      vec2 stellarPlane=q.xz+q.y*vec2(.41,.63);
      float stellarGrain=dustField(stellarPlane*1.1+noiseOffset,footprint*1.1);
      #ifdef COSMIC_STRUCTURES
        if(structureKind>.5&&structureKind<1.5){
          // Resolved cluster stars own the halo. Retain only the compact,
          // unresolved central population instead of an elliptical-galaxy lamp.
          float clusterCore=exp(-stellarRadius*18.)*coreStrength*.05;
          return tint*edge*clusterCore*(.7+.6*stellarGrain);
        }
      #endif
      float compactCore=exp(-stellarRadius*8.5)*coreStrength;
      float envelope=exp(-stellarRadius*3.5)*haloStrength*.03;
      return tint*edge*(compactCore+envelope)*(.7+.6*stellarGrain);
    }
    vec3 p=q*shapeScale;
    float bulge=exp(-length(p*vec3(1.,1./.52,1.))*8.);
    float halo=exp(-dot(q,q)*4.)*haloStrength*.045;
    // A real oriented stellar bar, in the exact local x-long / z-short frame
    // already used by the unchanged particle generator's central bar.
    vec3 barMetric=p/vec3(.36,.055,.07);
    float stellarBar=bar*exp(-.5*dot(barMetric,barMetric))*1.6;
    #ifdef COSMIC_STRUCTURES
      bulge=exp(-length(p*vec3(1.,1./.52,1.))*14.)*.55;
      halo*=.2;
      stellarBar*=.14;
    #endif
    return tint*mix(vec3(1.),vec3(1.12,.94,.74),exp(-length(p.xz)*9.))*edge*(bulge*coreStrength+halo+stellarBar)*dustTransmission(q,dustFootprint);
  }
  #ifdef GALAXY_PORTRAIT
  // Closed line integral for the elongated association cells in the parent's
  // physical frame. Endpoints are clipped to the same support and opaque depth
  // as the base galaxy. In particular, behind-camera cells never become fog.
  uniform vec4 portraitCenters[10],portraitAxes[10];
  uniform float portraitWeights[10];
  uniform vec3 portraitTint;
  uniform vec2 portraitLight;
  // Two offset Z slices of the periodic multiscale field. A
  // physical cloud retains variation seen along the plane as well as above it.
  float portraitCloud(vec3 p,float footprint,vec2 phase){
    float z=floor(p.z),f=fract(p.z);
    vec2 uv=p.xy*.25+z*vec2(.317,.261)+phase;
    return mix(dustField(uv,footprint*.25),dustField(uv+vec2(.317,.261),footprint*.25),f*f*(3.-2.*f));
  }
  float gaussianCDF(float x){
    // Standard normal CDF, error < .0002. Symmetric saturating tails.
    float a=abs(x)*.70710678;
    return .5+.5*sign(x)*sqrt(1.-exp(-a*a*(1.2732395+.147*a*a)/(1.+.147*a*a)));
  }
  vec3 portraitEmission(vec3 origin,vec3 ray,float reach,float angularFootprint){
    float light=0.;
    for(int i=0;i<10;i++){
      vec4 node=portraitCenters[i],stroke=portraitAxes[i];
      vec3 d=origin-node.xyz,n=stroke.xyz;
      // Major and minor inverse sigmas transform the ray to an isotropic Gaussian.
      float stretch=stroke.w-node.w;
      vec3 o=d*node.w+n*(dot(d,n)*stretch),v=ray*node.w+n*(dot(ray,n)*stretch);
      float speed=length(v);vec3 unitV=v/speed;
      float peak=-dot(o,unitV);
      vec3 perpendicular=o+unitV*peak;float transverse=dot(perpendicular,perpendicular);
      if(transverse>16. || peak < -4. || peak > reach*speed+4.)continue;
      float cloudWeight=portraitLight.x;
      if(portraitLight.y>0.){
        // Patchy natal/dust emission belongs only to the gas-rich families.
        // Address the field on a bounded physical depth plane. At grazing
        // incidence the anisotropic optical maximum sweeps along the major axis.
        float t=clamp(-dot(d,ray),0.,reach);
        vec3 p=origin+ray*t;
        float cloud=portraitCloud(p*14.,angularFootprint*14.,noiseOffset);
        float detail=portraitCloud(p.yzx*49.+vec3(cloud*.95,0.,0.),angularFootprint*49.,noiseOffset.yx);
        float pockets=smoothstep(.35,.72,cloud*.65+detail*.35);
        cloudWeight+=portraitLight.y*pockets*pockets*(.30+.74*detail);
      }
      float column=2.506628/speed*exp(-.5*transverse)*(gaussianCDF(reach*speed-peak)-gaussianCDF(-peak));
      light+=portraitWeights[i]*cloudWeight*column;
    }
    return portraitTint*light;
  }
  #endif
  void main(){
    vec3 direction=normalize(localExit-localCamera);
    // Evaluate derivatives before divergent ray/support branches. This footprint
    // filters both pixel aliasing and density detail unresolved along the ray.
    float angularFootprint=max(length(dFdx(direction).xz*shapeScale.xz),length(dFdy(direction).xz*shapeScale.xz));
    #ifdef COSMIC_STRUCTURES
      // Include Y for the nebula's three planes; the stellar disk footprint
      // above retains its existing XZ contract.
      float nebulaAngularFootprint=max(length(dFdx(direction)*shapeScale),length(dFdy(direction)*shapeScale));
    #endif
    float b=dot(localCamera,direction),c=dot(localCamera,localCamera)-1.;
    float discriminant=b*b-c;if(discriminant<=0.) discard;
    float root=sqrt(discriminant),entry=max(0.,-b-root),exitDistance=-b+root;
    float physicalSpeed=length(direction*shapeScale);
    #ifdef COSMIC_STRUCTURES
      exitDistance=min(exitDistance,scenePhysicalLimit(direction)/(physicalSpeed*radius));
    #endif
    if(exitDistance<=entry) discard;
    float rayRange=exitDistance-entry;
    #ifdef COSMIC_DUST_COMPLEX
      if(structureKind>1.5){
        // Fixed64 Gauss2 hull cells. No recursive/repeated error probes.
        // Exact field at each node; finite artistic quadrature.
        vec3 boundOrigin=localCamera*shapeScale-vec3((noiseOffset.x-.5)*.45,.025,(noiseOffset.y-.5)*.45);
        vec2 dustSpan=vec2(exitDistance,entry);bool hasDust=false;
        for(int box=0;box<13;box++){
          vec2 span=nebulaBoundInterval(box,boundOrigin,direction*shapeScale,entry,exitDistance,nebulaAngularFootprint*exitDistance);
          if(span.y>span.x){dustSpan=vec2(min(dustSpan.x,span.x),max(dustSpan.y,span.y));hasDust=true;}
        }
        vec2 ionSpan=nebulaBoundInterval(13,boundOrigin,direction*shapeScale,entry,exitDistance,0.);
        bool hasIon=ionSpan.y>ionSpan.x;
        if(!hasDust&&!hasIon){gl_FragColor=vec4(0.);return;}
        // Fixed physical hull cells. Bounds may omit a proven-vacuum query,
        // but never relocate nodes when an unrelated support box enters a ray.
        float stepLength=rayRange/64.;
        vec3 color=vec3(0.);float transmission=1.;
        for(int cell=0;cell<64;cell++){
          if(transmission<.0001)break;
          float a=entry+float(cell)*stepLength,b=a+stepLength;
          bool dustPossible=hasDust&&dustSpan.x<=b&&dustSpan.y>=a;
          bool ionPossible=hasIon&&ionSpan.x<=b&&ionSpan.y>=a;
          if(!dustPossible&&!ionPossible)continue;
          for(int node=0;node<2;node++){
            float fraction=node==0?.21132486540518713:.7886751345948129;
            float distanceAlongRay=a+fraction*stepLength;
            vec4 material=nebulaDensity(localCamera+direction*distanceAlongRay,nebulaAngularFootprint*distanceAlongRay,normalize(direction*shapeScale),physicalSpeed*rayRange/192.,dustPossible);
            float visibility=1.;
            #ifndef COSMIC_SUPPORT_FADE
              float trueDistance=distanceAlongRay*physicalSpeed*radius;
              visibility=1.-smoothstep(FADE_START,FADE_FAR,trueDistance);
            #endif
            float tau=24.*material.a*visibility*physicalSpeed*stepLength*.5;
            float absorbed=tau<.001?tau*(1.-tau*(.5-tau/6.)):1.-exp(-tau);
            color+=transmission*absorbed*material.rgb*(brightness*emissionStrength);
            transmission*=exp(-tau);
          }
        }
        float alpha=1.-transmission;
        #ifdef COSMIC_SUPPORT_FADE
          color*=structureVisibility;alpha*=structureVisibility;
        #endif
        if(any(isnan(color))||any(isinf(color))||isnan(alpha)||isinf(alpha)||alpha<0.||alpha>1.00001){gl_FragColor=vec4(1.,0.,1.,1.);return;}
        gl_FragColor=alpha>0.?vec4(color/alpha,alpha):vec4(0.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        return;
      }
    #endif
    float binFootprint=length(direction.xz*shapeScale.xz)*rayRange*2./float(steps);
    vec3 emission=vec3(0.);
    if(morphology<.5||morphology>=1.5){
      for(int i=0;i<48;i++){
        if(i>=steps) break;
        vec2 node=quadrature[i];
        float distanceAlongRay=entry+node.x*rayRange;
        vec3 q=localCamera+direction*distanceAlongRay;
        float visibility=1.;
        #ifndef COSMIC_SUPPORT_FADE
          float trueDistance=distanceAlongRay*physicalSpeed*radius;
          visibility=1.-smoothstep(FADE_START,FADE_FAR,trueDistance);
        #endif
        if(visibility==0.) continue;
        float sampleFootprint=max(binFootprint,angularFootprint*distanceAlongRay);
        if(morphology>=1.5) sampleFootprint=max(sampleFootprint,physicalSpeed*rayRange*2./float(steps));
        // A dust-plane crossing is localized; ray-bin width only filters
        // stellar integration, not the transverse structure of that crossing.
        float dustFootprint=angularFootprint*distanceAlongRay;
        vec4 light=density(q,sampleFootprint,dustFootprint);
        emission+=light.rgb*light.a*visibility*physicalSpeed*rayRange*node.y;
      }
    }
    if(morphology<1.5){
      // The narrow smooth core is independent of the noisy disk. Split at its
      // metric closest point and square the integration coordinate on both
      // sides, concentrating cheap samples where the exponential changes fast.
      // This removes the synchronized equal-depth core slices without jitter.
      vec3 metric=morphology<.5?shapeScale*vec3(1.,1./.52,1.):vec3(1.);
      vec3 coreCamera=localCamera*metric,coreDirection=direction*metric;
      float center=clamp(-dot(coreCamera,coreDirection)/dot(coreDirection,coreDirection),entry,exitDistance);
      vec2 reach=vec2(center-entry,exitDistance-center);
      for(int i=0;i<24;i++){
        if(i>=steps/2) break;
        vec2 node=coreQuadrature[i];float u=node.x;
        vec2 distanceAlongRay=vec2(center)-vec2(reach.x,-reach.y)*u*u;
        vec2 visibility=vec2(1.);
        #ifndef COSMIC_SUPPORT_FADE
          visibility=1.-smoothstep(vec2(FADE_START),vec2(FADE_FAR),distanceAlongRay*physicalSpeed*radius);
        #endif
        vec3 nearCore=vec3(0.),farCore=vec3(0.);
        if(reach.x!=0.&&visibility.x!=0.) nearCore=coreEmission(localCamera+direction*distanceAlongRay.x,max(binFootprint,angularFootprint*distanceAlongRay.x),angularFootprint*distanceAlongRay.x);
        if(reach.y!=0.&&visibility.y!=0.) farCore=coreEmission(localCamera+direction*distanceAlongRay.y,max(binFootprint,angularFootprint*distanceAlongRay.y),angularFootprint*distanceAlongRay.y);
        emission+=(nearCore*reach.x*visibility.x+farCore*reach.y*visibility.y)*2.*u*node.y*physicalSpeed;
      }
    }
    #ifdef GALAXY_PORTRAIT
      // The existing smooth unresolved disk yields to points on entry. The
      // local association still has its own spatially bounded diffuse light.
      vec3 portrait=portraitEmission((localCamera+direction*entry)*shapeScale,direction*shapeScale/physicalSpeed,
        physicalSpeed*rayRange,angularFootprint*exitDistance);
      emission=emission*continuumWeight+portrait*(.62+.38*continuumWeight);
    #endif
    #ifdef COSMIC_SUPPORT_FADE
      emission*=structureVisibility;
    #endif
    // Restrained warm-white emission; no chromatic fog or time-dependent noise.
    #ifdef COSMIC_STRUCTURES
      // The same density is integrated from outside and inside the structure;
      // close-up travel resolves stars and dust instead of a complete postcard.
      #ifndef GALAXY_PORTRAIT
        emission*=continuumWeight;
      #endif
      gl_FragColor=vec4(emission*1.35*brightness*emissionStrength,1.);
    #else
      gl_FragColor=vec4(emission*2.4*brightness*emissionStrength,1.);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Shape scales remain inside the existing galaxy support radius. */
export function galaxyHazeScale(descriptor) {
  if (descriptor.morphology === 'spiral') return [1, Math.min(.28, descriptor.thickness * 3.2), 1];
  if (descriptor.morphology === 'elliptical') return [1, descriptor.thickness, .8];
  return [1, 1, 1];
}

// Twelve fixed branches are created once with the descriptor's existing
// dust-offset seed. 576 bytes of uniform scalars; no per-frame geometry work.
function nebulaBranches(offset,profile){
  const roots=[],tips=[],bends=[],phase=offset.x*6.28318530718+offset.y*2.7;
  // Six nonuniform columns share local +Z; the descriptor owns orientation.
  for(let k=0;k<6;k++){
    const root=new THREE.Vector3((k%3-1)*.31+.05*Math.sin(k*2.3+phase),(Math.floor(k/3)-.5)*.4+.04*Math.cos(k*1.7+phase),-.52+.04*Math.sin(k+phase));
    const height=.20+.26*Math.sin(k*2.1+phase);
    const tip=new THREE.Vector3(root.x+.08*Math.sin(k*1.3+phase),root.y+.05*Math.cos(k*2.7+phase),height);
    const bend=new THREE.Vector3(.04*Math.cos(k*2.2+phase),.035*Math.sin(k*1.4+phase),0);
    roots.push(new THREE.Vector4(root.x,root.y,root.z,.105+.025*Math.cos(k*1.9+phase)));
    tips.push(new THREE.Vector4(tip.x,tip.y,tip.z,.075+.025*Math.sin(k*1.3+phase)));
    bends.push(new THREE.Vector4(bend.x,bend.y,bend.z,1));
    const junction=root.clone().lerp(tip,.53).add(bend);
    const branchTip=junction.clone().add(new THREE.Vector3(.12*Math.cos(k*2.6+phase),.11*Math.sin(k*2.6+phase),.18+.08*Math.cos(k+phase)));
    roots.push(new THREE.Vector4(junction.x,junction.y,junction.z,.045));
    tips.push(new THREE.Vector4(branchTip.x,branchTip.y,branchTip.z,.032));
    bends.push(new THREE.Vector4(-bend.y*.5,bend.x*.5,0,.80));
  }
  if(profile){
    const random=randomFromSeed(`${profile.seed}:companion-filaments-v1`),phase=random()*Math.PI*2;
    for(let k=0;k<12;k++){
      const lane=Math.floor(k/2),minor=k%2,root=roots[k],tip=tips[k],bend=bends[k];
      const a=phase+(lane-2.5)*.38,width=(.022+random()*.018)*(minor?.5:1);
      if(profile.motif==='shell-fan'){
        const r=.38+random()*.28,da=.28+random()*.35;
        root.set(Math.cos(a)*r,Math.sin(a)*r*.45,Math.sin(a)*r*.7,width);
        tip.set(Math.cos(a+da)*r,Math.sin(a+da)*r*.45,Math.sin(a+da)*r*.7,width*.65);
        bend.set(.025*Math.cos(a),.01,.025*Math.sin(a),.65);
      }else if(profile.motif==='tidal-hook'){
        const x=(lane-2.5)*.13;
        root.set(-.65+x*.15,-.2+x*.25,x,width*.7);
        tip.set(.25+x*.45,.28-x*.2,.4+x*.2,width*.45);
        bend.set(.18,-.12,.05,.55+random()*.35);
      }else if(profile.motif==='split-ridge'||profile.motif==='bar-ansae'){
        const x=(lane-2.5)*.19,side=minor?1:-1;
        root.set(x,side*.045,-.1+x*x*.22,width);
        tip.set(x+.20+random()*.1,side*.035,.05+x*x*.25,width*.7);
        bend.set(.02,side*.025,.03,.8);
      }else{
        root.x*=.65+random()*.55;root.y*=.7+random()*.5;
        tip.x+=Math.cos(a)*.16;tip.y+=Math.sin(a)*.12;
        root.w*=.55+random()*.4;tip.w*=.55+random()*.4;
        bend.x+=Math.cos(a)*.06;bend.y+=Math.sin(a)*.04;
      }
    }
  }
  return{roots,tips,bends};
}

function nebulaBounds(branches){
  const lower=[],upper=[];
  for(let k=0;k<12;k++){
    const r=branches.roots[k],t=branches.tips[k],b=branches.bends[k],m=Math.max(r.w,t.w),envelope=1.+.57*(k%2===0?1.:.65);
    // Global derivative bounds for width along u∈[0,1], including both heads.
    const widthSlope=1.16*(Math.abs(t.w-r.w)+1.40625*m+4.321*t.w)+3.04*(m+.71*t.w);
    const lo=new THREE.Vector4(Infinity,Infinity,Infinity,1),hi=new THREE.Vector4(-Infinity,-Infinity,-Infinity,1);
    for(let j=0;j<=1024;j++){
      const u=j/1024,v=Math.max(0,Math.min(1,(u-.12)/.48)),h0=(u-.92)/.16,h1=(u-.70)/.10;
      const width=((r.w*(1-u)+t.w*u)*(1-.45*v*v*(3-2*v))+t.w*(.55*Math.exp(-h0*h0)+.16*Math.exp(-h1*h1)))*(1+.10*Math.sin(u*13+r.x*7)+.06*Math.sin(u*29+r.y*9));
      for(let axis=0;axis<3;axis++){
        const center=r.getComponent(axis)*(1-u)+t.getComponent(axis)*u+b.getComponent(axis)*Math.sin(Math.PI*u);
        lo.setComponent(axis,Math.min(lo.getComponent(axis),center-envelope*width));hi.setComponent(axis,Math.max(hi.getComponent(axis),center+envelope*width));
      }
    }
    for(let axis=0;axis<3;axis++){
      const margin=(Math.abs(t.getComponent(axis)-r.getComponent(axis))+Math.PI*Math.abs(b.getComponent(axis))+envelope*widthSlope)/2048+.075+.012;
      lo.setComponent(axis,lo.getComponent(axis)-margin);hi.setComponent(axis,hi.getComponent(axis)+margin);
    }
    lower.push(lo);upper.push(hi);
  }
  const bx=.62*(1+(.15*.57+.025)/.15)+.075,by=.38*(1+(.15*.57+.025)/.15)+.075,bz=.15*(1+(.15*.57+.025)/.15)+.075;
  lower.push(new THREE.Vector4(-.12-bx,.08-by,-.58-bz,.62/.15));upper.push(new THREE.Vector4(-.12+bx,.08+by,-.58+bz,.62/.15));
  lower.push(new THREE.Vector4(.05-.78,.20-.55,.20-.72,0));
  upper.push(new THREE.Vector4(.05+.78,.20+.55,.20+.72,0));
  return{lower,upper};
}

function nebulaNoiseDomains(seed){
  const random=randomFromSeed(`${seed}:nebula-shared-domain-v1`),domains=[],phases=[];
  for(let level=0;level<3;level++){
    const axes=[0,1,2];for(let a=2;a>0;a--){const b=Math.floor(random()*(a+1));[axes[a],axes[b]]=[axes[b],axes[a]];}
    const signs=[random()<.5?-1:1,random()<.5?-1:1,random()<.5?-1:1],entries=new Array(9).fill(0);
    for(let row=0;row<3;row++)entries[row*3+axes[row]]=signs[row];
    domains.push(new THREE.Matrix3().set(...entries));
    phases.push(new THREE.Vector3(Math.floor(random()*96),Math.floor(random()*96),Math.floor(random()*96)));
  }
  return{domains,phases};
}

export function createGalaxyHaze({ seed = 'lonelysky', structures = false, supportVisibility = null } = {}) {
  const group = new THREE.Group(); group.name = 'galaxy-emission-volumes';
  const geometry = new THREE.SphereGeometry(1, 40, 24);
  const dustSeed = hashSeed(`${seed}:galaxy-dust-texture-v1`);
  const nebulaSeed = Math.floor(randomFromSeed(`${seed}:nebula-shared-lattice-v1`)() * 4294967296);
  const camera = new THREE.Vector3(), inverse = new THREE.Quaternion();
  const viewProjection = new THREE.Matrix4(), viewFrustum = new THREE.Frustum(), orientationMatrix = new THREE.Matrix4();
  let descriptors = [], disposed = false;
  function createVolume() {
    // Descriptor values are installed before this slot enters the scene.
    const material = new THREE.ShaderMaterial({
      uniforms: { localCamera: { value: new THREE.Vector3() }, shapeScale: { value: new THREE.Vector3() },
        tint: { value: new THREE.Color() }, dustSeed: { value: dustSeed }, noiseOffset: { value: new THREE.Vector2() },
        radius: { value: 0 }, thickness: { value: 0 }, arms: { value: 0 }, pitch: { value: 0 }, morphology: { value: 0 },
        asymmetry: { value: 0 }, bar: { value: 0 }, brightness: { value: 1 }, steps: { value: 32 },
        quadrature: { value: integrationRules[32] }, coreQuadrature: { value: integrationRules[16] } },
      defines: { FADE_START: structures ? `${COSMIC_VIEW_FADE_START}.` : '420000.', FADE_FAR: structures ? `${COSMIC_VIEW_FAR}.` : '520000.', ...(structures ? { COSMIC_STRUCTURES: 1 } : {}), ...(supportVisibility ? { COSMIC_SUPPORT_FADE: 1 } : {}) },
      vertexShader, fragmentShader, side: THREE.BackSide, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: !structures,
    });
    if(structures){
      material.uniforms.nebulaSeed={value:nebulaSeed};
      material.uniforms.portraitCenters={value:Array.from({length:10},()=>new THREE.Vector4())};
      material.uniforms.portraitAxes={value:Array.from({length:10},()=>new THREE.Vector4())};
      material.uniforms.portraitWeights={value:new Float32Array(10)};
      material.uniforms.portraitTint={value:new THREE.Vector3()};material.uniforms.portraitLight={value:new THREE.Vector2()};
      for(const name of ['nebulaWarm','nebulaCool','nebulaAmbient','nebulaLight','nebulaMatter'])material.uniforms[name]={value:new THREE.Vector3()};
      for(const name of ['nebulaBranchRoot','nebulaBranchTip','nebulaBranchBend'])material.uniforms[name]={value:Array.from({length:12},()=>new THREE.Vector4())};
      for(const name of ['nebulaBoundsMin','nebulaBoundsMax'])material.uniforms[name]={value:Array.from({length:14},()=>new THREE.Vector4())};
      material.uniforms.nebulaNoiseDomain={value:Array.from({length:3},()=>new THREE.Matrix3())};
      material.uniforms.nebulaNoisePhase={value:Array.from({length:3},()=>new THREE.Vector3())};
    }
    if (supportVisibility) material.uniforms.structureVisibility = { value: 1 };
    if (structures) {
      material.uniforms.continuumWeight = { value: 1 };
      material.uniforms.structureKind = { value: 0 };
      material.uniforms.uVisibility = { value: 1 }; material.uniforms.uDensity = { value: 1 };
      material.uniforms.uSceneDepth = { value: null }; material.uniforms.uHasSceneDepth = { value: 0 };
      material.uniforms.uDepthResolution = { value: new THREE.Vector2(1, 1) };
      material.uniforms.uCameraNearFar = { value: new THREE.Vector2(1, 220000) };
      material.uniforms.worldOrientation = { value: new THREE.Matrix3() };
    }
    for (const name of ['armStrength', 'coreStrength', 'dustStrength', 'haloStrength', 'bridgeStrength', 'knotScale', 'youngStrength', 'emissionStrength']) material.uniforms[name] = { value: 0 };
    const mesh = new THREE.Mesh(geometry, material);
    if (structures) {
      mesh.userData.setSceneDepth = (texture, width, height, viewCamera) => {
        material.uniforms.uSceneDepth.value = texture;
        material.uniforms.uHasSceneDepth.value = texture ? 1 : 0;
        if (texture) {
          material.uniforms.uDepthResolution.value.set(width, height);
          material.uniforms.uCameraNearFar.value.set(viewCamera.near, viewCamera.far);
        }
      };
    }
    mesh.frustumCulled = false;
    return mesh;
  }
  function configureVolume(mesh, descriptor) {
    const uniforms = mesh.material.uniforms, shape = galaxyHazeScale(descriptor);
    const appearance = describeGalaxyAppearance(descriptor), detail = randomFromSeed(`${descriptor.seed}:dust-offset-v1`);
    uniforms.localCamera.value.set(0, 0, 0); uniforms.shapeScale.value.fromArray(shape);
    uniforms.tint.value.setHex(structures && descriptor.theme === 'old-gold' ? 0xc0ac8e
      : structures && descriptor.theme === 'blue-nursery' ? 0x9aaeba
      : descriptor.morphology === 'elliptical' ? 0xc7bba5 : 0xc4c2b9);
    uniforms.noiseOffset.value.set(detail(), detail());
    // Separate the large filament integrator from stellar programs. Keeping
    // its 128-node path live raises register pressure on spiral galaxy draws.
    const isComplex=structures&&descriptor.kind==='nebula';
    if(Boolean(mesh.material.defines.COSMIC_DUST_COMPLEX)!==isComplex){
      if(isComplex)mesh.material.defines.COSMIC_DUST_COMPLEX=1;else delete mesh.material.defines.COSMIC_DUST_COMPLEX;
      mesh.material.needsUpdate=true;
    }
    const hasPortrait=structures&&Boolean(descriptor.portrait);
    if(Boolean(mesh.material.defines.GALAXY_PORTRAIT)!==hasPortrait){
      if(hasPortrait)mesh.material.defines.GALAXY_PORTRAIT=1;else delete mesh.material.defines.GALAXY_PORTRAIT;
      mesh.material.needsUpdate=true;
    }
    if(hasPortrait){
      const portrait=appearance.portrait;
      for(let i=0;i<10;i++){const n=portrait.nodes[i];uniforms.portraitCenters.value[i].set(...n.center,1/n.width);uniforms.portraitAxes.value[i].set(...n.axis,1/n.long);uniforms.portraitWeights.value[i]=n.weight;}
      uniforms.portraitTint.value.fromArray(portrait.diffuseTint);uniforms.portraitLight.value.set(portrait.continuum,portrait.clouds);
    }
    if(structures&&!hasPortrait){
      for(let i=0;i<10;i++){uniforms.portraitCenters.value[i].set(0,0,0,0);uniforms.portraitAxes.value[i].set(0,0,0,0);uniforms.portraitWeights.value[i]=0;}
      uniforms.portraitTint.value.set(0,0,0);uniforms.portraitLight.value.set(0,0);
    }
    if(structures&&descriptor.kind!=='nebula'){
      for(const name of ['nebulaWarm','nebulaCool','nebulaAmbient','nebulaLight','nebulaMatter'])uniforms[name].value.set(0,0,0);
      for(const name of ['nebulaBranchRoot','nebulaBranchTip','nebulaBranchBend','nebulaBoundsMin','nebulaBoundsMax'])for(const v of uniforms[name].value)v.set(0,0,0,0);
      for(const v of uniforms.nebulaNoiseDomain.value)v.identity();
      for(const v of uniforms.nebulaNoisePhase.value)v.set(0,0,0);
    }
    mesh.material.blending=structures&&descriptor.kind==='nebula'?THREE.NormalBlending:THREE.AdditiveBlending;
      if(structures&&descriptor.kind==='nebula'){
        const profile=descriptor.childAppearance;
        const branches=nebulaBranches(uniforms.noiseOffset.value,profile);
        uniforms.nebulaWarm.value.fromArray(profile?.warm??[1,.52,.18]);
        uniforms.nebulaCool.value.fromArray(profile?.cool??[.10,.32,.60]);
        uniforms.nebulaAmbient.value.fromArray(profile?.ambient??[.008,.004,.002]);
        uniforms.nebulaLight.value.fromArray(profile?.light??[.15,-.45,.72]);
        uniforms.nebulaMatter.value.set(profile?.dust??1,profile?.wall??1,profile?.ion??1);
        for(let i=0;i<12;i++){uniforms.nebulaBranchRoot.value[i].copy(branches.roots[i]);uniforms.nebulaBranchTip.value[i].copy(branches.tips[i]);uniforms.nebulaBranchBend.value[i].copy(branches.bends[i]);}
        const domains=nebulaNoiseDomains(descriptor.seed);
        for(let i=0;i<3;i++){uniforms.nebulaNoiseDomain.value[i].copy(domains.domains[i]);uniforms.nebulaNoisePhase.value[i].copy(domains.phases[i]);}
        const bounds=nebulaBounds(branches);for(let i=0;i<14;i++){uniforms.nebulaBoundsMin.value[i].copy(bounds.lower[i]);uniforms.nebulaBoundsMax.value[i].copy(bounds.upper[i]);}
      }

    if(descriptor.childAppearance&&descriptor.kind==='cluster')uniforms.tint.value.multiply(new THREE.Color(...descriptor.stellarTint));

    uniforms.radius.value = descriptor.radius; uniforms.thickness.value = descriptor.thickness;
    uniforms.arms.value = descriptor.arms; uniforms.pitch.value = descriptor.pitch;
    uniforms.morphology.value = descriptor.morphology === 'spiral' ? 0 : descriptor.morphology === 'elliptical' ? 1 : 2;
    uniforms.asymmetry.value = descriptor.asymmetry; uniforms.bar.value = Number(descriptor.bar);
    uniforms.brightness.value = 1; uniforms.steps.value = 32;
    uniforms.quadrature.value = integrationRules[32]; uniforms.coreQuadrature.value = integrationRules[16];
    if (supportVisibility) uniforms.structureVisibility.value = 1;
    mesh.name = descriptor.id; mesh.position.set(0, 0, 0); mesh.visible = true;
    mesh.rotation.order = 'XYZ'; mesh.rotation.fromArray(descriptor.orientation);
    mesh.scale.copy(uniforms.shapeScale.value).multiplyScalar(descriptor.radius);
    if (structures) {
      uniforms.continuumWeight.value = 1;
      uniforms.structureKind.value = descriptor.kind === 'nebula' ? 2 : descriptor.kind === 'cluster' ? 1 : 0;
      uniforms.uVisibility.value = uniforms.uDensity.value = 1;
      mesh.userData.setSceneDepth(null);
      uniforms.uDepthResolution.value.set(1, 1); uniforms.uCameraNearFar.value.set(1, 220000);
      uniforms.worldOrientation.value.setFromMatrix4(orientationMatrix.makeRotationFromEuler(mesh.rotation));
    }
    for (const name of ['armStrength', 'coreStrength', 'dustStrength', 'haloStrength', 'bridgeStrength', 'knotScale', 'youngStrength', 'emissionStrength']) uniforms[name].value = appearance[name];
    mesh.userData.appearance = appearance;
  }
  group.userData.setDescriptors = (next) => {
    if (disposed) return;
    // Keep current material/program owners across a catalogue handoff. Slots
    // follow catalogue order, not identity; custom providers may change an ID.
    // There is no spare pool: removed slots release their materials immediately.
    while (group.children.length > next.length) {
      const mesh = group.children[group.children.length - 1];
      mesh.removeFromParent(); mesh.material.dispose();
    }
    for (let i = 0; i < next.length; i++) {
      const mesh = group.children[i] ?? createVolume();
      configureVolume(mesh, next[i]);
      if (mesh.parent !== group) group.add(mesh);
    }
    descriptors = next;
  };
  group.userData.update = ({ centers, cameraPosition, camera: viewCamera, quality, brightness, home }) => {
    if (disposed) return 0;
    camera.fromArray(cameraPosition); let visible = 0;
    const cullToView = structures && viewCamera?.isPerspectiveCamera === true;
    if (cullToView) {
      viewCamera.updateWorldMatrix(true, false);
      viewProjection.multiplyMatrices(viewCamera.projectionMatrix, viewCamera.matrixWorldInverse);
      viewFrustum.setFromProjectionMatrix(viewProjection);
      group.updateWorldMatrix(true, false);
    }
    for (let i = 0; i < group.children.length; i++) {
      const mesh = group.children[i];
      mesh.position.fromArray(centers[i]);
      const distance = mesh.position.distanceTo(camera);
      mesh.visible = !home && (supportVisibility ? supportVisibility[i] > 0 : distance - descriptors[i].radius < (structures ? COSMIC_VIEW_FAR : 520000));
      if (mesh.visible && cullToView) {
        // All proxy vertices lie in the unit sphere. Transform its support
        // into the same world space as the planes, including parent scale,
        // rotation and shear, without allocating a per-frame bounding object.
        mesh.updateWorldMatrix(false, false);
        const e = mesh.matrixWorld.elements;
        // Radial depth compression preserves directions, not physical z.
        // Only the four viewport sides apply; true-space near/far planes do not.
        for (let side = 0; side < 4; side++) {
          const plane = viewFrustum.planes[side], n = plane.normal;
          const supportRadius = Math.hypot(n.x * e[0] + n.y * e[1] + n.z * e[2],
            n.x * e[4] + n.y * e[5] + n.z * e[6], n.x * e[8] + n.y * e[9] + n.z * e[10]);
          const centerDistance = n.x * e[12] + n.y * e[13] + n.z * e[14] + plane.constant;
          const tolerance = 64 * Number.EPSILON * (Math.abs(e[12]) + Math.abs(e[13])
            + Math.abs(e[14]) + Math.abs(plane.constant) + supportRadius + 1);
          if (centerDistance < -supportRadius - tolerance) {
            mesh.visible = false;
            break;
          }
        }
      }
      if (supportVisibility) mesh.material.uniforms.structureVisibility.value = supportVisibility[i];
      if (structures) {
        mesh.material.uniforms.uVisibility.value = Number(mesh.visible);
        // A statistical stellar continuum is appropriate at exterior scales.
        // Resolve it into the unchanged 3D tracers on entry, retaining only
        // low-density nearby dust instead of a screen-filling luminous fog.
        mesh.material.uniforms.continuumWeight.value = descriptors[i].kind==='nebula'?1:.004 + .996 * THREE.MathUtils.smoothstep(distance / descriptors[i].radius, .6, 1.8);
      }
      if (!mesh.visible) continue;
      inverse.copy(mesh.quaternion).invert();
      mesh.material.uniforms.localCamera.value.copy(camera).sub(mesh.position).applyQuaternion(inverse).divide(mesh.scale);
      const steps = quality === 'low' ? 16 : quality === 'high' ? 48 : 32;
      mesh.material.uniforms.steps.value = steps;
      mesh.material.uniforms.quadrature.value = integrationRules[steps];
      mesh.material.uniforms.coreQuadrature.value = integrationRules[steps / 2];
      mesh.material.uniforms.brightness.value = brightness;
      visible++;
    }
    return visible;
  };
  group.userData.dispose = () => {
    if (disposed) return; disposed = true;
    for (const mesh of group.children) mesh.material.dispose();
    geometry.dispose(); group.clear(); descriptors = []; supportVisibility = null;
  };
  return group;
}
