import * as THREE from 'three';
import {hashSeed} from '../random.js';
import {RING_HABITAT_RIVER_BANK_DISTANCE} from '../ring-habitat-field.js';
import {sampleRingHabitatTop as sampleTop} from '../ring-habitat-sampling.js';
import {createRingHabitatLatticeWorkspace,clearRingHabitatLatticeWorkspace,sampleCanonicalTop} from '../ring-habitat-regions.js';
import {RING_HABITAT_SHADOW_GLSL,createRingHabitatShadowUniforms} from './ring-habitat-shadow-receiver.js';

const CAPACITY=4096,PITCH=48,TILE_CELLS=10,RANGE=1536,MAX_HEIGHT=40,TAU=Math.PI*2;
const JITTER=.46;
const COMPANION_FADE_START=240,COMPANION_FADE_END=320,COMPANION_OFFSET=18;
export const RING_HABITAT_VEGETATION_PREPARE_RADIUS_L=RANGE+TILE_CELLS*PITCH+COMPANION_OFFSET;
// A 48-unit near tile bounds camera displacement by sqrt(2)*24. Its disk
// includes the complete 320-unit fade plus the 18-unit companion root offset.
// For producer terrain: inner>=97,266 and spacing>=47.9981. Counting lattice
// centres whose jitter boxes intersect these disks gives <=3324 primary cells
// and <=241 companion stands: even three per stand total <=4047 of 4096.
// The companions are fixed named-seed trees; this tile only selects already
// invisible distant candidates, never relocates a root. Main 480-unit tiles stay.

