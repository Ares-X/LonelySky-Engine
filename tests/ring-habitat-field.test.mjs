import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRingHabitat} from '../src/ring-habitat.js';
import {cosmicRingParts,cosmicSolidsInBounds} from '../src/cosmic-bodies.js';
import {createRingHabitatSourceProfile,createRingHabitatField,clipRingHabitatShoreTriangle,createRetainedShoreline,RING_HABITAT_FIELD_VERSION,RING_HABITAT_FIELD_LATTICE_L,RING_HABITAT_REGION_SIZE_L,RING_HABITAT_FIELD_MIN_HEIGHT_L,RING_HABITAT_FIELD_MAX_HEIGHT_L} from '../src/ring-habitat-field.js';

const options=(extra={})=>{const o={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture',...extra};o.parts=cosmicRingParts(o);return o;};
const recipeOptions=options(),recipes=createRingHabitat({...recipeOptions,terrainMode:'regions'}).terrainRecipes;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((v,k)=>v-b[k]);

test('opt-in recipe mode preserves corrected legacy output and the original admission stream',()=>{
  for(const [seed,sha,recipeSha] of [["habitat-fixture","232afa7001d8f7220dcbeeaa425f7c7948a61bb9f79ce01e02ffc20bc80d3988","8765d5b4450b77b51af756af7345fa59f2dbfb7b1b6f29572a3a0019c487867e"],["block-review-7","c88db42eb8301d6d6beef864335f07986582eb18dcc0e9a99dc640cc17a5b60e","4aa74fc35f0e0c9fead44880ae19d39ad3bc743ab216ca25abe41c9c714ec93e"]]){
    const o=options({seed}),legacy=createRingHabitat(o),regions=createRingHabitat({...o,terrainMode:'regions'});
    // C1 source admission corrects low terrain vertices; seeded controls and
    // site admission still match the pre-fix recipe bytes.
    assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),sha);
    assert.equal(createHash('sha256').update(JSON.stringify(regions.terrainRecipes)).digest('hex'),recipeSha);
    assert.deepEqual(createRingHabitat({...o,terrainMode:'legacy'}),legacy);
    assert.equal(regions.terrainGroups.length,0);assert.equal(regions.terrainRecipes.length,legacy.terrainGroups.length);
    assert.ok(JSON.stringify(regions).length<100000,'macro descriptor retains controls, not terrain vertices/BVH');
    for(let i=0;i<regions.terrainRecipes.length;i++){
      const r=regions.terrainRecipes[i],g=legacy.terrainGroups[i].topGrid;
      assert.deepEqual([r.minAngle,r.maxAngle,r.minY,r.maxY,r.innerRadius],[g.minAngle,g.maxAngle,g.minY,g.maxY,g.innerRadius]);
      assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.sources)&&Object.isFrozen(r.sources[0].peaks[0]));
      assert.equal(r.version,'halo-field-v1');assert.equal(r.lengthUnit,'L');assert.equal(r.siteIndex,i);
      assert.ok(!('vertices' in r)&&!('faces' in r)&&!('nodes' in r));
    }
    assert.deepEqual(o,options({seed}));
  }
  const broken=options({broken:true,phase:-2.9,seed:'block-review-7'}),old=createRingHabitat(broken),regions=createRingHabitat({...broken,terrainMode:'regions'});
  assert.equal(regions.terrainRecipes.length,old.terrainGroups.length);
  for(let i=0;i<old.terrainGroups.length;i++)assert.equal(regions.terrainRecipes[i].minAngle,old.terrainGroups[i].topGrid.minAngle);
  assert.throws(()=>createRingHabitat({...recipeOptions,terrainMode:'unknown'}),/terrain mode/);
});

