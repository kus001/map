const ASSET_PATH = "/models/landmarks/";

const LANDMARKS = [
  {
    id: "cn-tower",
    center: [-79.387083, 43.642556],
    height: 553.3,
    radius: 75,
    excludeRadius: 115,
    minZoom: 13.7,
    fullZoom: 16.0,
    type: "fbx",
    url: `${ASSET_PATH}cn-tower.fbx`,
  },
  {
    id: "eiffel-tower",
    center: [2.294481, 48.85837],
    height: 330,
    radius: 100,
    excludeRadius: 175,
    minZoom: 14.5,
    fullZoom: 17,
    type: "stl",
    url: "/api/landmarks/eiffel-tower.stl",
    backupUrl: "https://upload.wikimedia.org/wikipedia/commons/f/ff/Eiffel.stl",
    color: 0x826a50,
    expectedWidth: 125,
    expectedDepth: 125,
  },
  {
    id: "arc-de-triomphe",
    center: [2.29502, 48.873793],
    height: 50,
    radius: 45,
    excludeRadius: 78,
    minZoom: 14.5,
    fullZoom: 17,
    type: "stl",
    url: "/api/landmarks/arc-de-triomphe.stl",
    backupUrl: "https://upload.wikimedia.org/wikipedia/commons/e/ee/Arc_de_Triomphe.stl",
    color: 0xd4c9b5,
    expectedWidth: 44.8,
    expectedDepth: 22.0,
  },
];

let librariesPromise;
function loadLibraries() {
  if (!librariesPromise) {
    librariesPromise = Promise.all([
      import("https://esm.sh/three@0.169.0"),
      import("https://esm.sh/three@0.169.0/examples/jsm/loaders/FBXLoader.js"),
      import("https://esm.sh/three@0.169.0/examples/jsm/loaders/STLLoader.js"),
    ]).then(([three, fbx, stl]) => ({ three, FBXLoader: fbx.FBXLoader, STLLoader: stl.STLLoader }))
      .catch(error => { librariesPromise = null; throw error; });
  }
  return librariesPromise;
}

function kilometers(a, b) {
  const lat = (a[1] + b[1]) * Math.PI / 360;
  const dx = (a[0] - b[0]) * 111.3 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 111.3;
  return Math.hypot(dx, dy);
}

function updateAttribution(map, active) {
  const container = map.getContainer?.();
  const holder = container?.querySelector(".maplibregl-ctrl-attrib-inner");
  if (!holder) return;
  let credit = holder.querySelector("[data-km-arc-credit]");
  if (!active.includes("arc-de-triomphe")) {
    credit?.remove();
    return;
  }
  if (credit) return;
  credit = document.createElement("span");
  credit.dataset.kmArcCredit = "true";
  credit.append(document.createTextNode(" | Arc de Triomphe model: "));
  const link = document.createElement("a");
  link.href = "https://commons.wikimedia.org/wiki/File:Arc_de_Triomphe.stl";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Microsoft · CC BY 4.0";
  credit.append(link);
  holder.append(credit);
}

function removeLegacyLandmarks(map) {
  const oldLayers = ["km-landmark-models-3d", "km-landmark-extrusions", "km-landmark-models-layer"];
  for (const id of oldLayers) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of ["km-landmark-models", "km-landmark-geometry"]) {
    if (map.getSource(id)) {
      try { map.removeSource(id); } catch { return; }
    }
  }
}

function modelZoomScale(item, zoom) {
  if (zoom < item.minZoom) return 0;
  if (!item.fullZoom || zoom >= item.fullZoom) return 1;
  const t = Math.max(0, Math.min(1, (zoom - item.minZoom) / (item.fullZoom - item.minZoom)));
  return Math.min(1, 0.1 + 0.9 * t * t * (3 - 2 * t));
}

function landmarkNameExpression() {
  return ["downcase", ["to-string", ["coalesce",
    ["get", "name:en"], ["get", "name"], ["get", "name_en"], ""]]];
}

