/** Exterior ring alloy. All relief here changes the material normal only;
 * the catalogue solids continue to own silhouettes, shadows and collisions.
 * The broad reflected sky is a fixed artistic lighting environment, not a
 * sampled scene or an additional physical light-transport simulation.
 */
export const RING_ENGINEERING_MATERIAL_GLSL = /* glsl */`
// Integral of smoothstep(0,1,x). It permits a box-filtered bevel value and
// slope from the same height profile, including subpixel fabrication edges.
float engineeringStepIntegral(float x){
  float t=clamp(x,0.,1.);
  return t*t*t*(1.-.5*t)+max(x-1.,0.);
}
float engineeringPlateProfile(float x,float span,float bevel){
  return smoothstep(0.,bevel,x)-smoothstep(span-bevel,span,x);
}
float engineeringPlateIntegral(float x,float span,float bevel){
  return bevel*(engineeringStepIntegral(x/bevel)-engineeringStepIntegral((x-span+bevel)/bevel));
}
vec2 engineeringPlateBevel(float x,float span,float bevel,float footprint){
  float halfPixel=footprint*.5;
  // Both edges have the same profile. Measure from the nearer one so a
  // narrow groove never relies on subtracting two kilometre-scale values.
  float direction=x<=span*.5?1.:-1.;
  x=min(x,span-x);
  if(x+halfPixel<=0.)return vec2(0.);
  if(x-halfPixel>=bevel)return vec2(1.,0.);
  float value=(engineeringPlateIntegral(x+halfPixel,span,bevel)
    -engineeringPlateIntegral(x-halfPixel,span,bevel))/footprint;
  float slope=(engineeringPlateProfile(x+halfPixel,span,bevel)
    -engineeringPlateProfile(x-halfPixel,span,bevel))/footprint;
  return vec2(clamp(value,0.,1.),slope*direction);
}
float engineeringInterval(float x,float center,float width,float footprint){
  return max(0.,min(x+footprint*.5,center+width*.5)-max(x-footprint*.5,center-width*.5))/footprint;
}
float engineeringPatch(vec2 point,vec2 center,vec2 size,vec2 footprint){
  return engineeringInterval(point.x,center.x,size.x,footprint.x)
    *engineeringInterval(point.y,center.y,size.y,footprint.y);
}
vec4 engineeringFinePartition(vec2 point,vec2 size,vec3 id,out float path){
  vec2 low=vec2(0.),high=size;path=1.;
  for(int depth=0;depth<4;depth++){
    if(depth==3&&bodyHash(id+vec3(61.,17.,73.))<.22)break;
    vec2 span=high-low;
    float h=bodyHash(id+vec3(path*13.,float(depth)*19.,53.));
    float cutFraction=.3+.4*bodyHash(id+vec3(path*29.,7.,float(depth)*41.));
    if(span.x/span.y>mix(.67,1.6,h)){
      float cut=mix(low.x,high.x,cutFraction);
      if(point.x<cut){high.x=cut;path*=2.;}else{low.x=cut;path=path*2.+1.;}
    }else{
      float cut=mix(low.y,high.y,cutFraction);
      if(point.y<cut){high.y=cut;path*=2.;}else{low.y=cut;path=path*2.+1.;}
    }
  }
  return vec4(low,high);
}
vec3 engineeringEnvironment(vec3 reflected,float roughness){
  // Fixed body-frame directions: reflection moves optically with the viewer,
  // while neither the environment nor any surface field follows the camera.
  float sky=.5+.5*dot(reflected,normalize(vec3(-.38,.76,.53)));
  float key=pow(max(dot(reflected,uLight),0.),mix(22.,3.,roughness));
  return mix(vec3(.004,.008,.016),vec3(.08,.12,.18),sky*sky)
    +vec3(.147971)*key*(1.-roughness*.55);
}
float engineeringDisc(float radius,float limit,float footprint){
  return 1.-smoothstep(limit-footprint*.5,limit+footprint*.5,radius);
}
vec3 engineeringSurface(vec3 point,vec3 geometricNormal,vec3 ray,float distance){
  float radius=length(point.xz),angle=atan(point.z,point.x);
  vec3 radial=vec3(point.x,0.,point.z)/radius,tangent=vec3(-radial.z,0.,radial.x);
  vec3 world=point*uBodyRadius;
  vec3 dx=dFdx(world),dy=dFdy(world);
  float pixelMetres=max(distance*uPixelAngle*uBodyRadius,.001);
  float footprint=max(pixelMetres,max(length(dx),length(dy)));
  // An integer number of bays closes exactly around the reference circle.
  // Wrapped IDs and analytic arc derivatives avoid the atan +/-pi seam.
  float bayCount=max(1.,floor(BODY_TAU*uBodyRadius/16000.+.5));
  float bayWidth=BODY_TAU*uBodyRadius/bayCount;
  float arc=(angle/BODY_TAU+.5)*bayCount;
  vec2 metres=vec2(arc*bayWidth,world.y);
  vec3 axisU=tangent,axisV=vec3(0.,1.,0.);
  float uMetric=1./radius,faceSeed=0.;
  if(abs(geometricNormal.y)>.5){
    metres.y=(radius-1.)*uBodyRadius;axisV=radial;faceSeed=11.;
  }else if(abs(dot(geometricNormal,radial))<.5){
    metres.x=(radius-1.)*uBodyRadius;axisU=radial;uMetric=1.;
    faceSeed=23.+floor(arc);
  }
  vec2 filterSize=max(vec2(pixelMetres),vec2(
    (abs(dot(dx,axisU))+abs(dot(dy,axisU)))*uMetric,
    abs(dot(dx,axisV))+abs(dot(dy,axisV))));
  // Structural service courts cross the smaller fabrication grid. Their
  // phase closes on the same circumference as the bays.
  float courseCount=max(1.,floor(bayCount*.25+.5));
  float courseWidth=BODY_TAU*uBodyRadius/courseCount;
  float course=floor(metres.x/courseWidth);
  vec2 courtPoint=vec2(metres.x-course*courseWidth,metres.y);
  vec3 courseId=vec3(mod(course,courseCount),uPhase+faceSeed,149.);
  float courtRandom=bodyHash(courseId);
  vec2 courtCenter=vec2(courseWidth*(.34+.29*courtRandom),mix(-12500.,12500.,bodyHash(courseId+31.)));
  vec2 courtSize=vec2(courseWidth*(.32+.22*bodyHash(courseId+67.)),4200.+6900.*courtRandom);
  float courseResolved=1.-smoothstep(.24,.9,max(filterSize.x/courseWidth,filterSize.y/12000.));
  float courtOuter=0.,courtInset=0.,serviceRim=0.,serviceFace=0.,lockShoes=0.,serviceCover=0.;
  vec2 courtSlope=vec2(0.);
  if(courseResolved>0.&&faceSeed<23.){
    courtOuter=engineeringPatch(courtPoint,courtCenter,courtSize,filterSize);
    vec2 insetSize=courtSize-vec2(1400.,730.);
    vec2 insetLocal=courtPoint-courtCenter+.5*insetSize;
    vec2 insetU=engineeringPlateBevel(insetLocal.x,insetSize.x,470.,filterSize.x);
    vec2 insetV=engineeringPlateBevel(insetLocal.y,insetSize.y,300.,filterSize.y);
    courtInset=insetU.x*insetV.x;
    courtSlope=-140.*vec2(insetU.y*insetV.x,insetV.y*insetU.x);
    // Some courts enclose a radial access collar, with nested dark and light
    // bands that read before the smaller panels or the lamp clusters resolve.
    if(courtRandom>.48){
      vec2 serviceOffset=courtPoint-courtCenter-vec2((courtRandom-.72)*courtSize.x,0.);
      float serviceRadius=length(serviceOffset);
      float collarRadius=courtSize.y*.39;
      float serviceFilter=max(filterSize.x,filterSize.y);
      float collarResolved=courseResolved*(1.-smoothstep(.2,.8,serviceFilter/collarRadius));
      if(collarResolved>0.&&serviceRadius<collarRadius+serviceFilter*.5){
        float collarOuter=engineeringDisc(serviceRadius,collarRadius,serviceFilter);
        serviceCover=collarOuter*collarResolved;
        vec2 rim=engineeringPlateBevel(serviceRadius-.77*collarRadius,.23*collarRadius,
          .045*collarRadius,serviceFilter);
        vec2 boss=engineeringPlateBevel(serviceRadius+collarRadius,1.25*collarRadius,
          .08*collarRadius,serviceFilter);
        serviceRim=(rim.x+.58*boss.x)*collarResolved;
        serviceFace=max(0.,collarOuter-rim.x-boss.x)*collarResolved;
        courtSlope+=serviceOffset/max(serviceRadius,1.)*collarRadius*
          (.051*rim.y+.082*boss.y)*collarResolved;
        // Tapered locking shoes sit between the central cap and the outer
        // ring. Their radial ramp catches the same light as the access well.
        if(serviceRadius>.28*collarRadius&&serviceRadius<.84*collarRadius){
          float teeth=16.+2.*floor(courtRandom*5.);
          float angle=atan(serviceOffset.y,serviceOffset.x);
          float pitch=BODY_TAU*serviceRadius/teeth;
          float tooth=(fract(angle*teeth/BODY_TAU+courtRandom)-.5)*pitch;
          float width=pitch*mix(.28,.61,smoothstep(.32,.78,serviceRadius/collarRadius));
          float lug=engineeringInterval(tooth,0.,width,serviceFilter);
          vec2 ramp=engineeringPlateBevel(serviceRadius-.31*collarRadius,.48*collarRadius,
            .080*collarRadius,serviceFilter);
          float clear=collarResolved*(1.-smoothstep(.2,.75,serviceFilter/pitch));
          lockShoes=lug*ramp.x*clear;
          courtSlope+=serviceOffset/serviceRadius*(collarRadius*.11)*ramp.y*lug*clear;
        }
      }
    }
  }
  float recess=courseResolved*courtInset;
  float collar=max(0.,courtOuter-courtInset)*courseResolved;
  // The exposed curved side of each catalogue flange carries a pale rub rail.
  // Box filtering holds its energy as the rim recedes toward the far arc.
  float lip=0.;
  if(faceSeed==0.&&uSectionCount>=5){
    float lipWidth=min(280.,(uSections[3].w-uSections[3].z)*uBodyRadius*.36);
    float upperLip=uSections[3].w*uBodyRadius-lipWidth*.63;
    float lowerLip=uSections[4].z*uBodyRadius+lipWidth*.63;
    lip=max(engineeringInterval(world.y,upperLip,lipWidth,filterSize.y),
      engineeringInterval(world.y,lowerLip,lipWidth,filterSize.y));
  }
  vec2 baySize=vec2(bayWidth,9000.);
  float column=floor(metres.x/bayWidth),wrappedColumn=mod(column,bayCount);
  // Stagger whole bays; no horizontal line continues around the ring.
  float stagger=bodyHash(vec3(wrappedColumn,uPhase+faceSeed,91.))*baySize.y;
  vec2 bayPosition=vec2(metres.x-column*bayWidth,metres.y+stagger);
  float row=floor(bayPosition.y/baySize.y);
  bayPosition.y-=row*baySize.y;
  vec3 bayId=vec3(wrappedColumn,row,uPhase+faceSeed);
  float bayRandom=bodyHash(bayId+vec3(17.,31.,7.));
  // Follow one branch of a deterministic BSP. Three or four unequal splits
  // yield plates with varied aspect ratios and interrupted engineering seams.
  vec2 low=vec2(0.),high=baySize;
  float path=1.;
  for(int depth=0;depth<4;depth++){
    if(depth==3&&bayRandom<.38)break;
    vec2 span=high-low;
    float h=bodyHash(bayId+vec3(path*13.,float(depth)*19.,53.));
    bool alongU=span.x/span.y>mix(.64,1.65,h);
    float division=.31+.38*bodyHash(bayId+vec3(path*29.,7.,float(depth)*41.));
    if(alongU){
      float cut=mix(low.x,high.x,division);
      if(bayPosition.x<cut){high.x=cut;path*=2.;}
      else{low.x=cut;path=path*2.+1.;}
    }else{
      float cut=mix(low.y,high.y,division);
      if(bayPosition.y<cut){high.y=cut;path*=2.;}
      else{low.y=cut;path=path*2.+1.;}
    }
  }
  vec2 plateSize=high-low,local=bayPosition-low;
  float plateRandom=bodyHash(bayId+vec3(path*17.,71.,31.));
  float bayResolved=1.-smoothstep(.25,1.1,max(filterSize.x/baySize.x,filterSize.y/baySize.y));
  float plateResolved=bayResolved*(1.-smoothstep(.18,.85,max(filterSize.x/plateSize.x,filterSize.y/plateSize.y)));
  float alloyVariation=mix(.5,plateRandom,plateResolved);
  // Rounded, shallow material relief, in world units. Its convolved derivative
  // tends to zero when the plate is unresolved, rather than sparkling normals.
  float bevel=14.+plateRandom*25.;
  vec2 edgeU=engineeringPlateBevel(local.x,plateSize.x,bevel,filterSize.x);
  vec2 edgeV=engineeringPlateBevel(local.y,plateSize.y,bevel,filterSize.y);
  float plateTop=edgeU.x*edgeV.x;
  float averageTop=(1.-bevel/plateSize.x)*(1.-bevel/plateSize.y);
  plateTop=mix(.975,mix(averageTop,plateTop,plateResolved),bayResolved);
  float height=3.+plateRandom*4.;
  vec3 gradient=(axisU*edgeU.y*edgeV.x*uMetric+axisV*edgeV.y*edgeU.x)*height*plateResolved
    +(axisU*courtSlope.x*uMetric+axisV*courtSlope.y)*courseResolved;
  // Selected large plates carry recessed equipment racks. Their louvers
  // occupy the scale between a structural bay and the access plates.
  float rack=0.,louver=0.;
  float conduit=0.,clampFace=0.;
  float manifoldWell=0.,pipeMetal=0.,unionMetal=0.,inspectionLight=0.;
  if(plateResolved>0.){
    // A cable trough follows the plate, then offsets around the access bay.
    // A pair of rails and occasional clamps also identify unlit armor.
    float runLength=plateSize.x*(.66+.19*bayRandom);
    float u=local.x-plateSize.x*(.06+.05*plateRandom);
    float bend=u-runLength*(.34+.20*plateRandom);
    float diagonal=.31*sign(bayRandom-.5);
    float track=local.y-plateSize.y*mix(.22,.73,bayRandom)
      -diagonal*clamp(bend,0.,runLength*.14);
    float slope=bend>0.&&bend<runLength*.14?diagonal:0.;
    float acrossPixel=filterSize.y+abs(slope)*filterSize.x;
    float width=min(44.+38.*plateRandom,plateSize.y*.085);
    float run=engineeringInterval(u,.5*runLength,runLength,filterSize.x)*plateResolved;
    vec2 bed=engineeringPlateBevel(track+width*.5,width,width*.23,acrossPixel);
    vec2 rail=engineeringPlateBevel(abs(track)-width*.16,width*.11,width*.045,acrossPixel);
    float pitch=runLength/max(2.,floor(runLength/(225.+187.*bayRandom)));
    float tie=engineeringInterval((fract(u/pitch+.5)-.5)*pitch,0.,width*.44,filterSize.x);
    float clip=engineeringInterval(track,0.,width*1.21,acrossPixel)*tie;
    conduit=bed.x*run;
    clampFace=run*(rail.x+.85*clip);
    gradient+=(axisV-axisU*slope*uMetric)*run*width*
      (-.22*bed.y+.065*rail.y*sign(track));
  }
  if(bayResolved>0.){
    // A bay services several plates. Two unequal pipes run through a
    // recessed chase, interrupted by paired expansion collars and supports.
    // Keep the layout in bay coordinates so the runs cross the plate seams.
    float coursePitch=1050.+410.*bayRandom;
    float chaseRow=floor(bayPosition.y/coursePitch);
    float install=bodyHash(bayId+vec3(113.,chaseRow*19.,37.));
    float y=bayPosition.y-(chaseRow+.5)*coursePitch;
    float halfChase=coursePitch*(.073+.037*install);
    // Pipes run on both the armor and the floor of a service court. Only the
    // raised rim and the moving cover must stay clear.
    float reach=(1.-smoothstep(.25,.85,filterSize.y/halfChase))*bayResolved*(1.-max(collar,serviceCover));
    float offset=bodyHash(bayId+vec3(29.,chaseRow*23.,167.));
    float halfLength=bayWidth*(.11+.28*offset);
    float center=halfLength+(bayWidth-2.*halfLength)*mix(.12,.88,install);
    float along=bayPosition.x-center;
    if(install>.50&&abs(y)<halfChase+.5*filterSize.y&&abs(along)<halfLength+.5*filterSize.x&&reach>0.){
      float ends=engineeringInterval(along,0.,2.*halfLength,filterSize.x)*reach;
      vec2 trench=engineeringPlateBevel(y+halfChase,2.*halfChase,halfChase*.19,filterSize.y);
      manifoldWell=ends*trench.x;
      float pitch=coursePitch*(.56+.31*install);
      float joint=(fract(along/pitch+.5)-.5)*pitch;
      float support=engineeringInterval(joint,0.,pitch*.17,filterSize.x);
      float rib=engineeringInterval(abs(joint),pitch*.062,pitch*.034,filterSize.x);
      float lower=step(y,-.16*halfChase);
      float pipeRadius=halfChase*mix(.39,.23,lower);
      float across=y-halfChase*mix(.28,-.54,lower);
      vec2 shell=engineeringPlateBevel(across+pipeRadius,2.*pipeRadius,pipeRadius,filterSize.y);
      pipeMetal=ends*shell.x;
      unionMetal=manifoldWell*(.28*support+rib*shell.x);
      gradient+=axisV*ends*(pipeRadius*.83*shell.y-halfChase*.27*trench.y);
      // Both pipe ends enter a common header under the cover. It projects
      // just far enough beyond the pipes to make the attachment legible.
      vec2 header=engineeringPlateBevel(halfLength-abs(along),2.2*halfChase,.23*halfChase,filterSize.x);
      pipeMetal*=1.-header.x;
      unionMetal+=manifoldWell*header.x*.69;
      gradient-=axisU*sign(along)*uMetric*(halfChase*.26)*header.y*manifoldWell;
      float terminal=engineeringInterval(joint,pitch*.18,pitch*.071,filterSize.x);
      inspectionLight=ends*terminal*engineeringInterval(y,-.88*halfChase,halfChase*.088,filterSize.y)
        *step(.66,install);
    }
  }
  if(plateResolved>0.&&plateRandom>.49){
    vec2 rackSize=plateSize*vec2(.51,.21);
    vec2 rackLocal=local-plateSize*vec2(.20,.32);
    vec2 rackU=engineeringPlateBevel(rackLocal.x,rackSize.x,38.,filterSize.x);
    vec2 rackV=engineeringPlateBevel(rackLocal.y,rackSize.y,35.,filterSize.y);
    rack=rackU.x*rackV.x*plateResolved;
    gradient-=24.*plateResolved*(axisU*rackU.y*rackV.x*uMetric+axisV*rackV.y*rackU.x);
    float pitch=rackSize.x/7.;
    float slot=rackLocal.x/pitch-rackLocal.y*.28/pitch;
    float cover=engineeringInterval((fract(slot+.5)-.5)*pitch,0.,pitch*.32,filterSize.x+.28*filterSize.y);
    louver=rack*mix(cover,.32,smoothstep(.23,.74,(filterSize.x+.28*filterSize.y)/pitch));
  }
  // Craft-scale fabrication is distinct from kilometre-scale structural bays.
  // Use the bay's fixed chord frame before taking small remainders: reducing
  // a multi-million-unit arc coordinate directly would lose narrow grooves to
  // float precision. This frame is body-fixed and periodic with wrapped bay IDs.
  vec2 fineTileSize=vec2(bayWidth/128.,96.);
  float fineCoverage=.935,wornRim=.025,socketMask=.0025,socketCollar=.0015;
  float fineEmission=.00005,polishing=.5,finishGain=1.;
  // Each projected axis footprint is bounded below by pixelMetres. The
  // close-up field has already reached these same means beyond this limit.
  if(bayResolved>0.&&pixelMetres<min(fineTileSize.x,fineTileSize.y)*1.1){
    float middleAngle=(wrappedColumn+.5)/bayCount*BODY_TAU-3.14159265359;
    vec3 middleRadial=vec3(cos(middleAngle),0.,sin(middleAngle));
    vec3 fineAxisU=vec3(-middleRadial.z,0.,middleRadial.x);
    float fineU=dot(world-middleRadial*uBodyRadius,fineAxisU)+bayWidth*.5;
    if(faceSeed>=23.){fineU=metres.x;fineAxisU=axisU;}
    float fineColumn=floor(fineU/fineTileSize.x);
    float fineStagger=bodyHash(bayId+vec3(fineColumn,83.,11.))*fineTileSize.y;
    vec2 finePoint=vec2(fineU-fineColumn*fineTileSize.x,metres.y+fineStagger);
    float fineRow=floor(finePoint.y/fineTileSize.y);
    finePoint.y-=fineRow*fineTileSize.y;
    vec3 fineId=bayId+vec3(fineColumn*131.,fineRow*137.,157.);
    float finePath;
    vec4 fineBounds=engineeringFinePartition(finePoint,fineTileSize,fineId,finePath);
    vec2 fineSpan=fineBounds.zw-fineBounds.xy,fineLocal=finePoint-fineBounds.xy;
    vec2 fineFilter=max(vec2(pixelMetres),vec2(
      abs(dot(dx,fineAxisU))+abs(dot(dy,fineAxisU)),
      abs(dot(dx,axisV))+abs(dot(dy,axisV))));
    float fineTileResolved=bayResolved*(1.-smoothstep(.2,1.1,max(fineFilter.x/fineTileSize.x,fineFilter.y/fineTileSize.y)));
    float fineResolved=fineTileResolved*(1.-smoothstep(.15,.8,max(fineFilter.x/fineSpan.x,fineFilter.y/fineSpan.y)));
    float fineRandom=bodyHash(fineId+vec3(finePath*17.,31.,47.));
    // Panels are replaced in batches. A few bright or soot-dark batches make
    // the fabrication scale legible from the ship, even on unlit stretches.
    float batch=bodyHash(fineId+vec3(7.,59.,83.));
    finishGain+=fineTileResolved*(batch-.5)*.49+fineResolved*(fineRandom-.5)*.46;
    // Unequal 8--65-unit access plates: 0.3--0.5-unit half-grooves and a rounded
    // 0.25--0.6-unit shoulder. The 0.06--0.14-unit relief only changes shading.
    float fineGap=.3+.2*fineRandom,fineBevel=.25+.35*fineRandom;
    vec2 fineUProfile=engineeringPlateBevel(fineLocal.x-fineGap,fineSpan.x-2.*fineGap,fineBevel,fineFilter.x);
    vec2 fineVProfile=engineeringPlateBevel(fineLocal.y-fineGap,fineSpan.y-2.*fineGap,fineBevel,fineFilter.y);
    float fineTop=fineUProfile.x*fineVProfile.x;
    float fineTopMean=(1.-(2.*fineGap+fineBevel)/fineSpan.x)*(1.-(2.*fineGap+fineBevel)/fineSpan.y);
    fineCoverage=mix(.935,mix(fineTopMean,fineTop,fineResolved),fineTileResolved);
    gradient+=(fineAxisU*fineUProfile.y*fineVProfile.x+axisV*fineVProfile.y*fineUProfile.x)
      *(.06+.08*fineRandom)*fineResolved;
    // Broader shoulders minus plate tops form a worn metal rim, following the
    // actual filtered plate edge rather than painting uncorrelated noise flecks.
    vec2 wearU=engineeringPlateBevel(fineLocal.x-fineGap,fineSpan.x-2.*fineGap,fineBevel+.5,fineFilter.x);
    vec2 wearV=engineeringPlateBevel(fineLocal.y-fineGap,fineSpan.y-2.*fineGap,fineBevel+.5,fineFilter.y);
    float wearMean=fineTopMean-(1.-(2.*fineGap+fineBevel+.5)/fineSpan.x)*(1.-(2.*fineGap+fineBevel+.5)/fineSpan.y);
    wornRim=mix(.025,mix(wearMean,max(0.,fineTop-wearU.x*wearV.x),fineResolved),fineTileResolved);
    // Recessed service sockets sit inside selected plates. Rectangular collars,
    // dark inserts and the recess gradient share one position and world scale.
    float socketPopulation=step(.88,bodyHash(fineId+vec3(finePath*37.,67.,13.)));
    vec2 socketSize=vec2(1.8+fineRandom*3.5,.75+fineRandom*1.2);
    if(bodyHash(fineId+vec3(finePath,19.,61.))>.5)socketSize=socketSize.yx;
    vec2 socketCenter=fineSpan*vec2(.25+.5*bodyHash(fineId+vec3(finePath,17.,23.)),
      .25+.5*bodyHash(fineId+vec3(finePath,43.,89.)));
    vec2 socketU=engineeringPlateBevel(fineLocal.x-socketCenter.x+socketSize.x*.5,socketSize.x,.2,fineFilter.x);
    vec2 socketV=engineeringPlateBevel(fineLocal.y-socketCenter.y+socketSize.y*.5,socketSize.y,.2,fineFilter.y);
    float socketInterior=socketU.x*socketV.x;
    float socketMean=(socketSize.x-.2)*(socketSize.y-.2)/(fineSpan.x*fineSpan.y);
    socketMask=mix(.0025,mix(socketMean*.35,socketInterior*socketPopulation,fineResolved),fineTileResolved);
    gradient-=(fineAxisU*socketU.y*socketV.x+axisV*socketV.y*socketU.x)*.22*socketPopulation*fineResolved;
    float socketOuter=engineeringPatch(fineLocal,socketCenter,socketSize+vec2(.52),fineFilter);
    socketCollar=mix(.0015,max(0.,socketOuter-socketInterior)*socketPopulation,fineResolved);
    float fineLampPopulation=step(.91,bodyHash(fineId+vec3(finePath*53.,7.,101.)));
    vec2 fineLampSize=vec2(.3+.2*fineRandom,1.+fineRandom*.8);
    float fineLamp=engineeringPatch(fineLocal,socketCenter+socketSize*vec2(.65,-.63),fineLampSize,fineFilter)
      +engineeringPatch(fineLocal,socketCenter+socketSize*vec2(.92,-.12),fineLampSize*vec2(.6,.42),fineFilter);
    float fineLampMean=.09*fineLampSize.x*fineLampSize.y*1.252/(fineSpan.x*fineSpan.y);
    fineEmission=mix(.00005,mix(fineLampMean,fineLamp*fineLampPopulation,fineResolved),fineTileResolved);
    // An occupied maintenance deck lights a few adjacent ports on the same
    // recessed strip. Resolve the ports individually as the pilot closes.
    if(batch>.60&&fineRandom>.59&&fineResolved>0.){
      vec2 deck=vec2(fineSpan.x*.46,fineSpan.y*.17);
      vec2 offset=fineLocal-fineSpan*vec2(.53,.32);
      float tray=engineeringPatch(offset,vec2(0.),deck,fineFilter)*fineResolved;
      finishGain-=.36*tray;
      float pitch=deck.x/3.;
      float port=engineeringInterval((fract(offset.x/pitch+.5)-.5)*pitch,0.,pitch*.34,fineFilter.x);
      float ports=mix(port,.34,smoothstep(.25,.74,fineFilter.x/pitch));
      fineEmission+=tray*ports*engineeringInterval(offset.y,-.17*deck.y,deck.y*.34,fineFilter.y)*.48;
    }
    polishing=mix(.5,fineRandom,fineResolved);
  }
  vec3 seed=uPhase*vec3(19013.,7301.,11027.);
  vec4 patina=ringWorldField(world+seed,180.,footprint,false);
  vec4 grain=ringWorldField(world+seed+vec3(73.,19.,37.),.8,footprint,false);
  vec3 scratchStretch=vec3(.018,1.,.018);
  vec4 scratches=ringWorldField(world*scratchStretch+seed,1.8,footprint,false);
  gradient+=grain.yzw*.003+scratches.yzw*scratchStretch*.008;
  gradient-=geometricNormal*dot(gradient,geometricNormal);
  vec3 normal=normalize(geometricNormal-gradient);
  // A charcoal substrate carries individual darker plates, sunk courts and
  // exposed metal on their edges. The rough finish keeps grazing sky color.
  vec3 base=vec3(.19,.201,.216)*mix(.79,1.24,alloyVariation)*finishGain;
  base*=.91+patina.x*.18;
  base*=.60+.40*plateTop;
  base*=.65+.35*fineCoverage;
  base*=1.+wornRim*.6+socketCollar*.4;
  base*=1.-.52*recess;
  base*=1.-.49*rack;
  base+=vec3(.052,.058,.063)*louver;
  base*=1.-.55*conduit;
  base+=vec3(.11,.123,.131)*clampFace;
  base=mix(base,vec3(.19,.205,.220),collar*.54);
  base=mix(base,vec3(.091,.095,.10),serviceFace*.77);
  base=mix(base,vec3(.33,.32,.29),serviceRim*.82);
  base=mix(base,vec3(.39,.365,.318),lockShoes*.86);
  base=mix(base,vec3(.024,.029,.033),socketMask*.9);
  base=mix(base,vec3(.049,.054,.061),manifoldWell*.85);
  base=mix(base,mix(vec3(.25,.272,.291),vec3(.36,.318,.255),bayRandom),pipeMetal);
  base=mix(base,vec3(.38,.38,.37),min(1.,unionMetal));
  base=mix(base,vec3(.41,.465,.54),lip*.89);
  float roughness=clamp(.36+polishing*.21+alloyVariation*.06+(patina.x-.5)*.025
    +(grain.x-.5)*.018+(scratches.x-.5)*.015-wornRim*.12+socketMask*.19
    +recess*.09-lip*.12-serviceRim*.13-pipeMetal*.12,.28,.72);
  // Weathered protective coating leaves a diffuse response beside exposed
  // metal. A uniformly bare alloy only reveals the sun at a narrow glint and
  // otherwise loses the ring's actual stepped volume against the black sky.
  float metalness=.55-socketMask*.2;
  vec3 f0=mix(vec3(.04),base,metalness);
  vec3 view=-ray;
  float nv=max(dot(normal,view),.0001),nl=max(dot(normal,uLight),0.);
  vec3 halfVector=view+uLight;
  float halfSquared=dot(halfVector,halfVector);
  vec3 specular=vec3(0.),fresnel=f0;
  if(halfSquared>1.e-12){
    vec3 halfDirection=halfVector*inversesqrt(halfSquared);
    float nh=max(dot(normal,halfDirection),0.),vh=max(dot(view,halfDirection),0.);
    float alpha=roughness*roughness,a2=alpha*alpha;
    float denominator=nh*nh*(a2-1.)+1.;
    float distribution=a2/(3.14159265359*denominator*denominator);
    float smithV=2.*nv/(nv+sqrt(a2+(1.-a2)*nv*nv));
    float smithL=2.*nl/max(nl+sqrt(a2+(1.-a2)*nl*nl),.0001);
    fresnel=f0+(1.-f0)*pow(1.-vh,5.);
    specular=distribution*smithV*smithL*fresnel/max(4.*nv*nl,.0001);
  }
  float direct=ringDirectLight(point,geometricNormal,normal);
  vec3 diffuse=(1.-fresnel)*(1.-metalness)*base/3.14159265359;
  // The former RGB key had CIE Y=2.54808. Keep that intensity and the
  // unchanged body light direction, without tinting every alloy face orange.
  vec3 color=(diffuse+specular)*vec3(2.54808)*direct;
  vec3 environment=engineeringEnvironment(reflect(ray,normal),roughness);
  vec3 grazing=f0+(1.-f0)*pow(1.-nv,5.);
  color+=environment*mix(grazing,f0,roughness*.65)*(.88-.25*roughness);
  // Broad, body-fixed environmental fill gives the dusk faces a readable
  // value. It shares the coating and relief normal with the direct response,
  // so recessed panels stay dark and the attached flanges catch more light.
  float reflectedFill=.17+.22*(.5+.5*dot(normal,vec3(.364,-.861,.356)));
  color+=base*(1.-metalness)*vec3(1.,.99,.98)*reflectedFill;
  color+=lip*vec3(.014,.018,.026)*(1.-.43*nv);
  // Only occupied plates have a lamp cluster. Each combines two uneven
  // groups of small light strips, with a few cooler marker groups among them.
  float clusterRandom=bodyHash(bayId+vec3(path*43.,29.,97.));
  float lampCoverage=.00038;
  vec3 lampColor=vec3(1.96,1.48,1.05);
  if(plateResolved>0.){
    vec2 lampSize=vec2(28.+plateRandom*83.,16.+bayRandom*29.);
    vec2 clusterSize=lampSize*vec2(5.2,4.1);
    float annex=step(.81,clusterRandom);
    float localMean=.28*lampSize.x*lampSize.y*3.49/(plateSize.x*plateSize.y);
    float lamps=0.;
    if(clusterRandom>.72){
      vec2 center=plateSize*vec2(.24+.48*bodyHash(bayId+vec3(path,5.,13.)),
        .24+.48*bodyHash(bayId+vec3(path,79.,3.)));
      if(plateRandom>.49)center=plateSize*vec2(.23+.43*bayRandom,.55);
      vec2 offset=local-center;
      if(all(lessThan(abs(offset),clusterSize+filterSize*.5))){
        lamps=engineeringPatch(offset,vec2(0.),lampSize,filterSize)
          +engineeringPatch(offset,lampSize*vec2(1.71,-.12),lampSize*vec2(1.2,.83),filterSize)
          +engineeringPatch(offset,lampSize*vec2(3.25,.15),lampSize*vec2(.72,.75),filterSize)
          +annex*(engineeringPatch(offset,lampSize*vec2(-1.83,2.4),lampSize*vec2(1.3,.8),filterSize)
          +engineeringPatch(offset,lampSize*vec2(-.35,2.62),lampSize*vec2(.56,.65),filterSize));
      }
    }
    lampCoverage=mix(lampCoverage,mix(localMean,lamps,plateResolved),bayResolved);
    lampColor=mix(lampColor,vec3(.74,1.58,2.12),step(.937,clusterRandom)*plateResolved);
  }
  color+=(lampColor*lampCoverage+vec3(2.2,.98,.28)*fineEmission)*(1.-manifoldWell)
    +vec3(1.20,.68,.28)*inspectionLight;
  return color;
}
`;
