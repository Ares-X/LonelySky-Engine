/** An artistic, unit-integral Gaussian mixture, specified in CSS pixels. */
export const STELLAR_PSF_CORE_SIGMA_CSS = .65;
export const STELLAR_PSF_HALO_SIGMA_CSS = 2.2;
export const STELLAR_PSF_HALO_ENERGY = .03;

/** Full quad side in physical pixels; at least four halo sigmas on each side. */
export function stellarPsfSupportPixels(pixelRatio = 1) {
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new RangeError('Pixel ratio must be positive and finite');
  return Math.ceil(8 * STELLAR_PSF_HALO_SIGMA_CSS * pixelRatio);
}

// Abramowitz & Stegun, Handbook of Mathematical Functions, 7.1.26 (p.299).
// https://personal.math.ubc.ca/~cbm/aands/page_299.htm
// Its erfc form keeps positive tails instead of subtracting erf from one.
function erfcPositive(x) {
  const t = 1 / (1 + .3275911 * x);
  return t * (.254829592 + t * (-.284496736 + t * (1.421413741
    + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
}

// Q(z) = erfc(z/sqrt(2))/2; https://dlmf.nist.gov/7.1
export function gaussianPixelAxis(center, sigma) {
  const near = (Math.abs(center) - .5) / (Math.SQRT2 * sigma);
  const far = (Math.abs(center) + .5) / (Math.SQRT2 * sigma);
  if (near >= 0) return .5 * (erfcPositive(near) - erfcPositive(far));
  return 1 - .5 * (erfcPositive(-near) + erfcPositive(far));
}

/** Fraction of unit stellar flux in one physical pixel. x/y are that pixel's
 * center offsets from the star in physical pixels. CPU reference, no allocation.
 * The render caller supplies finite offsets and a positive finite pixel ratio.
 */
export function stellarPixelEnergy(x, y, pixelRatio = 1) {
  const coreSigma = STELLAR_PSF_CORE_SIGMA_CSS * pixelRatio;
  const haloSigma = STELLAR_PSF_HALO_SIGMA_CSS * pixelRatio;
  return (1 - STELLAR_PSF_HALO_ENERGY) * gaussianPixelAxis(x, coreSigma) * gaussianPixelAxis(y, coreSigma)
    + STELLAR_PSF_HALO_ENERGY * gaussianPixelAxis(x, haloSigma) * gaussianPixelAxis(y, haloSigma);
}
