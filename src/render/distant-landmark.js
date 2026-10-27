import * as THREE from 'three';

// Analytic cylinder/rim intersections resolve a finite-width solid ribbon.
// Shared with the black-hole sky, rather than a camera-following line or image.
export const LANDMARK_INTERSECTIONS_GLSL = /* glsl */`
uniform float uLandmarkVisibility,uLandmarkHalfWidth,uLandmarkThickness,uLandmarkPhase,uLandmarkBroken;
uniform int uLandmarkKind;
uniform bool uLandmarkRinged;
uniform vec3 uLandmarkCenter,uLandmarkLight,uLandmarkTint;
uniform mat3 uLandmarkFrame;
bool ringIntersection(vec3 direction,out vec3 point,out vec3 normal,out float coverage) {
  point=vec3(0.);normal=vec3(0.);coverage=0.;
  if(uLandmarkVisibility<=0.)return false;
  vec3 origin=-uLandmarkFrame*uLandmarkCenter,ray=uLandmarkFrame*direction;
  float planar=dot(ray.xz,ray.xz);
  float along=dot(origin.xz,ray.xz),nearest=1e10;
  if(planar>.0000001)for(int wall=0;wall<2;wall++){
    float radius=wall==0?1.-uLandmarkThickness:1.+uLandmarkThickness;
    float discriminant=along*along-planar*(dot(origin.xz,origin.xz)-radius*radius);
    if(discriminant<0.)continue;
    float root=sqrt(max(discriminant,0.));
    for(int side=0;side<2;side++){
      float distance=(-along+(side==0?-root:root))/planar;
      vec3 hit=origin+ray*distance;
      float aa=max(fwidth(hit.y),.000025);
      float alpha=1.-smoothstep(uLandmarkHalfWidth-aa,uLandmarkHalfWidth+aa,abs(hit.y));
      if(distance>.0001&&distance<nearest&&alpha>.001){
        nearest=distance;point=hit;coverage=alpha;
        normal=normalize(vec3(hit.x,0.,hit.z))*(wall==0?-1.:1.);
      }
    }
  }
  // Narrow metallic end rims close the ribbon when viewed nearly along it.
  if(abs(ray.y)>.000001)for(int side=0;side<2;side++){
    float distance=((side==0?-1.:1.)*uLandmarkHalfWidth-origin.y)/ray.y;
    vec3 hit=origin+ray*distance;float radial=length(hit.xz);
    float aa=max(fwidth(radial),.000025);
    float alpha=1.-smoothstep(uLandmarkThickness-aa,uLandmarkThickness+aa,abs(radial-1.));
    if(distance>.0001&&distance<nearest&&alpha>.001){nearest=distance;point=hit;coverage=alpha;normal=vec3(0.,side==0?-1.:1.,0.);}
  }
  if(coverage<=0.)return false;
  vec2 radial=normalize(point.xz);
  float gap=dot(radial,vec2(cos(uLandmarkPhase),sin(uLandmarkPhase)));
  coverage*=1.-uLandmarkBroken*smoothstep(.943,.952,gap);
  return coverage>0.;
}
bool giantIntersection(vec3 direction,out vec3 point,out float distance,out float coverage){
  vec3 origin=-uLandmarkFrame*uLandmarkCenter,ray=uLandmarkFrame*direction;
  float along=dot(origin,ray),perpendicular=length(cross(origin,ray));
  float aa=max(fwidth(perpendicular),.00001);
  coverage=1.-smoothstep(1.-aa,1.+aa,perpendicular);
  distance=-along-sqrt(max(1.-perpendicular*perpendicular,0.));
  point=origin+ray*max(distance,0.);
  if(distance<=0.)coverage=0.;
  return coverage>0.;
}
float giantRingIntersection(vec3 direction,out vec3 hit,out float distance){
  hit=vec3(0.);distance=0.;
  vec3 origin=-uLandmarkFrame*uLandmarkCenter,ray=uLandmarkFrame*direction;
  if(!uLandmarkRinged||abs(ray.y)<.000001)return 0.;
  distance=-origin.y/ray.y;hit=origin+ray*distance;float radius=length(hit.xz);
  float edge=max(fwidth(radius),.00004);
  float annulus=smoothstep(1.25-edge,1.25+edge,radius)*(1.-smoothstep(2.1-edge,2.1+edge,radius));
  float spacing=radius*330.;float bandFilter=1.-smoothstep(.3,1.2,fwidth(spacing));
  float bands=.65+.2*sin(spacing)*bandFilter;
  float gap=1.-.8*exp(-pow((radius-1.65)/.025,2.));
  return distance>0.?annulus*bands*gap*.85:0.;
}`;