test('whole-feature fields are deterministic, bounded and independent of query order or another instance',()=>{
  assert.equal(RING_HABITAT_FIELD_MIN_HEIGHT_L,-24);assert.equal(RING_HABITAT_FIELD_MAX_HEIGHT_L,3042.5+64);
  assert.equal(RING_HABITAT_FIELD_VERSION,'halo-field-v1');assert.equal(RING_HABITAT_FIELD_LATTICE_L,16);assert.equal(RING_HABITAT_REGION_SIZE_L,256);
  const p=[0,0,0],n=[0,0,0];
  for(const r of recipes){
    const field=createRingHabitatField(r),other=createRingHabitatField(JSON.parse(JSON.stringify(r))),{maxX:w,maxY:h}=field.bounds;
    assert.ok(Object.isFrozen(field)&&Object.isFrozen(field.bounds));assert.ok(field.hmin>=RING_HABITAT_FIELD_MIN_HEIGHT_L&&field.hmax<=RING_HABITAT_FIELD_MAX_HEIGHT_L);assert.ok(field.statistics.sparseControls>0);
    assert.ok(field.statistics.warpJacobianBound<1);assert.ok(Number.isSafeInteger(field.statistics.accountedBytes)&&field.statistics.accountedBytes>0&&field.statistics.accountedBytes<2*1024*1024);
    for(let iy=0;iy<=12;iy++)for(let ix=0;ix<=20;ix++){
      const x=ix/20*w,y=iy/12*h,value=field.sampleHeight(x,y);
      assert.ok(Number.isFinite(value)&&value>=field.hmin&&value<=field.hmax);
      other.sampleHeight(w-x,h-y);assert.equal(other.sampleHeight(x,y),value);
      assert.equal(field.position(x,y,p),p);assert.equal(field.normal(x,y,n),n);
      assert.ok(Math.abs((field.innerRadius-Math.hypot(p[0],p[2]))-value)<2e-9);
      assert.equal(p[1],r.minY+y);assert.ok(Math.abs(Math.hypot(...n)-1)<1e-12);
      assert.ok(-n[0]*Math.cos(r.minAngle+x/r.innerRadius)-n[2]*Math.sin(r.minAngle+x/r.innerRadius)>0);
    }
  }
});

test('field normals follow actual curved world positions with reusable output ownership',()=>{
  const f=createRingHabitatField(recipes[7]),p=[0,0,0],n=[0,0,0],a=[0,0,0],b=[0,0,0],c=[0,0,0],d=[0,0,0];
  for(let k=1;k<=31;k++){
    const x=f.bounds.maxX*(k*.61803398875%1)*.8+f.bounds.maxX*.1,y=f.bounds.maxY*(k*.41421356237%1)*.8+f.bounds.maxY*.1,e=.01;
    f.position(x,y,p);const before=p.slice();f.normal(x,y,n);assert.deepEqual(p,before);
    f.position(x-e,y,a);f.position(x+e,y,b);f.position(x,y-e,c);f.position(x,y+e,d);
    const geometric=cross(sub(b,a),sub(d,c)),size=Math.hypot(...geometric);
    assert.ok(dot(geometric,n)/size>.99999,'normal agrees with independent position derivatives');
  }
});

