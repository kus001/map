import { buildings as sampleBuildings, createBuildingMesh, sceneStats, createPolygonBuildingMesh, convertTorontoGeoJSON, polygonSceneStats } from "./buildingMesh.mjs";
import { createGroundMesh, parseOSMStreets } from "./cityGround.mjs";
import { FOV, clamp, cameraEye, screenRay, hitBuildings, zoomAt, panOnPlane, clippingPlanes, cameraInsideBuildings } from "./cameraMath.mjs";

const canvas = document.querySelector("#scene");
const status = document.querySelector("#status");
const texturesButton = document.querySelector("#textures");
const resetButton = document.querySelector("#reset");
const zoomInButton = document.querySelector("#zoom-in");
const zoomOutButton = document.querySelector("#zoom-out");
const torontoButton = document.querySelector("#toronto");
const samplesButton = document.querySelector("#samples");
const detailsButton = document.querySelector("#details");
const streetsButton = document.querySelector("#streets");
const panelToggle = document.querySelector("#panel-toggle");
const gl = canvas.getContext("webgl2", { antialias: true, depth: true, alpha: false });

const vertexShader = `#version 300 es
  in vec3 position;
  in vec2 uv;
  in vec3 normal;
  uniform mat4 viewProjection;
  out vec2 sampleUV;
  out vec3 lighting;
  void main() {
    sampleUV = uv;
    vec3 n = normalize(normal);
    vec3 sun = normalize(vec3(-0.52, 0.82, 0.39));
    vec3 skylight = vec3(0.64, 0.68, 0.73);
    vec3 sunlight = vec3(0.39, 0.35, 0.28) * max(dot(n, sun), 0.0);
    vec3 skyBounce = vec3(0.07, 0.09, 0.12) * max(n.y, 0.0);
    lighting = skylight + sunlight + skyBounce;
    gl_Position = viewProjection * vec4(position, 1.0);
  }
`;
const fragmentShader = `#version 300 es
  precision highp float;
  in vec2 sampleUV;
  in vec3 lighting;
  uniform sampler2D facade;
  uniform vec3 color;
  uniform vec3 tint;
  uniform bool useImage;
  uniform bool useArchitecture;
  uniform int wallStyle;
  uniform vec3 masonry;
  uniform vec3 frameColor;
  uniform vec2 moduleSize;
  out vec4 outputColor;
  void main() {
    vec3 surface = useImage ? texture(facade, sampleUV).rgb : color;
    if (useImage && useArchitecture) {
      // The images supply glazing detail; the facade itself isn't all glass.
      vec2 metres = sampleUV * 9.0;
      vec2 unit = fract(metres / moduleSize);
      float glassTower = float(wallStyle == 0);
      float wideWindow = wallStyle == 1 ? 0.68 : (wallStyle == 2 ? 0.57 : 0.73);
      float lowWindow = wallStyle == 1 ? 0.26 : (wallStyle == 2 ? 0.30 : 0.23);
      float xWidth = fwidth(unit.x) * 0.6;
      float yWidth = fwidth(unit.y) * 0.6;
      float windowX = smoothstep((1.0-wideWindow)*0.5-xWidth, (1.0-wideWindow)*0.5+xWidth, unit.x)
          * (1.0-smoothstep((1.0+wideWindow)*0.5-xWidth, (1.0+wideWindow)*0.5+xWidth, unit.x));
      float windowY = smoothstep(lowWindow-yWidth, lowWindow+yWidth, unit.y)
          * (1.0-smoothstep(0.94-yWidth, 0.94+yWidth, unit.y));
      float windowMask = windowX * windowY;
      vec3 siding = mix(masonry, surface * 0.40 + masonry * 0.60, glassTower * 0.22);
      surface = mix(siding, surface * (glassTower > 0.5 ? 0.94 : 0.89), windowMask);
      float pier = 1.0 - windowX;
      float spandrel = 1.0 - windowY;
      // Mullions, lintels, piers and horizontal floor bands.
      surface = mix(surface, frameColor, clamp(pier*0.22 + spandrel*0.13, 0.0, 0.36));
      if (metres.y < 5.2) {
        // Ground floors have masonry piers and larger storefront openings.
        float entrance = smoothstep(0.18-xWidth, 0.18+xWidth, unit.x)
            * (1.0-smoothstep(0.82-xWidth, 0.82+xWidth, unit.x));
        float groundGlazing = entrance * step(0.45, metres.y);
        surface = mix(masonry * 0.80, mix(surface, vec3(0.22,0.31,0.34), 0.31), groundGlazing * 0.75);
      }
    }
    surface *= tint;
    outputColor = vec4(clamp(surface * lighting, 0.0, 1.0), 1.0);
  }
`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function createProgram() {
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, vertexShader);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentShader);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function multiply(a, b) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      result[column * 4 + row] = sum;
    }
  }
  return result;
}

