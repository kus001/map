import Ontario511Layer from "./Ontario511Layer.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
  ZoomControl,
} from "react-leaflet";
import L from "leaflet";
import FreeMapLayer from "./FreeMapLayer";
import { vehicleSpecs } from "../utils/format.js";

import "leaflet/dist/leaflet.css";

const KEY_FROM_ENV = (import.meta.env.VITE_MAPTILER_KEY || "").trim();
const MAPTILER_KEY = ["", "undefined", "null", "none"].includes(KEY_FROM_ENV.toLowerCase()) ? "" : KEY_FROM_ENV;
const USE_MAPTILER = Boolean(MAPTILER_KEY) && import.meta.env.VITE_MAP_PROVIDER !== "openfreemap";

function mapTilerStyle(mapStyle, darkMode) {
  if (mapStyle === "satellite") return null;
  if (mapStyle === "hybrid") return darkMode ? "hybrid-v4-dark" : "hybrid-v4";
  return darkMode ? "streets-v4-dark" : "streets-v4";
}

async function validMapTilerStyle(styleId, signal) {
  const url = `https://api.maptiler.com/maps/${styleId}/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`;
  const res = await fetch(url, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok || !res.headers.get("content-type")?.includes("json")) return false;
  const style = await res.json();
  return style?.version === 8 && Array.isArray(style.layers) && !!style.sources;
}


// maptiler sometimes returns an error picture instead of a tile
function isMapTilerErrorTile(tile) {
  if (!tile?.complete || !tile.naturalWidth) return false;
  try {
    const ctx = getImageContext(128);
    if (!ctx) return false;
    ctx.drawImage(tile, 0, 0, 128, 128);
    const pixels = ctx.getImageData(0, 0, 128, 128).data;
    let pale = 0, white = 0, grey = 0, ink = 0;
    const near = (r, g, b, x, y, z) =>
      Math.abs(r - x) <= 3 && Math.abs(g - y) <= 3 && Math.abs(b - z) <= 3;
    for (let i = 0; i < pixels.length; i += 16) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (near(r, g, b, 249, 250, 251)) pale++;
      if (near(r, g, b, 255, 255, 255)) white++;
      if (near(r, g, b, 210, 215, 222)) grey++;
      if (r < 80 && b > r + 10) ink++;
    }
    const count = pixels.length / 16;
    return pale / count > 0.48 && white / count > 0.10 &&
      (grey / count > 0.025 || ink / count > 0.008);
  } catch {
    imageCanvases.delete(128);
    return false;
  }
}
const SATELLITE_NATIVE_ZOOM = 19;
const MAP_MAX_ZOOM = 22;
const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const EMPTY_TILE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const satTileCache = new Map();
const imageCanvases = new Map();

function getImageContext(size) {
  if (imageCanvases.has(size)) return imageCanvases.get(size);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context) imageCanvases.set(size, context);
  return context;
}


// check a block of tiles at once so we dont spam esri
async function hasSatelliteTile(coords) {
  const size = 8;
  const left = Math.floor(coords.x / size) * size;
  const top = Math.floor(coords.y / size) * size;
  const key = `${coords.z}:${top}:${left}`;
  let cached = satTileCache.get(key);

  if (!cached || cached.expires < Date.now()) {
    const url = `${ESRI_IMAGERY}/tilemap/${coords.z}/${top}/${left}/${size}/${size}?f=json`;
    const request = fetch(url, { signal: AbortSignal.timeout(2500) })
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);
    cached = { request, expires: Date.now() + 5 * 60 * 1000 };
    const entry = cached;
    request.then(info => { if (!info) entry.expires = Date.now() + 15000; });
    satTileCache.set(key, cached);
    if (satTileCache.size > 120) satTileCache.delete(satTileCache.keys().next().value);
  }

  const info = await cached.request;
  if (!info?.data || !info.location) return false;
  const { left: x, top: y, width, height } = info.location;
  const column = coords.x - x;
  const row = coords.y - y;
  return column >= 0 && row >= 0 && column < width && row < height &&
    info.data[row * width + column] === 1;
}

function missingSatelliteImage(tile) {
  try {
    const ctx = getImageContext(32);
    if (!ctx) return false;
    ctx.drawImage(tile, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let grey = 0, white = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r >= 185 && r <= 225 && Math.abs(r - g) < 5 && Math.abs(g - b) < 5) grey++;
      if (r > 240 && g > 240 && b > 240) white++;
    }
    return grey > 0.78 * 1024 && (white > 0.005 * 1024 || grey > 0.96 * 1024);
  } catch {
    imageCanvases.delete(32);
    return false;
  }
}

