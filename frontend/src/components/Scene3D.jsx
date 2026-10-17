import { useEffect, useMemo, useRef, useState } from "react";

const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_KEY || "").trim();
const FREE = "https://tiles.openfreemap.org/styles/";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// Buildings are optional and are only drawn close to the ground. A large-city
// full-detail extrusion at zoom 14 can overwhelm an integrated GPU.
const BUILDING_MIN_ZOOM = 16.5;
const TERRAIN_MIN_ZOOM = 8;
const GLOBE_TERRAIN_MIN_ZOOM = 12;
const SPACE = "#070b14";
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
      sources: { ...freeStyle.sources, "km-satellite": { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri" } },
      layers: [imagery, ...roadLabels],
    },
    buildingSource: freeStyle.sources.openmaptiles,
    fallback: freeStyle,
  };
}

// Keep expensive elevation data off the world view; MapLibre's globe terrain
// is only reliable after its automatic transition towards Mercator at z~12.
function syncTerrain(map, globe) {
  if (!map.getSource("km-elevation")) return;
  const show = map.getZoom() >= (globe ? GLOBE_TERRAIN_MIN_ZOOM : TERRAIN_MIN_ZOOM);
  const current = map.getTerrain();
  if (show && !current) map.setTerrain({ source: "km-elevation", exaggeration: 1.1 });
  else if (!show && current) map.setTerrain(null);
}