function perspective(fov, aspect, near, far) {
  const scale = 1 / Math.tan(fov / 2);
  const projection = new Float32Array(16);
  projection[0] = scale / aspect;
  projection[5] = scale;
  projection[10] = (far + near) / (near - far);
  projection[11] = -1;
  projection[14] = 2 * far * near / (near - far);
  return projection;
}

function normalize(v) {
  const size = Math.hypot(...v) || 1;
  return v.map(value => value / size);
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lookAt(eye, target) {
  const z = normalize(eye.map((value, i) => value - target[i]));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function makeBuffer(values, positionLocation, uvLocation, normalLocation) {
  const array = new Float32Array(values);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 32, 0);
  gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 32, 12);
  gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 32, 20);
  gl.enableVertexAttribArray(positionLocation);
  gl.enableVertexAttribArray(uvLocation);
  gl.enableVertexAttribArray(normalLocation);
  gl.bindVertexArray(null);
  return { vao, buffer, count: array.length / 8 };
}

function loadTexture(name, fallback) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
      if (anisotropy) {
        const max = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
      }
      resolve({ name, texture, ok: true });
    };
    image.onerror = () => resolve({ name, texture: fallback, ok: false });
    image.src = `/textures/buildings/${name}.png`;
  });
}

const palette = {
  glass: [0.55, 0.7, 0.78], brick: [0.67, 0.42, 0.32], concrete: [0.74, 0.73, 0.71],
  stone: [0.78, 0.73, 0.63], metal: [0.65, 0.7, 0.72], wood: [0.67, 0.51, 0.39],
  plaster: [0.85, 0.83, 0.78], default: [0.77, 0.76, 0.73],
};

// No new PNGs or per-frame randomness. The same building always has the same tint.
const facadeTints = [
  [1, 1, 1], [0.92, 0.97, 1.04], [1.06, 1.01, 0.94],
  [0.90, 0.93, 0.97], [1.04, 1.04, 1.02],
];
const roofPalette = {
  glass: [0.57, 0.62, 0.65], brick: [0.61, 0.55, 0.48], concrete: [0.68, 0.67, 0.63],
  stone: [0.70, 0.66, 0.59], metal: [0.48, 0.54, 0.57], wood: [0.58, 0.56, 0.49],
  plaster: [0.72, 0.69, 0.62], default: [0.66, 0.65, 0.62],
};
const roofTints = [1, 0.92, 1.07, 0.97, 1.04];
// Approximate facade styles, not surveyed architectural details.
const wallProfiles = {
  glass:    { style: 0, masonry: [0.47,0.53,0.57], frame: [0.28,0.35,0.38], bay: 2.9, floor: 3.7 },
  metal:    { style: 0, masonry: [0.57,0.61,0.62], frame: [0.33,0.37,0.40], bay: 3.2, floor: 3.9 },
  concrete: { style: 1, masonry: [0.72,0.69,0.65], frame: [0.51,0.50,0.49], bay: 3.0, floor: 3.4 },
  stone:    { style: 2, masonry: [0.76,0.68,0.55], frame: [0.55,0.50,0.45], bay: 2.7, floor: 3.5 },
  brick:    { style: 2, masonry: [0.66,0.36,0.28], frame: [0.46,0.29,0.25], bay: 2.55, floor: 3.3 },
  wood:     { style: 3, masonry: [0.65,0.48,0.34], frame: [0.39,0.32,0.26], bay: 2.6, floor: 3.2 },
  plaster:  { style: 3, masonry: [0.82,0.77,0.66], frame: [0.55,0.53,0.48], bay: 3.15, floor: 3.45 },
  default:  { style: 1, masonry: [0.72,0.70,0.65], frame: [0.50,0.52,0.54], bay: 3.0, floor: 3.5 },
};
function appearance(name) {
  const [base, raw] = name.split(":");
  const variant = Math.max(0, Math.min(4, Number(raw) || 0));
  return { base, tint: facadeTints[variant], roof: roofPalette[base].map(v => v * roofTints[variant]),
    wall: wallProfiles[base] || wallProfiles.default, variant };
}

