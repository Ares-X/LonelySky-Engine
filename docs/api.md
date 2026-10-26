# Generation and rendering API

## Pure core

Import `src/index.js` in Node.js or a browser. It never imports Three.js or uses
the DOM. The original 0.1 coordinates, random, gravity and collision APIs remain
available; their contract is in [physics.md](physics.md).

```js
const universe = createUniverse({
  seed: 'first-light',
  density: 0.65,
  palette: { colorA: 0x607fa5, colorB: 0xd4b68e, starColor: 0xffe3bd },
});
```

`seed` is a string; `density` is a finite number from 0 through 1; palette colors
are integers from `0x000000` through `0xffffff`. Options are captured at creation.
The frozen universe exposes `seed`, `density`, `revision: 0`, and these functions:

| API | Result |
| --- | --- |
| `getSector(index)` | Independent JSON-serializable scene description |
| `sector(index)` | Independent neutral sphere array for gravity and collision |

The separate named export `sectorBodies(description)` projects a scene
description into the same sphere contract.

`GENERATOR_VERSION` identifies the generation rules. Record it with seed, density
and palette when persisting addresses; changing generation rules can change a
world. Addresses use the existing signed three-axis cell encoding.

A description contains `index`, `id`, `cell`, `composition`, `planets`, `stars`,
optional `blackHole`, `nebula`, and `region`. Bodies carry stable IDs, local
positions and radii. Planets also carry `kind`, colors, seed and ring parameters.
Names and identities belong to the application.

`density=0` produces empty local sectors, including the origin. With nonzero
density, the origin supplies a seed-dependent ringed planet and star for a visible
starting scene. Other sectors are sparse. Local bodies are bounded within cells
and keep an empty spawn region near the origin. Background stars and galaxies
are a separate rendering layer.

## Optional Three.js adapter

Import `src/three.js`. The consuming application provides **Three.js 0.186.1**
through its existing package setup or an import map. Use one Three.js version
for engine and application. The [minimal example](../examples/minimal.html)
uses a pinned CDN import map; hosts can serve those modules locally.
No textures, remote services or game files are required by the engine.

```js
const view = createUniverseView(container, {
  universe,
  quality: 'auto',
  onContextLost: event => { /* Optional application status. */ },
  onContextRestored: event => { /* Optional application status. */ },
});
```

The container controls CSS size. Creation builds the scene synchronously without
starting a loop. WebGL creation or invalid provider data can throw; applications
should surface startup errors to their users.

| API | Behavior |
| --- | --- |
| `start()` / `stop()` | Start or stop the owned loop; no automatic camera movement |
| `render(seconds = 0)` | Render from an application's own loop |
| `setView({sectorIndex, position, orientation, fov})` | Set cell origin and local pose; quaternion is `[x,y,z,w]` |
| `setQuality('low' \| 'auto' \| 'high')` | Adjust pixel ratio, volume steps and postprocessing |
| `resize()` | Update container dimensions; automatic resize observation is also provided |
| `diagnostics()` | Current cell, streaming and rendering counters |
| `dispose()` | Stop, remove listeners/canvas and release owned GPU resources; idempotent |

`view.scene`, `view.camera`, `view.renderer`, and `view.universe` are available.
The host owns camera movement and floating-origin rebasing: pass the new cell
address and translated local pose together. Time and pose values must be finite.
Call `stop()` before using your own loop.

The view loads a radius-two neighborhood (125 cells), reuses retained cells and
retires those outside the neighborhood. Local objects fade between 25,000 and
36,000 world units. A custom provider can supply `{seed, revision,
getSector(index)}`; change `revision` after a content change. The next render
rebuilds streamed content. Providers own descriptor correctness.

Context loss pauses the owned loop; restoration resumes it if previously running.
`dispose()` releases engine-owned resources. Host-added objects remain the host's
responsibility.

## Individual visual primitives

- `planetMaterial`, `atmosphereMaterial`, `ringMaterial`, `starMaterial` return
  Three.js materials. Dispose them after use. Texture arguments are borrowed.
- `createNebula(options)` and `createBlackHole(options)` return groups exposing
  `userData.update(camera, seconds, {quality})` and `userData.dispose()`.
  Nebula update also accepts visibility; black holes expose `setVisibility`
  and `setSkyTransform`. Shared noise survives until its final user releases it.
  Injected sky textures remain caller-owned.