function SatelliteDetails() {
  const map = useMap();

  useEffect(() => {
    const SharpTile = L.TileLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("img");
        tile.alt = "";
        tile.setAttribute("role", "presentation");
        tile.crossOrigin = "anonymous";
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          done(null, tile);
        };
        const blank = () => {
          tile.onload = finish;
          tile.onerror = finish;
          tile.src = EMPTY_TILE;
        };
        tile.onload = () => {
          if (missingSatelliteImage(tile)) blank();
          else finish();
        };
        tile.onerror = blank;

        hasSatelliteTile(coords).then(found => {
          if (found) tile.src = `${this.getTileUrl(coords)}?blankTile=false`;
          else blank();
        }).catch(blank);
        return tile;
      },
    });


    const layers = [20, 21, 22].map(level => new SharpTile(`${ESRI_IMAGERY}/tile/{z}/{y}/{x}`, {
      minZoom: level,
      maxZoom: MAP_MAX_ZOOM,
      maxNativeZoom: level,
      zIndex: level,
      updateWhenZooming: false,
      keepBuffer: 1,
    }).addTo(map));

    return () => layers.forEach(layer => map.removeLayer(layer));
  }, [map]);

  return null;
}
const DEFAULT_CENTER = [43.4829, -80.5249];
// first view: neighbourhood-level for a real position, city-level for an approximate one
const PRECISE_ZOOM = 14;
const APPROX_ZOOM = 12;
const DEFAULT_ZOOM = 13;

const MODE_COLORS = {
  driving: "#66856B",
  walking: "#2F3E46",
  cycling: "#4F7455",
  transit: "#8A6F4D",
};

const EV_CHARGER_ICON = L.divIcon({
  className: "", iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -18],
  html: '<span style="display:grid;place-items:center;width:30px;height:30px;border:2px solid white;border-radius:10px;background:#059669;color:white;box-shadow:0 2px 6px #0005;font-size:20px;font-weight:700">⚡</span>'
});
const BUS_LIVE_ICON = L.icon({ iconUrl: "/icons/bus-live.svg", iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] });
const BUS_SCHEDULED_ICON = L.icon({ iconUrl: "/icons/bus-scheduled.svg", iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] });

const START_ICON = L.divIcon({
  className: "map-route-marker-shell",
  html: '<div class="map-route-marker map-route-marker-start">A</div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
});

const END_ICON = L.divIcon({
  className: "map-route-marker-shell",
  html: '<div class="map-route-marker map-route-marker-end">B</div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
});

function validCoordinate(coordinate) {
  return (
    Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    Number.isFinite(Number(coordinate[0])) &&
    Number.isFinite(Number(coordinate[1]))
  );
}

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };


function visibleOffset(insets) {
  return [(insets.left - insets.right) / 2, (insets.top - insets.bottom) / 2];
}


// offset the camera so the sidebar doesnt cover the route
function centeredTarget(map, latlng, zoom, insets) {
  const [dx, dy] = visibleOffset(insets);
  if (!dx && !dy) {
    return L.latLng(latlng);
  }
  return map.unproject(map.project(latlng, zoom).subtract([dx, dy]), zoom);
}


function MapInsetEffect({ insets }) {
  const map = useMap();
  const previous = useRef(insets);

  useEffect(() => {
    const [px, py] = visibleOffset(previous.current);
    const [nx, ny] = visibleOffset(insets);
    previous.current = insets;
    const dx = nx - px;
    const dy = ny - py;
    if (dx || dy) {
      map.panBy([-dx, -dy], { animate: true, duration: 0.3 });
    }
  }, [map, insets]);

  return null;
}

function MapCameraSync({ onCameraChange, registerCameraGetter }) {
  const map = useMap();
  const callback = useRef(onCameraChange);
  useEffect(() => { callback.current = onCameraChange; }, [onCameraChange]);
  const readCamera = () => {
    const center = map.getCenter();
    return { center: [center.lng, center.lat], zoom: map.getZoom(), pitch: 32, bearing: 0 };
  };
  useMapEvents({ moveend: () => callback.current?.(readCamera()) });
  useEffect(() => {
    callback.current?.(readCamera());
  }, [map]);
  useEffect(() => {
    // The parent can read a fresh camera even in the middle of an animated
    // Leaflet pan/zoom; cleanup unregisters the getter on unmount.
    registerCameraGetter?.(readCamera);
    return () => registerCameraGetter?.(null);
  }, [map, registerCameraGetter]);
  return null;
}

function RestoreCameraFrom3D({ camera }) {
  const map = useMap();
  useEffect(() => {
    if (!camera || !validCoordinate([camera.center?.[1], camera.center?.[0]]) || !Number.isFinite(camera.zoom)) return;
    // Wait one paint for the hidden Leaflet container to become visible again.
    // Keep the same map instance, tiles, overlays and event handlers.
    const frame = requestAnimationFrame(() => {
      map.stop();
      map.invalidateSize({ pan: false });
      const zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), camera.zoom));
      map.setView([camera.center[1], camera.center[0]], zoom, { animate: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [map, camera]);
  return null;
}

function MapResizeEffect() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    let frame = null;

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }));
    });

    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [map]);

  return null;
}