// Independent old plane/cylinder intersections. These witnesses come from the
// retained legacy source top, not from the new field's distance implementation.
function coastWitnesses(group){
  const {innerRadius:inner,minAngle,minY}=group.topGrid,R=inner-12,result=[];
  for(let row=0;row<16;row++)for(let col=0;col<32;col++){
    const a=row*33+col,b=a+1,c=a+33,d=c+1,faces=(row+col)%2?[[a,b,d],[a,d,c]]:[[a,b,c],[b,d,c]];
    for(const face of faces){
      const points=face.map(i=>group.vertices[i].map((v,k)=>v+group.center[k])),[a,b,c]=points,n=cross(sub(b,a),sub(c,a)),hits=[];
      for(let edge=0;edge<3;edge++){
        const p=points[edge],q=points[(edge+1)%3],dx=q[0]-p[0],dz=q[2]-p[2],A=dx*dx+dz*dz,B=2*(p[0]*dx+p[2]*dz),C=p[0]*p[0]+p[2]*p[2]-R*R,disc=B*B-4*A*C;
        if(A===0||disc<=0)continue;
        for(const t of [(-B-Math.sqrt(disc))/(2*A),(-B+Math.sqrt(disc))/(2*A)]){
          if(t<=1e-5||t>=1-1e-5)continue;
          const point=p.map((v,k)=>v+(q[k]-v)*t);let phi=Math.atan2(point[2],point[0]);phi+=Math.round((minAngle-phi)/(Math.PI*2))*Math.PI*2;
          hits.push({phi,axis:point[1]});
        }
      }
      if(hits.length!==2||Math.hypot((hits[0].phi-hits[1].phi)*inner,hits[0].axis-hits[1].axis)<100)continue;
      // Interior of the analytic source contour arc, away from triangle-edge
      // corners whose two adjoining normals need not pick the same land side.
      let phi=(hits[0].phi+hits[1].phi)/2,axis=(hits[0].axis+hits[1].axis)/2;
      const D=dot(n,a);
      if(Math.abs((hits[0].phi-hits[1].phi)*inner)>Math.abs(hits[0].axis-hits[1].axis)&&n[1]!==0)axis=(D-R*(n[0]*Math.cos(phi)+n[2]*Math.sin(phi)))/n[1];
      else{
        const phase=Math.atan2(n[2],n[0]),alpha=Math.acos(Math.max(-1,Math.min(1,(D-n[1]*axis)/(R*Math.hypot(n[0],n[2])))));
        let p=phase+alpha,q=phase-alpha;p+=Math.round((phi-p)/(Math.PI*2))*Math.PI*2;q+=Math.round((phi-q)/(Math.PI*2))*Math.PI*2;phi=Math.abs(p-phi)<Math.abs(q-phi)?p:q;
      }
      const x=(phi-minAngle)*inner,y=axis-minY,den=n[0]*Math.cos(phi)+n[2]*Math.sin(phi),hx=R*(-n[0]*Math.sin(phi)+n[2]*Math.cos(phi))/(inner*den),hy=n[1]/den,size=Math.hypot(hx,hy);
      if(size>1e-6)result.push({x,y,nx:hx/size,ny:hy/size});
    }
  }
  return result;
}
test('the retained12L full-land contour has bounded physical shore grades on both sides',()=>{
  const legacy=createRingHabitat(recipeOptions);
  for(const index of [0,11,22]){
    const f=createRingHabitatField(recipes[index]),witnesses=coastWitnesses(legacy.terrainGroups[index]);assert.ok(witnesses.length>50);
    for(let i=0;i<witnesses.length;i+=Math.ceil(witnesses.length/96)){
      const {x,y,nx,ny}=witnesses[i];assert.ok(Math.abs(f.sampleHeight(x,y)-12)<.081,'old visible footprint retained within0.25L contour approximation');
      for(const d of [2,6,12]){
        const inside=f.sampleHeight(x+nx*d,y+ny*d),outside=f.sampleHeight(x-nx*d,y-ny*d);
        assert.ok(inside>12&&outside<12,'signed physical distance retains land/water sides '+JSON.stringify({index,x,y,nx,ny,d,inside,outside}));
        assert.ok(Math.abs(inside-12)<d*.4&&Math.abs(outside-12)<d*.4,'no tall coastal admission curtain');
      }
    }
  }
});

