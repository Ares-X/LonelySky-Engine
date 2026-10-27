# Generation and rendering API

## Filtered scenery appearance (0.7.1)

Nebula appearance descriptors may supply `rimColor` independently of `colorA`
and `colorB`. Invalid colors fall back to their profile; a dark-cloud profile
still cannot gain emission. The shared noise tile is 64 cubed with mipmaps,
and paired quadrature keeps the existing 16/32/48 view-sample budgets. Density
and lighting are an appearance revision, while generated body addresses,
volume bounds and per-seed offsets stay unchanged. The depth-composition API
below remains supported. More detail does add GPU work; the sample budget is
not a promise of unchanged render time.

## Nebula depth composition (0.7)

`NebulaRenderPass(scene, camera)` from the optional `three` entry point replaces a
Three.js `RenderPass` before bloom/output in an `EffectComposer`. It renders
depth-writing surfaces once, snapshots their resolved depth, and draws the
remaining translucent materials in Three's usual order. Nebula ray integration
stops at the sampled surface instead of blending dust behind a solid over it.
The depth snapshot is separate from the active render target. With no visible
in-view nebula the pass follows the ordinary single-render path. Dispose the
pass before its composer; it owns only depth textures it attached itself.

`new NebulaRenderPass(scene, camera, { reuseWorldMatrices: true })` can reuse the
first draw's world matrices for the second draw. This defaults to `false` so
render hooks can keep changing transforms between draws. Enable it only when
scene, object, material and depth-binding hooks leave transforms and the scene
hierarchy, including automatic matrix-update settings, unchanged throughout
both draws. The pass restores the scene's
`matrixWorldAutoUpdate` setting after the second draw, including on failure;
the next frame's first draw still applies ordinary automatic matrix updates.
The option does not change the single-render path without a visible nebula.

`createUniverseView` uses this pass. Standalone `createNebula` remains compatible
with ordinary rendering, which retains its first-cloud depth approximation.
This correction does not implement order-independent transparency: overlapping
volumes, rings and glows still use object sorting. Rendering into a screen
framebuffer without a composer target also retains the ordinary path.

The pure entry point exports `NEBULA_VOLUME`, `describeNebulaVolume({tilt})` and
`nebulaVisibility(surfaceDistance)`. The descriptor returns the existing rotated
centre, half extents, bounding radius and scenic focus radius; it changes no
world-generation seed or address. Visibility stays full through 9,000 units from
the actual box surface and fades smoothly to zero at 16,000. This preserves the
authored entrance, 8,700 units from the front surface. The rendered group's
`userData.isInView(camera)` provides conservative transformed-box/frustum overlap
for consumers deciding whether the camera is looking into an empty view.

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

`describeGalaxyAppearance(descriptor)` is exported from `src/three.js`. Pass a
descriptor from `describeMacro`; the frozen result contains `revision: 1`, a
`family`, emission/dust/core/arm controls, and `viewing: {offset, fov}`. The offset
is in galaxy-local radius units; rotate by the descriptor orientation before
converting to a world position. The function uses a separate seeded stream and
never changes the descriptor, galaxy address or particle sample sequence. It
does not select a safe arrival point or manage gameplay navigation.

The six families refine the existing three macro morphologies. Volumes remain
within the existing galaxy support radius and reuse the same geometry, noise
texture and program. Quality levels retain 16/32/48 density integration samples.

- `planetMaterial`, `atmosphereMaterial`, `ringMaterial`, `starMaterial` return
  Three.js materials. Dispose them after use. Texture arguments are borrowed.
- `createNebula(options)` and `createBlackHole(options)` return groups exposing
  `userData.update(camera, seconds, {quality})` and `userData.dispose()`.
  Nebula update also accepts visibility; black holes expose `setVisibility`
  and `setSkyTransform`. Shared noise survives until its final user releases it.
  Injected sky textures remain caller-owned.
- Nebula `userData.distanceToVolume(worldPosition)` accepts a Three.js `Vector3`
  and returns world-unit distance to its transformed box volume, including parent
  transforms that preserve orthogonal box axes (translation, rotation and scale,
  without shear). Points inside or on the box return zero. Use this distance for
  visibility fading instead of distance to the group's origin; the box bounds
  the volume, rather than tracing individual dust features. The input is unchanged.
- `createDeepSky({detailTexture})` creates the directional background also sampled by the
  default black-hole lens. Pass the same trusted environment to
  `sky.userData.update(environment, quiet)` and
  `hole.userData.setEnvironment(environment, quiet)` to customize both. The
  environment contains finite `ambientTint` RGB and unit `bandNormal` arrays,
  plus finite `skyBrightness`, `bandStrength`, and `starDensity` values. An
  explicit environment supersedes the legacy photographic sky texture path.
  Both groups expose idempotent `userData.dispose()`.