function MapThemeEffect({ darkMode, mapStyle }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    container.classList.toggle("map-dark-ui", darkMode);
    container.classList.toggle(
      "dark-satellite-map",
      darkMode && mapStyle === "satellite"
    );

    return () => {
      container.classList.remove("map-dark-ui", "dark-satellite-map");
    };
  }, [map, darkMode, mapStyle]);

  return null;
}

// The map opens near the visitor without waiting for a permission prompt. The location can
// arrive just after the map mounts (first visit, nothing cached; or the browser's real
// position finishing), so move there once more - but only while nobody has moved the map
// (the user, a route fitting itself, "find me") and only if this is a fresh map rather
// than one coming back with its saved camera (e.g. after leaving 3D).
function InitialLocationCenter({ currentLocation, approxLocation, initialCamera }) {
  const map = useMap();
  const resumed = useRef(Boolean(initialCamera));
  const ownMove = useRef(false);
  const moved = useRef(false);

  useMapEvents({
    movestart() {
      if (!ownMove.current) moved.current = true;
    },
  });

  useEffect(() => {
    if (resumed.current || moved.current) return;
    const precise = validCoordinate(currentLocation);
    const target = precise ? currentLocation : approxLocation;
    if (!validCoordinate(target)) return;

    const lat = Number(target[0]);
    const lon = Number(target[1]);
    const center = map.getCenter();
    if (Math.abs(center.lat - lat) < 0.005 && Math.abs(center.lng - lon) < 0.005) return;

    ownMove.current = true;
    try {
      map.setView([lat, lon], precise ? PRECISE_ZOOM : APPROX_ZOOM, { animate: false });
    } finally {
      ownMove.current = false;
    }
  }, [map, currentLocation, approxLocation]);

  return null;
}

function MapEffects({
  routeCoordinates,
  currentLocation,
  locationFocusKey,
  routeFocusKey,
  stepFocusCoordinate,
  stepFocusKey,
  insets,
}) {
  const map = useMap();
  const previousLocationFocusKey = useRef(locationFocusKey);
  const previousRouteFocusKey = useRef(routeFocusKey);
  const previousStepFocusKey = useRef(stepFocusKey);

  useEffect(() => {
    if (locationFocusKey === previousLocationFocusKey.current) {
      return;
    }

    previousLocationFocusKey.current = locationFocusKey;

    if (!validCoordinate(currentLocation)) {
      return;
    }

    map.flyTo(
      centeredTarget(
        map,
        [Number(currentLocation[0]), Number(currentLocation[1])],
        15,
        insets
      ),
      15,
      {
        animate: true,
        duration: 0.9,
      }
    );
  }, [map, currentLocation, locationFocusKey, insets]);

  useEffect(() => {
    if (routeFocusKey === previousRouteFocusKey.current) {
      return;
    }

    previousRouteFocusKey.current = routeFocusKey;

    const safeRouteCoordinates = (routeCoordinates ?? []).filter(validCoordinate);
    if (safeRouteCoordinates.length < 2) {
      return;
    }

    const bounds = L.latLngBounds(safeRouteCoordinates);
    map.flyToBounds(bounds, {
      paddingTopLeft: [58 + insets.left, 58 + insets.top],
      paddingBottomRight: [58 + insets.right, 58 + insets.bottom],
      maxZoom: 16,
      animate: true,
      duration: 1.1,
      easeLinearity: 0.25,
    });
  }, [map, routeCoordinates, routeFocusKey, insets]);

  useEffect(() => {
    if (stepFocusKey === previousStepFocusKey.current) {
      return;
    }

    previousStepFocusKey.current = stepFocusKey;

    if (!validCoordinate(stepFocusCoordinate)) {
      return;
    }

    const zoom = Math.max(map.getZoom(), 17);
    map.flyTo(
      centeredTarget(
        map,
        [Number(stepFocusCoordinate[0]), Number(stepFocusCoordinate[1])],
        zoom,
        insets
      ),
      zoom,
      {
        animate: true,
        duration: 0.75,
      }
    );
  }, [map, stepFocusCoordinate, stepFocusKey, insets]);

  return null;
}

function NavigationFollow({ active, location, insets }) {
  const map = useMap();
  const started = useRef(false);

  useEffect(() => {
    if (!active) {
      started.current = false;
      return;
    }

    if (!validCoordinate(location)) {
      return;
    }

    const target = [Number(location[0]), Number(location[1])];
    if (!started.current) {
      started.current = true;
      const zoom = Math.max(map.getZoom(), 17);
      map.flyTo(centeredTarget(map, target, zoom, insets), zoom, {
        animate: true,
        duration: 0.8,
      });
      return;
    }

    map.panTo(centeredTarget(map, target, map.getZoom(), insets), {
      animate: true,
      duration: 0.45,
    });
  }, [map, active, location, insets]);

  return null;
}

