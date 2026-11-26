import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {createRingHabitatVegetation,ringHabitatStandProbability} from '../../src/render/ring-habitat-vegetation.js';
import {createRingHabitat,RING_HABITAT_ECOLOGY} from '../../src/ring-habitat.js';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';
import {createMeshTerrainWorkspace,meshTerrainDistance} from '../../src/mesh-terrain.js';
import {createRingHabitatShadowUniforms} from '../../src/render/ring-habitat-shadow-receiver.js';
import {sampleRingHabitatTop} from '../../src/ring-habitat-sampling.js';

const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-vegetation-fixture'};
const parts=cosmicRingParts(options),habitat=createRingHabitat({...options,parts});
const frame=[1,0,0,0,1,0,0,0,1],inner=parts[0].innerRadius;
function fixture(shadowUniforms,foliageMaterial=null){
  const group=createRingHabitatVegetation({shadowUniforms,foliageMaterial}),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  const body={id:'habitat-vegetation-fixture',kind:'ring',radius:options.radius,phase:options.phase,theme:options.theme,
    frame,light:[.4,.8,.2],center:[0,0,0],shape:{type:'compound',parts,terrainGroups:habitat.terrainGroups},
    habitat:{climate:habitat.climate,ecology:habitat.ecology}};
  let selected=false;
  for(const patch of habitat.terrainGroups){
    for(let i=0;i<patch.topGrid.columns*patch.topGrid.rows;i++){
      const v=patch.vertices[i],x=v[0]+patch.center[0],y=v[1]+patch.center[1],z=v[2]+patch.center[2],r=Math.hypot(x,z);
      const h=inner-r,n=patch.normals[i];
      if(h>100&&h<500&&-(n[0]*x+n[2]*z)/r>.94){
        // Camera is 120 units above a genuine low mountain shoulder.
        body.center[0]=-x*(1-120/r);body.center[1]=-y;body.center[2]=-z*(1-120/r);selected=true;break;
      }
    }
    if(selected)break;
  }
  assert.ok(selected,'fixture has an eligible real terrain shoulder');
  const update=()=>group.userData.update({body,camera,viewportHeight:1000,pixelRatio:1});
  return {group,body,camera,update};
}

function crownComponentThickness(position,faces){
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),cross=new THREE.Vector3();
  const projected=new THREE.Vector3(),minimum=new THREE.Vector3(Infinity,Infinity,Infinity),maximum=new THREE.Vector3(-Infinity,-Infinity,-Infinity),edges=new Map();
  let volume=0;
  for(const face of faces){
    const at=face*3;a.fromBufferAttribute(position,at);b.fromBufferAttribute(position,at+1);c.fromBufferAttribute(position,at+2);
    cross.crossVectors(ab.subVectors(b,a),ac.subVectors(c,a));
    volume+=a.dot(new THREE.Vector3().crossVectors(b,c))/6;
    // Each closed surface projects both entering and exiting faces. The
    // quarter factor includes that pair and cross's twice-triangle-area.
    projected.x+=Math.abs(cross.x)*.25;projected.y+=Math.abs(cross.y)*.25;projected.z+=Math.abs(cross.z)*.25;
    const vertices=[a,b,c];
    for(let i=0;i<3;i++){
      minimum.min(vertices[i]);maximum.max(vertices[i]);
      const from=vertices[i].toArray().join(','),to=vertices[(i+1)%3].toArray().join(','),forward=from<to,key=forward?`${from}/${to}`:`${to}/${from}`,edge=edges.get(key)??[0,0];
      edge[0]++;edge[1]+=forward?1:-1;edges.set(key,edge);
    }
  }
  const span=Math.max(maximum.x-minimum.x,maximum.y-minimum.y,maximum.z-minimum.z);
  const thickness=volume/Math.max(projected.x,projected.y,projected.z);
  return {volume,ratio:thickness/span,closed:[...edges.values()].every(([count,direction])=>count===2&&direction===0)};
}

function assertLowCrownThickness(component){
  // A low-LOD solid bough may have notches, but its effective mean thickness
  // must remain at least one tenth of its longest extent: no thin sprays.
  assert.ok(component.ratio>=.10,'low crown effective thickness must prevent an aspect ratio above 10:1');
}

test('near-field allocation is lazy and roots lie on actual retained top triangles above the sea',()=>{
  const {group,body,update}=fixture();
  assert.equal(group.children.length,0);
  try{
    update();assert.equal(group.children.length,3);assert.ok(group.visible);
    const geometry=group.userData.shadowMesh.geometry,roots=geometry.attributes.iRoot.array;
    assert.ok(geometry.instanceCount>40&&geometry.instanceCount<=4096);
    const work=createMeshTerrainWorkspace(),out={point:[0,0,0],normal:[0,0,0]};
    let worst=0;
    // Independent physical mesh distance query: no renderer sampling helpers.
    for(let i=0;i<geometry.instanceCount;i+=Math.max(1,Math.floor(geometry.instanceCount/120))){
      const x=roots[i*3],y=roots[i*3+1],z=roots[i*3+2];let nearest=Infinity,face=-1,owner=null;
      for(const patch of body.shape.terrainGroups){
        if(Math.hypot(x-patch.center[0],y-patch.center[1],z-patch.center[2])>patch.radius+1)continue;
        assert.notEqual(meshTerrainDistance(patch,x,y,z,out,work),false);
        const distance=Math.sqrt(work.closest.squared);
        if(distance<nearest){nearest=distance;face=work.closest.face;owner=patch;}
      }
      worst=Math.max(worst,nearest);assert.ok(nearest<.08,'float32 root remains on the real mesh');
      assert.ok(face>=0,'root has an actual retained mesh face');
      const triangle=owner.faces[face],a=owner.vertices[triangle[0]],b=owner.vertices[triangle[1]],c=owner.vertices[triangle[2]];
      const faceNormal=new THREE.Vector3().crossVectors(new THREE.Vector3().fromArray(b).sub(new THREE.Vector3().fromArray(a)),new THREE.Vector3().fromArray(c).sub(new THREE.Vector3().fromArray(a))).normalize();
      assert.ok(-(faceNormal.x*x+faceNormal.z*z)/Math.hypot(x,z)>.8,'root is on an upward-facing physical top surface');
      assert.ok(inner-Math.hypot(x,z)>19.9);assert.ok(inner-Math.hypot(x,z)<body.habitat.ecology.forestCeiling+.1);
      assert.ok(geometry.attributes.iShape.array[i*4]>=20&&geometry.attributes.iShape.array[i*4]<=40);
    }
    assert.ok(worst>0,'test includes the real GPU float32 conversion boundary');
  }finally{group.userData.dispose();}
});

