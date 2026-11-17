import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionWorld } from '../src/collision.js';
import {solidDistance} from '../src/solid-geometry.js';
import { encodeCell } from '../src/coordinates.js';

const h = 1 / 120;
const orbiting = (extra = {}) => ({ id: 'moon', type: 'planet', radius: 10, position: [0, 0, 0],
  orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e13 }, ...extra });
const provider = bodies => index => index === 0 ? bodies : [];

// Public snapshots and separate caller outputs may remain live while this
// instance services other moves and body queries.
test('reusable sweeps preserve prior snapshots and independent caller outputs', () => {
  const collision = createCollisionWorld({ sector: provider([orbiting()]) });
  const a = collision.createMoveResult(), b = collision.createMoveResult();
  const position = a.position, velocity = a.velocity;
  const start = Object.freeze([1000, 100, 0]), zero = Object.freeze([0, 0, 0]);
  const options = { deltaTime: h };
  const published = collision.move(0, start, start, zero, options);
  const safe = collision.ensureSafe(0, [1000, 0, 0], zero);
  const bodies = collision.bodies(0);
  const retained = structuredClone({ published, safe, bodies });
  assert.equal(collision.moveInto(0, start, start, zero, options, a), a);
  assert.deepEqual(a, published);
  const contact = a.contact, retainedContact = structuredClone(contact);
  const first = structuredClone(a);
  collision.moveInto(0, [-5000, 4000, 0], [-4999, 4000, 0], zero, { deltaTime: h, timeSeconds: .2 }, b);
  assert.deepEqual(a, first);
  for (const timeScale of [0, .4, 1]) {
    collision.bodies(0, .3, timeScale);
    collision.moveInto(0, [-5000, 4000, 0], [-4999, 4000, 0], zero, { deltaTime: h, timeScale }, a);
    assert.equal(a.position, position); assert.equal(a.velocity, velocity);
    assert.equal(a.contact, null); assert.equal(a.failure, undefined);
    assert.deepEqual(contact, retainedContact);
    assert.deepEqual({ published, safe, bodies }, retained);
  }
});

test('a reused output accepts its previous vectors as the next move inputs', () => {
  for (const moving of [false, true]) {
    const collision = createCollisionWorld({ sector: provider(moving ? [orbiting()] : []) });
    const out = collision.createMoveResult(), options = { deltaTime: h };
    out.position.splice(0, 3, -5000, 4000, 0); out.velocity.splice(0, 3, 120, 0, 0);
    const velocity = out.velocity;
    for (let i = 0; i < 20; i++) {
      const end = Object.freeze([out.position[0] + 1, 4000, 0]);
      collision.moveInto(0, out.position, end, out.velocity, options, out);
      assert.deepEqual(out.position, [-4999 + i, 4000, 0]);
      assert.equal(out.velocity, velocity); assert.deepEqual(out.velocity, [120, 0, 0]);
    }
  }
});

test('clock changes, recovery and crossed cells preserve reusable result behavior', () => {
  const target = encodeCell({ x: 3, y: 0, z: 0 });
  const scenarios = [
    { sector: provider([orbiting()]), start: [1000, 100, 0], end: [1000, 100, 0] },
    { sector: provider([orbiting()]), start: [1000, 0, 0], end: [1010, 10, 0] },
    { sector: provider([orbiting({ orbit: undefined })]), start: [-200, 0, 0], end: [200, 0, 0] },
    { sector: index => index === target ? [orbiting({ position: [-1000, 0, 0] })] : [], start: [0, 0, 0], end: [80000, 0, 0] },
  ];
  for (const { sector, start, end } of scenarios) {
    const collision = createCollisionWorld({ sector }), out = collision.createMoveResult();
    Object.freeze(start); Object.freeze(end);
    const velocity = Object.freeze([12, 0, 0]);
    for (const timeScale of [1, 0, .4, 1]) for (const timeSeconds of [0, .017, -.04]) {
      const options = { deltaTime: h, timeScale, timeSeconds };
      assert.deepEqual(collision.moveInto(0, start, end, velocity, options, out),
        createCollisionWorld({ sector }).move(0, start, end, velocity, options));
    }
  }
});

test('independent collision instances retain their own active sweep state', () => {
  const a = createCollisionWorld({ sector: provider([orbiting()]) });
  const b = createCollisionWorld({ sector: provider([orbiting({ position: [0, -5000, 0] })]) });
  const outA = a.createMoveResult(), outB = b.createMoveResult();
  const start = [1000, 100, 0], zero = [0, 0, 0], options = { deltaTime: h };
  for (let i = 0; i < 10; i++) {
    a.moveInto(0, start, start, zero, options, outA);
    const snapshot = structuredClone(outA);
    b.moveInto(0, start, start, zero, options, outB);
    assert.deepEqual(outA, snapshot);
    assert.ok(outA.contact); assert.equal(outB.contact, null);
  }
});

