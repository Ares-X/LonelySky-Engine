/** Column-major world-to-local orthonormal frame for Euler XYZ angles. */
export function rotationFrame3([x,y,z]) {
  const a=Math.cos(x),b=Math.sin(x),c=Math.cos(y),d=Math.sin(y),e=Math.cos(z),f=Math.sin(z);
  const ae=a*e,af=a*f,be=b*e,bf=b*f;
  return [c*e,-c*f,d, af+be*d,ae-bf*d,-b*c, bf-ae*d,be+af*d,a*c];
}

/** Inverse of an orthonormal frame; no rendering dependency. */
export function frameToWorld3(f,[x,y,z]) {
  return [f[0]*x+f[1]*y+f[2]*z,f[3]*x+f[4]*y+f[5]*z,f[6]*x+f[7]*y+f[8]*z];
}

export function frameToLocal3(f,[x,y,z]) {
  return [f[0]*x+f[3]*y+f[6]*z,f[1]*x+f[4]*y+f[7]*z,f[2]*x+f[5]*y+f[8]*z];
}