test('world-fixed stands form coherent dense/open groups while keeping the recipe mean and continuous boundaries',()=>{
  const size=160,values=new Float64Array(size*size),density=.65,seed=0x53a971;
  let sum=0,squared=0,pairs=0,products=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const p=ringHabitatStandProbability(-830000+x*48,-4000+y*48,120000,density,seed);
    values[y*size+x]=p;sum+=p;squared+=p*p;
    assert.ok(p>=.3-1e-12&&p<=1);
    if(x){products+=p*values[y*size+x-1];pairs++;}
  }
  const mean=sum/values.length,variance=squared/values.length-mean*mean,covariance=products/pairs-mean*mean;
  assert.ok(Math.abs(mean-density)<.025,'spatial grouping preserves expected recipe population');
  assert.ok(variance>.02,'density actually contains open and dense groups');
  assert.ok(covariance/variance>.65,'adjacent cells belong to coherent stands rather than independent planting');
  for(let i=0;i<200;i++){
    const x=-830000+i*73,y=-4017+i*19,z=120000+i*31;
    const p=ringHabitatStandProbability(x,y,z,.65,seed),next=ringHabitatStandProbability(x+.01,y,z,.65,seed);
    assert.ok(Math.abs(p-next)<.001,'small motion does not cross a density discontinuity');
    assert.ok(Math.abs(p-ringHabitatStandProbability(x,y,z,.35,seed)-.30)<1e-12,'recipe density shifts the same stand field without retiming it');
  }
});

test('generated trees break lattice spacing and contain young narrow and mature broader crowns',()=>{
  const {group,update}=fixture();
  try{
    update();const g=group.userData.shadowMesh.geometry,r=g.attributes.iRoot.array,s=g.attributes.iShape.array;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,young=0,mature=0,youngWidth=0,matureWidth=0;
    for(let i=0;i<g.instanceCount;i++){
      const column=(Math.atan2(r[i*3+2],r[i*3])/(Math.PI*2)+.5)*Math.round(Math.PI*2*inner/48),row=r[i*3+1]/48;
      const x=column-Math.floor(column)-.5,y=row-Math.floor(row)-.5;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      if(s[i*4]<25){young++;youngWidth+=s[i*4+1];}
      if(s[i*4]>33){mature++;matureWidth+=s[i*4+1];}
    }
    assert.ok(maxX-minX>.85&&maxY-minY>.85,'root jitter no longer leaves regular rows with a large fixed minimum spacing');
    assert.ok(young/g.instanceCount>.30&&mature/g.instanceCount>.25,'mixed age cohorts replace one uniform size band');
    assert.ok(matureWidth/mature>youngWidth/young+.30,'age changes crown proportions as well as height');
  }finally{group.userData.dispose();}
});

test('production rock terraces use authoritative refined top samples and only their bare area excludes trees',()=>{
  const {group,body,camera,update}=fixture(),control=createRingHabitatVegetation();
  const p=new THREE.Vector3(),n=new THREE.Vector3(),face=new THREE.Vector3(),info={rockCoverage:0};
  let terrace=null;
  // Retain the actual closed mesh/UV topology, changing only classification.
  const unmarked={...body,shape:{...body.shape,terrainGroups:body.shape.terrainGroups.map(patch=>({...patch,surfaceKinds:new Array(patch.vertices.length).fill(0)}))}};
  const visited=new Set();
  try{
    // Search only through the public sampler. No test-local interpretation of
    // refinement topology or a second formula for the terrace elevation.
    search:for(const patch of habitat.terrainGroups){
      if(!patch.refinedFaces?.length)continue;
      const grid=patch.topGrid;
      for(let y=0;y<(grid.rows-1)*8;y++)for(let x=0;x<(grid.columns-1)*8;x++){
        const angle=grid.minAngle+(grid.maxAngle-grid.minAngle)*(x+.5)/((grid.columns-1)*8);
        const axis=grid.minY+(grid.maxY-grid.minY)*(y+.5)/((grid.rows-1)*8);
        if(!sampleRingHabitatTop(patch,angle,axis,p,n,face,info))continue;
        const radius=Math.hypot(p.x,p.z),height=inner-radius,upright=-(face.x*p.x+face.z*p.z)/radius;
        if(info.rockCoverage<=.85||height<=20||height>=body.habitat.ecology.forestCeiling||upright<=.84)continue;
        const cx=p.x,cy=p.y,cz=p.z,columns=Math.round(Math.PI*2*inner/48);
        const tile=`${Math.floor((Math.atan2(cz,cx)/(Math.PI*2)+.5)*columns/10)},${Math.floor(cy/480)}`;
        if(visited.has(tile))continue;visited.add(tile);
        body.center[0]=-cx*(1-120/radius);body.center[1]=-cy;body.center[2]=-cz*(1-120/radius);
        control.userData.update({body:unmarked,camera,viewportHeight:1000});
        const source=control.userData.shadowMesh.geometry,roots=source.attributes.iRoot.array;
        // A geometric sample alone does not guarantee the deterministic planting
        // grid accepts a tree there. Select a real soil-control tree first.
        for(let i=0;i<source.instanceCount;i++){
          const x=roots[i*3],y=roots[i*3+1],z=roots[i*3+2];
          if(sampleRingHabitatTop(patch,Math.atan2(z,x),y,p,n,face,info)&&info.rockCoverage>.40){terrace=new THREE.Vector3(cx,cy,cz);break search;}
        }
      }
    }
    assert.ok(terrace,'production fixture has a real, otherwise plantable refined rock shelf');
    const radius=Math.hypot(terrace.x,terrace.z);
    body.center[0]=-terrace.x*(1-120/radius);body.center[1]=-terrace.y;body.center[2]=-terrace.z*(1-120/radius);update();
    control.userData.update({body:unmarked,camera,viewportHeight:1000});
    const accepted=group.userData.shadowMesh.geometry,all=control.userData.shadowMesh.geometry;
    const roots=all.attributes.iRoot.array,keptRoots=accepted.attributes.iRoot.array,kept=new Set();
    for(let i=0;i<accepted.instanceCount;i++)kept.add(`${keptRoots[i*3]},${keptRoots[i*3+1]},${keptRoots[i*3+2]}`);
    assert.ok(accepted.instanceCount>0,'nearby ordinary forest is retained');
    assert.ok(accepted.instanceCount<all.instanceCount,'real bare shelves remove otherwise eligible trees');
    const work=createMeshTerrainWorkspace(),out={point:[0,0,0],normal:[0,0,0]};let excluded=0,terraceRoots=0;
    for(let i=0;i<all.instanceCount;i++){
      const x=roots[i*3],y=roots[i*3+1],z=roots[i*3+2],angle=Math.atan2(z,x);
      let closest=Infinity,coverage=0;
      for(const patch of body.shape.terrainGroups){
        if(!sampleRingHabitatTop(patch,angle,y,p,n,face,info))continue;
        const squared=(p.x-x)**2+(p.y-y)**2+(p.z-z)**2;
        if(squared<closest){closest=squared;coverage=info.rockCoverage;}
      }
      const present=kept.has(`${x},${y},${z}`);
      if(!present&&i<control.userData.stats.primaryInstances){excluded++;assert.ok(coverage>.348,'every removed primary tree belongs to the actual bare-rock boundary');}
      else if(present)assert.ok(coverage<.352,'ordinary surviving roots remain outside the bare shelf');
      if(coverage>.35){
        terraceRoots++;let distance=Infinity;
        for(const patch of body.shape.terrainGroups){
          if(Math.hypot(x-patch.center[0],y-patch.center[1],z-patch.center[2])>patch.radius+1)continue;
          assert.notEqual(meshTerrainDistance(patch,x,y,z,out,work),false);
          distance=Math.min(distance,Math.sqrt(work.closest.squared));
        }
        assert.ok(distance<.08,'refined-shelf root is anchored to a real retained triangle, never the replaced coarse face');
      }
    }
    assert.ok(excluded>0&&terraceRoots>0,'the test actually exercises new refined shelf geometry');
  }finally{group.userData.dispose();control.userData.dispose();}
});