// At a tile corner the camera is sqrt(2)*240 from the generation centre.
// Reserve the entire tree height, a jitter envelope and another half cell for
// surface interpolation/curvature, then round DOWN. Every changing disk-edge
// instance is therefore fully faded before the tile's fixed buffer changes.
const FADE_END=Math.floor((RANGE-Math.SQRT2*(TILE_CELLS*PITCH*.5+PITCH*JITTER)-MAX_HEIGHT-PITCH*.5)/100)*100;
const FADE_START=FADE_END-300;
const MIDDLE_PIXEL_START=36,MIDDLE_PIXEL_END=64,HIGH_PIXEL_START=140,HIGH_PIXEL_END=220;
const HIGH_DISTANCE_START=140,HIGH_DISTANCE_END=240;
// Both visible foliage and its shadow use this exact alpha decision. Maps are
// borrowed from the caller; the alpha atlas stores opacity in its red channel.
export const RING_HABITAT_FOLIAGE_GLSL=/* glsl */`
#ifdef HABITAT_FOLIAGE_MAP
uniform bool uHasHabitatFoliage;
uniform sampler2D uHabitatFoliageColor,uHabitatFoliageAlpha;
uniform vec4 uHabitatFoliageUV;
vec2 habitatFoliageTexcoord(vec3 uv){return mix(uHabitatFoliageUV.xy,uHabitatFoliageUV.zw,uv.xy);}
bool habitatFoliageMask(vec3 uv){
  if(!uHasHabitatFoliage||uv.z<.5)return true;
  return texture(uHabitatFoliageAlpha,habitatFoliageTexcoord(uv)).r>=.30;
}
#else
bool habitatFoliageMask(vec3 uv){return true;}
#endif
`;
// Shared verbatim by the lit and vegetation-shadow passes. Return only a
// root-relative offset, so the shadow owner can subtract its origin first.
export const RING_HABITAT_TREE_TRANSFORM_GLSL=/* glsl */`
vec2 habitatTreeProfile(vec4 shape){
  float kind=floor(shape.w*3.);
  return kind<.5?vec2(.80,-.08):kind<1.5?vec2(1.18,-.15):vec2(.88,.12);
}
vec3 habitatTreeOffset(vec3 position,vec3 root,vec4 shape){
  vec3 up=-normalize(vec3(root.x,0.,root.z));
  vec3 right=normalize(cross(vec3(0.,1.,0.),up)),forward=cross(right,up);
  vec2 profile=habitatTreeProfile(shape);
  float angle=shape.z+(shape.w-.5)*1.8*position.y;
  float c=cos(angle),s=sin(angle),scale=(profile.x+profile.y*position.y)*shape.y;
  vec2 radial=mat2(c,s,-s,c)*position.xz*scale;
  float phase=shape.w*6.28318530718,lean=.014+.025*shape.w;
  radial+=vec2(sin(position.y*1.7+phase)-sin(phase),sin(position.y*2.3+phase*.61)-sin(phase*.61))*lean;
  return (right*radial.x+up*position.y+forward*radial.y)*shape.x;
}
vec3 habitatTreeNormal(vec3 normal,vec3 position,vec3 root,vec4 shape){
  vec3 up=-normalize(vec3(root.x,0.,root.z));
  vec3 right=normalize(cross(vec3(0.,1.,0.),up)),forward=cross(right,up);
  vec2 profile=habitatTreeProfile(shape);
  float k=(shape.w-.5)*1.8,angle=shape.z+k*position.y,c=cos(angle),s=sin(angle);
  mat2 rotation=mat2(c,s,-s,c);
  float scale=(profile.x+profile.y*position.y)*shape.y;
  vec2 radialNormal=rotation*normal.xz/scale;
  vec2 derivative=rotation*(position.xz*(profile.y*shape.y)+vec2(-position.z,position.x)*(k*scale));
  float phase=shape.w*6.28318530718,lean=.014+.025*shape.w;
  derivative+=vec2(1.7*cos(position.y*1.7+phase),2.3*cos(position.y*2.3+phase*.61))*lean;
  float verticalNormal=normal.y-dot(radialNormal,derivative);
  return normalize(right*radialNormal.x+up*verticalNormal+forward*radialNormal.y);
}
`;
const VERTEX=/* glsl */`
in vec3 iRoot,iGroundNormal,iShadowRoot;
in vec4 iShape;
in float treePart;
in vec3 iShadowCoverage;
in vec3 geometricNormal;
in vec3 treeUV;
uniform mat3 uBodyToWorld,uViewRotation;
uniform vec3 uBodyCenter,uLight,uCameraLocal;

out vec3 vNormal;
out vec3 vBodyPoint,vShadowRelative,vGeometricNormal;
out vec3 vTreePoint;
out vec3 vTreeUV;
out vec3 vViewDirection;
out float vAge;
out float vPart,vVariation,vCoverage,vHeight,vGroundLight;
out vec2 vLodInterval;
${RING_HABITAT_TREE_TRANSFORM_GLSL}
void main(){
  vec3 localVertex=habitatTreeOffset(position,iRoot,iShape);
  vec3 rootRelative=uBodyToWorld*iRoot+uBodyCenter;
  vec3 relative=rootRelative+uBodyToWorld*localVertex;
  vCoverage=iShadowCoverage.x;vLodInterval=iShadowCoverage.yz;
  vNormal=habitatTreeNormal(normal,position,iRoot,iShape);
  vGeometricNormal=habitatTreeNormal(geometricNormal,position,iRoot,iShape);
  vBodyPoint=iRoot+localVertex;
  vShadowRelative=iShadowRoot+localVertex;
  vViewDirection=(uCameraLocal-iRoot)-localVertex;
  vTreePoint=position*iShape.x;vAge=(iShape.x-20.)/20.;
  vTreeUV=treeUV;

  vPart=treePart;vVariation=iShape.w;vHeight=position.y;
  vGroundLight=.7+.3*max(dot(iGroundNormal,uLight),0.);
  // Physical scene units, with camera rotation only. No camera-following scale
  // or distant-body depth compression is used inside this bounded near field.
  gl_Position=projectionMatrix*vec4(uViewRotation*relative,1.);
}`;
const FRAGMENT=/* glsl */`
precision highp float;
uniform vec3 uLight,uFoliage;
in vec3 vNormal;
in vec3 vBodyPoint,vShadowRelative,vGeometricNormal;
in vec3 vTreePoint;
in vec3 vTreeUV;
in vec3 vViewDirection;
in float vAge;
in float vPart,vVariation,vCoverage,vHeight,vGroundLight;
in vec2 vLodInterval;
out vec4 vegetationColor;
#define gl_FragColor vegetationColor
${RING_HABITAT_SHADOW_GLSL}
${RING_HABITAT_FOLIAGE_GLSL}
void main(){
  // Screen-door coverage lets the existing canopy material take over at the
  // pixel/distance limit without scaling trees into large distant substitutes.
  float threshold=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  if(vCoverage<=threshold)discard;
  float lodSample=fract(sin(dot(gl_FragCoord.xy,vec2(39.346,11.135)))*47453.5453);
  if(lodSample<vLodInterval.x||lodSample>=vLodInterval.y)discard;
  if(!habitatFoliageMask(vTreeUV))discard;
  float visibility=uVegetationShadowTriangleAware>.5?habitatVegetationVisibilityRelative(vShadowRelative,normalize(vGeometricNormal))
    :habitatVegetationVisibility(vBodyPoint,normalize(vGeometricNormal));
  vec3 normal=normalize(vNormal);
  float ndl=max(dot(normal,uLight),0.),light=ndl*visibility;
  vec3 foliage=uFoliage*mix(vec3(.98,1.05,.86),vec3(.88,.94,1.02),vAge)
    *(.94+vVariation*.10)*(.93+vHeight*.08);
  #ifdef HABITAT_FOLIAGE_MAP
  if(uHasHabitatFoliage&&vTreeUV.z>.5){
    vec3 photograph=texture(uHabitatFoliageColor,habitatFoliageTexcoord(vTreeUV)).rgb;
    float luminance=dot(photograph,vec3(.2126,.7152,.0722));
    vec3 tint=clamp(photograph/(luminance+.04),vec3(.65),vec3(1.35));
    foliage*=mix(vec3(1.),tint,.40)*(.82+.36*smoothstep(.015,.22,luminance));
  }
  #endif
  // Longitudinal bark flutes and fine cross grain use tree-local scene units.
  // Filter their amplitude before they become subpixel, with no bitmap or
  // camera-relative material field. Needle sprays stay low contrast.
  float theta=dot(vTreePoint.xz,vTreePoint.xz)>1.e-8?atan(vTreePoint.z,vTreePoint.x):0.;
  float barkPhase=theta*13.+sin(vTreePoint.y*.65)*1.2;
  float bark=.5+.5*cos(barkPhase)*(1.-smoothstep(.4,1.4,fwidth(barkPhase)));
  float grainPhase=vTreePoint.y*5.7+theta*3.;
  float grain=sin(grainPhase)*(1.-smoothstep(.4,1.4,fwidth(grainPhase)));
  vec3 barkColor=mix(vec3(.067,.057,.043),vec3(.125,.111,.083),bark)*(.98+grain*.045);
  vec3 albedo=mix(barkColor,foliage,vPart);
  vec3 ambient=vec3(.17,.215,.24)*vGroundLight;
  // Restrained rough dielectric sheen, plus a small needle back-light term;
  // both consume the same actual shadow visibility as diffuse illumination.
  vec3 color=albedo*(ambient+vec3(1.06,1.02,.94)*light);
  vec3 view=normalize(vViewDirection),halfVector=view+uLight;
  float halfSquared=dot(halfVector,halfVector);
  if(halfSquared>1.e-10){
    vec3 halfDirection=halfVector*inversesqrt(halfSquared);
    float nv=max(dot(normal,view),.001),nh=max(dot(normal,halfDirection),0.),vh=max(dot(view,halfDirection),0.);
    float roughness=mix(.82,.65,vPart),alpha=roughness*roughness,a2=alpha*alpha;
    float denominator=nh*nh*(a2-1.)+1.,distribution=a2/(3.14159265359*denominator*denominator);
    float smithV=2.*nv/(nv+sqrt(a2+(1.-a2)*nv*nv));
    float smithL=2.*ndl/max(ndl+sqrt(a2+(1.-a2)*ndl*ndl),.001);
    float fresnel=.025+.975*pow(1.-vh,5.);
    color+=vec3(.87,.91,.82)*distribution*smithV*smithL*fresnel/max(4.*nv*ndl,.001)*light;
  }
  color+=foliage*max(dot(-normal,uLight),0.)*visibility*vPart*.055;
  vegetationColor=vec4(color,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function cellHash(x,y,seed,salt){
  let h=Math.imul(x^seed,0x9e3779b1)^Math.imul(y^salt,0x85ebca6b);
  h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);
  return ((h^(h>>>16))>>>0)/4294967296;
}

function standNoise(x,y,z,seed){
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);
  let fx=x-ix,fy=y-iy,fz=z-iz;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);fz=fz*fz*(3-2*fz);
  const z0=Math.imul(iz,0x68bc21eb),z1=Math.imul(iz+1,0x68bc21eb);
  const a=cellHash(ix,iy,seed,z0),b=cellHash(ix+1,iy,seed,z0),c=cellHash(ix,iy+1,seed,z0),d=cellHash(ix+1,iy+1,seed,z0);
  const e=cellHash(ix,iy,seed,z1),f=cellHash(ix+1,iy,seed,z1),g=cellHash(ix,iy+1,seed,z1),h=cellHash(ix+1,iy+1,seed,z1);
  const low=(a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy,high=(e+(f-e)*fx)*(1-fy)+(g+(h-g)*fx)*fy;
  return low+(high-low)*fz;
}
/** Continuous decorative stand density in body-local scene units. */
export function ringHabitatStandProbability(x,y,z,density,seed){
  const value=standNoise(x/400,y/400,z/400,seed^0x53a7)*.76+standNoise(x/180,y/180,z/180,seed^0x317b)*.24;
  const t=Math.max(0,Math.min(1,(value-.35)/.30)),contrast=t*t*(3-2*t)*2-1;
  // Symmetric contrast changes spatial grouping, preserving the recipe's
  // expected population. It never lowers view range, capacity or tree count
  // as a performance measure; real terrain/rock eligibility remains separate.
  return density+Math.min(density,1-density)*contrast;
}

function createTreeGeometry(detail,instances,foliageAspect){
  const positions=[],normals=[],geometricNormals=[],parts=[],uvs=[];
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),normal=new THREE.Vector3();
  const axis=new THREE.Vector3(),right=new THREE.Vector3(),forward=new THREE.Vector3(),reference=new THREE.Vector3();
  const triangle=(ax,ay,az,bx,by,bz,cx,cy,cz,part)=>{
    a.set(ax,ay,az);b.set(bx,by,bz);c.set(cx,cy,cz);
    normal.crossVectors(ab.subVectors(b,a),ac.subVectors(c,a)).normalize();
    positions.push(ax,ay,az,bx,by,bz,cx,cy,cz);
    for(let i=0;i<3;i++){normals.push(normal.x,normal.y,normal.z);geometricNormals.push(normal.x,normal.y,normal.z);parts.push(part);uvs.push(0,0,0);}
  };
  const frame=(dx,dy,dz)=>{
    axis.set(dx,dy,dz).normalize();reference.set(Math.abs(axis.y)>.9?1:0,Math.abs(axis.y)>.9?0:1,0);
    right.crossVectors(axis,reference).normalize();forward.crossVectors(right,axis);
  };
  const limb=(ax,ay,az,bx,by,bz,radius,tipRadius,sides)=>{
    frame(bx-ax,by-ay,bz-az);const ring=new Float64Array(sides*6);
    for(let i=0;i<sides;i++){
      const angle=i*TAU/sides,x=right.x*Math.cos(angle)+forward.x*Math.sin(angle),y=right.y*Math.cos(angle)+forward.y*Math.sin(angle),z=right.z*Math.cos(angle)+forward.z*Math.sin(angle);
      const j=i*6;ring[j]=ax+x*radius;ring[j+1]=ay+y*radius;ring[j+2]=az+z*radius;
      ring[j+3]=bx+x*tipRadius;ring[j+4]=by+y*tipRadius;ring[j+5]=bz+z*tipRadius;
    }
    for(let i=0;i<sides;i++){
      const j=i*6,k=((i+1)%sides)*6;
      triangle(ring[j],ring[j+1],ring[j+2],ring[j+3],ring[j+4],ring[j+5],ring[k+3],ring[k+4],ring[k+5],0);
      triangle(ring[j],ring[j+1],ring[j+2],ring[k+3],ring[k+4],ring[k+5],ring[k],ring[k+1],ring[k+2],0);
      triangle(ax,ay,az,ring[j],ring[j+1],ring[j+2],ring[k],ring[k+1],ring[k+2],0);
      triangle(bx,by,bz,ring[k+3],ring[k+4],ring[k+5],ring[j+3],ring[j+4],ring[j+5],0);
    }
  };
  const crownMass=(rings,sectors,scale)=>{
    // Far silhouettes retain a complete, irregular 3D envelope. Closer LODs
    // use a smaller continuous core under their overlapping needle sprays.
    const heights=rings===9?[.18,.27,.37,.48,.59,.70,.80,.89,.96]:rings===7?[.18,.30,.44,.58,.72,.86,.96]:[.20,.35,.50,.66,.82,.96];
    const radii=rings===9?[.11,.205,.195,.17,.148,.113,.085,.055,.018]:rings===7?[.11,.205,.185,.15,.11,.065,.018]:[.13,.20,.16,.125,.08,.015];
    const vertices=[],faces=[];
    for(let ring=0;ring<rings;ring++)for(let sector=0;sector<sectors;sector++){
      const angle=sector*TAU/sectors+ring*.173;
      const irregular=detail===0?.82+.30*cellHash(Math.floor(ring*.5),sector,0x43a17,31)+.14*Math.sin(angle*3.+ring*.7):.90+.20*cellHash(ring,sector,0x43a17,31)+.10*Math.sin(angle*3.+ring*.7);
      const radius=radii[ring]*scale*irregular;
      const y=heights[ring]+(cellHash(ring,sector,0x43a17,53)-.5)*(detail===0?.045:.024);
      vertices.push([Math.cos(angle)*radius+Math.sin(ring*1.31)*scale*.008,y,Math.sin(angle)*radius+Math.cos(ring*.83)*scale*.008]);
    }
    const bottom=vertices.length;vertices.push([0,heights[0]-.025,0]);
    const top=vertices.length;vertices.push([0,detail===0?1.:.985,0]);
    for(let ring=0;ring<rings-1;ring++)for(let sector=0;sector<sectors;sector++){
      const next=(sector+1)%sectors,a=ring*sectors+sector,b=(ring+1)*sectors+sector,c=(ring+1)*sectors+next,d=ring*sectors+next;
      faces.push([a,b,c],[a,c,d]);
    }
    for(let sector=0;sector<sectors;sector++){
      const next=(sector+1)%sectors;faces.push([bottom,sector,next],[top,(rings-1)*sectors+next,(rings-1)*sectors+sector]);
    }
    const adjacent=vertices.map(()=>[]),faceAreaVectors=[],faceUnits=[],sideFaces=(rings-1)*sectors*2;
    for(let index=0;index<sideFaces;index++){
      const face=faces[index];
      a.fromArray(vertices[face[0]]);b.fromArray(vertices[face[1]]);c.fromArray(vertices[face[2]]);
      const area=new THREE.Vector3().crossVectors(ab.subVectors(b,a),ac.subVectors(c,a));
      faceAreaVectors.push(area);faceUnits.push(area.clone().normalize());
      for(const vertex of face)adjacent[vertex].push(index);
    }
    const shading=new THREE.Vector3(),faceNormal=new THREE.Vector3();
    for(let index=0;index<faces.length;index++){
      const face=faces[index],x=vertices[face[0]],y=vertices[face[1]],z=vertices[face[2]];
      triangle(x[0],x[1],x[2],y[0],y[1],y[2],z[0],z[1],z[2],1);
      if(index<sideFaces){
        // Preserve real sharp crown creases instead of averaging a concave
        // corner across opposing faces. All work is construction-time only.
        faceNormal.copy(normal);const start=normals.length-9;
        for(let i=0;i<3;i++){
          shading.set(0,0,0);
          for(const neighbor of adjacent[face[i]])if(faceNormal.dot(faceUnits[neighbor])>=.5)shading.add(faceAreaVectors[neighbor]);
          shading.normalize();const at=start+i*3;normals[at]=shading.x;normals[at+1]=shading.y;normals[at+2]=shading.z;
        }
      }
    }
  };
  const sprayNormals=(cx,cy,cz,length,width,side)=>{
    // Broad needle sprays shade along their gently bowed fan surface, rather
    // than acquiring the radial ellipsoid normal of a rounded plastic bead.
    const start=positions.length-9;
    for(let i=0;i<3;i++){
      const at=start+i*3,x=positions[at]-cx,y=positions[at+1]-cy,z=positions[at+2]-cz;
      const along=(x*axis.x+y*axis.y+z*axis.z)/length,across=(x*right.x+y*right.y+z*right.z)/width;
      normal.copy(forward).addScaledVector(axis,-along*.14).addScaledVector(right,-across*.08).multiplyScalar(side).normalize();
      normals[at]=normal.x;normals[at+1]=normal.y;normals[at+2]=normal.z;
    }
  };
  const sprayUV=(cx,cy,cz,length,width)=>{
    const start=positions.length-9;
    for(let i=0;i<3;i++){
      const at=start+i*3,x=positions[at]-cx,y=positions[at+1]-cy,z=positions[at+2]-cz;
      uvs[at]=Math.max(0,Math.min(1,.5+(x*right.x+y*right.y+z*right.z)/(2*width)));
      uvs[at+1]=Math.max(0,Math.min(1,.5+(x*axis.x+y*axis.y+z*axis.z)/(2*length)));
      uvs[at+2]=1;
    }
  };
  const foliage=(cx,cy,cz,dx,dy,dz,length,width,depth,seed,sides)=>{
    if(foliageAspect!==null){length=Math.max(length,width/foliageAspect);width=length*foliageAspect;}
    frame(dx,dy,dz);
    const roll=((seed%3)-1)*.70+(cellHash(seed,0,0x731f,53)-.5)*.55;
    reference.copy(right);right.multiplyScalar(Math.cos(roll)).addScaledVector(forward,Math.sin(roll));
    forward.multiplyScalar(Math.cos(roll)).addScaledVector(reference,-Math.sin(roll));
    // Concave outlines place the old vertex budget into separated terminal
    // tips and notches. Closed, thin 3D sprays interleave around the branch;
    // they are neither billboards nor independent needles or growth physics.
    const profile=foliageAspect!==null?(detail===2?[[-1,-1],[1,-1],[1.035,-.3],[1,1],[-1,1],[-1.035,.35],[-1.035,-.35]]
      :detail===1?[[-1,-1],[1,-1],[1.035,0],[1,1],[-1,1],[-1.035,0]]:[[-1,-1],[1,-1],[1,1],[-1,1]])
      :detail===2?[[0,-1],[-1,.45],[-.22,.20],[-.05,1],[.25,.30],[1,.55],[.4,-.65]]
      :detail===1?[[0,-1],[-.95,.65],[-.16,.24],[.08,1],[.95,.60],[.30,-.55]]
      :[[0,-1],[-.78,.35],[.05,1],[.80,.22]];
    const contour=profile.map((p,i)=>new THREE.Vector2(p[0]*width*(foliageAspect!==null?1.:.92+.13*cellHash(seed,i,0x731f,79)),p[1]*length));
    if(THREE.ShapeUtils.isClockWise(contour))contour.reverse();
    const faces=THREE.ShapeUtils.triangulateShape(contour,[]),count=contour.length;
    const ring=new Float64Array(count*6),thickness=Math.min(depth*.09,width*.075);
    for(let i=0;i<count;i++){
      const u=contour[i].x,l=contour[i].y,bow=(l/length)*(l/length)*width*.07;
      for(let side=0;side<2;side++){
        const h=bow+(side?1:-1)*thickness,index=(side*count+i)*3;
        ring[index]=cx+right.x*u+axis.x*l+forward.x*h;
        ring[index+1]=cy+right.y*u+axis.y*l+forward.y*h;
        ring[index+2]=cz+right.z*u+axis.z*l+forward.z*h;
      }
    }
    for(const face of faces){
      let ia=face[0],ib=face[1],ic=face[2];
      const a=contour[ia],b=contour[ib],c=contour[ic];
      if((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)<0){const swap=ib;ib=ic;ic=swap;}
      const loA=ia*3,loB=ib*3,loC=ic*3,hiA=(count+ia)*3,hiB=(count+ib)*3,hiC=(count+ic)*3;
      triangle(ring[hiA],ring[hiA+1],ring[hiA+2],ring[hiB],ring[hiB+1],ring[hiB+2],ring[hiC],ring[hiC+1],ring[hiC+2],1);
      sprayNormals(cx,cy,cz,length,width,1);
      sprayUV(cx,cy,cz,length,width);
      triangle(ring[loA],ring[loA+1],ring[loA+2],ring[loC],ring[loC+1],ring[loC+2],ring[loB],ring[loB+1],ring[loB+2],1);
      sprayNormals(cx,cy,cz,length,width,-1);
      sprayUV(cx,cy,cz,length,width);
    }
    for(let i=0;i<count;i++){
      const j=(i+1)%count,a=i*3,b=j*3,A=(count+i)*3,B=(count+j)*3;
      triangle(ring[a],ring[a+1],ring[a+2],ring[b],ring[b+1],ring[b+2],ring[B],ring[B+1],ring[B+2],1);
      sprayUV(cx,cy,cz,length,width);
      triangle(ring[a],ring[a+1],ring[a+2],ring[B],ring[B+1],ring[B+2],ring[A],ring[A+1],ring[A+2],1);
      sprayUV(cx,cy,cz,length,width);
    }
  };

  const branchCore=(endX,endY,endZ,y,spread)=>{
    // Five actual3D twig sprays replace the opaque core's20triangles.
    // Each four-face tetrahedral envelope folds the complete twig rectangle;
    // visible and shadow holes come from the existing shared atlas alpha.
    frame(endX,endY-y,endZ);
    const stem=axis.clone(),lateral=right.clone();
    const faces=[[0,2,1],[0,3,2],[0,1,3],[1,2,3]],uv=[[0,0],[1,0],[1,1],[0,1]],rolls=[-.65,.45,-.10,.80,-.50];
    for(let spray=0;spray<5;spray++){
      const fraction=.12+spray*.16,offset=(spray%2?1:-1)*spread*.08;
      const cx=endX*fraction+lateral.x*offset,cy=y+(endY-y)*fraction+lateral.y*offset,cz=endZ*fraction+lateral.z*offset;
      const splay=(spray%2?1:-1)*(.22+spray*.035),co=Math.cos(splay),si=Math.sin(splay);
      frame(stem.x*co+lateral.x*si,stem.y*co+lateral.y*si,stem.z*co+lateral.z*si);
      const roll=rolls[spray],cr=Math.cos(roll),sr=Math.sin(roll);
      reference.copy(right);right.multiplyScalar(cr).addScaledVector(forward,sr);forward.multiplyScalar(cr).addScaledVector(reference,-sr);
      const length=spread*.38*(1.-spray*.10),width=length*foliageAspect,depth=width*.18;
      const vertices=[[-width,-length,-depth],[width,-length,depth],[width,length,-depth],[-width,length,depth]];
      for(const v of vertices){
        const x=v[0],l=v[1],z=v[2];v[0]=cx+right.x*x+axis.x*l+forward.x*z;v[1]=cy+right.y*x+axis.y*l+forward.y*z;v[2]=cz+right.z*x+axis.z*l+forward.z*z;
      }
      for(const f of faces){
        const A=vertices[f[0]],B=vertices[f[1]],C=vertices[f[2]];
        triangle(A[0],A[1],A[2],B[0],B[1],B[2],C[0],C[1],C[2],1);
        const start=uvs.length-9;for(let i=0;i<3;i++){const at=start+i*3;uvs[at]=uv[f[i]][0];uvs[at+1]=uv[f[i]][1];uvs[at+2]=1;}
      }
    }
  };

  // Low silhouettes keep an opaque connected inner crown. Overlapping closed
  // branch-wheel lobes supply the outer mass, true notches and stepped edges;
  // these are decorative geometry, not a branch-growth or collision model.
  const lowWhorledCrown=()=>{
    crownMass(7,8,.56);
    const heights=[.235,.345,.455,.565,.675,.785,.89];
    const sourceHeights=[.18,.27,.37,.48,.59,.70,.80,.89,.96];
    const sourceRadii=[.11,.205,.195,.17,.148,.113,.085,.055,.018];
    // Same 28 boughs and 24 triangles per bough. A closed seven-point
    // forked envelope spends the former round tube's budget on real terminal
    // notches. No alpha cards, noise shading, extra instances or moving detail.
    const profile=[[0,.01],[-.56,.48],[-.40,.94],[-.12,.65],[.08,1.07],[.23,.68],[.59,.83]];
    const contour=profile.map(([across,along])=>new THREE.Vector2(across,along));
    if(THREE.ShapeUtils.isClockWise(contour))contour.reverse();
    const faces=THREE.ShapeUtils.triangulateShape(contour,[]),count=contour.length;
    const ring=new Float64Array(count*6);
    for(let level=0;level<heights.length;level++){
      const y=heights[level];let section=0;
      while(section<sourceHeights.length-2&&sourceHeights[section+1]<y)section++;
      const t=(y-sourceHeights[section])/(sourceHeights[section+1]-sourceHeights[section]);
      const radius=(sourceRadii[section]+(sourceRadii[section+1]-sourceRadii[section])*t)*1.12;
      const rotation=level*2.399963+(cellHash(level,0,0x27b591,13)-.5)*.40;
      for(let member=0;member<4;member++){
        const h=cellHash(level,member,0x27b591,31),angle=rotation+member*TAU/4+(h-.5)*.16;
        const dx=Math.cos(angle),dz=Math.sin(angle),reach=radius*(.92+.14*h);
        const cy=y+(cellHash(level,member,0x27b591,53)-.5)*.025;
        const depth=(.052-.014*level/6)*(.90+.20*cellHash(level,member,0x27b591,71));
        for(let i=0;i<count;i++)for(let side=0;side<2;side++){
          const across=contour[i].x*reach,along=contour[i].y;
          const thickness=depth*(1.-along*.32),index=(side*count+i)*3;
          ring[index]=dx*reach*along-dz*across;
          ring[index+1]=cy+.018-.063*along+(side?1:-1)*thickness;
          ring[index+2]=dz*reach*along+dx*across;
        }
        for(const face of faces){
          let [ia,ib,ic]=face;
          const a=contour[ia],b=contour[ib],c=contour[ic];
          if((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)<0){const swap=ib;ib=ic;ic=swap;}
          const a0=ia*3,b0=ib*3,c0=ic*3,a1=(count+ia)*3,b1=(count+ib)*3,c1=(count+ic)*3;
          triangle(ring[a1],ring[a1+1],ring[a1+2],ring[b1],ring[b1+1],ring[b1+2],ring[c1],ring[c1+1],ring[c1+2],1);
          triangle(ring[a0],ring[a0+1],ring[a0+2],ring[c0],ring[c0+1],ring[c0+2],ring[b0],ring[b0+1],ring[b0+2],1);
        }
        for(let i=0;i<count;i++){
          const j=(i+1)%count,a=i*3,b=j*3,A=(count+i)*3,B=(count+j)*3;
          triangle(ring[A],ring[A+1],ring[A+2],ring[a],ring[a+1],ring[a+2],ring[b],ring[b+1],ring[b+2],1);
          triangle(ring[A],ring[A+1],ring[A+2],ring[b],ring[b+1],ring[b+2],ring[B],ring[B+1],ring[B+2],1);
        }
      }
    }
  };

  // Near and middle crowns put their detail budget into many overlapping
  // small sprays around actual limbs. The core only closes interior gaps;
  // the far model instead closes its mass with overlapping branch-wheel lobes.
  limb(0,0,0,0,.985,0,.017,.0025,detail===2?6:detail===1?5:4);
  if(detail===0)lowWhorledCrown();
  else if(foliageAspect===null)crownMass(detail===1?7:6,10,detail===1?.42:.34);
  // Keep the existing branch/spray counts, but arrange real limbs into uneven
  // groups instead of a uniformly rising spiral. Each group has an asymmetric
  // opening; shorter terminal sprays leave gaps between neighbouring groups.
  const branches=detail===2?44:28;
  const groupSizes=detail===2?[6,5,6,5,5,5,4,4,4]:[5,5,4,4,4,3,3];
  const groupHeights=detail===2?[.225,.305,.395,.475,.565,.650,.740,.825,.885]
    :[.225,.335,.450,.565,.680,.790,.885];
  let groupIndex=0,firstBranch=0;
  for(let branch=0;detail>0&&branch<branches;branch++){
    while(branch>=firstBranch+groupSizes[groupIndex]){firstBranch+=groupSizes[groupIndex];groupIndex++;}
    const member=branch-firstBranch,members=groupSizes[groupIndex];
    const h=cellHash(branch,groupIndex,0x537bf1,13);
    const rotation=groupIndex*2.399963+(cellHash(groupIndex,0,0x537bf1,23)-.5)*1.3;
    const angle=rotation+(member+.16*(h-.5))*TAU/(members+.36);
    const y=groupHeights[groupIndex]+(cellHash(branch,groupIndex,0x537bf1,31)-.5)*.031;
    const reach=.74+.48*h+.10*Math.sin(member*2.3+groupIndex);
    const spread=.205*Math.pow(1.-y,.67)*reach;
    const dx=Math.cos(angle),dz=Math.sin(angle);
    const bend=(.024+(1-y)*.055)*(.70+.60*cellHash(branch,0,0x537bf1,43));
    const endX=dx*spread,endY=y-bend,endZ=dz*spread;
    limb(0,y,0,endX,endY,endZ,.0045*(1-y)+.0015,.001,detail===2?4:3);
    if(foliageAspect!==null&&member===0&&(detail===1||groupIndex===0||groupIndex===1||groupIndex===3||groupIndex===4||groupIndex===6||groupIndex===8))branchCore(endX,endY,endZ,y,spread);
    const clusters=detail===2?6:3;
    for(let cluster=0;cluster<clusters;cluster++){
      if(detail===1&&cluster===2&&branch%2)continue;
      const nominal=detail===2?.24+cluster*.16:cluster===0?.38:cluster===1?.72:1.02;
      const fraction=nominal+(cellHash(branch,cluster,0x731f,101)-.5)*.085;
      const side=(cluster%2?1:-1)*spread*(detail===2?.14:.18)
        *(.65+.70*cellHash(branch,cluster,0x731f,107));
      const cx=endX*fraction-dz*side,cz=endZ*fraction+dx*side;
      const cy=y-bend*fraction+(cellHash(branch,cluster,0x731f,113)-.5)*.022;
      const terminal=.98-.20*Math.max(0,fraction-.5);
      const scale=(.76+.44*cellHash(branch,cluster,0x731f,127))*terminal;
      const length=spread*(detail===1?.43:.32)*scale;
      const width=(detail===1?.032+.020*(1-y):.032+.022*(1-y))*scale;
      const fanAngle=(cluster%2?1:-1)*(.25+cellHash(branch,cluster,0x731f,137)*.42);
      const fx=dx*Math.cos(fanAngle)-dz*Math.sin(fanAngle),fz=dx*Math.sin(fanAngle)+dz*Math.cos(fanAngle);
      const droop=-.13-.18*fraction+.24*cellHash(branch,cluster,0x731f,149);
      foliage(cx,cy,cz,fx,droop,fz,length,width,width*.92,branch*11+cluster,detail===1?5:6);
    }
    if((branch%2===0&&detail===2)||(branch%4===0&&detail===1)){
      const tx=endX*.65-dz*spread*.28,tz=endZ*.65+dx*spread*.28,ty=y-bend*.5+.025;
      limb(endX*.4,y-bend*.4,endZ*.4,tx,ty,tz,.0025,.0007,3);
    }
  }
  if(detail>0)foliage(0,.955,0,0,1,0,.045,.018,.016,317,detail===1?5:6);
  const geometry=new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('geometricNormal',new THREE.Float32BufferAttribute(geometricNormals,3));
  geometry.setAttribute('treePart',new THREE.Float32BufferAttribute(parts,1));
  geometry.setAttribute('treeUV',new THREE.Float32BufferAttribute(uvs,3));
  geometry.setAttribute('iShadowRoot',new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*3),3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('iRoot',instances.root);geometry.setAttribute('iGroundNormal',instances.normal);geometry.setAttribute('iShape',instances.shape);
  geometry.setAttribute('iShadowCoverage',new THREE.InstancedBufferAttribute(new Uint8Array(CAPACITY*3),3,true).setUsage(THREE.DynamicDrawUsage));
  geometry.instanceCount=0;return geometry;
}
/** Bounded, decorative near-field pines. The sole closed terrain mesh owns
 * ground and collision; trees have no collision body, mass or ecology solver.
 * GPU resources are lazy: one master list feeds three bounded packed LOD lists.
 * Shadow casters borrow the same packed LOD geometry and coverage records;
 * this module owns those wrappers and releases all resources on dispose.
 */
export function createRingHabitatVegetation({shadowUniforms,foliageMaterial=null,terrainRegistry=null}={}){
  const group=new THREE.Group();group.name='Decorative inner-ring vegetation';group.visible=false;
  const frame=new THREE.Matrix3(),cameraLocal=new THREE.Vector3(),point=new THREE.Vector3(),normal=new THREE.Vector3(),faceNormal=new THREE.Vector3();
  group.userData.cameraLocal=cameraLocal; // Borrowed; updated in place, retained after dispose.
  const bestPoint=new THREE.Vector3(),bestNormal=new THREE.Vector3(),bestFaceNormal=new THREE.Vector3();
  const river={distance:0,progressL:0,tangentX:0,tangentY:0};
  const surfaceInfo={rockCoverage:0};
  const foliageUniforms={uHasHabitatFoliage:{value:foliageMaterial!==null},uHabitatFoliageColor:{value:foliageMaterial?foliageMaterial.color:null},uHabitatFoliageAlpha:{value:foliageMaterial?foliageMaterial.alpha:null},uHabitatFoliageUV:{value:new THREE.Vector4().fromArray(foliageMaterial?foliageMaterial.uvRect:[0,0,1,1])}};
  group.userData.foliageUniforms=foliageUniforms;
  const foliageAspect=foliageMaterial?(foliageMaterial.uvRect[2]-foliageMaterial.uvRect[0])*foliageMaterial.color.image.width/((foliageMaterial.uvRect[3]-foliageMaterial.uvRect[1])*foliageMaterial.color.image.height):null;
  const active=new Int32Array(32),fieldActive=new Uint8Array(32),fieldLeases=new Array(32).fill(null),meshes=[],shadowMeshes=[];
  // Only the receiver's namespace is borrowed. Body uniforms use normalized
  // lengths elsewhere and must never replace the tree's scene-unit records.
  const receiver=createRingHabitatShadowUniforms();
  const shadowAnchor=new THREE.Vector3(NaN,NaN,NaN),shadowRootVersions=new Int32Array(3).fill(-1);
  if(shadowUniforms)for(const name in shadowUniforms)if(name.startsWith('uVegetationShadow'))receiver[name]=shadowUniforms[name];
  group.userData.lodMeshes=meshes;group.userData.shadowMeshes=shadowMeshes;group.userData.shadowMesh=null;
  // Actual caster sources are these same packed render geometries, borrowed by
  // the shadow owner. iShadowCoverage is normalized Uint8 vec3 =
  // (overall visibility, LOD interval start, LOD interval end). Both render and
  // shadow consume these authoritative quantized values; no consumer recomputes
  // range/pixel/LOD decisions. The complete shadowMesh is bounds/diagnostics only.
  group.userData.shadowCasters=meshes;
  let visibilityBytes=null,highBytes=null,lowStartBytes=null,primaryColumns=null,primaryRows=null;
  let master=null,uniforms=null,disposed=false,activeCount=0,masterCount=0,primaryCount=0,masterRevision=0;
  const queues=[],counts=new Int32Array(3),changed=new Uint8Array(3),packedRevision=new Int32Array(3).fill(-1);
  let lastGroups=null,lastId=null,lastPhase=NaN,lastTheme=null,lastClimate=-1,lastCeiling=NaN,lastDensity=NaN,lastInner=NaN,lastTileX=NaN,lastTileY=NaN,lastNearX=NaN,lastNearY=NaN,seed=0,companionSeed=0;
  let canonicalTerrain=false,lastTerrainRevision,retainedFields=0,latticeWork=null;
  const stats={rebuilds:0,activePatches:0,instances:0,primaryInstances:0,companionInstances:0,lodInstances:[0,0,0],shadowAnchorUploads:0};group.userData.stats=stats;
  group.userData.updateShadowAnchor=origin=>{
    if(disposed)return;
    const moved=!shadowAnchor.equals(origin);
    for(let detail=0;detail<meshes.length;detail++){
      const geometry=meshes[detail].geometry,roots=geometry.attributes.iRoot,relative=geometry.attributes.iShadowRoot;
      if(!moved&&shadowRootVersions[detail]===roots.version)continue;
      const source=roots.array,target=relative.array;
      // Preserve the visual/caster contract: subtract in double from the
      // actual uploaded roots, then round once into this relative buffer.
      for(let i=0;i<geometry.instanceCount;i++){const at=i*3;target[at]=source[at]-origin.x;target[at+1]=source[at+1]-origin.y;target[at+2]=source[at+2]-origin.z;}
      relative.needsUpdate=true;shadowRootVersions[detail]=roots.version;stats.shadowAnchorUploads++;
    }
    shadowAnchor.copy(origin);
  };
  const releaseFields=()=>{if(!retainedFields)return;clearRingHabitatLatticeWorkspace(latticeWork);for(let i=0;i<fieldLeases.length;i++){const lease=fieldLeases[i];if(lease){lease.release();fieldLeases[i]=null;}}retainedFields=0;};
  const clear=()=>{
    releaseFields();
    group.visible=false;stats.instances=0;stats.primaryInstances=0;stats.companionInstances=0;masterCount=0;primaryCount=0;
    for(let i=0;i<meshes.length;i++){meshes[i].geometry.instanceCount=0;shadowMeshes[i].geometry.instanceCount=0;stats.lodInstances[i]=0;}
  };
  const createInstances=()=>({root:new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*3),3).setUsage(THREE.DynamicDrawUsage),normal:new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*3),3).setUsage(THREE.DynamicDrawUsage),shape:new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*4),4).setUsage(THREE.DynamicDrawUsage)});
  const allocate=()=>{
    master=createInstances();primaryColumns=new Int32Array(CAPACITY);primaryRows=new Int32Array(CAPACITY);
    visibilityBytes=new Uint8Array(CAPACITY);highBytes=new Uint8Array(CAPACITY);lowStartBytes=new Uint8Array(CAPACITY);
    const shared={...receiver,...foliageUniforms,uBodyToWorld:{value:new THREE.Matrix3()},uViewRotation:{value:new THREE.Matrix3()},uBodyCenter:{value:new THREE.Vector3()},uLight:{value:new THREE.Vector3()},uCameraLocal:{value:cameraLocal},uFoliage:{value:new THREE.Color()},uPixelAngle:{value:.001},uFadeRange:{value:new THREE.Vector2(FADE_START,FADE_END)}};
    for(let detail=0;detail<3;detail++){
      const g=createTreeGeometry(detail,createInstances(),foliageAspect),u={...shared};
      const material=new THREE.ShaderMaterial({vertexShader:VERTEX,fragmentShader:FRAGMENT,uniforms:u,
        defines:foliageMaterial?{HABITAT_FOLIAGE_MAP:1}:{},glslVersion:THREE.GLSL3,depthWrite:true,depthTest:true});
      const m=new THREE.Mesh(g,material);m.frustumCulled=false;m.renderOrder=2;meshes.push(m);group.add(m);queues.push(new Int32Array(CAPACITY));
      // Shadow views share static tree vertices, but borrow the FULL master
      // roots/shapes, never a camera-dependent packed render buffer.
      const shadowGeometry=new THREE.InstancedBufferGeometry();
      shadowGeometry.setAttribute('position',g.attributes.position);shadowGeometry.setAttribute('normal',g.attributes.normal);shadowGeometry.setAttribute('geometricNormal',g.attributes.geometricNormal);shadowGeometry.setAttribute('treePart',g.attributes.treePart);
      shadowGeometry.setAttribute('treeUV',g.attributes.treeUV);
      shadowGeometry.setAttribute('iRoot',master.root);shadowGeometry.setAttribute('iGroundNormal',master.normal);shadowGeometry.setAttribute('iShape',master.shape);
      shadowGeometry.instanceCount=0;
      const shadow=new THREE.Mesh(shadowGeometry,material);shadow.frustumCulled=false;shadowMeshes.push(shadow);
    }
    group.userData.shadowMesh=shadowMeshes[2];uniforms=meshes[0].material.uniforms;
  };
  const append=(detail,index)=>{
    const at=counts[detail]++;
    if(queues[detail][at]!==index)changed[detail]=1;
    queues[detail][at]=index;
  };
  const smoothUnit=value=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};
  const packLods=pixelAngle=>{
    counts.fill(0);changed.fill(0);
    const roots=master.root.array,shapes=master.shape.array,normals=master.normal.array;
    for(let i=0;i<masterCount;i++){
      const distance=Math.hypot(roots[i*3]-cameraLocal.x,roots[i*3+1]-cameraLocal.y,roots[i*3+2]-cameraLocal.z);
      const pixels=shapes[i*4]/(Math.max(distance,.0001)*pixelAngle);
      const fadeStart=i<primaryCount?FADE_START:COMPANION_FADE_START,fadeEnd=i<primaryCount?FADE_END:COMPANION_FADE_END;
      const overall=smoothUnit((pixels-2)/4)*(1-smoothUnit((distance-fadeStart)/(fadeEnd-fadeStart)));
      const coverage=Math.round(overall*255);
      // Screen size owns the coarse-model boundary: a 100-pixel tree always
      // receives the middle geometry. The most expensive geometry additionally
      // has a hard 240-unit near-field limit, independent of display resolution.
      const middleShare=smoothUnit((pixels-MIDDLE_PIXEL_START)/(MIDDLE_PIXEL_END-MIDDLE_PIXEL_START));
      const highShare=middleShare*smoothUnit((pixels-HIGH_PIXEL_START)/(HIGH_PIXEL_END-HIGH_PIXEL_START))
        *(1-smoothUnit((distance-HIGH_DISTANCE_START)/(HIGH_DISTANCE_END-HIGH_DISTANCE_START)));
      const high=Math.round(highShare*255),lowStart=Math.round(middleShare*255);
      visibilityBytes[i]=coverage;highBytes[i]=high;lowStartBytes[i]=lowStart;
      if(!coverage)continue;
      if(lowStart<255)append(0,i);
      if(high<lowStart)append(1,i);
      if(high>0)append(2,i);
    }
    for(let detail=0;detail<3;detail++){
      const g=meshes[detail].geometry,count=counts[detail];
      const positionsChanged=changed[detail]||count!==g.instanceCount||packedRevision[detail]!==masterRevision;
      const r=g.attributes.iRoot.array,n=g.attributes.iGroundNormal.array,s=g.attributes.iShape.array,w=g.attributes.iShadowCoverage.array;
      let weightsChanged=false;
      for(let j=0;j<count;j++){
        const i=queues[detail][j];
        if(positionsChanged){
          for(let k=0;k<3;k++){r[j*3+k]=roots[i*3+k];n[j*3+k]=normals[i*3+k];}
          for(let k=0;k<4;k++)s[j*4+k]=shapes[i*4+k];
        }
        const start=detail===0?lowStartBytes[i]:detail===1?highBytes[i]:0;
        const end=detail===0?255:detail===1?lowStartBytes[i]:highBytes[i];
        if(w[j*3]!==visibilityBytes[i]||w[j*3+1]!==start||w[j*3+2]!==end){
          w[j*3]=visibilityBytes[i];w[j*3+1]=start;w[j*3+2]=end;weightsChanged=true;
        }
      }
      g.instanceCount=count;stats.lodInstances[detail]=count;packedRevision[detail]=masterRevision;
      if(positionsChanged){g.attributes.iRoot.needsUpdate=true;g.attributes.iGroundNormal.needsUpdate=true;g.attributes.iShape.needsUpdate=true;}
      if(weightsChanged)g.attributes.iShadowCoverage.needsUpdate=true;
    }
  };
  const plant=(body,groups,ecology,inner,angle,axis,wrapped,row,treeSeed,count)=>{
    const roots=master.root.array,groundNormals=master.normal.array,shapes=master.shape.array;
    let bestRadius=Infinity,found=false,bestRockCoverage=0,bestIndex=-1,bestX=0,bestY=0;
    for(let i=0;i<activeCount;i++){
      const patch=groups[active[i]];
      let sampled,sampleX=0,sampleY=0;
      if(canonicalTerrain){
        const phi=angle+Math.round(((patch.minAngle+patch.maxAngle)*.5-angle)/TAU)*TAU;
        sampleX=(phi-patch.minAngle)*patch.innerRadius;sampleY=axis-patch.minY;
        sampled=terrainRegistry.samplePreparedTop(body,patch.siteIndex,sampleX,sampleY,point,null,faceNormal,surfaceInfo)
          ||sampleCanonicalTop(fieldLeases[active[i]].field,sampleX,sampleY,point,null,faceNormal,surfaceInfo,latticeWork);
      }else sampled=sampleTop(patch,angle,axis,point,normal,faceNormal,surfaceInfo);
      if(!sampled)continue;
      const r=Math.hypot(point.x,point.z);
      if(r<bestRadius){bestRadius=r;bestPoint.copy(point);if(!canonicalTerrain)bestNormal.copy(normal);bestFaceNormal.copy(faceNormal);bestRockCoverage=surfaceInfo.rockCoverage;found=true;bestIndex=active[i];bestX=sampleX;bestY=sampleY;}
    }
    if(!found)return false;
    const height=inner-bestRadius,upright=-(bestFaceNormal.x*bestPoint.x+bestFaceNormal.z*bestPoint.z)/bestRadius;
    if(height<=20||height>=ecology.forestCeiling||upright<.84||bestRockCoverage>.35)return false;
    if(canonicalTerrain){
      const field=fieldLeases[bestIndex].field,patch=groups[bestIndex];
      if(field.sampleRiver?.(bestX,bestY,river)&&river.distance<RING_HABITAT_RIVER_BANK_DISTANCE)return false;
      if(!terrainRegistry.samplePreparedTop(body,patch.siteIndex,bestX,bestY,bestPoint,bestNormal,bestFaceNormal,surfaceInfo))sampleCanonicalTop(field,bestX,bestY,bestPoint,bestNormal,bestFaceNormal,surfaceInfo,latticeWork);
    }
    const age=cellHash(wrapped,row,treeSeed,97);
    const maturity=age<.42?Math.pow(age/.42,2)*.30:.30+.70*Math.pow((age-.42)/.58,.60);
    const size=20.+20.*maturity,offset=count*3,shapeOffset=count*4;
    roots[offset]=bestPoint.x;roots[offset+1]=bestPoint.y;roots[offset+2]=bestPoint.z;
    groundNormals[offset]=bestNormal.x;groundNormals[offset+1]=bestNormal.y;groundNormals[offset+2]=bestNormal.z;
    shapes[shapeOffset]=size;shapes[shapeOffset+1]=.62+.65*Math.pow(maturity,.60)+.15*cellHash(wrapped,row,treeSeed,127);
    shapes[shapeOffset+2]=TAU*cellHash(wrapped,row,treeSeed,151);shapes[shapeOffset+3]=cellHash(wrapped,row,treeSeed,173);
    return true;
  };
  group.userData.update=({body=null,camera,viewportHeight,pixelRatio=1})=>{
    if(disposed)return;
    canonicalTerrain=Boolean(body?.kind==='ring'&&body.habitat?.terrainRecipes?.length);
    const groups=body?.kind==='ring'?(canonicalTerrain?body.habitat.terrainRecipes:body.shape.terrainGroups):null,ecology=body?.habitat?.ecology;
    if(!groups?.length||!ecology||(body.visibility??1)<=0){clear();lastGroups=null;return;}
    const inner=body.shape.parts[0].innerRadius;
    frame.fromArray(body.frame);cameraLocal.fromArray(body.center).negate().applyMatrix3(frame);
    const radial=Math.hypot(cameraLocal.x,cameraLocal.z);
    if(Math.abs(inner-radial)>=3500){clear();lastGroups=null;return;}
    if(canonicalTerrain&&!terrainRegistry){clear();lastGroups=null;throw new TypeError('Canonical Halo vegetation requires its terrain registry');}
    if(canonicalTerrain&&!latticeWork)latticeWork=createRingHabitatLatticeWorkspace();
    const columns=Math.max(1,Math.round(TAU*inner/PITCH)),spacing=TAU*inner/columns;
    const cameraColumn=(Math.atan2(cameraLocal.z,cameraLocal.x)/TAU+.5)*columns;
    const tileX=Math.floor(cameraColumn/TILE_CELLS),tileY=Math.floor(cameraLocal.y/PITCH/TILE_CELLS);
    const climate=body.habitat.climate;
    const terrainRevision=canonicalTerrain?terrainRegistry.revision:undefined;
    const metadataChanged=groups!==lastGroups||body.id!==lastId||body.phase!==lastPhase||body.theme!==lastTheme||climate!==lastClimate||ecology.forestCeiling!==lastCeiling||ecology.treeDensity!==lastDensity||inner!==lastInner||terrainRevision!==lastTerrainRevision;
    const rebuild=metadataChanged||tileX!==lastTileX||tileY!==lastTileY;
    try{
    if(rebuild){
      if(groups.length>active.length)throw new RangeError('Near vegetation supports the catalogue maximum of 32 terrain patches');
      activeCount=0;fieldActive.fill(0);if(metadataChanged)releaseFields();
      for(let i=0;i<groups.length;i++){
        const patch=groups[i];
        if(canonicalTerrain){
          const angle=Math.atan2(cameraLocal.z,cameraLocal.x),phi=angle+Math.round(((patch.minAngle+patch.maxAngle)*.5-angle)/TAU)*TAU;
          const dx=Math.max(patch.minAngle-phi,0,phi-patch.maxAngle)*patch.innerRadius,dy=Math.max(patch.minY-cameraLocal.y,0,cameraLocal.y-patch.maxY);
          if(Math.hypot(dx,dy)>RING_HABITAT_VEGETATION_PREPARE_RADIUS_L)continue;
          active[activeCount++]=i;fieldActive[i]=1;
        }else if(patch.topGrid&&Math.hypot(cameraLocal.x-patch.center[0],cameraLocal.y-patch.center[1],cameraLocal.z-patch.center[2])<=patch.radius+RANGE+3500+720+MAX_HEIGHT)active[activeCount++]=i;
      }
      for(let i=0;i<fieldLeases.length;i++){
        if(!fieldActive[i]&&fieldLeases[i]){fieldLeases[i].release();fieldLeases[i]=null;retainedFields--;}
        else if(fieldActive[i]&&!fieldLeases[i]){fieldLeases[i]=terrainRegistry.acquireField(body,groups[i].siteIndex);retainedFields++;}
      }
      stats.activePatches=activeCount;
      if(metadataChanged){seed=hashSeed(`${body.id}:${body.phase}:habitat-tree-v1`);companionSeed=hashSeed(`${body.id}:${body.phase}:habitat-companions-v1`);}
      if(activeCount){
        if(!master)allocate();
        const centerColumn=tileX*TILE_CELLS+TILE_CELLS*.5,centerRow=tileY*TILE_CELLS+TILE_CELLS*.5;
        const steps=Math.ceil(RANGE/Math.min(spacing,PITCH));let count=0;
        for(let y=-steps;y<=steps;y++)for(let x=-steps;x<=steps;x++){
          const column=tileX*TILE_CELLS+TILE_CELLS*.5+x,row=tileY*TILE_CELLS+TILE_CELLS*.5+y;
          const wrapped=((column%columns)+columns)%columns;
          const h=cellHash(wrapped,row,seed,31);
          const cellX=column+.5+(cellHash(wrapped,row,seed,53)-.5)*(JITTER*2),cellY=row+.5+(cellHash(wrapped,row,seed,79)-.5)*(JITTER*2);
          const footprintDistanceSquared=((cellX-centerColumn)*spacing)**2+((cellY-centerRow)*PITCH)**2;
          if(footprintDistanceSquared>RANGE*RANGE)continue;
          const angle=cellX/columns*TAU-Math.PI,axis=cellY*PITCH;
          if(h>=ringHabitatStandProbability(Math.cos(angle)*inner,axis,Math.sin(angle)*inner,ecology.treeDensity,seed))continue;
          if(!plant(body,groups,ecology,inner,angle,axis,wrapped,row,seed,count))continue;
          primaryColumns[count]=column;primaryRows[count]=row;count++;
        }
        primaryCount=count;masterCount=count;stats.primaryInstances=count;stats.rebuilds++;
        if(!count)clear();
      }else clear();
    }
    const nearX=Math.floor(cameraColumn),nearY=Math.floor(cameraLocal.y/PITCH);
    if(master&&primaryCount&&(rebuild||nearX!==lastNearX||nearY!==lastNearY)){
      const nearColumn=nearX+.5,nearRow=nearY+.5;
      // Bound arc distance from a <=320-unit body-local chord at either allowed
      // radial altitude. The extra .1 covers chord-to-arc curvature at min radius.
      const parentRange=COMPANION_FADE_END*inner/(inner-3500)+.1
        +Math.SQRT2*Math.max(spacing,PITCH)*.5+COMPANION_OFFSET;
      let count=primaryCount;
      for(let i=0;i<primaryCount;i++){
        const column=primaryColumns[i],row=primaryRows[i],wrapped=((column%columns)+columns)%columns;
        const cellX=column+.5+(cellHash(wrapped,row,seed,53)-.5)*(JITTER*2);
        const cellY=row+.5+(cellHash(wrapped,row,seed,79)-.5)*(JITTER*2);
        let delta=cellX-nearColumn;delta-=Math.round(delta/columns)*columns;
        if((delta*spacing)**2+((cellY-nearRow)*PITCH)**2>parentRange*parentRange)continue;
        const siblings=2+(cellHash(wrapped,row,companionSeed,19)<.5?1:0);
        const rotation=TAU*cellHash(wrapped,row,companionSeed,23);
        for(let sibling=0;sibling<siblings;sibling++){
          const treeSeed=(companionSeed+Math.imul(sibling+1,0x9e3779b9))>>>0;
          const bearing=rotation+TAU*(sibling+.15*cellHash(wrapped,row,treeSeed,29))/siblings;
          const offset=8+10*cellHash(wrapped,row,treeSeed,37);
          const angle=(cellX+Math.cos(bearing)*offset/spacing)/columns*TAU-Math.PI;
          const axis=cellY*PITCH+Math.sin(bearing)*offset;
          if(plant(body,groups,ecology,inner,angle,axis,wrapped,row,treeSeed,count))count++;
        }
      }
      masterCount=count;masterRevision++;stats.instances=count;stats.companionInstances=count-primaryCount;
      lastNearX=nearX;lastNearY=nearY;
      for(let i=0;i<3;i++)shadowMeshes[i].geometry.instanceCount=count;
      master.root.needsUpdate=true;master.normal.needsUpdate=true;master.shape.needsUpdate=true;
    }
    if(rebuild){lastGroups=groups;lastId=body.id;lastPhase=body.phase;lastTheme=body.theme;lastClimate=climate;lastCeiling=ecology.forestCeiling;lastDensity=ecology.treeDensity;lastInner=inner;lastTileX=tileX;lastTileY=tileY;lastTerrainRevision=terrainRevision;}
    }catch(cause){clear();lastGroups=null;throw cause;}
    if(!master||!masterCount){group.visible=false;return;}
    const pixelAngle=2./(camera.projectionMatrix.elements[5]*viewportHeight*pixelRatio);
    packLods(pixelAngle);
    camera.updateWorldMatrix(true,false);
    uniforms.uBodyToWorld.value.copy(frame).transpose();uniforms.uBodyCenter.value.fromArray(body.center);
    uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);uniforms.uLight.value.fromArray(body.light).normalize();
    uniforms.uPixelAngle.value=pixelAngle;
    const color=uniforms.uFoliage.value;
    if(climate===1)color.setRGB(.026,.052,.041);else if(climate===2)color.setRGB(.071,.083,.041);else if(climate===3)color.setRGB(.023,.075,.039);else color.setRGB(.029,.064,.041);
    group.visible=counts[0]+counts[1]+counts[2]>0;
  };
  group.userData.dispose=()=>{
    if(disposed)return;disposed=true;clear();
    for(let i=0;i<meshes.length;i++){meshes[i].geometry.dispose();meshes[i].material.dispose();shadowMeshes[i].geometry.dispose();}
    group.clear();meshes.length=0;shadowMeshes.length=0;group.userData.shadowMesh=null;
    master=null;uniforms=null;visibilityBytes=null;highBytes=null;lowStartBytes=null;primaryColumns=null;primaryRows=null;queues.length=0;lastGroups=null;activeCount=0;stats.activePatches=0;terrainRegistry=null;latticeWork=null;
  };
  return group;
}