let yaw = -0.62;
let tilt = 0.65;
let distance = 260;
let textureMode = true;
let activePointers = new Map();
let lastTouchGesture = null;
let lastTap = null;
let architectureMode = true;
let streetsMode = true;
let groundGeometry = null;
let streetStatus = "";
let activeBuildings = [];
let sceneRadius = 750;
let pendingFrame = false;
let renderer;
let mode = "samples";
let requestedMode = "toronto";
let torontoData = null;
let torontoPromise = null;
let sampleStatus = "";
let torontoStatus = "Loading Toronto building outlines...";
let cameraTarget = [10, 18, 0];
const sampleCamera = { yaw: -0.62, tilt: 0.65, distance: 260, target: [10, 18, 0] };
let torontoCamera = null;

// Single snapshot request; moving the camera never fetches or updates building geometry.
const CITY_DATA_URL = "https://gis.toronto.ca/arcgis/rest/services/cot_geospatial3/FeatureServer/2/query";
function cityQuery() {
  const params = new URLSearchParams({
    where: "1=1", geometry: "-79.3865,43.6480,-79.3773,43.6553",
    geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    outSR: "4326", outFields: "OBJECTID,BUILDINGID,DERIVED_HEIGHT,SUBTYPE_DESC",
    returnGeometry: "true", resultRecordCount: "1200", f: "geojson",
  });
  return `${CITY_DATA_URL}?${params}`;
}

function refreshButtons() {
  torontoButton.setAttribute("aria-pressed", String(mode === "toronto"));
  samplesButton.setAttribute("aria-pressed", String(mode === "samples"));
}

function replaceGround() {
  if (!renderer) return;
  if (renderer.groundParts) for (const entry of renderer.groundParts.values()) {
    gl.deleteVertexArray(entry.vao);
    gl.deleteBuffer(entry.buffer);
  }
  renderer.groundParts = new Map();
  const ground = createGroundMesh(mode === "toronto" ? "toronto" : "samples",
    mode === "toronto" && streetsMode ? groundGeometry : null);
  const position = gl.getAttribLocation(renderer.program, "position");
  const uv = gl.getAttribLocation(renderer.program, "uv");
  const normal = gl.getAttribLocation(renderer.program, "normal");
  for (const [name, vertices] of ground) {
    if (vertices.length) renderer.groundParts.set(name,
      makeBuffer(vertices, position, uv, normal));
  }
  requestDraw();
}

function installScene(mesh, stats, camera, buildings = []) {
  const position = gl.getAttribLocation(renderer.program, "position");
  const uv = gl.getAttribLocation(renderer.program, "uv");
  const normal = gl.getAttribLocation(renderer.program, "normal");
  const nextParts = new Map();
  for (const [name, entry] of mesh) {
    if (entry.walls.length === 0) continue;
    nextParts.set(name, {
      walls: makeBuffer(entry.walls, position, uv, normal),
      roofs: makeBuffer(entry.roofs, position, uv, normal),
      details: makeBuffer(entry.details || [], position, uv, normal),
    });
  }
  const previous = renderer.parts;
  renderer.parts = nextParts;
  renderer.stats = stats;
  activeBuildings = buildings;
  sceneRadius = radiusForBuildings(buildings);
  yaw = camera.yaw;
  tilt = camera.tilt;
  distance = camera.distance;
  cameraTarget = camera.target;
  for (const entry of previous.values()) {
    for (const part of [entry.walls, entry.roofs, entry.details].filter(Boolean)) {
      gl.deleteVertexArray(part.vao);
      gl.deleteBuffer(part.buffer);
    }
  }
  replaceGround();
  requestDraw();
}