test('all three decorative limb/needle geometries are closed, outward, finite and bounded',()=>{
  const {group,update}=fixture();
  try{
    update();
    for(let detail=0;detail<3;detail++){
    const g=group.children[detail].geometry,p=g.attributes.position,n=g.attributes.normal,gn=g.attributes.geometricNormal,parts=g.attributes.treePart;
    assert.equal(p.count%3,0);assert.ok(p.count/3<=[800,2500,10000][detail]);
    if(detail===1)assert.ok(p.count/3>=1500,'readable crowns use the requested middle-detail geometry budget');
    if(detail===2)assert.ok(p.count/3>=6000,'near crowns retain their explicitly requested fine geometry');
    const edges=new Map(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),cross=new THREE.Vector3();
    const faceVolumes=new Float64Array(p.count/3),faceAreas=new Float64Array(p.count/3),parents=Array.from({length:p.count/3},(_,i)=>i);
    const owner=i=>{while(parents[i]!==i)i=parents[i];return i;};
    let volume=0,maxY=-Infinity,minY=Infinity,maxRadius=0,trunk=0,crown=0,smoothLeaves=0;
    for(let i=0;i<p.count;i+=3){
      a.fromBufferAttribute(p,i);b.fromBufferAttribute(p,i+1);c.fromBufferAttribute(p,i+2);
      cross.crossVectors(ab.subVectors(b,a),ac.subVectors(c,a));
      assert.ok(cross.length()>1e-8,'no degenerate triangle');
      faceAreas[i/3]=cross.length()*.5;
      const faceNormal=cross.clone().normalize(),signedVolume=a.dot(new THREE.Vector3().crossVectors(b,c))/6;
      volume+=signedVolume;faceVolumes[i/3]=signedVolume;
      const vertices=[a,b,c];
      for(let j=0;j<3;j++){
        const vertex=vertices[j],normal=new THREE.Vector3().fromBufferAttribute(n,i+j),geometric=new THREE.Vector3().fromBufferAttribute(gn,i+j);
        assert.ok(Number.isFinite(vertex.x+vertex.y+vertex.z));assert.ok(Math.abs(normal.length()-1)<1e-6);
        assert.ok(faceNormal.dot(geometric)>1-1e-6,'physical normal matches the actual triangle winding');
        assert.ok(faceNormal.dot(normal)>0,'shading normal faces outward');
        if(parts.getX(i+j)===1&&normal.dot(geometric)<.9999)smoothLeaves++;
        minY=Math.min(minY,vertex.y);maxY=Math.max(maxY,vertex.y);maxRadius=Math.max(maxRadius,Math.hypot(vertex.x,vertex.z));
        const from=vertex.toArray().join(','),to=vertices[(j+1)%3].toArray().join(','),forward=from<to;
        const key=forward?`${from}/${to}`:`${to}/${from}`,edge=edges.get(key)??[0,0,[]];
        edge[0]++;edge[1]+=forward?1:-1;edge[2].push(i/3);edges.set(key,edge);
      }
      if(parts.getX(i)===0)trunk++;else crown++;
    }
    for(const [count,direction,faces] of edges.values()){
      assert.equal(count,2,'each decorative component has a closed surface');assert.equal(direction,0,'shared edges have opposite winding');
      parents[owner(faces[0])]=owner(faces[1]);
    }
    const volumes=new Map(),areas=new Map(),heightBounds=new Map(),leafComponents=new Set(),componentFaces=new Map();
    for(let i=0;i<faceVolumes.length;i++){
      const component=owner(i);volumes.set(component,(volumes.get(component)??0)+faceVolumes[i]);areas.set(component,(areas.get(component)??0)+faceAreas[i]);
      if(parts.getX(i*3)===1){
        leafComponents.add(component);
        const faces=componentFaces.get(component)??[];faces.push(i);componentFaces.set(component,faces);
        const bounds=heightBounds.get(component)??[Infinity,-Infinity];
        for(let vertex=0;vertex<3;vertex++){const y=p.getY(i*3+vertex);bounds[0]=Math.min(bounds[0],y);bounds[1]=Math.max(bounds[1],y);}
        heightBounds.set(component,bounds);
      }
    }
    assert.ok(volumes.size>1);for(const signedVolume of volumes.values())assert.ok(signedVolume>0,'every closed decorative component winds outward');
    if(detail===0){
      assert.ok(leafComponents.size>1,'far crown has overlapping solid branch lobes rather than one exposed cone');
      for(const component of leafComponents)assertLowCrownThickness(crownComponentThickness(p,componentFaces.get(component)));
      assert.ok([...heightBounds.values()].some(([low,high])=>high-low>=.75),'one closed continuous crown body spans most of the tree height');
      // Flatten exactly one real outer bough, leaving the continuous core and
      // every other bough intact. Closure and positive volume alone must not
      // let that paper-thin component pass the low-LOD solid-crown contract.
      const branch=[...leafComponents].find(component=>{const [low,high]=heightBounds.get(component);return high-low<.75;});
      assert.notEqual(branch,undefined);const faces=componentFaces.get(branch),thin=p.clone(),[low,high]=heightBounds.get(branch),centre=(low+high)*.5;
      for(const face of faces)for(let vertex=0;vertex<3;vertex++){const at=face*3+vertex;thin.setY(at,centre+(p.getY(at)-centre)*.01);}
      const flattened=crownComponentThickness(thin,faces),original=crownComponentThickness(p,faces);
      assert.equal(flattened.closed,true,'the negative control remains a closed outward-oriented component');
      assert.ok(flattened.volume>0);assert.ok(Math.abs(flattened.volume/original.volume-.01)<1e-4,'only bough thickness was reduced');
      assert.throws(()=>assertLowCrownThickness(flattened),/effective thickness/,'one thin bough cannot hide behind the unchanged solid crown');
    }else{
      const bulk=[...leafComponents].filter(component=>volumes.get(component)/Math.pow(areas.get(component),1.5)>=.05);
      assert.ok(bulk.length<=1,'only the continuous crown core is volumetric; outer needle sprays remain thin');
    }
    assert.ok(volume>0);assert.ok(trunk>0&&crown>trunk);assert.equal(minY,0);assert.equal(maxY,1);
    if(detail>0)assert.ok(smoothLeaves>crown*.5,'needle-spray shading follows bowed fans, while separate physical normals retain true facets');
    assert.ok(maxRadius<.36,'expanded overlapping sprays remain inside the bounded tree/fade reserve');
    assert.equal(g.attributes.iRoot.array.length,4096*3);assert.equal(g.attributes.iShape.array.length,4096*4);
    // Geometry is built once; neither camera updates nor tile rebuilds replace it.
    const vertices=g.attributes.position.array;update();assert.equal(g.attributes.position.array,vertices);
    }
  }finally{group.userData.dispose();}
});

