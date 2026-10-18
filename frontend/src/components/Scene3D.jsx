import { useEffect, useMemo, useRef, useState } from "react";

const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_KEY || "").trim();
const FREE = "https://tiles.openfreemap.org/styles/";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRAIN_MIN_ZOOM = 7;
const MAX_FREE_PITCH = 85;
function safeCameraPitch(zoom, pitch) {
  const limit = zoom >= 10 ? 80 : MAX_FREE_PITCH;
  return Math.max(0, Math.min(limit, Number.isFinite(pitch) ? pitch : 0));
}

function deviceProfile() {
  const memory = typeof navigator === "undefined" ? 0 : Number(navigator.deviceMemory) || 0;
  const cores = typeof navigator === "undefined" ? 0 : Number(navigator.hardwareConcurrency) || 0;
  const mobile = typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") || navigator.userAgentData?.mobile === true);
  const tier = mobile || (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4)
    ? "low" : (memory > 0 && memory <= 8) || (cores > 0 && cores <= 8)
      ? "medium" : "high";
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return {
    tier,
    pixelRatio: Math.min(ratio, tier === "low" ? 1 : tier === "medium" ? 1.2 : 1.4),
    tileCache: tier === "low" ? 8 : tier === "medium" ? 14 : 22,
    buildingZoom: tier === "low" ? 15.6 : tier === "medium" ? 15.2 : 14.8,
    demZoom: tier === "low" ? 9 : tier === "medium" ? 10 : 11,
    shadeZoom: tier === "low" ? 8 : 6,
  };
}

function applyAtmosphere(map, darkMode, globe) {
  const nextSky = globe ? {
    "sky-color": darkMode ? "#214565" : "#8dc5ed",
    "horizon-color": darkMode ? "#496f92" : "#e1f3ff",
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 9, 0.95, 15, 0.65, 22, 0.38],
  } : {
    "sky-color": darkMode ? "#17304b" : "#79b8e6",
    "horizon-color": darkMode ? "#779ab7" : "#edf8ff",
    "fog-color": darkMode ? "#54738c" : "#c3e1f5",
    "sky-horizon-blend": 0.7,
    "horizon-fog-blend": 0.72,
    "fog-ground-blend": 0.12,
    "atmosphere-blend": 0,
  };
  const id = `${globe ? "globe" : "flat"}:${darkMode ? "dark" : "light"}`;
  if (map.__kmSkyKey === id) return;
  map.setSky(nextSky);
  map.__kmSkyKey = id;
}

const DEFAULT_CAMERA = { center: [-80.5249, 43.4829], zoom: 13, pitch: 58, bearing: 0 };
const COLOR = { driving: "#62876d", walking: "#e9f3ec", cycling: "#81b686", transit: "#b99aff" };
const FEED_COLORS = { incidents: "#db544d", construction: "#eb9d3c", cameras: "#478cc5", winter: "#7299cd" };
const freeStyleCache = new Map();
let maptilerUnavailable = false;

let loader;
function loadMapLibre() {
  if (!loader) {
    loader = (async () => {
      if (!document.querySelector('link[data-km-3d]')) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.dataset.km3d = "true";
        css.href = "https://unpkg.com/maplibre-gl@6.14.0/dist/maplibre-gl.css";
        document.head.appendChild(css);
      }
      const url = "https://unpkg.com/maplibre-gl@6.14.0/dist/maplibre-gl.mjs";
      const gl = await import(url);
      if (!gl?.Map) throw new Error("3D renderer unavailable");
      return gl;
    })().catch(error => { loader = null; throw error; });
  }
  return loader;
}

function geoLine(points) {
  const coords = (points || []).filter(p => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map(p => [Number(p[1]), Number(p[0])]);
  return coords.length > 1 ? { type: "LineString", coordinates: coords } : null;
}
function collection(features) { return { type: "FeatureCollection", features }; }
function setData(map, id, features) {
  const source = map.getSource(id);
  if (source) source.setData(collection(features));
}
function addGeo(map, id) {
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: collection([]) });
}
function validCoord(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(v => Number.isFinite(Number(v)));
}
function lineFeature(points, color, routeNumber, walking = false, chosen = false) {
  const geometry = geoLine(points);
  return geometry ? { type: "Feature", geometry, properties: { color, routeNumber: String(routeNumber), walking: walking ? 1 : 0, chosen: chosen ? 1 : 0 } } : null;
}

function buildingSourceFromStyle(style) {
  const sources = style?.sources || {};
  const layer = (style?.layers || []).find(item => item["source-layer"] === "building" &&
    sources[item.source]?.type === "vector");
  return (layer && sources[layer.source]) || sources.openmaptiles || sources.openfreemap || null;
}

