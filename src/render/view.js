import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { NebulaRenderPass } from './nebula-render-pass.js';
import { createBloomPass } from './bloom.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createUniverse } from '../generator.js';
import { decodeCell } from '../coordinates.js';
import { randomFromSeed } from '../random.js';
import { loadedCells, visibilityAtDistance, VIEW_FAR } from '../streaming.js';
import { planetMaterial, atmosphereMaterial, ringMaterial, starMaterial } from './materials.js';
import { createNebula } from './nebula.js';
import { createBlackHole } from './blackhole.js';
import { createCosmos } from './cosmos.js';
import { createDeepSky } from './deep-sky.js';
import { nebulaVisibility } from '../nebula-volume.js';
import { createPlanetLod } from './planet-lod.js';

const QUALITIES = new Set(['auto', 'low', 'high']);
function checkQuality(value) {
  if (!QUALITIES.has(value)) throw new RangeError('Quality must be auto, low or high');
  return value;
}
function finiteArray(value, length, name) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(`${name} must be an array of ${length} finite numbers`);
  if (value.length !== length || !Array.from(value).every(Number.isFinite)) throw new TypeError(`${name} must contain ${length} finite numbers`);
  return Array.from(value);
}
function releaseAll(callbacks) {
  const errors = [];
  for (const release of callbacks.splice(0).reverse()) {
    try { release(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Universe view resource cleanup failed');
}

function createStarfield(seed) {
  const random = randomFromSeed(`${seed}:background-stars`), count = 9000;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const color = new THREE.Color();
  for (let i = 0; i < count; i += 1) {
    const azimuth = random() * Math.PI * 2, y = random() * 2 - 1, radius = Math.sqrt(1 - y * y);
    positions.set([Math.cos(azimuth) * radius * 92000, y * 92000, Math.sin(azimuth) * radius * 92000], i * 3);
    const temperature = random(), bright = random() < .015 ? 2 + random() * 2 : .25 + random() * .8;
    color.set(temperature < .15 ? 0xffd6ad : temperature > .7 ? 0xa6c6ff : 0xf1f0e7);
    colors.set([color.r * bright, color.g * bright, color.b * bright], i * 3);
    sizes[i] = bright > 2 ? 2 + random() * 1.7 : .7 + random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('pointSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { ratio: { value: 1 } },
    vertexShader: 'attribute vec3 color;attribute float pointSize;uniform float ratio;varying vec3 tint;void main(){tint=color;gl_PointSize=pointSize*ratio;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec3 tint;void main(){float radius=length(gl_PointCoord-.5);gl_FragColor=vec4(tint,1.-smoothstep(.06,.5,radius));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material); stars.frustumCulled = false;
  stars.name = 'Procedural stellar background';
  return stars;
}

function createGlow() {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const r = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
    const offset = (y * size + x) * 4;
    pixels.set([255, 255, 255, Math.round(255 * Math.exp(-r * r * 7) * Math.max(0, 1 - r))], offset);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
  return texture;
}

/** Synchronous, asset-free renderer. Local camera coordinates belong to sectorIndex.
 * render() and start() animate materials only; the caller owns camera movement.
 * Use setView at cell boundaries to supply the new sector and rebased position.
 * Arrays use [x,y,z] and quaternion [x,y,z,w]; animation time is in seconds.
 */
export function createUniverseView(container, { universe = createUniverse(), quality = 'auto', onContextLost, onContextRestored } = {}) {
  if (!container || typeof container.append !== 'function' || !container.ownerDocument?.defaultView) throw new TypeError('A DOM container is required');
  if (!universe || typeof universe.getSector !== 'function' || typeof universe.seed !== 'string') throw new TypeError('Universe must provide seed and getSector(index)');
  for (const callback of [onContextLost, onContextRestored]) if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Context callbacks must be functions');
  quality = checkQuality(quality);
  const host = container.ownerDocument.defaultView;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 1, .5, 220000);
  scene.add(camera);
  const resources = [], chunks = new Map();
  let renderer, composer, bloom, stars, sky, cosmos, sphere, distantSphere, planetLod, ringGeometry, glow, fallbackTexture;
  let disposed = false, running = false, lost = false, resumeAfterRestore = false, raf = null;
  let width = 1, height = 1, sectorIndex = 0, loadedIndex = -1, loadedRevision, time = 0, epoch = null;
  const cameraPosition = new THREE.Vector3(), bodyPosition = new THREE.Vector3();
  const lightDirection = new THREE.Vector3(-1, .4, .35).normalize();
  const own = object => { resources.push(() => object.dispose()); return object; };
  const active = () => { if (disposed) throw new Error('Universe view has been disposed'); };

  function makeBody(data, materials, isStar = false, illumination = lightDirection) {
    const group = new THREE.Group(); group.position.fromArray(data.position);
    const track = material => { materials.add(material); return material; };
    const surface = track(isStar ? starMaterial(data.color) : planetMaterial(data, { lightDirection: illumination }));
    if (!isStar && !surface.uniforms.surface.value) surface.uniforms.surface.value = fallbackTexture;
    const geometry = isStar ? sphere : planetLod.geometry();
    const body = new THREE.Mesh(geometry, surface); body.scale.setScalar(data.radius); group.add(body);
    const lodMeshes = isStar ? [] : [body];
    const visibleMaterials = [surface];
    if (isStar || ['gas', 'ocean', 'ice'].includes(data.kind)) {
      const air = track(atmosphereMaterial(isStar ? data.color : data.colorA, illumination));
      const atmosphere = new THREE.Mesh(geometry, air); atmosphere.scale.setScalar(data.radius * (isStar ? 1.06 : 1.015));
      group.add(atmosphere); visibleMaterials.push(air);
      if (!isStar) lodMeshes.push(atmosphere);
    }
    if (data.rings && !isStar) {
      const material = track(ringMaterial(data.ringColor, data.seed, { planetRadius: data.radius, lightDirection: illumination }));
      material.uniforms.ringMap.value = fallbackTexture;
      const ring = new THREE.Mesh(ringGeometry, material); ring.scale.setScalar(data.radius);
      ring.rotation.set(-1.38, .14, 0);
      const axis = new THREE.Group(); axis.rotation.z = data.ringTilt ?? -.28; axis.add(ring); group.add(axis);
      group.userData.ring = ring; visibleMaterials.push(material);
    }
    if (isStar) {
      for (const [scale, opacity] of [[6.5, .36], [18, .16]]) {
        const material = track(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(data.color).multiplyScalar(1.9), opacity,
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        const halo = new THREE.Sprite(material); halo.scale.setScalar(data.radius * scale); halo.userData.baseOpacity = opacity; group.add(halo);
      }
    }
    group.userData = { ...group.userData, surface, body, isStar, lodMeshes, radius: data.radius, materials: visibleMaterials };
    return group;
  }

  function makeChunk(index) {
    const data = universe.getSector(index), group = new THREE.Group(), materials = new Set(), volumes = [];
    const bodies = [], holes = [];
    let released = false;
    group.userData.dispose = () => {
      if (released) return; released = true; group.removeFromParent();
      releaseAll([...Array.from(materials, material => () => material.dispose()), ...volumes.map(volume => () => volume.userData.dispose())]);
      group.clear();
    };
    try {
      for (const dataBody of data.planets) {
        const illumination = data.stars.length
          ? new THREE.Vector3().fromArray(data.stars[0].position).sub(new THREE.Vector3().fromArray(dataBody.position)).normalize()
          : lightDirection;
        const body = makeBody(dataBody, materials, false, illumination); bodies.push(body); group.add(body);
      }
      for (const dataBody of data.stars) { const body = makeBody(dataBody, materials, true); bodies.push(body); group.add(body); }
      if (data.nebula?.density > .001) {
        const nebula = createNebula({ ...data.nebula, morphology: data.region?.morphology, seed: data.id });
        volumes.push(nebula); nebula.rotation.z = (data.nebula.tilt ?? 0) * .5; group.add(nebula); group.userData.nebula = nebula;
      }
      if (data.blackHole) {
        const hole = createBlackHole(data.blackHole); volumes.push(hole); hole.position.fromArray(data.blackHole.position); group.add(hole); holes.push(hole);
      }
      Object.assign(group.userData, { index, bodies, holes });
      return group;
    } catch (error) {
      try { group.userData.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Sector creation and cleanup failed', { cause: error }); }
      throw error;
    }
  }

  function syncChunks() {
    const entries = loadedCells(sectorIndex), revision = universe.revision ?? 0, rebuild = revision !== loadedRevision;
    const pending = new Map();
    try {
      for (const { index } of entries) if (rebuild || !chunks.has(index)) pending.set(index, makeChunk(index));
    } catch (error) {
      try { releaseAll([...pending.values()].map(group => () => group.userData.dispose())); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Streaming and cleanup failed', { cause: error }); }
      throw error;
    }
    const requested = new Set(entries.map(entry => entry.index));
    for (const [index, chunk] of chunks) if (rebuild || !requested.has(index)) { chunk.userData.dispose(); chunks.delete(index); }
    for (const [index, chunk] of pending) { chunks.set(index, chunk); scene.add(chunk); }
    for (const { index, offset } of entries) chunks.get(index).position.fromArray(offset);
    loadedIndex = sectorIndex; loadedRevision = revision;
  }

  function resize() {
    active();
    width = Math.max(1, container.clientWidth || 1); height = Math.max(1, container.clientHeight || 1);
    const deviceRatio = host.devicePixelRatio || 1;
    const ratio = Math.min(deviceRatio, quality === 'low' ? .9 : quality === 'high' ? 1.6 : width < 700 ? 1 : 1.25);
    renderer.setDrawingBufferSize(width, height, ratio);
    composer.setSize(width * ratio, height * ratio);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    bloom.enabled = quality !== 'low'; bloom.strength = quality === 'high' ? .42 : .32;
    stars.material.uniforms.ratio.value = ratio;
    stars.geometry.setDrawRange(0, quality === 'low' ? 4000 : 9000);
  }

  function render(elapsedTime = 0) {
    active();
    if (!Number.isFinite(elapsedTime)) throw new TypeError('Animation time must be finite');
    if (lost) return;
    if (![camera.position.x, camera.position.y, camera.position.z, ...camera.quaternion.toArray(), camera.fov].every(Number.isFinite)) throw new TypeError('Camera pose must contain finite values');
    if (sectorIndex !== loadedIndex || (universe.revision ?? 0) !== loadedRevision) syncChunks();
    time = elapsedTime;
    scene.updateMatrixWorld(true); camera.getWorldPosition(cameraPosition);
    stars.position.copy(cameraPosition);
    sky.position.copy(cameraPosition);
    cosmos.userData.update({ sectorIndex, cameraPosition: cameraPosition.toArray(), camera, quality, viewportHeight: height, pixelRatio: renderer.getPixelRatio() });
    for (const chunk of chunks.values()) {
      const nebula = chunk.userData.nebula;
      if (nebula) {
        const visibility = nebulaVisibility(nebula.userData.distanceToVolume(cameraPosition));
        nebula.visible = visibility > .001 && nebula.userData.isInView(camera);
        if (nebula.visible) nebula.userData.update(camera, time, { quality, visibility });
      }
      for (const group of chunk.userData.bodies) {
        bodyPosition.copy(chunk.position).add(group.position);
        const distance = bodyPosition.distanceTo(cameraPosition), visibility = visibilityAtDistance(distance);
        group.visible = visibility > 0;
        if (!group.visible) continue;
        for (const material of group.userData.materials) material.uniforms.visibility.value = visibility;
        group.userData.surface.depthWrite = visibility === 1;
        if (group.userData.isStar) {
          group.traverse(object => { if (object.geometry === sphere || object.geometry === distantSphere) object.geometry = distance > 15000 ? distantSphere : sphere; });
          group.userData.surface.uniforms.time.value = time;
          for (const object of group.children) if (object.isSprite) object.material.opacity = object.userData.baseOpacity * visibility;
        } else {
          planetLod.update(group.userData.lodMeshes, { radius: group.userData.radius, distance,
            fov: camera.fov, viewportHeight: height, pixelRatio: renderer.getPixelRatio(), quality });
          group.userData.body.rotation.y = time * .003;
        }
        if (group.userData.ring) group.getWorldPosition(group.userData.ring.material.uniforms.planetCenter.value);
      }
      for (const hole of chunk.userData.holes) {
        bodyPosition.copy(chunk.position).add(hole.position);
        const visibility = visibilityAtDistance(bodyPosition.distanceTo(cameraPosition));
        hole.visible = visibility > 0; hole.userData.setVisibility(visibility);
        if (hole.visible) hole.userData.update(camera, time, { quality });
      }
    }
    renderer.info.reset(); composer.render();
  }

  function frame(timestamp) {
    raf = null;
    if (!running || lost || disposed) return;
    if (epoch === null) epoch = timestamp - time * 1000;
    try { render((timestamp - epoch) / 1000); }
    catch (error) { running = false; epoch = null; throw error; }
    if (running && !lost && !disposed) raf = host.requestAnimationFrame(frame);
  }
  function start() {
    active();
    if (lost) { resumeAfterRestore = true; return; }
    if (running) return;
    running = true; epoch = null; raf = host.requestAnimationFrame(frame);
  }
  function stop() {
    if (disposed) return;
    running = false; resumeAfterRestore = false; epoch = null;
    if (raf !== null) host.cancelAnimationFrame(raf); raf = null;
  }
  function handleLost(event) {
    event.preventDefault();
    if (disposed || lost) return;
    resumeAfterRestore = running; running = false; lost = true; epoch = null;
    if (raf !== null) host.cancelAnimationFrame(raf); raf = null;
    onContextLost?.(event);
  }
  function handleRestored(event) {
    if (disposed) return;
    const resume = resumeAfterRestore; resumeAfterRestore = false; lost = false;
    resize(); if (resume) start(); onContextRestored?.(event);
  }
  function dispose() {
    if (disposed) return;
    stop(); disposed = true;
    const cleanup = [...resources, ...chunks.values()].map(entry => typeof entry === 'function' ? entry : () => entry.userData.dispose());
    resources.length = 0; chunks.clear();
    try { releaseAll(cleanup); } finally { scene.clear(); }
  }

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
    resources.push(() => renderer.dispose());
    resources.push(() => { if (renderer.getContext()) renderer.forceContextLoss(); });
    renderer.setClearColor(0x000003); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
    renderer.info.autoReset = false;
    renderer.domElement.setAttribute('aria-label', 'Procedural three-dimensional universe');
    renderer.domElement.style.display = 'block'; renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    container.append(renderer.domElement); resources.push(() => renderer.domElement.remove());
    sphere = own(new THREE.SphereGeometry(1, 96, 64)); distantSphere = own(new THREE.SphereGeometry(1, 48, 32));
    planetLod = createPlanetLod(); resources.push(() => planetLod.dispose());
    ringGeometry = own(new THREE.RingGeometry(1.18, 2.26, 256, 1)); glow = own(createGlow());
    fallbackTexture = own(new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)); fallbackTexture.needsUpdate = true;
    stars = createStarfield(universe.seed); own(stars.geometry); own(stars.material); scene.add(stars);
    sky = createDeepSky(); resources.push(() => sky.userData.dispose()); scene.add(sky);
    cosmos = createCosmos({ seed: universe.seed }); resources.push(() => cosmos.userData.dispose()); scene.add(cosmos);
    composer = own(new EffectComposer(renderer));
    // Keep DPR at the renderer boundary and resize postprocessing only once.
    composer.setPixelRatio(1);
    const renderPass = own(new NebulaRenderPass(scene, camera)); bloom = own(createBloomPass({strength: .32}));
    const output = own(new OutputPass()); composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(output);
    renderer.domElement.addEventListener('webglcontextlost', handleLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleRestored);
    resources.push(() => {
      renderer.domElement.removeEventListener('webglcontextlost', handleLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleRestored);
    });
    host.addEventListener('resize', resize); resources.push(() => host.removeEventListener('resize', resize));
    if (host.ResizeObserver) {
      const observer = new host.ResizeObserver(() => { if (!disposed) resize(); });
      observer.observe(container); resources.push(() => observer.disconnect());
    }
    resize(); syncChunks();
  } catch (error) {
    try { dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Universe view initialization and cleanup failed', { cause: error }); }
    throw error;
  }

  return {
    scene, camera, renderer, universe, render, start, stop, resize, dispose,
    setView({ sectorIndex: index = sectorIndex, position, orientation, fov } = {}) {
      active(); decodeCell(index);
      const nextPosition = position === undefined ? null : finiteArray(position, 3, 'Position');
      const nextOrientation = orientation === undefined ? null : finiteArray(orientation, 4, 'Orientation');
      if (nextOrientation) {
        const length = Math.hypot(...nextOrientation);
        if (!Number.isFinite(length) || length < 1e-12) throw new RangeError('Orientation quaternion must have a finite nonzero length');
        for (let i = 0; i < 4; i += 1) nextOrientation[i] /= length;
      }
      if (fov !== undefined && (!Number.isFinite(fov) || fov <= 0 || fov >= 180)) throw new RangeError('Field of view must be between 0 and 180 degrees');
      sectorIndex = index;
      if (nextPosition) camera.position.fromArray(nextPosition);
      if (nextOrientation) camera.quaternion.fromArray(nextOrientation).normalize();
      if (fov !== undefined) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },
    setQuality(value) { active(); quality = checkQuality(value); resize(); },
    diagnostics() {
      return { disposed, running, contextLost: lost, sectorIndex, revision: universe.revision ?? 0, loadedRevision,
        cells: chunks.size, viewFar: VIEW_FAR, quality, time, viewport: [width, height], bloom: !disposed && bloom.enabled,
        planets: [...chunks.values()].reduce((count, chunk) => count + chunk.userData.bodies.filter(body => !body.userData.isStar).length, 0),
        stars: [...chunks.values()].reduce((count, chunk) => count + chunk.userData.bodies.filter(body => body.userData.isStar).length, 0),
        blackHoles: [...chunks.values()].reduce((count, chunk) => count + chunk.userData.holes.length, 0),
        drawCalls: renderer.info.render.calls, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
        cosmos: { ...cosmos.userData.stats } };
    },
  };
}
