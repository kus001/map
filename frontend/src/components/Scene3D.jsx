import { useEffect, useMemo, useRef, useState } from "react";

const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_KEY || "").trim();
const FREE = "https://tiles.openfreemap.org/styles/";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// Buildings are optional and are only drawn close to the ground. A large-city
// full-detail extrusion at zoom 14 can overwhelm an integrated GPU.
// DEM tiles are needed when regional contours start to be discernible. In the
// distant planet view they're both wasteful and imperceptible. The same terrain
// setting applies to Street, Satellite and Hybrid basemaps.
const TERRAIN_MIN_ZOOM = 7;
// The map is a GPU-intensive surface. Render fewer device pixels and fewer
// cached tiles on phones and integrated GPUs; don't wait for a crash to adapt.
function deviceProfile() {
  if (typeof navigator === "undefined") return { tier: "medium", pixelRatio: 1.25, tileCache: 20, buildingZoom: 17.5, demZoom: 11, shadeZoom: 7 };
  const memory = Number(navigator.deviceMemory) || 0;
  const cores = Number(navigator.hardwareConcurrency) || 0;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") || navigator.userAgentData?.mobile === true;
  const tier = mobile || (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4)
    ? "low" : (memory > 0 && memory <= 8) || (cores > 0 && cores <= 8) ? "medium" : "high";
  const ratio = Math.max(1, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  return {
    tier,
    pixelRatio: Math.min(ratio, tier === "low" ? 1 : tier === "medium" ? 1.35 : 1.7),
    tileCache: tier === "low" ? 12 : tier === "medium" ? 20 : 30,
    buildingZoom: tier === "low" ? 18 : tier === "medium" ? 17.5 : 16.5,
    demZoom: tier === "low" ? 10 : tier === "medium" ? 11 : 12,
    shadeZoom: tier === "low" ? 8 : 6,
  };
}

// MapLibre's sky API is different from Mapbox's fog API. Fade the planet halo
// before terrain is enabled, avoiding globe fog/terrain shader warnings.
function applyAtmosphere(map, darkMode, globe) {
  if (globe && map.getZoom() >= TERRAIN_MIN_ZOOM) {
    map.setSky(undefined);
    return;
  }
  map.setSky({
    "sky-color": darkMode ? "#243c5a" : "#8bc1ed",
    "horizon-color": darkMode ? "#6587a6" : "#e3f3ff",
    "fog-color": darkMode ? "#708da4" : "#d5e9f9",
    "sky-horizon-blend": 0.58,
    "horizon-fog-blend": 0.72,
    "fog-ground-blend": 0.22,
    "atmosphere-blend": globe
      ? ["interpolate", ["linear"], ["zoom"], 0, 1, 3, 1, 5, 0.9, TERRAIN_MIN_ZOOM, 0]
      : 0,
  });
}
const DEFAULT_CAMERA = { center: [-80.5249, 43.4829], zoom: 13, pitch: 58, bearing: 0 };
const COLOR = { driving: "#62876d", walking: "#e9f3ec", cycling: "#81b686", transit: "#b99aff" };
const FEED_COLORS = { incidents: "#db544d", construction: "#eb9d3c", cameras: "#478cc5", winter: "#7299cd" };
const freeStyleCache = new Map();

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
      // Keep 3D's MapLibre separate from the older Leaflet adapter used in 2D.
      const url = "https://unpkg.com/maplibre-gl@6.14.0/dist/maplibre-gl.mjs";
      const gl = await import(/* @vite-ignore */ url);
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

async function getStyle(mapStyle, darkMode, signal) {
  // We use one vector source for buildings in all three map modes.
  const freeName = darkMode ? "dark" : "liberty";
  let freeStyle = freeStyleCache.get(freeName);
  if (!freeStyle) {
    const response = await fetch(`${FREE}${freeName}`, { signal });
    if (!response.ok) throw new Error("The free map provider isn't responding");
    freeStyle = await response.json();
    // Do not cache failed/partial downloads; clone before handing styles to GL.
    if (freeStyle.version === 8 && freeStyle.sources?.openmaptiles)
      freeStyleCache.set(freeName, freeStyle);
  }
  freeStyle = structuredClone(freeStyle);
  if (freeStyle.version !== 8 || !freeStyle.sources?.openmaptiles) throw new Error("Unexpected map style data");

  const keyAllowed = MAPTILER_KEY && import.meta.env.VITE_MAP_PROVIDER !== "openfreemap";
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
      if (result.ok && result.headers.get("content-type")?.includes("json")) {
        const style = await result.json();
        if (style.version === 8 && style.sources && Array.isArray(style.layers)) return { style, buildingSource: freeStyle.sources.openmaptiles, fallback: satelliteFallback };
      }
    } catch (error) { if (signal.aborted) throw error; }
  }

  if (mapStyle === "street") return { style: freeStyle, buildingSource: freeStyle.sources.openmaptiles, fallback: freeStyle };

  // The satellite remains Esri in 3D, including its imagery when a key is absent.
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
      // Satellite needs raster imagery only. Avoid loading OpenMapTiles city
      // vectors unless buildings are deliberately enabled by the user.
      sources: { ...(mapStyle === "hybrid" ? freeStyle.sources : {}),
        "km-satellite": { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri" } },
      layers: [imagery, ...roadLabels],
    },
    buildingSource: freeStyle.sources.openmaptiles,
    fallback: freeStyle,
  };
}