- The environment may include a trusted `starSea` descriptor: `weights` is six
  finite nonnegative blend weights (all zero disables the layer), `frame` is a
  nine-number column-major rotation matrix mapping sky directions to the sea's
  local frame, `phase` is a finite spatial variation offset, and `width` is a
  positive finite latitude scale. The six weights select a stellar river, folded
  blue veil, old stellar halo, broken star islands, dark rift, and curved arc.
  The application owns sampling, seeding and transitions; the renderer copies the
  descriptor values without generating regions. Omitting `starSea` on a later
  environment update clears its contribution. Creation defaults to no sea.
  `deepSkyUniforms({detailTexture})` and
  `setDeepSkyEnvironment(uniforms, environment, quiet = 0)` expose the same setup
  for custom materials. Supply the same optional `detailTexture` to
  `createBlackHole({detailTexture})` and `createDeepSky({detailTexture})` to share
  celestial detail in both views. It is borrowed and never disposed by either
  group; without it, the layer uses procedural detail. Like the environment,
  the texture is supplied by the application, with no engine asset dependency.
  An optional `starSea.appearance` profile supplies `morphologyWeights` (18
  nonnegative weights), linear RGB `cool`, `warm`, `accent` and a three-number
  spatial noise `offset`. Four-number controls are `shape` (stretch, warp, core,
  spread), `structure` (arm count, pitch, clumping, asymmetry), `dust` (opacity,
  lane width, erosion, contrast) and `state` (young population, emission,
  exposure, extinction). The first six weights address the legacy river,
  curtain, halo, islands, rift and arc. Weights 6–17 add barred/fragmented
  spirals, eroded emission shells, filaments, stellar lenses, diffuse
  ellipsoids, starburst knots, tidal clusters, dust braids, hollow dust eyes,
  tidal tails and broken annuli. The application owns correlated palettes,
  seed streams and continuous spatial interpolation. The renderer copies
  profiles to both sky and lens; it does not choose a profile from a dominant
  family. Old descriptors without `appearance` retain the six-weight contract;
  removing a sea clears all eighteen contributions. The catalogue texture
  contributes filtered stellar grain only, so its panoramic silhouette does
  not determine the profile's geometry or palette. This changes appearance,
  not celestial addresses or particle generation. More primitives and per-pixel
  math can increase frame cost; no cross-device performance guarantee is made.
  Use an equirectangular celestial map with periodic longitude and set the
  caller-owned texture's `wrapS = THREE.RepeatWrapping`; latitude uses the
  texture's usual clamped wrapping. Version 0.6.1 supplies explicit texture
  gradients with the shortest periodic U difference, preventing coarse-mip
  dark seams at the longitude meridian in both the sky and lens. Latitude
  filtering is preserved. This changes filtering only: it adds no image assets
  and does not change UV coordinates, descriptors, seeds or body positions.
- A caller may instead provide `starSea.landscape = {revision: 1, components}`.
  This replaces the profile's radiance for that environment; it does not reseed
  or combine with the legacy eighteen-shape path. `components` has exactly four
  fixed slots, ordered far to near. Each slot contains an orthonormal `frame`
  (nine column-major numbers, applied after `starSea.frame`), `offset` (three),
  `shape` (positive angular scales X/Y, hollow amount, positive rim width),
  `topology` (nonnegative cloud/ring/stream/spiral weights), `contour` (bend,
  winding, shear, ridge), `material` (warp, breakup, clump, optical depth),
  `light` (nonnegative emission, core strength, source X/Y), and linear-light
  RGB `cool`/`warm` arrays. Shape coordinates use stereographic direction units.
  Clump controls detail amplitude, density concentration and dust structure.
  Pure absorption and pure emission are both supported. A caller must keep
  slot roles stable across space, interpolate its fields, then reconstruct
  orthonormal local frames; do not sort slots as brightness changes. Seeds,
  placement rules, camera composition and naming belong to the caller.
  The sky and black-hole lens copy the same descriptor into independent
  uniforms. Removing the landscape clears all slots and restores the published
  appearance/legacy path. No texture or drawing pass is added. The new path has
  a fixed four-field cost (up to sixteen noise evaluations per fragment,
  including the basic sky), plus optical and filtered stellar-detail math;
  unchanged draw counts do not imply unchanged GPU time. Measure on the target
  hardware and include mixed spatial samples, not only anchor points.
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
