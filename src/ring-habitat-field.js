import {hashSeed} from './random.js';

/** Canonical scene-length L field. This is deterministic artistic terrain,
 * not a hydrology/erosion simulation. Camera-independent samples become the
 * shared physical 16L triangle lattice at the region registry owner. */
export const RING_HABITAT_FIELD_VERSION='halo-field-v1';
export const RING_HABITAT_FIELD_LATTICE_L=16;
export const RING_HABITAT_REGION_SIZE_L=256;
export const RING_HABITAT_RIVER_BANK_DISTANCE=1;
// Cold-query radial envelope: normalized source controls cap at3000L;
// broad/narrow shoulders add at most22.5L+20L; static interior detail
// adds at most64L. Water/shore and the submerged minimum stay unchanged.
export const RING_HABITAT_FIELD_MIN_HEIGHT_L=-24;
export const RING_HABITAT_FIELD_MAX_HEIGHT_L=3106.5;
const TAU=Math.PI*2,TOP_X=33,TOP_Y=17,BASE_X=9;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const smooth=x=>{x=clamp(x,0,1);return x*x*(3-2*x);};
const hash=(seed,x,y,salt)=>{
 let h=(seed^Math.imul(x,0x9e3779b1)^Math.imul(y,0x85ebca6b)^Math.imul(salt,0xc2b2ae35))>>>0;
 h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);
 return ((h^(h>>>16))>>>0)/4294967296;
};
export function ringHabitatNoise(x,y,seed){
  const ix=Math.floor(x),iy=Math.floor(y),fx=smooth(x-ix),fy=smooth(y-iy);
  const sample=(a,b)=>{
    let h=Math.imul(a^seed,0x9e3779b1)^Math.imul(b,0x85ebca6b);
    h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);
    return ((h^(h>>>16))>>>0)/2147483648-1;
  };
  const a=sample(ix,iy),b=sample(ix+1,iy),c=sample(ix,iy+1),d=sample(ix+1,iy+1);
  return (a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy;
}
/** Source-profile arithmetic is also consumed by the legacy mesh owner.
 * It retains its published 33x17 control grid and RNG independently of the
 * new sparse interior. No mesh or BVH is constructed here. */
export function ringHabitatPatchBurial({inner,depth,minAngle,maxAngle}){
 const step=(maxAngle-minAngle)/(TOP_X-1),baseStep=(maxAngle-minAngle)/(BASE_X-1);
 const topBurial=inner*(1/Math.cos(step/2)-1)+Math.min(24,depth*.08);
 const bottomBurial=(inner+topBurial+Math.min(32,depth*.12))/Math.cos(baseStep/2)-inner;
 return {topBurial,bottomBurial};
}
export function createRingHabitatSourceProfile({inner,angle,minAngle,maxAngle,minY,maxY,sources,depth,seed}){
 const span=maxAngle-minAngle,step=span/(TOP_X-1),noiseSeed=hashSeed(`${seed}:height-grid-v1`);
 const spacing=Math.max(inner*step,(maxY-minY)/(TOP_Y-1));
 const ridgeSeeds=sources.map((_,index)=>hashSeed(`${seed}:branch-ridge-v1:${index}`));
 const {topBurial,bottomBurial}=ringHabitatPatchBurial({inner,depth,minAngle,maxAngle});
  function height(phi,y){
    let result=0;
    for(let index=0;index<sources.length;index++){
      const source=sources[index],first=source.peaks[0],last=source.peaks[1];
      const tangent=(phi-source.angle)*inner,axis=y-source.y;
      const u=tangent*source.cr+axis*source.sr,v=-tangent*source.sr+axis*source.cr;
      const along=(u-first[0])/(last[0]-first[0]),at=Math.max(0,Math.min(1,along));
      const beyond=Math.max(first[0]-u,u-last[0],0)/(source.length*.32);
      if(beyond>=1)continue;
      const endEnvelope=(1-beyond*beyond)**2;
      const bendScale=Math.max(source.length*.65,spacing*3);
      const crestV=first[1]+(last[1]-first[1])*at
        +source.width*.12*ringHabitatNoise(u/bendScale,source.angle*7,ridgeSeeds[index]);
      const saddle=Math.sin(Math.PI*at)**2;
      const crestHeight=(first[2]+(last[2]-first[2])*at)*(1-.24*saddle);
      // A crest has a finite cross-slope rather than the zero summit
      // derivative of an elliptical dome. Broad shoulders stay resolvable
      // by this mesh; no sub-grid spikes or extra normal-only relief.
      const halfWidth=Math.max(source.width*.55,spacing*.85);
      const main=crestHeight*endEnvelope*Math.max(0,1-Math.abs(v-crestV)/halfWidth)**1.35;
      const branchAt=(u-first[0])/(last[0]-first[0]+source.length*.2);
      let branch=0;
      if(branchAt>=0&&branchAt<=1){
        const sign=(ridgeSeeds[index]&1)?1:-1;
        const branchV=crestV+sign*source.width*.7*branchAt;
        const branchWidth=Math.max(source.width*.3,spacing*.75);
        branch=crestHeight*.7*(1-branchAt*branchAt)
          *Math.max(0,1-Math.abs(v-branchV)/branchWidth)**1.35;
      }
      // One broad oblique valley connects the saddle to the flank. Its
      // width is at least two grid intervals, so its depth is actual mesh
      // geometry rather than unresolved, alternating sample noise.
      const valleyU=(first[0]+last[0])/2+(v-crestV)*.35;
      const valleyWidth=Math.max(spacing*1.1,Math.min(3500,source.length*.18));
      const valley=Math.max(0,1-Math.abs(u-valleyU)/valleyWidth);
      const cut=Math.min(500,crestHeight*.2)*valley*valley
        *Math.min(1,Math.abs(v-crestV)/(halfWidth*.5));
      const candidate=Math.max(0,Math.max(main,branch)-cut);
      if(candidate===0)continue;
      const overlap=Math.max(0,80-Math.abs(result-candidate))/80*smooth(Math.min(result,candidate)/80);
      result=Math.max(result,candidate)+overlap*overlap*20;
    }
    const x=(phi-angle)*inner,coarse=Math.max(4500,spacing*3),detail=Math.max(1800,spacing*1.8);
    return Math.min(3000,result*(.9+.1*ringHabitatNoise(x/coarse,y/coarse,noiseSeed)+.035*ringHabitatNoise(x/detail,y/detail,noiseSeed^0x7ac39d)));
  }
 return {sampleBaseHeight:height,topBurial,bottomBurial};
}

function edgeRoots(a,b,radius){
 const dx=b[0]-a[0],dz=b[2]-a[2],A=dx*dx+dz*dz,B=2*(a[0]*dx+a[2]*dz),C=a[0]*a[0]+a[2]*a[2]-radius*radius;
 if(A===0)return C===0?[0,1]:[];
 const d=B*B-4*A*C;if(d<0)return[];
 const q=-.5*(B+(B>=0?1:-1)*Math.sqrt(d)),roots=q===0?[-B/(2*A)]:[q/A,C/q];
 return roots.filter((t,i)=>t>=-1e-10&&t<=1+1e-10&&roots.findIndex(v=>Math.abs(v-t)<1e-10)===i).map(t=>clamp(t,0,1));
}
/** Cold construction helper: clip the actual plane/cylinder conic to one
 * finite triangle. Boundary events are sorted in the conic parameter; an
 * interval is admitted only when its interior lies in the triangle. */