test('zero-peak plains, lowland sites and dry climate have explicit valid field paths',()=>{
  const original=recipes[0],p=[0,0,0],n=[0,0,0];
  for(const sources of [[],original.sources.map(s=>({...s,peaks:s.peaks.map(p=>[p[0],p[1],0])}))]){
    const f=createRingHabitatField({...original,sources});assert.equal(f.hasLand,false);assert.equal(f.hmin,-24);assert.equal(f.hmax,-24);
    assert.equal(f.sampleHeight(10,20),-24);assert.equal(f.position(10,20,p),p);assert.equal(f.normal(10,20,n),n);assert.ok(n.every(Number.isFinite));
  }
  const low=createRingHabitatField({...original,sources:original.sources.map(s=>({...s,peaks:s.peaks.map(p=>[p[0],p[1],p[2]*.15])}))});
  assert.equal(low.hasLand,true);assert.ok(low.statistics.sourcePeaks>0&&low.hmax<500);
  for(let j=0;j<=8;j++)for(let i=0;i<=8;i++){
    const height=low.sampleHeight(low.bounds.maxX*i/8,low.bounds.maxY*j/8);
    assert.ok(Number.isFinite(height)&&height>=low.hmin&&height<=low.hmax,'lowland detail stays within its own physical bounds');
  }
  const dry=createRingHabitat({...options({theme:'old-gold'}),terrainMode:'regions'}),a=createRingHabitatField(original),b=createRingHabitatField(dry.terrainRecipes[0]);
  assert.equal(dry.climate,2);assert.equal(dry.terrainRecipes[0].seed,original.seed);
  for(let k=0;k<30;k++){const x=a.bounds.maxX*k/30,y=a.bounds.maxY*(k*.71%1);assert.equal(a.sampleHeight(x,y),b.sampleHeight(x,y));}
  assert.throws(()=>createRingHabitatField({...original,version:'unknown'}),/Unsupported/);
  assert.throws(()=>createRingHabitatField({...original,sources:[{...original.sources[0],peaks:[[1,0,30],[0,0,40]]}]}),/Unordered/);
});

function triangleContains(points,p){const [a,b,c]=points,u=sub(b,a),v=sub(c,a),q=sub(p,a),uu=dot(u,u),uv=dot(u,v),vv=dot(v,v),qu=dot(q,u),qv=dot(q,v),den=uu*vv-uv*uv,s=(vv*qu-uv*qv)/den,t=(uu*qv-uv*qu)/den;return s>=-1e-10&&t>=-1e-10&&s+t<=1+1e-10;}
function countAt(arcs,phi){let count=0;for(const arc of arcs){let lo=Math.min(arc.a[0],arc.b[0]),hi=Math.max(arc.a[0],arc.b[0]);for(const shift of [-Math.PI*2,0,Math.PI*2])if(phi+shift>lo+1e-8&&phi+shift<hi-1e-8)count++;}return count;}
test('plane/cylinder clipping retains4/6 crossings and classifies tangencies and vertical branches',()=>{
  const fixtures=[
    {name:'four',points:[[2,0,0],[-2,0,0],[0,0,.8]],crossings:4,arcs:2},
    {name:'six',points:Array.from({length:3},(_,i)=>[1.5*Math.cos(i*Math.PI*2/3),0,1.5*Math.sin(i*Math.PI*2/3)]),crossings:6,arcs:3},
    {name:'one tangent',points:[[1,0,0],[2,0,-1],[2,0,1]],crossings:1,arcs:0},
    {name:'enclosed circle',points:[[-3,0,-3],[3,0,-3],[0,0,4]],crossings:0,arcs:1},
    {name:'vertical',points:[[0,-2,-2],[0,-2,2],[0,2,0]],crossings:4,arcs:2},
    {name:'vertical tangent',points:[[1,-2,-2],[1,-2,2],[1,2,0]],crossings:2,arcs:1},
  ];
  fixtures.push({...fixtures[0],name:'tilted four',points:fixtures[0].points.map(p=>[p[0],.6*p[0]-.2*p[2],p[2]])});
  fixtures.push({name:'near-tangent vertical',points:[[1-1e-12,-2,-.01],[1-1e-12,-1,.01],[1-1e-12,2,.005]],crossings:4,arcs:2});
  for(const fixture of fixtures){
    const result=clipRingHabitatShoreTriangle(fixture.points,1);assert.equal(result.crossings,fixture.crossings,fixture.name);assert.equal(result.arcs.length,fixture.arcs,fixture.name);
    const n=cross(sub(fixture.points[1],fixture.points[0]),sub(fixture.points[2],fixture.points[0])),D=dot(n,fixture.points[0]);
    for(const arc of result.arcs)for(let k=0;k<=20;k++){const phi=arc.a[0]+(arc.b[0]-arc.a[0])*k/20,y=n[1]===0?arc.a[1]+(arc.b[1]-arc.a[1])*k/20:(D-n[0]*Math.cos(phi)-n[2]*Math.sin(phi))/n[1],p=[Math.cos(phi),y,Math.sin(phi)];assert.ok(Math.abs(dot(n,p)-D)<1e-10);assert.ok(Math.abs(Math.hypot(p[0],p[2])-1)<1e-14);assert.ok(triangleContains(fixture.points,p),fixture.name);}
    if(n[1]!==0)for(let k=0;k<1000;k++){const phi=-Math.PI+(k+.371)/1000*Math.PI*2,p=[Math.cos(phi),(D-n[0]*Math.cos(phi)-n[2]*Math.sin(phi))/n[1],Math.sin(phi)];assert.equal(countAt(result.arcs,phi),Number(triangleContains(fixture.points,p)),fixture.name+' gaps/double coverage');}
    if(fixture.name==='one tangent')assert.equal(result.tangencies,1);
    if(fixture.name==='vertical tangent')assert.equal(result.arcs[0].crossing,false,'touching line has distance but cannot toggle land parity');
  }
});

