const MATERIALS = ["glass", "brick", "concrete", "stone", "metal", "wood", "plaster", "default"];
const ROOF_MATERIALS = MATERIALS.map(name => `roof-${name}`);
const DRAW_MATERIALS = [...MATERIALS, ...ROOF_MATERIALS];
const ROOF_COLOURS = {
  glass: [174, 184, 189], brick: [170, 155, 145], concrete: [185, 184, 180],
  stone: [198, 188, 174], metal: [172, 181, 185], wood: [184, 169, 147],
  plaster: [205, 197, 186], default: [184, 180, 170],
};
const EARTH_METERS = 40075016.68557849;
const MIN_DETAIL_ZOOM = 14.8;
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
  const meters = Math.max(1400, Math.min(3200, 1800 * 2 ** ((zoom - 15.5) * 0.25)));
  return tier === "low" ? meters * 0.75 : meters;
}

function polygonDistance(ring, center) {
  const latScale = 111320;
  const lonScale = latScale * Math.cos(center[1] * Math.PI / 180);
  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const ay = (a[1] - center[1]) * latScale;
    const by = (b[1] - center[1]) * latScale;
    const ax = (a[0] - center[0]) * lonScale;
    const bx = (b[0] - center[0]) * lonScale;
    if ((ay > 0) !== (by > 0) && 0 < ax + (bx - ax) * (0 - ay) / (by - ay)) inside = !inside;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    nearest = Math.min(nearest, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return inside ? 0 : nearest;
}

function triangulate(points) {
  const size = points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]
    ? points.length - 1 : points.length;
  if (size < 3) return [];
  const centre = points.slice(0, size).reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
  centre[0] /= size; centre[1] /= size;
  const shape = points.slice(0, size).map(([x, y]) => [(x - centre[0]) * 1e7, (y - centre[1]) * 1e7]);
  const order = shape.map((_, i) => i);
  let area = 0;
  for (let i = 0; i < size; i++) {
    const a = shape[i], b = shape[(i + 1) % size];
    area += a[0] * b[1] - a[1] * b[0];
  }
  if (Math.abs(area) < 1e-10) return [];
  const sign = Math.sign(area);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const triangles = [];
  for (let tries = 0; order.length > 3 && tries < size * size; tries++) {
    let found = false;
    for (let i = 0; i < order.length; i++) {
      const a = order[(i + order.length - 1) % order.length];
      const b = order[i];
      const c = order[(i + 1) % order.length];
      if (sign * cross(shape[a], shape[b], shape[c]) <= 1e-8) continue;
      let contains = false;
      for (const other of order) {
        if (other === a || other === b || other === c) continue;
        const p = shape[other];
        if (sign * cross(shape[a], shape[b], p) >= -1e-8 &&
            sign * cross(shape[b], shape[c], p) >= -1e-8 &&
            sign * cross(shape[c], shape[a], p) >= -1e-8) {
          contains = true; break;
        }
      }
      if (contains) continue;
      triangles.push([a, b, c]);
      order.splice(i, 1);
      found = true;
      break;
    }
    if (!found) break;
  }
  if (order.length === 3) triangles.push([order[0], order[1], order[2]]);
  return triangles;
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
  const buckets = Object.fromEntries(DRAW_MATERIALS.map(name => [name, []]));
  if (!range) return { buckets, count: 0, range: 0, vertices: 0, coveredRadius: 0 };
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
    const height = Math.max(3, number(properties.render_height ?? properties.height, 12));
    const base = Math.max(0, number(properties.render_min_height ?? properties.min_height, 0));
    if (height - base < 3 || height > 950) continue;
    for (const poly of rings) {
      const ring = poly?.[0];
      if (!ring || ring.length < 4 || ring.length > 150) continue;
      const minX = Math.min(...ring.map(item => item[0]));
      const maxX = Math.max(...ring.map(item => item[0]));
      const minY = Math.min(...ring.map(item => item[1]));
      const maxY = Math.max(...ring.map(item => item[1]));
      const middle = [(minX + maxX) / 2, (minY + maxY) / 2];
      const distance = polygonDistance(ring, center);
      if (distance > range + 120) continue;
      const key = `${Math.round(minX * 1e6)}:${Math.round(minY * 1e6)}:${Math.round(maxX * 1e6)}:${Math.round(maxY * 1e6)}:${Math.round(height * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ring, properties, height, base, distance, middle });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  // all buildings inside this circle have to be in the mesh too
  const selected = candidates.slice(0, maxBuildings);
  const coveredRadius = selected.length
    ? Math.min(range, Math.max(50, selected[selected.length - 1].distance - 8)) : 0;
  for (const item of selected) {
    if (item.distance > coveredRadius) continue;
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
      const offset = scale * 0.38 / edgeUnits;
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
    // roofs go through this same layer, so theres no second wall fighting depth
    const roof = buckets[`roof-${material}`];
    const faces = triangulate(points);
    const roofZ = (height + ground) * scale;
    for (const [a, b, c] of faces) {
      for (const index of [a, b, c]) {
        roof.push(points[index][0], points[index][1], roofZ, 0, 0);
      }
      vertices += 3;
    }
    count++;
  }
  return { buckets, count, range, vertices, coveredRadius };
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
  void main() {
    v_uv = a_uv;
    gl_Position = u_matrix * vec4(a_pos, 1.0);
  }`);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_image;
  out vec4 color;
  void main() {
    vec3 sampleColor = texture(u_image, v_uv).rgb;
    color = vec4(sampleColor, 1.0);
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
  let hasWalls = false;
  let lastError = null;
  const textures = new Map();
  const buffers = new Map();
  const positions = new Map();
  let loadVersion = 0;
  let lastRefresh = 0;
  let waitingForTiles = false;
  let lastTileRetry = 0;
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
      catch (error) { lastError = String(error?.message || error); onStatus("error", lastError); return; }
      const stamp = ++loadVersion;
      const base = String(import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
      onStatus("loading");
      Promise.all(MATERIALS.map(async name => {
        const { data } = await map.loadImage(`${base}textures/buildings/${name}.png?v=10.17.1`);
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
          for (const name of MATERIALS) {
            const roof = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, roof);
            const rgba = Uint8Array.from([...ROOF_COLOURS[name], 255]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            textures.set(`roof-${name}`, roof);
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
          ready = true;
          onStatus("waiting");
          refresh(true);
          map.triggerRepaint();
        } catch (error) { lastError = String(error?.message || error); onStatus("error", lastError); }
      }).catch(error => { if (active && stamp === loadVersion) { lastError = String(error?.message || error); onStatus("error", lastError); } });
      map.on("moveend", changed);
      map.on("idle", idle);
    },
    render(context, args) {
      if (!active || !ready || !hasWalls || !gpuProgram || !buffers.size) return;
      if (map.getProjection?.()?.type === "globe") return;
      const matrix = args?.defaultProjectionData?.mainMatrix;
      if (!matrix) {
        if (lastError !== "Map projection matrix unavailable") {
          lastError = "Map projection matrix unavailable";
          onStatus("error", lastError);
        }
        return;
      }
      if (context.isContextLost?.()) return;
      const previous = {
        blend: context.isEnabled(context.BLEND),
        cull: context.isEnabled(context.CULL_FACE),
        depth: context.isEnabled(context.DEPTH_TEST),
        depthMask: context.getParameter(context.DEPTH_WRITEMASK),
        depthFunc: context.getParameter(context.DEPTH_FUNC),
        program: context.getParameter(context.CURRENT_PROGRAM),
        vao: context.getParameter(context.VERTEX_ARRAY_BINDING),
        arrayBuffer: context.getParameter(context.ARRAY_BUFFER_BINDING),
        activeTexture: context.getParameter(context.ACTIVE_TEXTURE),
        blendSrcRGB: context.getParameter(context.BLEND_SRC_RGB),
        blendDstRGB: context.getParameter(context.BLEND_DST_RGB),
        blendSrcAlpha: context.getParameter(context.BLEND_SRC_ALPHA),
        blendDstAlpha: context.getParameter(context.BLEND_DST_ALPHA),
      };
      context.activeTexture(context.TEXTURE0);
      previous.texture0 = context.getParameter(context.TEXTURE_BINDING_2D);
      const currentZoom = map.getZoom();
      try {
        context.useProgram(gpuProgram);
        context.bindVertexArray(vao);
        context.depthFunc(context.LEQUAL);
        context.uniformMatrix4fv(context.getUniformLocation(gpuProgram, "u_matrix"), false, matrix);
        context.uniform1i(context.getUniformLocation(gpuProgram, "u_image"), 0);
        context.enable(context.DEPTH_TEST);
        // walls and roofs now own the depth, so they should hide each other properly
        context.depthMask(true);
        context.disable(context.CULL_FACE);
        context.disable(context.BLEND);
        context.activeTexture(context.TEXTURE0);
        for (const name of DRAW_MATERIALS) {
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
      } catch (error) {
        lastError = String(error?.message || error);
        onStatus("error", lastError);
      } finally {
        context.bindBuffer(context.ARRAY_BUFFER, previous.arrayBuffer);
        context.bindVertexArray(previous.vao);
        context.depthMask(previous.depthMask);
        context.depthFunc(previous.depthFunc);
        if (previous.depth) context.enable(context.DEPTH_TEST);
        else context.disable(context.DEPTH_TEST);
        if (previous.cull) context.enable(context.CULL_FACE);
        else context.disable(context.CULL_FACE);
        if (previous.blend) context.enable(context.BLEND);
        else context.disable(context.BLEND);
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, previous.texture0);
        context.activeTexture(previous.activeTexture);
        context.blendFuncSeparate(previous.blendSrcRGB, previous.blendDstRGB, previous.blendSrcAlpha, previous.blendDstAlpha);
        context.useProgram(previous.program);
      }
      if (map && stats.vertices > 0) {
        map.__kmFacadeStats = { ...stats, drawn: true, textureCount: textures.size, zoom: currentZoom, error: lastError };
      }
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
      hasWalls = false;
      if (map) {
        map.__kmFacadeStats = null;
        map.__kmFacadeSnapshot = null;
      }
      map = null;
    },
  };
  function changed() { refresh(false); }
  function idle() {
    if (map?.isMoving?.()) return;
    const now = performance.now();
    if (waitingForTiles ? now - lastTileRetry > 400 : !lastView || now - lastRefresh > 10000) refresh(false);
  }
  function refresh(force) {
    if (!active || !ready || !map || !map.isStyleLoaded() || pending || map.isMoving?.()) return;
    if (map.getProjection?.()?.type === "globe") return;
    const zoom = map.getZoom();
    const focus = map.getCenter();
    const center = [focus.lng, focus.lat];
    const now = performance.now();
    const movement = lastView ? meters(center, lastView.center) : Infinity;
    if (!force && !waitingForTiles && lastView && movement < 75 && Math.abs(lastView.zoom - zoom) < 0.2 && now - lastRefresh < 10000) return;
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
    if (!features?.length) {
      waitingForTiles = true;
      lastTileRetry = now;
      // new tiles are still loading. keep the old walls + matching roof mask
      // until we have actual geometry to replace both together
      map.__kmFacadeStats = { ...stats, textureCount: textures.size,
        reason: hasWalls ? "keeping walls while tiles load" : "waiting for building tiles" };
      if (!hasWalls) onStatus("waiting");
      return;
    }
    pending = true;
    try {
      const groundAt = point => map.getTerrain?.() ? map.queryTerrainElevation?.(point, { exaggerated: true }) || 0 : 0;
      const mesh = makeFacadeMesh(features, center, zoom, tier, groundAt);
      for (const name of DRAW_MATERIALS) {
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
      const hadWalls = hasWalls;
      hasWalls = mesh.vertices > 0;
      stats = { count: mesh.count, vertices: mesh.vertices, range: mesh.range, coveredRadius: mesh.coveredRadius, textureCount: textures.size };
      map.__kmFacadeStats = stats;
      // only change the cap after its exact matching wall buffers are uploaded
      map.__kmFacadeSnapshot = hasWalls ? { center, coveredRadius: mesh.coveredRadius } : null;
      if (hasWalls !== hadWalls || force || mesh.coveredRadius !== lastView?.coveredRadius ||
          meters(center, lastView?.center || center) > 10) {
        onStatus(hasWalls ? "ready" : "waiting");
      }
      lastView = { center, zoom, coveredRadius: mesh.coveredRadius };
      lastRefresh = now;
      waitingForTiles = false;
      map.triggerRepaint();
    } catch (error) { lastError = String(error?.message || error); onStatus("error", lastError); }
    finally { pending = false; }
  }
  return layer;
}