function landmarkNameMatch(item) {
  const name = landmarkNameExpression();
  if (item.id === "cn-tower") {
    return ["any", [">=", ["index-of", "cn tower", name], 0], ["==", name, "tour cn"]];
  }
  if (item.id === "eiffel-tower") {
    return ["in", name, ["literal", ["eiffel tower", "tour eiffel"]]];
  }
  return ["in", name, ["literal", ["arc de triomphe", "arc de triomphe de l'étoile"]]];
}

function combinedFilter(originalFilter, exclusions) {
  if (!exclusions.length) return originalFilter ?? null;
  if (!originalFilter) return ["all", ...exclusions];
  return ["all", originalFilter, ...exclusions];
}

function updateBuildingFilter(map) {
  const active = map.__kmActiveModels || [];
  const exclusions = active.flatMap(id => {
    const item = LANDMARKS.find(entry => entry.id === id);
    if (!item) return [];
    const point = { type: "Point", coordinates: item.center };
    const distance = ["distance", point];
    const height = ["to-number", ["get", "render_height"], ["get", "height"], 0];
    const tallLimit = item.id === "cn-tower" ? 275 : item.id === "eiffel-tower" ? 150 : 55;
    const outerRadius = item.id === "cn-tower" ? 300 : item.id === "eiffel-tower" ? 250 : 105;
    return [["!", ["any", landmarkNameMatch(item),
      ["<", distance, item.excludeRadius || item.radius],
      ["all", [">", height, tallLimit], ["<", distance, outerRadius]]]]];
  });
  const layers = map.getStyle?.()?.layers || [];
  const cache = map.__kmStoredBuildingFilters || (map.__kmStoredBuildingFilters = new Map());
  const existingIds = new Set(layers.map(layer => layer.id));
  for (const id of cache.keys()) if (!existingIds.has(id)) cache.delete(id);
  const results = {};
  for (const layer of layers) {
    if (layer.type !== "fill-extrusion") continue;
    if (layer.id.startsWith("km-landmark-")) continue;
    const existing = map.getFilter?.(layer.id) ?? null;
    if (!cache.has(layer.id)) cache.set(layer.id, { original: existing });
    const original = cache.get(layer.id).original;
    const next = combinedFilter(original, exclusions);
    if (JSON.stringify(existing) === JSON.stringify(next)) {
      results[layer.id] = "current";
      continue;
    }
    try {
      map.setFilter(layer.id, next);
      results[layer.id] = "updated";
    } catch (error) {
      results[layer.id] = String(error?.message || error);
      console.warn("Landmark building exclusion unavailable", error);
    }
  }
  map.__kmLandmarkFilters = results;
}

function disposeObject(root) {
  root.traverse(child => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose();
    }
  });
}