function MapPointPicker({ darkMode, onSetStart, onSetDestination }) {
  const [point, setPoint] = useState(null);

  useMapEvents({
    contextmenu(event) {
      event.originalEvent?.preventDefault?.();
      setPoint([event.latlng.lat, event.latlng.lng]);
    },
  });

  if (!validCoordinate(point)) {
    return null;
  }

  return (
    <Popup
      position={point}
      eventHandlers={{ remove: () => setPoint(null) }}
      className="map-picker-popup"
    >
      <div className="min-w-[150px]">
        <div className="mb-2 text-xs font-semibold">Use this location</div>
        <div className="grid gap-1.5">
          <button
            type="button"
            onClick={() => {
              onSetStart(point);
              setPoint(null);
            }}
            className={`rounded-md px-2.5 py-1.5 text-left text-xs font-semibold transition ${
              darkMode
                ? "bg-charcoal-light text-darkmode-gray hover:bg-blue/20"
                : "bg-slate-100 text-charcoal hover:bg-green/15"
            }`}
          >
            Set as start
          </button>
          <button
            type="button"
            onClick={() => {
              onSetDestination(point);
              setPoint(null);
            }}
            className={`rounded-md px-2.5 py-1.5 text-left text-xs font-semibold transition ${
              darkMode
                ? "bg-charcoal-light text-darkmode-gray hover:bg-blue/20"
                : "bg-slate-100 text-charcoal hover:bg-green/15"
            }`}
          >
            Set as destination
          </button>
        </div>
        <div className="mt-2 text-[10px] opacity-60">
          {Number(point[0]).toFixed(5)}, {Number(point[1]).toFixed(5)}
        </div>
      </div>
    </Popup>
  );
}

