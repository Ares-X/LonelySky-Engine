import test from 'node:test';
import assert from 'node:assert/strict';
import {createRingHabitat,RING_HABITAT_ECOLOGY} from '../src/ring-habitat.js';
import {cosmicRingParts} from '../src/cosmic-bodies.js';
import {randomFromSeed} from '../src/random.js';

const TAU=Math.PI*2,TOP=33*17;
const options=(extra={})=>{
  const value={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture',...extra};
  value.parts=extra.parts??cosmicRingParts(value);return value;
};
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((n,i)=>n-b[i]);
const angleDistance=(a,b)=>Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
const world=(group,v)=>v.map((n,i)=>n+group.center[i]);

function verifyGeometry(input,habitat){
  const core=input.parts.slice(0,3),inner=input.radius-input.radius*input.thickness,outer=input.radius+input.radius*input.thickness;
  const bands=core.map(p=>[p.minY,p.maxY]).sort((a,b)=>a[0]-b[0]);
  const minY=bands[0][0],maxY=Math.max(...core.map(p=>p.maxY));
  const bodyBound=Math.hypot(outer,Math.max(Math.abs(minY),Math.abs(maxY)));
  assert.ok(habitat.terrainGroups.length<=32);
  for(const group of habitat.terrainGroups){
    assert.ok(Object.isFrozen(group)&&Object.isFrozen(group.vertices)&&Object.isFrozen(group.faces)&&Object.isFrozen(group.normals));
    assert.equal(group.vertices.length,579+group.refinedFaces.length*529);assert.equal(group.faces.length,1154+group.refinedFaces.length*1058);assert.equal(group.normals.length,group.vertices.length);
    assert.ok(group.vertices.length<=2048&&group.faces.length<=4096);
    assert.ok(group.nodes.length<=2048);assert.equal(group.triangleOrder.length,group.faces.length);
    assert.ok(Object.isFrozen(group.nodes)&&Object.isFrozen(group.triangleOrder));
    assert.equal(group.surfaceKinds.length,group.vertices.length);assert.equal(group.vertexUV.length,group.vertices.length);
    assert.ok(Object.isFrozen(group.surfaceKinds)&&Object.isFrozen(group.vertexUV)&&Object.isFrozen(group.refinedFaces));
    assert.ok(group.surfaceKinds.every((kind,index)=>(kind===0||kind===1)&&(index>=579||kind===0)));
    let highest=0;
    for(let index=0;index<group.vertices.length;index++){
      const vertex=group.vertices[index],p=world(group,vertex),radial=Math.hypot(p[0],p[2]);
      assert.ok(Object.isFrozen(vertex)&&Object.isFrozen(group.normals[index]));
      assert.ok(Math.hypot(...vertex)<=group.radius+1e-6);
      assert.ok(radial<=outer+1e-7,'all generated geometry stays below outer hull');
      assert.ok(p[1]>=minY-1e-7&&p[1]<=maxY+1e-7);
      assert.ok(Math.hypot(...p)<=bodyBound+1e-6,'original broadphase still contains entire convex hull of vertices');
      assert.ok(Math.abs(Math.hypot(...group.normals[index])-1)<1e-8,'lighting normals are finite normalized vectors');
      highest=Math.max(highest,inner-radial);
    }
    assert.ok(highest>100&&highest<=3000,'real continuous mountain elevation, not only a normal texture');
    const edges=new Map();let volume=0;
    for(let faceIndex=0;faceIndex<group.faces.length;faceIndex++){
      const face=group.faces[faceIndex],[a,b,c]=face.map(i=>group.vertices[i]),normal=cross(sub(b,a),sub(c,a));
      assert.ok(Math.hypot(...normal)>1e-4,'no collapsed triangles');
      volume+=dot(a,cross(b,c))/6;
      for(let i=0;i<3;i++){
        const a=face[i],b=face[(i+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;
        const edge=edges.get(key)??[0,0];edge[0]++;edge[1]+=a<b?1:-1;edges.set(key,edge);
      }
      const buried=faceIndex>=1024&&faceIndex<1154;
      if(!buried){
        const [a,b,c]=face.map(i=>group.vertexUV[i]);
        assert.ok((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0,'all top triangles retain a nonfolded UV graph');
        const px=group.center[0]+(group.vertices[face[0]][0]+group.vertices[face[1]][0]+group.vertices[face[2]][0])/3;
        const pz=group.center[2]+(group.vertices[face[0]][2]+group.vertices[face[1]][2]+group.vertices[face[2]][2])/3;
        assert.ok(-normal[0]*px-normal[2]*pz>0,'the actual physical top surface remains a radial graph too');
      }
      // Independent barycentric samples exercise actual top, curved bottom
      // and side faces. This does not use any terrain distance/CCD function.
      for(let i=0;i<=3;i++)for(let j=0;j<=3-i;j++){
        const p=world(group,a.map((n,k)=>n+(b[k]-n)*i/3+(c[k]-n)*j/3)),radial=Math.hypot(p[0],p[2]);
        assert.ok(radial<=outer+1e-7);
        if(buried)assert.ok(radial>=inner-1e-7,'entire bottom and boundary skirt attach inside real curved core');
        for(const part of core)if(part.gapHalfAngle>0)assert.ok(angleDistance(Math.atan2(p[2],p[0]),part.gapCenter)>=part.gapHalfAngle-1e-10,'mesh does not close the ring break');
      }
    }
    assert.ok(volume>0,'closed outward-oriented solid has positive signed volume');
    for(const [count,direction] of edges.values()){assert.equal(count,2);assert.equal(direction,0,'shared edges have opposite winding');}
  }
}

test('continuous meshes are deterministic, frozen, independently seeded and preserve input',()=>{
  const input=options(),a=createRingHabitat(input),b=createRingHabitat(input);
  assert.deepEqual(a,b);assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.terrainGroups));
  assert.notDeepEqual(a.terrainGroups[0].vertices,createRingHabitat(options({seed:'another'})).terrainGroups[0].vertices);
  const themed=createRingHabitat(options({theme:'dark-rift'}));assert.equal(themed.climate,1);assert.deepEqual(themed.terrainGroups,a.terrainGroups);
  const parent=randomFromSeed('published-layout'),control=randomFromSeed('published-layout');
  assert.equal(parent(),control());createRingHabitat(input);assert.equal(parent(),control());assert.deepEqual(input,options());
});

test('valid vegetation seed triangulates thin transition ears in its final physical UV chart',()=>{
  const input=options({seed:'habitat-vegetation-fixture'}),habitat=createRingHabitat(input);
  assert.ok(habitat.terrainGroups.length>0);
  verifyGeometry(input,habitat);
  for(const patch of habitat.terrainGroups)for(let index=0;index<TOP;index++){
    assert.deepEqual(patch.vertexUV[index],[index%33,Math.floor(index/33)],'fixed macro UVs stay authoritative in reference and final states');
  }
});

for(const [seed,radius,phase,broken,patches] of [
  ['block-review-2',700000,TAU-.03,false,32],
  ['block-review-7',950000,-2.9,true,28],
])test(`${seed} generates closed block terrain with nonfolded UVs at full capacity`,()=>{
  const input=options({seed,radius,phase,broken}),habitat=createRingHabitat(input);
  assert.equal(habitat.terrainGroups.length,patches,'valid sites are generated rather than omitted');
  verifyGeometry(input,habitat);
});

test('climate recipes remain numeric and unknown themes use temperate',()=>{
  for(const [theme,climate] of [['silver-dust',0],['dark-rift',1],['old-gold',2],['tidal-islands',3],['blue-nursery',0],['unknown',0],['toString',0]])assert.equal(createRingHabitat(options({radius:1000,theme})).climate,climate);
});

test('four climates share canonical frozen ecology recipes without reseeding the landscape',()=>{
  assert.ok(Object.isFrozen(RING_HABITAT_ECOLOGY));
  assert.deepEqual(RING_HABITAT_ECOLOGY,[
    {forestCeiling:1650,snowLine:1900,treeDensity:.65},
    {forestCeiling:750,snowLine:1100,treeDensity:.42},
    {forestCeiling:900,snowLine:2400,treeDensity:.12},
    {forestCeiling:2400,snowLine:2900,treeDensity:.8},
  ]);
  const themes=['silver-dust','dark-rift','old-gold','tidal-islands'];
  const baseline=createRingHabitat(options());
  for(let climate=0;climate<themes.length;climate++){
    const habitat=createRingHabitat(options({theme:themes[climate]}));
    assert.equal(habitat.ecology,RING_HABITAT_ECOLOGY[climate]);
    assert.ok(Object.isFrozen(habitat.ecology));
    assert.deepEqual(habitat.terrainGroups,baseline.terrainGroups,'ecology appearance and tree density do not move real terrain');
  }
  assert.equal(createRingHabitat(options({radius:1000,theme:'unknown'})).ecology,RING_HABITAT_ECOLOGY[0]);
});

test('continuous terrain meshes stay closed, buried, within unchanged bounds and outside breaks',()=>{
  for(const radius of [600000,900000,1200000])for(const broken of [false,true]){
    const input=options({radius,broken,phase:radius===900000?TAU-.03:-2.9,seed:`shape-${radius}`,halfWidth:radius===600000?.016:.028,thickness:radius===600000?.00025:.00075});
    const habitat=createRingHabitat(input);assert.ok(habitat.terrainGroups.length>=24);verifyGeometry(input,habitat);
  }
});

test('one connected height grid replaces separate mountain hulls and has real gradual shoulder slopes',()=>{
  const input=options(),habitat=createRingHabitat(input);assert.equal(habitat.terrainGroups.length,32);
  let highest=0,relief=0,areaCoverage=0;
  for(const group of habitat.terrainGroups){
    assert.ok(group.vertices.length<=2048&&group.faces.length<=4096);assert.equal(group.bodies,undefined);
    const heights=group.vertices.slice(0,TOP).map(v=>{const p=world(group,v);return input.radius-input.radius*input.thickness-Math.hypot(p[0],p[2]);});
    highest=Math.max(highest,...heights);
    for(let y=1;y<16;y++)for(let x=1;x<32;x++){
      const h=heights[y*33+x],neighbors=[heights[y*33+x-1],heights[y*33+x+1],heights[(y-1)*33+x],heights[(y+1)*33+x]];
      if(h>200&&neighbors.some(n=>n<h-50)&&neighbors.some(n=>n>h+50))relief++;
    }
    const a=world(group,group.vertices[0]),b=world(group,group.vertices[32]);
    areaCoverage+=angleDistance(Math.atan2(a[2],a[0]),Math.atan2(b[2],b[0]));
    // The top grid is one shared-index disk: each interior vertex has a
    // complete neighborhood, rather than eight overlapping convex shells.
    const logical=group.faces.slice(0,1024).map((face,index)=>group.refinedFaces.find(r=>r.face===index)?.base??face);
    const used=new Set(logical.flat());assert.equal(used.size,TOP);
  }
  assert.ok(highest>1500&&highest<=3000);assert.ok(relief>300,'many real non-flat shoulder vertices');
  assert.ok(areaCoverage/TAU>.2&&areaCoverage/TAU<.8);
});

test('sampled mountain crests have finite cross-slopes, connected ridge runs and intervening saddles',()=>{
  for(const seed of ['habitat-fixture','ridge-valleys-2','ridge-valleys-3']){
    const input=options({seed}),habitat=createRingHabitat(input),sharpness=[];
    let connected=0,saddles=0;
    for(const group of habitat.terrainGroups){
      const grid=group.topGrid,dy=(grid.maxY-grid.minY)/(grid.rows-1);
      const h=group.vertices.slice(0,TOP).map(v=>{const p=world(group,v);return grid.innerRadius-Math.hypot(p[0],p[2]);});
      const profile=[];
      for(let column=0;column<33;column++)profile.push(Math.max(...Array.from({length:17},(_,row)=>h[row*33+column])));
      for(let row=1;row<16;row++)for(let column=1;column<32;column++){
        const value=h[row*33+column],low=h[(row-1)*33+column],high=h[(row+1)*33+column];
        if(value<=500||value<=low||value<=high)continue;
        sharpness.push((2*value-low-high)/(2*dy));
        // Crests remain high into the adjacent column: this rejects an
        // apparent improvement made entirely of isolated single-grid spikes.
        for(let offset=-1;offset<=1;offset++)if(h[(row+offset)*33+column+1]>value*.5){connected++;break;}
      }
      for(let column=3;column<30;column++){
        const left=Math.max(...profile.slice(column-3,column)),right=Math.max(...profile.slice(column+1,column+4));
        if(profile[column]<Math.min(left,right)-150)saddles++;
      }
    }
    sharpness.sort((a,b)=>a-b);
    assert.ok(sharpness.length>habitat.terrainGroups.length*10);
    assert.ok(sharpness[Math.floor(sharpness.length/2)]>.25,'physical cross-slope turns remain visible in actual sampled geometry');
    assert.ok(connected>sharpness.length*.6,'ridge runs span multiple columns');
    assert.ok(saddles>habitat.terrainGroups.length*3,'high areas are separated by actual lower saddle terrain');
  }
});

test('topGrid identifies the actual shared top vertices and triangles for surface consumers',()=>{
  const input=options(),habitat=createRingHabitat(input);
  for(const group of habitat.terrainGroups){
    const grid=group.topGrid;
    assert.ok(Object.isFrozen(grid));assert.equal(grid.columns,33);assert.equal(grid.rows,17);
    assert.equal(grid.innerRadius,input.radius-input.radius*input.thickness);
    for(let row=0;row<grid.rows;row++)for(let column=0;column<grid.columns;column++){
      const p=world(group,group.vertices[row*grid.columns+column]);
      const angle=grid.minAngle+(grid.maxAngle-grid.minAngle)*column/(grid.columns-1);
      const y=grid.minY+(grid.maxY-grid.minY)*row/(grid.rows-1);
      assert.ok(angleDistance(Math.atan2(p[2],p[0]),angle)<1e-12);
      assert.ok(Math.abs(p[1]-y)<1e-8);
    }
    for(let row=0;row<grid.rows-1;row++)for(let column=0;column<grid.columns-1;column++){
      const a=row*grid.columns+column,b=a+1,c=a+grid.columns,d=c+1;
      const pair=((row*(grid.columns-1))+column)*2;
      const expected=(column+row)%2?[[a,b,d],[a,d,c]]:[[a,b,c],[b,d,c]];
      const logical=group.faces.slice(pair,pair+2).map((face,side)=>group.refinedFaces.find(r=>r.face===pair+side)?.base??face);
      assert.deepEqual(logical,expected,'surface consumers retain the original triangle domain and use refined metadata for its actual faces');
    }
    assert.equal((grid.columns-1)*(grid.rows-1)*2,1024);
    assert.equal(grid.columns*grid.rows,561);
  }
});

test('conforming microgeometry preserves a single projected surface, fixed boundaries and natural rear contact',()=>{
  const habitat=createRingHabitat(options());let finer=0;
  for(const patch of habitat.terrainGroups)for(const [rock,refined] of patch.refinedFaces.entries()){
    assert.equal(refined.faces.length,1059);
    const ids=[...new Set(refined.faces.flatMap(index=>patch.faces[index]))],boundary=new Map();
    const base=refined.base.map(index=>patch.vertices[index]),n=cross(sub(base[1],base[0]),sub(base[2],base[0])),size=Math.hypot(...n);for(let axis=0;axis<3;axis++)n[axis]/=size;
    const level=index=>{
      const p=patch.vertices[index],x=patch.center[0]+p[0],z=patch.center[2]+p[2],r=Math.hypot(x,z);
      return dot(sub(p,base[0]),n)/(-(n[0]*x+n[2]*z)/r);
    };
    for(const index of ids){
      const p=patch.vertices[index],uv=patch.vertexUV[index],grid=patch.topGrid;
      let angle=Math.atan2(patch.center[2]+p[2],patch.center[0]+p[0]);angle+=Math.round(((grid.minAngle+grid.maxAngle)*.5-angle)/TAU)*TAU;
      assert.ok(Math.abs(uv[0]-(angle-grid.minAngle)/(grid.maxAngle-grid.minAngle)*32)<1e-10,'UV follows final physical angle after normal displacement');
      assert.ok(Math.abs(uv[1]-(patch.center[1]+p[1]-grid.minY)/(grid.maxY-grid.minY)*16)<1e-10);
      const h=level(index),kind=patch.surfaceKinds[index];
      if(Math.abs(h)<1e-6)assert.equal(kind,0);
      if(kind===1)assert.ok(h>0);else assert.ok(h<=6+1e-6);
    }
    let area=0;
    for(const index of refined.faces){
      const face=patch.faces[index],[a,b,c]=face.map(i=>patch.vertexUV[i]);
      const signed=((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;assert.ok(signed>0);area+=signed;
      for(let edge=0;edge<3;edge++){const a=face[edge],b=face[(edge+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;boundary.set(key,(boundary.get(key)??0)+1);}
      if(face.every(i=>patch.surfaceKinds[i]===1)){
        const [a,b,c]=face.map(i=>patch.vertices[i]),physical=Math.hypot(...cross(sub(b,a),sub(c,a)))/2;
        assert.ok(physical<625,'interior rock facets actually resolve the old large planes');finer++;
      }
    }
    const uv=refined.base.map(index=>patch.vertexUV[index]),expected=((uv[1][0]-uv[0][0])*(uv[2][1]-uv[0][1])-(uv[1][1]-uv[0][1])*(uv[2][0]-uv[0][0]))/2;
    assert.ok(Math.abs(area-expected)<1e-8);
    const outer=Array.from(boundary).filter(([,count])=>count===1).map(([key])=>key).sort();
    const wanted=refined.base.map((a,index)=>{const b=refined.base[(index+1)%3];return a<b?`${a},${b}`:`${b},${a}`;}).sort();assert.deepEqual(outer,wanted,'shared midpoint splits cannot leave any interior T boundary');
    const coarse=Array.from({length:49},(_,index)=>579+rock*49+index);
    for(const index of coarse.slice(0,24)){assert.ok(Math.abs(level(index))<1e-6);assert.equal(patch.surfaceKinds[index],0);}
    const heights=coarse.slice(24,39).map(level),maximum=Math.max(...ids.map(level));let run=0,longest=0;
    for(let index=0;index<30;index++){run=heights[index%15]<=maximum*.05?run+1:0;longest=Math.max(longest,run);}
    assert.ok(longest>=4,'microgeometry cannot pull the original natural rear into a pedestal rim');
    const controls=coarse.map(level),controlMaximum=Math.max(...controls);
    assert.ok(controls.slice(24).filter(height=>height>controlMaximum*.85).length<=6,'the main roof has a high/low profile rather than a broad equal-height cap');
    let frontCut=false;
    for(let sector=0;sector<3;sector++){
      const wall=24+sector*5,inside=39+sector*3,left=24+(sector*5+14)%15,right=24+(sector*5+1)%15;
      if(Math.abs(controls[wall])<1e-5&&Math.abs(controls[inside])<1e-5&&Math.abs(controls[48])<1e-5
        &&Math.min(controls[left],controls[right])>controlMaximum*.08)frontCut=true;
    }
    assert.equal(frontCut,true,'one actual zero-height cut reaches the front rim between two raised ridges');
  }
  assert.ok(finer>1000);
});

test('different gaps across wrap reject entire continuous patches',()=>{
  const input=options({broken:true,phase:TAU-.025});
  const parts=input.parts.map((part,i)=>i<3?{...part,gapHalfAngle:[.04,.72,.31][i],gapCenter:input.phase+[0,.09,-.13][i]}:part);
  const value={...input,parts},habitat=createRingHabitat(value);assert.ok(habitat.terrainGroups.length>=20&&habitat.terrainGroups.length<32);verifyGeometry(value,habitat);
  const sealed={...input,parts:input.parts.map((part,i)=>i<3?{...part,gapHalfAngle:Math.PI-.005}:part)};assert.equal(createRingHabitat(sealed).terrainGroups.length,0);
});

test('unsupported miniature, narrow and thin cores omit sites; curved thick rings still attach',()=>{
  for(const extra of [{radius:1000},{halfWidth:.0001},{thickness:.0000001}]){
    const input=options(extra),before=JSON.stringify(input.parts);assert.equal(createRingHabitat(input).terrainGroups.length,0);assert.equal(JSON.stringify(input.parts),before);
  }
  for(const extra of [{radius:600000,halfWidth:.5,thickness:.002},{halfWidth:.9,thickness:.68}]){
    const input=options(extra),habitat=createRingHabitat(input);assert.ok(habitat.terrainGroups.length>0);verifyGeometry(input,habitat);
  }
});

test('public mesh construction rejects invalid core and seed',()=>{
  assert.throws(()=>createRingHabitat(options({parts:[]})),TypeError);assert.throws(()=>createRingHabitat(options({seed:null})),TypeError);assert.throws(()=>createRingHabitat(options({radius:0})),RangeError);
  const input=options();assert.throws(()=>createRingHabitat({...input,parts:input.parts.map((p,i)=>i===0?{...p,innerRadius:input.radius}:p)}),RangeError);
});
