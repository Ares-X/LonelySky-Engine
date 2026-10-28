// SI constants: https://www.nist.gov/si-redefinition/meet-constants
const SECOND_RADIATION_CONSTANT_NM = 6.62607015e-34 * 299792458 / 1.380649e-23 * 1e9;
const RED_REFERENCE_NM = 680;

/** Relative received flux, using the astronomical logarithmic magnitude scale.
 * Floating-point underflow becomes zero; an unrepresentable bright flux throws.
 */
export function relativeStarFlux(magnitude, referenceMagnitude = 6) {
  if (!Number.isFinite(magnitude) || !Number.isFinite(referenceMagnitude)) {
    throw new RangeError('Star magnitudes must be finite numbers');
  }
  const flux = 10 ** (-.4 * (magnitude - referenceMagnitude));
  if (!Number.isFinite(flux)) throw new RangeError('Relative star flux exceeds the numeric range');
  return flux;
}

// Planck B_lambda relative to its value at 680 nm. Removing the common scale
// before exponentiation retains finite chromaticity even in the Wien limit.
// expm1 also retains the Rayleigh-Jeans limit at arbitrarily high finite T.
function relativeRadiance(wavelengthNm, temperature) {
  const referenceExponent = SECOND_RADIATION_CONSTANT_NM / RED_REFERENCE_NM / temperature;
  const exponent = SECOND_RADIATION_CONSTANT_NM / wavelengthNm / temperature;
  const exponentDifference = (SECOND_RADIATION_CONSTANT_NM / wavelengthNm
    - SECOND_RADIATION_CONSTANT_NM / RED_REFERENCE_NM) / temperature;
  return Math.exp(5 * Math.log(RED_REFERENCE_NM / wavelengthNm) - exponentDifference
    + Math.log(-Math.expm1(-referenceExponent)) - Math.log(-Math.expm1(-exponent)));
}

function response(temperature, a, b, c) {
  return (relativeRadiance(a, temperature) + relativeRadiance(b, temperature)
    + relativeRadiance(c, temperature)) / 3;
}

const WHITE_RED = response(6500, 620, 650, 680);
const WHITE_GREEN = response(6500, 500, 540, 580);
const WHITE_BLUE = response(6500, 420, 450, 480);

/** Continuous artist color from three equal-weight broad Planck response bands.
 * This is not a CIE color match or stellar-atmosphere model. Each band is white
 * balanced at 6500 K, then linear RGB luminance (.2126,.7152,.0722) is set to 1.
 * All positive finite kelvin values are accepted. Reuse output to avoid allocation.
 */
export function starLinearColor(temperature, output = [0, 0, 0]) {
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new RangeError('Star temperature must be a positive finite kelvin value');
  }
  const red = response(temperature, 620, 650, 680) / WHITE_RED;
  const green = response(temperature, 500, 540, 580) / WHITE_GREEN;
  const blue = response(temperature, 420, 450, 480) / WHITE_BLUE;
  const luminance = .2126 * red + .7152 * green + .0722 * blue;
  output[0] = red / luminance;
  output[1] = green / luminance;
  output[2] = blue / luminance;
  return output;
}
