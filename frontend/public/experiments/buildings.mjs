import { buildings as sampleBuildings, createBuildingMesh, sceneStats, createPolygonBuildingMesh, convertTorontoGeoJSON, polygonSceneStats } from "./buildingMesh.mjs";
import { FOV, clamp, cameraEye, screenRay, hitBuildings, zoomAt, panOnPlane, clippingPlanes, cameraInsideBuildings } from "./cameraMath.mjs";

const canvas = document.querySelector("#scene");
const status = document.querySelector("#status");
const texturesButton = document.querySelector("#textures");
const resetButton = document.querySelector("#reset");
const zoomInButton = document.querySelector("#zoom-in");
const zoomOutButton = document.querySelector("#zoom-out");
const torontoButton = document.querySelector("#toronto");
const samplesButton = document.querySelector("#samples");
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
  out vec4 outputColor;
  void main() {
    vec3 surface = (useImage ? texture(facade, sampleUV).rgb : color) * tint;
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
function appearance(name) {
  const [base, raw] = name.split(":");
  const variant = Math.max(0, Math.min(4, Number(raw) || 0));
  return { base, tint: facadeTints[variant], roof: roofPalette[base].map(v => v * roofTints[variant]) };
}

let yaw = -0.62;
let tilt = 0.65;
let distance = 260;
let textureMode = true;
let pointer;
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
  status.textContent = torontoStatus;
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
      torontoStatus = `${stats.buildings} Toronto building polygons · ${stats.wallTriangles} wall triangles · ${stats.roofTriangles} roof triangles\n${parsed.recordedHeights} recorded heights · ${parsed.estimatedHeights} estimated at 12 m${parsed.skippedHoles ? ` · ${parsed.skippedHoles} courtyard footprints simplified` : ""}\nIllustrative façade mixes, stable per-building tints, and roof colours. Materials are not surveyed. Camera movement never rebuilds geometry.`;
      if (requestedMode === "toronto") showToronto();
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
  for (const [name, part] of renderer.parts) {
    const { base, tint, roof } = appearance(name);
    const chosen = renderer.textures.get(base);
    gl.uniform3fv(renderer.color, palette[base]);
    gl.uniform3fv(renderer.tint, tint);
    gl.uniform1i(renderer.useImage, Boolean(textureMode && chosen?.ok));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, chosen?.texture || renderer.blank);
    gl.uniform1i(renderer.facade, 0);
    gl.bindVertexArray(part.walls.vao);
    gl.drawArrays(gl.TRIANGLES, 0, part.walls.count);
    gl.uniform1i(renderer.useImage, false);
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
canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("pointerdown", event => {
  if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
  const pos = localPointer(event);
  pointer = { x: pos.x, y: pos.y, id: event.pointerId,
    pan: event.button === 2 || event.button === 1 || event.shiftKey };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const pos = localPointer(event);
  if (pointer.pan) {
    cameraTarget = panOnPlane(cameraTarget, yaw, tilt, distance,
      pointer.x, pointer.y, pos.x, pos.y, pos.width, pos.height);
  } else {
    yaw += (pos.x - pointer.x) * 0.008;
    tilt = clamp(tilt + (pos.y - pointer.y) * 0.007, 0.16, 1.48);
  }
  pointer.x = pos.x;
  pointer.y = pos.y;
  requestDraw();
});
canvas.addEventListener("pointerup", () => { pointer = null; });
canvas.addEventListener("pointercancel", () => { pointer = null; });
canvas.addEventListener("dblclick", event => {
  event.preventDefault();
  const { x, y, width, height } = localPointer(event);
  const hit = hitBuildings(screenRay(x, y, width, height, cameraTarget, yaw, tilt, distance), activeBuildings);
  if (!hit) return;
  cameraTarget = hit;
  distance = Math.max(12, Math.min(distance * 0.38, 80));
  requestDraw();
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
  };
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
    getDataStatus: () => ({ mode, toronto: Boolean(torontoData), requestedMode }),
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