test('all LODs retain crown projected area from multiple side directions',()=>{
  const {group,update}=fixture();
  try{
    update();const width=64,height=96,mask=new Uint8Array(width*height);
    for(const mesh of group.children){
      const p=mesh.geometry.attributes.position,part=mesh.geometry.attributes.treePart;
      for(const angle of [0,Math.PI/4,Math.PI/2,Math.PI*.75]){
        mask.fill(0);const c=Math.cos(angle),s=Math.sin(angle);
        for(let i=0;i<p.count;i+=3){
          if(part.getX(i)!==1)continue;
          const ax=((p.getX(i)*c+p.getZ(i)*s)+.34)/.68*width,ay=p.getY(i)*height;
          const bx=((p.getX(i+1)*c+p.getZ(i+1)*s)+.34)/.68*width,by=p.getY(i+1)*height;
          const cx=((p.getX(i+2)*c+p.getZ(i+2)*s)+.34)/.68*width,cy=p.getY(i+2)*height;
          const determinant=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(determinant)<1e-9)continue;
          const minX=Math.max(0,Math.floor(Math.min(ax,bx,cx))),maxX=Math.min(width-1,Math.ceil(Math.max(ax,bx,cx)));
          const minY=Math.max(0,Math.floor(Math.min(ay,by,cy))),maxY=Math.min(height-1,Math.ceil(Math.max(ay,by,cy)));
          for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
            const qx=x+.5-ax,qy=y+.5-ay,u=(qx*(cy-ay)-qy*(cx-ax))/determinant,v=((bx-ax)*qy-(by-ay)*qx)/determinant;
            if(u>=0&&v>=0&&u+v<=1)mask[y*width+x]=1;
          }
        }
        const coverage=mask.reduce((sum,value)=>sum+value,0)/(width*height);
        assert.ok(coverage>=.18,'crown area must not collapse into a sparse stem at another view/LOD');
      }
    }
  }finally{group.userData.dispose();}
});

test('warm updates change camera uniforms without uploading stable world-fixed instances',()=>{
  const {group,body,camera,update}=fixture();
  try{
    update();const mesh=group.children[0],g=mesh.geometry,u=mesh.material.uniforms;
    const roots=g.attributes.iRoot,normal=g.attributes.iGroundNormal,shape=g.attributes.iShape;
    const versions=[roots.version,normal.version,shape.version],count=g.instanceCount,rebuilds=group.userData.stats.rebuilds;
    camera.rotation.y=.7;camera.position.set(200000,300000,-400000);
    update();
    assert.deepEqual([roots.version,normal.version,shape.version],versions);assert.equal(g.instanceCount,count);
    assert.equal(group.userData.stats.rebuilds,rebuilds);
    const master=group.userData.shadowMesh.geometry,masterVersion=master.attributes.iRoot.version;
    group.userData.update({body,camera,viewportHeight:2000,pixelRatio:2});
    assert.equal(master.attributes.iRoot.version,masterVersion,'screen-size LOD changes never reseed or move master roots');
    assert.equal(u.uPixelAngle.value,2/(camera.projectionMatrix.elements[5]*4000));
    const expected=new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse);
    assert.deepEqual(u.uViewRotation.value.elements,expected.elements);
    assert.deepEqual(u.uBodyCenter.value.toArray(),body.center,'camera translation is not applied twice');
  }finally{group.userData.dispose();}
});

test('packed LOD membership preserves master anchors, complete shadows and complementary transitions',()=>{
  const {group,body,update}=fixture();
  const key=(roots,i)=>`${roots[i*3]},${roots[i*3+1]},${roots[i*3+2]}`;
  try{
    update();const lods=group.userData.lodMeshes,shadows=group.userData.shadowMeshes,master=group.userData.shadowMesh.geometry;
    const roots=master.attributes.iRoot.array,total=master.instanceCount,known=new Set(),drawn=new Set();
    for(let i=0;i<total;i++)known.add(key(roots,i));
    assert.equal(lods.length,3);assert.equal(shadows.length,3);assert.equal(group.userData.shadowMesh,shadows[2]);
    let vertices=0;
    for(let detail=0;detail<3;detail++){
      const g=lods[detail].geometry,r=g.attributes.iRoot.array;
      assert.notEqual(g.attributes.iRoot,master.attributes.iRoot,'packed render roots never truncate or overwrite shadow master data');
      assert.equal(shadows[detail].geometry.attributes.position,g.attributes.position);
      assert.equal(shadows[detail].geometry.attributes.iRoot,master.attributes.iRoot);
      assert.equal(shadows[detail].geometry.instanceCount,total);
      vertices+=g.instanceCount*g.attributes.position.count;
      for(let i=0;i<g.instanceCount;i++){
        const id=key(r,i);assert.ok(known.has(id),'render root belongs to the original master forest');drawn.add(id);
        const distance=Math.hypot(r[i*3]+body.center[0],r[i*3+1]+body.center[1],r[i*3+2]+body.center[2]);
        const pixels=g.attributes.iShape.array[i*4]/(distance*lods[detail].material.uniforms.uPixelAngle.value);
        if(detail===2)assert.ok(distance<242&&pixels>139,'high detail is restricted to large, nearby trees');
        if(detail===1)assert.ok(distance<1102&&pixels>35,'middle pass owns readable trees, including 100-pixel crowns');
        if(detail===0)assert.ok(distance<1102&&pixels<65,'coarse crown geometry never substitutes for a large readable tree');
      }
    }
    for(let i=0;i<total;i++){
      const distance=Math.hypot(roots[i*3]+body.center[0],roots[i*3+1]+body.center[1],roots[i*3+2]+body.center[2]);
      if(distance<(i<group.userData.stats.primaryInstances?1080:300))assert.ok(drawn.has(key(roots,i)),'every clearly nonzero-coverage primary or companion tree remains represented');
    }
    assert.ok(vertices<total*lods[2].geometry.attributes.position.count/4,'high-detail geometry is actually excluded from far instances');
  }finally{group.userData.dispose();}
});