export function clipRingHabitatShoreTriangle(points,R,referenceAngle=0){return clipShoreTriangle(points,R,referenceAngle,null);}
function clipShoreTriangle(points,R,referenceAngle,sharedEdges){
 const[a,b,c]=points,ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
 if(!(R>0)||!Number.isFinite(R)||Math.hypot(nx,ny,nz)===0)throw new RangeError('Invalid finite shoreline triangle/cylinder');
 const plane={nx,ny,nz,D:nx*a[0]+ny*a[1]+nz*a[2],origin:a},hits=[],arcs=[];
 const hitTolerance=64*Number.EPSILON*Math.max(1,R,...points.flat().map(Math.abs));
 const unwrap=phi=>phi+Math.round((referenceAngle-phi)/TAU)*TAU;
 const drop=Math.abs(nx)>Math.abs(ny)?(Math.abs(nx)>Math.abs(nz)?0:2):(Math.abs(ny)>Math.abs(nz)?1:2),i=(drop+1)%3,j=(drop+2)%3;
 const orientation=(b[i]-a[i])*(c[j]-a[j])-(b[j]-a[j])*(c[i]-a[i]),sign=Math.sign(orientation);
 function inside(p){for(let e=0;e<3;e++){const q=points[e],v=points[(e+1)%3],one=(v[i]-q[i])*(p[j]-q[j]),two=(v[j]-q[j])*(p[i]-q[i]),error=64*Number.EPSILON*(Math.abs(one)+Math.abs(two)+Math.abs(orientation));if((one-two)*sign< -error)return false;}return true;}
 function onCurve(phi){const x=R*Math.cos(phi),z=R*Math.sin(phi);return [x,a[1]-(nx*(x-a[0])+nz*(z-a[2]))/ny,z];}
 for(let e=0;e<3;e++){
  if(sharedEdges){for(const event of sharedEdges[e])if(!hits.some(h=>Math.hypot(Math.atan2(Math.sin(h[0]-event[0]),Math.cos(h[0]-event[0]))*R,h[1]-event[1])<hitTolerance))hits.push(event);}
  else{const p=points[e],q=points[(e+1)%3];for(const t of edgeRoots(p,q,R)){const v=p.map((value,k)=>value+(q[k]-value)*t),phi=unwrap(Math.atan2(v[2],v[0]));if(!hits.some(h=>Math.hypot(Math.atan2(Math.sin(h[0]-phi),Math.cos(h[0]-phi))*R,h[1]-v[1])<hitTolerance))hits.push([phi,v[1]]);}}
 }
 let tangencies=0;
 if(ny!==0){
  const events=hits.slice().sort((p,q)=>p[0]-q[0]),intervals=[];
  if(events.length===0){const lo=referenceAngle-Math.PI,hi=referenceAngle+Math.PI;if(inside(onCurve(referenceAngle)))arcs.push({a:[lo,onCurve(lo)[1]],b:[hi,onCurve(hi)[1]],parameter:'phi',crossing:true});}
  else{
   for(let k=0;k<events.length;k++){const lo=events[k][0],hi=k+1<events.length?events[k+1][0]:events[0][0]+TAU;intervals.push(inside(onCurve((lo+hi)*.5)));}
   for(let k=0;k<events.length;k++){
    if(intervals[k]===intervals[(k+events.length-1)%events.length])tangencies++;
    if(!intervals[k])continue;const lo=events[k][0],hi=k+1<events.length?events[k+1][0]:events[0][0]+TAU;
    if(hi<=lo)continue;const first=events[k],last=events[(k+1)%events.length];arcs.push({a:sharedEdges?first:[lo,onCurve(lo)[1]],b:sharedEdges?(k+1<events.length?last:[hi,last[1]]):[hi,onCurve(hi)[1]],parameter:'phi',crossing:true});
   }
   // Preserve the old numerics only after proving that its two endpoints
   // delimit one short, wholly admitted arc; multi-arc bays use true phi.
   if(hits.length===2&&arcs.length===1&&arcs[0].b[0]-arcs[0].a[0]<Math.PI){arcs[0].a=hits[0];arcs[0].b=hits[1];arcs[0].parameter='legacy';}
  }
 }else{
  const norm=Math.hypot(nx,nz),branches=[];
  // In this vertical plane the two cylinder branches have opposite signed
  // coordinates on its horizontal tangent axis. Use actual edge events to
  // identify them, avoiding acos conditioning near a tangent plane.
  for(const h of hits){const tangent=R*(-nz*Math.cos(h[0])+nx*Math.sin(h[0]))/norm,label=Math.abs(tangent)<=hitTolerance?0:Math.sign(tangent);let branch=branches.find(g=>g.label===label);if(!branch){branch={label,phi:h[0],ys:[]};branches.push(branch);}if(!branch.ys.some(y=>Math.abs(y-h[1])<hitTolerance))branch.ys.push(h[1]);}
  for(const branch of branches){const{phi,ys,label}=branch;
   if(!sharedEdges){ys.length=0;
   const target=(-nz*(R*Math.cos(phi)-a[0])+nx*(R*Math.sin(phi)-a[2]))/norm;
   for(let e=0;e<3;e++){const p=points[e],q=points[(e+1)%3],ta=(-nz*(p[0]-a[0])+nx*(p[2]-a[2]))/norm,tb=(-nz*(q[0]-a[0])+nx*(q[2]-a[2]))/norm;
    if(ta===tb){if(Math.abs(target-ta)<=hitTolerance)for(const y of [p[1],q[1]])if(!ys.some(v=>Math.abs(v-y)<hitTolerance))ys.push(y);}
    else if(target>=Math.min(ta,tb)-hitTolerance&&target<=Math.max(ta,tb)+hitTolerance){const t=clamp((target-ta)/(tb-ta),0,1),y=p[1]+(q[1]-p[1])*t;if(!ys.some(v=>Math.abs(v-y)<hitTolerance))ys.push(y);}
   }
   }
   ys.sort((p,q)=>p-q);if(ys.length===1)tangencies++;
   for(let k=0;k+1<ys.length;k++){const low=ys[k],high=ys[k+1];if(high<=low||!inside([R*Math.cos(phi),(low+high)*.5,R*Math.sin(phi)]))continue;const crossing=label!==0;arcs.push({a:[phi,low],b:[phi,high],parameter:'vertical',crossing});if(!crossing)tangencies++;}
  }
  if(hits.length===2&&arcs.length===1&&arcs[0].crossing){arcs[0].a=hits[0];arcs[0].b=hits[1];arcs[0].parameter='legacy';}
 }
 return {plane,arcs,crossings:hits.length,tangencies};
}
export function createRetainedShoreline(patch,{heightL=12,cellSize=1024,maxDeviationL=.25,maxDepth=12,maxSegments=65536,sourceId='source'}={}){
 const grid=patch.topGrid,inner=grid.innerRadius,R=inner-heightL,angle0=grid.minAngle,width=(grid.maxAngle-angle0)*inner,height=grid.maxY-grid.minY,middle=(grid.minAngle+grid.maxAngle)/2;
 const metric=R/inner,segments=[];let maxMeasuredDeviation=0,splitTriangles=0,tangentTriangles=0,contourArcs=0;
 // Whole-mesh construction owns shared edge events. Canonical vertex order
 // and sorted root ordinal compute each event once for both adjacent faces.
 const worldVertices=patch.vertices.map(v=>v.map((n,a)=>n+patch.center[a])),edgeEvents=new Map();
 function sharedEdge(a,b){if(a>b)[a,b]=[b,a];const key=a+':'+b,old=edgeEvents.get(key);if(old)return old;
  const p=worldVertices[a],q=worldVertices[b],events=edgeRoots(p,q,R).sort((a,b)=>a-b).map(t=>{const v=t===0?p:t===1?q:p.map((n,a)=>n+(q[a]-n)*t);let phi=Math.atan2(v[2],v[0]);phi+=Math.round((middle-phi)/TAU)*TAU;return [phi,v[1]];});edgeEvents.set(key,events);return events;
 }
 function addArc(a,b,plane,depth,parameter='legacy',crossing=true){
  const du=(b[0]-a[0])*metric,dv=b[1]-a[1],x=(a[0]+b[0])*.5,y=(a[1]+b[1])*.5;let mid;
  if(parameter==='vertical')mid=[x,y];
  else if(parameter==='phi'){const phi=angle0+x/inner,o=plane.origin;mid=[x,o[1]-(plane.nx*(R*Math.cos(phi)-o[0])+plane.nz*(R*Math.sin(phi)-o[2]))/plane.ny-grid.minY];}
  else if(Math.abs(du)>=Math.abs(dv)&&plane.ny!==0){const phi=angle0+x/inner;mid=[x,(plane.D-R*(plane.nx*Math.cos(phi)+plane.nz*Math.sin(phi)))/plane.ny-grid.minY];}
  else{
   const axis=grid.minY+y,norm=Math.hypot(plane.nx,plane.nz),phase=Math.atan2(plane.nz,plane.nx),c=clamp((plane.D-plane.ny*axis)/(R*norm),-1,1),v=Math.acos(c),target=angle0+x/inner;
   let p=phase+v,q=phase-v;p+=Math.round((target-p)/TAU)*TAU;q+=Math.round((target-q)/TAU)*TAU;const phi=Math.abs(p-target)<Math.abs(q-target)?p:q;mid=[(phi-angle0)*inner,y];
  }
  const deviation=Math.hypot((mid[0]-x)*metric,mid[1]-y);
  const phiSpan=(b[0]-a[0])/inner,curveBound=parameter==='phi'?R*Math.hypot(plane.nx,plane.nz)/Math.abs(plane.ny)*phiSpan*phiSpan/8:deviation;
  if(Math.max(deviation,curveBound)>maxDeviationL){if(depth===maxDepth)throw new RangeError('Retained shoreline curve exceeded finite subdivision budget: '+sourceId);addArc(a,mid,plane,depth+1,parameter,crossing);addArc(mid,b,plane,depth+1,parameter,crossing);return;}
  maxMeasuredDeviation=Math.max(maxMeasuredDeviation,deviation);if(Math.hypot(du,dv)>1e-8){if(segments.length===maxSegments)throw new RangeError('Retained shoreline exceeded finite segment budget: '+sourceId);segments.push(Object.freeze({a:Object.freeze(a),b:Object.freeze(b),crossing}));}
 }
 for(let fi=0;fi<patch.faces.length;fi++){
  const face=patch.faces[fi];if(!face.every(i=>patch.vertexUV[i]!==null))continue;
  const points=face.map(i=>worldVertices[i]),events=face.map((i,e)=>sharedEdge(i,face[(e+1)%3])),clipped=clipShoreTriangle(points,R,middle,events);
  if(clipped.arcs.length>1)splitTriangles++;if(clipped.tangencies)tangentTriangles++;contourArcs+=clipped.arcs.length;
  for(const arc of clipped.arcs)addArc([(arc.a[0]-angle0)*inner,arc.a[1]-grid.minY],[(arc.b[0]-angle0)*inner,arc.b[1]-grid.minY],clipped.plane,0,arc.parameter,arc.crossing);
 }
 edgeEvents.clear();worldVertices.length=0;
 if(!segments.length)return null;
 const columns=Math.ceil(width/cellSize),rows=Math.ceil(height/cellSize);if(columns*rows>4096)throw new RangeError('Shoreline index exceeds declared 4096 cells');
 const count=segments.length;if(count===0)throw new RangeError('Shoreline segment BVH requires a nonempty finite contour');
 const rowIndex=Array.from({length:rows},()=>[]),cellCounts=new Uint32Array(columns*rows);
 for(let i=0;i<count;i++){
  const{a,b}=segments[i],x0=clamp(Math.floor(Math.min(a[0],b[0])/cellSize),0,columns-1),x1=clamp(Math.floor(Math.max(a[0],b[0])/cellSize),0,columns-1),y0=clamp(Math.floor(Math.min(a[1],b[1])/cellSize),0,rows-1),y1=clamp(Math.floor(Math.max(a[1],b[1])/cellSize),0,rows-1);
  for(let y=y0;y<=y1;y++){rowIndex[y].push(i);for(let x=x0;x<=x1;x++)cellCounts[y*columns+x]++;}
 }
 // Balanced, immutable segment BVH: every segment has exactly one leaf slot.
 // Median splitting at leafSize8 needs at most29 splits even at the JS
 // array length limit (13 for the existing65536 default contour budget).
 // One instance-owned32-slot query stack is sufficient, with no hot allocation.
 const leafSize=8;let leaves=1;while(leaves<Math.ceil(count/leafSize))leaves*=2;const capacity=leaves*2-1,bounds=new Float64Array(capacity*4),children=new Int32Array(capacity*2),ids=new Uint32Array(count),stack=new Int32Array(32);for(let i=0;i<count;i++)ids[i]=i;let nodeCount=0,bvhMaxDepth=0;
 function compareX(i,j){const a=segments[i],b=segments[j];return(a.a[0]+a.b[0])-(b.a[0]+b.b[0])||i-j;}
 function compareY(i,j){const a=segments[i],b=segments[j];return(a.a[1]+a.b[1])-(b.a[1]+b.b[1])||i-j;}
 function build(first,last,depth){const node=nodeCount++,o=node*4;bvhMaxDepth=Math.max(bvhMaxDepth,depth);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let k=first;k<last;k++){const{a,b}=segments[ids[k]],qx=a[0]+(b[0]-a[0]),qy=a[1]+(b[1]-a[1]);minX=Math.min(minX,a[0],b[0],qx);minY=Math.min(minY,a[1],b[1],qy);maxX=Math.max(maxX,a[0],b[0],qx);maxY=Math.max(maxY,a[1],b[1],qy);}
  // Include the exact rounded t=1 projection. Monotone multiply/add for
  // t in[0,1] stays inside these bounds, even if a+(b-a) differs from b.
  bounds[o]=minX;bounds[o+1]=minY;bounds[o+2]=maxX;bounds[o+3]=maxY;
  if(last-first<=leafSize){children[node*2]=first-last;children[node*2+1]=first;return node;}
  ids.subarray(first,last).sort((maxX-minX)*metric>=maxY-minY?compareX:compareY);const middle=first+Math.floor((last-first)/2);children[node*2]=build(first,middle,depth+1);children[node*2+1]=build(middle,last,depth+1);return node;
 }
 build(0,count,0);
 // Original nearest tie order was ring -> cell row -> cell column -> segment
 // insertion ID. Compute its first cell occurrence only for a distance winner;
 // traversal order is consequently free to visit each segment just once.
 function originalRank(id,cx,cy){const{a,b}=segments[id],x0=clamp(Math.floor(Math.min(a[0],b[0])/cellSize),0,columns-1),x1=clamp(Math.floor(Math.max(a[0],b[0])/cellSize),0,columns-1),y0=clamp(Math.floor(Math.min(a[1],b[1])/cellSize),0,rows-1),y1=clamp(Math.floor(Math.max(a[1],b[1])/cellSize),0,rows-1),ring=Math.max(0,x0-cx,cx-x1,y0-cy,cy-y1),iy=Math.max(y0,cy-ring),ix=Math.max(x0,cx-ring);return ring*(columns*rows)+iy*columns+ix;}
 function nodeDistance(node,x,y){const o=node*4,dx=x<bounds[o]?(bounds[o]-x)*metric:x>bounds[o+2]?(x-bounds[o+2])*metric:0,dy=y<bounds[o+1]?bounds[o+1]-y:y>bounds[o+3]?y-bounds[o+3]:0;return Math.max(dx,dy);}
 function query(x,y,out){
  const cx=clamp(Math.floor(x/cellSize),0,columns-1),cy=clamp(Math.floor(y/cellSize),0,rows-1),crossings=rowIndex[cy];let parity=0;
  for(let k=0;k<crossings.length;k++){const{a,b,crossing}=segments[crossings[k]];if(crossing&&(a[1]>y)!==(b[1]>y)){const at=a[0]+(b[0]-a[0])*(y-a[1])/(b[1]-a[1]);if(at>x)parity^=1;}}
  let best=Infinity,bestX=0,bestY=0,bestRank=Infinity,bestId=Infinity,visited=0,top=0;stack[top++]=0;
  while(top){const node=stack[--top];if(nodeDistance(node,x,y)>best)continue;const left=children[node*2],right=children[node*2+1];
   if(left>=0){const dl=nodeDistance(left,x,y),dr=nodeDistance(right,x,y);if(dl<=dr){if(dr<=best)stack[top++]=right;if(dl<=best)stack[top++]=left;}else{if(dl<=best)stack[top++]=left;if(dr<=best)stack[top++]=right;}continue;}
   const first=right>>>0;for(let k=first;k<first-left;k++){visited++;const id=ids[k],{a,b}=segments[id],dx=(b[0]-a[0])*metric,dy=b[1]-a[1],px=(x-a[0])*metric,py=y-a[1],t=clamp((px*dx+py*dy)/(dx*dx+dy*dy),0,1),qx=a[0]+(b[0]-a[0])*t,qy=a[1]+dy*t,ex=(x-qx)*metric,ey=y-qy;if(Math.abs(ex)<=best&&Math.abs(ey)<=best){const d=Math.hypot(ex,ey);if(d<=best){const rank=originalRank(id,cx,cy);if(d<best||rank<bestRank||rank===bestRank&&id<bestId){best=d;bestX=qx;bestY=qy;bestRank=rank;bestId=id;}}}}
  }
  if(!Number.isFinite(best))throw new Error('Indexed retained shoreline distance had no segment');
  out.distance=parity?best:-best;out.closestX=bestX;out.closestY=bestY;out.inside=!!parity;out.segmentTests=visited;return out;
 }
 // Declared conservative resident storage, not a VM heap measurement. Row
 // parity references are unchanged; nearest cells retain counts only during
 // construction. Include each typed backing store and its64B header.
 const nearestIndexBytes=bounds.byteLength+children.byteLength+ids.byteLength+3*64,nearestScratchBytes=stack.byteLength+64,accountedBytes=1024+128+segments.length*296+rowIndex.length*64+rowIndex.reduce((n,a)=>n+a.length,0)*8+nearestIndexBytes+nearestScratchBytes;
 return Object.freeze({accountedBytes,heightL,radius:R,metric,width,height,cellSize,columns,rows,segments:Object.freeze(segments),maxMeasuredDeviationL:maxMeasuredDeviation,splitTriangles,tangentTriangles,contourArcs,maxCellSegments:Math.max(...cellCounts),maxRowSegments:Math.max(...rowIndex.map(v=>v.length)),nearestIndex:Object.freeze({kind:'segment-bvh',leafSize,nodeCount,capacity,maxDepth:bvhMaxDepth,bytes:nearestIndexBytes,scratchBytes:nearestScratchBytes,constructionCellCountBytes:cellCounts.byteLength}),query});
}