export function StopBoard({ stop }) {
  const [board, setBoard] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ stop_id: stop.id, limit: "8" });
    fetch(`/api/transit/stop-board?${query}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        return response.ok ? result : { error: result.error || "Departures unavailable" };
      })
      .then(setBoard)
      .catch(error => {
        if (error.name !== "AbortError") setBoard({ error: "Could not load departures" });
      });
    return () => controller.abort();
  }, [stop.id]);

  const departures = board?.departures || [];
  return (
    <div className="stop-board min-w-[230px] text-slate-900">
      <div className="text-sm font-bold leading-snug">{stop.name}</div>
      <div className="mt-1 text-xs text-slate-600">
        {stop.agency_label || String(stop.agency || "").toUpperCase()} · Departures
      </div>
      {!board && <div className="mt-3 text-xs">Loading times…</div>}
      {board?.error && <div className="mt-3 text-xs text-amber-800">{board.error}</div>}
      {board && !board.error && departures.length === 0 && (
        <div className="mt-3 text-xs text-slate-700">No departures listed for this stop right now.</div>
      )}
      {departures.length > 0 && (
        <div className="mt-2 max-h-60 space-y-1.5 overflow-y-auto">
          {departures.map((item, i) => (
            <div key={`${item.trip_id}-${i}`} className="rounded-lg bg-slate-100 px-2.5 py-2 text-xs">
              <div className="flex justify-between gap-2 font-semibold">
                <span>{item.route} {item.direction ? `→ ${item.direction}` : ""}</span>
                <span className="whitespace-nowrap">{item.expected_time || item.scheduled_time}</span>
              </div>
              {item.boarding_stop && (
                <div className="mt-1 text-[11px] text-slate-700">Nearby boarding stop: {item.boarding_stop}</div>
              )}
              <div className="mt-1 text-[11px] text-slate-700">
                {item.cancelled ? "Cancelled" : item.realtime ? "Live" : "Scheduled"}
                {item.delay_min >= 1 ? ` · +${Math.round(item.delay_min)} min` : ""}
                {Number.isFinite(item.minutes_until) ? ` · in ${Math.max(0, item.minutes_until)} min` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TransitStopMarker({ stop, showDot }) {
  const [open, setOpen] = useState(false);
  return (
    <CircleMarker
      center={stop.coordinates}
      radius={showDot ? 5 : 12}
      pathOptions={{
        color: showDot ? "#FFFFFF" : "transparent",
        weight: showDot ? 1.5 : 0,
        fillColor: "#8A6F4D",
        fillOpacity: showDot ? 0.9 : 0,
      }}
      eventHandlers={{
        popupopen: () => setOpen(true),
        popupclose: () => setOpen(false),
        click: event => L.DomEvent.stopPropagation(event.originalEvent),
      }}
    >
      <Popup className="transit-board-popup" minWidth={265} maxWidth={330}>
        {open ? <StopBoard stop={stop} /> : null}
      </Popup>
    </CircleMarker>
  );
}

// combine nearby stops with route stops, skip duplicates
function TransitStops({ enabled, selectedStops = [], mapStyle }) {
  const map = useMap();
  const [viewport, setViewport] = useState(() => {
    const center = map.getCenter();
    return { lat: center.lat, lon: center.lng, zoom: map.getZoom() };
  });
  const [nearby, setNearby] = useState([]);
  const [tileStop, setTileStop] = useState(null);

  const stops = useMemo(() => {
    const combined = [];
    const ids = new Set();
    const cells = new Map();
    const cellKey = (lat, lon) => `${lat}:${lon}`;
    for (const stop of [...selectedStops, ...nearby]) {
      if (!validCoordinate(stop.coordinates) || ids.has(stop.id)) continue;
      const latitude = Math.floor(Number(stop.coordinates[0]) * 5000);
      const longitude = Math.floor(Number(stop.coordinates[1]) * 5000);
      let duplicate = false;
      for (let latitudeOffset = -1; latitudeOffset <= 1 && !duplicate; latitudeOffset++) {
        for (let longitudeOffset = -1; longitudeOffset <= 1 && !duplicate; longitudeOffset++) {
          const neighbours = cells.get(cellKey(latitude + latitudeOffset, longitude + longitudeOffset)) || [];
          duplicate = neighbours.some(item => item.agency === stop.agency &&
            item.name === stop.name && map.distance(item.coordinates, stop.coordinates) < 12);
        }
      }
      if (duplicate) continue;
      ids.add(stop.id);
      combined.push(stop);
      const key = cellKey(latitude, longitude);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(stop);
    }
    return combined;
  }, [selectedStops, nearby, map]);

  const updateViewport = () => {
    const center = map.getCenter();
    const next = { lat: center.lat, lon: center.lng, zoom: map.getZoom() };
    setViewport(previous => Math.floor(previous.zoom) === Math.floor(next.zoom) &&
      Math.abs(previous.lat - next.lat) < 0.0009 &&
      Math.abs(previous.lon - next.lon) < 0.0009 ? previous : next);
  };

  useMapEvents({
    moveend: updateViewport,
    zoomend: updateViewport,
    click(event) {
      if (!enabled || map.getZoom() < 16) return;
      const clickPoint = map.latLngToContainerPoint(event.latlng);
      let nearest = null;
      let pixels = 38;
      for (const stop of stops) {
        const separation = clickPoint.distanceTo(map.latLngToContainerPoint(stop.coordinates));
        if (separation < pixels && map.distance(stop.coordinates, event.latlng) < 95) {
          pixels = separation;
          nearest = stop;
        }
      }
      if (nearest) setTileStop({ stop: nearest, position: event.latlng });
    },
  });

  useEffect(() => {
    if (!enabled || viewport.zoom < 16) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        lat: String(viewport.lat), lon: String(viewport.lon), radius: "800",
      });
      fetch(`/api/transit/stops?${query}`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : { stops: [] })
        .then(result => { if (!controller.signal.aborted) setNearby(result.stops || []); })
        .catch(error => { if (error.name !== "AbortError") console.warn("Stop map layer:", error); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, viewport]);

  if (!enabled || viewport.zoom < 16) return null;
  return (
    <>
      {stops.map(stop => {
        const majorStop = /station|terminal|centre|center|mall|exchange|hub/i.test(stop.name || "");


        const showDot = mapStyle === "satellite" || (!majorStop && viewport.zoom >= 18);
        return <TransitStopMarker key={stop.id} stop={stop} showDot={showDot} />;
      })}
      {tileStop && (
        <Popup
          key={`${tileStop.stop.id}-${tileStop.position.lat.toFixed(5)}`}
          position={tileStop.position}
          className="transit-board-popup"
          minWidth={265}
          maxWidth={330}
          eventHandlers={{ remove: () => setTileStop(null) }}
        >
          <StopBoard stop={tileStop.stop} />
        </Popup>
      )}
    </>
  );
}

function TransitSegments({ route, darkMode, mapStyle }) {
  return (route?.segments ?? []).map((segment, index) => {
    const walking = segment.type === "walking";

    return (
      <Polyline
        key={`${segment.type}-${segment.route || "walk"}-${index}`}
        positions={segment.coordinates || []}
        pathOptions={{
          color: !walking && /^#[0-9a-fA-F]{6}$/.test(segment.color || "")
            ? segment.color
            : walking
            ? darkMode
              ? "#FFFFFF"
              : MODE_COLORS.walking
            : darkMode
              ? mapStyle === "hybrid"
                ? "#C2A9DF"
                : mapStyle === "satellite"
                  ? "#8fa88f"
                  : "#7EA5C8"
              : "#8fa88f",
          weight: walking ? 5 : 7,
          opacity: 1,
          dashArray: walking ? "1 10" : undefined,
          lineCap: "round",
          lineJoin: "round",
        }}
      />
    );
  });
}

function getBaseLayer(mapStyle, darkMode, useKey) {
  if (mapStyle === "hybrid") {
    if (useKey) {

      const styleId = darkMode ? "hybrid-v4-dark" : "hybrid-v4";
      return {
        id: `maptiler-${styleId}`,
        url: `https://api.maptiler.com/maps/${styleId}/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
        attribution:
          '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      };
    }


    return {
      id: "esri-hybrid",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      labels: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attribution: "Labels &copy; Esri",
      },
    };
  }

  if (mapStyle === "satellite") {
    return {
      id: "esri-satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    };
  }

  if (useKey) {
    const styleId = darkMode ? "streets-v4-dark" : "streets-v4";

    return {
      id: `maptiler-${styleId}`,
      url: `https://api.maptiler.com/maps/${styleId}/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      attribution:
        '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    };
  }

  return { id: "openfreemap", vector: true };
}


export default function MapView({
  data,
  selectedRoute,
  selectedRouteNumber = 1,
  hoveredRouteNumber = null,
  onSelectRoute = () => {},
  onHoverRoute = () => {},
  displayedMode,
  currentLocation,
  approxLocation = null,
  navigationActive = false,
  navigationAccuracy = null,
  navigationHeading = null,
  startCoordinate,
  destinationCoordinate,
  startLabel = "Start",
  destinationLabel = "Destination",
  startDraggable = true,
  onSetMapStart = () => {},
  onSetMapDestination = () => {},
  onMoveStart = () => {},
  onMoveDestination = () => {},
  locationFocusKey = 0,
  routeFocusKey = 0,
  stepFocusCoordinate = null,
  stepFocusKey = 0,
  darkMode,
  mapStyle = "street",
  viewInsets = ZERO_INSETS,
  enabledLayers = [],
  onLayerStatus = () => {},
  initialCamera = null,
  returnCamera = null,
  onCameraChange = () => {},
  registerCameraGetter = null,
}) {
  const [mapTilerFailed, setMapTilerFailed] = useState(false);
  const [verifiedStyle, setVerifiedStyle] = useState(null);
  const tileErrors = useRef([]);
  const styleId = mapTilerStyle(mapStyle, darkMode);

  useEffect(() => {
    if (!USE_MAPTILER || !styleId || mapTilerFailed) return;
    let cancelled = false;
    let checking = false;
    let controller;


    const verify = async () => {
      if (checking) return;
      checking = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const ok = await validMapTilerStyle(styleId, controller.signal);
        if (!cancelled) {
          if (ok) setVerifiedStyle(styleId);
          else setMapTilerFailed(true);
        }
      } catch {
        if (!cancelled) setMapTilerFailed(true);
      } finally {
        clearTimeout(timeout);
        checking = false;
      }
    };

    verify();
    const refresh = setInterval(verify, 90000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      controller?.abort();
    };
  }, [styleId, mapTilerFailed]);

  const onTileError = () => {
    const now = Date.now();
    tileErrors.current = tileErrors.current.filter(time => now - time < 10000);
    tileErrors.current.push(now);
    if (tileErrors.current.length >= 2) setMapTilerFailed(true);
  };
  const onTileLoad = event => {
    if (isMapTilerErrorTile(event.tile)) setMapTilerFailed(true);
  };
  const mode = displayedMode || data?.mode || "driving";

  const route = useMemo(() => {
    if (selectedRoute) {
      return selectedRoute;
    }

    return (
      data?.routes?.find(item => item.route_number === selectedRouteNumber) ||
      data?.routes?.[0] ||
      null
    );
  }, [data, selectedRoute, selectedRouteNumber]);

  const routeCoordinates = route?.route_coordinates ?? [];
  const routes = data?.routes ?? [];
  const otherRoutes = routes.filter(
    item => item.route_number !== route?.route_number
  );
  const selectedColor = mode === "walking"
    ? "#FFFFFF"
    : mapStyle === "hybrid" ? "#B99AFF"
      : mapStyle === "satellite" ? "#8fa88f" : "#A8D8FF";
  const baseLayer = getBaseLayer(mapStyle, darkMode,
    USE_MAPTILER && !mapTilerFailed && verifiedStyle === styleId);

  // real position if we have it, else the approximate one, else the home area
  const startPoint = validCoordinate(currentLocation) ? currentLocation
    : validCoordinate(approxLocation) ? approxLocation : null;
  const mapCenter = startPoint
    ? [Number(startPoint[0]), Number(startPoint[1])]
    : DEFAULT_CENTER;
  const startZoom = validCoordinate(currentLocation) ? PRECISE_ZOOM
    : validCoordinate(approxLocation) ? APPROX_ZOOM : DEFAULT_ZOOM;

  const visibleStart = validCoordinate(startCoordinate)
    ? startCoordinate
    : data?.start?.coordinates;
  const visibleDestination = validCoordinate(destinationCoordinate)
    ? destinationCoordinate
    : data?.end?.coordinates;

  return (
    <MapContainer
      center={initialCamera?.center ? [initialCamera.center[1], initialCamera.center[0]] : mapCenter}
      zoom={initialCamera?.zoom ?? startZoom}
      zoomSnap={0.25}
      minZoom={0}
      maxZoom={MAP_MAX_ZOOM}
      zoomControl={false}
      scrollWheelZoom
      className="h-full w-full"
    >
      <MapCameraSync onCameraChange={onCameraChange} registerCameraGetter={registerCameraGetter} />
      <RestoreCameraFrom3D camera={returnCamera} />
      <InitialLocationCenter
        currentLocation={currentLocation}
        approxLocation={approxLocation}
        initialCamera={initialCamera}
      />
      <MapThemeEffect darkMode={darkMode} mapStyle={mapStyle} />
      <Ontario511Layer enabled={enabledLayers} onStatus={onLayerStatus} darkMode={darkMode} />
      <MapResizeEffect />
      <MapInsetEffect insets={viewInsets} />
      <NavigationFollow
        active={navigationActive}
        location={currentLocation}
        insets={viewInsets}
      />

      {mapStyle === "hybrid" && (
        <TileLayer
          key="hybrid-background"
          url={`${ESRI_IMAGERY}/tile/{z}/{y}/{x}`}
          attribution="Tiles &copy; Esri"
          maxZoom={MAP_MAX_ZOOM}
          maxNativeZoom={SATELLITE_NATIVE_ZOOM}
          zIndex={0}
        />
      )}

      {baseLayer.vector ? (
        <FreeMapLayer darkMode={darkMode} />
      ) : baseLayer.id === "esri-hybrid" ? null : (
        <TileLayer
          key={`${baseLayer.id}-${darkMode ? "dark" : "light"}`}
          url={baseLayer.url}
          attribution={baseLayer.attribution}
          maxZoom={MAP_MAX_ZOOM}
          maxNativeZoom={baseLayer.id === "esri-satellite" ? SATELLITE_NATIVE_ZOOM : undefined}
          zIndex={baseLayer.id.startsWith("maptiler-") ? 100 : 1}
          crossOrigin={baseLayer.id.startsWith("maptiler-") ? "anonymous" : undefined}
          eventHandlers={baseLayer.id.startsWith("maptiler-")
            ? { tileerror: onTileError, tileload: onTileLoad }
            : undefined}
        />
      )}

      {(mapStyle === "satellite" || mapStyle === "hybrid") && <SatelliteDetails />}

      {baseLayer.labels && (
        <TileLayer
          key={`${baseLayer.id}-labels`}
          url={baseLayer.labels.url}
          attribution={baseLayer.labels.attribution}
          maxZoom={20}
          maxNativeZoom={SATELLITE_NATIVE_ZOOM}
          zIndex={250}
        />
      )}

      <ZoomControl position="bottomright" />

      {otherRoutes.map(otherRoute => {
        const hovered = otherRoute.route_number === hoveredRouteNumber;

        return (
          <Polyline
            key={`other-${otherRoute.route_number}`}
            positions={otherRoute.route_coordinates || []}
            eventHandlers={{
              click: () => onSelectRoute(otherRoute.route_number),
              mouseover: () => onHoverRoute(otherRoute.route_number),
              mouseout: () => onHoverRoute(null),
            }}
            pathOptions={{
              color: hovered
                ? selectedColor
                : darkMode
                  ? "#9AA4A8"
                  : "#7D8589",
              weight: hovered ? 7 : 5,
              opacity: hovered ? 0.9 : 0.42,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        );
      })}

      {route && mode === "transit" && route.segments?.length ? (
        <TransitSegments route={route} darkMode={darkMode} mapStyle={mapStyle} />
      ) : route?.route_coordinates?.length ? (
        <>
          {mode !== "walking" && (
            <Polyline
              positions={route.route_coordinates}
              eventHandlers={{
                mouseover: () => onHoverRoute(route.route_number),
                mouseout: () => onHoverRoute(null),
              }}
              pathOptions={{
                color: darkMode ? "#182126" : "#FFFFFF",
                weight: 10,
                opacity: 0.55,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          )}

          <Polyline
            positions={route.route_coordinates}
            eventHandlers={{
              mouseover: () => onHoverRoute(route.route_number),
              mouseout: () => onHoverRoute(null),
            }}
            pathOptions={{
              color: selectedColor,
              weight: hoveredRouteNumber === route.route_number ? 8 : 7,
              opacity: 1,
              dashArray: mode === "walking" ? "1 10" : undefined,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        </>
      ) : null}

      <TransitStops
        enabled={mode === "transit"}
        selectedStops={route?.transit_stops || []}
        mapStyle={mapStyle}
      />

      {(route?.live_vehicles ?? [])
        .filter(vehicle => validCoordinate([vehicle.lat, vehicle.lon]))
        .map(vehicle => {
          const estimated = Boolean(vehicle.estimated);
          const delayAdjusted = vehicle.position_source === "schedule_adjusted";
          return (
            <Marker
              key={`${vehicle.agency}-${vehicle.trip_id}-${
                vehicle.vehicle_id || (estimated ? "scheduled" : "vehicle")
              }`}
              position={[vehicle.lat, vehicle.lon]}
              icon={estimated ? BUS_SCHEDULED_ICON : BUS_LIVE_ICON}
              zIndexOffset={950}
            >
              <Popup>
                <div className="font-semibold">
                  {vehicle.agency_label || String(vehicle.agency || "").toUpperCase()} • {
                    estimated ? "Scheduled estimate" : "Live"
                  } {vehicle.route ? `route ${vehicle.route}` : "vehicle"}
                </div>
                {vehicle.display_headsign || vehicle.headsign ? <div>toward {vehicle.display_headsign || vehicle.headsign}</div> : null}
                {vehicle.vehicle_label ? <div>{vehicle.vehicle_label}</div> : null}
                {(() => {
                  const specs = vehicleSpecs(vehicle);
                  return specs ? (
                    <div className="mt-1 text-[11px]">
                      {[specs.year, specs.powertrainLabel, specs.model, specs.seats ? `${specs.seats} seats` : null]
                        .filter(Boolean).join(" • ")}
                    </div>
                  ) : null;
                })()}
                {estimated ? (
                  <div className="mt-1 text-[10px] opacity-70">
                    {delayAdjusted
                      ? "Estimated from the timetable with the latest known delay."
                      : "Estimated from the scheduled timetable; not a GPS position."}
                  </div>
                ) : vehicle.timestamp ? (
                  <div className="mt-1 text-[10px] opacity-60">
                    Position update {new Date(Number(vehicle.timestamp) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                  </div>
                ) : null}
              </Popup>
            </Marker>
          );
        })}

      {(route?.charging_stops || []).filter(stop => validCoordinate(stop.coordinates)).map((stop, i) => (
        <Marker key={`ev-charge-${i}`} position={stop.coordinates} icon={EV_CHARGER_ICON}>
          <Popup><strong>{stop.name || "EV charging stop"}</strong><div>{stop.charging_time_min} min charging</div>{stop.operator && <div>{stop.operator}</div>}</Popup>
        </Marker>
      ))}

      {!navigationActive && validCoordinate(visibleStart) && (
        <Marker
          position={visibleStart}
          icon={START_ICON}
          draggable={startDraggable}
          eventHandlers={{
            dragend: event => {
              const position = event.target.getLatLng();
              onMoveStart([position.lat, position.lng]);
            },
          }}
        >
          <Popup>
            Start: {data?.start?.address || startLabel || "Selected location"}
            {startDraggable && (
              <div className="mt-1 text-[10px] opacity-60">Drag to reroute</div>
            )}
          </Popup>
        </Marker>
      )}

      {validCoordinate(visibleDestination) && (
        <Marker
          position={visibleDestination}
          icon={END_ICON}
          draggable
          eventHandlers={{
            dragend: event => {
              const position = event.target.getLatLng();
              onMoveDestination([position.lat, position.lng]);
            },
          }}
        >
          <Popup>
            Destination: {data?.end?.address || destinationLabel || "Selected location"}
            <div className="mt-1 text-[10px] opacity-60">Drag to reroute</div>
          </Popup>
        </Marker>
      )}

      {navigationActive &&
        validCoordinate(currentLocation) &&
        Number.isFinite(Number(navigationAccuracy)) &&
        Number(navigationAccuracy) > 0 && (
          <Circle
            center={currentLocation}
            radius={Number(navigationAccuracy)}
            pathOptions={{
              color: "#4E7CA8",
              weight: 1,
              opacity: 0.35,
              fillColor: "#4E7CA8",
              fillOpacity: 0.08,
            }}
          />
        )}

      {validCoordinate(currentLocation) && (
        <CircleMarker
          center={currentLocation}
          radius={8}
          pathOptions={{
            color: "#D7E3DE",
            weight: 5,
            fillColor: "#4E7CA8",
            fillOpacity: 1,
          }}
        >
          <Popup>
            {navigationActive ? "Live navigation position" : "Your current location"}
            {navigationActive && Number.isFinite(Number(navigationAccuracy)) && (
              <div className="mt-1 text-[10px] opacity-60">
                GPS ±{Math.round(Number(navigationAccuracy))} m
                {Number.isFinite(Number(navigationHeading))
                  ? ` • heading ${Math.round(Number(navigationHeading))}°`
                  : ""}
              </div>
            )}
          </Popup>
        </CircleMarker>
      )}

      {!navigationActive && (
        <MapPointPicker
          darkMode={darkMode}
          onSetStart={onSetMapStart}
          onSetDestination={onSetMapDestination}
        />
      )}

      <MapEffects
        routeCoordinates={routeCoordinates}
        currentLocation={currentLocation}
        locationFocusKey={locationFocusKey}
        routeFocusKey={routeFocusKey}
        stepFocusCoordinate={stepFocusCoordinate}
        stepFocusKey={stepFocusKey}
        insets={viewInsets}
      />
    </MapContainer>
  );
}