test('a bounded moving-contact failure returns the safe start and does not leak to the next move', () => {
  const bodies = [-1, 1].map(sign => orbiting({ id: `closing-${sign}`, position: [sign * 60, -sign * 1000, 0],
    orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 4e9, meanAnomalyAtEpoch: sign * Math.PI / 2 } }));
  const collision = createCollisionWorld({ sector: provider(bodies) }), out = collision.createMoveResult();
  const options = { deltaTime: h }, zero = Object.freeze([0, 0, 0]);
  const published = collision.move(0, zero, [0, 0, .1], [0, 0, 12], options);
  const publishedPosition = [...published.position], publishedVelocity = [...published.velocity];
  const aliased = collision.createMoveResult(); aliased.velocity[2] = 12;
  collision.moveInto(0, aliased.position, [0, 0, .1], aliased.velocity, options, aliased);
  assert.deepEqual(aliased, published);
  collision.moveInto(0, zero, [0, 0, .1], [0, 0, 12], options, out);
  assert.equal(out.failure.code, 'infeasible-moving-contact');
  assert.deepEqual(out.position, zero); assert.deepEqual(out.velocity, [0, 0, 12]);
  assert.equal(out.failure.safeAtStart, true); assert.equal(out.distance, 0);
  const failure = out.failure, retained = structuredClone(failure.contacts);
  collision.moveInto(0, [-5000, 4000, 0], [-4999, 4000, 0], zero, options, out);
  assert.equal(out.failure, undefined); assert.equal(out.corrected, false); assert.equal(out.contact, null);
  assert.deepEqual(failure.contacts, retained);
  assert.deepEqual(published.position, publishedPosition); assert.deepEqual(published.velocity, publishedVelocity);
});

test('reusable output retains real ring holes, solid contacts and root-budget failure endpoints', () => {
  const solid = { id: 'ring', position: [0, 0, 0], boundsRadius: 203,
    shape: { type: 'compound', parts: [{ type: 'annular-sector-slab', innerRadius: 100, outerRadius: 200,
      minY: -10, maxY: 10, gapCenter: 0, gapHalfAngle: 0 }] } };
  const sector = provider([orbiting({ position: [0, 5000, 0] })]);
  for (const solidSweepBudget of [1, 32768]) {
    const config = { sector, solidProvider: () => [solid], solidSweepBudget };
    const collision = createCollisionWorld(config), out = collision.createMoveResult();
    for (const [start, end] of [[[0, -4000, 0], [0, 4000, 0]], [[-1000, 15, 0], [1000, 15, 0]], [[150, 0, 0], [150, 0, 20]]]) {
      const options = { deltaTime: h }, velocity = [240000, 0, 0];
      assert.deepEqual(collision.moveInto(0, start, end, velocity, options, out),
        createCollisionWorld(config).move(0, start, end, velocity, options));
    }
  }
});


test('unrecoverable initial overlap preserves inputs and marks the endpoint unsafe', () => {
  const giant = orbiting({ orbit: undefined, radius: 1e8 });
  const collision = createCollisionWorld({ sector: provider([giant]) }), out = collision.createMoveResult();
  const start = Object.freeze([0, 0, 0]), velocity = Object.freeze([12, 0, 0]);
  collision.moveInto(0, start, [1, 0, 0], velocity, { deltaTime: h }, out);
  assert.equal(out.failure.code, 'recovery-scan-limit'); assert.equal(out.failure.safeAtStart, false);
  assert.deepEqual(out.position, start); assert.deepEqual(out.velocity, velocity);
  assert.equal(out.corrected, false); assert.equal(out.distance, 0);
  const expectedPosition = [...out.position], expectedVelocity = [...out.velocity];
  collision.moveInto(0, out.position, [1, 0, 0], out.velocity, { deltaTime: h }, out);
  assert.equal(out.failure.safeAtStart, false);
  assert.deepEqual(out.position, expectedPosition); assert.deepEqual(out.velocity, expectedVelocity);
});

test('collision construction validates before acquiring external query owners and legacy disposal remains supported',()=>{
  let created=0;const world={sector:()=>[],createSolidQueryWorkspace(){created++;return {};}};
  for(const options of [{shipRadius:NaN},{shipRadius:-1},{solidSweepBudget:0}])assert.throws(()=>createCollisionWorld({world,...options}),RangeError);
  assert.equal(created,0);
  const legacy=createCollisionWorld({world});assert.deepEqual(legacy.ensureSafe(0,[0,0,0],[0,0,0]).position,[0,0,0]);legacy.dispose();legacy.dispose();assert.equal(created,1);
});