function radiusForBuildings(items) {
  if (!items.length) return 750;
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,maxH=0;
  for (const item of items) {
    for(const [x,z] of item.points){ minX=Math.min(minX,x); maxX=Math.max(maxX,x); minZ=Math.min(minZ,z); maxZ=Math.max(maxZ,z); }
    maxH=Math.max(maxH,item.h);
  }
  return Math.hypot(maxX-minX,maxZ-minZ,maxH);
}
function sampleFootprints() {
  return sampleBuildings.map(({ x,z,w,d,h }) => ({ h,points:[[x,z],[x+w,z],[x+w,z+d],[x,z+d]] }));
}
function cameraForBuildings(items) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const item of items) for (const [x, z] of item.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  return { yaw: -0.62, tilt: 0.88, distance: Math.max(420, span * 1.75),
    target: [(minX + maxX) / 2, 30, (minZ + maxZ) / 2] };
}

function showSamples(reason = "") {
  mode = "samples";
  installScene(createBuildingMesh(), sceneStats(), sampleCamera, sampleFootprints());
  refreshButtons();
  status.textContent = `${sampleStatus}${reason ? `\n${reason}` : ""}`;
}

function showToronto() {
  if (!torontoData) return;
  mode = "toronto";
  installScene(createPolygonBuildingMesh(torontoData.buildings), polygonSceneStats(torontoData.buildings), torontoCamera, torontoData.buildings);
  refreshButtons();
  updateTorontoStatus();
}

// Streets come from a separate OSM snapshot, never from a simulated road grid.
const OSM_STREETS_QUERY = `[out:json][timeout:18];(way["highway"](43.6480,-79.3865,43.6553,-79.3773);way["leisure"="park"](43.6480,-79.3865,43.6553,-79.3773););out geom;`;
async function loadStreets() {
  if (groundGeometry || !streetsMode) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22000);
    let response;
    try {
      response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(OSM_STREETS_QUERY)}`,
        { signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    groundGeometry = parseOSMStreets(data);
    streetStatus = `${groundGeometry.roads.length} OSM street segments · ${groundGeometry.parks.length} park outlines`;
    if (mode === "toronto") replaceGround();
  } catch (error) {
    streetStatus = `Street data unavailable (${error.message}); neutral ground retained`;
  }
  if (mode === "toronto") updateTorontoStatus();
}
function updateTorontoStatus() {
  if (mode === "toronto") status.textContent = `${torontoStatus}${streetStatus ? `\n${streetStatus}` : ""}`;
}

async function loadToronto() {
  if (torontoData) { showToronto(); return; }
  if (torontoPromise) return torontoPromise;
  torontoStatus = "Fetching one fixed area of downtown Toronto...";
  status.textContent = torontoStatus;
  torontoPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let response;
      try { response = await fetch(cityQuery(), { signal: controller.signal, mode: "cors" }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`Toronto data service returned HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || "Toronto data service reported an error");
      const parsed = convertTorontoGeoJSON(data);
      if (parsed.buildings.length < 3) throw new Error("No usable building polygons in the Toronto response");
      torontoData = parsed;
      torontoCamera = cameraForBuildings(parsed.buildings);
      const stats = polygonSceneStats(parsed.buildings);
      torontoStatus = `${stats.buildings} Toronto building polygons · ${stats.wallTriangles} wall triangles · ${stats.roofTriangles} roof triangles\n${parsed.recordedHeights} recorded heights · ${parsed.estimatedHeights} estimated at 12 m${parsed.skippedHoles ? ` · ${parsed.skippedHoles} courtyard footprints simplified` : ""}\nIllustrative windows, cladding, piers and podiums; actual facade materials are not surveyed. Camera movement never rebuilds geometry.`;
      if (requestedMode === "toronto") showToronto();
      loadStreets();
    } catch (error) {
      torontoStatus = `Couldn't fetch Toronto buildings (${error.message}). Sample blocks are still available.`;
      if (requestedMode === "toronto") showSamples(torontoStatus);
    } finally {
      torontoPromise = null;
    }
  })();
  return torontoPromise;
}

function resize() {
  const ratio = Math.min(devicePixelRatio || 1, 1.8);
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
}

