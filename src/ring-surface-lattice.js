/** Implicit, finite plates on an annular slab's outer cylindrical wall.
 * No plate array is retained. Local coordinates and world-length units match
 * solid-geometry.js; callers retain their existing frame conversion and roots.
 */
const TAU = Math.PI * 2;
const wrap = x => ((x % TAU) + TAU) % TAU;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function ringSurfaceHash(seed, column, row, salt = 0) {
  let h = (seed ^ Math.imul(column + 1, 0x9e3779b9) ^ Math.imul(row + 1, 0x85ebca6b) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
export function createRingSurfaceLattice(parent, { pitch = 3000, rowPitch = 1500, depth = 64, seed = 0, tiered = false } = {}) {
  if (!(parent.innerRadius >= 0 && parent.outerRadius > parent.innerRadius && parent.maxY > parent.minY &&
    parent.gapHalfAngle >= 0 && parent.gapHalfAngle < Math.PI && Number.isFinite(parent.gapCenter)) ||
    ![pitch, rowPitch, depth].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(seed) || typeof tiered !== 'boolean') throw new RangeError('Invalid ring surface lattice');
  const columns = Math.max(4, Math.ceil(TAU * parent.outerRadius / pitch));
  const rows = Math.max(1, Math.ceil((parent.maxY - parent.minY) / rowPitch));
  if (columns > 0x7fffffff || rows > 0x7fffffff) throw new RangeError('Ring surface lattice exceeds shader integer range');
  const step = TAU / columns;
  // A whole cell must fit the parent's admitted arc. In particular, plates
  // never bridge a broken gap, even if their smaller randomized slab would fit.
  return Object.freeze({ innerRadius: parent.outerRadius, outerRadius: parent.outerRadius + depth,
    minY: parent.minY, maxY: parent.maxY, gapCenter: parent.gapCenter, gapHalfAngle: parent.gapHalfAngle,
    columns, rows, angleStep: step, tiered, masked: false, seed: seed >>> 0, firstColumn: Math.ceil(parent.gapHalfAngle / step),
    lastColumn: parent.gapHalfAngle === 0 ? columns - 1 : Math.floor((TAU - parent.gapHalfAngle) / step) - 1 });
}
export function createRingSurfaceWorkspace({ maxCells = 4096 } = {}) {
  if (!Number.isInteger(maxCells) || maxCells < 1) throw new RangeError('Invalid lattice cell budget');
  const workspace = surfaceWorkspace(maxCells);
  workspace.child = surfaceWorkspace(128);
  workspace.childLattice = { innerRadius: 0, outerRadius: 0, minY: 0, maxY: 0, gapCenter: 0, gapHalfAngle: 0,
    columns: 8, rows: 8, angleStep: 0, tiered: false, masked: true, seed: 0, firstColumn: 0, lastColumn: 7 };
  workspace.envelope = { type: 'annular-sector-slab', innerRadius: 0, outerRadius: 0, minY: 0, maxY: 0, gapCenter: 0, gapHalfAngle: 0 };
  return workspace;
}
function surfaceWorkspace(maxCells) {
  return { maxCells, count: 0, childCells: 0, status: 'complete', reason: undefined,
    plate: { type: 'annular-sector-slab', innerRadius: 0, outerRadius: 0, minY: 0, maxY: 0, gapCenter: 0, gapHalfAngle: 0 },
    distance: { distance: Infinity, normal: [0, 0, 0], feature: '', part: -1 }, scratch: [0, 0],
    intervals: new Float64Array(4), intervalCount: 0 };
}
/** Discrete equipment groups, shared verbatim with the shader's mask. */
export function ringSurfaceChildCell(seed, column, row) {
  const mode = seed & 3;
  if (mode === 1) return column >= 2 && column <= 5 && row >= 1 && row <= 6 && ((column + row) & 1) === 0;
  if (mode === 2) return column >= 1 && column <= 6 && (row === 1 || row === 2 || row === 5 || row === 6);
  return row >= 1 && row <= 6 && (column === 1 || column === 2 || column === 5 || column === 6);
}
/** Mutates caller storage. Returns false for a cell removed by the parent gap. */
export function ringSurfacePlate(lattice, column, row, out) {
  if (column < lattice.firstColumn || column > lattice.lastColumn || row < 0 || row >= lattice.rows) return false;
  if (lattice.masked && !ringSurfaceChildCell(lattice.seed, column, row)) return false;
  const a = lattice.angleStep, b = (lattice.maxY - lattice.minY) / lattice.rows;
  const width = .2 + .6 * (ringSurfaceHash(lattice.seed, column, row, 0) & 65535) / 65536;
  const height = .2 + .6 * (ringSurfaceHash(lattice.seed, column, row, 1) & 65535) / 65536;
  const jx = .2 * (ringSurfaceHash(lattice.seed, column, row, 2) & 65535) / 65536 - .1;
  const jy = .2 * (ringSurfaceHash(lattice.seed, column, row, 3) & 65535) / 65536 - .1;
  const relief = (ringSurfaceHash(lattice.seed, column, row, 4) & 65535) / 65536;
  out.type = 'annular-sector-slab'; out.innerRadius = lattice.innerRadius;
  out.outerRadius = lattice.innerRadius + (lattice.outerRadius-lattice.innerRadius)*(lattice.tiered ? .8 : 1)*(.15+.85*relief*relief);
  out.minY = lattice.minY + (row + .5 + jy - height * .5) * b; out.maxY = out.minY + height * b;
  out.gapCenter = lattice.gapCenter + (column + .5 + jx) * a + Math.PI;
  out.gapHalfAngle = Math.PI - width * a * .5;
  return true;
}
/** Writes an owned finite child patch; no child descriptor/plate is retained
 * by the immutable catalogue or allocated during a query. */
export function writeRingSurfaceChildLattice(lattice, column, row, plate, out) {
  const halfAngle = Math.PI - plate.gapHalfAngle;
  out.innerRadius = plate.outerRadius;
  out.outerRadius = plate.outerRadius + (lattice.outerRadius - lattice.innerRadius) * .2;
  out.minY = plate.minY; out.maxY = plate.maxY;
  out.gapCenter = plate.gapCenter - Math.PI - halfAngle;
  out.angleStep = halfAngle * 2 / 8;
  out.seed = ringSurfaceHash(lattice.seed, column, row, 5);
  return out;
}
function begin(w) { w.count = 0; w.childCells = 0; w.status = 'complete'; w.reason = undefined; }
function budget(w) {
  if (++w.count <= w.maxCells) return true;
  w.status = 'failed'; w.reason = 'ring-surface-cell-budget'; return false;
}
function evaluate(l, c, row, x, y, z, out, w, slabDistance) {
  if (!ringSurfacePlate(l, c, row, w.plate)) return true;
  if (!budget(w)) return false;
  slabDistance(w.plate, x, y, z, w.distance, w.scratch);
  if (w.distance.distance < out.distance) {
    out.distance = w.distance.distance; out.feature = w.distance.feature;
    out.normal[0] = w.distance.normal[0]; out.normal[1] = w.distance.normal[1]; out.normal[2] = w.distance.normal[2];
  }
  if (l.tiered) {
    const child = writeRingSurfaceChildLattice(l, c, row, w.plate, w.childLattice), envelope = w.envelope;
    envelope.innerRadius = child.innerRadius; envelope.outerRadius = child.outerRadius;
    envelope.minY = child.minY; envelope.maxY = child.maxY;
    envelope.gapCenter = w.plate.gapCenter; envelope.gapHalfAngle = w.plate.gapHalfAngle;
    slabDistance(envelope, x, y, z, w.distance, w.scratch);
    // This is the exact finite slab enclosing every child, including the
    // short angular footprint. Its signed distance is a true lower bound.
    if (w.distance.distance < out.distance) {
      if (!ringSurfaceDistance(child, x, y, z, out, w.child, slabDistance)) {
        w.status = 'failed'; w.reason = w.child.reason; return false;
      }
      w.childCells += w.child.count;
    }
  }
  return true;
}
/** Improves an existing nearest result, in local coordinates. An initial
 * distance supplied by the base solid makes remote queries cheap. Returns
 * false on explicit work exhaustion; a partial result is never a success.
 * Near the raised wall, the search visits a handful of cells. Global queries
 * without a base-solid bound can require O(columns*rows) and can fail budget.
 */
export function ringSurfaceDistance(l, x, y, z, out, w, slabDistance) {
  begin(w);
  if (l.firstColumn > l.lastColumn) return true;
  const r = Math.hypot(x, z), step = l.angleStep, rowStep = (l.maxY - l.minY) / l.rows;
  const radial = Math.max(l.innerRadius - r, 0, r - l.outerRadius), vertical = Math.max(l.minY - y, 0, y - l.maxY);
  if (out.distance >= 0 && Math.hypot(radial, vertical) > out.distance) return true;
  const angle = wrap(Math.atan2(z, x) - l.gapCenter);
  // Seed both admissible endpoints as well as the local cell: wrap can make
  // either endpoint nearest to a point in the excluded arc.
  const cc = clamp(Math.floor(angle / step), l.firstColumn, l.lastColumn), rr = clamp(Math.floor((y - l.minY) / rowStep), 0, l.rows - 1);
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    const c = ((cc + dc) % l.columns + l.columns) % l.columns;
    if (!evaluate(l, c, rr + dr, x, y, z, out, w, slabDistance)) return false;
  }
  for (let dr = -1; dr <= 1; dr++) {
    if (!evaluate(l, l.firstColumn, rr + dr, x, y, z, out, w, slabDistance) ||
      !evaluate(l, l.lastColumn, rr + dr, x, y, z, out, w, slabDistance)) return false;
  }
  // Disjoint cells have disjoint interiors. A negative result therefore
  // belongs to the only plate that can contain the point.
  if (out.distance < 0) return true;
  const best = out.distance;
  const xzBudget = Math.sqrt(Math.max(0, best * best - vertical * vertical));
  const rho = clamp(Math.sqrt(Math.max(0, r * r - xzBudget * xzBudget)), l.innerRadius, l.outerRadius);
  const reach = r === 0 ? Math.PI : Math.acos(clamp((r * r + rho * rho - xzBudget * xzBudget) / (2 * r * rho), -1, 1));
  const low = Math.max(0, Math.floor((y - best - l.minY) / rowStep)), high = Math.min(l.rows - 1, Math.floor((y + best - l.minY) / rowStep));
  // Shift the query by whole turns to intersect the one admitted column span.
  for (let turn = -1; turn <= 1; turn++) {
    const first = Math.max(l.firstColumn, Math.floor((angle - reach + turn * TAU) / step));
    const last = Math.min(l.lastColumn, Math.floor((angle + reach + turn * TAU) / step));
    for (let c = first; c <= last; c++) for (let row = low; row <= high; row++) {
      if (!evaluate(l, c, row, x, y, z, out, w, slabDistance)) return false;
    }
  }
  return true;
}
/** Exact conservative sweep culling only; actual roots remain the existing
 * slab solver. p+delta*t uses the caller's original t in [0,1]. At most two
 * intervals survive the radial shell. Visitor(w.plate,p,delta,radius,context)
 * must consume the reusable plate synchronously, and may return false to fail.
 */
export function visitRingSurfaceSweep(l, p, delta, radius, w, visitor, context) {
  begin(w); w.intervalCount = 0;
  let lo = 0, hi = 1;
  if (delta[1] === 0) { if (p[1] < l.minY - radius || p[1] > l.maxY + radius) return true; }
  else {
    const a = (l.minY - radius - p[1]) / delta[1], b = (l.maxY + radius - p[1]) / delta[1];
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
  }
  if (lo > hi || l.firstColumn > l.lastColumn) return true;
  const a = delta[0] ** 2 + delta[2] ** 2, along = p[0] * delta[0] + p[2] * delta[2];
  const cross = p[0] * delta[2] - p[2] * delta[0], outer = l.outerRadius + radius, inner = Math.max(0, l.innerRadius - radius);
  if (a === 0) {
    const r = Math.hypot(p[0], p[2]); if (r < inner || r > outer) return true;
  } else {
    const disc = a * outer * outer - cross * cross;
    if (disc < 0) return true;
    const root = Math.sqrt(disc);
    lo = Math.max(lo, (-along - root) / a); hi = Math.min(hi, (-along + root) / a);
    if (lo > hi) return true;
    const holeDisc = a * inner * inner - cross * cross;
    if (holeDisc > 0) {
      const holeRoot = Math.sqrt(holeDisc), enter = (-along - holeRoot) / a, leave = (-along + holeRoot) / a;
      if (enter > lo) { w.intervals[0] = lo; w.intervals[1] = Math.min(hi, enter); w.intervalCount = 1; }
      if (leave < hi) { const i = w.intervalCount++ * 2; w.intervals[i] = Math.max(lo, leave); w.intervals[i + 1] = hi; }
      // The entire clipped segment may be inside the open hole.
      if (enter <= lo && leave >= hi) return true;
    } else { w.intervals[0] = lo; w.intervals[1] = hi; w.intervalCount = 1; }
  }
  if (a === 0) { w.intervals[0] = lo; w.intervals[1] = hi; w.intervalCount = 1; }
  const step = l.angleStep, rowStep = (l.maxY - l.minY) / l.rows;
  const padding = inner > radius ? Math.asin(Math.min(1, radius / inner)) : Math.PI;
  for (let interval = 0; interval < w.intervalCount; interval++) {
    const t0 = w.intervals[interval * 2], t1 = w.intervals[interval * 2 + 1];
    const x0 = p[0] + delta[0] * t0, z0 = p[2] + delta[2] * t0, x1 = p[0] + delta[0] * t1, z1 = p[2] + delta[2] * t1;
    const angle = wrap(Math.atan2(z0, x0) - l.gapCenter);
    const change = Math.atan2(x0 * z1 - z0 * x1, x0 * x1 + z0 * z1);
    const angleLow = inner === 0 ? -Math.PI : Math.min(angle, angle + change) - padding;
    const angleHigh = inner === 0 ? TAU + Math.PI : Math.max(angle, angle + change) + padding;
    const y0 = p[1] + delta[1] * t0, y1 = p[1] + delta[1] * t1;
    const rowLow = Math.max(0, Math.floor((Math.min(y0, y1) - radius - l.minY) / rowStep));
    const rowHigh = Math.min(l.rows - 1, Math.floor((Math.max(y0, y1) + radius - l.minY) / rowStep));
    for (let turn = -1; turn <= 1; turn++) {
      const first = Math.max(l.firstColumn, Math.floor((angleLow + turn * TAU) / step));
      const last = Math.min(l.lastColumn, Math.floor((angleHigh + turn * TAU) / step));
      for (let c = first; c <= last; c++) for (let row = rowLow; row <= rowHigh; row++) {
        if (!ringSurfacePlate(l, c, row, w.plate)) continue;
        if (!budget(w)) return false;
        if (visitor(w.plate, p, delta, radius, context) === false) { w.status = 'failed'; w.reason = 'ring-surface-visitor-budget'; return false; }
        if (l.tiered) {
          writeRingSurfaceChildLattice(l, c, row, w.plate, w.childLattice);
          if (!visitRingSurfaceSweep(w.childLattice, p, delta, radius, w.child, visitor, context)) {
            w.status = 'failed'; w.reason = w.child.reason; return false;
          }
          w.childCells += w.child.count;
        }
      }
    }
  }
  return true;
}

/** Requires sectionCast/solidArc from the existing annular slab shader before
 * this source. Bounds are normalized (inner,outer,minY,maxY) of the RAISED
 * shell. gap is the parent gap; counts/seed/admittedColumns are the descriptor
 * integers. Column admission is decided once on CPU, never rounded from the
 * float shader gap: that could add an entire physically absent column.
 * maximum is the caller's known nearest hit; root and leaf traversal only
 * admit details strictly nearer than that distance, irrespective of normals.
 * The uint hash, 16-bit fractions and parameter expressions match the CPU.
 * Two shell intervals; angular/Y DDA visits only cells crossed by the ray.
 * Any unvisited remainder after 80 cells explicitly sets overflow=true.
 */
export const RING_SURFACE_LATTICE_GLSL = /* glsl */`
uint ringPlateHash(uint seed,int column,int row,uint salt){
  uint h=seed^(uint(column+1)*0x9e3779b9u)^(uint(row+1)*0x85ebca6bu)^salt;
  h=(h^(h>>16u))*0x7feb352du;h=(h^(h>>15u))*0x846ca68bu;
  return h^(h>>16u);
}
float ringPlateUnit(uint seed,int column,int row,uint salt){return float(ringPlateHash(seed,column,row,salt)&65535u)/65536.;}
// A cylindrical cell boundary is one radial HALF-plane. The infinite plane
// also intersects the opposite side of the ring, often behind this interval.
// That opposite root is not a DDA crossing. Rounding at the starting boundary
// may instead put the proper half-plane a little behind current: advance that
// already crossed boundary at current, without moving the ray backwards.
float ringLatticeAngularBoundary(float ox,float oz,float dx,float dz,float boundary,float current){
  float c=cos(boundary),s=sin(boundary);
  float denominator=-dx*s+dz*c;
  if(abs(denominator)<1.e-20)return 1.e25;
  float time=(ox*s-oz*c)/denominator;
  float radial=(ox+dx*time)*c+(oz+dz*time)*s;
  if(radial<=0.)return 1.e25;
  return max(current,time);
}
bool ringChildCell(uint seed,int column,int row){
  int mode=int(seed&3u);
  if(mode==1)return column>=2&&column<=5&&row>=1&&row<=6&&((column+row)&1)==0;
  if(mode==2)return column>=1&&column<=6&&(row==1||row==2||row==5||row==6);
  return row>=1&&row<=6&&(column==1||column==2||column==5||column==6);
}
bool ringPlateBounds(vec4 shell,vec2 parentGap,ivec2 counts,uint seed,ivec2 admittedColumns,bool tiered,bool masked,float step,int column,int row,out vec4 bounds,out vec2 gap){
  const float tau=6.283185307179586;
  float rowStep=(shell.w-shell.z)/float(counts.y);
  if(column<admittedColumns.x||column>admittedColumns.y||row<0||row>=counts.y)return false;
  if(masked&&!ringChildCell(seed,column,row))return false;
  float width=.2+.6*ringPlateUnit(seed,column,row,0u),height=.2+.6*ringPlateUnit(seed,column,row,1u);
  float jx=.2*ringPlateUnit(seed,column,row,2u)-.1,jy=.2*ringPlateUnit(seed,column,row,3u)-.1;
  float low=shell.z+(float(row)+.5+jy-height*.5)*rowStep;
  float relief=ringPlateUnit(seed,column,row,4u);
  bounds=vec4(shell.x,shell.x+(shell.y-shell.x)*(tiered?.8:1.)*(.15+.85*relief*relief),low,low+height*rowStep);
  gap=vec2(parentGap.x+(float(column)+.5+jx)*step+tau*.5,tau*.5-width*step*.5);
  return true;
}
bool ringLatticeIntervals(vec3 origin,vec3 ray,vec4 shell,vec2 clip,out vec4 intervals,out int intervalCount){
  float lo=clip.x,hi=clip.y;intervals=vec4(0.);intervalCount=0;
  if(abs(ray.y)<1.e-12){if(origin.y<shell.z||origin.y>shell.w)return false;}
  else{vec2 t=(shell.zw-origin.y)/ray.y;lo=max(lo,min(t.x,t.y));hi=min(hi,max(t.x,t.y));}
  float planar=dot(ray.xz,ray.xz),along=dot(origin.xz,ray.xz);
  float crossValue=origin.x*ray.z-origin.z*ray.x;
  if(planar<1.e-20){float r=length(origin.xz);if(r<shell.x||r>shell.y)return false;intervals.xy=vec2(lo,hi);intervalCount=1;}
  else{
    float disc=planar*shell.y*shell.y-crossValue*crossValue;if(disc<0.)return false;
    float root=sqrt(disc);lo=max(lo,(-along-root)/planar);hi=min(hi,(-along+root)/planar);
    if(lo>hi)return false;
    float holeDisc=planar*shell.x*shell.x-crossValue*crossValue;
    if(holeDisc>0.){
      float holeRoot=sqrt(holeDisc),enter=(-along-holeRoot)/planar,leave=(-along+holeRoot)/planar;
      if(enter>lo){intervals.xy=vec2(lo,min(hi,enter));intervalCount=1;}
      if(leave<hi){if(intervalCount==0)intervals.xy=vec2(max(lo,leave),hi);else intervals.zw=vec2(max(lo,leave),hi);intervalCount++;}
    }else{intervals.xy=vec2(lo,hi);intervalCount=1;}
  }
  return lo<=hi&&intervalCount>0;
}
// A leaf is a short convex angular patch, not a ring. Clip both radial
// half-planes before shell splitting, so the opposite side is never visited.
bool ringLeafCast(vec3 origin,vec3 ray,vec4 shell,vec2 rootGap,uint seed,bool shadowRay,float minimum,float maximum,
 out vec3 point,out vec3 normal,out float nearest,out bool overflow){
  const float pi=3.141592653589793;
  point=vec3(0.);normal=vec3(0.);nearest=1.e25;overflow=false;
  float halfAngle=pi-rootGap.y,angleStart=rootGap.x-pi-halfAngle;
  float step=halfAngle*2./8.,rowStep=(shell.w-shell.z)/8.;
  vec2 clip=vec2(max(0.,minimum),min(1.e24,maximum));
  for(int edge=0;edge<2;edge++){
    float a=angleStart+float(edge)*halfAngle*2.;
    vec2 inward=vec2(-sin(a),cos(a))*(edge==0?1.:-1.);
    float offset=dot(origin.xz,inward),rate=dot(ray.xz,inward);
    if(abs(rate)<1.e-20){if(offset<0.)return false;}
    else{float t=-offset/rate;if(rate>0.)clip.x=max(clip.x,t);else clip.y=min(clip.y,t);}
  }
  if(clip.x>clip.y)return false;
  vec4 intervals;int intervalCount;
  if(!ringLatticeIntervals(origin,ray,shell,clip,intervals,intervalCount))return false;
  float crossValue=origin.x*ray.z-origin.z*ray.x;
  int angularDirection=crossValue>=0.?1:-1,rowDirection=ray.y>=0.?1:-1,visited=0;
  for(int interval=0;interval<2;interval++){
    if(interval>=intervalCount)break;
    vec2 range=interval==0?intervals.xy:intervals.zw;
    if(range.x>range.y||range.x>nearest)continue;
    vec3 at=origin+ray*range.x;float raw=atan(at.z,at.x)-angleStart;
    float angle=atan(sin(raw),cos(raw));
    int column=int(floor(angle/step)),row=int(floor((at.y-shell.z)/rowStep));
    if(row==8&&rowDirection<0)row--;
    bool finished=false;float current=range.x;
    // Seven interior angular boundaries + seven Y boundaries, two interval
    // starts and initial boundary corrections fit twenty grid visits.
    for(int iteration=0;iteration<20;iteration++){
      if(visited>=20){overflow=true;return nearest<1.e24;}visited++;
      if((column<0&&angularDirection<0)||(column>=8&&angularDirection>0)||
         (row<0&&rowDirection<0)||(row>=8&&rowDirection>0)){finished=true;break;}
      vec4 bounds;vec2 gap;vec3 p,n;float t;
      if(ringPlateBounds(shell,vec2(angleStart,0.),ivec2(8),seed,ivec2(0,7),false,true,step,column,row,bounds,gap)&&
        sectionCast(origin,ray,bounds,gap,vec2(0.),false,shadowRay,minimum,p,n,t)&&t<min(nearest,maximum)){nearest=t;point=p;normal=n;}
      float nextAngle=1.e25,nextRow=1.e25;
      if(abs(crossValue)>1.e-20){
        float boundary=angleStart+float(column+(angularDirection>0?1:0))*step;
        nextAngle=ringLatticeAngularBoundary(origin.x,origin.z,ray.x,ray.z,boundary,current);
      }
      if(abs(ray.y)>1.e-12)nextRow=max(current,(shell.z+float(row+(rowDirection>0?1:0))*rowStep-origin.y)/ray.y);
      float next=min(nextAngle,nextRow);
      if(next>range.y||next>nearest){finished=true;break;}
      if(nextAngle<=nextRow)column+=angularDirection;
      if(nextRow<=nextAngle)row+=rowDirection;
      current=next;
    }
    if(!finished){overflow=true;return nearest<1.e24;}
  }
  return nearest<1.e24;
}
bool ringLatticeCast(vec3 origin,vec3 ray,vec4 shell,vec2 parentGap,ivec2 counts,uint seed,ivec2 admittedColumns,bool tiered,bool shadowRay,float minimum,float maximum,
 out vec3 point,out vec3 normal,out float nearest,out bool overflow){
  const float tau=6.283185307179586;
  point=vec3(0.);normal=vec3(0.);nearest=1.e25;overflow=false;
  vec4 intervals;int intervalCount;
  // The caller already owns a nearer solid hit. Only details strictly before
  // that hit can improve it; this also excludes hidden far-side shell work.
  if(!ringLatticeIntervals(origin,ray,shell,vec2(max(0.,minimum),min(1.e24,maximum)),intervals,intervalCount))return false;
  float crossValue=origin.x*ray.z-origin.z*ray.x;
  float step=tau/float(counts.x),rowStep=(shell.w-shell.z)/float(counts.y);
  int angularDirection=crossValue>=0.?1:-1,rowDirection=ray.y>=0.?1:-1,visited=0;
  for(int interval=0;interval<2;interval++){
    if(interval>=intervalCount)break;
    vec2 range=interval==0?intervals.xy:intervals.zw;
    if(range.x>range.y||range.x>nearest)continue;
    vec3 at=origin+ray*range.x;
    float angle=mod(atan(at.z,at.x)-parentGap.x+tau,tau);
    int column=int(floor(angle/step)),row=int(floor((at.y-shell.z)/rowStep));
    // At the upper cap a downward ray belongs to the final row. On all other
    // exact boundaries a zero-time DDA step visits both adjacent cells.
    if(row==counts.y&&rowDirection<0)row--;
    bool finished=false;float current=range.x;
    for(int iteration=0;iteration<80;iteration++){
      if(visited>=80){overflow=true;return nearest<1.e24;}visited++;
      int wrappedColumn=(column%counts.x+counts.x)%counts.x;
      vec4 bounds;vec2 gap;vec3 p,n;float t;
      if(ringPlateBounds(shell,parentGap,counts,seed,admittedColumns,tiered,false,step,wrappedColumn,row,bounds,gap)){
        if(sectionCast(origin,ray,bounds,gap,vec2(0.),false,shadowRay,minimum,p,n,t)&&t<min(nearest,maximum)){nearest=t;point=p;normal=n;}
        if(tiered){
          vec4 childShell=vec4(bounds.y,bounds.y+(shell.y-shell.x)*.2,bounds.zw);bool childOverflow;
          if(ringLeafCast(origin,ray,childShell,gap,ringPlateHash(seed,wrappedColumn,row,5u),shadowRay,minimum,min(nearest,maximum),p,n,t,childOverflow)&&t<nearest){nearest=t;point=p;normal=n;}
          if(childOverflow){overflow=true;return nearest<1.e24;}
        }
      }
      float nextAngle=1.e25,nextRow=1.e25;
      if(abs(crossValue)>1.e-20){
        float boundary=parentGap.x+float(column+(angularDirection>0?1:0))*step;
        nextAngle=ringLatticeAngularBoundary(origin.x,origin.z,ray.x,ray.z,boundary,current);
      }
      if(abs(ray.y)>1.e-12)nextRow=max(current,(shell.z+float(row+(rowDirection>0?1:0))*rowStep-origin.y)/ray.y);
      float next=min(nextAngle,nextRow);
      if(next>range.y||next>nearest){finished=true;break;}
      if(nextAngle<=nextRow)column+=angularDirection;
      if(nextRow<=nextAngle)row+=rowDirection;
      current=next;
    }
    if(!finished){overflow=true;return nearest<1.e24;}
  }
  return nearest<1.e24;
}
`;
