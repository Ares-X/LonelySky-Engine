import test from 'node:test';
import assert from 'node:assert/strict';
import {Plane,Ray,Triangle,Vector3} from 'three';
import {createRingHabitat} from '../src/ring-habitat.js';
import {cosmicRingParts} from '../src/cosmic-bodies.js';
import {sampleRingHabitatTop} from '../src/ring-habitat-sampling.js';
import {createMeshTerrainWorkspace,meshTerrainDistance} from '../src/mesh-terrain.js';
import {createSolidWorkspace,sweepSolid} from '../src/solid-geometry.js';

const input={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture'};
input.parts=cosmicRingParts(input);
const habitat=createRingHabitat(input),point={x:0,y:0,z:0},normal={x:0,y:0,z:0},faceNormal={x:0,y:0,z:0},info={rockCoverage:0};
const w=createMeshTerrainWorkspace(),out={distance:Infinity,normal:[0,0,0]};
const area=(a,b,c)=>((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
const sampleUV=(patch,uv)=>sampleRingHabitatTop(patch,patch.topGrid.minAngle+(patch.topGrid.maxAngle-patch.topGrid.minAngle)*uv[0]/32,patch.topGrid.minY+(patch.topGrid.maxY-patch.topGrid.minY)*uv[1]/16,point,normal,faceNormal,info);

function barycentric(p,a,b,c){const denominator=area(a,b,c)*2,beta=((p[0]-a[0])*(c[1]-a[1])-(p[1]-a[1])*(c[0]-a[0]))/denominator,gamma=((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))/denominator;return [1-beta-gamma,beta,gamma];}
function basePlane(patch,refined){return new Plane().setFromCoplanarPoints(...refined.base.map(index=>new Vector3(...patch.vertices[index])));}
function radialReference(patch,plane,local){
  const x=patch.center[0]+local[0],z=patch.center[2]+local[2],radius=Math.hypot(x,z);
  const height=plane.distanceToPoint(new Vector3(...local))/(-(plane.normal.x*x+plane.normal.z*z)/radius);
  return {height,baseline:[local[0]+height*x/radius,local[1],local[2]+height*z/radius]};
}

test('refined surfaces partition each original triangle without gaps, overlap, new boundary vertices or radial folds',()=>{
  let count=0;
  for(const patch of habitat.terrainGroups)for(const refined of patch.refinedFaces){
    count++;
    const interior=new Set(refined.faces.flatMap(index=>patch.faces[index]).filter(index=>!refined.base.includes(index)));
    assert.ok(interior.size>0);assert.equal(refined.faces.length,interior.size*2+1,'triangulation retains only the three original boundary edges');
    const base=refined.base.map(index=>patch.vertexUV[index]),expected=area(...base);
    let total=0;
    const boundary=new Map();
    for(const index of refined.faces){
      const face=patch.faces[index],uv=face.map(i=>patch.vertexUV[i]);
      const a=area(...uv);assert.ok(a>1e-9);total+=a;
      for(const p of uv)for(const weight of barycentric(p,...base))assert.ok(weight>=-1e-9);
      for(let i=0;i<3;i++){const a=face[i],b=face[(i+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;boundary.set(key,(boundary.get(key)??0)+1);}
      const vertices=face.map(i=>patch.vertices[i]),a3=vertices[0],b3=vertices[1],c3=vertices[2];
      const ux=b3[0]-a3[0],uy=b3[1]-a3[1],uz=b3[2]-a3[2],vx=c3[0]-a3[0],vy=c3[1]-a3[1],vz=c3[2]-a3[2];
      const px=patch.center[0]+(a3[0]+b3[0]+c3[0])/3,pz=patch.center[2]+(a3[2]+b3[2]+c3[2])/3;
      assert.ok((uy*vz-uz*vy)*-px+(ux*vy-uy*vx)*-pz>0,'physical surface remains a radial graph, without overhang intersections');
    }
    assert.ok(Math.abs(total-expected)<1e-10);
    const outer=Array.from(boundary).filter(([,count])=>count===1).map(([key])=>key).sort();
    const wanted=refined.base.map((a,i)=>{const b=refined.base[(i+1)%3];return a<b?`${a},${b}`:`${b},${a}`;}).sort();assert.deepEqual(outer,wanted);
    // Irrational offsets avoid intentional shared-edge ambiguity.
    for(let i=0;i<17;i++)for(let j=0;j<17-i;j++){
      const beta=(i+.173)/18,gamma=(j+.317)/18,alpha=1-beta-gamma;
      const p=[base[0][0]*alpha+base[1][0]*beta+base[2][0]*gamma,base[0][1]*alpha+base[1][1]*beta+base[2][1]*gamma];
      let hits=0;
      for(const index of refined.faces){const weights=barycentric(p,...patch.faces[index].map(v=>patch.vertexUV[v]));if(weights.every(n=>n>=0))hits++;}
      assert.equal(hits,1);
    }
  }
  assert.ok(count>habitat.terrainGroups.length,'fixture includes multiple real terraces per patch');
});

test('authoritative sampler returns actual refined face points, smooth normals and material interpolation',()=>{
  let rock=0,mixed=0;
  const triangle=new Triangle(),expectedFace=new Vector3(),expectedSmooth=new Vector3(),value=new Vector3();
  for(const patch of habitat.terrainGroups)for(const refined of patch.refinedFaces)for(const faceIndex of refined.faces){
    const face=patch.faces[faceIndex],uv=[0,0],expected=[0,0,0];let coverage=0;
    for(const index of face){uv[0]+=patch.vertexUV[index][0]/3;uv[1]+=patch.vertexUV[index][1]/3;for(let axis=0;axis<3;axis++)expected[axis]+=patch.vertices[index][axis]/3;coverage+=patch.surfaceKinds[index]/3;}
    assert.equal(sampleUV(patch,uv),true);
    assert.ok(Math.hypot(point.x-patch.center[0]-expected[0],point.y-patch.center[1]-expected[1],point.z-patch.center[2]-expected[2])<1e-5);
    assert.ok(Math.abs(info.rockCoverage-coverage)<1e-8);
    assert.ok(Math.abs(Math.hypot(normal.x,normal.y,normal.z)-1)<1e-10);assert.ok(Math.abs(Math.hypot(faceNormal.x,faceNormal.y,faceNormal.z)-1)<1e-10);
    triangle.a.fromArray(patch.vertices[face[0]]);triangle.b.fromArray(patch.vertices[face[1]]);triangle.c.fromArray(patch.vertices[face[2]]);triangle.getNormal(expectedFace);
    expectedSmooth.set(0,0,0);for(const index of face)expectedSmooth.add(value.fromArray(patch.normals[index]));expectedSmooth.normalize();
    assert.ok(expectedFace.dot(value.set(faceNormal.x,faceNormal.y,faceNormal.z))>1-1e-10,'sampling retains the actual finite-triangle outward normal');
    assert.ok(expectedSmooth.dot(value.set(normal.x,normal.y,normal.z))>1-1e-10,'the smooth normal interpolates retained mesh metadata');
    assert.equal(meshTerrainDistance(patch,point.x,point.y,point.z,out,w),out);assert.ok(Math.abs(out.distance)<1e-5);
    assert.ok(expectedFace.dot(value.fromArray(out.normal))>1-1e-10,'the sampled visible boundary and CPU collision agree on the outward face normal');
    if(coverage===1)rock++;else mixed++;
  }
  assert.ok(rock>0&&mixed>0);
});

test('rock-bearing physical facets are substantially smaller than the coarse V17 rock triangles',()=>{
  // The same 32-patch fixture had a 2509.43-square-unit maximum bare face in
  // V17. A scene-unit area budget protects real tessellation, without fixing
  // the subdivision recipe, vertex stream or triangle count.
  const triangle=new Triangle();let largestBare=0,largestMixed=0,count=0;
  for(const patch of habitat.terrainGroups)for(const refined of patch.refinedFaces)for(const index of refined.faces){
    const face=patch.faces[index];if(!face.some(vertex=>patch.surfaceKinds[vertex]===1))continue;
    triangle.a.fromArray(patch.vertices[face[0]]);triangle.b.fromArray(patch.vertices[face[1]]);triangle.c.fromArray(patch.vertices[face[2]]);
    const size=triangle.getArea();
    if(face.every(vertex=>patch.surfaceKinds[vertex]===1))largestBare=Math.max(largestBare,size);
    else largestMixed=Math.max(largestMixed,size);
    count++;
  }
  assert.ok(count>0&&largestBare>0);assert.ok(largestBare<=625,`maximum bare face area ${largestBare} exceeds the physical refinement budget`);
  // Mixed transition faces keep fixed natural boundary edges and use a
  // separate area budget while retaining the same physical refinement goal.
  assert.ok(largestMixed<=750,`maximum mixed-material face area ${largestMixed} exceeds the physical refinement budget`);
});

test('small fracture displacement changes the shared physical surface, not only its normal or triangle count',()=>{
  // Frozen after the C1 source-profile correction, at the first
  // subdivideRockSurface entry before subdivision or micro displacement.
  // Select the largest all-bare coarse face in patches0/4 (faces1349/1251)
  // before probing the final mesh; final microgeometry never supplies anchors.
  const anchors=[
    {patch:0,points:[[16895.655625859195,1564.4073987351478,-3280.634443640352],[16839.526171076857,1642.974760700775,-3246.83187094228],[16931.1070321235,1620.3777489082072,-3275.69330467904]]},
    {patch:4,points:[[2073.9720725946236,-3698.070741655747,1074.6855176708227],[2057.552689534086,-3656.5663638075534,1081.0234942434147],[2103.3456973330276,-3653.8987138439825,1123.7654399578569]]},
  ];
  const before=new Triangle(),triangle=new Triangle(),coarseNormal=new Vector3(),origin=new Vector3(),target=new Vector3(),hit=new Vector3(),closest=new Vector3(),ray=new Ray();
  let displaced=0;
  for(const anchor of anchors){
    const patch=habitat.terrainGroups[anchor.patch];before.a.fromArray(anchor.points[0]);before.b.fromArray(anchor.points[1]);before.c.fromArray(anchor.points[2]);before.getNormal(coarseNormal);
    for(const weights of [[1/3,1/3,1/3],[.2,.3,.5],[.5,.3,.2]]){
      target.copy(before.a).multiplyScalar(weights[0]).addScaledVector(before.b,weights[1]).addScaledVector(before.c,weights[2]);
      origin.copy(target).addScaledVector(coarseNormal,50);ray.origin.copy(origin);ray.direction.copy(coarseNormal).negate();let nearest=Infinity;
      for(const face of patch.faces){
        triangle.a.fromArray(patch.vertices[face[0]]);triangle.b.fromArray(patch.vertices[face[1]]);triangle.c.fromArray(patch.vertices[face[2]]);
        if(ray.intersectTriangle(triangle.a,triangle.b,triangle.c,false,hit)){
          const distance=hit.distanceToSquared(origin);if(distance<nearest){nearest=distance;closest.copy(hit);}
        }
      }
      assert.ok(Number.isFinite(nearest));
      const displacement=closest.clone().sub(target).dot(coarseNormal);
      assert.ok(Math.abs(displacement)<=8+1e-5,`real surface displacement ${displacement} must stay at fracture scale`);
      if(Math.abs(displacement)>.5)displaced++;
      assert.equal(meshTerrainDistance(patch,closest.x+patch.center[0],closest.y+patch.center[1],closest.z+patch.center[2],out,w),out);assert.ok(Math.abs(out.distance)<1e-5);
    }
  }
  assert.ok(displaced>=4,'both retained rock regions contain actual geometry displacement from the coarse planes');
});

test('localized rock clusters have a physical 120-240-unit footprint and leave their long base triangle natural',()=>{
  for(const patch of habitat.terrainGroups)for(const refined of patch.refinedFaces){
    const plane=basePlane(patch,refined);
    const ids=[...new Set(refined.faces.flatMap(id=>patch.faces[id]).filter(i=>!refined.base.includes(i)))];
    const levels=[],baselines=[];
    for(const index of ids){
      const reference=radialReference(patch,plane,patch.vertices[index]);
      levels.push(reference.height);baselines.push(reference.baseline);
    }
    const maximum=Math.max(...levels),raised=levels.filter((_,index)=>patch.surfaceKinds[ids[index]]===1),outer=baselines.filter((_,index)=>patch.surfaceKinds[ids[index]]===0);
    assert.ok(maximum>=40&&maximum<=120,'radial displacement is a local rock scale, separate from the old slope height');
    assert.ok(outer.length>0&&raised.length>0);
    for(let index=0;index<ids.length;index++){
      const height=levels[index],kind=patch.surfaceKinds[ids[index]];
      assert.ok(height>=-1e-6);
      if(Math.abs(height)<1e-6)assert.equal(kind,0,'points on the unchanged slope retain their natural material');
      if(kind===0)assert.ok(height<=6+1e-6,'natural material may cover the low transition into raised rock');
      else{assert.equal(kind,1);assert.ok(height>0,'bare material belongs to actual raised geometry');}
    }
    assert.ok(Math.max(...raised)-Math.min(...raised)>maximum*.35,'the local solid has actual unequal ledges and a low gully');
    assert.ok(Math.min(...raised)<maximum*.7);
    let diameter=0;
    for(const a of outer)for(const b of outer)diameter=Math.max(diameter,Math.hypot(...a.map((n,i)=>n-b[i])));
    assert.ok(diameter>=95&&diameter<=240,'footprint uses physical scene units rather than the original kilometer triangle');
    const a=outer[0],b=outer[1],e1=b.map((n,i)=>n-a[i]),size=Math.hypot(...e1);for(let i=0;i<3;i++)e1[i]/=size;
    const p=patch.vertices[refined.base[0]],q=patch.vertices[refined.base[1]],r=patch.vertices[refined.base[2]],u=q.map((n,i)=>n-p[i]),v=r.map((n,i)=>n-p[i]);
    const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],norm=Math.hypot(...normal);for(let i=0;i<3;i++)normal[i]/=norm;
    const e2=[normal[1]*e1[2]-normal[2]*e1[1],normal[2]*e1[0]-normal[0]*e1[2],normal[0]*e1[1]-normal[1]*e1[0]];
    let minimum=Infinity,maximumWidth=0;
    for(let axis=0;axis<24;axis++){
      const angle=axis*Math.PI/24,dir=e1.map((n,i)=>n*Math.cos(angle)+e2[i]*Math.sin(angle));
      const values=outer.map(p=>p.reduce((sum,n,i)=>sum+n*dir[i],0)),width=Math.max(...values)-Math.min(...values);
      minimum=Math.min(minimum,width);maximumWidth=Math.max(maximumWidth,width);
    }
    assert.ok(minimum/maximumWidth>.45,'the footprint is round or mildly anisotropic, not a scaled long triangle');
    for(const index of refined.faces){
      const face=patch.faces[index];
      if(face.some(i=>patch.surfaceKinds[i]>0))assert.ok(face.every(i=>!refined.base.includes(i)),'bare material cannot spread to the original triangle corners');
    }
  }
});

test('raised terraces have broad unequal ledges and stop high-speed crossings before the replaced macro face',()=>{
  const sw=createSolidWorkspace();let checked=0;
  for(const patch of habitat.terrainGroups.slice(0,3))for(const refined of patch.refinedFaces){
    const plane=basePlane(patch,refined);
    let faceIndex=refined.face,best=-Infinity;
    for(const index of refined.faces){
      let score=0;
      for(const vertex of patch.faces[index]){
        score+=radialReference(patch,plane,patch.vertices[vertex]).height;
      }
      if(score>best){best=score;faceIndex=index;}
    }
    const face=patch.faces[faceIndex],uv=[0,0];
    for(const index of face){uv[0]+=patch.vertexUV[index][0]/3;uv[1]+=patch.vertexUV[index][1]/3;}
    assert.equal(sampleUV(patch,uv),true);
    const raised=[point.x,point.y,point.z],radial=Math.hypot(point.x,point.z),up=[-point.x/radial,0,-point.z/radial];
    const elevation=radialReference(patch,plane,raised.map((value,axis)=>value-patch.center[axis])).height;
    assert.ok(elevation>20&&elevation<=120);
    const levels=[];
    for(const index of new Set(refined.faces.flatMap(id=>patch.faces[id]).filter(index=>patch.surfaceKinds[index]===1))){
      levels.push(radialReference(patch,plane,patch.vertices[index]).height);
    }
    const maximum=Math.max(...levels),plateau=levels.filter(h=>h>maximum*.7);
    assert.ok(maximum>=40&&maximum<=120);
    assert.ok(plateau.length>=3,'the high fragments occupy multiple real vertices, not one cone summit');
    assert.ok(Math.max(...plateau)-Math.min(...plateau)>maximum*.06,'platform and ledges have unequal heights');
    const inside=raised.map((v,i)=>v-up[i]*elevation*.5);
    assert.equal(meshTerrainDistance(patch,...inside,out,w),out);assert.ok(out.distance<-1,'raised volume is filled by the same single manifold');
    const start=raised.map((v,i)=>v+up[i]*5000),end=raised.map((v,i)=>v-up[i]*5000);
    const solid={id:'refined',position:[0,0,0],shape:{type:'compound',parts:[],terrainGroups:[patch]}};
    for(const radius of [0,3]){
      const result=sweepSolid(solid,start,end,radius,undefined,sw.result,sw);
      assert.equal(result.status,'hit');
      if(radius===0)assert.ok(Math.abs(result.fraction-.5)<1e-5,'point sweep hits the real displaced face');
      else{
        assert.ok(result.fraction<.5&&result.fraction>.48,'sphere reaches local geometry before the old macro face');
        const contact=start.map((n,i)=>n+(end[i]-n)*result.fraction);
        assert.equal(meshTerrainDistance(patch,...contact,out,w),out);assert.ok(Math.abs(out.distance-radius)<1e-4,'sphere contact agrees with exact finite geometry');
      }
    }
    checked++;
  }
  assert.ok(checked>0);
});

test('nine-by-two buried base keeps the original axial extrusion without removing visible terrain',()=>{
  for(const patch of habitat.terrainGroups.slice(0,3))for(let column=0;column<9;column++){
    const a=patch.vertices[561+column],b=patch.vertices[570+column];
    assert.equal(a[0],b[0]);assert.equal(a[2],b[2]);
    for(let row=0;row<=4;row++){
      const p=a.map((n,axis)=>patch.center[axis]+n+(b[axis]-n)*row/4);
      assert.equal(meshTerrainDistance(patch,...p,out,w),out);assert.ok(Math.abs(out.distance)<1e-6,'every old intermediate base row remains on the same physical buried boundary');
    }
  }
});

test('real producer metadata supports angle wrap and optional material output without guessing missing data',()=>{
  const patch=habitat.terrainGroups[0],grid=patch.topGrid,angle=(grid.minAngle+grid.maxAngle)/2,y=(grid.minY+grid.maxY)/2;
  assert.equal(sampleRingHabitatTop(patch,angle,y,point,normal,faceNormal),true);
  const expected={...point};
  assert.equal(sampleRingHabitatTop(patch,angle+Math.PI*2,y,point,normal,faceNormal,info),true);
  assert.ok(Math.hypot(point.x-expected.x,point.y-expected.y,point.z-expected.z)<1e-5);
  assert.equal(sampleRingHabitatTop(patch,grid.minAngle-.01,y,point,normal,faceNormal),false);
  assert.throws(()=>sampleRingHabitatTop({...patch,vertexUV:undefined},angle,y,point,normal,faceNormal),TypeError);
});

test('caller-owned output objects and mesh metadata remain stable over repeated shared-edge samples',()=>{
  const patch=habitat.terrainGroups[0],refined=patch.refinedFaces[0],face=patch.faces[refined.faces[20]],a=patch.vertexUV[face[0]],b=patch.vertexUV[face[1]],uv=[(a[0]+b[0])/2,(a[1]+b[1])/2];
  const before=JSON.stringify(patch);
  for(let i=0;i<10000;i++)assert.equal(sampleUV(patch,uv),true);
  assert.equal(JSON.stringify(patch),before);assert.deepEqual(Object.keys(point),['x','y','z']);assert.deepEqual(Object.keys(info),['rockCoverage']);
  assert.equal(meshTerrainDistance(patch,point.x,point.y,point.z,out,w),out);assert.ok(Math.abs(out.distance)<1e-5);
});