// Limit expensive elevation requests at world scale, but retain real DEM-driven
// terrain in BOTH projections and all three basemap styles. This runs after
// style.load, after zoomend, and when the user changes the terrain toggle.
function syncTerrain(map, enabled, profile) {
  if (!map.getSource("km-elevation")) return;
  const shouldRender = enabled && map.getZoom() >= TERRAIN_MIN_ZOOM;
  const current = map.getTerrain();
  if (shouldRender && !current) map.setTerrain({ source: "km-elevation", exaggeration: profile.tier === "low" ? 1.25 : 1.45 });
  else if (!shouldRender && current) map.setTerrain(null);
  // Hillshade shows relief on all map styles even before the expensive 3D
  // terrain mesh becomes visible. Independent DEM sources avoid quality loss.
  if (map.getLayer("km-terrain-shading")) {
    map.setLayoutProperty("km-terrain-shading", "visibility", enabled ? "visible" : "none");
  }
}

function ensureBuildingLayer(map, buildingSource, darkMode, mapStyle, profile) {
  if (map.getLayer("km-buildings-3d")) {
    map.setLayoutProperty("km-buildings-3d", "visibility", "visible");
    return;
  }
  const style = map.getStyle();
  const native = style.layers.find(l => l["source-layer"] === "building" && style.sources?.[l.source]?.type === "vector");
  const existing = native?.source || (style.sources?.openmaptiles?.type === "vector" ? "openmaptiles" : null);
  const sourceId = existing || "km-buildings";
  // Do not request a second expensive vector tile source for satellite unless
  // buildings are actually switched on (phones default to off).
  if (!existing && buildingSource && !map.getSource(sourceId)) map.addSource(sourceId, { ...buildingSource, type: "vector" });
  if (!map.getSource(sourceId)) return;
  const before = map.getStyle().layers.find(layer => layer.type === "symbol")?.id;
  map.addLayer({
    id: "km-buildings-3d", type: "fill-extrusion", source: sourceId,
    "source-layer": native?.["source-layer"] || "building", minzoom: profile.buildingZoom,
    paint: {
      "fill-extrusion-base": ["coalesce", ["to-number", ["get", "render_min_height"]], 0],
      "fill-extrusion-height": ["coalesce", ["to-number", ["get", "render_height"]], ["to-number", ["get", "height"]], 8],
      "fill-extrusion-color": darkMode ? (mapStyle === "hybrid" ? "#8976a8" : "#72808c") : (mapStyle === "satellite" ? "#c3bbb0" : "#b6b9b3"),
      "fill-extrusion-opacity": 0.79,
    },
  }, before);
}