async function getStyle(mapStyle, darkMode, signal) {
  const freeName = darkMode ? "dark" : "liberty";
  let freeStyle = freeStyleCache.get(freeName);
  if (!freeStyle) {
    const response = await fetch(`${FREE}${freeName}`, { signal });
    if (!response.ok) throw new Error("The free map provider isn't responding");
    freeStyle = await response.json();
    if (freeStyle.version === 8 && buildingSourceFromStyle(freeStyle))
      freeStyleCache.set(freeName, freeStyle);
  }
  freeStyle = structuredClone(freeStyle);
  if (freeStyle.version !== 8 || !freeStyle.sources) throw new Error("Unexpected map style data");
  const freeBuildingSource = buildingSourceFromStyle(freeStyle);
  const dedicatedBuildingSource = freeBuildingSource;

  const keyAllowed = MAPTILER_KEY && !maptilerUnavailable && import.meta.env.VITE_MAP_PROVIDER !== "openfreemap";
  const satelliteFallback = mapStyle === "hybrid" ? {
    version: 8, glyphs: freeStyle.glyphs, sprite: freeStyle.sprite,
    sources: { ...freeStyle.sources, "km-satellite": { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri" } },
    layers: [
      { id: "km-imagery", type: "raster", source: "km-satellite", paint: darkMode ? { "raster-brightness-max": 0.82 } : {} },
      ...freeStyle.layers.filter(layer => ["line", "symbol"].includes(layer.type) && /road|street|highway|rail|bridge|tunnel|place|poi|label|boundary|waterway|transport/i.test(layer.id)),
    ],
  } : freeStyle;

  if (keyAllowed && mapStyle !== "satellite") {
    const styleName = mapStyle === "hybrid" ? (darkMode ? "hybrid-v4-dark" : "hybrid-v4") : (darkMode ? "streets-v4-dark" : "streets-v4");
    try {
      const key = encodeURIComponent(MAPTILER_KEY);
      const result = await fetch(`https://api.maptiler.com/maps/${styleName}/style.json?key=${key}`, { signal });
      if (result.status === 401 || result.status === 403) maptilerUnavailable = true;
      if (result.ok && result.headers.get("content-type")?.includes("json")) {
        const style = await result.json();
        if (style.version === 8 && style.sources && Array.isArray(style.layers)) return { style, buildingSource: freeBuildingSource, fallback: satelliteFallback };
      }
    } catch (error) { if (signal.aborted) throw error; }
  }

  if (mapStyle === "street") return { style: freeStyle, buildingSource: freeBuildingSource, fallback: freeStyle };

  const imagery = {
    id: "km-imagery", type: "raster", source: "km-satellite",
    paint: darkMode ? { "raster-brightness-max": 0.82 } : {},
  };
  const roadLabels = mapStyle === "hybrid" ? satelliteFallback.layers.slice(1) : [];
  return {
    style: {
      version: 8,
      glyphs: freeStyle.glyphs,
      sprite: freeStyle.sprite,
      sources: { ...(mapStyle === "hybrid" ? freeStyle.sources : {}),
        ...(dedicatedBuildingSource ? { "km-building-vectors": dedicatedBuildingSource } : {}),
        "km-satellite": { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri" } },
      layers: [imagery, ...roadLabels],
    },
    buildingSource: freeBuildingSource,
    fallback: freeStyle,
  };
}

function syncTerrain(map, enabled, profile) {
  if (!map.isStyleLoaded() || !map.getSource("km-elevation")) return;
  const shouldRender = enabled && map.getZoom() >= TERRAIN_MIN_ZOOM && map.getPitch() <= 89;
  const current = map.getTerrain();
  if (shouldRender && !current) map.setTerrain({ source: "km-elevation", exaggeration: profile.tier === "low" ? 1.25 : 1.45 });
  else if (!shouldRender && current) map.setTerrain(null);
  if (map.getLayer("km-terrain-shading")) {
    map.setLayoutProperty("km-terrain-shading", "visibility", enabled ? "visible" : "none");
  }
}

function pickBuildingSource(map, buildingSource) {
  const style = map.getStyle();
  const sources = style.sources || {};
  const usedByBuildings = (style.layers || [])
    .filter(layer => layer["source-layer"] === "building" && sources[layer.source]?.type === "vector")
    .map(layer => layer.source);
  const candidates = [...new Set(["km-building-vectors", ...usedByBuildings, "openmaptiles", "openfreemap", "maptiler_planet"])]
    .filter(id => sources[id]?.type === "vector" && map.getSource(id));
  if (candidates.length) {
    return candidates.find(id => map.isSourceLoaded(id)) || candidates[0];
  }
  const sourceId = "km-buildings";
  if (!map.getSource(sourceId)) {
    const supplied = buildingSource?.type === "vector" ? buildingSource : {
      type: "vector", url: "https://tiles.openfreemap.org/planet",
    };
    map.addSource(sourceId, { ...supplied, type: "vector" });
  }
  return sourceId;
}

function buildingLayerInsertionPoint(map) {
  const layers = map.getStyle().layers || [];
  let lastGroundIndex = -1;
  for (let i = 0; i < layers.length; i++) {
    if (["raster", "hillshade", "background"].includes(layers[i].type)) lastGroundIndex = i;
  }
  return layers.slice(lastGroundIndex + 1)
    .find(layer => layer.type === "symbol")?.id;
}

function buildingMaterialColor(darkMode) {
  const neutral = darkMode ? "#aeb5bb" : "#d1c8ba";
  const material = ["downcase", ["to-string", ["coalesce",
    ["get", "render_material"], ["get", "building:material"], ["get", "material"], ""]]];
  const byMaterial = ["match", material,
    "brick", darkMode ? "#9d786e" : "#bb8e7e",
    "glass", darkMode ? "#759baa" : "#9bbec9",
    "concrete", darkMode ? "#9b9ea1" : "#c2bfba",
    "stone", darkMode ? "#b1aaa0" : "#d4c9b6",
    "metal", darkMode ? "#8497a1" : "#a9b7ba",
    "wood", darkMode ? "#997c67" : "#c6a88d",
    "plaster", darkMode ? "#b8b2a7" : "#e1d7c8",
    neutral];
  return ["to-color",
    ["get", "render_colour"], ["get", "building:colour"],
    ["get", "building:color"], ["get", "colour"], ["get", "color"],
    byMaterial];
}

function ensureBuildingLayer(map, buildingSource, darkMode, mapStyle, profile) {
  if (map.getLayer("km-buildings-3d")) {
    map.setLayoutProperty("km-buildings-3d", "visibility", "visible");
    return true;
  }
  const diagnostic = map.__kmBuildingInfo || (map.__kmBuildingInfo = { attempts: 0, lastError: null });
  diagnostic.attempts++;
  let sourceId;
  try {
    sourceId = pickBuildingSource(map, buildingSource);
  } catch (error) {
    diagnostic.lastError = `Source: ${String(error?.message || error)}`;
    console.warn("3D building source setup failed", error);
    return false;
  }
  diagnostic.sourceId = sourceId;
  if (!sourceId || !map.getSource(sourceId)) {
    diagnostic.lastError = "Vector source not registered in map style";
    return false;
  }
  const startZoom = Math.min(profile.buildingZoom, 15.3);
  const layer = {
    id: "km-buildings-3d", type: "fill-extrusion", source: sourceId,
    "source-layer": "building", minzoom: startZoom,
    layout: { visibility: "visible" },
    filter: ["!=", ["get", "hide_3d"], true],
    paint: {
      "fill-extrusion-color": buildingMaterialColor(darkMode),
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"],
        startZoom, 0, startZoom + 0.5,
        ["max", 3, ["to-number", ["get", "render_height"], ["get", "height"], 12]]],
      "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"],
        startZoom, 0, startZoom + 0.5,
        ["max", 0, ["to-number", ["get", "render_min_height"], ["get", "min_height"], 0]]],
      "fill-extrusion-opacity": 1,
    },
  };
  const before = buildingLayerInsertionPoint(map);
  try {
    map.addLayer(layer, before);
  } catch (error) {
    diagnostic.lastError = `Layer: ${String(error?.message || error)}`;
    console.warn("3D building extrusion failed to install", error);
    return false;
  }
  diagnostic.lastError = null;
  return Boolean(map.getLayer("km-buildings-3d"));
}

function syncNativeBuildings(map, buildingsEnabled) {
  const layer = map.getLayer("km-buildings-3d");
  let customReady = false;
  if (buildingsEnabled && layer?.source) {
    try {
      customReady = map.isSourceLoaded(layer.source) &&
        map.querySourceFeatures(layer.source, { sourceLayer: "building" }).length > 0;
    } catch { customReady = false; }
  }
  for (const nativeLayer of map.getStyle()?.layers || []) {
    if (nativeLayer.type !== "fill-extrusion" || nativeLayer.id === "km-buildings-3d") continue;
    const visibility = !buildingsEnabled || customReady ? "none" : "visible";
    if (map.getLayoutProperty(nativeLayer.id, "visibility") !== visibility) {
      map.setLayoutProperty(nativeLayer.id, "visibility", visibility);
    }
  }
  return customReady;
}

function removeLegacyLandmarks(map) {
  for (const id of ["km-real-landmarks", "km-landmark-models-3d"]) {
    if (!map.getLayer(id)) continue;
    try { map.removeLayer(id); }
    catch (error) { console.warn("Could not clean up old landmark layer", error); }
  }
  const filters = map.__kmStoredBuildingFilters;
  if (filters) {
    for (const [id, filter] of Object.entries(filters)) {
      if (!map.getLayer(id)) continue;
      try { map.setFilter(id, filter); }
      catch (error) { console.warn("Could not restore building filter", error); }
    }
    delete map.__kmStoredBuildingFilters;
  }
}

function addSceneLayers(map, buildingSource, darkMode, mapStyle, buildingsEnabled, terrainEnabled, profile) {
  removeLegacyLandmarks(map);
  if (buildingsEnabled) ensureBuildingLayer(map, buildingSource, darkMode, mapStyle, profile);
  syncNativeBuildings(map, buildingsEnabled);
  if (map.getSource("km-hillshade-dem") && !map.getLayer("km-terrain-shading")) {
    const before = map.getStyle().layers.find(l => ["line", "symbol", "fill-extrusion"].includes(l.type))?.id;
    try { map.addLayer({
      id: "km-terrain-shading", type: "hillshade", source: "km-hillshade-dem",
      minzoom: profile.shadeZoom, maxzoom: 16,
      layout: { visibility: terrainEnabled ? "visible" : "none" },
      paint: {
        "hillshade-exaggeration": profile.tier === "low" ? 0.45 : mapStyle === "satellite" ? 0.56 : 0.7,
        "hillshade-shadow-color": darkMode ? "#111c2c" : "#374b55",
        "hillshade-highlight-color": darkMode ? "#a4bdd7" : "#fff3dc",
        "hillshade-accent-color": darkMode ? "#30475d" : "#758b78",
        "hillshade-illumination-direction": 315,
      },
    }, before); } catch (error) {
      console.warn("3D hillshade unavailable; buildings remain enabled", error);
    }
  }

  addGeo(map, "km-stops");
  map.addLayer({ id: "km-stops-points", type: "circle", source: "km-stops", minzoom: 16,
    paint: { "circle-color": "#9b734b", "circle-radius": 7, "circle-opacity": 0.96,
      "circle-pitch-alignment": "viewport", "circle-pitch-scale": "viewport",
      "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });

  addGeo(map, "km-routes");
  map.addLayer({ id: "km-route-casing", type: "line", source: "km-routes", paint: { "line-color": "#17212a", "line-opacity": 0.58, "line-width": ["case", ["==", ["get", "chosen"], 1], 10, 6] }, layout: { "line-join": "round", "line-cap": "round" } });
  map.addLayer({ id: "km-route-lines", type: "line", source: "km-routes", filter: ["==", ["get", "walking"], 0], paint: { "line-color": ["get", "color"], "line-opacity": ["case", ["==", ["get", "chosen"], 1], 1, 0.5], "line-width": ["case", ["==", ["get", "chosen"], 1], 6, 4] }, layout: { "line-join": "round", "line-cap": "round" } });
  map.addLayer({ id: "km-route-walk", type: "line", source: "km-routes", filter: ["==", ["get", "walking"], 1], paint: { "line-color": "#f8fafc", "line-width": 5, "line-dasharray": [0.5, 1.8] }, layout: { "line-cap": "round" } });

  for (const kind of Object.keys(FEED_COLORS)) {
    const name = `km-511-${kind}`;
    addGeo(map, name);
    map.addLayer({ id: `${name}-lines`, type: "line", source: name, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": FEED_COLORS[kind], "line-width": 4, "line-opacity": 0.85 } });
    map.addLayer({ id: `${name}-points`, type: "circle", source: name, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": FEED_COLORS[kind], "circle-radius": 6, "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
  }
}

function popupElement(title, subtitle = "") {
  const content = document.createElement("div");
  content.className = "km-3d-info";
  const heading = document.createElement("div");
  heading.className = "km-3d-info-title";
  heading.textContent = title || "Map information";
  content.append(heading);
  if (subtitle) {
    const sub = document.createElement("div");
    sub.className = "km-3d-subtitle";
    sub.textContent = subtitle;
    content.append(sub);
  }
  return content;
}
function popupText(text, className = "km-3d-body-text") {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}
function scenePopup(gl, map, coordinates, content, options = {}) {
  map.__kmOpenPopup?.remove();
  const popup = new gl.Popup({
    className: "km-3d-popup", maxWidth: "330px", offset: 13,
    anchor: "bottom", closeOnClick: false, closeButton: true,
    focusAfterOpen: false, ...options,
  }).setLngLat(coordinates).setDOMContent(content).addTo(map);
  map.__kmOpenPopup = popup;
  popup.on("close", () => {
    if (map.__kmOpenPopup === popup) map.__kmOpenPopup = null;
  });
  return popup;
}
function stopPopupContent(props) {
  const agency = String(props.agency || "grt").toLowerCase();
  const label = agency === "go" ? "GO Transit" : agency === "ttc" ? "TTC" : "GRT";
  const body = popupElement(props.name || "Transit stop", `${label} · Departures`);
  const board = document.createElement("div");
  board.className = "km-3d-board";
  board.append(popupText("Loading times…"));
  body.append(board);
  return { body, board };
}
function renderStopDepartures(board, info) {
  board.replaceChildren();
  if (info?.error) {
    board.append(popupText(info.error, "km-3d-board-error"));
    return;
  }
  const departures = info?.departures || [];
  if (!departures.length) {
    board.append(popupText("No departures listed for this stop right now."));
    return;
  }
  const list = document.createElement("div");
  list.className = "km-3d-board-list";
  for (const item of departures) {
    const card = document.createElement("div");
    card.className = "km-3d-board-card";
    const header = document.createElement("div");
    header.className = "km-3d-board-row";
    const route = document.createElement("span");
    route.textContent = `${item.route || "Transit"}${item.direction ? ` → ${item.direction}` : ""}`;
    const time = document.createElement("span");
    time.className = "km-3d-board-time";
    time.textContent = item.expected_time || item.scheduled_time || "";
    header.append(route, time);
    card.append(header);
    if (item.boarding_stop) card.append(popupText(`Nearby boarding stop: ${item.boarding_stop}`, "km-3d-board-meta"));
    const state = item.cancelled ? "Cancelled" : item.realtime ? "Live" : "Scheduled";
    const delay = Number(item.delay_min);
    const until = Number(item.minutes_until);
    card.append(popupText(`${state}${delay >= 1 ? ` · +${Math.round(delay)} min` : ""}` +
      `${item.minutes_until != null && Number.isFinite(until) ? ` · in ${Math.max(0, until)} min` : ""}`, "km-3d-board-meta"));
    list.append(card);
  }
  board.append(list);
}
function nearestStopOnScreen(map, point, radius = 34) {
  let closest = null;
  let best = radius * radius;
  for (const stop of map.__kmNearbyStops || []) {
    const projected = map.project(stop.geometry.coordinates);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
    const dx = projected.x - point.x;
    const dy = projected.y - point.y;
    const distance = dx * dx + dy * dy;
    if (distance < best) { closest = stop; best = distance; }
  }
  return closest;
}

function cameraMarker(gl, map, latLng, label, onMove) {
  const element = document.createElement("div");
  element.className = "km-3d-pin-anchor";
  const shell = document.createElement("div");
  shell.className = "km-3d-pin-shell";
  const shape = document.createElement("span");
  shape.className = "km-3d-pin-shape";
  shape.setAttribute("aria-hidden", "true");
  const glyph = document.createElement("span");
  glyph.className = "km-3d-pin-glyph";
  glyph.textContent = label;
  shell.append(shape, glyph);
  element.append(shell);
  return new gl.Marker({
    element, draggable: Boolean(onMove), anchor: "bottom",
    pitchAlignment: "viewport", rotationAlignment: "viewport", rotation: 0,
  })
    .setLngLat([Number(latLng[1]), Number(latLng[0])])
    .addTo(map);
}

export default function Scene3D({
  data, selectedRoute, selectedRouteNumber = 1, displayedMode, onSelectRoute,
  currentLocation, navigationActive, startCoordinate, destinationCoordinate, startLabel, destinationLabel,
  startDraggable, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination,
  locationFocusKey, routeFocusKey, stepFocusCoordinate, stepFocusKey,
  mapStyle, darkMode, globe, initialCamera, onCameraChange, onDisable3D,
  enabledLayers = [], onLayerStatus = () => {},
}) {
  const holder = useRef(null);
  const mapRef = useRef(null);
  const glRef = useRef(null);
  const stylesRef = useRef(0);
  const markers = useRef([]);
  const callbackRef = useRef({});
  const [problem, setProblem] = useState("");
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(() => initialCamera?.zoom ?? DEFAULT_CAMERA.zoom);
  const [profile] = useState(deviceProfile);
  const buildingStyleRef = useRef(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const terrainRef = useRef(true);
  const [buildingsEnabled, setBuildingsEnabled] = useState(true);
  const buildingsRef = useRef(buildingsEnabled);
  const globeRef = useRef(globe);
  useEffect(() => {
    buildingsRef.current = buildingsEnabled;
    globeRef.current = globe;
    terrainRef.current = terrainEnabled;
  }, [buildingsEnabled, globe, terrainEnabled]);
  const mode = displayedMode || data?.mode || "driving";
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const route = selectedRoute || data?.routes?.find(r => r.route_number === selectedRouteNumber) || data?.routes?.[0];
  const camera = useRef(initialCamera || DEFAULT_CAMERA);
  const previousGlobe = useRef(null);
  const newestLines = useRef([]);
  useEffect(() => {
    callbackRef.current = { onCameraChange, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute };
  }, [onCameraChange, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute]);

  const features = useMemo(() => {
    const result = [];
    for (const item of data?.routes || []) {
      if (item.route_number === route?.route_number) continue;
      const line = lineFeature(item.route_coordinates, "#8c9caa", item.route_number);
      if (line) result.push(line);
    }
    if (mode === "transit" && route?.segments?.length) {
      for (const segment of route.segments) {
        const isWalk = segment.type === "walking";
        const gtfsColor = /^#[0-9a-fA-F]{6}$/.test(segment.color || "") ? segment.color : COLOR.transit;
        const line = lineFeature(segment.coordinates, isWalk ? COLOR.walking : gtfsColor, route.route_number, isWalk, true);
        if (line) result.push(line);
      }
    } else if (route) {
      const line = lineFeature(route.route_coordinates, COLOR[mode] || COLOR.driving, route.route_number, mode === "walking", true);
      if (line) result.push(line);
    }
    return result;
  }, [data, route, mode]);

  useEffect(() => { newestLines.current = features; }, [features]);

  useEffect(() => {
    let active = true;
    let map;
    loadMapLibre().then(gl => {
      if (!active || !holder.current) return;
      glRef.current = gl;
      const initial = camera.current;
      map = new gl.Map({
        container: holder.current,
        style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#d9e3de" } }] },
        center: initial.center, zoom: initial.zoom,
        pitch: safeCameraPitch(initial.zoom, initial.pitch ?? 58),
        bearing: initial.bearing || 0, roll: initial.roll || 0,
        maxZoom: 20, minZoom: 0, maxPitch: MAX_FREE_PITCH,
        centerClampedToGround: true,
        transformCameraUpdate: next => {
          const pitch = safeCameraPitch(next.zoom, next.pitch);
          return pitch === next.pitch ? {} : { pitch };
        },
        dragPan: true, dragRotate: true, touchZoomRotate: true, touchPitch: true,
        rollEnabled: true, aroundCenter: false, bearingSnap: 0,
        cooperativeGestures: false,
        rotateSpeed: 0.56, pitchSpeed: -0.4,
        antialias: false, fadeDuration: 0,
        renderWorldCopies: !globeRef.current,
        maxTileCacheSize: profile.tileCache, maxTileCacheZoomLevels: 2,
        pixelRatio: profile.pixelRatio, crossSourceCollisions: false,
        anisotropicFilterPitch: profile.tier === "low" ? 180 : 75,
        maxCanvasSize: [2048, 2048], reduceMotion: profile.tier === "low",
        canvasContextAttributes: { alpha: true, antialias: false, powerPreference: "low-power" },
        cancelPendingTileRequestsWhileZooming: true,
        attributionControl: true,
      });
      mapRef.current = map;
      map.addControl(new gl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true, visualizeRoll: true }), "top-right");
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.touchPitch?.enable();
      map.getCanvasContainer().style.touchAction = "none";
      const syncGestures = () => {
        map.dragPan.enable();
        map.dragRotate.enable();
        map.touchZoomRotate.enable();
        map.touchZoomRotate.enableRotation();
        map.touchPitch?.enable();
        map.setRenderWorldCopies(!globeRef.current);
        map.setCenterClampedToGround(true);
        const pitch = safeCameraPitch(map.getZoom(), map.getPitch());
        if (pitch !== map.getPitch()) map.setPitch(pitch);
      };
      map.__kmSyncGlobeGestures = syncGestures;
      map.__kmSpinCleanup = () => {
        delete map.__kmSyncGlobeGestures;
        delete map.__kmNotifyCamera;
      };
      syncGestures();
      let lastFrame = 0;
      let samples = 0;
      let totalFrameMs = 0;
      let lastAdjustment = 0;
      let slowWindows = 0;
      map.on("render", () => {
        const now = performance.now();
        if (!map.isMoving()) { lastFrame = 0; return; }
        if (lastFrame) {
          const delta = now - lastFrame;
          if (delta > 2 && delta < 200) { samples++; totalFrameMs += delta; }
        }
        lastFrame = now;
        if (samples < 30) return;
        const mean = totalFrameMs / samples;
        if (typeof window !== "undefined") window.__kmaps3DStats = {
          tier: profile.tier, frameMs: Math.round(mean * 10) / 10,
          movingFps: Math.round(1000 / mean), pixelRatio: map.getPixelRatio(),
          samples, projection: globeRef.current ? "globe" : "flat",
          terrain: Boolean(map.getTerrain()),
          buildingLayer: Boolean(map.getLayer("km-buildings-3d") &&
            map.getLayoutProperty("km-buildings-3d", "visibility") !== "none"),
        };
        slowWindows = mean > 28 ? slowWindows + 1 : 0;
        if (slowWindows >= 2 && now - lastAdjustment > 3000 && map.getPixelRatio() > 0.76) {
          map.setPixelRatio(Math.max(0.75, Math.round((map.getPixelRatio() - 0.2) * 100) / 100));
          lastAdjustment = now;
          slowWindows = 0;
        }
        samples = 0; totalFrameMs = 0;
      });
      map.on("pitchend", () => syncTerrain(map, terrainRef.current, profile));
      map.on("zoomend", () => {
        setZoom(map.getZoom());
        syncTerrain(map, terrainRef.current, profile);
      });
      map.on("styleimagemissing", event => {
        const id = event.id;
        if ((id === " " || id === "transportation:road_") && !map.hasImage(id)) {
          map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
        }
      });
      map.__kmNotifyCamera = () => {
        callbackRef.current.onCameraChange?.({
          center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(),
          bearing: map.getBearing(), pitch: map.getPitch(), roll: map.getRoll(),
        });
      };
      map.on("moveend", map.__kmNotifyCamera);
      map.__kmBuildingErrors = [];
      map.on("error", event => {
        const message = String(event?.error?.message || event?.message || "");
        if (!message || /abort/i.test(message)) return;
        const list = map.__kmBuildingErrors;
        list.push(message.slice(0, 360));
        if (list.length > 12) list.shift();
      });
      if (typeof window !== "undefined") window.__kmaps3DBuildings = () => {
        const layer = map.getLayer("km-buildings-3d");
        const sourceId = layer?.source;
        const style = map.getStyle();
        const candidateSources = Object.entries(style?.sources || {})
          .filter(([, source]) => source.type === "vector").map(([id]) => id);
        let sourceFeatures = null;
        if (sourceId && map.isSourceLoaded(sourceId)) {
          try { sourceFeatures = map.querySourceFeatures(sourceId, { sourceLayer: "building" }).length; }
          catch (error) { console.warn("3D building query", error); }
        }
        return {
          source: sourceId || null,
          sourceLoaded: sourceId ? (() => {
            try { return map.isSourceLoaded(sourceId); } catch { return false; }
          })() : false,
          sourceFeatures,
          zoom: Number(map.getZoom().toFixed(1)),
          visible: layer ? map.getLayoutProperty("km-buildings-3d", "visibility") !== "none" : false,
          candidateSources,
          layerInstalled: Boolean(layer),
          attempts: map.__kmBuildingInfo?.attempts ?? 0,
          lastError: map.__kmBuildingInfo?.lastError ?? null,
          lastSource: map.__kmBuildingInfo?.sourceId ?? null,
          style: style?.name ?? null,
          providerErrors: (map.__kmBuildingErrors || []).slice(-4),
        };
      };
      let lastRotateAt = -Infinity;
      map.on("rotate", () => { lastRotateAt = performance.now(); });
      map.on("contextmenu", event => {
        event.preventDefault();
        if (performance.now() - lastRotateAt < 350) return;
        const root = document.createElement("div");
        root.className = "km-3d-picker";
        for (const [label, action] of [["Set as start", "onSetMapStart"], ["Set as destination", "onSetMapDestination"]]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.onclick = () => { callbackRef.current[action]?.([event.lngLat.lat, event.lngLat.lng]); popup.remove(); };
          root.append(button);
        }
        root.append(popupText(`${event.lngLat.lat.toFixed(5)}, ${event.lngLat.lng.toFixed(5)}`, "km-3d-coordinates"));
        const popup = scenePopup(gl, map, event.lngLat, root, { maxWidth: "235px" });
      });
      const openStop = feature => {
        const props = feature.properties || {};
        const coordinates = feature.geometry?.coordinates;
        if (!Array.isArray(coordinates)) return;
        const { body, board } = stopPopupContent(props);
        const popup = scenePopup(gl, map, coordinates, body, { className: "km-3d-popup km-3d-transit-popup" });
        const req = new AbortController();
        popup.on("close", () => req.abort());
        fetch(`/api/transit/stop-board?${new URLSearchParams({ stop_id: props.stop_id, limit: "8" })}`, { signal: req.signal })
          .then(async r => {
            const data = await r.json();
            return r.ok ? data : { error: data.error || "Departures unavailable" };
          })
          .then(info => { if (!req.signal.aborted) renderStopDepartures(board, info); })
          .catch(() => { if (!req.signal.aborted) renderStopDepartures(board, { error: "Could not load departures" }); });
      };
      map.on("click", event => {
        const ids = ["km-stops-points", "km-route-lines",
          ...Object.keys(FEED_COLORS).flatMap(kind => [`km-511-${kind}-points`, `km-511-${kind}-lines`])]
          .filter(id => map.getLayer(id));
        if (!ids.length) return;
        const point = event.point;
        const hits = map.queryRenderedFeatures([
          [point.x - 13, point.y - 13], [point.x + 13, point.y + 13],
        ], { layers: ids });
        const stopHit = hits.find(hit => hit.layer?.id === "km-stops-points");
        const stop = modeRef.current === "transit" && map.getZoom() >= 16
          ? nearestStopOnScreen(map, point)
          : null;
        if (stop || stopHit) {
          openStop(stop || stopHit);
          return;
        }
        const hit = hits[0];
        if (!hit) return;
        const props = hit.properties || {};
        if (hit.layer.id === "km-route-lines") {
          const number = Number(props.routeNumber);
          if (Number.isFinite(number)) callbackRef.current.onSelectRoute?.(number);
          return;
        }
        const body = popupElement(props.title || "Road update", props.direction || "");
        if (props.closure) body.append(popupText("Road closed", "km-3d-board-error"));
        if (props.details) body.append(popupText(props.details));
        if (props.impact && props.impact !== props.details) body.append(popupText(props.impact, "km-3d-subtitle"));
        if (props.lanes) body.append(popupText(props.lanes, "km-3d-subtitle"));
        const coordinates = hit.geometry.type === "Point" ? hit.geometry.coordinates : event.lngLat;
        if (props.kind === "cameras") {
          let images = [];
          try { images = JSON.parse(props.images || "[]"); } catch { images = []; }
          if (images.length) {
            let index = 0;
            const photo = document.createElement("img"); photo.className = "km-3d-photo";
            const caption = document.createElement("small");
            const bar = document.createElement("div"); bar.className = "km-3d-camera-controls";
            const previous = document.createElement("button"); previous.textContent = "‹";
            const next = document.createElement("button"); next.textContent = "›";
            const show = () => {
              try {
                const url = new URL(images[index].url);
                url.searchParams.set("_km_refresh", String(Math.floor(Date.now() / 30000)));
                photo.src = url.toString();
              } catch { photo.src = images[index].url; }
              photo.alt = images[index].label || "Highway camera";
              caption.textContent = images[index].label || `View ${index + 1}`;
            };
            previous.onclick = () => { index = (index - 1 + images.length) % images.length; show(); };
            next.onclick = () => { index = (index + 1) % images.length; show(); };
            bar.append(previous, caption, next);
            body.append(photo, bar); show();
            const timer = setInterval(show, 30000);
            const popup = scenePopup(gl, map, coordinates, body);
            popup.on("close", () => clearInterval(timer));
            return;
          }
        }
        scenePopup(gl, map, coordinates, body);
      });
      setReady(true);
    }).catch(error => { if (active) setProblem(error.message); });
    const styles = stylesRef;
    return () => {
      active = false; styles.current++;
      markers.current.forEach(marker => marker.remove()); markers.current = [];
      map?.__kmSpinCleanup?.();
      map?.__kmOpenPopup?.remove();
      map?.remove();
      if (typeof window !== "undefined") {
        delete window.__kmaps3DStats;
        delete window.__kmaps3DBuildings;
      }
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const controller = new AbortController();
    const version = ++stylesRef.current;
    let onProviderError;
    let styleInstall;
    const repairTimers = [];
    setProblem("");
    getStyle(mapStyle, darkMode, controller.signal).then(({ style, buildingSource, fallback }) => {
      if (controller.signal.aborted || stylesRef.current !== version) return;
      const install = () => {
        if (controller.signal.aborted || stylesRef.current !== version) return;
        try {
          try { map.setProjection({ type: globeRef.current ? "globe" : "mercator" }); }
          catch (error) { console.warn("Projection unavailable", error); }
          try { map.__kmSyncGlobeGestures?.(); }
          catch (error) { console.warn("Gesture sync unavailable", error); }
          map.__kmSkyKey = null;
          try { applyAtmosphere(map, darkMode, globeRef.current); }
          catch (error) { console.warn("3D atmosphere unavailable", error); }
          buildingStyleRef.current = { buildingSource, darkMode, mapStyle };
          addSceneLayers(map, buildingSource, darkMode, mapStyle,
            buildingsRef.current, terrainRef.current, profile);
          if (typeof map.setLight === "function") {
            try { map.setLight({ anchor: "map", color: "#fff7e8",
              intensity: darkMode ? 0.42 : 0.58, position: [1.15, 305, 48] }); }
            catch { console.debug("Using default map lighting"); }
          }
          setData(map, "km-routes", newestLines.current);
          syncTerrain(map, terrainRef.current, profile);
        } catch (error) { console.warn("3D map layers:", error); setProblem("Some 3D layers couldn't load"); }
        for (const delay of [700, 2400]) {
          repairTimers.push(setTimeout(() => {
            if (controller.signal.aborted || stylesRef.current !== version ||
                !buildingsRef.current || map.getLayer("km-buildings-3d") ||
                (map.__kmBuildingInfo?.attempts || 0) >= 4) return;
            ensureBuildingLayer(map, buildingSource, darkMode, mapStyle, profile);
            syncNativeBuildings(map, buildingsRef.current);
          }, delay));
        }
      };
      styleInstall = install;
      map.on("style.load", install);
      const repairBuildings = () => {
        if (controller.signal.aborted || stylesRef.current !== version) return;
        if (buildingsRef.current && !map.getLayer("km-buildings-3d") &&
            buildingStyleRef.current && (map.__kmBuildingInfo?.attempts || 0) < 4) {
          ensureBuildingLayer(map, buildingSource, darkMode, mapStyle, profile);
        }
        syncNativeBuildings(map, buildingsRef.current);
      };
      map.on("idle", repairBuildings);
      const oldCleanup = map.__kmBuildingRepairCleanup;
      oldCleanup?.();
      map.__kmBuildingRepairCleanup = () => map.off("idle", repairBuildings);
      let styleFailures = 0;
      const providerFailure = event => {
        const description = String(event.error?.message || event.message || "");
        if (style === fallback || !/maptiler/i.test(description)) return;
        if (/403|401|forbidden|unauthori[sz]ed/i.test(description)) maptilerUnavailable = true;
        styleFailures++;
        if (styleFailures < 2) return;
        map.off("error", providerFailure);
        map.setStyle(prepare(fallback), { diff: false });
      };
      onProviderError = providerFailure;
      map.on("error", providerFailure);
      const prepare = base => ({
        ...base,
        layers: (base.layers || []).filter(layer => {
          if (profile.tier !== "low" || layer.type !== "symbol") return true;
          return !/poi|housenumber|house.number|address.label/i.test(layer.id);
        }).map(layer => {
          if (layer.id !== "Sea labels" || !layer.layout?.["text-size"]) return layer;
          const fixSize = value => Array.isArray(value) ? value.map(fixSize) : value == null ? 16 : value;
          return { ...layer, layout: { ...layer.layout,
            "text-size": fixSize(layer.layout["text-size"]) } };
        }),
        sources: { ...base.sources,
          "km-elevation": { type: "raster-dem", tiles: [TERRAIN], tileSize: 256,
            maxzoom: profile.demZoom, encoding: "terrarium", attribution: "Terrain: AWS Open Data" },
          "km-hillshade-dem": { type: "raster-dem", tiles: [TERRAIN], tileSize: 256,
            maxzoom: Math.min(9, profile.demZoom), encoding: "terrarium", attribution: "Terrain: AWS Open Data" },
        },
      });
      try { map.setStyle(prepare(style), { diff: false }); }
      catch (error) {
        map.off("style.load", install);
        if (style !== fallback) map.setStyle(prepare(fallback), { diff: false });
        else setProblem(error.message);
      }
    }).catch(error => { if (!controller.signal.aborted) setProblem(error.message); });
    return () => {
      controller.abort();
      repairTimers.forEach(clearTimeout);
      if (onProviderError) map.off("error", onProviderError);
      if (styleInstall) map.off("style.load", styleInstall);
      map.__kmBuildingRepairCleanup?.();
      delete map.__kmBuildingRepairCleanup;
    };
  }, [ready, mapStyle, darkMode, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled || !map.isStyleLoaded()) return;
      try {
        if (previousGlobe.current !== globe) {
          previousGlobe.current = globe;
          const view = { center: map.getCenter(), zoom: map.getZoom(),
            pitch: map.getPitch(), bearing: map.getBearing(), roll: map.getRoll() };
          map.setProjection({ type: globe ? "globe" : "mercator" });
          map.__kmSyncGlobeGestures?.();
          map.__kmSkyKey = null;
          if (Math.abs(map.getZoom() - view.zoom) > 0.001) map.jumpTo(view);
        }
        applyAtmosphere(map, darkMode, globe);
        syncTerrain(map, terrainRef.current, profile);
      } catch (error) {
        console.warn("3D camera change deferred", error);
      }
    };
    map.on("style.load", apply);
    map.on("idle", apply);
    apply();
    return () => { cancelled = true; map.off("style.load", apply); map.off("idle", apply); };
  }, [ready, globe, darkMode, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) syncTerrain(map, terrainEnabled, profile);
  }, [ready, terrainEnabled, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.isStyleLoaded()) return;
    if (!buildingsEnabled) {
      for (const layer of map.getStyle().layers) {
        if (layer.type === "fill-extrusion") map.setLayoutProperty(layer.id, "visibility", "none");
      }
      return;
    }
    if (buildingStyleRef.current) {
      const { buildingSource, darkMode: styleDark, mapStyle: styleName } = buildingStyleRef.current;
      ensureBuildingLayer(map, buildingSource, styleDark, styleName, profile);
    }
    syncNativeBuildings(map, true);
  }, [ready, buildingsEnabled, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map?.getSource("km-routes")) setData(map, "km-routes", features);
  }, [ready, features]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !navigationActive || !validCoord(currentLocation)) return;
    map.easeTo({ center: [currentLocation[1], currentLocation[0]],
      zoom: Math.max(16, map.getZoom()), pitch: 60, duration: 450 });
  }, [ready, navigationActive, currentLocation]);

  useEffect(() => {
    const map = mapRef.current;
    const gl = glRef.current;
    if (!ready || !map || !gl) return;
    markers.current.forEach(m => m.remove());
    markers.current = [];
    const pin = (point, text, onDrag) => {
      if (!validCoord(point)) return;
      const marker = cameraMarker(gl, map, point, text, onDrag);
      if (onDrag) marker.on("dragend", () => { const p = marker.getLngLat(); onDrag([p.lat, p.lng]); });
      markers.current.push(marker);
    };
    if (!navigationActive) pin(startCoordinate || data?.start?.coordinates, "A", startDraggable ? callbackRef.current.onMoveStart : null);
    pin(destinationCoordinate || data?.end?.coordinates, "B", callbackRef.current.onMoveDestination);
    if (validCoord(currentLocation)) pin(currentLocation, "●");
    for (const vehicle of route?.live_vehicles || []) {
      if (!Number.isFinite(Number(vehicle.lat)) || !Number.isFinite(Number(vehicle.lon))) continue;
      if (!(route?.steps || []).some(step => step.type === "transit" && String(step.trip_id) === String(vehicle.trip_id))) continue;
      pin([vehicle.lat, vehicle.lon], "🚌");
    }
  }, [ready, route, startCoordinate, destinationCoordinate, currentLocation, data, navigationActive, startDraggable, startLabel, destinationLabel]);

  const previousFocus = useRef([locationFocusKey, routeFocusKey, stepFocusKey]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const old = previousFocus.current;
    previousFocus.current = [locationFocusKey, routeFocusKey, stepFocusKey];
    if (stepFocusKey !== old[2] && validCoord(stepFocusCoordinate)) {
      map.flyTo({ center: [stepFocusCoordinate[1], stepFocusCoordinate[0]], zoom: Math.max(17, map.getZoom()), essential: true });
    } else if (locationFocusKey !== old[0] && validCoord(currentLocation)) {
      map.flyTo({ center: [currentLocation[1], currentLocation[0]], zoom: 15, essential: true });
    } else if (routeFocusKey !== old[1]) {
      const line = route?.route_coordinates?.filter(validCoord) || [];
      if (line.length > 1) {
        const box = line.reduce((bounds, p) => bounds.extend([p[1], p[0]]), new glRef.current.LngLatBounds([line[0][1], line[0][0]], [line[0][1], line[0][0]]));
        map.fitBounds(box, { padding: 95, maxZoom: 16, duration: 850 });
      }
    }
  }, [ready, locationFocusKey, routeFocusKey, stepFocusKey, stepFocusCoordinate, currentLocation, route]);

  const layerList = enabledLayers.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const selected = new Set(layerList.split(",").filter(Boolean));
    let timer;
    let dead = false;
    let controller;
    const refreshed = new Map();
    const refresh = () => {
      if (dead || !map.getSource("km-routes")) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        controller?.abort();
        controller = new AbortController();
        const signal = controller.signal;
        const bounds = map.getBounds();
        const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
          .map(n => n.toFixed(4)).join(",");
        const zoom = map.getZoom();
        const tasks = Object.keys(FEED_COLORS).map(async kind => {
          const id = `km-511-${kind}`;
          if (!map.getSource(id)) return;
          if (!selected.has(kind) || zoom < (kind === "cameras" ? 12 : 9)) {
            if (refreshed.has(kind)) { setData(map, id, []); refreshed.delete(kind); }
            return;
          }
          const key = `${kind}:${bbox}`;
          const previous = refreshed.get(kind);
          if (previous && previous.key === key && Date.now() - previous.when < 20000) return;
          try {
            const res = await fetch(`/api/layers/ontario511?${new URLSearchParams({ kind, bbox })}`, { signal });
            if (!res.ok) throw new Error("Layer unavailable");
            const payload = await res.json();
            if (dead || signal.aborted || !map.getSource(id)) return;
            onLayerStatus(kind, payload.message || "");
            const features511 = [];
            for (const item of payload.items || []) {
              const properties = { id: item.id, title: item.title || kind,
                details: item.summary || item.details || "", direction: item.direction || "",
                impact: item.impact || "", lanes: item.lanes || "",
                closure: Boolean(item.closure), kind,
                images: kind === "cameras" ? JSON.stringify(item.images || []) : "[]" };
              if (validCoord(item.point)) features511.push({ type: "Feature",
                geometry: { type: "Point", coordinates: [item.point[1], item.point[0]] }, properties });
              for (const line of item.lines || []) {
                const geometry = geoLine(line);
                if (geometry) features511.push({ type: "Feature", geometry, properties });
              }
            }
            setData(map, id, features511);
            refreshed.set(kind, { key, when: Date.now() });
          } catch {
            if (!signal.aborted && !dead) onLayerStatus(kind, "Unable to load this layer");
          }
        });
        await Promise.all(tasks);
      }, profile.tier === "low" ? 650 : 350);
    };
    map.on("moveend", refresh);
    map.on("style.load", refresh);
    refresh();
    return () => { dead = true; clearTimeout(timer); controller?.abort();
      map.off("moveend", refresh); map.off("style.load", refresh); };
  }, [ready, layerList, mapStyle, darkMode, onLayerStatus, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let controller;
    let timer;
    const fetchStops = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        controller?.abort(); controller = new AbortController();
        if (!map.getSource("km-stops")) return;
        if (mode !== "transit" || map.getZoom() < 16) {
          map.__kmNearbyStops = [];
          setData(map, "km-stops", []); return;
        }
        const center = map.getCenter();
        const radius = map.getZoom() < 17 ? 1500 : map.getZoom() < 18 ? 1100 : 800;
        const query = new URLSearchParams({ lat: String(center.lat), lon: String(center.lng), radius: String(radius) });
        try {
          const result = await fetch(`/api/transit/stops?${query}`, { signal: controller.signal }).then(r => r.json());
          if (controller.signal.aborted || !map.getSource("km-stops")) return;
          const stops = (result.stops || []).filter(s => validCoord(s.coordinates)).slice(0, 150).map(stop => ({
            type: "Feature", geometry: { type: "Point", coordinates: [stop.coordinates[1], stop.coordinates[0]] },
            properties: { stop_id: stop.id, name: stop.name, agency: stop.agency || "grt" },
          }));
          map.__kmNearbyStops = stops;
          setData(map, "km-stops", stops);
        } catch (error) {
          if (error.name !== "AbortError") console.debug("Nearby stops unavailable", error);
        }
      }, 250);
    };
    map.on("moveend", fetchStops); map.on("style.load", fetchStops);
    fetchStops();
    return () => { controller?.abort(); clearTimeout(timer); map.off("moveend", fetchStops); map.off("style.load", fetchStops); };
  }, [ready, mode, mapStyle, darkMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !enabledLayers.includes("traffic")) return;
    let cancelled = false;
    let addTraffic;
    fetch("/api/layers/traffic/status").then(r => r.json()).then(info => {
      if (cancelled || !info.enabled) { if (!cancelled) onLayerStatus("traffic", info.message || "Unavailable"); return; }
      const add = () => {
        if (!map.getSource("km-routes") || map.getSource("km-traffic")) return;
        map.addSource("km-traffic", { type: "raster", tiles: [`/api/layers/traffic/tile/{z}/{x}/{y}.png?style=${darkMode ? "dark" : "light"}`], tileSize: 256, maxzoom: 20 });
        const before = map.getLayer("km-buildings-3d") ? "km-buildings-3d" : undefined;
        map.addLayer({ id: "km-traffic", type: "raster", source: "km-traffic", minzoom: 8, paint: { "raster-opacity": 0.85 } }, before);
      };
      addTraffic = add;
      map.on("style.load", add);
      add();
    }).catch(() => { if (!cancelled) onLayerStatus("traffic", "Unavailable"); });
    return () => {
      cancelled = true;
      if (addTraffic) map.off("style.load", addTraffic);
      if (map.getLayer("km-traffic")) map.removeLayer("km-traffic");
      if (map.getSource("km-traffic")) map.removeSource("km-traffic");
    };
  }, [ready, enabledLayers, darkMode, onLayerStatus]);

  return (
    <div className={`km-3d-scene absolute inset-0 ${darkMode ? "km-3d-dark" : ""}`}>
      <div ref={holder} className={`km-3d-map h-full w-full ${globe ? "km-3d-globe" : "km-3d-flat"}`} aria-label="Interactive 3D map" />
      {problem && <div className="km-3d-error"><span>{problem}</span><button onClick={onDisable3D} type="button">Back to 2D</button></div>}
      <div className="km-3d-tools" role="group" aria-label="3D map controls">
        <button type="button" className="km-3d-toggle" aria-pressed={terrainEnabled}
          title={`True 3D terrain elevation loads at map zoom ${TERRAIN_MIN_ZOOM}+`}
          onClick={() => setTerrainEnabled(value => !value)}>
          Terrain {terrainEnabled ? (zoom >= TERRAIN_MIN_ZOOM ? "On" : "Zoom in") : "Off"}
        </button>
        <button type="button" className="km-3d-toggle" aria-pressed={buildingsEnabled}
          title={`3D buildings appear from zoom ${profile.buildingZoom} (move closer to see them)`}
          onClick={() => setBuildingsEnabled(value => !value)}>
          Buildings {buildingsEnabled ? (zoom >= profile.buildingZoom ? "On" : "Zoom in") : "Off"}
        </button>
      </div>
    </div>
  );
}