function draw() {
  pendingFrame = false;
  if (!renderer) return;
  resize();
  gl.clearColor(0.92, 0.95, 0.96, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(renderer.program);
  const target = cameraTarget;
  const eye = cameraEye(target, yaw, tilt, distance);
  const { near, far } = clippingPlanes(distance, sceneRadius + Math.hypot(target[0],target[2]));
  const matrix = multiply(perspective(FOV, canvas.width / canvas.height, near, far), lookAt(eye, target));
  gl.uniformMatrix4fv(renderer.viewProjection, false, matrix);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  if (renderer.groundParts) {
    const groundColors = {
      ground: [0.77,0.80,0.75], park: [0.43,0.58,0.41], sidewalk: [0.71,0.71,0.67],
      road: [0.27,0.30,0.31], path: [0.60,0.57,0.50],
    };
    gl.uniform1i(renderer.useImage, false);
    gl.uniform1i(renderer.useArchitecture, false);
    gl.uniform3fv(renderer.tint, [1,1,1]);
    for (const [type, entry] of renderer.groundParts) {
      gl.uniform3fv(renderer.color, groundColors[type] || groundColors.ground);
      gl.bindVertexArray(entry.vao);
      gl.drawArrays(gl.TRIANGLES, 0, entry.count);
    }
  }
  for (const [name, part] of renderer.parts) {
    const { base, tint, roof, wall } = appearance(name);
    const chosen = renderer.textures.get(base);
    gl.uniform3fv(renderer.color, palette[base]);
    gl.uniform3fv(renderer.tint, tint);
    gl.uniform1i(renderer.useImage, Boolean(textureMode && chosen?.ok));
    gl.uniform1i(renderer.useArchitecture, architectureMode && textureMode && Boolean(chosen?.ok));
    gl.uniform1i(renderer.wallStyle, wall.style);
    gl.uniform3fv(renderer.masonry, wall.masonry);
    gl.uniform3fv(renderer.frameColor, wall.frame);
    const variant = appearance(name).variant;
    gl.uniform2fv(renderer.moduleSize, [wall.bay * (1 + 0.035 * (variant - 2)), wall.floor]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, chosen?.texture || renderer.blank);
    gl.uniform1i(renderer.facade, 0);
    gl.bindVertexArray(part.walls.vao);
    gl.drawArrays(gl.TRIANGLES, 0, part.walls.count);
    gl.uniform1i(renderer.useImage, false);
    gl.uniform1i(renderer.useArchitecture, false);
    gl.uniform3fv(renderer.color, roof);
    gl.uniform3fv(renderer.tint, [1, 1, 1]);
    gl.bindVertexArray(part.roofs.vao);
    gl.drawArrays(gl.TRIANGLES, 0, part.roofs.count);
    if (part.details?.count) {
      gl.uniform3fv(renderer.color, roof.map(v => v * 0.73));
      gl.bindVertexArray(part.details.vao);
      gl.drawArrays(gl.TRIANGLES, 0, part.details.count);
    }
  }
  gl.bindVertexArray(null);
}

function requestDraw() {
  if (!pendingFrame) {
    pendingFrame = true;
    requestAnimationFrame(draw);
  }
}

const zoomLimits = () => mode === "toronto" ? [2.5, 13000] : [2.5, 1000];
function localPointer(event) {
  const r = canvas.getBoundingClientRect();
  return { x: event.clientX - r.left, y: event.clientY - r.top,
    width: r.width, height: r.height };
}
function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
  const [minimum, maximum] = zoomLimits();
  let nextDistance = clamp(distance * factor, minimum, maximum);
  if (nextDistance === distance) return;
  const before = cameraTarget;
  const nextTargetAt = d => zoomAt(before, yaw, tilt, distance, d,
    x, y, canvas.clientWidth, canvas.clientHeight, activeBuildings);
  let nextTarget = nextTargetAt(nextDistance);
  // Don't wheel straight through a facade when inspecting from the outside.
  if (nextDistance < distance &&
      !cameraInsideBuildings(cameraEye(before, yaw, tilt, distance), activeBuildings) &&
      cameraInsideBuildings(cameraEye(nextTarget, yaw, tilt, nextDistance), activeBuildings)) {
    let unsafe = nextDistance, safe = distance;
    for (let i = 0; i < 12; i++) {
      const mid = (safe + unsafe) / 2;
      const midTarget = nextTargetAt(mid);
      if (cameraInsideBuildings(cameraEye(midTarget, yaw, tilt, mid), activeBuildings)) unsafe = mid;
      else safe = mid;
    }
    nextDistance = safe;
    nextTarget = nextTargetAt(nextDistance);
  }
  cameraTarget = nextTarget;
  distance = nextDistance;
  requestDraw();
}
// Pointer Events give touch, pen and mouse the same canvas coordinates.
function focusAt(x, y) {
  const hit = hitBuildings(screenRay(x, y, canvas.clientWidth, canvas.clientHeight,
    cameraTarget, yaw, tilt, distance), activeBuildings);
  if (!hit) return;
  cameraTarget = hit;
  distance = Math.max(12, Math.min(distance * 0.38, 80));
  requestDraw();
}
function twoFingerState() {
  const pair = [...activePointers.values()].slice(0, 2);
  const x = (pair[0].x + pair[1].x) * 0.5, y = (pair[0].y + pair[1].y) * 0.5;
  return { x, y, span: Math.hypot(pair[1].x-pair[0].x, pair[1].y-pair[0].y) };
}
canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("pointerdown", event => {
  if (event.pointerType !== "touch" && ![0,1,2].includes(event.button)) return;
  const pos = localPointer(event);
  activePointers.set(event.pointerId, { ...pos, type: event.pointerType,
    pan: event.pointerType !== "touch" && (event.button === 2 || event.button === 1 || event.shiftKey),
    moved: false, downX: pos.x, downY: pos.y });
  canvas.setPointerCapture(event.pointerId);
  lastTouchGesture = activePointers.size === 2 ? twoFingerState() : null;
});
canvas.addEventListener("pointermove", event => {
  const p = activePointers.get(event.pointerId);
  if (!p) return;
  const next = localPointer(event);
  if (Math.hypot(next.x-p.downX, next.y-p.downY) > 8) p.moved = true;
  if (activePointers.size >= 2) {
    p.x = next.x; p.y = next.y;
    const gesture = twoFingerState();
    if (lastTouchGesture) {
      cameraTarget = panOnPlane(cameraTarget, yaw, tilt, distance,
        lastTouchGesture.x, lastTouchGesture.y, gesture.x, gesture.y, next.width, next.height);
      if (gesture.span > 3 && lastTouchGesture.span > 3)
        zoom(lastTouchGesture.span / gesture.span, gesture.x, gesture.y);
      requestDraw();
    }
    lastTouchGesture = gesture;
    return;
  }
  if (p.pan) {
    cameraTarget = panOnPlane(cameraTarget, yaw, tilt, distance,
      p.x, p.y, next.x, next.y, next.width, next.height);
  } else {
    yaw += (next.x-p.x)*0.008;
    tilt = clamp(tilt + (next.y-p.y)*0.007, 0.16, 1.48);
  }
  p.x = next.x; p.y = next.y;
  requestDraw();
});
function finishPointer(event, cancelled = false) {
  const p = activePointers.get(event.pointerId);
  if (!p) return;
  const wasSingle = activePointers.size === 1;
  activePointers.delete(event.pointerId);
  lastTouchGesture = activePointers.size === 2 ? twoFingerState() : null;
  if (!cancelled && event.pointerType === "touch" && wasSingle && !p.moved) {
    const now = performance.now();
    const pos = localPointer(event);
    if (lastTap && now-lastTap.time < 320 && Math.hypot(pos.x-lastTap.x,pos.y-lastTap.y) < 30) {
      focusAt(pos.x,pos.y);
      lastTap = null;
    } else lastTap = { time: now, x: pos.x, y: pos.y };
  }
}
canvas.addEventListener("pointerup", event => finishPointer(event));
canvas.addEventListener("pointercancel", event => finishPointer(event,true));
canvas.addEventListener("dblclick", event => {
  event.preventDefault();
  const {x,y} = localPointer(event);
  focusAt(x,y);
});
canvas.addEventListener("wheel", event => {
  event.preventDefault();
  const pos = localPointer(event);
  // Trackpad and mouse wheel both zoom toward the selected roof, wall or ground.
  const scroll = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * canvas.clientHeight : event.deltaY;
  zoom(Math.exp(clamp(scroll * 0.001, -0.9, 0.9)), pos.x, pos.y);
}, { passive: false });
zoomInButton.addEventListener("click", () => zoom(0.65));
zoomOutButton.addEventListener("click", () => zoom(1.55));