// Requires the shared skyNoise() field declared by deep-sky.js.
export const DISTANT_LANDMARK_GLSL = LANDMARK_INTERSECTIONS_GLSL + /* glsl */`
vec4 ringRadiance(vec3 direction) {
  vec3 point,normal;float coverage;
  if(!ringIntersection(direction,point,normal,coverage))return vec4(0.);
  vec2 radial=normalize(point.xz);
  float angle=atan(radial.y,radial.x);
  float angularDx=dFdx(angle),angularDy=dFdy(angle);
  angularDx-=floor(angularDx/6.28318530718+.5)*6.28318530718;
  angularDy-=floor(angularDy/6.28318530718+.5)*6.28318530718;
  float resolved=1.-smoothstep(.25,1.1,max(abs(angularDx),abs(angularDy))*720.);
  float panel=mix(.55,.3+.7*smoothstep(.05,.16,abs(sin(angle*720.))),resolved);
  float land=skyNoise(vec3(radial.x*170.,point.y*600.,radial.y*170.)+uLandmarkPhase);
  float clouds=skyNoise(vec3(radial.x*85.,point.y*240.,radial.y*85.)+13.);
  float inner=step(dot(normal,vec3(point.x,0.,point.z)),0.);
  vec3 ground=mix(vec3(.08,.16,.2),vec3(.24,.29,.19),smoothstep(.35,.68,land));
  ground=mix(ground,vec3(.5,.53,.5),smoothstep(.68,.85,clouds)*.3);
  vec3 steel=uLandmarkTint*(.18+panel*.22);
  vec3 albedo=mix(steel,ground,inner);
  float edge=smoothstep(.7,.94,abs(point.y)/uLandmarkHalfWidth);
  albedo=mix(albedo,uLandmarkTint*(.55+panel*.2),edge);
  float diffuse=max(dot(normal,normalize(uLandmarkLight)),0.);
  vec3 color=albedo*(.018+diffuse*1.65);
  // A quiet sunlit lip, not an emissive neon outline around the whole ring.
  color+=uLandmarkTint*edge*pow(diffuse,3.)*.045;
  return vec4(color,coverage*uLandmarkVisibility);
}
vec4 giantRadiance(vec3 direction) {
  vec3 origin=-uLandmarkFrame*uLandmarkCenter,ray=uLandmarkFrame*direction;
  float distance,coverage;vec3 point,color=vec3(0.);
  if(giantIntersection(direction,point,distance,coverage)){
    vec3 n=normalize(point);
    float broad=skyNoise(n*7.+uLandmarkPhase);
    float fine=skyNoise(n*vec3(47.,190.,47.)+broad*2.);
    float diffuse=max(dot(n,normalize(uLandmarkLight)),0.);
    float facing=clamp(dot(n,-ray),0.,1.);
    if(uLandmarkKind==4){
      float convection=skyNoise(n*11.+uLandmarkPhase);
      float granules=skyNoise(n*27.+uLandmarkPhase)*.48+skyNoise(n*67.+uLandmarkPhase)*.32+skyNoise(n*153.+uLandmarkPhase)*.2;
      float grain=smoothstep(.23,.77,granules);
      color=uLandmarkTint*(.5+convection*.26+grain*.9)*(.42+.58*pow(facing,.34));
    }else{
      vec3 albedo;
      if(uLandmarkKind==2){
        float belt=.5+.5*sin(n.y*55.+broad*6.);
        albedo=mix(uLandmarkTint*.4,uLandmarkTint*1.05,belt*.65+fine*.25);
        // Irregular circulation belongs to the fixed body, never the camera.
        vec3 storm=normalize(vec3(sin(uLandmarkPhase),.23,cos(uLandmarkPhase)));
        float vortex=exp(-(1.-dot(n,storm))*140.);
        albedo=mix(albedo,uLandmarkTint*.33,vortex*.65);
      }else{
        albedo=uLandmarkTint*(.08+fine*.04+broad*.08);
      }
      color=albedo*(.006+pow(diffuse,.8)*1.1);
      float atmosphere=pow(1.-facing,5.)*diffuse;
      color+=uLandmarkTint*atmosphere*(uLandmarkKind==3?.035:.12);
    }
  }else coverage=0.;
  if(uLandmarkRinged){
    float t;vec3 hit;float alpha=giantRingIntersection(direction,hit,t);
    if(alpha>0.&&(coverage<=0.||t<distance)){
      float lit=.05+.65*abs(normalize(uLandmarkLight).y);
      // The same sphere blocks sunlight on the far side of its ring plane.
      vec3 light=normalize(uLandmarkLight);float shadowAlong=dot(-hit,light);
      float shadow=shadowAlong>0.?1.-smoothstep(.9,1.02,length(cross(hit,light))):0.;
      vec3 ring=uLandmarkTint*.55*lit*(1.-shadow*.95);
      float combined=alpha+coverage*(1.-alpha);
      color=(ring*alpha+color*coverage*(1.-alpha))/max(combined,.000001);coverage=combined;
    }
  }
  return vec4(color,coverage*uLandmarkVisibility);
}
vec4 distantLandmarkRadiance(vec3 direction){
  if(uLandmarkVisibility<=0.)return vec4(0.);
  return uLandmarkKind==1?ringRadiance(direction):giantRadiance(direction);
}`;