function addSceneLayers(map, buildingSource, darkMode, mapStyle, buildingsEnabled) {
  // Reuse a basemap's vector tiles rather than loading the same city a second time.
  const style = map.getStyle();
  const native = style.layers.find(l => l["source-layer"] === "building" && style.sources?.[l.source]?.type === "vector");
  const existing = native?.source || (style.sources?.openmaptiles?.type === "vector" ? "openmaptiles" : null);
  const sourceId = existing || "km-buildings";
  if (!existing && buildingSource && !map.getSource(sourceId)) map.addSource(sourceId, { ...buildingSource, type: "vector" });
  // The original style may already contain 3D buildings.
  for (const layer of map.getStyle().layers) {
    if (layer.type === "fill-extrusion" && layer.id !== "km-buildings-3d") map.setLayoutProperty(layer.id, "visibility", "none");
  }
  if (!map.getLayer("km-buildings-3d")) {
    const before = map.getStyle().layers.find(layer => layer.type === "symbol")?.id;
    map.addLayer({
      id: "km-buildings-3d", type: "fill-extrusion", source: sourceId,
      "source-layer": native?.["source-layer"] || "building", minzoom: BUILDING_MIN_ZOOM,
      layout: { visibility: buildingsEnabled ? "visible" : "none" },
      // A single GPU-drawn vector extrusion layer, not per-building meshes.
      paint: {
        "fill-extrusion-base": ["coalesce", ["to-number", ["get", "render_min_height"]], 0],
        "fill-extrusion-height": ["coalesce", ["to-number", ["get", "render_height"]], ["to-number", ["get", "height"]], 8],
        "fill-extrusion-color": darkMode ? (mapStyle === "hybrid" ? "#8976a8" : "#72808c") : (mapStyle === "satellite" ? "#c3bbb0" : "#b6b9b3"),
        "fill-extrusion-opacity": 0.79,
      },
    }, before);
  }

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
  // Conservative defaults on low-memory devices; manually override via UI.
  const [buildingsEnabled, setBuildingsEnabled] = useState(() =>
    !(typeof navigator !== "undefined" && navigator.deviceMemory && navigator.deviceMemory <= 4));
  const buildingsRef = useRef(buildingsEnabled);
  const globeRef = useRef(globe);
  useEffect(() => {
    buildingsRef.current = buildingsEnabled;
    globeRef.current = globe;
  }, [buildingsEnabled, globe]);
  const mode = displayedMode || data?.mode || "driving";
  const route = selectedRoute || data?.routes?.find(r => r.route_number === selectedRouteNumber) || data?.routes?.[0];
  const camera = useRef(initialCamera || DEFAULT_CAMERA);
  const flatCamera = useRef(null);
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
        maxTileCacheSize: 36, attributionControl: true,
      });
      mapRef.current = map;
      map.addControl(new gl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), "top-right");
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      // Debounced updates avoid repeated expensive terrain changes during a pan.
      map.on("zoomend", () => syncTerrain(map, globeRef.current));
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
          map.setSky({
            "sky-color": darkMode ? "#162336" : "#b5cee8",
            "horizon-color": darkMode ? "#304252" : "#e4eef7",
            "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
          });
          addSceneLayers(map, buildingSource, darkMode, mapStyle, buildingsRef.current);
          setData(map, "km-routes", newestLines.current);
          syncTerrain(map, globeRef.current);
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
        layers: (base.layers || []).map(layer => {
          if (layer.id !== "Sea labels" || !layer.layout?.["text-size"]) return layer;
          const fixSize = value => Array.isArray(value) ? value.map(fixSize) : value == null ? 16 : value;
          return { ...layer, layout: { ...layer.layout,
            "text-size": fixSize(layer.layout["text-size"]) } };
        }),
        // Keep terrain available in street, satellite AND hybrid styles.
        sources: { ...base.sources,
          "km-elevation": { type: "raster-dem", tiles: [TERRAIN], tileSize: 256,
            maxzoom: 13, encoding: "terrarium", attribution: "Terrain: AWS Open Data" },
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
    const projection = globe ? "globe" : "mercator";
    map.setProjection({ type: projection });
    if (globe) {
      flatCamera.current = { center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
      map.easeTo({ zoom: Math.min(map.getZoom(), 3), pitch: 0, duration: 650 });
    } else if (flatCamera.current) {
      map.easeTo({ ...flatCamera.current, duration: 650 });
      flatCamera.current = null;
    }
    // A style change may still be pending; sync on its next style.load too.
    syncTerrain(map, globe);
  }, [ready, globe]);

  useEffect(() => {
    const map = mapRef.current;
    if (ready && map?.getLayer("km-buildings-3d"))
      map.setLayoutProperty("km-buildings-3d", "visibility", buildingsEnabled ? "visible" : "none");
  }, [ready, buildingsEnabled]);

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

  // Reuse the same Flask layer endpoints. Only request enabled layers in view.
  const layerList = enabledLayers.join(",");
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const selected = layerList.split(",").filter(Boolean);
    let requestId = 0;
    let timer;
    let dead = false;
    let controller;
    const refresh = () => {
      if (dead || !map.getSource("km-routes")) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        controller?.abort(); controller = new AbortController();
        const token = ++requestId;
        const b = map.getBounds();
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(n => n.toFixed(5)).join(",");
        for (const kind of Object.keys(FEED_COLORS)) {
          if (!map.getSource(`km-511-${kind}`)) continue;
          if (!selected.includes(kind) || map.getZoom() < (kind === "cameras" ? 12 : 9)) { setData(map, `km-511-${kind}`, []); continue; }
          try {
            const res = await fetch(`/api/layers/ontario511?${new URLSearchParams({ kind, bbox })}`, { signal: controller.signal });
            if (!res.ok) throw new Error("Layer unavailable");
            const payload = await res.json();
            if (dead || token !== requestId || !map.getSource(`km-511-${kind}`)) return;
            onLayerStatus(kind, payload.message || "");
            const features511 = [];
            for (const item of payload.items || []) {
              const properties = {
                id: item.id, title: item.title || kind,
                details: item.summary || item.impact || item.details || "", kind,
                images: kind === "cameras" ? JSON.stringify(item.images || []) : "[]",
              };
              if (validCoord(item.point)) features511.push({ type: "Feature", geometry: { type: "Point", coordinates: [item.point[1], item.point[0]] }, properties });
              for (const line of item.lines || []) {
                const geometry = geoLine(line);
                if (geometry) features511.push({ type: "Feature", geometry, properties });
              }
            }
            setData(map, `km-511-${kind}`, features511);
          } catch { if (!controller.signal.aborted) onLayerStatus(kind, "Unable to load this layer"); }
        }
      }, 300);
    };
    map.on("moveend", refresh);
    map.on("style.load", refresh);
    refresh();
    return () => { dead = true; clearTimeout(timer); controller?.abort(); map.off("moveend", refresh); map.off("style.load", refresh); };
  }, [ready, layerList, mapStyle, darkMode, onLayerStatus]);

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
        map.addLayer({ id: "km-traffic", type: "raster", source: "km-traffic", minzoom: 8, paint: { "raster-opacity": 0.85 } }, "km-buildings-3d");
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
      <button type="button" className="km-3d-tilt" onClick={() => {
        const map = mapRef.current;
        if (map) map.easeTo({ pitch: map.getPitch() < 15 ? 62 : 0, duration: 550 });
      }}>Tilt</button>
      <button type="button" className="km-3d-buildings" aria-pressed={buildingsEnabled}
        title="Extruded buildings appear at close zoom; disable if your device slows down"
        onClick={() => setBuildingsEnabled(v => !v)}>
        Buildings {buildingsEnabled ? "On" : "Off"}
      </button>
      <div className="km-3d-hint">Drag to move · Right-drag to rotate</div>
    </div>
  );
}
