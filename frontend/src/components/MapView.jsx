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

import "leaflet/dist/leaflet.css";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
const DEFAULT_CENTER = [43.4829, -80.5249];

const MODE_COLORS = {
  driving: "#66856B",
  walking: "#2F3E46",
  cycling: "#4F7455",
  transit: "#8A6F4D",
};

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

// Offset (px) of the centre of the *visible* map area from the centre of the
// map container, given the pixels covered by overlays on each side.
function visibleOffset(insets) {
  return [(insets.left - insets.right) / 2, (insets.top - insets.bottom) / 2];
}

// Returns the map centre that makes `latlng` appear in the middle of the
// visible (un-covered) area at the given zoom.
function centeredTarget(map, latlng, zoom, insets) {
  const [dx, dy] = visibleOffset(insets);
  if (!dx && !dy) {
    return L.latLng(latlng);
  }
  return map.unproject(map.project(latlng, zoom).subtract([dx, dy]), zoom);
}

// When an overlay opens/closes, shift the map so whatever was in the middle of
// the visible area stays in the middle of the visible area.
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

function StopBoard({ stop }) {
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
        {stop.agency === "go" ? "GO Transit" : stop.agency === "ttc" ? "TTC" : "GRT"} · Departures
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
    for (const stop of [...selectedStops, ...nearby]) {
      if (!validCoordinate(stop.coordinates)) continue;
      // Adjacent platforms can share nearly identical GTFS points.
      const duplicate = combined.some(item =>
        item.id === stop.id || (
          item.agency === stop.agency &&
          map.distance(item.coordinates, stop.coordinates) < 12 &&
          item.name === stop.name
        )
      );
      if (!duplicate) combined.push(stop);
    }
    return combined;
  }, [selectedStops, nearby, map]);

  useMapEvents({
    moveend() {
      const center = map.getCenter();
      setViewport({ lat: center.lat, lon: center.lng, zoom: map.getZoom() });
    },
    zoomend() {
      const center = map.getCenter();
      setViewport({ lat: center.lat, lon: center.lng, zoom: map.getZoom() });
    },
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
    if (!enabled || viewport.zoom < 16) {
      return;
    }
    const controller = new AbortController();
    const query = new URLSearchParams({
      lat: String(viewport.lat), lon: String(viewport.lon), radius: "800",
    });
    fetch(`/api/transit/stops?${query}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : { stops: [] })
      .then(result => setNearby(result.stops || []))
      .catch(error => { if (error.name !== "AbortError") console.warn("Stop map layer:", error); });
    return () => controller.abort();
  }, [enabled, viewport]);

  if (!enabled || viewport.zoom < 16) return null;
  return (
    <>
      {stops.map(stop => {
        const majorStop = /station|terminal|centre|center|mall|exchange|hub/i.test(stop.name || "");
        // Large stations usually have a symbol in the basemap already.
        // At close zoom, smaller curbside stops get a dot if no tile icon is shown.
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

function getBaseLayer(mapStyle, darkMode) {
  if (mapStyle === "hybrid") {
    if (MAPTILER_KEY) {
      // MapTiler's rendered hybrid style includes imagery, roads and labels.
      const styleId = darkMode ? "hybrid-v4-dark" : "hybrid-v4";
      return {
        id: `maptiler-${styleId}`,
        url: `https://api.maptiler.com/maps/${styleId}/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
        attribution:
          '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      };
    }

    // Key-free fallback: Esri satellite imagery with a transparent label overlay.
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
    if (MAPTILER_KEY) {
      return {
        id: "maptiler-satellite",
        url: `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`,
        attribution:
          '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>',
      };
    }

    return {
      id: "esri-satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution:
        "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    };
  }

  if (MAPTILER_KEY) {
    const styleId = darkMode ? "streets-v4-dark" : "streets-v4";

    return {
      id: `maptiler-${styleId}`,
      url: `https://api.maptiler.com/maps/${styleId}/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      attribution:
        '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    };
  }

  return {
    id: darkMode ? "carto-dark" : "carto-light",
    url: darkMode
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; CARTO',
  };
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
}) {
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
  const selectedColor =
    mode === "walking"
      ? darkMode || mapStyle === "satellite" || mapStyle === "hybrid"
        ? "#FFFFFF"
        : "#2F3E46"
      : mode === "driving"
        ? darkMode
          ? mapStyle === "hybrid"
            ? "#C2A9DF"
            : mapStyle === "satellite"
              ? "#8fa88f"
              : "#7EA5C8"
          : "#8fa88f"
        : MODE_COLORS[mode] || MODE_COLORS.driving;
  const baseLayer = getBaseLayer(mapStyle, darkMode);

  const mapCenter = validCoordinate(currentLocation)
    ? [Number(currentLocation[0]), Number(currentLocation[1])]
    : DEFAULT_CENTER;

  const visibleStart = validCoordinate(startCoordinate)
    ? startCoordinate
    : data?.start?.coordinates;
  const visibleDestination = validCoordinate(destinationCoordinate)
    ? destinationCoordinate
    : data?.end?.coordinates;

  return (
    <MapContainer
      center={mapCenter}
      zoom={13}
      zoomControl={false}
      scrollWheelZoom
      className="h-full w-full"
    >
      <MapThemeEffect darkMode={darkMode} mapStyle={mapStyle} />
      <MapResizeEffect />
      <MapInsetEffect insets={viewInsets} />
      <NavigationFollow
        active={navigationActive}
        location={currentLocation}
        insets={viewInsets}
      />

      <TileLayer
        key={`${baseLayer.id}-${darkMode ? "dark" : "light"}`}
        url={baseLayer.url}
        attribution={baseLayer.attribution}
        maxZoom={22}
      />

      {baseLayer.labels && (
        <TileLayer
          key={`${baseLayer.id}-labels`}
          url={baseLayer.labels.url}
          attribution={baseLayer.labels.attribution}
          maxZoom={22}
          zIndex={250}
        />
      )}

      <ZoomControl position="topright" />

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
        .filter(vehicle => validCoordinate([vehicle.lat, vehicle.lon]) &&
          (route?.steps || []).some(step => step.type === "transit" &&
            String(step.agency) === String(vehicle.agency) &&
            String(step.trip_id) === String(vehicle.trip_id)))
        .map(vehicle => {
          const estimated = Boolean(vehicle.estimated);
          const delayAdjusted = vehicle.position_source === "schedule_adjusted";
          return (
            <CircleMarker
              key={`${vehicle.agency}-${vehicle.trip_id}-${
                vehicle.vehicle_id || (estimated ? "scheduled" : "vehicle")
              }`}
              center={[vehicle.lat, vehicle.lon]}
              radius={estimated ? 6 : 7}
              pathOptions={{
                color: "#FFFFFF",
                weight: estimated ? 2 : 3,
                fillColor: estimated ? "#64748B" : "#D97706",
                fillOpacity: estimated ? 0.85 : 1,
                dashArray: estimated ? "4 3" : undefined,
              }}
            >
              <Popup>
                <div className="font-semibold">
                  {vehicle.agency === "go" ? "GO Transit" : vehicle.agency === "ttc" ? "TTC" : "GRT"} • {
                    estimated ? "Scheduled estimate" : "Live"
                  } {vehicle.route ? `route ${vehicle.route}` : "vehicle"}
                </div>
                {vehicle.headsign ? <div>toward {vehicle.headsign}</div> : null}
                {vehicle.vehicle_label ? <div>{vehicle.vehicle_label}</div> : null}
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
            </CircleMarker>
          );
        })}

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