test('a readable 100-pixel tree uses middle geometry and the high mesh remains distance-bounded',()=>{
  const {group,body,camera,update}=fixture();
  try{
    update();const master=group.userData.shadowMesh.geometry,r=master.attributes.iRoot.array,s=master.attributes.iShape.array;
    const x=r[0],y=r[1],z=r[2],height=s[0],radius=Math.hypot(x,z),key=`${x},${y},${z}`;
    const has=(detail)=>{
      const g=group.children[detail].geometry,points=g.attributes.iRoot.array;
      for(let i=0;i<g.instanceCount;i++)if(`${points[i*3]},${points[i*3+1]},${points[i*3+2]}`===key)return i;
      return -1;
    };
    const place=(distance,pixels)=>{
      body.center[0]=-x*(1-distance/radius);body.center[1]=-y;body.center[2]=-z*(1-distance/radius);
      const pixelAngle=height/(pixels*distance),viewportHeight=2/(camera.projectionMatrix.elements[5]*pixelAngle);
      group.userData.update({body,camera,viewportHeight,pixelRatio:1});
    };
    place(200,100);const index=has(1);
    assert.ok(index>=0);assert.equal(has(0),-1);assert.equal(has(2),-1);
    const coverage=group.children[1].geometry.attributes.iShadowCoverage;
    assert.equal(coverage.getX(index),1);assert.equal(coverage.getY(index),0);assert.equal(coverage.getZ(index),1);
    place(300,500);
    assert.equal(has(2),-1,'even an enormous projected tree cannot activate high geometry outside its 240-unit near field');
    assert.ok(has(1)>=0);
  }finally{group.userData.dispose();}
});

test('visible and shadow passes consume the same quantized coverage and complementary packed intervals',()=>{
  const {group,camera,body,update}=fixture();
  try{
    update();assert.equal(group.userData.shadowCasters,group.userData.lodMeshes);
    const byRoot=new Map();let faded=0;
    for(let detail=0;detail<3;detail++){
      const mesh=group.userData.shadowCasters[detail],g=mesh.geometry,w=g.attributes.iShadowCoverage,r=g.attributes.iRoot.array;
      assert.equal(g,group.children[detail].geometry);assert.equal(w.itemSize,3);assert.equal(w.normalized,true);
      assert.ok(w.array instanceof Uint8Array);assert.equal(w.array.length,4096*3);
      for(let i=0;i<g.instanceCount;i++){
        const coverage=w.array[i*3],start=w.array[i*3+1],end=w.array[i*3+2];
        assert.ok(coverage>0&&end>start,'zero-coverage/empty-interval trees are absent from actual caster draws');
        const key=`${r[i*3]},${r[i*3+1]},${r[i*3+2]}`,records=byRoot.get(key)??[];
        records.push([coverage,start,end]);byRoot.set(key,records);if(coverage<255)faded++;
      }
    }
    assert.ok(faded>0,'actual distance fade is exercised');
    for(const records of byRoot.values()){
      records.sort((a,b)=>a[1]-b[1]);assert.equal(records[0][1],0);assert.equal(records.at(-1)[2],255);
      for(let i=0;i<records.length;i++){
        assert.equal(records[i][0],records[0][0],'all representations of one tree share the same overall visibility');
        if(i)assert.equal(records[i-1][2],records[i][1],'LOD coverage has neither overlapping stochastic intervals nor gaps');
      }
    }
    const attrs=group.children.map(m=>m.geometry.attributes.iShadowCoverage),arrays=attrs.map(a=>a.array),versions=attrs.map(a=>a.version);
    camera.rotation.y+=Math.PI;update();
    assert.deepEqual(attrs.map(a=>a.version),versions,'looking away does not remove legitimate offscreen casters');
    body.center[1]-=4;update();assert.ok(attrs.some((a,i)=>a.version>versions[i]),'moving through a fade revises actual caster weights');
    const movedVersions=attrs.map(a=>a.version);update();assert.deepEqual(attrs.map(a=>a.version),movedVersions,'stationary warm frames do not upload weights');
    attrs.forEach((a,i)=>assert.equal(a.array,arrays[i]));
    const masterCount=group.userData.shadowMesh.geometry.instanceCount;
    group.userData.update({body,camera,viewportHeight:1});
    assert.ok(group.userData.shadowCasters.every(m=>m.geometry.instanceCount===0),'subpixel invisible trees cannot leave opaque ghost shadows');
    assert.equal(group.userData.shadowMesh.geometry.instanceCount,masterCount,'visibility never deletes the authoritative master trees');
  }finally{group.userData.dispose();}
});

test('camera movement only uploads LOD lists whose membership changes, reusing all master and packed arrays',()=>{
  const {group,body,update}=fixture();
  try{
    const tileY=Math.floor(-body.center[1]/480);body.center[1]=-(tileY*480+264);update();
    const lods=group.userData.lodMeshes,master=group.userData.shadowMesh.geometry,roots=master.attributes.iRoot.array;
    const masterVersion=master.attributes.iRoot.version,masterCount=master.instanceCount;
    const arrays=lods.map(m=>m.geometry.attributes.iRoot.array),versions=lods.map(m=>m.geometry.attributes.iRoot.version);
    body.center[1]-=.000001;update();
    assert.deepEqual(lods.map(m=>m.geometry.attributes.iRoot.version),versions,'subpixel movement with unchanged membership does not upload');
    body.center[1]-=12;update();
    assert.equal(master.attributes.iRoot.array,roots);assert.equal(master.attributes.iRoot.version,masterVersion);
    assert.equal(master.instanceCount,masterCount,'camera movement does not delete/reseed master trees');
    assert.ok(lods.some((m,i)=>m.geometry.attributes.iRoot.version>versions[i]),'movement crosses actual LOD memberships');
    for(let i=0;i<3;i++)assert.equal(lods[i].geometry.attributes.iRoot.array,arrays[i]);
    const movedVersions=lods.map(m=>m.geometry.attributes.iRoot.version);update();
    assert.deepEqual(lods.map(m=>m.geometry.attributes.iRoot.version),movedVersions,'stationary repeat has no upload');
  }finally{group.userData.dispose();}
});