const poly=(a,b,c,d,t)=>((a*t+b)*t+c)*t+d;
function closestQuadratic(c,x,y,out){
 const px=c.x-x,py=c.y-y,A=c.cubicA,B=c.cubicB,C=c.bx*c.bx+c.by*c.by+2*(c.ax*px+c.ay*py),D=c.bx*px+c.by*py;
 let best=px*px+py*py,bestT=0;const ex=c.ax+c.bx+px,ey=c.ay+c.by+py,end=ex*ex+ey*ey;if(end<best){best=end;bestT=1;}
 if(A===0){const t=clamp(-D/C,0,1),qx=(c.ax*t+c.bx)*t+px,qy=(c.ay*t+c.by)*t+py;out.distanceSquared=qx*qx+qy*qy;out.t=t;return out;}
 const disc=B*B-3*A*C;let c0=1,c1=1,count=0;
 if(disc>=0){const root=Math.sqrt(disc),a=(-B-root)/(3*A),b=(-B+root)/(3*A);if(a>0&&a<1){c0=a;count++;}if(b>0&&b<1&&b!==a){if(count)c1=b;else c0=b;count++;}}
 let lo=0,flo=D;
 for(let interval=0;interval<=count;interval++){
  const hi=interval===0&&count?c0:interval===1&&count===2?c1:1,fhi=poly(A,B,C,D,hi);let t=hi;
  // Cubic stationary roots are isolated by derivative critical points. A
  // fixed24 bisections gives <=6e-8 parameter uncertainty per bracket.
  if(flo*fhi<0){let a=lo,b=hi,fa=flo;for(let k=0;k<24;k++){const m=(a+b)/2,fm=poly(A,B,C,D,m);if(fa*fm<=0)b=m;else{a=m;fa=fm;}}t=(a+b)/2;}
  const qx=(c.ax*t+c.bx)*t+px,qy=(c.ay*t+c.by)*t+py,d=qx*qx+qy*qy;if(d<best){best=d;bestT=t;}
  // Critical endpoints are also candidates, including tangent stationary roots.
  const hx=(c.ax*hi+c.bx)*hi+px,hy=(c.ay*hi+c.by)*hi+py,hd=hx*hx+hy*hy;if(hd<best){best=hd;bestT=hi;}
  lo=hi;flo=fhi;
 }
 out.distanceSquared=best;out.t=bestT;return out;
}
function createBroadValleys({nodes,downstream,accumulation,shoreline,width,height,columns,rows}){
 const params=Object.freeze({catchmentThreshold:4,halfWidthMinL:600,halfWidthMaxL:1100,targetDepthMinL:80,targetDepthMaxL:150,maxRelativeCut:.4,shoulderRatio:.15,shoulderOffsetWidths:1.6,shoulderHalfWidthWidths:.6,coastFadeL:900,headFadeL:1000,closestRootBisections:24});
 const incoming=nodes.map(()=>[]);for(let i=0;i<nodes.length;i++)if(downstream[i]>=0)incoming[downstream[i]].push(i);
 const mouths=[];for(let i=0;i<nodes.length;i++){const j=downstream[i];if(j>=0&&nodes[i].h>12&&nodes[j].h<=12&&accumulation[i]>=params.catchmentThreshold)mouths.push(i);}
 const maxCatchment=Math.max(params.catchmentThreshold,...mouths.map(i=>accumulation[i])),trunks=[],curves=[],shore={};
 for(const mouth of mouths){
  const path=[mouth];let at=mouth;
  while(incoming[at].length){let chosen=-1;for(const i of incoming[at])if(chosen<0||accumulation[i]>accumulation[chosen]||(accumulation[i]===accumulation[chosen]&&(nodes[i].h>nodes[chosen].h||(nodes[i].h===nodes[chosen].h&&i<chosen))))chosen=i;path.push(chosen);at=chosen;}
  path.reverse();if(path.length<3)continue;
  const a=nodes[mouth],b=nodes[downstream[mouth]];let lo=0,hi=1;
  for(let k=0;k<40;k++){const t=(lo+hi)/2;if(shoreline.query(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,shore).inside)lo=t;else hi=t;}
  const t=(lo+hi)/2,points=path.map(i=>({x:nodes[i].x,y:nodes[i].y,w:params.halfWidthMinL+(params.halfWidthMaxL-params.halfWidthMinL)*Math.sqrt(Math.max(0,accumulation[i]-1)/Math.max(1,maxCatchment-1))}));
  points.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,w:points[points.length-1].w});
  const length=points.reduce((n,p,i)=>i?n+Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y):0,0);if(length<2200)continue;
  const id=trunks.length,targetDepth=params.targetDepthMinL+(params.targetDepthMaxL-params.targetDepthMinL)*(accumulation[mouth]-params.catchmentThreshold)/Math.max(1,maxCatchment-params.catchmentThreshold);
  const trunk={id,mouth,downstream:downstream[mouth],catchment:accumulation[mouth],path:Object.freeze(path),points:Object.freeze(points.map(Object.freeze)),targetDepthL:targetDepth,lengthL:length,curveIds:[]};let walked=0;
  for(let i=0;i<points.length;i++){
   const p=points[i],before=i?points[i-1]:p,after=i+1<points.length?points[i+1]:p,start=i?{x:(before.x+p.x)/2,y:(before.y+p.y)/2,w:(before.w+p.w)/2}:p,end=i+1<points.length?{x:(p.x+after.x)/2,y:(p.y+after.y)/2,w:(p.w+after.w)/2}:p;
   const ax=start.x-2*p.x+end.x,ay=start.y-2*p.y+end.y,bx=2*(p.x-start.x),by=2*(p.y-start.y),curve={id:curves.length,trunk:id,x:start.x,y:start.y,ax,ay,bx,by,cubicA:2*(ax*ax+ay*ay),cubicB:3*(ax*bx+ay*by),w0:start.w,w1:p.w,w2:end.w,startDistanceL:walked,lengthL:0,minX:Math.min(start.x,p.x,end.x),maxX:Math.max(start.x,p.x,end.x),minY:Math.min(start.y,p.y,end.y),maxY:Math.max(start.y,p.y,end.y)};
   let px=start.x,py=start.y;for(let k=1;k<=16;k++){const t=k/16,x=(ax*t+bx)*t+start.x,y=(ay*t+by)*t+start.y;curve.lengthL+=Math.hypot(x-px,y-py);px=x;py=y;}
   walked+=curve.lengthL;trunk.curveIds.push(curve.id);curves.push(Object.freeze(curve));
  }
  trunk.lengthL=walked;trunk.curveIds=Object.freeze(trunk.curveIds);trunks.push(Object.freeze(trunk));
 }
 const dx=width/(columns-1),dy=height/(rows-1),index=Array.from({length:columns*rows},()=>[]);
 for(const c of curves){const reach=Math.max(c.w0,c.w1,c.w2)*2.2,x0=clamp(Math.floor((c.minX-reach)/dx),0,columns-1),x1=clamp(Math.floor((c.maxX+reach)/dx),0,columns-1),y0=clamp(Math.floor((c.minY-reach)/dy),0,rows-1),y1=clamp(Math.floor((c.maxY+reach)/dy),0,rows-1);for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)index[y*columns+x].push(c.id);}
 const closest={distanceSquared:0,t:0},distance=new Float64Array(trunks.length),progress=new Float64Array(trunks.length);
 function deform(x,y,base,coastDistance,out){
  out.cutL=0;out.bankL=0;out.activeTrunks=0;if(base<=12||coastDistance<=0)return out;
  distance.fill(Infinity);progress.fill(0);const local=index[clamp(Math.floor(y/dy),0,rows-1)*columns+clamp(Math.floor(x/dx),0,columns-1)];
  for(let i=0;i<local.length;i++){const c=curves[local[i]];closestQuadratic(c,x,y,closest);const t=closest.t,width=(1-t)*(1-t)*c.w0+2*(1-t)*t*c.w1+t*t*c.w2,normalized=Math.sqrt(closest.distanceSquared)/width;if(normalized<distance[c.trunk]){distance[c.trunk]=normalized;progress[c.trunk]=c.startDistanceL+t*c.lengthL;}}
  const budget=Math.min(150,params.maxRelativeCut*(base-12)),coastFade=smooth(coastDistance/params.coastFadeL);let noCut=1,noBank=1;
  for(let i=0;i<trunks.length;i++){
   const d=distance[i];if(d>=2.2)continue;const strength=Math.min(1,trunks[i].targetDepthL/budget)*coastFade*smooth(progress[i]/params.headFadeL);if(strength===0)continue;out.activeTrunks++;
   if(d<1.2){const q=d/1.2;noCut*=1-strength*(1-q*q)**3;}
   const shoulder=(d-params.shoulderOffsetWidths)/params.shoulderHalfWidthWidths;if(Math.abs(shoulder)<1)noBank*=1-strength*(1-shoulder*shoulder)**3;
  }
  out.cutL=budget*(1-noCut);out.bankL=budget*params.shoulderRatio*(1-noBank);return out;
 }
 // The visible water uses the same centerlines as the carved valleys.
 // Only main trunks carry water. Narrower creek paths still shape dry terrain.
 let widestCatchment=params.catchmentThreshold;
 for(const trunk of trunks)widestCatchment=Math.max(widestCatchment,trunk.catchment);
 const riverCatchment=Math.ceil(widestCatchment*.75);
 function sampleRiver(x,y,out){
  out.distance=2;out.progressL=0;out.tangentX=0;out.tangentY=0;
  const local=index[clamp(Math.floor(y/dy),0,rows-1)*columns+clamp(Math.floor(x/dx),0,columns-1)];
  for(const id of local){
   const c=curves[id],trunk=trunks[c.trunk];
   if(trunk.catchment<riverCatchment)continue;
   const maxWidth=Math.max(c.w0,c.w1,c.w2),reach=maxWidth*.15+36;
   if(x<c.minX-reach||x>c.maxX+reach||y<c.minY-reach||y>c.maxY+reach)continue;
   closestQuadratic(c,x,y,closest);
   const t=closest.t,head=c.startDistanceL+t*c.lengthL;
   if(closest.distanceSquared>reach*reach)continue;
   let vx=2*c.ax*t+c.bx,vy=2*c.ay*t+c.by;
   if(vx===0&&vy===0){vx=c.ax+c.bx;vy=c.ay+c.by;}
   const length=Math.hypot(vx,vy),tx=vx/length,ty=vy/length;
   const px=x-((c.ax*t+c.bx)*t+c.x),py=y-((c.ay*t+c.by)*t+c.y);
   // Sub-valley bends stay within36L of the retained valley center and return
   // to it before entering the shore. The same phase continues across curves.
   const taper=clamp((trunk.lengthL-head)/360,0,1),mouth=smooth(taper);
   const a=head*(TAU/1180)+trunk.id*2.39996323,b=head*(TAU/470)-trunk.id*.57;
   const centerOffset=25*Math.sin(a)+11*Math.sin(b),bend=mouth*centerOffset;
   const width=(.066+.007*Math.sin(a+b))*((1-t)*(1-t)*c.w0+2*(1-t)*t*c.w1+t*t*c.w2);
   const d=Math.hypot(-px*ty+py*tx-bend,px*tx+py*ty)/width+2*(1-smooth(head/params.headFadeL));
   if(d>=out.distance)continue;
   const grade=mouth*(25*(TAU/1180)*Math.cos(a)+11*(TAU/470)*Math.cos(b))
     -6*taper*(1-taper)/360*centerOffset;
   const tangentLength=Math.hypot(1,grade);
   out.distance=d;out.progressL=head;out.tangentX=(tx-ty*grade)/tangentLength;out.tangentY=(ty+tx*grade)/tangentLength;
  }
  return out.distance<2;
 }
 const accountedBytes=2048+curves.length*320+trunks.reduce((n,t)=>n+384+t.path.length*8+t.curveIds.length*8+t.points.length*160,0)+index.length*64+index.reduce((n,a)=>n+a.length,0)*8+distance.byteLength+progress.byteLength;
 return Object.freeze({accountedBytes,params,trunks:Object.freeze(trunks),curves:Object.freeze(curves),maxIndexCurves:Math.max(...index.map(a=>a.length)),deform,sampleRiver});
}