- `createDeepSky()` creates the directional background also sampled by the
  default black-hole lens. Pass the same trusted environment to
  `sky.userData.update(environment, quiet)` and
  `hole.userData.setEnvironment(environment, quiet)` to customize both. The
  environment contains finite `ambientTint` RGB and unit `bandNormal` arrays,
  plus finite `skyBrightness`, `bandStrength`, and `starDensity` values. An
  explicit environment supersedes the legacy photographic sky texture path.
  Both groups expose idempotent `userData.dispose()`.
- `createCosmos({seed})` creates sparse spiral, elliptical and irregular galaxies.
  Its update takes `{sectorIndex, cameraPosition, viewportHeight, pixelRatio,
  quality}`. `describeMacro`, `sampleGalaxy` and `loadedMacros` expose descriptions
  and particle samples.

Galaxy emission uses 16/32/48 bounded disk samples for low/auto/high quality.
The smooth core is integrated separately with samples concentrated around the
closest point of the ray. Dust uses mip filtering; analytic spiral arms are
filtered over the ray/pixel footprint while preserving their periodic mean
brightness. These rendering changes do not reseed descriptors or star positions.
Subpixel detail may differ by quality; the spatial layout remains the same.

Generation uses artistic placement. Volume and black-hole rendering uses optical
approximations. Camera depth compression and local gravity do not form a
physically consistent galaxy-to-planet simulation.

## Elliptic orbital mechanics (0.3)

`orbitalPeriod({semiMajorAxis, mu})` and `evaluateOrbit(elements, timeSeconds)`
are stateless two-body calculations. Use one consistent length unit, seconds,
and `mu = G(M + m)` in length³/second². Required elements are positive
`semiMajorAxis` and `mu`, and `eccentricity` in `[0,1)`. Optional angles
`inclination`, `ascendingNode`, `argumentOfPeriapsis`, and
`meanAnomalyAtEpoch` are radians; they and `epochSeconds` default to zero.
The reference plane is right-handed XY with +Z normal.

The result contains focus-relative position, velocity, acceleration, radius,
mean/eccentric/true anomaly, mean motion, period and `accelerationBound` (the
periapsis maximum with outward numerical slack). Invalid/nonrepresentable input
throws; there is no silently clamped orbit. Very large input times still have
IEEE-754 precision limits; choose an epoch near the simulation time.

`evaluateBodyState(body, timeSeconds)` adds the fixed `body.position` focus to
an optional `body.orbit`. Static descriptors return detached positions and zero
velocity/acceleration/bound. Orbital descriptors preserve the relative orbital
fields. Applications must use this same sampled state for their moving visuals;
the stock `createUniverseView` does not animate custom orbital providers.

Gravity `sample(index, position, timeSeconds = 0)` samples current orbital poses.
Since 0.3.1, a non-null `source` includes detached `position` and `velocity`
vectors evaluated at the requested time. Both use the sampled sector's local
frame, including across wrapped cell boundaries; static sources have zero
velocity. These describe the strongest contributor, not a bound-orbit verdict.

Positive finite `body.mu` selects inverse-square attraction outside the surface,
bounded at the radius, with the existing finite-range taper and total cap. Bodies
without `mu` retain legacy softening. This is a gameplay field; it does not
integrate mutual perturbations between bodies.

Collision APIs accept the same clock: `ensureSafe(index, position, velocity,
timeSeconds = 0)`, `bodies(index, timeSeconds = 0)`, and
`move(index, start, end, velocity, {timeSeconds = 0, deltaTime = 0})`.
Here time is the start of the interval. Positive duration uses relative moving
sphere sweeps, surface-relative response and simultaneous contact constraints.
Orbit chords are no longer than 1/120 second and are conservatively inflated by
`accelerationBound * dt² / 8`; extreme curvature can produce early contact.
Durations over 64/120 second and exhausted contact/recovery bounds throw.
Zero duration retains the static sweep behavior at the requested phase.

Providers own spatial bounds: the existing 27 anchor-cell physics neighborhood
is unchanged. Large orbits reaching from more distant owner cells require a
different spatial provider. This module does not implement N-body interactions,
parabolic/hyperbolic trajectories, relativistic or surface-terrain physics.
Basis: [NASA Kepler's laws](https://science.nasa.gov/solar-system/orbits-and-keplers-laws/)
and [NASA orbital mechanics](https://science.nasa.gov/learn/basics-of-space-flight/chapter3-3/).