test('tile changes use fixed capacity and revisiting the same world seed restores exact tree bytes',()=>{
  const {group,body,update}=fixture();
  try{
    update();const mesh=group.children[0],g=group.userData.shadowMesh.geometry,roots=g.attributes.iRoot.array,shapes=g.attributes.iShape.array;
    const count=g.instanceCount,first=roots.slice(0,count*3),firstShapes=shapes.slice(0,count*4),center=body.center.slice();
    for(let i=1;i<=24;i++){
      body.center[1]=center[1]+i*480;update();
      assert.equal(group.children.length,3);assert.equal(group.children[0],mesh);assert.equal(group.userData.shadowMesh.geometry,g);
      assert.equal(g.attributes.iRoot.array,roots);assert.equal(g.attributes.iShape.array,shapes);
      assert.equal(roots.length,4096*3);assert.ok(g.instanceCount<=4096);
    }
    body.center[1]=center[1];update();
    assert.equal(g.instanceCount,count);assert.deepEqual(roots.slice(0,count*3),first);assert.deepEqual(shapes.slice(0,count*4),firstShapes);
  }finally{group.userData.dispose();}
});

for(const tileCells of [1,10])test(`trees added or removed at a ${tileCells*48}-unit tile boundary already have zero distance coverage`,()=>{
  const {group,body,update}=fixture();
  const snapshot=()=>{
    const g=group.userData.shadowMesh.geometry,roots=g.attributes.iRoot.array,result=new Map();
    for(let i=0;i<g.instanceCount;i++){
      const p=Array.from(roots.subarray(i*3,i*3+3)),key=p.join(',');p.push(i>=group.userData.stats.primaryInstances?1:0);result.set(key,p);
    }
    return result;
  };
  try{
    const cameraY=-body.center[1],boundary=(Math.floor(cameraY/(48*tileCells))+1)*48*tileCells;
    const radius=Math.hypot(body.center[0],body.center[2]),columns=Math.round(Math.PI*2*inner/48);
    const cameraColumn=(Math.atan2(-body.center[2],-body.center[0])/(Math.PI*2)+.5)*columns;
    const angleBoundary=(Math.floor(cameraColumn/tileCells)+1)*tileCells/columns*Math.PI*2-Math.PI;
    // Cross both axes at once: the worst tile-corner camera offset, rather
    // than the easier midpoint of an edge. Physical travel is only millimetres.
    const beforeAngle=angleBoundary-.001/inner,afterAngle=angleBoundary+.001/inner;
    body.center[0]=-radius*Math.cos(beforeAngle);body.center[2]=-radius*Math.sin(beforeAngle);
    body.center[1]=-boundary+.001;update();
    const before=snapshot(),oldCenter=body.center.slice(),fade=group.children[0].material.uniforms.uFadeRange.value;
    body.center[0]=-radius*Math.cos(afterAngle);body.center[2]=-radius*Math.sin(afterAngle);
    body.center[1]=-boundary-.001;update();
    const after=snapshot(),newCenter=body.center.slice();let changes=0;
    const coverage=(p,c)=>{
      const distance=Math.hypot(p[0]+c[0],p[1]+c[1],p[2]+c[2]);
      const start=p[3]?240:fade.x,end=p[3]?320:fade.y;
      const t=Math.max(0,Math.min(1,(distance-start)/(end-start)));
      return 1-t*t*(3-2*t);
    };
    for(const [key,p] of before)if(!after.has(key)){
      changes++;assert.equal(coverage(p,oldCenter),0,'removed tree was already invisible before crossing');
      assert.equal(coverage(p,newCenter),0,'removed tree is outside the visible distance after crossing');
    }
    for(const [key,p] of after)if(!before.has(key)){
      changes++;assert.equal(coverage(p,oldCenter),0,'new tree was outside visible distance before crossing');
      assert.equal(coverage(p,newCenter),0,'new tree remains invisible when its instance is added');
    }
    assert.ok(changes>0,'the test actually replaces trees at the generation boundary');
  }finally{group.userData.dispose();}
});

test('slot/theme changes consume authoritative ecology and clear stale trees on other bodies or departure',()=>{
  const {group,body,camera,update}=fixture();
  try{
    update();const mesh=group.children[0],g=mesh.geometry,originalCount=g.instanceCount;
    body.theme='old-gold';body.habitat={climate:2,ecology:RING_HABITAT_ECOLOGY[2]};update();
    assert.ok(g.instanceCount<originalCount,'producer arid density has fewer trees');
    assert.ok(mesh.material.uniforms.uFoliage.value.r>mesh.material.uniforms.uFoliage.value.b,'arid palette remains warmer than conifer green');
    group.userData.update({body:{...body,kind:'gas-giant'},camera,viewportHeight:1000});
    assert.equal(group.visible,false);assert.equal(g.instanceCount,0);assert.equal(group.children.length,3);
    update();assert.ok(g.instanceCount>0);
    const cx=body.center[0],cz=body.center[2],r=Math.hypot(cx,cz);
    body.center[0]*=(r-5000)/r;body.center[2]*=(r-5000)/r;update();
    assert.equal(group.visible,false);assert.equal(g.instanceCount,0);
  }finally{group.userData.dispose();}
});

test('tree receivers borrow only shadow-prefixed records and preserve independent scene-unit transforms',()=>{
  const shared={...createRingHabitatShadowUniforms(),uBodyCenter:{value:new THREE.Vector3(.2,.3,.4)},uLight:{value:new THREE.Vector3(-9,-8,-7)}};
  const {group,body,update}=fixture(shared);
  try{
    assert.equal(group.children.length,0,'receiver defaults allocate no GPU geometry or maps');update();
    const cameraLocal=group.userData.cameraLocal;
    assert.ok(cameraLocal instanceof THREE.Vector3);assert.deepEqual(cameraLocal.toArray(),body.center.map(n=>-n));
    for(const mesh of group.children){
      const u=mesh.material.uniforms;
      for(const name in shared)if(name.startsWith('uVegetationShadow'))assert.equal(u[name],shared[name]);
      assert.notEqual(u.uBodyCenter,shared.uBodyCenter);assert.notEqual(u.uLight,shared.uLight);
      assert.deepEqual(u.uBodyCenter.value.toArray(),body.center,'foreign normalized body transform never enters trees');
    }
    shared.uVegetationShadowEnabled.value=1;
    assert.ok(group.children.every(mesh=>mesh.material.uniforms.uVegetationShadowEnabled.value===1));
    update();assert.equal(group.userData.cameraLocal,cameraLocal);
  }finally{group.userData.dispose();}
  const isolated=fixture();
  try{
    isolated.update();
    assert.equal(isolated.group.children[0].material.uniforms.uVegetationShadowEnabled.value,0);
    assert.equal(isolated.group.children[0].material.uniforms.uVegetationShadow.value,null);
  }finally{isolated.group.userData.dispose();}
});