texturesButton.addEventListener("click", () => {
  textureMode = !textureMode;
  texturesButton.textContent = textureMode ? "Textures on" : "Textures off";
  texturesButton.setAttribute("aria-pressed", String(textureMode));
  requestDraw();
});
panelToggle.addEventListener("click", () => {
  const expanded = panelToggle.closest("aside").classList.toggle("expanded");
  panelToggle.setAttribute("aria-expanded", String(expanded));
  panelToggle.textContent = expanded ? "Hide controls" : "Controls";
});
detailsButton.addEventListener("click", () => {
  architectureMode = !architectureMode;
  detailsButton.textContent = architectureMode ? "Architecture on" : "Architecture off";
  detailsButton.setAttribute("aria-pressed", String(architectureMode));
  requestDraw();
});
streetsButton.addEventListener("click", () => {
  streetsMode = !streetsMode;
  streetsButton.textContent = streetsMode ? "Streets on" : "Streets off";
  streetsButton.setAttribute("aria-pressed", String(streetsMode));
  replaceGround();
  if (streetsMode && mode === "toronto") loadStreets();
});
resetButton.addEventListener("click", () => {
  const camera = mode === "toronto" ? torontoCamera : sampleCamera;
  yaw = camera.yaw;
  tilt = camera.tilt;
  distance = camera.distance;
  cameraTarget = camera.target;
  requestDraw();
});
torontoButton.addEventListener("click", () => {
  requestedMode = "toronto";
  if (torontoData) showToronto();
  else loadToronto();
});
samplesButton.addEventListener("click", () => {
  requestedMode = "samples";
  showSamples();
});
new ResizeObserver(requestDraw).observe(canvas);

