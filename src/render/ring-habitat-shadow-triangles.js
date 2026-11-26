import * as THREE from 'three';

// Residual quantization is relative to the stored Float32 high word's ULP.
// Signed255 steps include exact zero; endpoint rounding error is <=ULP/510.
function residualByte(value,high){
  const ulp=high===0?2**-149:2**Math.max(-149,Math.floor(Math.log2(Math.abs(high)))-23);
  return Math.max(-127,Math.min(127,Math.round((value-high)/ulp*255)))+128;
}
function packedResidual(point,data,offset){
  return 1+residualByte(point.x,data[offset])+256*residualByte(point.y,data[offset+1])+65536*residualByte(point.z,data[offset+2]);
}

// Immutable mesh/light transport, owned by the exact raster geometry owner.
// Shadow-focus/camera changes only update the small offset in the shadow owner.
export function createRingHabitatShadowTriangles({uniforms}){
  const light=new THREE.Vector3(),previousLight=new THREE.Vector3(NaN,NaN,NaN),zero=new THREE.Vector3(),up=new THREE.Vector3(),rotation=new THREE.Matrix4(),basis=new THREE.Matrix3(),point=new THREE.Vector3();
  const stats={builds:0,faces:0,bytes:0,texturesDisposed:0,revision:-1,reason:null};
  let texture=null,revision=-1,disposed=false;
  const release=()=>{if(texture){texture.dispose();stats.texturesDisposed++;texture=null;}uniforms.uVegetationShadowTriangles.value=null;uniforms.uVegetationShadowTriangleWidth.value=1;stats.faces=0;stats.bytes=0;revision=-1;};
  const update=(entries,bodyLight,shapeRevision)=>{
    if(disposed)return;
    light.fromArray(bodyLight).normalize();
    const shapeChanged=shapeRevision!==revision,lightChanged=!light.equals(previousLight);
    if(!shapeChanged&&!lightChanged)return;
    if(!entries.length){release();previousLight.copy(light);revision=shapeRevision;return;}
    let faces=0,vertices=0;
    for(const entry of entries){const g=entry.mesh.geometry;faces+=(g.index?g.index.count:g.attributes.position.count)/3;vertices+=g.attributes.position.count;}
    // One face texel stores three exact Float32 integer addresses; each uploaded
    // position follows once. Nonindexed near vertices retain distinct addresses.
    // Ordered corners and the existing2048²/64MiB transport limit are unchanged.
    const width=2048,texels=faces+vertices;
    if(!Number.isSafeInteger(faces)||!Number.isSafeInteger(vertices)||texels>width*2048)throw new RangeError('Complete triangle table exceeds existing2048x2048 transport capacity');
    const height=Math.ceil(texels/width);const origin=uniforms.uVegetationShadowTriangleOrigin.value;
    if(shapeChanged){
      let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
      for(const entry of entries){const p=entry.mesh.geometry.attributes.position,c=entry.center;for(let i=0;i<p.count;i++){const x=c[0]+p.getX(i),y=c[1]+p.getY(i),z=c[2]+p.getZ(i);minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);}}
      origin.set((minX+maxX)*.5,(minY+maxY)*.5,(minZ+maxZ)*.5);
    }
    up.set(0,Math.abs(light.y)>.95?0:1,Math.abs(light.y)>.95?1:0);rotation.lookAt(light,zero,up);basis.setFromMatrix4(rotation).transpose();uniforms.uVegetationShadowTriangleBasis.value.copy(basis);
    if(!texture||texture.image.width!==width||texture.image.height!==height){
      if(texture){texture.dispose();stats.texturesDisposed++;}
      texture=new THREE.DataTexture(new Float32Array(width*height*4),width,height,THREE.RGBAFormat,THREE.FloatType);texture.internalFormat='RGBA32F';texture.name='Canonical habitat shadow triangles';texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;
    }
    const data=texture.image.data;let face=0,vertex=0;
    for(const entry of entries){
      const g=entry.mesh.geometry,p=g.attributes.position,index=g.index,c=entry.center,count=index?index.count:p.count;
      for(let i=0;i<count;i+=3,face++){const offset=face*4;for(let k=0;k<3;k++)data[offset+k]=faces+vertex+(index?index.getX(i+k):i+k);data[offset+3]=0;}
      for(let i=0;i<p.count;i++,vertex++){point.set((c[0]-origin.x)+p.getX(i),(c[1]-origin.y)+p.getY(i),(c[2]-origin.z)+p.getZ(i)).applyMatrix3(basis);const offset=(faces+vertex)*4;data[offset]=point.x;data[offset+1]=point.y;data[offset+2]=point.z;data[offset+3]=packedResidual(point,data,offset);}
    }
    texture.needsUpdate=true;uniforms.uVegetationShadowTriangles.value=texture;uniforms.uVegetationShadowTriangleWidth.value=width;
    stats.builds++;stats.faces=faces;stats.bytes=data.byteLength;stats.revision=shapeRevision;stats.reason=shapeChanged?'shape':'light';revision=shapeRevision;previousLight.copy(light);
  };
  const dispose=()=>{if(disposed)return;disposed=true;release();};
  return {update,clear:release,dispose,stats};
}