test('foliage bundle records are constructor-owned, shared across LODs and keep atlas textures borrowed',()=>{
  const color=new THREE.DataTexture(new Uint8Array(4*4*4),4,4),alpha=new THREE.DataTexture(new Uint8Array(4*4*4),4,4);
  const uvRect=[.640625,.6171875,.953125,.96875],bundle={color,alpha,uvRect};
  const {group,update}=fixture(undefined,bundle);let colorDisposals=0,alphaDisposals=0;
  color.addEventListener('dispose',()=>colorDisposals++);alpha.addEventListener('dispose',()=>alphaDisposals++);
  try{
    const u=group.userData.foliageUniforms;
    assert.equal(group.children.length,0);assert.equal(u.uHasHabitatFoliage.value,true);
    assert.equal(u.uHabitatFoliageColor.value,color);assert.equal(u.uHabitatFoliageAlpha.value,alpha);
    assert.deepEqual(u.uHabitatFoliageUV.value.toArray(),uvRect);
    uvRect[0]=.1;assert.equal(u.uHabitatFoliageUV.value.x,.640625,'caller rectangle arrays are copied once');
    update();
    for(const mesh of group.children)for(const name in u)assert.equal(mesh.material.uniforms[name],u[name]);
    group.userData.dispose();assert.equal(colorDisposals,0);assert.equal(alphaDisposals,0);
    assert.equal(u.uHabitatFoliageColor.value,color);assert.equal(u.uHabitatFoliageAlpha.value,alpha);
  }finally{group.userData.dispose();color.dispose();alpha.dispose();}
  assert.equal(colorDisposals,1);assert.equal(alphaDisposals,1);
  const isolated=createRingHabitatVegetation();
  try{assert.equal(isolated.userData.foliageUniforms.uHasHabitatFoliage.value,false);assert.equal(isolated.userData.foliageUniforms.uHabitatFoliageAlpha.value,null);}
  finally{isolated.userData.dispose();}
});

test('atlas crowns retain real roots and use complete thick cutout twigs instead of opaque near filler',()=>{
  const color=new THREE.DataTexture(new Uint8Array(4),1,1),alpha=new THREE.DataTexture(new Uint8Array(4),1,1);
  const {group,body,update}=fixture(undefined,{color,alpha,uvRect:[.640625,.6171875,.953125,.96875]}),control=fixture();
  const wood=g=>{const h=createHash('sha256');for(let i=0;i<g.attributes.position.count;i+=3)if(g.attributes.treePart.getX(i)===0)for(const a of Object.values(g.attributes))if(!a.isInstancedBufferAttribute){const first=i*a.itemSize;h.update(new Uint8Array(a.array.buffer,a.array.byteOffset+first*a.array.BYTES_PER_ELEMENT,3*a.itemSize*a.array.BYTES_PER_ELEMENT));}return h.digest('hex');};
  try{
    assert.deepEqual(body.center,control.body.center);update();control.update();
    assert.equal(group.userData.stats.instances,control.group.userData.stats.instances);
    assert.deepEqual(group.userData.stats.lodInstances,control.group.userData.stats.lodInstances);
    for(let detail=0;detail<3;detail++){
      const g=group.children[detail].geometry,reference=control.group.children[detail].geometry,p=g.attributes.position,uv=g.attributes.treeUV,part=g.attributes.treePart;
      assert.equal(p.count/3,[800,2000,7472][detail]);assert.equal(uv.itemSize,3);assert.equal(uv.count,p.count);
      assert.equal(group.userData.shadowMeshes[detail].geometry.attributes.treeUV,uv,'shadow views borrow identical static UVs');
      assert.equal(group.userData.shadowCasters[detail].geometry,g,'actual caster uses this same cutout geometry');
      assert.equal(wood(g),wood(reference),'atlas representation never replaces or deforms actual wood');
      for(const[name,a]of Object.entries(g.attributes))if(a.isInstancedBufferAttribute||detail===0)assert.deepEqual(a.array,reference.attributes[name].array,'roots/shape/coverage and complete lowLOD stay independent of the atlas representation');
      const parents=Array.from({length:p.count/3},(_,i)=>i),edges=new Map(),owner=i=>{while(parents[i]!==i)i=parents[i];return i;};
      for(let i=0;i<p.count;i+=3){
        const tag=uv.getZ(i);assert.equal(uv.getZ(i+1),tag);assert.equal(uv.getZ(i+2),tag);
        for(let j=0;j<3;j++){
          assert.ok(uv.getX(i+j)>=0&&uv.getX(i+j)<=1&&uv.getY(i+j)>=0&&uv.getY(i+j)<=1);
          if(part.getX(i+j)===0)assert.equal(tag,0,'wood never samples the foliage atlas');
          else assert.equal(tag,detail===0?0:1,'every near foliage surface consumes the shared alpha; no opaque filler');
          const from=[p.getX(i+j),p.getY(i+j),p.getZ(i+j)].join(','),next=i+(j+1)%3,to=[p.getX(next),p.getY(next),p.getZ(next)].join(','),key=from<to?from+'/'+to:to+'/'+from,face=i/3;
          if(edges.has(key))parents[owner(face)]=owner(edges.get(key));else edges.set(key,face);
        }
      }
      if(detail>0){
        const components=new Map();for(let face=0;face<p.count/3;face++)if(part.getX(face*3)===1){const id=owner(face),faces=components.get(id)??[];faces.push(face);components.set(id,faces);}assert.ok(components.size>0);
        for(const faces of components.values()){
          const shape=crownComponentThickness(p,faces);assert.ok(shape.closed&&shape.volume>0);assert.ok(shape.ratio>=.03,'each mapped twig has finite3Dthickness instead of a coplanar card');
          let area=0;for(const face of faces){const i=face*3;area+=Math.abs((uv.getX(i+1)-uv.getX(i))*(uv.getY(i+2)-uv.getY(i))-(uv.getY(i+1)-uv.getY(i))*(uv.getX(i+2)-uv.getX(i)))*.5;}
          assert.ok(Math.abs(area-2)<1e-4,'each closed cutout twig spans the complete atlas rectangle on both broad sides');
        }
        if(detail===1){
          // Preserve UVs/closure while flattening one real leaf cluster. The
          // same thickness contract must reject it without relying on face count.
          const faces=components.values().next().value,thin=p.clone(),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
          for(const face of faces)for(let j=0;j<3;j++)for(let k=0;k<3;k++){const v=p.getComponent(face*3+j,k);min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v);}
          const span=max.map((v,k)=>v-min[k]),axis=span.indexOf(Math.min(...span)),centre=(min[axis]+max[axis])*.5;
          for(const face of faces)for(let j=0;j<3;j++){const at=face*3+j;thin.setComponent(at,axis,centre+(p.getComponent(at,axis)-centre)*.001);}
          const flattened=crownComponentThickness(thin,faces);assert.ok(flattened.closed&&flattened.volume>0);assert.ok(flattened.ratio<.03,'a closed positive-volume paper cluster cannot pass the3Dcontract');
        }
      }
      const array=uv.array;update();assert.equal(g.attributes.treeUV.array,array,'UVs remain static through warm updates');
    }
  }finally{group.userData.dispose();control.group.userData.dispose();color.dispose();alpha.dispose();}
});

