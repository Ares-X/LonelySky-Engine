# Engine and game integration

The reusable engine contains deterministic generation, spatial addressing,
physics and optional Three.js visuals. The main demo link points to the normal
[LonelySky game](https://lonelysky.app/), maintained separately.

There are two entry points:

- `src/index.js`: pure data, generation, streaming and physics; no DOM or Three.js.
- `src/three.js`: the optional renderer and individual celestial primitives.

An application can use the default generator or supply its own scene provider.
Game-specific seeds, names, authored compositions and asset choices stay with
that provider. Seed independent generators explicitly so adding a visual layer
does not change an existing world's body stream.

The original physics factories still accept sphere-array providers. With the
default generator, use `createGravityField({world: universe})` or
`createCollisionWorld({world: universe})`; `universe.sector` supplies spheres.
Rendering reads `universe.getSector` instead.

The renderer starts no input, flight controls, social features, identity, saving,
analytics or backend requests. Its procedural scene needs no artwork downloads.
Hosts can supply their own materials and separately licensed textures.

The full game has its own cinematic camera, compositions, planetary textures,
flight handling and UI. A gameplay screenshot shows the visual techniques;
the default embedding example produces its own world. [Image credits](showcase-credits.md).

Pin an engine commit in a Git submodule. Upgrade and validate the consumer before
changing its recorded revision. Avoid a moving branch in production builds.

The cosmos renderer retains particle buffers when a cell rebase stays inside
the same macro neighborhood and quality level. Only positions are uploaded;
colors and radii keep their existing storage. Population or quality changes
replace the buffers. Particle coordinates, counts, distance fades and volume
sampling budgets are unchanged.

Shaders skip work only when an existing contribution is exactly zero: fully
transparent points are clipped before rasterization, galaxy samples beyond the
existing visibility fade avoid density evaluation, and the two optional shell
families avoid microstructure queries outside their existing fronts. Deep-sky
band noise and resolved spark detail are also skipped when their weights are
zero. The geometry, integration nodes, sample counts and fade distances remain
unchanged; no additional density or opacity cutoff is introduced.

## Procedural scenery appearance

The directional sky shares absorbing dust lanes with the black-hole lens. Galaxy
volumes use a shared, mip-filtered 64 by 64 periodic multiscale texture for dusty
complexes, uneven arm widths and small star-forming regions. Dust reduces the
galaxy's own emission; it does not cover unrelated foreground geometry or sky.
Descriptors, addresses, particle positions and quality prefixes are unchanged.

Nebula volumes fade to zero before their bounds, use one mip-filtered 64-cubed
noise texture, directional ray/pixel footprints and paired Gauss samples within
the existing 16/32/48-step budgets. Extinction follows the world-space optical
length through a scaled volume. Appearance profiles add tapered trunks, broad
seeded shear, depth-coherent dust erosion and two-point light-column shading.
An optional `rimColor` separates ionized skins from reflected dust light. Calls
without appearance descriptors retain their palette and source controls. The warm emission-cloud palette and optical galaxy populations draw
on NASA's [Cosmic Cliffs](https://science.nasa.gov/asset/webb/cosmic-cliffs-in-the-carina-nebula-nircam-image/),
[Pillars of Creation](https://science.nasa.gov/asset/webb/pillars-of-creation-nircam-image/)
and [Hubble M74](https://science.nasa.gov/asset/hubble/spiral-galaxy-m74/).
These are artistic display cues, not calibrated naked-eye colors or radiative
transfer. No reference photographs or additional dependencies are required.