function bayPatch(){
  const columns=5,rows=5,vertices=[],faces=[],vertexUV=[];
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){const phi=-.6+x*.3,axis=-2+y,r=x===0||y===0||x===4||y===4?1.1:x===2&&y===2?.8:1.001;vertices.push([r*Math.cos(phi),axis,r*Math.sin(phi)]);vertexUV.push([x,y]);}
  for(let y=0;y<4;y++)for(let x=0;x<4;x++){const a=y*5+x,b=a+1,c=a+5,d=c+1;if((x+y)%2)faces.push([a,b,d],[a,d,c]);else faces.push([a,b,c],[b,d,c]);}
  return {center:[0,0,0],vertices,faces,vertexUV,topGrid:{columns,rows,innerRadius:13,minAngle:-.6,maxAngle:.6,minY:-2,maxY:2}};
}
test('multi-branch shore graph is closed and indexed parity agrees with independent radial triangle intersections',()=>{
  const patch=bayPatch(),shore=createRetainedShoreline(patch,{cellSize:1,maxDeviationL:1e-5}),degree=new Map();assert.ok(shore.splitTriangles>0);assert.ok(shore.contourArcs>patch.faces.length/2);assert.equal('ambiguousTriangles' in shore,false);
  for(const segment of shore.segments)for(const p of [segment.a,segment.b]){const key=p.map(v=>Math.round(v*1e7)).join(',');degree.set(key,(degree.get(key)??0)+1);}assert.ok([...degree.values()].every(n=>n===2),'every split contour endpoint has its matching neighboring arc');
  const out={};let tested=0;
  for(let j=0;j<40;j++)for(let i=0;i<60;i++){
    const phi=-.6+(i+.371)/60*1.2,y=-2+(j+.219)/40*4,rx=Math.cos(phi),rz=Math.sin(phi);let radius=null;
    for(const face of patch.faces){const points=face.map(k=>patch.vertices[k]),n=cross(sub(points[1],points[0]),sub(points[2],points[0])),r=(dot(n,points[0])-n[1]*y)/(n[0]*rx+n[2]*rz);if(r>0&&triangleContains(points,[r*rx,y,r*rz])){if(radius!==null)assert.ok(Math.abs(radius-r)<1e-10);radius=r;}}
    assert.notEqual(radius,null);shore.query((phi+.6)*13,y+2,out);if(Math.abs(out.distance)<1e-3)continue;assert.equal(out.inside,radius<1,'one parity crossing for each actual retained land boundary');assert.ok(Number.isFinite(out.distance));tested++;
  }assert.ok(tested>2000);
  assert.throws(()=>createRetainedShoreline(patch,{maxSegments:1,sourceId:'budget-body/site-4'}),/segment budget: budget-body\/site-4/);
  assert.throws(()=>createRetainedShoreline(patch,{maxDepth:0,maxDeviationL:1e-14,sourceId:'budget-body/site-4'}),/subdivision budget: budget-body\/site-4/);
});

