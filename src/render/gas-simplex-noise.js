// Signed simplex: Ian McEwan / Ashima Arts, MIT (../../licenses/webgl-noise.MIT.txt).
import {SN_CONTINUOUS_SIMPLEX_GLSL} from './continuous-noise.js';
export const GAS_SIGNED_SIMPLEX_GLSL=SN_CONTINUOUS_SIMPLEX_GLSL+/* glsl */`
float gmSimplex(vec3 p){return snNoise(p);}
`;
