import {randomFromSeed,hashSeed} from './random.js';
import {buildTerrainMesh} from './mesh-terrain.js';
import {RING_HABITAT_FIELD_VERSION,ringHabitatNoise as noise,ringHabitatPatchBurial,createRingHabitatSourceProfile} from './ring-habitat-field.js';

const TAU=Math.PI*2,TOP_X=33,TOP_Y=17,BASE_X=9,BASE_Y=2;
const CLIMATES=new Map([['silver-dust',0],['dark-rift',1],['old-gold',2],['tidal-islands',3]]);
const angleDistance=(a,b)=>Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
// One height/density decision for both surface shading and physical trees.
// Elevations use the same scene units as the actual inner-ring landscape.
export const RING_HABITAT_ECOLOGY=freeze([
  {forestCeiling:1650,snowLine:1900,treeDensity:.65},
  {forestCeiling:750,snowLine:1100,treeDensity:.42},
  {forestCeiling:900,snowLine:2400,treeDensity:.12},
  {forestCeiling:2400,snowLine:2900,treeDensity:.8},
]);
const smooth=t=>t*t*(3-2*t);
function perimeter(nx,ny,offset=0){
  const result=[];
  for(let x=0;x<nx-1;x++)result.push(offset+x);
  for(let y=0;y<ny-1;y++)result.push(offset+y*nx+nx-1);
  for(let x=nx-1;x>0;x--)result.push(offset+(ny-1)*nx+x);
  for(let y=ny-1;y>0;y--)result.push(offset+y*nx);
  return result;
}
function triangulateRockSector(polygon,uv,faces,metric,vertices,center,straightEdges){
  const collinear=(a,b,c)=>{const edge=straightEdges.get(a);return edge!==undefined&&straightEdges.get(b)===edge&&straightEdges.get(c)===edge;};
  // A sector between nested ledges is a simple concave polygon. Clipping
  // ears keeps every diagonal inside it; a polar zipper can fold when one
  // ring has only three corners and the next has twelve irregular points.
  while(polygon.length>3){
    let best=-1,bestScore=Infinity,bestA=0,bestB=0,bestC=0;
    for(let at=0;at<polygon.length;at++){
      const ia=polygon[(at+polygon.length-1)%polygon.length],ib=polygon[at],ic=polygon[(at+1)%polygon.length];
      // Known straight polygon edges cannot become false ears through atan2 roundoff.
      if(collinear(ia,ib,ic))continue;
      // Retain area in the remaining polygon at every size, including a fan
      // whose only point off this straight edge would otherwise be removed.
      let remainingEdge,remainingStraight=true;
      for(let index=0;index<polygon.length;index++){
        if(index===at)continue;
        const edge=straightEdges.get(polygon[index]);
        if(edge===undefined||(remainingEdge!==undefined&&edge!==remainingEdge)){remainingStraight=false;break;}
        remainingEdge=edge;
      }
      if(remainingStraight)continue;
      const a=uv[ia],b=uv[ib],c=uv[ic],bx=b[0]-a[0],by=b[1]-a[1],cx=c[0]-a[0],cy=c[1]-a[1],det=bx*cy-by*cx;
      if(det<=1e-12)continue;
      const p=vertices[ia],q=vertices[ib],r=vertices[ic],ux=q[0]-p[0],uy=q[1]-p[1],uz=q[2]-p[2],vx=r[0]-p[0],vy=r[1]-p[1],vz=r[2]-p[2];
      if((uy*vz-uz*vy)*-(center[0]+(p[0]+q[0]+r[0])/3)+(ux*vy-uy*vx)*-(center[2]+(p[2]+q[2]+r[2])/3)<=0)continue;
      let occupied=false;
      for(const index of polygon){
        if(index===ia||index===ib||index===ic)continue;
        const x=uv[index][0]-a[0],y=uv[index][1]-a[1],beta=(x*cy-y*cx)/det,gamma=(bx*y-by*x)/det;
        if(beta>=-1e-12&&gamma>=-1e-12&&beta+gamma<=1+1e-12){occupied=true;break;}
      }
      if(occupied)continue;
      const du=uv[ia][0]-uv[ic][0],dv=uv[ia][1]-uv[ic][1];
      const score=du*du*metric[0]+2*du*dv*metric[1]+dv*dv*metric[2];
      if(score<bestScore){best=at;bestScore=score;bestA=ia;bestB=ib;bestC=ic;}
    }
    if(best<0)throw new Error('Rock ledge sector cannot be triangulated');
    // Prefer a short diagonal in the actual base plane. Including rock height
    // in this metric would favor low outer points and leave one long wall fan.
    faces.push([bestA,bestB,bestC]);polygon.splice(best,1);
  }
  faces.push([polygon[0],polygon[1],polygon[2]]);
}
function subdivideRockSurface(vertices,faces,vertexUV,surfaceKinds,center,grid,control,seed){
  const {refined,rise,normal:baseNormal,basePoint,boundary,outsideCount}=control;
  const fixed=new Set(),reference=new Map(),referenceNormals=new Map();
  const edgeKey=(a,b)=>a<b?`${a}:${b}`:`${b}:${a}`;
  for(let index=0;index<boundary.length;index++)fixed.add(edgeKey(boundary[index],boundary[(index+1)%boundary.length]));
  let records=refined.faces.map((index,at)=>({index,detail:at>=outsideCount}));
  for(const record of records)for(const index of faces[record.index])if(!reference.has(index)){
    reference.set(index,vertices[index]);referenceNormals.set(index,[0,0,0]);
  }
  for(const record of records){
    const face=faces[record.index],[a,b,c]=face.map(index=>reference.get(index));
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];
    for(const index of face){const normal=referenceNormals.get(index);for(let axis=0;axis<3;axis++)normal[axis]+=n[axis];}
  }
  for(const normal of referenceNormals.values()){const size=Math.hypot(...normal);for(let axis=0;axis<3;axis++)normal[axis]/=size;}
  // Existing shape controls keep their globally feasible positions; only the
  // subdivision points created below may recover additional detail amplitude.
  const detailVertexStart=vertices.length;
  for(let level=0;level<2;level++){
    // This cache belongs only to this construction level. Both incident
    // triangles receive one shared point, including green transition splits.
    const midpoints=new Map();
    for(const record of records)if(record.detail){
      const face=faces[record.index];
      for(let edge=0;edge<3;edge++){
        const a=face[edge],b=face[(edge+1)%3],key=edgeKey(a,b);if(fixed.has(key)||midpoints.has(key))continue;
        const p=reference.get(a),q=reference.get(b),normalA=referenceNormals.get(a),normalB=referenceNormals.get(b);
        const point=[(p[0]+q[0])/2,(p[1]+q[1])/2,(p[2]+q[2])/2],normal=[normalA[0]+normalB[0],normalA[1]+normalB[1],normalA[2]+normalB[2]],size=Math.hypot(...normal);
        for(let axis=0;axis<3;axis++)normal[axis]/=size;
        const index=vertices.length;vertices.push(point.slice());vertexUV.push([0,0]);surfaceKinds.push(0);
        reference.set(index,point);referenceNormals.set(index,normal);midpoints.set(key,index);
      }
    }
    const next=[];
    function write(parent,triangles){
      faces[parent.index]=triangles[0];next.push(parent);
      for(let at=1;at<triangles.length;at++){const index=faces.length;faces.push(triangles[at]);next.push({index,detail:parent.detail});}
    }
    for(const record of records){
      const face=faces[record.index],a=face[0],b=face[1],c=face[2];
      const m=[midpoints.get(edgeKey(a,b)),midpoints.get(edgeKey(b,c)),midpoints.get(edgeKey(c,a))],count=m.filter(value=>value!==undefined).length;
      if(count===0){next.push(record);continue;}
      if(count===3){write(record,[[a,m[0],m[2]],[m[0],b,m[1]],[m[2],m[1],c],[m[0],m[1],m[2]]]);continue;}
      if(count===1){
        const edge=m.findIndex(value=>value!==undefined),u=face[edge],v=face[(edge+1)%3],w=face[(edge+2)%3];
        write(record,[[u,m[edge],w],[m[edge],v,w]]);continue;
      }
      const missing=m.findIndex(value=>value===undefined),u=face[(missing+1)%3],v=face[(missing+2)%3],w=face[missing],uv=m[(missing+1)%3],vw=m[(missing+2)%3];
      const pu=reference.get(u),pw=reference.get(w),quv=reference.get(uv),qvw=reference.get(vw);
      const first=(pu[0]-qvw[0])**2+(pu[1]-qvw[1])**2+(pu[2]-qvw[2])**2,second=(pw[0]-quv[0])**2+(pw[1]-quv[1])**2+(pw[2]-quv[2])**2;
      write(record,first<=second?[[uv,v,vw],[u,uv,vw],[u,vw,w]]:[[uv,v,vw],[u,uv,w],[uv,vw,w]]);
    }
    records=next;
  }
  const microSeed=hashSeed(`${seed}:rock-micro-fold-v1`),entries=[],referenceUV=new Map();
  function project(point,out){
    let angle=Math.atan2(center[2]+point[2],center[0]+point[0]);
    angle+=Math.round(((grid.minAngle+grid.maxAngle)*.5-angle)/TAU)*TAU;
    out[0]=(angle-grid.minAngle)/(grid.maxAngle-grid.minAngle)*(grid.columns-1);
    out[1]=(center[1]+point[1]-grid.minY)/(grid.maxY-grid.minY)*(grid.rows-1);
  }
  for(const [index,point] of reference){
    // Fixed macro vertices retain their original UVs. Reference areas and
    // install() must use that same state, not a fresh atan2 approximation.
    const baselineUV=index<TOP_X*TOP_Y?vertexUV[index]:[0,0];
    if(index>=TOP_X*TOP_Y)project(point,baselineUV);
    referenceUV.set(index,baselineUV);
    if(index<TOP_X*TOP_Y)continue;
    const normal=referenceNormals.get(index),wx=center[0]+point[0],wy=center[1]+point[1],wz=center[2]+point[2],radius=Math.hypot(wx,wz);
    const lift=baseNormal[0]*(point[0]-basePoint[0])+baseNormal[1]*(point[1]-basePoint[1])+baseNormal[2]*(point[2]-basePoint[2]);
    const height=lift/(-(baseNormal[0]*wx+baseNormal[2]*wz)/radius),rock=height>rise*.05;
    const fade=rock?smooth(Math.max(0,Math.min(1,lift/32)))*smooth(Math.max(0,Math.min(1,(rise-height)/24))):0;
    const field=noise(wx/12,wy/12+wz/26,microSeed)*.65+noise(wy/8,wz/16+wx/30,microSeed^0x1a27f6bd)*.35;
    const displacement=8*Math.tanh(field*2.4)*fade;
    vertices[index]=point.slice();vertexUV[index]=baselineUV.slice();
    entries.push({index,point,delta:[normal[0]*displacement,normal[1]*displacement,normal[2]*displacement]});
  }
  const originalAreas=records.map(record=>{
    const face=faces[record.index],a=referenceUV.get(face[0]),b=referenceUV.get(face[1]),c=referenceUV.get(face[2]);
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  });
  function writeVertex(entry,scale){
    const point=vertices[entry.index];
    for(let axis=0;axis<3;axis++)point[axis]=entry.point[axis]+entry.delta[axis]*scale;
    project(point,vertexUV[entry.index]);
  }
  function admissibleFace(at){
    const face=faces[records[at].index],a=vertexUV[face[0]],b=vertexUV[face[1]],c=vertexUV[face[2]];
    const area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    if(area<originalAreas[at]*.10)return false;
    const p=vertices[face[0]],q=vertices[face[1]],r=vertices[face[2]],ux=q[0]-p[0],uy=q[1]-p[1],uz=q[2]-p[2],vx=r[0]-p[0],vy=r[1]-p[1],vz=r[2]-p[2];
    return (uy*vz-uz*vy)*-(center[0]+(p[0]+q[0]+r[0])/3)+(ux*vy-uy*vx)*-(center[2]+(p[2]+q[2]+r[2])/3)>0;
  }
  function install(scale){
    for(const entry of entries)writeVertex(entry,scale);
    for(let at=0;at<records.length;at++)if(!admissibleFace(at))return false;
    return true;
  }
  // The bounded global solve supplies a verified feasible starting state.
  let initialScale=1;
  if(!install(1)){
    let low=0,high=1;
    for(let iteration=0;iteration<12;iteration++){const mid=(low+high)/2;if(install(mid))low=mid;else high=mid;}
    if(!install(low))throw new Error('Rock microgeometry cannot retain its radial graph');
    initialScale=low;
  }
  // Index incident faces once for this construction. These work arrays remain
  // local to this call; the immutable mesh retains only the final geometry.
  entries.sort((a,b)=>a.index-b.index);
  const offsets=new Uint32Array(vertices.length+1);
  for(const record of records)for(const index of faces[record.index])offsets[index+1]++;
  for(let index=1;index<offsets.length;index++)offsets[index]+=offsets[index-1];
  const incidentFaces=new Uint16Array(records.length*3);
  {
    const cursor=offsets.slice(0,-1);
    for(let at=0;at<records.length;at++)for(const index of faces[records[at].index])incidentFaces[cursor[index]++]=at;
  }
  const scales=new Float64Array(entries.length);scales.fill(initialScale);
  function tryVertex(entry,scale){
    writeVertex(entry,scale);
    for(let at=offsets[entry.index];at<offsets[entry.index+1];at++)if(!admissibleFace(incidentFaces[at]))return false;
    return true;
  }
  // Two ordered passes recover subdivision detail while preserving coarse
  // crests, cuts and roofs. Every accepted point keeps all incident faces valid;
  // rejected trials restore their verified lower endpoint before continuing.
  for(let pass=0;pass<2;pass++)for(let order=0;order<entries.length;order++){
    const at=pass===0?order:entries.length-1-order,entry=entries[at],delta=entry.delta;
    if(entry.index<detailVertexStart||scales[at]===1||(delta[0]===0&&delta[1]===0&&delta[2]===0))continue;
    if(tryVertex(entry,1)){scales[at]=1;continue;}
    let low=scales[at],high=1;
    for(let iteration=0;iteration<8;iteration++){
      const mid=(low+high)/2;
      if(tryVertex(entry,mid))low=mid;else high=mid;
    }
    writeVertex(entry,low);scales[at]=low;
  }
  for(const entry of entries){
    const point=vertices[entry.index],wx=center[0]+point[0],wz=center[2]+point[2];
    const lift=baseNormal[0]*(point[0]-basePoint[0])+baseNormal[1]*(point[1]-basePoint[1])+baseNormal[2]*(point[2]-basePoint[2]);
    const height=lift/(-(baseNormal[0]*wx+baseNormal[2]*wz)/Math.hypot(wx,wz));surfaceKinds[entry.index]=height>rise*.05?1:0;
  }
  refined.faces=records.map(record=>record.index);
}
function refineRockFaces(vertices,faces,vertexUV,surfaceKinds,center,inner,seed,grid){
  const random=randomFromSeed(`${seed}:rock-terraces-v1`),candidates=[],selected=[],refined=[],controls=[];
  for(let face=0;face<(TOP_X-1)*(TOP_Y-1)*2;face++){
    const indices=faces[face],a=vertices[indices[0]],b=vertices[indices[1]],c=vertices[indices[2]];
    const column=Math.floor(face/2)%(TOP_X-1),row=Math.floor(face/(2*(TOP_X-1)));
    if(column<2||column>=TOP_X-3||row<2||row>=TOP_Y-3)continue;
    let height=0,maximum=-Infinity;
    for(const index of indices){const p=vertices[index],h=inner-Math.hypot(center[0]+p[0],center[2]+p[2]);height+=h/3;maximum=Math.max(maximum,h);}
    if(height<120||maximum>850)continue;
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    const px=center[0]+(a[0]+b[0]+c[0])/3,pz=center[2]+(a[2]+b[2]+c[2])/3;
    const upright=-(nx*px+nz*pz)/(Math.hypot(nx,ny,nz)*Math.hypot(px,pz));
    const slope=Math.sqrt(Math.max(0,1-upright*upright))/upright;
    if(slope>=.12&&slope<=1.1)candidates.push({face,column,row,maximum});
  }
  for(let choice=0;choice<2&&candidates.length;choice++){
    const start=Math.floor(random()*candidates.length);
    for(let attempt=0;attempt<candidates.length;attempt++){
      const candidate=candidates[(start+attempt)%candidates.length];
      if(selected.some(item=>Math.abs(item.column-candidate.column)<2&&Math.abs(item.row-candidate.row)<2))continue;
      selected.push(candidate);break;
    }
  }
  for(const candidate of selected){
    const base=faces[candidate.face].slice(),baseUV=base.map(index=>vertexUV[index]);
    const a=vertices[base[0]],b=vertices[base[1]],c=vertices[base[2]];
    const ab=b.map((n,axis)=>n-a[axis]),ac=c.map((n,axis)=>n-a[axis]);
    const abLength=Math.hypot(...ab),acLength=Math.hypot(...ac),bcLength=Math.hypot(...b.map((n,axis)=>n-c[axis])),perimeter=abLength+acLength+bcLength;
    const n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]],area2=Math.hypot(...n);
    const e1=ab.map(value=>value/abLength),unit=n.map(value=>value/area2);
    const e2=[unit[1]*e1[2]-unit[2]*e1[1],unit[2]*e1[0]-unit[0]*e1[2],unit[0]*e1[1]-unit[1]*e1[0]];
    // The incenter gives the largest safe physical footprint on an elongated
    // triangle. The axes below are scene units, not fractions of a 2km face.
    const origin=a.map((value,axis)=>(value*bcLength+b[axis]*acLength+c[axis]*abLength)/perimeter);
    const plane=base.map(index=>{const p=vertices[index].map((value,axis)=>value-origin[axis]);return[p[0]*e1[0]+p[1]*e1[1]+p[2]*e1[2],p[0]*e2[0]+p[1]*e2[1]+p[2]*e2[2]];});
    const angles=plane.map(p=>Math.atan2(p[1],p[0]));
    for(let index=1;index<3;index++)while(angles[index]<=angles[index-1])angles[index]+=TAU;
    angles.push(angles[0]+TAU);
    const inradius=area2/perimeter,major=Math.min(60+random()*60,inradius*.85),minor=major*(.70+random()*.25);
    const rise=50+random()*70,rings=[],shapePoints=[];
    // Retain the previous orientation draw so all existing point/footprint
    // streams remain stable when only the strata height recipe changes.
    random();const fracture=random()*TAU;
    const worldX=center[0]+origin[0],worldZ=center[2]+origin[2],worldRadius=Math.hypot(worldX,worldZ);
    const downX=(e1[0]*worldX+e1[2]*worldZ)/worldRadius,downY=(e2[0]*worldX+e2[2]*worldZ)/worldRadius,dip=Math.atan2(downY,downX);
    const alongExtent=Math.hypot(major*Math.cos(dip-fracture),minor*Math.sin(dip-fracture));
    const acrossExtent=Math.hypot(major*Math.sin(dip-fracture),minor*Math.cos(dip-fracture));
    let cutDirection=angles[0];
    for(let corner=1;corner<3;corner++)if(Math.cos(angles[corner]-fracture)>Math.cos(cutDirection-fracture))cutDirection=angles[corner];
    const ax=plane[0][0],ay=plane[0][1],bx=plane[1][0]-ax,by=plane[1][1]-ay,cx=plane[2][0]-ax,cy=plane[2][1]-ay,det=bx*cy-by*cx;
    const ub=baseUV[1][0]-baseUV[0][0],vb=baseUV[1][1]-baseUV[0][1],uc=baseUV[2][0]-baseUV[0][0],vc=baseUV[2][1]-baseUV[0][1],uvDet=ub*vc-vb*uc;
    const xu=(bx*vc-cx*vb)/uvDet,yu=(by*vc-cy*vb)/uvDet,xv=(cx*ub-bx*uc)/uvDet,yv=(cy*ub-by*uc)/uvDet;
    const metric=[xu*xu+yu*yu,xu*xv+yu*yv,xv*xv+yv*yv];
    function writePoint(index,x,y,h){
      const beta=((x-ax)*cy-(y-ay)*cx)/det,gamma=(bx*(y-ay)-by*(x-ax))/det,weights=[1-beta-gamma,beta,gamma];
      const p=[0,0,0],uv=[0,0];
      for(let corner=0;corner<3;corner++){
        for(let axis=0;axis<3;axis++)p[axis]+=vertices[base[corner]][axis]*weights[corner];
        uv[0]+=baseUV[corner][0]*weights[corner];uv[1]+=baseUV[corner][1]*weights[corner];
      }
      const radial=Math.hypot(center[0]+p[0],center[2]+p[2]);
      p[0]-=(center[0]+p[0])/radial*h;p[2]-=(center[2]+p[2])/radial*h;
      // Choose coarse ears in the same physical cylindrical chart used by
      // the final mesh and sampler. Reprojecting only after triangulation can
      // reverse a very thin natural-transition ear even at zero roughness.
      let angle=Math.atan2(center[2]+p[2],center[0]+p[0]);
      angle+=Math.round(((grid.minAngle+grid.maxAngle)*.5-angle)/TAU)*TAU;
      uv[0]=(angle-grid.minAngle)/(grid.maxAngle-grid.minAngle)*(grid.columns-1);
      uv[1]=(center[1]+p[1]-grid.minY)/(grid.maxY-grid.minY)*(grid.rows-1);
      // Material and vegetation consume the same actual displacement: the
      // unraised rear and its low transition remain natural slope, not a gray
      // rock ring painted over a geometrically open scarp.
      vertices[index]=p;vertexUV[index]=uv;surfaceKinds[index]=h>rise*.05?1:0;
    }
    function addPoint(x,y,h){
      const index=vertices.length;vertices.push(null);vertexUV.push(null);surfaceKinds.push(0);
      writePoint(index,x,y,h);shapePoints.push({index,x,y,h});return index;
    }
    function roofHeight(x,y){
      const along=(x*Math.cos(dip)+y*Math.sin(dip))/alongExtent,across=(-x*Math.sin(dip)+y*Math.cos(dip))/acrossExtent;
      return rise*(.64-.12*along+.07*across);
    }
    // A convex, asymmetric block perimeter supplies long straight joint faces.
    // It remains inside the same physical ellipse envelope, with a wide roof.
    const block=[[-.94,-.30],[-.66,-.74],[.40,-.87],[.94,-.34],[.94,.31],[.52,.83],[-.45,.87],[-.90,.40]],straightEdges=new Map();
    function blockRay(angle){
      const dx=(Math.cos(angle)*Math.cos(fracture)+Math.sin(angle)*Math.sin(fracture))/major;
      const dy=(-Math.cos(angle)*Math.sin(fracture)+Math.sin(angle)*Math.cos(fracture))/minor;
      let radius=Infinity,edgeIndex=-1;
      for(let edge=0;edge<block.length;edge++){
        const a=block[edge],b=block[(edge+1)%block.length],ex=b[0]-a[0],ey=b[1]-a[1],denominator=dx*ey-dy*ex;
        if(denominator===0)continue;
        const distance=(a[0]*ey-a[1]*ex)/denominator,at=(a[0]*dy-a[1]*dx)/denominator;
        if(distance>0&&at>=0&&at<=1&&distance<radius){radius=distance;edgeIndex=edge;}
      }
      if(edgeIndex<0)throw new Error('Block perimeter ray has no boundary');
      return {radius,edgeIndex};
    }
    for(const [count,lowRadius,highRadius] of [[24,1,1],[15,.82,.82],[9,.64,.64]]){
      const indices=[],coordinates=[],perSector=count/3;
      for(let index=0;index<count;index++){
        const sector=Math.floor(index/perSector),within=index%perSector;
        const fraction=(within+(within===0?0:(random()-.5)*.48))/perSector;
        const angle=angles[sector]+(angles[sector+1]-angles[sector])*fraction;
        // Physical sectors share the real base-corner directions. Equally
        // spaced 120-degree sectors would cross on a long, thin base face.
        const wave=.5+.30*Math.cos(angle-fracture+count*.31)+.2*(random()*2-1);
        const boundary=blockRay(angle),radius=boundary.radius*(lowRadius+(highRadius-lowRadius)*wave);
        const x=Math.cos(angle)*radius,y=Math.sin(angle)*radius;
        // Retain point-stream consumption so the second site's footprint
        // keeps its previous seed layout while the landform recipe changes.
        random();
        // The outer twenty-four points stay on the original slope and retain its
        // natural material. Only the compact interior is raised and bare rock.
        const pointIndex=addPoint(x,y,0);
        straightEdges.set(pointIndex,count*8+boundary.edgeIndex);
        indices.push(pointIndex);coordinates.push([x,y]);
      }
      rings.push({indices,coordinates});
    }
    let cutSector=0;
    for(let sector=1;sector<3;sector++)if(Math.abs(angles[sector]-cutDirection)<Math.abs(angles[cutSector]-cutDirection))cutSector=sector;
    const middle=rings[1],innerRing=rings[2],cutMiddle=cutSector*5,cutInner=cutSector*3;
    const pointByIndex=new Map(shapePoints.map(point=>[point.index,point]));
    for(const ring of rings.slice(1))for(const index of ring.indices){const p=pointByIndex.get(index);p.h=roofHeight(p.x,p.y);}
    // The opposing low bank remains soil, while the inner perimeter behind it
    // rises into a short rear cliff instead of spreading into a rounded ramp.
    let bankStart=-1,bankScore=-Infinity;
    for(let start=0;start<15;start++){
      let score=0,allowed=true;
      for(let at=0;at<4;at++){
        const index=(start+at)%15;if(index===cutMiddle||index===(cutMiddle+14)%15||index===(cutMiddle+1)%15){allowed=false;break;}
        const p=pointByIndex.get(middle.indices[index]);score-=Math.cos(Math.atan2(p.y,p.x)-fracture);
      }
      if(allowed&&score>bankScore){bankScore=score;bankStart=start;}
    }
    for(let at=0;at<4;at++)pointByIndex.get(middle.indices[(bankStart+at)%15]).h=0;
    pointByIndex.get(middle.indices[cutMiddle]).h=0;
    pointByIndex.get(innerRing.indices[cutInner]).h=0;
    for(const at of[(cutMiddle+14)%15,(cutMiddle+1)%15])pointByIndex.get(middle.indices[at]).h*=.55;
    pointByIndex.get(innerRing.indices[(cutInner+4)%9]).h*=.55;
    let shoulder=null;
    for(let at=0;at<15;at++){
      if(at===cutMiddle||at===(cutMiddle+14)%15||at===(cutMiddle+1)%15)continue;
      const p=pointByIndex.get(middle.indices[at]);if(p.h>0&&(!shoulder||p.h>shoulder.h))shoulder=p;
    }
    shoulder.h=rise;
    for(const p of shapePoints)writePoint(p.index,p.x,p.y,p.h);
    const localFaces=[];
    let outer={indices:base};
    for(const ring of rings){
      const outside=outer.indices.length/3,inside=ring.indices.length/3;
      for(let sector=0;sector<3;sector++){
        const polygon=[];
        for(let at=0;at<=outside;at++)polygon.push(outer.indices[(sector*outside+at)%outer.indices.length]);
        for(let at=0;at<=inside;at++)polygon.push(ring.indices[((sector+1)*inside-at)%ring.indices.length]);
        triangulateRockSector(polygon,vertexUV,localFaces,metric,vertices,center,straightEdges);
      }
      outer=ring;
    }
    // Triangulate the broad roof directly. The low interior point belongs only
    // to the cleft corner, so the whole roof no longer fans into one low centre.
    const roofFaces=[];triangulateRockSector(outer.indices.slice(),vertexUV,roofFaces,metric,vertices,center,straightEdges);
    const cutVertex=innerRing.indices[cutInner];let notch=-1,notchArea=-1;
    for(let at=0;at<roofFaces.length;at++)if(roofFaces[at].includes(cutVertex)){
      const [a,b,c]=roofFaces[at].map(index=>vertexUV[index]),area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      if(area>notchArea){notchArea=area;notch=at;}
    }
    const notchFace=roofFaces[notch],cutPoint=pointByIndex.get(cutVertex),other=notchFace.filter(index=>index!==cutVertex).map(index=>pointByIndex.get(index));
    const peak=addPoint(cutPoint.x*.86+(other[0].x+other[1].x)*.07,cutPoint.y*.86+(other[0].y+other[1].y)*.07,0);
    for(let at=0;at<roofFaces.length;at++){
      const [a,b,c]=roofFaces[at];
      if(at===notch)localFaces.push([a,b,peak],[b,c,peak],[c,a,peak]);else localFaces.push([a,b,c]);
    }
    const actual=[candidate.face];faces[candidate.face]=localFaces[0];
    for(let index=1;index<localFaces.length;index++){actual.push(faces.length);faces.push(localFaces[index]);}
    const record={face:candidate.face,base,faces:actual};refined.push(record);
    controls.push({refined:record,rise,normal:unit,basePoint:a,boundary:rings[0].indices,outsideCount:base.length+rings[0].indices.length});
  }
  for(let index=0;index<controls.length;index++)subdivideRockSurface(vertices,faces,vertexUV,surfaceKinds,center,grid,controls[index],`${seed}:${index}`);
  return refined;
}
function meshPatch({inner,angle,minAngle,maxAngle,minY,maxY,sources,depth,seed}){
  const span=maxAngle-minAngle;
  const {topBurial,bottomBurial}=ringHabitatPatchBurial({inner,depth,minAngle,maxAngle});
  if(bottomBurial>depth*2)return null;
  const center=[Math.cos(angle)*inner,(minY+maxY)/2,Math.sin(angle)*inner];
  const vertices=[],faces=[];
  const profile=createRingHabitatSourceProfile({inner,angle,minAngle,maxAngle,minY,maxY,sources,depth,seed});
  function point(phi,y,height){
    const radial=inner-height;
    vertices.push([radial*Math.cos(phi)-center[0],y-center[1],radial*Math.sin(phi)-center[2]]);
  }
  for(let y=0;y<TOP_Y;y++)for(let x=0;x<TOP_X;x++){
    const phi=minAngle+span*x/(TOP_X-1),axis=minY+(maxY-minY)*y/(TOP_Y-1);
    const edge=smooth(Math.min(1,Math.min(x,TOP_X-1-x)/2))*smooth(Math.min(1,Math.min(y,TOP_Y-1-y)/2));
    point(phi,axis,profile.sampleBaseHeight(phi,axis)*edge-topBurial*(1-edge));
  }
  for(let y=0;y<TOP_Y-1;y++)for(let x=0;x<TOP_X-1;x++){
    const a=y*TOP_X+x,b=a+1,c=a+TOP_X,d=c+1;
    if((x+y)%2)faces.push([a,b,d],[a,d,c]);else faces.push([a,b,c],[b,d,c]);
  }
  const baseOffset=vertices.length;
  for(let y=0;y<BASE_Y;y++)for(let x=0;x<BASE_X;x++)point(minAngle+span*x/(BASE_X-1),minY+(maxY-minY)*y/(BASE_Y-1),-bottomBurial);
  for(let y=0;y<BASE_Y-1;y++)for(let x=0;x<BASE_X-1;x++){
    const a=baseOffset+y*BASE_X+x,b=a+1,c=a+BASE_X,d=c+1;
    faces.push([a,c,b],[b,c,d]);
  }
  const upper=perimeter(TOP_X,TOP_Y),lower=perimeter(BASE_X,BASE_Y,baseOffset);
  let upperAt=0;
  for(let edge=0;edge<lower.length;edge++){
    const bottom=lower[edge],next=lower[(edge+1)%lower.length],count=edge===BASE_X-1||edge===lower.length-1?TOP_Y-1:4;
    for(let k=0;k<count;k++)faces.push([upper[(upperAt+k+1)%upper.length],upper[(upperAt+k)%upper.length],bottom]);
    faces.push([upper[(upperAt+count)%upper.length],bottom,next]);upperAt+=count;
  }
  const vertexUV=vertices.map((_,index)=>index<TOP_X*TOP_Y?[index%TOP_X,Math.floor(index/TOP_X)]:null);
  const surfaceKinds=vertices.map(()=>0);
  const topGrid={columns:TOP_X,rows:TOP_Y,minAngle,maxAngle,minY,maxY,innerRadius:inner};
  const refinedFaces=refineRockFaces(vertices,faces,vertexUV,surfaceKinds,center,inner,seed,topGrid);
  const normals=vertices.map(()=>[0,0,0]);
  for(const face of faces){
    const [a,b,c]=face.map(index=>vertices[index]),ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];
    for(const index of face)for(let axis=0;axis<3;axis++)normals[index][axis]+=n[axis];
  }
  for(const normal of normals){const size=Math.hypot(...normal);for(let axis=0;axis<3;axis++)normal[axis]/=size;}
  return buildTerrainMesh({center,radius:Math.max(...vertices.map(v=>Math.hypot(...v))),vertices,faces,normals,topGrid,vertexUV,refinedFaces,surfaceKinds});
}