test('a failed release is explicit, clears CPU ownership and is not replayed',()=>{
  const failure=new Error('release failed'),workspace={};let releases=0;
  const collision=createCollisionWorld({world:{sector:()=>[],createSolidQueryWorkspace:()=>workspace,releaseSolidQueryWorkspace(w){assert.equal(w,workspace);releases++;throw failure;}}});
  collision.bodies(0);assert.ok(collision.cacheSize>0);
  assert.throws(()=>collision.dispose(),e=>e===failure);assert.equal(collision.cacheSize,0);collision.dispose();assert.equal(releases,1);
  assert.throws(()=>collision.bodies(0),/Collision world disposed/);
});


const part={type:'annular-sector-slab',innerRadius:100,outerRadius:200,minY:-10,maxY:10,gapCenter:0,gapHalfAngle:0};
const ring={id:'ring',position:[0,0,0],boundsRadius:210,shape:{type:'compound',parts:[part]}};
const cases=[{name:'oblique wall',start:[150,30,-20],end:[150,0,20],hit:true},{name:'finite corner',start:[85,30,0],end:[145,0,0],hit:true},{name:'concave inner wall',start:[90,0,-10],end:[115,0,25],hit:true},{name:'clear middle hole',start:[0,0,0],end:[50,0,30],hit:false},{name:'initially clear stationary',start:[70,0,0],end:[70,0,0],hit:false}];
for(const c of cases)test(`camera first-contact CCD stays on the prepared boom for ${c.name}; default ship behavior is unchanged`,()=>{
 const queries=[],options={sector:()=>[],shipRadius:2,solidProvider(_index,bounds){queries.push({min:bounds.min.slice(),max:bounds.max.slice()});return [ring];}},camera=createCollisionWorld(options),ship=createCollisionWorld({...options,solidProvider:()=>[ring]}),defaultShip=createCollisionWorld({...options,solidProvider:()=>[ring]});
 try{const velocity=c.end.map((v,i)=>v-c.start[i]),normal=defaultShip.move(0,c.start,c.end,velocity),unchanged=ship.move(0,c.start,c.end,velocity,{stopAtContact:false});assert.deepEqual(unchanged,normal);const hit=camera.move(0,c.start,c.end,velocity,{stopAtContact:true});assert.equal(hit.failure,undefined);assert.equal(!!hit.contact,c.hit);assert.ok(solidDistance(ring,hit.position).distance>=2-1e-5);for(const q of queries)for(let axis=0;axis<3;axis++){assert.ok(q.min[axis]>=Math.min(c.start[axis],c.end[axis])-2-1e-8);assert.ok(q.max[axis]<=Math.max(c.start[axis],c.end[axis])+2+1e-8);}if(c.hit){const delta=c.end.map((v,i)=>v-c.start[i]),fraction=(hit.position[0]-c.start[0])/(delta[0]||1);if(delta[0])for(let a=0;a<3;a++)assert.ok(Math.abs(hit.position[a]-c.start[a]-delta[a]*fraction)<1e-5);assert.ok(hit.distance<=normal.distance+1e-7);}else assert.deepEqual(hit.position,c.end);
 }finally{camera.dispose();ship.dispose();defaultShip.dispose();}
});
test('camera first-contact option preserves explicit initial safe recovery rather than bypassing contact',()=>{const collision=createCollisionWorld({sector:()=>[],solidProvider:()=>[ring],shipRadius:2});try{const r=collision.move(0,[150,0,0],[150,30,0],[0,0,0],{stopAtContact:true});assert.equal(r.failure,undefined);assert.ok(r.corrected);assert.ok(solidDistance(ring,r.position).distance>=2-1e-5);}finally{collision.dispose();}});
test('releaseQueryResources ends the old workspace and acquires a new owner only on the next real query',()=>{let next=0,released=0;const active=new Set(),seen=[];const world={sector:()=>[],createSolidQueryWorkspace(){const w={id:++next};active.add(w);return w;},releaseSolidQueryWorkspace(w){assert.ok(active.delete(w));released++;},collisionSolidsInBounds(_index,_bounds,w){assert.ok(active.has(w));seen.push(w);return [];}};const collision=createCollisionWorld({world,shipRadius:2});try{collision.move(0,[0,0,0],[5,0,0],[0,0,0]);const first=seen.at(-1);collision.releaseQueryResources();assert.equal(active.size,0);assert.equal(next,1);collision.move(0,[5,0,0],[8,0,0],[0,0,0]);assert.notEqual(seen.at(-1),first);assert.equal(next,2);assert.equal(released,1);}finally{collision.dispose();assert.equal(active.size,0);assert.equal(released,2);}});
