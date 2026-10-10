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
      [Number(currentLocation[0]), Number(currentLocation[1])],
      15,
      {
        animate: true,
        duration: 0.9,
      }
    );
  }, [map, currentLocation, locationFocusKey]);

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
      padding: [58, 58],
      maxZoom: 16,
      animate: true,
      duration: 1.1,
      easeLinearity: 0.25,
    });
  }, [map, routeCoordinates, routeFocusKey]);

  useEffect(() => {
    if (stepFocusKey === previousStepFocusKey.current) {
      return;
    }

    previousStepFocusKey.current = stepFocusKey;

    if (!validCoordinate(stepFocusCoordinate)) {
      return;
    }

    map.flyTo(
      [Number(stepFocusCoordinate[0]), Number(stepFocusCoordinate[1])],
      Math.max(map.getZoom(), 17),
      {
        animate: true,
        duration: 0.75,
      }
    );
  }, [map, stepFocusCoordinate, stepFocusKey]);

  return null;
}

function NavigationFollow({ active, location }) {
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
      map.flyTo(target, Math.max(map.getZoom(), 17), {
        animate: true,
        duration: 0.8,
      });
      return;
    }

    map.panTo(target, { animate: true, duration: 0.45 });
  }, [map, active, location]);

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

function TransitStopMarker({ stop, darkMode }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [boardLoadedAt, setBoardLoadedAt] = useState(0);

  async function loadBoard() {
    const freshEnough = board && Date.now() - boardLoadedAt < 30000;
    if (stop.agency !== "go" || loading || freshEnough) {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `/api/transit/live-departures?agency=go&stop_id=${encodeURIComponent(
          stop.raw_id || stop.id
        )}&limit=4`
      );
      const result = await response.json();
      setBoard(result);
      setBoardLoadedAt(Date.now());
    } catch (error) {
      console.warn("Could not load GO live departures:", error);
      setBoard({ success: false, connected: false, error: "request_failed" });
      setBoardLoadedAt(Date.now());
    } finally {
      setLoading(false);
    }
  }

  const goStop = stop.agency === "go";
  const departures = board?.departures ?? [];

  return (
    <CircleMarker
      center={stop.coordinates}
      radius={goStop ? 5 : 4}
      pathOptions={{
        color: "#FFFFFF",
        weight: 2,
        fillColor: goStop ? "#007A53" : MODE_COLORS.transit,
        fillOpacity: 1,
      }}
      eventHandlers={{ popupopen: loadBoard }}
    >
      <Popup minWidth={goStop ? 250 : 120}>
        <div className={darkMode ? "text-charcoal" : ""}>
          <div className="font-semibold">{stop.name}</div>
          {goStop && (
            <div className="mt-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                  GO live departures
                </div>
                {boardLoadedAt > 0 && !loading && (
                  <div className="text-[9px] text-slate-500">30 s refresh</div>
                )}
              </div>

              {loading && <div className="mt-1 text-xs">Loading live times…</div>}

              {!loading && board && !board.connected && (
                <div className="mt-1 text-xs leading-4 text-slate-600">
                  {board.configured === false
                    ? "Add METROLINX_API_KEY on the server to enable GO live times."
                    : "GO live times are temporarily unavailable."}
                </div>
              )}

              {!loading && departures.length > 0 && (
                <div className="mt-1.5 space-y-1.5">
                  {departures.map((departure, index) => (
                    <div
                      key={`${departure.trip_number || departure.line_code}-${index}`}
                      className="rounded-md bg-slate-100 px-2 py-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-3 font-semibold">
                        <span>
                          {departure.line_code || departure.line_name || "GO"}
                          {departure.direction ? ` → ${departure.direction}` : ""}
                        </span>
                        <span>{departure.computed_time || departure.scheduled_time}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-600">
                        <span>{departure.status || "Scheduled"}</span>
                        {Math.abs(departure.delay_min || 0) >= 1 && (
                          <span>
                            {departure.delay_min > 0 ? "+" : ""}
                            {Math.round(departure.delay_min)} min
                          </span>
                        )}
                        {(departure.actual_platform || departure.scheduled_platform) && (
                          <span>
                            Platform {departure.actual_platform || departure.scheduled_platform}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!loading && board?.connected && departures.length === 0 && (
                <div className="mt-1 text-xs text-slate-600">No upcoming GO service returned.</div>
              )}
            </div>
          )}
        </div>
      </Popup>
    </CircleMarker>
  );
}

function TransitSegments({ route, darkMode }) {
  return (route?.segments ?? []).map((segment, index) => {
    const walking = segment.type === "walking";

    return (
      <Polyline
        key={`${segment.type}-${segment.route || "walk"}-${index}`}
        positions={segment.coordinates || []}
        pathOptions={{
          color: walking
            ? darkMode
              ? "#FFFFFF"
              : MODE_COLORS.walking
            : segment.color || MODE_COLORS.transit,
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


function NearbyVehicleLayer({ enabled, selectedVehicles }) {
  const map = useMap();
  const [viewport, setViewport] = useState(() => {
    const center = map.getCenter();
    const bounds = map.getBounds();
    return { lat: center.lat, lon: center.lng,
      radius: Math.min(15000, Math.max(1000, map.distance(center, bounds.getNorthWest()))) };
  });
  const [vehicles, setVehicles] = useState([]);
  const selectedKeys = new Set(
    (selectedVehicles || []).map(v => `${v.agency}:${v.trip_id}`)
  );

  useMapEvents({
    moveend: () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      setViewport({ lat: center.lat, lon: center.lng,
        radius: Math.min(15000, Math.max(1000, map.distance(center, bounds.getNorthWest()))) });
    },
  });

  useEffect(() => {
    if (!enabled || !viewport) return;
    let active = true;
    let controller;
    async function refresh() {
      controller?.abort();
      controller = new AbortController();
      try {
        const q = new URLSearchParams({ lat: String(viewport.lat),
          lon: String(viewport.lon), radius: String(Math.round(viewport.radius)) });
        const response = await fetch(`/api/transit/vehicles?${q}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = await response.json();
        if (active && result.success) setVehicles(result.vehicles || []);
      } catch (error) {
        if (error.name !== "AbortError") console.warn("Vehicle map refresh:", error);
      }
    }
    refresh();
    const intervalId = window.setInterval(refresh, 20000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(intervalId);
    };
  }, [enabled, viewport]);

  if (!enabled) return null;
  return <>
    {vehicles.filter(v =>
      validCoordinate([v.lat, v.lon]) && !selectedKeys.has(`${v.agency}:${v.trip_id}`)
    ).map(v => (
      <CircleMarker
        key={`nearby-${v.agency}-${v.trip_id}`}
        center={[v.lat, v.lon]}
        radius={v.estimated ? 5.5 : 7}
        pathOptions={{
          color: "#FFFFFF", weight: v.estimated ? 2 : 3,
          fillColor: v.estimated ? "#64748B" : "#D97706",
          fillOpacity: v.estimated ? 0.85 : 1,
          dashArray: v.estimated ? "4 3" : undefined,
        }}
      >
        <Popup>
          <div className="font-semibold">
            {v.agency === "go" ? "GO Transit" : "GRT"}
            {v.route ? ` • ${v.route}` : ""}
          </div>
          <div>{v.estimated ? "Scheduled estimate — not GPS" : "Live GPS position"}</div>
          {v.headsign && <div>toward {v.headsign}</div>}
          {v.estimated && <div className="text-xs">Approximate position between scheduled stops.</div>}
        </Popup>
      </CircleMarker>
    ))}
  </>;
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
      ? darkMode || mapStyle === "satellite"
        ? "#FFFFFF"
        : "#2F3E46"
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
      <NavigationFollow active={navigationActive} location={currentLocation} />

      <TileLayer
        key={`${baseLayer.id}-${darkMode ? "dark" : "light"}`}
        url={baseLayer.url}
        attribution={baseLayer.attribution}
        maxZoom={22}
      />

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
        <TransitSegments route={route} darkMode={darkMode} />
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

      <NearbyVehicleLayer
        enabled={mode === "transit"}
        selectedVehicles={route?.live_vehicles || []}
      />

      {(route?.transit_stops ?? [])
        .filter(stop => validCoordinate(stop.coordinates))
        .map(stop => (
          <TransitStopMarker key={stop.id} stop={stop} darkMode={darkMode} />
        ))}

      {(route?.live_vehicles ?? [])
        .filter(vehicle => validCoordinate([vehicle.lat, vehicle.lon]))
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
                  {vehicle.agency === "go" ? "GO Transit" : "GRT"} • {
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
      />
    </MapContainer>
  );
}