/** Static 33x17 landscapes, curved 9x2 buried bases and up to two inset
 * rock surfaces with two conforming microgeometry levels. Patches remain
 * within 2048 vertices / 4096 triangles. CPU
 * and GPU share one closed mesh/BVH; no overlapping additional rock shells.
 * Opt-in regions mode keeps the same candidate/admission RNG stream but emits
 * compact immutable halo-field-v1 site recipes, with no eager terrain mesh.
 * Lengths are scene L; canonical field/region owners build geometry lazily.
 */
export function createRingHabitat({radius,halfWidth,thickness,phase,broken,parts,theme,seed,terrainMode='legacy'}){
  if(terrainMode!=='legacy'&&terrainMode!=='regions')throw new TypeError('Unsupported ring habitat terrain mode');
  if(![radius,halfWidth,thickness,phase].every(Number.isFinite)||radius<=0||halfWidth<=0||halfWidth>=1||thickness<=0||thickness>=1/1.45||typeof broken!=='boolean')throw new RangeError('Invalid ring habitat cross section');
  if(!Array.isArray(parts)||parts.length<3)throw new TypeError('Ring habitat requires the three original core slabs');
  const depth=radius*thickness,inner=radius-depth,outer=radius+depth,core=parts.slice(0,3);
  for(const part of core)if(part.type!=='annular-sector-slab'||![part.innerRadius,part.outerRadius,part.minY,part.maxY,part.gapCenter,part.gapHalfAngle].every(Number.isFinite)||part.minY>=part.maxY||part.innerRadius>inner||part.outerRadius<outer||part.gapHalfAngle<0||part.gapHalfAngle>Math.PI)throw new RangeError('Ring habitat core does not contain its declared cross section');
  if(typeof seed!=='string'&&(!Number.isInteger(seed)||seed<0||seed>0xffffffff))throw new TypeError('Ring habitat seed must be a string or unsigned 32-bit integer');
  const random=randomFromSeed(`${typeof seed}:${seed}:ring-habitat-terrain-v1`),bands=[];
  for(const part of core.slice().sort((a,b)=>a.minY-b.minY)){
    const last=bands[bands.length-1];
    if(last&&part.minY<=last[1])last[1]=Math.max(last[1],part.maxY);else bands.push([part.minY,part.maxY]);
  }
  const terrainGroups=[],terrainRecipes=[],pitch=TAU/32,climate=CLIMATES.get(theme)??0;
  for(let site=0;site<32;site++){
    const angle=phase+(site+.5+(random()-.5)*.3)*pitch;
    const referenceLength=Math.min(11000+random()*10000,radius*pitch*.13),referenceWidth=3500+random()*3000;
    const sources=[];let minY=Infinity,maxY=-Infinity,minAngle=Infinity,maxAngle=-Infinity;
    for(let index=0;index<8;index++){
      const main=index<5,along=(main?(index-2)*.75:(index-6)*.75)+(random()-.5)*.25;
      const bodyAngle=angle+along*referenceLength/inner;
      const across=(main?(random()-.5)*.55:(index%2?1:-1)*(.6+random()*.6))*referenceWidth;
      const length=referenceLength*(main?.75+random()*.55:.55+random()*.35);
      const width=referenceWidth*(.65+random()*.6),rotation=(random()-.5)*(main?.6:1.3),burial=depth*(.16+random()*.18);
      const height=main?(index===2&&site%7===0?3000:700+random()*1800):150+random()*450;
      const cr=Math.cos(rotation),sr=Math.sin(rotation),baseCount=main?8:6,peaks=[];
      const detailRandom=randomFromSeed(`${typeof seed}:${seed}:ring-habitat-shoulders-v1:${site}:${index}`);
      // Preserve the published candidate stream: its six original base
      // samples and two peak samples keep all site/source positions stable.
      for(let vertex=0;vertex<baseCount+2;vertex++){
        let u,v,h;
        if(vertex<baseCount){
          const sample=vertex<6?random:detailRandom,a=vertex*TAU/baseCount+(sample()-.5)*.13,scale=.88+sample()*.2;
          u=Math.cos(a)*length*.5*scale;v=Math.sin(a)*width*.5*scale;h=-burial;
        }else{
          u=(vertex===baseCount?-.2:.2)*length+(random()-.5)*length*.06;
          v=(random()-.5)*width*.3;h=height*(.78+random()*.22);peaks.push([u,v,h]);
        }
        const tangent=u*cr-v*sr,axis=across+u*sr+v*cr;
        const phi=bodyAngle+Math.atan2(tangent,inner-h);
        minY=Math.min(minY,axis);maxY=Math.max(maxY,axis);minAngle=Math.min(minAngle,phi);maxAngle=Math.max(maxAngle,phi);
      }
      sources.push({angle:bodyAngle,y:across,length,width,cr,sr,peaks});
    }
    const extent=maxY-minY,available=bands.map(band=>Math.max(0,band[1]-band[0]-extent));
    const total=available.reduce((sum,n)=>sum+n,0),yChoice=random();
    if(referenceLength<8000||total<=0)continue;
    let admitted=true;
    for(const part of core)if(part.gapHalfAngle>0&&angleDistance((minAngle+maxAngle)/2,part.gapCenter)<=part.gapHalfAngle+(maxAngle-minAngle)/2)admitted=false;
    if(!admitted)continue;
    let offset=yChoice*total,bandIndex=0;
    while(bandIndex<bands.length-1&&offset>=available[bandIndex])offset-=available[bandIndex++];
    const shiftY=bands[bandIndex][0]+offset-minY;
    for(const source of sources)source.y+=shiftY;
    const patch={inner,angle,minAngle,maxAngle,minY:minY+shiftY,maxY:maxY+shiftY,sources,depth,seed:`${typeof seed}:${seed}:${site}`};
    if(terrainMode==='regions'){
      if(ringHabitatPatchBurial(patch).bottomBurial>depth*2)continue;
      terrainRecipes.push({version:RING_HABITAT_FIELD_VERSION,lengthUnit:'L',siteIndex:site,seed:patch.seed,climate,innerRadius:inner,depth,angle,minAngle,maxAngle,minY:patch.minY,maxY:patch.maxY,sources});
    }else{
      const group=meshPatch(patch);if(group)terrainGroups.push(group);
    }
  }
  return freeze(terrainMode==='regions'?{climate,ecology:RING_HABITAT_ECOLOGY[climate],terrainGroups,terrainRecipes}:{climate,ecology:RING_HABITAT_ECOLOGY[climate],terrainGroups});
}
