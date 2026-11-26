const TAU=Math.PI*2;

/** Sample createRingHabitat's retained top triangles and required metadata.
 * This internal API consumes vertexUV/refinedFaces/surfaceKinds from that
 * producer; it does not infer metadata for arbitrary public mesh inputs.
 * Positions
 * are written in body-local scene units (patch.center already included).
 * Output vectors expose x/y/z; optional surfaceInfo is caller-owned storage.
 * UVs describe topology only: no second terrain height function is evaluated.
 */
export function sampleRingHabitatTop(patch,angle,y,point,normal,faceNormal,surfaceInfo=null){
  const grid=patch.topGrid;
  angle+=Math.round(((grid.minAngle+grid.maxAngle)*.5-angle)/TAU)*TAU;
  if(angle<grid.minAngle||angle>=grid.maxAngle||y<grid.minY||y>=grid.maxY)return false;
  const gx=(angle-grid.minAngle)/(grid.maxAngle-grid.minAngle)*(grid.columns-1);
  const gy=(y-grid.minY)/(grid.maxY-grid.minY)*(grid.rows-1);
  const first=(Math.floor(gy)*(grid.columns-1)+Math.floor(gx))*2;
  for(let side=0;side<2;side++){
    const original=first+side;
    let refined=null;
    for(let i=0;i<patch.refinedFaces.length;i++)if(patch.refinedFaces[i].face===original){refined=patch.refinedFaces[i];break;}
    const count=refined?refined.faces.length:1;
    for(let candidate=0;candidate<count;candidate++){
      const face=patch.faces[refined?refined.faces[candidate]:original],ia=face[0],ib=face[1],ic=face[2];
      const au=patch.vertexUV[ia],bu=patch.vertexUV[ib],cu=patch.vertexUV[ic];
      const ax=au[0],ay=au[1],bx=bu[0]-ax,by=bu[1]-ay,cx=cu[0]-ax,cy=cu[1]-ay;
      const determinant=bx*cy-by*cx;
      const b=((gx-ax)*cy-(gy-ay)*cx)/determinant;
      const c=(bx*(gy-ay)-by*(gx-ax))/determinant,a=1-b-c;
      // A closed shared-edge inclusion rule permits either incident face at
      // a rounding boundary; both interpolate the same retained edge points.
      if(a<-1e-10||b<-1e-10||c<-1e-10)continue;
      const va=patch.vertices[ia],vb=patch.vertices[ib],vc=patch.vertices[ic];
      point.x=patch.center[0]+va[0]*a+vb[0]*b+vc[0]*c;
      point.y=patch.center[1]+va[1]*a+vb[1]*b+vc[1]*c;
      point.z=patch.center[2]+va[2]*a+vb[2]*b+vc[2]*c;
      const na=patch.normals[ia],nb=patch.normals[ib],nc=patch.normals[ic];
      normal.x=na[0]*a+nb[0]*b+nc[0]*c;normal.y=na[1]*a+nb[1]*b+nc[1]*c;normal.z=na[2]*a+nb[2]*b+nc[2]*c;
      const size=Math.hypot(normal.x,normal.y,normal.z);normal.x/=size;normal.y/=size;normal.z/=size;
      const ux=vb[0]-va[0],uy=vb[1]-va[1],uz=vb[2]-va[2],vx=vc[0]-va[0],vy=vc[1]-va[1],vz=vc[2]-va[2];
      faceNormal.x=uy*vz-uz*vy;faceNormal.y=uz*vx-ux*vz;faceNormal.z=ux*vy-uy*vx;
      const faceSize=Math.hypot(faceNormal.x,faceNormal.y,faceNormal.z);faceNormal.x/=faceSize;faceNormal.y/=faceSize;faceNormal.z/=faceSize;
      if(surfaceInfo)surfaceInfo.rockCoverage=patch.surfaceKinds[ia]*a+patch.surfaceKinds[ib]*b+patch.surfaceKinds[ic]*c;
      return true;
    }
  }
  return false;
}