function addSceneLayers(map, buildingSource, darkMode, mapStyle, buildingsEnabled, terrainEnabled, profile) {
  // Hillshade is separate from terrain geometry. Place it after ground raster/
  // polygons but before roads and labels, so shading remains visible without
  // obscuring geographic labels. Low-end devices skip distant hillshade tiles.
  if (map.getSource("km-hillshade") && !map.getLayer("km-terrain-shading")) {
    const before = map.getStyle().layers.find(l => ["line", "symbol", "fill-extrusion"].includes(l.type))?.id;
    map.addLayer({
      id: "km-terrain-shading", type: "hillshade", source: "km-hillshade",
      minzoom: profile.shadeZoom, maxzoom: 16,
      layout: { visibility: terrainEnabled ? "visible" : "none" },
      paint: {
        "hillshade-exaggeration": profile.tier === "low" ? 0.45 : mapStyle === "satellite" ? 0.56 : 0.7,
        "hillshade-shadow-color": darkMode ? "#111c2c" : "#374b55",
        "hillshade-highlight-color": darkMode ? "#a4bdd7" : "#fff3dc",
        "hillshade-accent-color": darkMode ? "#30475d" : "#758b78",
        "hillshade-illumination-direction": 315,
      },
    }, before);
  }
  // Turn off expensive built-in extrusions in provider styles. Only draw our
  // single batched extrusion at close range when explicitly enabled.
  for (const layer of map.getStyle().layers) {
    if (layer.type === "fill-extrusion" && layer.id !== "km-buildings-3d") map.setLayoutProperty(layer.id, "visibility", "none");
  }
  if (buildingsEnabled) ensureBuildingLayer(map, buildingSource, darkMode, mapStyle, profile);

  addGeo(map, "km-stops");
  map.addLayer({ id: "km-stops-points", type: "circle", source: "km-stops", minzoom: 16,
    paint: { "circle-color": "#9b734b", "circle-radius": 5, "circle-opacity": 0.92,
      "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });

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

function cameraMarker(gl, map, latLng, label, onMove) {
  const element = document.createElement("div");
  element.className = "km-3d-pin";
  element.textContent = label;
  return new gl.Marker({ element, draggable: Boolean(onMove), anchor: "bottom" })
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
  const profile = useRef(deviceProfile()).current;
  const buildingStyleRef = useRef(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const terrainRef = useRef(true);
  // Conservative defaults on low-memory devices; manually override via UI.
  const [buildingsEnabled, setBuildingsEnabled] = useState(() => deviceProfile().tier === "high");
  const buildingsRef = useRef(buildingsEnabled);
  const globeRef = useRef(globe);
  const darkModeRef = useRef(darkMode);
  useEffect(() => {
    buildingsRef.current = buildingsEnabled;
    globeRef.current = globe;
    darkModeRef.current = darkMode;
    terrainRef.current = terrainEnabled;
  }, [buildingsEnabled, globe, terrainEnabled]);
  const mode = displayedMode || data?.mode || "driving";
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
        center: initial.center, zoom: initial.zoom, pitch: Math.max(35, initial.pitch || 58),
        bearing: initial.bearing || 0, maxZoom: 22, minZoom: 0, maxPitch: 85,
        antialias: false, fadeDuration: 0, renderWorldCopies: false,
        maxTileCacheSize: profile.tileCache, pixelRatio: profile.pixelRatio,
        maxCanvasSize: [2560, 2560], reduceMotion: profile.tier === "low",
        cancelPendingTileRequestsWhileZooming: true,
        attributionControl: true,
      });
      mapRef.current = map;
      map.addControl(new gl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), "top-right");
      map.dragRotate.enable(); // Right-drag: rotate horizontally, pitch vertically.
      map.touchZoomRotate.enableRotation();
      map.touchPitch?.enable(); // Two-finger tilt on phones and tablets.
      // In-browser instrumentation: sample actual rendered frames while moving.
      // If an integrated GPU cannot keep up, lower the device-pixel workload
      // (pixel count scales with DPR squared). Never force a continuous repaint.
      let lastFrame = 0;
      let samples = 0;
      let totalFrameMs = 0;
      let lastAdjustment = 0;
      map.on("render", () => {
        const now = performance.now();
        const moving = map.isMoving();
        if (!moving) { lastFrame = 0; return; }
        if (lastFrame) {
          const frameMs = now - lastFrame;
          if (frameMs < 150) { samples++; totalFrameMs += frameMs; }
        }
        lastFrame = now;
        if (samples < 45) return;
        const mean = totalFrameMs / samples;
        if (typeof window !== "undefined") {
          window.__kmaps3DStats = { tier: profile.tier, frameMs: Math.round(mean * 10) / 10,
            movingFps: Math.round(1000 / mean), pixelRatio: map.getPixelRatio(), samples };
        }
        // Require a genuinely slow run and space adjustments apart; reduce
        // the expensive canvas first, rather than disabling terrain/buildings.
        if (mean > 30 && now - lastAdjustment > 6000 && map.getPixelRatio() > 1.01) {
          map.setPixelRatio(Math.max(1, Math.round((map.getPixelRatio() - 0.25) * 100) / 100));
          lastAdjustment = now;
        }
        samples = 0; totalFrameMs = 0;
      });
      // Avoid expensive DEM setup during continuous zooming; sync after zoom.
      map.on("zoomend", () => {
        setZoom(map.getZoom());
        syncTerrain(map, terrainRef.current, profile);
        applyAtmosphere(map, darkModeRef.current, globeRef.current);
      });
      // Some third-party basemaps refer to icons missing from their sprite.
      // Provide a transparent placeholder instead of repeatedly warning/rendering errors.
      map.on("styleimagemissing", event => {
        const id = event.id;
        if ((id === " " || id === "transportation:road_") && !map.hasImage(id)) {
          map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
        }
      });
      map.on("moveend", () => callbackRef.current.onCameraChange?.({
        center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
      }));
      map.on("contextmenu", event => {
        event.preventDefault();
        const root = document.createElement("div");
        root.className = "km-3d-picker";
        for (const [label, action] of [["Set as start", "onSetMapStart"], ["Set as destination", "onSetMapDestination"]]) {
          const button = document.createElement("button"); button.type = "button"; button.textContent = label;
          button.onclick = () => { callbackRef.current[action]?.([event.lngLat.lat, event.lngLat.lng]); popup.remove(); };
          root.appendChild(button);
        }
        const popup = new gl.Popup({ closeOnClick: true }).setLngLat(event.lngLat).setDOMContent(root).addTo(map);
      });
      map.on("click", event => {
        const ids = ["km-route-lines", "km-stops-points",
          ...Object.keys(FEED_COLORS).flatMap(kind => [`km-511-${kind}-points`, `km-511-${kind}-lines`])]
          .filter(id => map.getLayer(id));
        if (!ids.length) return;
        const hit = map.queryRenderedFeatures(event.point, { layers: ids })[0];
        if (!hit) return;
        const props = hit.properties || {};
        if (hit.layer.id === "km-route-lines") {
          const number = Number(props.routeNumber);
          if (Number.isFinite(number)) callbackRef.current.onSelectRoute?.(number);
          return;
        }
        if (hit.layer.id === "km-stops-points") {
          const body = document.createElement("div");
          body.className = "km-3d-info";
          const title = document.createElement("strong"); title.textContent = props.name || "Transit stop";
          body.appendChild(title);
          const schedule = document.createElement("div"); schedule.textContent = "Loading departures…";
          body.appendChild(schedule);
          const popup = new gl.Popup({ maxWidth: "290px" }).setLngLat(event.lngLat).setDOMContent(body).addTo(map);
          const req = new AbortController();
          popup.on("close", () => req.abort());
          fetch(`/api/transit/stop-board?${new URLSearchParams({ stop_id: props.stop_id, limit: "8" })}`, { signal: req.signal })
            .then(r => r.json()).then(info => {
              if (req.signal.aborted) return;
              schedule.replaceChildren();
              for (const item of info.departures || []) {
                const row = document.createElement("div");
                row.className = "km-3d-departure";
                row.textContent = `${item.route || "Transit"}  ${item.expected_time || item.scheduled_time || ""}`;
                schedule.appendChild(row);
              }
              if (!schedule.childNodes.length) schedule.textContent = info.error || "No upcoming departures";
            }).catch(() => { if (!req.signal.aborted) schedule.textContent = "Departures unavailable"; });
          return;
        }
        const body = document.createElement("div"); body.className = "km-3d-info";
        const title = document.createElement("strong"); title.textContent = props.title || "Road update";
        body.appendChild(title);
        if (props.details) {
          const summary = document.createElement("p"); summary.textContent = props.details;
          body.appendChild(summary);
        }
        if (props.kind === "cameras") {
          let images = [];
          try { images = JSON.parse(props.images || "[]"); } catch { /* old camera records */ }
          if (images.length) {
            let index = 0;
            const photo = document.createElement("img"); photo.className = "km-3d-photo";
            const caption = document.createElement("small");
            const bar = document.createElement("div"); bar.className = "km-3d-camera-controls";
            const previous = document.createElement("button"); previous.textContent = "‹";
            const next = document.createElement("button"); next.textContent = "›";
            const show = () => {
              // Force a new still at a reasonable interval while the popup is open.
              // These provider snapshots are not actual video streams.
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
            const timer = setInterval(() => { index = (index + 1) % images.length; show(); }, 30000);
            const popup = new gl.Popup({ maxWidth: "300px" }).setLngLat(event.lngLat).setDOMContent(body).addTo(map);
            popup.on("close", () => clearInterval(timer));
            return;
          }
        }
        new gl.Popup({ maxWidth: "290px" }).setLngLat(event.lngLat).setDOMContent(body).addTo(map);
      });
      setReady(true);
    }).catch(error => { if (active) setProblem(error.message); });
    const styles = stylesRef;
    return () => {
      active = false; styles.current++;
      markers.current.forEach(marker => marker.remove()); markers.current = [];
      map?.remove();
      if (typeof window !== "undefined") delete window.__kmaps3DStats;
      if (mapRef.current === map) mapRef.current = null;
    };
  }, []);

  // Keep the camera. Calling setStyle() doesn't reset it.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const controller = new AbortController();
    const version = ++stylesRef.current;
    let onProviderError;
    let styleInstall;
    setProblem("");
    getStyle(mapStyle, darkMode, controller.signal).then(({ style, buildingSource, fallback }) => {
      if (controller.signal.aborted || stylesRef.current !== version) return;
      const install = () => {
        if (controller.signal.aborted || stylesRef.current !== version) return;
        try {
          map.setProjection({ type: globeRef.current ? "globe" : "mercator" });
          applyAtmosphere(map, darkMode, globeRef.current);
          buildingStyleRef.current = { buildingSource, darkMode, mapStyle };
          addSceneLayers(map, buildingSource, darkMode, mapStyle,
            buildingsRef.current, terrainRef.current, profile);
          setData(map, "km-routes", newestLines.current);
          syncTerrain(map, terrainRef.current, profile);
        } catch (error) { console.warn("3D map layers:", error); setProblem("Some 3D layers couldn't load"); }
      };
      styleInstall = install;
      map.on("style.load", install);
      let styleFailures = 0;
      const providerFailure = event => {
        if (style === fallback || !/maptiler/i.test(String(event.error?.message || event.message || ""))) return;
        styleFailures++;
        if (styleFailures < 2) return;
        map.off("error", providerFailure);
        map.setStyle(prepare(fallback), { diff: false });
      };
      onProviderError = providerFailure;
      map.on("error", providerFailure);
      const prepare = base => ({
        ...base,
        // Fix malformed expression branches in some provider label styles.
        layers: (base.layers || []).filter(layer => {
          // Keep roads, transit labels and towns, but discard dense, tiny
          // points-of-interest glyphs on phones / integrated GPUs.
          if (profile.tier !== "low" || layer.type !== "symbol") return true;
          return !/poi|housenumber|house.number|address.label/i.test(layer.id);
        }).map(layer => {
          if (layer.id !== "Sea labels" || !layer.layout?.["text-size"]) return layer;
          const fixSize = value => Array.isArray(value) ? value.map(fixSize) : value == null ? 16 : value;
          return { ...layer, layout: { ...layer.layout,
            "text-size": fixSize(layer.layout["text-size"]) } };
        }),
        // Keep terrain available in street, satellite AND hybrid styles.
        sources: { ...base.sources,
          "km-elevation": { type: "raster-dem", tiles: [TERRAIN], tileSize: 256,
            maxzoom: profile.demZoom, encoding: "terrarium", attribution: "Terrain: AWS Open Data" },
          "km-hillshade": { type: "raster-dem", tiles: [TERRAIN], tileSize: 256,
            maxzoom: profile.tier === "low" ? 9 : 11, encoding: "terrarium" },
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
      if (onProviderError) map.off("error", onProviderError);
      if (styleInstall) map.off("style.load", styleInstall);
    };
    // Line data changes shouldn't rebuild the whole basemap.
  }, [ready, mapStyle, darkMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (previousGlobe.current !== globe) {
      previousGlobe.current = globe;
      // A globe is a projection, not a different zoom preset. Preserve the
      // camera without easeTo/flyTo or a trip out to zoom level 3.
      const view = { center: map.getCenter(), zoom: map.getZoom(),
        pitch: map.getPitch(), bearing: map.getBearing() };
      map.setProjection({ type: globe ? "globe" : "mercator" });
      if (Math.abs(map.getZoom() - view.zoom) > 0.001) map.jumpTo(view);
    }
    applyAtmosphere(map, darkMode, globe);
    syncTerrain(map, terrainRef.current, profile);
  }, [ready, globe, darkMode, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map) syncTerrain(map, terrainEnabled, profile);
  }, [ready, terrainEnabled, profile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!buildingsEnabled) {
      if (map.getLayer("km-buildings-3d")) map.setLayoutProperty("km-buildings-3d", "visibility", "none");
      return;
    }
    // Lazy load city vector data only when the user enables buildings.
    if (buildingStyleRef.current && map.getSource("km-elevation")) {
      const { buildingSource, darkMode: styleDark, mapStyle: styleName } = buildingStyleRef.current;
      ensureBuildingLayer(map, buildingSource, styleDark, styleName, profile);
    }
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

  // Route cards and the focus controls work in either renderer.
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

  // Fetch only enabled Ontario 511 layers inside the viewport. Parallel
  // requests avoid a 4x serial latency penalty; delayed/aborted moves don't
  // queue a backlog of stale GeoJSON/CPU work.
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
                details: item.summary || item.impact || item.details || "", kind,
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
          setData(map, "km-stops", []); return;
        }
        const center = map.getCenter();
        const query = new URLSearchParams({ lat: String(center.lat), lon: String(center.lng), radius: "650" });
        try {
          const result = await fetch(`/api/transit/stops?${query}`, { signal: controller.signal }).then(r => r.json());
          if (controller.signal.aborted || !map.getSource("km-stops")) return;
          const stops = (result.stops || []).filter(s => validCoord(s.coordinates)).slice(0, 150).map(stop => ({
            type: "Feature", geometry: { type: "Point", coordinates: [stop.coordinates[1], stop.coordinates[0]] },
            properties: { stop_id: stop.id, name: stop.name },
          }));
          setData(map, "km-stops", stops);
        } catch { /* No nearby stop data */ }
      }, 250);
    };
    map.on("moveend", fetchStops); map.on("style.load", fetchStops);
    fetchStops();
    return () => { controller?.abort(); clearTimeout(timer); map.off("moveend", fetchStops); map.off("style.load", fetchStops); };
  }, [ready, mode, mapStyle, darkMode]);

  // The traffic raster also works in the 3D view; it is kept separate from the elevation data.
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
    <div className="km-3d-scene absolute inset-0">
      <div ref={holder} className="km-3d-map h-full w-full" aria-label="Interactive 3D map" />
      {problem && <div className="km-3d-error"><span>{problem}</span><button onClick={onDisable3D} type="button">Back to 2D</button></div>}
      <div className="km-3d-tools" role="group" aria-label="3D map controls">
        <button type="button" className="km-3d-toggle" aria-pressed={terrainEnabled}
          title={`True 3D terrain elevation loads at map zoom ${TERRAIN_MIN_ZOOM}+`}
          onClick={() => setTerrainEnabled(value => !value)}>
          Terrain {terrainEnabled ? (zoom >= TERRAIN_MIN_ZOOM ? "On" : "Zoom in") : "Off"}
        </button>
        <button type="button" className="km-3d-toggle" aria-pressed={buildingsEnabled}
          title="Buildings are rendered only when zoomed in closely, to protect performance"
          onClick={() => setBuildingsEnabled(value => !value)}>
          Buildings {buildingsEnabled ? "On" : "Off"}
        </button>
      </div>
      <div className="km-3d-hint">Drag to move · Right-drag to rotate and tilt · Two-finger tilt on touch</div>
    </div>
  );
}