function validateRecipe(r){
 if(!r||r.version!==RING_HABITAT_FIELD_VERSION||r.lengthUnit!=='L')throw new TypeError('Unsupported ring habitat field recipe');
 if(![r.innerRadius,r.depth,r.angle,r.minAngle,r.maxAngle,r.minY,r.maxY].every(Number.isFinite)||r.innerRadius<=RING_HABITAT_FIELD_MAX_HEIGHT_L||r.depth<=0||r.minAngle>=r.maxAngle||r.minY>=r.maxY||r.maxAngle-r.minAngle>=Math.PI||typeof r.seed!=='string'||!Number.isInteger(r.siteIndex)||r.siteIndex<0||r.siteIndex>=32||!Number.isInteger(r.climate)||r.climate<0||r.climate>3||!Array.isArray(r.sources)||r.sources.length>8)throw new RangeError('Invalid ring habitat field recipe');
 for(const s of r.sources){
  if(![s.angle,s.y,s.length,s.width,s.cr,s.sr].every(Number.isFinite)||s.length<=0||s.width<=0||Math.abs(s.cr*s.cr+s.sr*s.sr-1)>1e-10||!Array.isArray(s.peaks)||s.peaks.length!==2)throw new RangeError('Invalid ring habitat source control');
  for(const p of s.peaks)if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)||p[2]<0||p[2]>3000)throw new RangeError('Invalid ring habitat broad peak');
  if(s.peaks[0][0]>=s.peaks[1][0])throw new RangeError('Unordered ring habitat peak controls');
 }
}
function noRiver(){return false;}
function createSubmergedPlain(recipe,width,height){
 const inner=recipe.innerRadius,angle=recipe.minAngle,minY=recipe.minY;
 return Object.freeze({version:RING_HABITAT_FIELD_VERSION,lengthUnit:'L',bounds:Object.freeze({minX:0,minY:0,maxX:width,maxY:height}),innerRadius:inner,minAngle:angle,minY,hmin:RING_HABITAT_FIELD_MIN_HEIGHT_L,hmax:RING_HABITAT_FIELD_MIN_HEIGHT_L,hasLand:false,
  sampleHeight(){return RING_HABITAT_FIELD_MIN_HEIGHT_L;},
  sampleRiver:noRiver,
  position(x,y,out){const phi=angle+x/inner;out[0]=(inner-RING_HABITAT_FIELD_MIN_HEIGHT_L)*Math.cos(phi);out[1]=minY+y;out[2]=(inner-RING_HABITAT_FIELD_MIN_HEIGHT_L)*Math.sin(phi);return out;},
  normal(x,y,out){const phi=angle+x/inner;out[0]=-Math.cos(phi);out[1]=0;out[2]=-Math.sin(phi);return out;},
  statistics:Object.freeze({sourcePeaks:0,sparseControls:0,shoreSegments:0,shoreSplitTriangles:0,shoreTangentTriangles:0,shoreArcs:0,downhillLinks:0,broadTrunks:0,warpJacobianBound:0,warpDisplacementBound:0,accountedBytes:2048}),
 });
}

