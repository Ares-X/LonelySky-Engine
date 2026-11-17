import {randomFromSeed} from '../random.js';

// A finite stellar association in the parent's local frame. Each tapered stroke is
// made of overlapping, unequal ellipsoids; the points and unresolved light share
// their centers, tangent and widths. All dimensions are fractions of parent radius.
const TAU = 2 * Math.PI;
const styles = {
  // motif, resolved fraction, width, star tint, star gain, continuum, cloud amplitude, cloud color.
  'grand-spiral': ['feathered-arm',.36,.031,[.67,.84,1.13],1.95,.055,0,[.64,.79,1.03]],
  'barred-spiral': ['bar-ansae',.43,.040,[1.16,.95,.69],1.85,.035,0,[1.05,.90,.69]],
  'dust-disk': ['split-ridge',.47,.032,[.98,.89,.73],1.50,.009,.39,[.87,.75,.58]],
  'ancient-halo': ['shell-fan',.49,.020,[1.09,.96,.81],2.45,.012,0,[1.03,.94,.82]],
  'tidal-islands': ['tidal-hook',.48,.022,[.62,.84,1.22],2.12,.020,0,[.65,.85,1.1]],
  'stellar-nursery': ['blister-rim',.46,.045,[.71,.85,1.16],1.9,.012,.77,[1.05,.63,.52]],
};

export function createGalaxyPortrait(descriptor, family, random) {
  const [motif, fraction, width, tint, starGain, continuum, clouds, diffuseTint] = styles[family];
  const angle = random()*TAU, sweep=.8+random()*.44, scale=.88+random()*.22;
  // Two families inherit axes that already own stars: the disk's actual arm
  // phase / local X bar and the irregular galaxy's outer two islands.
  const arm = Math.floor(random()*descriptor.arms)*TAU/descriptor.arms;
  const sign = random()<.5?-1:1, c=Math.cos(angle), s=Math.sin(angle);
  // Draw these after the primary anchors and camera frame parameters. Satellite arms/shells range from a scar to an almost equal partner;
  // clumping and length asymmetry change on both strokes in each host.
  const partner=.10+.95*random()**1.4, opening=.45+1.09*random(), split=.22+.48*random();
  const lopsided=(random()-.5)*1.7, knotLocation=.15+.68*random();
  const knots=randomFromSeed(descriptor.seed+':portrait-associations-v1');
  const traces = 2, nodes = [], weights = [];
  function path(stroke,t) {
    let x,y,z,a,r;
    switch(motif){
      case 'feathered-arm':
        r=(.19+.56*t)*scale;
        a=arm+Math.log(r+.06)/descriptor.pitch+stroke*(.03+opening*Math.max(0,t-split)**1.35)*sign;
        return [Math.cos(a)*r,.017*Math.sin(4*t+angle),Math.sin(a)*r];
      case 'bar-ansae':
        a=(t-.5)*2.65*sweep*(stroke?opening:1);
        return [(stroke?-1:1)*((stroke?.31+.11*opening:.385)+.105*Math.cos(a))*scale,.018*Math.sin(3*a+angle),(.19*Math.sin(a)+.05*t)*sign];
      case 'split-ridge':
        x=(t-.5)*1.45*scale*(stroke?.4+.58*opening:1); y=(stroke?-.041*opening:.026)+.04*x*x*sign;
        z=(stroke?.10*opening:-.032)+.27*x*x*sign+.038*Math.sin(4*t+angle);
        break;
      case 'shell-fan':
        a=(t-.5)*(stroke?1.95*opening:2.75)*sweep+stroke*(split-.2);
        r=(stroke?.32+.20*opening:.70)*scale;
        x=r*Math.cos(a); y=r*Math.sin(a)*.40*sign; z=r*Math.sin(a)*.71;
        break;
      case 'tidal-hook': {
        // Stream escapes on the outside of the eldest island rather than
        // drawing another straight bridge through the core.
        a=descriptor.asymmetry+4.2+(1.55*t*(stroke?.55+.4*opening:1)-.19)*sweep;
        r=(.55+.29*t-.15*t*t)*scale;
        return [Math.cos(a)*r, .12-.23*t+stroke*.035*t+r*.09*Math.sin(5*t), Math.sin(a)*r+stroke*(.024+.20*opening)*t*t];
      }
      case 'blister-rim':
        a=(t-.5)*(stroke?2.15*opening:3.8)*sweep+stroke*(1.8+1.8*split);
        r=(stroke?.072+.091*opening:.235)*scale;
        x=.40+r*Math.cos(a); y=.07+r*Math.sin(a)*.66; z=r*Math.sin(a)*.88-.1*t;
        break;
    }
    return [x*c-z*s,y,x*s+z*c];
  }
  for(let j=0;j<traces;j++) for(let i=0;i<5;i++){
    const t=(i+.5)/5, p=path(j,t), lo=path(j,t-.09), hi=path(j,t+.09);
    const dx=hi[0]-lo[0],dy=hi[1]-lo[1],dz=hi[2]-lo[2],length=Math.hypot(dx,dy,dz);
    const taper=.63+.37*Math.sin(t*Math.PI),minor=width*taper*(.82+.37*random());
    let weight=(j===0?1:partner)*(.62+.7*random())*taper*(1+lopsided*(t-.5));
    if(motif==='tidal-hook') weight*=.13+.87*(1-Math.exp(-((t-knotLocation)**2)/.028));
    if(motif==='stellar-nursery') weight*=.45+1.45*Math.exp(-((t-knotLocation)**2)/.025);
    const long=Math.max(minor*1.65,length*.79);
    const axis=Object.freeze([dx/length,dy/length,dz/length]);
    // A small, coherent cluster sits off the stroke's spine; its stars share
    // age/tint and its own centroid. The surrounding population remains open.
    const along=(knots()-.5)*1.35*long;
    const knotCenter=Object.freeze(p.map((v,k)=>v+axis[k]*along+(knots()-.5)*minor*.85));
    nodes.push(Object.freeze({center:Object.freeze(p),axis,long,width:minor,weight,
      knotCenter,knotWidth:minor*(.24+.32*knots()),knotChance:.12+.27*knots(),
      warmth:(knots()-.5)*.54}));
    // Sample integrated light, not peak intensity: puff volume is proportional
    // to long*width². The common Gaussian normalisation cancels in the CDF.
    weights.push(weight*long*minor*minor+(weights[weights.length-1]??0));
  }
  const total=weights[weights.length-1];
  return Object.freeze({motif, fraction, starGain, continuum, clouds, diffuseTint:Object.freeze(diffuseTint), tint:Object.freeze(tint), nodes:Object.freeze(nodes),
    cdf:Object.freeze(weights.map(x=>x/total)), anchor:nodes[2].center});
}

// Draw from the same ellipsoid as the ray integral; no geometry buffers or
// per-star records besides the owning sampler's existing output.
export function samplePortraitNode(portrait, random, gaussian, point) {
  const roll=random(); let i=0;
  while(roll>portrait.cdf[i]) i++;
  const node=portrait.nodes[i], a=node.axis, center=node.center;
  if(random()<node.knotChance){
    const k=node.knotCenter,w=node.knotWidth;
    point.set(k[0]+w*gaussian(),k[1]+w*gaussian(),k[2]+w*gaussian());
    return node;
  }
  const x=gaussian(),y=gaussian(),z=gaussian(),stretch=(x*a[0]+y*a[1]+z*a[2])*(node.long-node.width);
  point.set(center[0]+x*node.width+stretch*a[0],center[1]+y*node.width+stretch*a[1],center[2]+z*node.width+stretch*a[2]);
  return null;
}