async function start() {
  if (!gl) throw new Error("WebGL2 is unavailable");
  const program = createProgram();
  const mesh = createBuildingMesh();
  const position = gl.getAttribLocation(program, "position");
  const uv = gl.getAttribLocation(program, "uv");
  const normal = gl.getAttribLocation(program, "normal");
  const parts = new Map();
  for (const [name, entry] of mesh) {
    if (entry.walls.length === 0) continue;
    parts.set(name, { walls: makeBuffer(entry.walls, position, uv, normal),
      roofs: makeBuffer(entry.roofs, position, uv, normal),
      details: makeBuffer(entry.details || [], position, uv, normal) });
  }
  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  const names = [...parts.keys()];
  activeBuildings = sampleFootprints();
  sceneRadius = radiusForBuildings(activeBuildings);
  renderer = {
    program, parts, blank, textures: new Map(),
    viewProjection: gl.getUniformLocation(program, "viewProjection"),
    color: gl.getUniformLocation(program, "color"),
    tint: gl.getUniformLocation(program, "tint"),
    useImage: gl.getUniformLocation(program, "useImage"),
    facade: gl.getUniformLocation(program, "facade"),
    useArchitecture: gl.getUniformLocation(program, "useArchitecture"),
    wallStyle: gl.getUniformLocation(program, "wallStyle"),
    masonry: gl.getUniformLocation(program, "masonry"),
    frameColor: gl.getUniformLocation(program, "frameColor"),
    moduleSize: gl.getUniformLocation(program, "moduleSize"),
  };
  replaceGround();
  requestDraw();
  const loaded = await Promise.all(names.map(name => loadTexture(name, blank)));
  renderer.textures = new Map(loaded.map(value => [value.name, value]));
  const readyCount = loaded.filter(value => value.ok).length;
  const stats = sceneStats();
  sampleStatus = `${stats.buildings} sample buildings · ${stats.wallTriangles} wall triangles · ${stats.roofTriangles} roof triangles\n${readyCount}/${names.length} material textures loaded\nAll meshes built once; moving the camera never rebuilds them.`;
  status.textContent = sampleStatus;
  requestDraw();
  window.__kmBuildingDemo = { gl, renderer, sceneStats, draw,
    getCamera: () => ({ yaw, tilt, distance, target: cameraTarget, mode }),
    getBuildingStats: () => renderer.stats,
    getDataStatus: () => ({ mode, toronto: Boolean(torontoData), requestedMode, streets: streetStatus, architectureMode }),
    zoom, setCamera: (next) => {
      if (Number.isFinite(next?.yaw)) yaw = next.yaw;
      if (Number.isFinite(next?.tilt)) tilt = clamp(next.tilt, .16, 1.48);
      if (Number.isFinite(next?.distance)) distance = clamp(next.distance, ...zoomLimits());
      if (Array.isArray(next?.target) && next.target.length === 3 && next.target.every(Number.isFinite)) cameraTarget = next.target.slice();
      requestDraw();
    },
  };
  loadToronto();
}

start().catch(error => {
  status.textContent = `Renderer error: ${error.message}`;
  console.error(error);
});