/** Lazily reconstruct the retained 12L visible-land contour from the compact
 * source recipe, then release its interior grid constraints. Source triangle
 * positions below are construction-only, with no closed mesh/BVH or cache.
 * The physical sea surface is0L;12L is the established full-land material
 * datum. Signed physical shore distance bounds the coastal grade.
 * position/normal write caller-owned array outputs; queries allocate nothing.
 */
export function createRingHabitatField(recipe){
 validateRecipe(recipe);
 const {innerRadius:inner,minAngle:angle0,minY,maxY}=recipe,width=(recipe.maxAngle-angle0)*inner,height=maxY-minY,seed=recipe.seed;
 const g={columns:TOP_X,rows:TOP_Y,minAngle:angle0,maxAngle:recipe.maxAngle,minY,maxY,innerRadius:inner};
 const source=createRingHabitatSourceProfile({...recipe,inner}),retained=[],vertices=[],faces=[],vertexUV=[];
 for(let y=0;y<TOP_Y;y++)for(let x=0;x<TOP_X;x++){
  const phi=angle0+(recipe.maxAngle-angle0)*x/(TOP_X-1),axis=minY+height*y/(TOP_Y-1),edge=smooth(Math.min(1,Math.min(x,TOP_X-1-x)/2))*smooth(Math.min(1,Math.min(y,TOP_Y-1-y)/2)),h=source.sampleBaseHeight(phi,axis)*edge-source.topBurial*(1-edge),r=inner-h;
  retained.push(h);vertices.push([r*Math.cos(phi),axis,r*Math.sin(phi)]);vertexUV.push([x,y]);
 }
 for(let y=0;y<TOP_Y-1;y++)for(let x=0;x<TOP_X-1;x++){const a=y*TOP_X+x,b=a+1,c=a+TOP_X,d=c+1;if((x+y)%2)faces.push([a,b,d],[a,d,c]);else faces.push([a,b,c],[b,d,c]);}
 const patch={topGrid:g,center:[0,0,0],vertices,faces,vertexUV};
  const localPeaks=[];
  for(let y=1;y<g.rows-1;y++)for(let x=1;x<g.columns-1;x++){
    const i=y*g.columns+x,h=retained[i];
    if(h>12&&h>=retained[i-1]&&h>=retained[i+1]&&h>=retained[i-g.columns]&&h>=retained[i+g.columns])localPeaks.push(Object.freeze({x:x/(g.columns-1)*width,y:y/(g.rows-1)*height,h}));
  }
  // Mountain sites keep only their broad high summits. Lowland sites have
  // a deliberate sparse low-elevation path; no invented high peak is added.
  const highPeaks=localPeaks.filter(p=>p.h>800),sourcePeaks=highPeaks.length?highPeaks:localPeaks;
  // With no visible-land source control this site is a submerged plain,
  // including the zero-source/zero-peak recipe case. No mountain is invented.
  if(!sourcePeaks.length)return createSubmergedPlain(recipe,width,height);
  const sourceId=recipe.seed+':site-'+recipe.siteIndex;let shoreline;
  try{shoreline=createRetainedShoreline(patch,{heightL:12,sourceId});}
  catch(cause){throw new Error('Halo shoreline '+sourceId+': '+cause.message,{cause});}
  if(!shoreline)throw new Error('Land source controls require a finite shoreline: '+sourceId);
  const shore={distance:0},seedBase=hashSeed(`${seed}:halo-field-v1:sparse-base`),controls=[];
  for(let i=0;i<sourcePeaks.length;i++){const p=sourcePeaks[i];controls.push(Object.freeze({...p,kind:'peak',sigma:1250+hash(seedBase,i,0,1)*600,weight:1.6}));}
  // Sparse minimum-spanning ridge layout, admitted only across retained land.
  const admitted=new Set([0]);
  while(admitted.size<sourcePeaks.length){let best=Infinity,from=-1,to=-1;
    for(const i of admitted)for(let j=0;j<sourcePeaks.length;j++)if(!admitted.has(j)){const a=sourcePeaks[i],b=sourcePeaks[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d<best){best=d;from=i;to=j;}}
    admitted.add(to);const a=sourcePeaks[from],b=sourcePeaks[to];let land=true;
    for(const t of [.2,.4,.6,.8])if(!shoreline.query(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,shore).inside)land=false;
    if(!land)continue;
    for(const t of [1/3,2/3])controls.push(Object.freeze({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,h:(a.h+(b.h-a.h)*t)*(1-.16*Math.sin(Math.PI*t)),sigma:clamp(best*.22,1000,2200),weight:1,kind:'ridge'}));
    const mx=(a.x+b.x)*.5,my=(a.y+b.y)*.5,nx=-(b.y-a.y)/best,ny=(b.x-a.x)/best;
    for(const sign of [-1,1]){
      const offset=1900+hash(seedBase,from,to,sign===1?3:4)*700,x=mx+nx*offset*sign,y=my+ny*offset*sign;
      if(x<=0||x>=width||y<=0||y>=height||shoreline.query(x,y,shore).distance<200)continue;
      if(controls.some(c=>c.kind==='valley'&&Math.hypot(c.x-x,c.y-y)<1300))continue;
      controls.push(Object.freeze({x,y,h:90+Math.min(a.h,b.h)*.11,sigma:1000+hash(seedBase,from,to,sign===1?5:6)*400,weight:1.25,kind:'valley'}));
    }
  }
  const theta1=hash(seedBase,0,0,10)*Math.PI*2,theta2=theta1+1.1+hash(seedBase,0,0,11)*.4;
  const warpModes=Object.freeze([{amplitude:400,wavelength:12000,angle:theta1,phase:hash(seedBase,0,0,12)*Math.PI*2},{amplitude:100,wavelength:8000,angle:theta2,phase:hash(seedBase,0,0,13)*Math.PI*2}].map(Object.freeze));
  const warpJacobianBound=warpModes.reduce((n,m)=>n+m.amplitude*Math.PI*2/m.wavelength,0),warpDisplacementBound=warpModes.reduce((n,m)=>n+m.amplitude,0);
  const gradePhase=hash(seedBase,0,0,14)*Math.PI*2;
  function warp(x,y,out){out[0]=x;out[1]=y;for(let i=0;i<warpModes.length;i++){const m=warpModes[i],c=Math.cos(m.angle),s=Math.sin(m.angle),v=m.amplitude*Math.sin((x*c+y*s)*Math.PI*2/m.wavelength+m.phase);out[0]-=s*v;out[1]+=c*v;}return out;}
  const warped=[0,0];
  function rawBase(x,y){
    warp(x,y,warped);let maximum=-Infinity;
    // Subtract the largest log weight: normalized Gaussian radial controls
    // remain defined over the complete feature, including remote water cells.
    for(let i=0;i<controls.length;i++){const c=controls[i],dx=warped[0]-c.x,dy=warped[1]-c.y,log=Math.log(c.weight)-.5*(dx*dx+dy*dy)/(c.sigma*c.sigma);if(log>maximum)maximum=log;}
    let sum=0,value=0;
    for(let i=0;i<controls.length;i++){const c=controls[i],dx=warped[0]-c.x,dy=warped[1]-c.y,w=Math.exp(Math.log(c.weight)-.5*(dx*dx+dy*dy)/(c.sigma*c.sigma)-maximum);sum+=w;value+=w*c.h;}
    return value/sum;
  }
  function shoreGrade(x,y){return .22+.035*Math.sin((x*.8+y*.6)*Math.PI*2/8000+gradePhase)+.025*Math.sin((x*-.6+y*.8)*Math.PI*2/5000+gradePhase*.71);}
  function envelope(x,y){
    const distance=shoreline.query(x,y,shore).distance,C=shoreGrade(x,y)*distance,datum=shoreline.heightL;
    if(distance<=0)return datum+C/Math.sqrt(1+(C/36)**2);
    const A=rawBase(x,y)-datum,ratio=C/A;
    return datum+C/(1+ratio**6)**(1/6);
  }
  // Only the retained visible-shore domain constrains interior elevation.
  // The old 561 heights are not interpolated, blended or pinned anywhere.
  const values=Array.from({length:g.columns*g.rows},(_,i)=>envelope(i%g.columns/(g.columns-1)*width,Math.floor(i/g.columns)/(g.rows-1)*height));
  // One coherent artistic downhill network. This is a static D8 layout on
  // retained controls, not simulated drainage, erosion, water flow or mass.
  const seedNumber=hashSeed(`${seed}:halo-field-v1:connected-gullies`),nodeCount=g.columns*g.rows;
  const dx=width/(g.columns-1),dy=height/(g.rows-1),downstream=new Int32Array(nodeCount).fill(-1),accumulation=new Float64Array(nodeCount);
  const nodes=values.map((h,i)=>Object.freeze({id:i,x:i%g.columns*dx,y:Math.floor(i/g.columns)*dy,h}));
  for(let i=0;i<nodeCount;i++){
    const a=nodes[i];if(a.h<=0)continue;accumulation[i]=1;let best=0,target=-1;
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      if(ox===0&&oy===0)continue;
      const x=i%g.columns+ox,y=Math.floor(i/g.columns)+oy;
      if(x<0||x>=g.columns||y<0||y>=g.rows)continue;
      const j=y*g.columns+x,drop=(a.h-values[j])/Math.hypot(ox*dx,oy*dy);
      if(drop>best||(drop===best&&drop>0&&j<target)){best=drop;target=j;}
    }
    downstream[i]=target;
  }
  const order=Array.from({length:nodeCount},(_,i)=>i).sort((a,b)=>values[b]-values[a]||a-b);
  for(const i of order){const to=downstream[i];if(to>=0)accumulation[to]+=accumulation[i];}
  const maximumAccumulation=Math.max(...accumulation),nodeWidth=i=>88+188*Math.sqrt(Math.max(0,accumulation[i]-1)/Math.max(1,maximumAccumulation-1));
  const channels=[],index=Array.from({length:nodeCount},()=>[]);
  for(let i=0;i<nodeCount;i++){
    const j=downstream[i];if(j<0||values[i]<=32)continue;
    const a=nodes[i],b=nodes[j],vx=b.x-a.x,vy=b.y-a.y,length=Math.hypot(vx,vy),wx=nodeWidth(i),wy=nodeWidth(j);
    const phase=hash(seedNumber,i,j,0)*Math.PI*2,phase2=hash(seedNumber,i,j,1)*Math.PI*2;
    const amplitude=Math.min(Math.max(wx,wy)*.5,length*.065);
    const channel=Object.freeze({id:channels.length,from:i,to:j,x:a.x,y:a.y,dx:vx,dy:vy,length,tx:vx/length,ty:vy/length,nx:-vy/length,ny:vx/length,widthA:wx,widthB:wy,phase,phase2,amplitude,accumulation:accumulation[i]});
    channels.push(channel);
    const reach=Math.max(wx,wy)*1.07*2.75+amplitude*1.35;
    const minX=clamp(Math.floor((Math.min(a.x,b.x)-reach)/dx),0,g.columns-1),maxX=clamp(Math.floor((Math.max(a.x,b.x)+reach)/dx),0,g.columns-1);
    const minY=clamp(Math.floor((Math.min(a.y,b.y)-reach)/dy),0,g.rows-1),maxY=clamp(Math.floor((Math.max(a.y,b.y)+reach)/dy),0,g.rows-1);
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)index[y*g.columns+x].push(channel.id);
  }
  const widthAt=(channel,t)=>{
    const cap=Math.sin(Math.PI*t)**2;
    return (channel.widthA+(channel.widthB-channel.widthA)*smooth(t))*(1+.07*cap*Math.sin(Math.PI*2*t+channel.phase2));
  };
  const broadValleys=createBroadValleys({nodes,downstream,accumulation,shoreline,width,height,columns:g.columns,rows:g.rows});
  function gullyProfiles(x,y,out){
    const gx=clamp(Math.floor(x/dx),0,g.columns-1),gy=clamp(Math.floor(y/dy),0,g.rows-1),local=index[gy*g.columns+gx];
    let remainingCut=1,remainingBank=1;
    for(let i=0;i<local.length;i++){
      const c=channels[local[i]],px=x-c.x,py=y-c.y,s=(px*c.tx+py*c.ty)/c.length,t=clamp(s,0,1),cap=Math.sin(Math.PI*t)**2;
      const bend=c.amplitude*cap*(Math.sin(Math.PI*2*t+c.phase)+.35*Math.sin(Math.PI*4*t+c.phase2));
      const cross=px*c.nx+py*c.ny-bend,along=(s-t)*c.length,width=widthAt(c,t),distance=Math.hypot(cross,along)/width;
      if(distance<1.35){const q=distance/1.35;remainingCut*=1-(1-q*q)**3;}
      const bank=(distance-2)/.75;
      if(Math.abs(bank)<1)remainingBank*=1-(1-bank*bank)**3;
    }
    out.cut=1-remainingCut;out.bank=1-remainingBank;return out;
  }
  // One static artistic relief hypothesis. The retained shoreline and sparse
  // macro controls are untouched; these wavelengths create real 16L triangles.
  const reliefSeed=hashSeed(`${seed}:geologic-relief-v1`);
  const reliefCr=recipe.sources[0].cr,reliefSr=recipe.sources[0].sr;
  function interiorRelief(x,y,heightL,coastDistanceL){
    // Exact zero through the first600L of interior coast. Height taper keeps
    // land strictly above12L even under the full negative64L perturbation:
    // smooth(t)/t<=1.125 and64/128*1.125=.5625<1.
    const fade=smooth((coastDistanceL-600)/1000)*smooth((heightL-12)/128);
    if(fade===0)return 0;
    const u=x*reliefCr+y*reliefSr,v=-x*reliefSr+y*reliefCr;
    const broad=ringHabitatNoise(u/768,v/768,reliefSeed);
    const middle=ringHabitatNoise((u*.8+v*.6)/192,(-u*.6+v*.8)/192,reliefSeed^0x51d7348b);
    const fine=ringHabitatNoise(u/64,v/64,reliefSeed^0x2a8f6c31);
    // Noise is in[-1,1]. The smooth broad ridge is also in[-1,1],
    // so |relief|<=40+18+6=64L before a fade in[0,1]. No physical erosion.
    return fade*(40*(1-2*broad*broad)+18*middle+6*fine);
  }
  const profile={cut:0,bank:0},broadProfile={cutL:0,bankL:0,activeTrunks:0};
  function sample(x,y){
    const base=envelope(x,y);if(base<=shoreline.heightL)return base;
    const distance=shore.distance; // envelope owns the immediately preceding query.
    broadValleys.deform(x,y,base,distance,broadProfile);
    const meso=base-broadProfile.cutL+broadProfile.bankL;
    gullyProfiles(x,y,profile);
    const depth=Math.min(200,.18*(meso-shoreline.heightL))*smooth(distance/400);
    const terrain=meso-depth*profile.cut+depth*.1*profile.bank;
    return terrain+interiorRelief(x,y,terrain,distance);
  }
  function position(x,y,out){
    const phi=angle0+x/inner,r=inner-sample(x,y);
    out[0]=r*Math.cos(phi);out[1]=g.minY+y;out[2]=r*Math.sin(phi);return out;
  }
  function normal(x,y,out){
    const e=.25,x0=Math.max(0,x-e),x1=Math.min(width,x+e),y0=Math.max(0,y-e),y1=Math.min(height,y+e);
    const hx=(sample(x1,y)-sample(x0,y))/(x1-x0),hy=(sample(x,y1)-sample(x,y0))/(y1-y0),phi=angle0+x/inner;
    const r=1-sample(x,y)/inner,tx=-Math.sin(phi),tz=Math.cos(phi),rx=Math.cos(phi),rz=Math.sin(phi);
    // normal is -radial - tangent*h_x/r - axis*h_y, toward the interior air.
    const nx=-rx-tx*hx/r,nz=-rz-tz*hx/r,size=Math.hypot(nx,hy,nz);
    out[0]=nx/size;out[1]=-hy/size;out[2]=nz/size;return out;
  }
  const hmax=Math.max(...controls.map(c=>c.h))+42.5+64;
  // Charge construction records conservatively too: an engine may retain a
  // closure context longer than its logically live arrays. Cache eviction is
  // based on this explicit schedule; it is not a JS heap-size claim.
  const accountedBytes=4096+shoreline.accountedBytes+broadValleys.accountedBytes+controls.length*256+nodeCount*400+channels.length*256+index.length*64+index.reduce((n,a)=>n+a.length,0)*8;
  return Object.freeze({version:RING_HABITAT_FIELD_VERSION,lengthUnit:'L',bounds:Object.freeze({minX:0,minY:0,maxX:width,maxY:height}),innerRadius:inner,minAngle:angle0,minY:g.minY,hmin:RING_HABITAT_FIELD_MIN_HEIGHT_L,hmax,hasLand:true,
    sampleHeight:sample,position,normal,sampleRiver:recipe.climate===2?noRiver:broadValleys.sampleRiver,
    statistics:Object.freeze({sourcePeaks:sourcePeaks.length,sparseControls:controls.length,shoreSegments:shoreline.segments.length,shoreSplitTriangles:shoreline.splitTriangles,shoreTangentTriangles:shoreline.tangentTriangles,shoreArcs:shoreline.contourArcs,downhillLinks:channels.length,broadTrunks:broadValleys.trunks.length,warpJacobianBound,warpDisplacementBound,accountedBytes}),
  });
}
