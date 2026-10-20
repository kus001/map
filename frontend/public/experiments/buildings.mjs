import { createBuildingMesh, sceneStats } from "./buildingMesh.mjs";

const canvas = document.querySelector("#scene");
const status = document.querySelector("#status");
const texturesButton = document.querySelector("#textures");
const resetButton = document.querySelector("#reset");
const gl = canvas.getContext("webgl2", { antialias: true, depth: true, alpha: false });

const vertexShader = `#version 300 es
  in vec3 position;
  in vec2 uv;
  in vec3 normal;
  uniform mat4 viewProjection;
  out vec2 sampleUV;
  out float brightness;
  void main() {
    sampleUV = uv;
    brightness = 0.65 + 0.35 * max(dot(normalize(normal), normalize(vec3(0.35, 0.95, 0.5))), 0.0);
    gl_Position = viewProjection * vec4(position, 1.0);
  }
`;
const fragmentShader = `#version 300 es
  precision highp float;
  in vec2 sampleUV;
  in float brightness;
  uniform sampler2D facade;
  uniform vec3 color;
  uniform bool useImage;
  out vec4 outputColor;
  void main() {
    vec3 shade = useImage ? texture(facade, sampleUV).rgb : color;
    outputColor = vec4(shade * brightness, 1.0);
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
  return { vao, count: array.length / 8 };
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

let yaw = -0.62;
let tilt = 0.65;
let distance = 260;
let textureMode = true;
let pointer;
let pendingFrame = false;
let renderer;

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
  const target = [10, 18, 0];
  const horizontal = Math.cos(tilt) * distance;
  const eye = [target[0] + horizontal * Math.sin(yaw), target[1] + distance * Math.sin(tilt), target[2] + horizontal * Math.cos(yaw)];
  const matrix = multiply(perspective(Math.PI / 3, canvas.width / canvas.height, 0.5, 1500), lookAt(eye, target));
  gl.uniformMatrix4fv(renderer.viewProjection, false, matrix);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  for (const [name, part] of renderer.parts) {
    const chosen = renderer.textures.get(name);
    const color = palette[name];
    gl.uniform3fv(renderer.color, color);
    gl.uniform1i(renderer.useImage, Boolean(textureMode && chosen?.ok));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, chosen?.texture || renderer.blank);
    gl.uniform1i(renderer.facade, 0);
    gl.bindVertexArray(part.walls.vao);
    gl.drawArrays(gl.TRIANGLES, 0, part.walls.count);
    gl.uniform1i(renderer.useImage, false);
    gl.uniform3fv(renderer.color, [0.75, 0.72, 0.66]);
    gl.bindVertexArray(part.roofs.vao);
    gl.drawArrays(gl.TRIANGLES, 0, part.roofs.count);
  }
  gl.bindVertexArray(null);
}

function requestDraw() {
  if (!pendingFrame) {
    pendingFrame = true;
    requestAnimationFrame(draw);
  }
}

canvas.addEventListener("pointerdown", event => {
  pointer = { x: event.clientX, y: event.clientY, id: event.pointerId };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  yaw += (event.clientX - pointer.x) * 0.008;
  tilt = Math.max(0.12, Math.min(1.48, tilt + (event.clientY - pointer.y) * 0.007));
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  requestDraw();
});
canvas.addEventListener("pointerup", () => { pointer = null; });
canvas.addEventListener("pointercancel", () => { pointer = null; });
canvas.addEventListener("wheel", event => {
  event.preventDefault();
  distance = Math.max(90, Math.min(700, distance * Math.exp(event.deltaY * 0.001)));
  requestDraw();
}, { passive: false });
texturesButton.addEventListener("click", () => {
  textureMode = !textureMode;
  texturesButton.textContent = textureMode ? "Textures on" : "Textures off";
  texturesButton.setAttribute("aria-pressed", String(textureMode));
  requestDraw();
});
resetButton.addEventListener("click", () => {
  yaw = -0.62;
  tilt = 0.65;
  distance = 260;
  requestDraw();
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
    parts.set(name, { walls: makeBuffer(entry.walls, position, uv, normal), roofs: makeBuffer(entry.roofs, position, uv, normal) });
  }
  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  const names = [...parts.keys()];
  renderer = {
    program, parts, blank, textures: new Map(),
    viewProjection: gl.getUniformLocation(program, "viewProjection"),
    color: gl.getUniformLocation(program, "color"),
    useImage: gl.getUniformLocation(program, "useImage"),
    facade: gl.getUniformLocation(program, "facade"),
  };
  requestDraw();
  const loaded = await Promise.all(names.map(name => loadTexture(name, blank)));
  renderer.textures = new Map(loaded.map(value => [value.name, value]));
  const readyCount = loaded.filter(value => value.ok).length;
  const stats = sceneStats();
  status.textContent = `${stats.buildings} sample buildings · ${stats.wallTriangles} wall triangles · ${stats.roofTriangles} roof triangles\n${readyCount}/${names.length} material textures loaded\nAll meshes built once; moving the camera never rebuilds them.`;
  requestDraw();
  window.__kmBuildingDemo = { gl, renderer, sceneStats, draw, getCamera: () => ({ yaw, tilt, distance }) };
}

start().catch(error => {
  status.textContent = `Renderer error: ${error.message}`;
  console.error(error);
});
