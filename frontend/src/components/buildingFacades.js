const MATERIALS = ["glass", "brick", "concrete", "stone", "metal", "wood", "plaster", "default"];
const EARTH_METERS = 40075016.68557849;
const MIN_DETAIL_ZOOM = 16;
const TILE_LIMIT = 450;

export function facadeMaterial(properties = {}) {
  const name = String(properties.render_material ?? properties["building:material"] ?? properties.material ?? "").toLowerCase();
  if (name.includes("glass")) return "glass";
  if (name.includes("brick")) return "brick";
  if (name.includes("concrete") || name.includes("cement")) return "concrete";
  if (name.includes("stone") || name.includes("limestone") || name.includes("granite")) return "stone";
  if (name.includes("metal") || name.includes("steel") || name.includes("aluminium")) return "metal";
  if (name.includes("wood") || name.includes("timber")) return "wood";
  if (name.includes("plaster") || name.includes("stucco")) return "plaster";
  return "default";
}

export function facadeRange(zoom, tier = "medium") {
  if (zoom < MIN_DETAIL_ZOOM) return 0;
  const meters = Math.max(230, Math.min(780, 420 * 2 ** (zoom - 16)));
  return tier === "low" ? meters * 0.65 : meters;
}

function meters(point, center) {
  const dLng = (point[0] - center[0]) * Math.cos(center[1] * Math.PI / 180);
  const dLat = point[1] - center[1];
  return Math.hypot(dLng, dLat) * 111320;
}

function mercator(point) {
  const lat = Math.max(-85, Math.min(85, point[1])) * Math.PI / 180;
  return [
    (point[0] + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2,
  ];
}

function number(value, fallback) {
  const result = Number.parseFloat(value);
  return Number.isFinite(result) ? result : fallback;
}

export function makeFacadeMesh(features, center, zoom, tier = "medium", terrainHeight = () => 0) {
  const range = facadeRange(zoom, tier);
  const buckets = Object.fromEntries(MATERIALS.map(name => [name, []]));
  if (!range) return { buckets, count: 0, range: 0, vertices: 0 };
  const seen = new Set();
  let count = 0;
  let vertices = 0;
  const maxBuildings = tier === "low" ? 120 : tier === "medium" ? 260 : TILE_LIMIT;
  const candidates = [];
  for (const feature of features || []) {
    const geometry = feature?.geometry;
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) continue;
    const rings = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const properties = feature.properties || {};
    if (properties.hide_3d === true) continue;
    const height = Math.max(0, number(properties.render_height ?? properties.height, number(properties["building:levels"], 4) * 3));
    const base = Math.max(0, number(properties.render_min_height ?? properties.min_height, 0));
    if (height - base < 7 || height > 950) continue;
    for (const poly of rings) {
      const ring = poly?.[0];
      if (!ring || ring.length < 4 || ring.length > 150) continue;
      const minX = Math.min(...ring.map(item => item[0]));
      const maxX = Math.max(...ring.map(item => item[0]));
      const minY = Math.min(...ring.map(item => item[1]));
      const maxY = Math.max(...ring.map(item => item[1]));
      const middle = [(minX + maxX) / 2, (minY + maxY) / 2];
      const distance = meters(middle, center);
      if (distance > range + 120) continue;
      const key = `${Math.round(minX * 1e6)}:${Math.round(minY * 1e6)}:${Math.round(maxX * 1e6)}:${Math.round(maxY * 1e6)}:${Math.round(height * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ring, properties, height, base, distance, middle });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  for (const item of candidates.slice(0, maxBuildings)) {
    const { ring, properties, height, base, middle } = item;
    const scale = 1 / (EARTH_METERS * Math.cos(middle[1] * Math.PI / 180));
    const ground = Number(terrainHeight(middle)) || 0;
    const material = facadeMaterial(properties);
    const verticesOut = buckets[material];
    const points = ring.map(mercator);
    let area = 0;
    for (let i = 0; i < points.length - 1; i++) {
      area += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
    }
    if (Math.abs(area) < 1e-19) continue;
    const direction = area > 0 ? 1 : -1;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const edgeUnits = Math.hypot(dx, dy);
      const length = edgeUnits / scale;
      if (length < 0.5 || length > 380) continue;
      const offset = scale * 0.12 / edgeUnits;
      const nx = direction * dy * offset;
      const ny = direction * -dx * offset;
      const x1 = a[0] + nx;
      const y1 = a[1] + ny;
      const x2 = b[0] + nx;
      const y2 = b[1] + ny;
      const z0 = (base + ground) * scale;
      const z1 = (height + ground) * scale;
      const u = length / 12;
      const v = (height - base) / 9;
      const face = [x1, y1, z0, 0, 0, x2, y2, z0, u, 0,
        x1, y1, z1, 0, v, x1, y1, z1, 0, v,
        x2, y2, z0, u, 0, x2, y2, z1, u, v];
      verticesOut.push(...face);
      vertices += 6;
    }
    count++;
  }
  return { buckets, count, range, vertices };
}

function shader(gl, kind, source) {
  const item = gl.createShader(kind);
  gl.shaderSource(item, source);
  gl.compileShader(item);
  if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(item) || "Facade shader failed";
    gl.deleteShader(item);
    throw new Error(message);
  }
  return item;
}

function program(gl) {
  const vertex = shader(gl, gl.VERTEX_SHADER, `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 a_pos;
  layout(location = 1) in vec2 a_uv;
  uniform mat4 u_matrix;
  out vec2 v_uv;
  void main() { v_uv = a_uv; gl_Position = u_matrix * vec4(a_pos, 1.0); }`);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
  precision mediump float;
  in vec2 v_uv;
  uniform sampler2D u_image;
  out vec4 color;
  void main() {
    vec3 sampleColor = texture(u_image, v_uv).rgb;
    color = vec4(min(vec3(1.0), sampleColor * 1.17), 1.0);
  }`);
  const result = gl.createProgram();
  gl.attachShader(result, vertex);
  gl.attachShader(result, fragment);
  gl.linkProgram(result);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(result) || "Facade program failed";
    gl.deleteProgram(result);
    throw new Error(message);
  }
  return result;
}