test('dispose releases all owned LOD/shadow wrappers and materials once, leaving borrowed terrain intact',()=>{
  const {group,body,update}=fixture();update();let geometries=0,materials=0;
  for(const mesh of [...group.children,...group.userData.shadowMeshes])mesh.geometry.addEventListener('dispose',()=>geometries++);
  for(const mesh of group.children)mesh.material.addEventListener('dispose',()=>materials++);
  const borrowed=body.shape.terrainGroups;
  group.userData.dispose();group.userData.dispose();update();
  assert.equal(geometries,6);assert.equal(materials,3);assert.equal(group.visible,false);assert.equal(group.children.length,0);
  assert.equal(group.userData.shadowMesh,null);assert.equal(group.userData.shadowMeshes.length,0);
  assert.equal(body.shape.terrainGroups,borrowed);assert.ok(Object.isFrozen(borrowed));assert.ok(borrowed[0].vertices.length>0);
  const empty=createRingHabitatVegetation();empty.userData.dispose();empty.userData.dispose();assert.equal(empty.children.length,0);
});


test('worst producer lattice envelopes fit all primary and near companion candidates without truncation',()=>{
  // Smallest producer with terrain: referenceLength>=8000 and
  // referenceLength<=radius*(tau/32)*.13, thickness<1/1.45.
  const minimumInner=8000/(Math.PI*2/32*.13)*(1-1/1.45);
  const spacing=48/(1+48/(2*Math.PI*2*minimumInner));
  const maximumSpacing=48/(1-48/(2*Math.PI*2*minimumInner));
  const support=320*minimumInner/(minimumInner-3500)+.1+Math.SQRT2*maximumSpacing/2+18;
  let primaries=0,stands=0;
  // Each jitter box is allowed its independently most favourable position:
  // this upper bound is stronger than testing any particular random seed.
  for(let y=-34;y<=34;y++)for(let x=-34;x<=34;x++){
    if((Math.max(Math.abs(x+.5)-.46,0)*spacing)**2+(Math.max(Math.abs(y+.5)-.46,0)*48)**2<=1536**2)primaries++;
    if((Math.max(Math.abs(x)-.46,0)*spacing)**2+(Math.max(Math.abs(y)-.46,0)*48)**2<=support**2)stands++;
  }
  assert.equal(primaries,3324);assert.equal(stands,241);
  assert.equal(primaries+3*stands,4047);assert.ok(primaries+3*stands<=4096);
});

test('near companions increase actual local roots, stay on soil and retain world-fixed primary anchors across near tiles',t=>{
  const {group,body,update}=fixture();
  const sample=new THREE.Vector3(),normal=new THREE.Vector3(),face=new THREE.Vector3(),info={rockCoverage:0};
  try{
    update();const master=group.userData.shadowMesh.geometry,roots=master.attributes.iRoot.array,shapes=master.attributes.iShape.array;
    const primary=group.userData.stats.primaryInstances,initial=roots.slice(0,primary*3),primaryShapes=shapes.slice(0,primary*4);
    t.diagnostic(`fixture primary=${primary}, companions=${group.userData.stats.companionInstances}; packed LOD=${group.userData.stats.lodInstances.join('/')}; triangles per visible or per shadow cascade=${group.userData.lodMeshes.reduce((sum,m)=>sum+m.geometry.instanceCount*m.geometry.attributes.position.count/3,0)}`);
    assert.ok(group.userData.stats.companionInstances>30,'this terrain actually receives additional true 3D trees');
    assert.equal(master.instanceCount,primary+group.userData.stats.companionInstances);
    let visibleCompanions=0;
    for(let i=primary;i<master.instanceCount;i++){
      const x=roots[i*3],y=roots[i*3+1],z=roots[i*3+2],angle=Math.atan2(z,x);
      let nearestStand=Infinity,nearestSurface=Infinity,rock=0;
      for(let j=0;j<primary;j++){
        let da=angle-Math.atan2(roots[j*3+2],roots[j*3]);da-=Math.round(da/(Math.PI*2))*Math.PI*2;
        nearestStand=Math.min(nearestStand,Math.hypot(da*inner,y-roots[j*3+1]));
      }
      assert.ok(nearestStand<18.1,'companions form bounded groups around retained primary stands');
      for(const patch of body.shape.terrainGroups){
        if(!sampleRingHabitatTop(patch,angle,y,sample,normal,face,info))continue;
        const d=Math.hypot(sample.x-x,sample.y-y,sample.z-z);
        if(d<nearestSurface){nearestSurface=d;rock=info.rockCoverage;}
      }
      assert.ok(nearestSurface<.08);assert.ok(rock<.352);
      assert.ok(inner-Math.hypot(x,z)>20&&inner-Math.hypot(x,z)<body.habitat.ecology.forestCeiling);
      assert.ok(shapes[i*4]>=20&&shapes[i*4]<=40);
      if(Math.hypot(x+body.center[0],y+body.center[1],z+body.center[2])<240)visibleCompanions++;
    }
    assert.ok(visibleCompanions>20,'local density gain is within the fully visible zone');
    const before=new Map();for(let i=primary;i<master.instanceCount;i++)before.set(Array.from(roots.subarray(i*3,i*3+3)).join(','),Array.from(shapes.subarray(i*4,i*4+4)));
    const originalCenter=body.center.slice();body.center[1]-=48;update();
    assert.equal(group.userData.stats.primaryInstances,primary);
    assert.deepEqual(roots.slice(0,primary*3),initial);assert.deepEqual(shapes.slice(0,primary*4),primaryShapes);
    let shared=0;
    for(let i=primary;i<master.instanceCount;i++){
      const key=Array.from(roots.subarray(i*3,i*3+3)).join(',');
      if(before.has(key)){shared++;assert.deepEqual(Array.from(shapes.subarray(i*4,i*4+4)),before.get(key));}
    }
    assert.ok(shared>30,'near tile crossing preserves identical roots and shapes in the overlap');
    const masterArray=roots,version=master.attributes.iRoot.version;update();
    assert.equal(master.attributes.iRoot.array,masterArray);assert.equal(master.attributes.iRoot.version,version);
    body.center.splice(0,3,...originalCenter);update();
    assert.equal(master.instanceCount,primary+before.size);
    for(let i=primary;i<master.instanceCount;i++)assert.ok(before.has(Array.from(roots.subarray(i*3,i*3+3)).join(',')));
  }finally{group.userData.dispose();}
});
