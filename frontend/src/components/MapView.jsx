import { useEffect, useMemo, useRef, useState } from "react";
import {
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

function MapPointPicker({ darkMode, onSetStart, onSetDestination }) {
  const [point, setPoint] = useState(null);

  useMapEvents({
    click(event) {
      setPoint([event.latlng.lat, event.latlng.lng]);
    },
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

export default function MapView({
  data,
  selectedRoute,
  selectedRouteNumber = 1,
  hoveredRouteNumber = null,
  onSelectRoute = () => {},
  onHoverRoute = () => {},
  displayedMode,
  currentLocation,
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

      {(route?.transit_stops ?? [])
        .filter(stop => validCoordinate(stop.coordinates))
        .map(stop => (
          <CircleMarker
            key={stop.id}
            center={stop.coordinates}
            radius={4}
            pathOptions={{
              color: "#FFFFFF",
              weight: 2,
              fillColor: MODE_COLORS.transit,
              fillOpacity: 1,
            }}
          >
            <Popup>{stop.name}</Popup>
          </CircleMarker>
        ))}

      {(route?.live_vehicles ?? [])
        .filter(vehicle => validCoordinate([vehicle.lat, vehicle.lon]))
        .map(vehicle => (
          <CircleMarker
            key={`${vehicle.agency}-${vehicle.trip_id}-${
              vehicle.vehicle_id || "vehicle"
            }`}
            center={[vehicle.lat, vehicle.lon]}
            radius={7}
            pathOptions={{
              color: "#FFFFFF",
              weight: 3,
              fillColor: "#D97706",
              fillOpacity: 1,
            }}
          >
            <Popup>
              Live {vehicle.route ? `route ${vehicle.route}` : "transit vehicle"}
              {vehicle.headsign ? ` toward ${vehicle.headsign}` : ""}
            </Popup>
          </CircleMarker>
        ))}

      {validCoordinate(visibleStart) && (
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
          <Popup>Your current location</Popup>
        </CircleMarker>
      )}

      <MapPointPicker
        darkMode={darkMode}
        onSetStart={onSetMapStart}
        onSetDestination={onSetMapDestination}
      />

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