export function createFacadeLayer(tier = "medium", onStatus = () => {}) {
  let map;
  let gl;
  let active = false;
  let gpuProgram;
  let vao;
  let pending = false;
  let lastView;
  let ready = false;
  const textures = new Map();
  const buffers = new Map();
  const positions = new Map();
  let loadVersion = 0;
  let lastRefresh = 0;
  let stats = { count: 0, vertices: 0, range: 0 };
  const layer = {
    id: "km-textured-facades",
    type: "custom",
    renderingMode: "3d",
    onAdd(currentMap, context) {
      map = currentMap;
      gl = context;
      active = true;
      try { gpuProgram = program(gl); vao = gl.createVertexArray(); }
      catch (error) { onStatus("error", String(error?.message || error)); return; }
      const stamp = ++loadVersion;
      const base = String(import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
      onStatus("loading");
      Promise.all(MATERIALS.map(async name => {
        const { data } = await map.loadImage(`${base}textures/buildings/${name}.png?v=10.16.3`);
        if (!data || data.width !== 512 || data.height !== 512) {
          throw new Error(`Invalid image ${name}.png (expected 512×512)`);
        }
        return [name, data];
      })).then(images => {
        if (!active || stamp !== loadVersion) return;
        try {
          for (const [name, data] of images) {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
            textures.set(name, texture);
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
          ready = true;
          onStatus("ready");
          refresh(true);
          map.triggerRepaint();
        } catch (error) { onStatus("error", String(error?.message || error)); }
      }).catch(error => { if (active && stamp === loadVersion) onStatus("error", String(error?.message || error)); });
      map.on("moveend", changed);
      map.on("idle", idle);
    },
    render(context, args) {
      if (!active || !ready || !gpuProgram || !buffers.size || map.getZoom() < MIN_DETAIL_ZOOM) return;
      if (map.getProjection?.()?.type === "globe") return;
      const matrix = args?.defaultProjectionData?.mainMatrix;
      if (!matrix) return;
      context.useProgram(gpuProgram);
      context.bindVertexArray(vao);
      context.depthFunc(context.LEQUAL);
      context.uniformMatrix4fv(context.getUniformLocation(gpuProgram, "u_matrix"), false, matrix);
      context.uniform1i(context.getUniformLocation(gpuProgram, "u_image"), 0);
      context.enable(context.DEPTH_TEST);
      context.depthMask(false);
      context.disable(context.CULL_FACE);
      context.disable(context.BLEND);
      context.activeTexture(context.TEXTURE0);
      for (const name of MATERIALS) {
        const buffer = buffers.get(name);
        const amount = positions.get(name);
        if (!buffer || !amount) continue;
        context.bindTexture(context.TEXTURE_2D, textures.get(name));
        context.bindBuffer(context.ARRAY_BUFFER, buffer);
        context.enableVertexAttribArray(0);
        context.vertexAttribPointer(0, 3, context.FLOAT, false, 20, 0);
        context.enableVertexAttribArray(1);
        context.vertexAttribPointer(1, 2, context.FLOAT, false, 20, 12);
        context.drawArrays(context.TRIANGLES, 0, amount);
      }
      context.bindBuffer(context.ARRAY_BUFFER, null);
      context.bindTexture(context.TEXTURE_2D, null);
      context.depthMask(true);
      context.bindVertexArray(null);
    },
    onRemove() {
      active = false;
      loadVersion++;
      map?.off("moveend", changed);
      map?.off("idle", idle);
      if (gl) {
        for (const buffer of buffers.values()) gl.deleteBuffer(buffer);
        for (const texture of textures.values()) gl.deleteTexture(texture);
        if (gpuProgram) gl.deleteProgram(gpuProgram);
        if (vao) gl.deleteVertexArray(vao);
      }
      buffers.clear();
      textures.clear();
      positions.clear();
      if (map) map.__kmFacadeStats = null;
      map = null;
    },
  };
  function changed() { refresh(false); }
  function idle() {
    if (!lastView || performance.now() - lastRefresh > 10000) refresh(false);
  }
  function refresh(force) {
    if (!active || !ready || !map || !map.isStyleLoaded() || pending) return;
    if (map.getProjection?.()?.type === "globe") return;
    const zoom = map.getZoom();
    const focus = map.getCenter();
    const center = [focus.lng, focus.lat];
    const now = performance.now();
    const movement = lastView ? meters(center, lastView.center) : Infinity;
    if (!force && lastView && movement < 75 && Math.abs(lastView.zoom - zoom) < 0.2 && now - lastRefresh < 10000) return;
    const candidates = (map.getStyle()?.layers || []).filter(item => item.type === "fill-extrusion" &&
      map.getLayoutProperty(item.id, "visibility") !== "none");
    const targets = candidates.sort((a, b) => Number(b.id === "km-buildings-3d") - Number(a.id === "km-buildings-3d"));
    let features;
    for (const target of targets) {
      const source = target.source;
      if (!source || !map.isSourceLoaded(source)) continue;
      try { features = map.querySourceFeatures(source, { sourceLayer: target["source-layer"] || "building" }); }
      catch { continue; }
      if (features?.length) break;
    }
    if (!features?.length) return;
    pending = true;
    try {
      const groundAt = point => map.getTerrain?.() ? map.queryTerrainElevation?.(point, { exaggerated: true }) || 0 : 0;
      const mesh = makeFacadeMesh(features, center, zoom, tier, groundAt);
      for (const name of MATERIALS) {
        const data = mesh.buckets[name];
        const count = data.length / 5;
        if (count) {
          let buffer = buffers.get(name);
          if (!buffer) { buffer = gl.createBuffer(); buffers.set(name, buffer); }
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
        }
        positions.set(name, count);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      stats = { count: mesh.count, vertices: mesh.vertices, range: mesh.range };
      map.__kmFacadeStats = stats;
      lastView = { center, zoom };
      lastRefresh = now;
      map.triggerRepaint();
    } catch (error) { onStatus("error", String(error?.message || error)); }
    finally { pending = false; }
  }
  return layer;
}