function modelMatrix(three, center, altitude) {
  const longitude = center[0];
  const latitude = center[1] * Math.PI / 180;
  const mercatorX = (longitude + 180) / 360;
  const mercatorY = (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2;
  const unitsPerMeter = 1 / (40075016.68557849 * Math.cos(latitude));
  return new three.Matrix4()
    .makeTranslation(mercatorX, mercatorY, altitude * unitsPerMeter)
    .scale(new three.Vector3(unitsPerMeter, -unitsPerMeter, unitsPerMeter))
    .multiply(new three.Matrix4().makeRotationX(Math.PI / 2));
}

function removeImportedScene(root) {
  const blocked = new Set(["ground", "untitled2", "object001"]);
  const removed = [];
  const candidates = [];
  root.traverse(node => {
    if (node === root) return;
    const name = (node.name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (blocked.has(name)) candidates.push(node);
  });
  for (const node of candidates) {
    if (!node.parent) continue;
    node.parent.remove(node);
    removed.push(node.name);
    node.traverse(child => { child.geometry?.dispose(); });
  }
  return removed;
}

function orientMesh(three, root, item) {
  const reference = { width: item.expectedWidth || 1, height: item.height, depth: item.expectedDepth || 1 };
  root.updateMatrixWorld(true);
  const sourceBox = new three.Box3().setFromObject(root);
  const size = sourceBox.getSize(new three.Vector3());
  const candidates = [];
  for (const rotationX of [0, -Math.PI / 2, Math.PI / 2]) {
    for (const rotationZ of [0, Math.PI / 2, -Math.PI / 2]) {
      if (rotationX && rotationZ) continue;
      for (const rotationY of [0, Math.PI / 2]) {
        root.rotation.set(rotationX, rotationY, rotationZ);
        root.updateMatrixWorld(true);
        const bounds = new three.Box3().setFromObject(root).getSize(new three.Vector3());
        if (bounds.y < 1e-6) continue;
        const widthToHeight = bounds.x / bounds.y;
        const depthToHeight = bounds.z / bounds.y;
        const score = Math.abs(Math.log(Math.max(1e-6, widthToHeight) / (reference.width / reference.height))) +
          Math.abs(Math.log(Math.max(1e-6, depthToHeight) / (reference.depth / reference.height))) +
          (Math.abs(rotationX) + Math.abs(rotationZ) + Math.abs(rotationY)) * 0.0001;
        candidates.push({ score, rotationX, rotationY, rotationZ });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best || !Number.isFinite(best.score)) throw new Error(`Unable to orient ${item.id}`);
  root.rotation.set(best.rotationX, best.rotationY, best.rotationZ);
  root.updateMatrixWorld(true);
  return { axis: [best.rotationX, best.rotationY, best.rotationZ], score: best.score,
    sourceDimensions: size.toArray() };
}

function orientTowerMesh(three, root) {
  root.updateMatrixWorld(true);
  const bounds = new three.Box3().setFromObject(root);
  const dimensions = bounds.getSize(new three.Vector3());
  const axis = dimensions.z >= dimensions.x && dimensions.z >= dimensions.y ? "z"
    : dimensions.x >= dimensions.y ? "x" : "y";
  const start = bounds.min[axis];
  const length = dimensions[axis];
  const end = start + length;
  const position = root.geometry?.attributes?.position;
  let baseAtHighEnd = false;
  if (position?.count && length > 0) {
    const low = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
    const high = { minA: Infinity, maxA: -Infinity, minB: Infinity, maxB: -Infinity };
    const axes = ["x", "y", "z"].filter(value => value !== axis);
    const step = Math.max(1, Math.floor(position.count / 8000));
    for (let i = 0; i < position.count; i += step) {
      const v = { x: position.getX(i), y: position.getY(i), z: position.getZ(i) };
      const side = v[axis] < start + length * 0.15 ? low
        : v[axis] > end - length * 0.15 ? high : null;
      if (!side) continue;
      const a = v[axes[0]];
      const b = v[axes[1]];
      side.minA = Math.min(side.minA, a);
      side.maxA = Math.max(side.maxA, a);
      side.minB = Math.min(side.minB, b);
      side.maxB = Math.max(side.maxB, b);
    }
    const area = side => Number.isFinite(side.minA) ?
      (side.maxA - side.minA) * (side.maxB - side.minB) : 0;
    if (area(low) > 0 && area(high) > 0) baseAtHighEnd = area(high) > area(low);
  }
  root.rotation.set(0, 0, 0);
  if (axis === "z") root.rotation.x = baseAtHighEnd ? Math.PI / 2 : -Math.PI / 2;
  else if (axis === "x") root.rotation.z = baseAtHighEnd ? -Math.PI / 2 : Math.PI / 2;
  else if (baseAtHighEnd) root.rotation.z = Math.PI;
  root.updateMatrixWorld(true);
  return { axis: root.rotation.toArray().slice(0, 3), sourceDimensions: dimensions.toArray(), baseAtHighEnd };
}

function normalizeModel(three, root, landmark) {
  const removed = landmark.type === "fbx" ? removeImportedScene(root) : [];
  root.updateMatrixWorld(true);
  const orientation = landmark.id === "eiffel-tower"
    ? orientTowerMesh(three, root)
    : landmark.type === "stl" ? orientMesh(three, root, landmark) : null;
  const box = new three.Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  if (!Number.isFinite(height) || height <= 0) throw new Error("Invalid model dimensions");
  const scale = landmark.height / height;
  const group = new three.Group();
  group.userData.kmModelInfo = {
    removed,
    orientation,
    targetHeightMeters: landmark.height,
    rawHeight: height,
    scale,
    widthMeters: (box.max.x - box.min.x) * scale,
    depthMeters: (box.max.z - box.min.z) * scale,
  };
  root.position.set(-((box.min.x + box.max.x) / 2), -box.min.y, -((box.min.z + box.max.z) / 2));
  root.scale.multiplyScalar(scale);
  root.position.multiplyScalar(scale);
  if (Array.isArray(landmark.rotation)) group.rotation.set(...landmark.rotation);
  group.add(root);
  return group;
}

function createModelLayer() {
  let removed = false;
  let three;
  let camera;
  let scene;
  let renderer;
  let map;
  let activeKey = "";
  const loading = new Set();
  const loaded = new Map();
  const rejected = new Set();
  let loaders;
  let loadingLibraries = false;
  let context;
  let projectionError = null;
  let filterQueued = false;

  function applyFiltersSoon() {
    if (filterQueued) return;
    filterQueued = true;
    Promise.resolve().then(() => {
      filterQueued = false;
      if (!removed && map?.isStyleLoaded?.()) updateBuildingFilter(map);
    });
  }

  function refresh() {
    if (!map || removed) return;
    const center = map.getCenter();
    const location = [center.lng, center.lat];
    const zoom = map.getZoom();
    const active = [];
    if (!loaders && !loadingLibraries && LANDMARKS.some(item =>
      zoom >= item.minZoom && kilometers(location, item.center) < 6)) {
      loadingLibraries = true;
      loadLibraries().then(libs => {
        if (removed) return;
        loaders = libs;
        three = libs.three;
        camera = new three.Camera();
        scene = new three.Scene();
        map.__kmLandmarkLibraryError = null;
        scene.add(new three.AmbientLight(0xffffff, 1.4));
        const sun = new three.DirectionalLight(0xfff4dc, 2);
        sun.position.set(1, 2, 3);
        scene.add(sun);
        renderer = new three.WebGLRenderer({ canvas: map.getCanvas(), context, antialias: false });
        renderer.autoClear = false;
        refresh();
      }).catch(error => {
        loadingLibraries = false;
        map.__kmLandmarkLibraryError = String(error?.message || error);
        console.warn("Architectural 3D models unavailable", error);
      });
    }
    for (const item of LANDMARKS) {
      const visible = zoom >= item.minZoom && kilometers(location, item.center) < 6;
      const object = loaded.get(item.id);
      if (object) {
        object.visible = visible;
        object.scale.setScalar(modelZoomScale(item, zoom));
      }
      if (object && visible && map.__kmLandmarkRendered?.[item.id]) active.push(item.id);
      if (!visible || object || loading.has(item.id) || rejected.has(item.id) || !loaders) continue;
      loading.add(item.id);
      const loader = item.type === "fbx" ? new loaders.FBXLoader() : new loaders.STLLoader();
      if (item.type === "fbx") loader.setResourcePath(ASSET_PATH);
      const acceptModel = value => {
        loading.delete(item.id);
        if (removed) return;
        try {
          const root = item.type === "stl"
            ? new three.Mesh(value, new three.MeshStandardMaterial({ color: item.color, roughness: 0.9, metalness: 0.05 }))
            : value;
          const group = normalizeModel(three, root, item);
          let meshes = 0;
          group.traverse(child => { if (child.isMesh) meshes++; });
          if (!meshes) throw new Error("Model contains no drawable meshes");
          loaded.set(item.id, group);
          map.__kmLandmarkMeshCounts = { ...map.__kmLandmarkMeshCounts, [item.id]: meshes };
          map.__kmLandmarkModelInfo = { ...map.__kmLandmarkModelInfo, [item.id]: group.userData.kmModelInfo };
          scene.add(group);
          refresh();
          map.triggerRepaint();
        } catch (error) {
          rejected.add(item.id);
          map.__kmLandmarkLoadErrors = { ...map.__kmLandmarkLoadErrors, [item.id]: String(error?.message || error) };
          console.warn(`Could not position ${item.id}`, error);
        }
      };
      const reportFailure = error => {
        loading.delete(item.id);
        if (removed || !map) return;
        rejected.add(item.id);
        map.__kmLandmarkLoadErrors = { ...map.__kmLandmarkLoadErrors, [item.id]: String(error?.message || error) };
        console.warn(`Could not load ${item.id}`, error);
      };
      loader.load(item.url, acceptModel, undefined, error => {
        if (item.backupUrl && !removed) loader.load(item.backupUrl, acceptModel, undefined, reportFailure);
        else reportFailure(error);
      });
    }
    map.__kmActiveModels = active;
    updateAttribution(map, active);
    map.__kmLandmarkErrors = [...rejected];
    const key = active.slice().sort().join("|");
    if (key !== activeKey) {
      activeKey = key;
      applyFiltersSoon();
    }
  }

  function refreshVisibility() {
    for (const [id, object] of loaded) {
      const item = LANDMARKS.find(entry => entry.id === id);
      const c = map?.getCenter();
      const zoom = map?.getZoom() ?? 0;
      object.visible = Boolean(c && zoom >= item.minZoom && kilometers([c.lng, c.lat], item.center) < 6);
      object.scale.setScalar(modelZoomScale(item, zoom));
    }
  }

  return {
    id: "km-real-landmarks",
    type: "custom",
    renderingMode: "3d",
    onAdd(activeMap, gl) {
      map = activeMap;
      removeLegacyLandmarks(map);
      context = gl;
      removed = false;
      map.on("moveend", refresh);
      map.__kmStoredBuildingFilters = new Map();
      map.__kmLandmarkRendered = {};
      map.__kmActiveModels = [];
      refresh();
    },
    render(gl, args) {
      if (!renderer || !three || !loaded.size) return;
      refreshVisibility();
      const projectionData = args?.defaultProjectionData?.mainMatrix || args?.modelViewProjectionMatrix;
      if (!projectionData) {
        if (!projectionError) {
          projectionError = "MapLibre model projection unavailable";
          map.__kmLandmarkProjectionError = projectionError;
          console.warn(projectionError);
        }
        return;
      }
      let drew = false;
      for (const item of LANDMARKS) {
        const group = loaded.get(item.id);
        if (!group?.visible) continue;
        try {
          const elevation = map.queryTerrainElevation?.(item.center, { exaggerated: true });
          const altitude = Number.isFinite(elevation) ? elevation : 0;
          const projection = new three.Matrix4().fromArray(projectionData);
          const model = modelMatrix(three, item.center, altitude);
          camera.projectionMatrix.copy(projection).multiply(model);
          for (const [id, object] of loaded) object.visible = id === item.id;
          renderer.resetState();
          renderer.render(scene, camera);
          drew = true;
          if (projectionError) {
            projectionError = null;
            map.__kmLandmarkProjectionError = null;
          }
          map.__kmLandmarkRendered = { ...map.__kmLandmarkRendered, [item.id]: true };
        } catch (error) {
          if (!map.__kmLandmarkProjectionWarned) {
            console.warn("3D landmark projection error", error);
            map.__kmLandmarkProjectionWarned = true;
          }
          projectionError = String(error?.message || error);
          map.__kmLandmarkProjectionError = projectionError;
        }
      }
      if (drew) {
        refreshVisibility();
        refresh();
      }
    },
    onRemove() {
      removed = true;
      map?.off("moveend", refresh);
      if (map) {
        map.__kmActiveModels = [];
        updateAttribution(map, []);
        updateBuildingFilter(map);
      }
      try { if (renderer && !renderer.getContext().isContextLost()) renderer.dispose(); } catch (error) { console.debug("3D landmark renderer already released", error); }
      for (const object of loaded.values()) disposeObject(object);
      loaded.clear();
      loading.clear();
      map = null;
    },
  };
}

export function ensureRealLandmarks(map, enabled) {
  removeLegacyLandmarks(map);
  const id = "km-real-landmarks";
  if (!enabled) {
    if (map.getLayer(id)) map.removeLayer(id);
    map.__kmActiveModels = [];
    updateAttribution(map, []);
    updateBuildingFilter(map);
    return;
  }
  if (!map.getLayer(id)) {
    try { map.addLayer(createModelLayer()); }
    catch (error) { console.warn("Landmark model layer failed", error); }
  }
  updateBuildingFilter(map);
}

export { LANDMARKS };