test('static interior detail preserves corrected coastal and downstream lowland heights',()=>{
  // Frozen macro-field heights after correcting C1 source admission, at
  // independent retained-shore witnesses,400L seaward and200/500L landward. Detail must remain zero
  // throughout this coastal band, including land already well above12L.
  const cases=[
    [0,52723.713910182254,3906.0347355582203,-20.643413792117606],
    [0,52730.053055714,4506.001247318608,49.54043771423959],
    [0,52733.22262847987,4805.984503198802,103.21033234246215],
    [11,16058.261146662406,3580.6837230617352,-20.971063735252358],
    [11,16058.185588141581,4180.68371830416,55.86655500011],
    [11,16058.14780888117,4480.683715925373,126.31272107094985],
    [22,5062.191103858314,4686.436812971664,-21.52444133116653],
    [22,5218.6491915589995,5265.678443720909,60.81225603513666],
    [22,5296.878235409342,5555.299259095532,137.31102634577627],
  ];

  for(const [index,x,y,height] of cases){
    const f=createRingHabitatField(recipes[index]),p=[0,0,0];
    assert.equal(f.sampleHeight(x,y),height,'coast and its lowland continuation retain corrected macro height');
    f.position(x,y,p);assert.ok(Math.abs(f.innerRadius-Math.hypot(p[0],p[2])-height)<2e-9);
  }
});

test('signed interior relief changes real geometry within64L of corrected macro heights',()=>{
  // Corrected macro-field values are numeric witnesses, not a second runtime field
  // implementation. Exercise opposite signs and several existing landforms.
  const cases=[
    [0,0.3,0.3,152.9248787833017],
    [0,0.7,0.7,420.484512586989],
    [7,0.3,0.3,245.04777170484408],
    [7,0.5,0.5,210.14415160637856],
    [7,0.7,0.7,254.59066092899457],
    [22,0.3,0.3,137.4577673682224],
    [22,0.5,0.5,211.43037549039838],
    [22,0.7,0.7,408.9121074484665],
    [24,0.5625,0.625,166.901345793771],
    [3,0.1875,0.5625,369.730923676146],
  ];

  let lowest=Infinity,highest=-Infinity;
  for(const [index,fx,fy,originalHeight] of cases){
    const f=createRingHabitatField(recipes[index]),x=f.bounds.maxX*fx,y=f.bounds.maxY*fy,p=[0,0,0],value=f.sampleHeight(x,y),change=value-originalHeight;
    assert.ok(Math.abs(change)<=64,'actual height stays within the exported cold-query extra envelope');
    assert.ok(value>12&&value<=f.hmax&&f.hmax<=RING_HABITAT_FIELD_MAX_HEIGHT_L);
    f.position(x,y,p);assert.ok(Math.abs(f.innerRadius-Math.hypot(p[0],p[2])-value)<2e-9,'perturbation moves real surface positions');
    lowest=Math.min(lowest,change);highest=Math.max(highest,change);
  }
  assert.ok(lowest<-1&&highest>1,'detail has real depressions and raises rather than a uniform altitude shift');
});

