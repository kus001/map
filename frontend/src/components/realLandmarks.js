const ASSET_PATH = "/models/landmarks/";

const LANDMARKS = [
  {
    id: "cn-tower",
    center: [-79.387083, 43.642556],
    height: 553.3,
    radius: 75,
    excludeRadius: 90,
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
    excludeRadius: 120,
    minZoom: 14.5,
    type: "stl",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/ff/Eiffel.stl",
    color: 0x826a50,
  },
  {
    id: "arc-de-triomphe",
    center: [2.29502, 48.873793],
    height: 50,
    radius: 45,
    excludeRadius: 65,
    minZoom: 15,
    type: "stl",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/ee/Arc_de_Triomphe.stl",
    color: 0xd4c9b5,
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

function footprint(center, radius) {
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const angle = Math.PI * 2 * i / 24;
    points.push([
      center[0] + Math.cos(angle) * radius / (111320 * Math.cos(center[1] * Math.PI / 180)),
      center[1] + Math.sin(angle) * radius / 111320,
    ]);
  }
  return { type: "Polygon", coordinates: [points] };
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
  const layer = "km-landmark-models-3d";
  const source = "km-landmark-models";
  if (map.getLayer(layer)) map.removeLayer(layer);
  if (map.getSource(source)) map.removeSource(source);
}

function modelZoomScale(item, zoom) {
  if (zoom < item.minZoom) return 0;
  if (!item.fullZoom || zoom >= item.fullZoom) return 1;
  const t = Math.max(0, Math.min(1, (zoom - item.minZoom) / (item.fullZoom - item.minZoom)));
  return 0.1 + 0.9 * t * t * (3 - 2 * t);
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
  const exclusions = [];
  for (const id of active) {
    const item = LANDMARKS.find(entry => entry.id === id);
    if (!item) continue;
    exclusions.push(["!", ["any", landmarkNameMatch(item),
      ["within", footprint(item.center, item.excludeRadius || item.radius)]]]);
  }
  const layers = map.getStyle?.()?.layers || [];
  map.__kmStoredBuildingFilters ||= {};
  for (const layer of layers) {
    if (layer.type !== "fill-extrusion" || layer.id === "km-landmark-models-3d") continue;
    const sourceLayer = layer["source-layer"] || "";
    if (layer.id !== "km-buildings-3d" && sourceLayer !== "building" &&
      !/building/i.test(layer.id)) continue;
    const cached = map.__kmStoredBuildingFilters;
    if (!(layer.id in cached)) cached[layer.id] = map.getFilter?.(layer.id) ?? null;
    try {
      const next = combinedFilter(cached[layer.id], exclusions);
      map.setFilter(layer.id, next);
    } catch (error) {
      console.warn("Landmark building exclusion unavailable", error);
    }
  }
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

function normalizeModel(three, root, landmark) {
  const removed = landmark.type === "fbx" ? removeImportedScene(root) : [];
  root.updateMatrixWorld(true);
  if (landmark.type === "stl") root.rotation.x = -Math.PI / 2;
  root.updateMatrixWorld(true);
  const box = new three.Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  if (!Number.isFinite(height) || height <= 0) throw new Error("Invalid model dimensions");
  const scale = landmark.height / height;
  const group = new three.Group();
  group.userData.kmModelInfo = {
    removed,
    targetHeightMeters: landmark.height,
    rawHeight: height,
    scale,
    widthMeters: (box.max.x - box.min.x) * scale,
    depthMeters: (box.max.z - box.min.z) * scale,
  };
  root.position.set(-((box.min.x + box.max.x) / 2), -box.min.y, -((box.min.z + box.max.z) / 2));
  root.scale.multiplyScalar(scale);
  root.position.multiplyScalar(scale);
  if (Array.isArray(landmark.rotation)) {
    group.rotation.set(landmark.rotation[0] || 0, landmark.rotation[1] || 0, landmark.rotation[2] || 0);
  }
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
      loader.load(item.url, value => {
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
      }, undefined, error => {
        loading.delete(item.id);
        rejected.add(item.id);
        map.__kmLandmarkLoadErrors = { ...map.__kmLandmarkLoadErrors, [item.id]: String(error?.message || error) };
        console.warn(`Could not load ${item.id}`, error);
      });
    }
    map.__kmActiveModels = active;
    updateAttribution(map, active);
    map.__kmLandmarkErrors = [...rejected];
    const key = active.slice().sort().join("|");
    if (key !== activeKey) {
      activeKey = key;
      updateBuildingFilter(map);
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
          const altitude = map.queryTerrainElevation?.(item.center, { exaggerated: true }) || 0;
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
      if (renderer) renderer.dispose();
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
}

export { LANDMARKS };