// Point stars represent the unresolved sky population. The exact same solid
// intersections suppress them behind the landmark, including a ring's breach.
export const DISTANT_LANDMARK_OCCLUSION_GLSL = LANDMARK_INTERSECTIONS_GLSL + /* glsl */`
float landmarkStarTransmission(vec3 direction){
  if(uLandmarkVisibility<=0.)return 1.;
  vec3 point,normal;float distance,coverage;
  if(uLandmarkKind==1)ringIntersection(direction,point,normal,coverage);
  else {
    giantIntersection(direction,point,distance,coverage);
    float ringAlpha=giantRingIntersection(direction,point,distance);
    coverage+=ringAlpha*(1.-coverage);
  }
  return 1.-coverage*uLandmarkVisibility;
}`;

export function distantLandmarkUniforms() {
  return {uLandmarkVisibility:{value:0},uLandmarkKind:{value:0},uLandmarkRinged:{value:false},uLandmarkCenter:{value:new THREE.Vector3()},uLandmarkFrame:{value:new THREE.Matrix3()},
    uLandmarkHalfWidth:{value:.02},uLandmarkThickness:{value:.0015},uLandmarkPhase:{value:0},uLandmarkBroken:{value:0},
    uLandmarkLight:{value:new THREE.Vector3(-.5,.6,.4).normalize()},uLandmarkTint:{value:new THREE.Color(.5,.58,.6)}};
}
export function setDistantLandmark(uniforms, ring) {
  uniforms.uLandmarkVisibility.value=ring?.visibility??0;
  if(!ring)return;
  uniforms.uLandmarkKind.value={'ring':1,'gas-giant':2,'dark-world':3,'stellar-giant':4}[ring.kind];
  uniforms.uLandmarkRinged.value=ring.ringed??false;
  uniforms.uLandmarkCenter.value.fromArray(ring.center).divideScalar(ring.radius);
  uniforms.uLandmarkFrame.value.fromArray(ring.frame);
  uniforms.uLandmarkHalfWidth.value=ring.halfWidth;
  uniforms.uLandmarkThickness.value=ring.thickness;
  uniforms.uLandmarkPhase.value=ring.phase;
  uniforms.uLandmarkBroken.value=Number(ring.broken);
  uniforms.uLandmarkLight.value.fromArray(ring.light);
  uniforms.uLandmarkTint.value.fromArray(ring.tint);
}