test('all canonical ring fields in the actual ordinary ridge sector display bounds construct',()=>{
  // Public seeded world and ordinary saved-sector fixture from the normal
  // renderer observation. Include its extra20k streaming margin, not only the
  // selected site's near physical window.
  const radius=32020000,bounds={min:[-radius,-radius,-radius],max:[radius,radius,radius]},rings=cosmicSolidsInBounds({sectorIndex:32865088429165,bounds,seed:'lonely-universe-v2',terrainMode:'regions'}).filter(b=>b.kind==='ring');let count=0;
  assert.ok(rings.some(b=>b.id==='cosmic-body-v3:-28,30,-22'));
  for(const body of rings)for(const recipe of body.habitat.terrainRecipes){const field=createRingHabitatField(recipe);assert.ok(Number.isFinite(field.sampleHeight(field.bounds.maxX*.43,field.bounds.maxY*.61)),body.id+'/site-'+recipe.siteIndex);for(const key of ['shoreSplitTriangles','shoreTangentTriangles','shoreArcs'])assert.ok(Number.isInteger(field.statistics[key])&&field.statistics[key]>=0);count++;}
  assert.equal(count,rings.reduce((n,b)=>n+b.habitat.terrainRecipes.length,0));assert.ok(count>=28);
});


test('first source foot has continuous height and derivative without an overlap pedestal',()=>{
  const recipe=recipes[0],source=recipe.sources[0],profile=createRingHabitatSourceProfile({...recipe,inner:recipe.innerRadius,sources:[source]});
  const sample=offset=>{
    const u=source.peaks[0][0]-.32*source.length+offset;
    return profile.sampleBaseHeight(source.angle+u*source.cr/recipe.innerRadius,source.y+u*source.sr);
  };
  // The original source returned17.98L here as a vanishing candidate entered.
  assert.equal(sample(-.001),0);
  const at=sample(0),inside=sample(.001);
  assert.ok(at>=0&&inside>=0&&at<1e-6&&inside<1e-6);
  assert.ok(Math.abs((inside-at)/.001)<1e-5,'no entry impulse in the source derivative');
});

test('fully admitted high source overlaps retain their pre-fix height',()=>{
  const recipe=recipes[0],source={angle:recipe.angle,y:0,length:20000,width:5000,cr:1,sr:0,peaks:[[-4000,0,300],[4000,0,300]]};
  const profile=createRingHabitatSourceProfile({...recipe,inner:recipe.innerRadius,sources:[source,{...source}]});
  const heights=[174.30273203585804,174.3031246946232,174.30351751587287];
  for(let i=0;i<3;i++)assert.equal(profile.sampleBaseHeight(recipe.angle+(i-1)*.1/recipe.innerRadius,0),heights[i]);
});

test('whole-mesh shared events keep exact exterior rows outside for vertical and multiple-arc shores',()=>{
  // Complete closed components isolated from valid seeded source meshes. Every
  // contour point lies to the right of the query, an independent outside proof.
  // Former per-triangle endpoint reconstruction opened these exact rows by ulps.
  const fixtures=JSON.parse(readFileSync(new URL('./fixtures/ring-habitat-shore-shared-events.json',import.meta.url)));
  for(const fixture of fixtures){
    const shore=createRetainedShoreline(fixture.patch,fixture.options),out={};
    assert.ok(fixture.minimumContourX>fixture.point.x);
    for(const offset of[-1e-6,0,1e-6]){
      shore.query(fixture.point.x,fixture.point.y+offset,out);
      assert.equal(out.inside,false,fixture.kind+' exact and neighboring rows are outside');
      assert.ok(out.distance<0);
    }
    shore.query(fixture.point.x,fixture.point.y,out);
    assert.ok(Math.abs(Math.abs(out.distance)-fixture.distanceMagnitude)<1e-6,'event sharing preserves geometric distance');
  }
});
