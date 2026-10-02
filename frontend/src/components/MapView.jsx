import { useEffect, useMemo } from "react"
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  ZoomControl
} from "react-leaflet"

import L from "leaflet";
import "leaflet/dist/leaflet.css";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
const DEFAULT_CENTER = [43.4829, -80.5249];
const MODE_COLORS = {
  driving: "#66856B",
  walking: "#2F3E46",
  cycling: "#4F7455",
  transit: "#8A6F4D"
}

function validCoordinate(coordinate) {
  return (
    Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    Number.isFinite(Number(coordinate[0])) &&
    Number.isFinite(Number(coordinate[1]))
  );
}

function MapEffects({routeCoordinates, currentLocation}) {
  const map = useMap();

  useEffect(() => {
    const safeRouteCoordinates = (routeCoordinates ?? []).filter(validCoordinate);
    if (safeRouteCoordinates.length >= 2) {
      const bounds = L.latLngBounds(safeRouteCoordinates);
      map.fitBounds(bounds, {
        padding: [42, 42],
        animate: true,
      });
      return;
    }

    if (validCoordinate(currentLocation)) {
      map.flyTo([Number(currentLocation[0]), Number(currentLocation[1])], 15, {duration: 0.8});
    }
  }, [map, routeCoordinates, currentLocation]);
  return null;
}

function TransitSegments({ route }) {
  const segments = route?.segments ?? [];
  if (segments.length === 0) {
    return null;
  }

  return route.segments.map((segment, index) => {
    const walking = segment.type === "walking";

    return(
      <Polyline
        key={`${segment.type}-${segment.route || "walk"}-${index}`}
        positions={segment.coordinates}
        pathOptions={{
          color: walking ? MODE_COLORS.walking : segment.color || MODE_COLORS.transit,
          weight: walking ? 5 : 7,
          opacity: 0.92,
          dashArray: walking ? "1 10" : undefined,
          lineCap: "round",
          lineJoin: "round"
        }}
      />
    );
  });
}

function MapView({
  data, selectedRoute, selectedRouteNumber = 1, onSelectRoute = () => {}, displayedMode, currentLocation
}) {
  const mode = displayedMode || data?.mode || "driving";
  const route = useMemo(() => {
    if (selectedRoute) {
      return selectedRoute;
    }
    return data?.routes?.find((item) => item.route_number === selectedRouteNumber);
  }, [data, selectedRoute, selectedRouteNumber]);
  const routeCoordinates = route?.route_coordinates || [];

  const routes = data?.routes ?? [];
  const otherRoutes = routes.filter((item) => item.route_number !== selectedRouteNumber);
  const tileUrl = MAPTILER_KEY ? `https://api.maptiler.com/maps/streets-v4/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}` : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const selectedColor = MODE_COLORS[mode] || MODE_COLORS.driving;
  const mapCenter = validCoordinate(currentLocation)
    ? [Number(currentLocation[0]), Number(currentLocation[1])]
    : DEFAULT_CENTER;

  return (
    <MapContainer center={mapCenter} zoom={13} zoomControl={false} scrollWheelZoom className="h-full w-full">
      <TileLayer url={tileUrl} attribution='&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' />
      <ZoomControl position="topright" />
      {otherRoutes.map((otherRoute) => (
        <Polyline
          key={`other-${otherRoute.route_number}`}
          positions={otherRoute.route_coordinates || []}
          eventHandlers={{click: () => onSelectRoute(otherRoute.route_number)}}
          pathOptions={{
            color: "#7D8589",
            weight: 5,
            opacity: 0.42,
            lineCap: "round",
            lineJoin: "round",
          }}
        />
      ))}

      {route && mode === "transit" && route.segments?.length ? (
        <TransitSegments route={route} />
      ) : route?.route_coordinates?.length ? (
        <>
          {mode !== "walking" && (
            <Polyline
              positions={route.route_coordinates}
              pathOptions={{
                color: "#FFFFFF",
                weight: 9,
                opacity: 0.45,
                lineCap: "round",
                lineJoin: "round"
              }}
            />
          )}

          <Polyline
            positions={route.route_coordinates}
            pathOptions={{
              color: selectedColor,
              weight: 7,
              opacity: 1,
              dashArray: mode === "walking" ? "1 10" : (mode === "transit" ? "10 7" : undefined),
              lineCap: "round",
              lineJoin: "round"
            }}
          />
        </>
      ) : null }

      {
        (route?.transit_stops ?? []).filter((stop) => validCoordinate(stop.coordinates)).map((stop) => (
          <CircleMarker
            key={stop.id}
            center={stop.coordinates}
            radius={4}
            pathOptions={{
              color: "#FFFFFF",
              weight: 2,
              fillColor: MODE_COLORS.transit,
              fillOpacity: 1
            }}
          >
            <Popup>{stop.name}</Popup>
          </CircleMarker>
        ))
      }

      {
        validCoordinate(data?.start?.coordinates) && (
          <CircleMarker
            center={data.start.coordinates}
            radius={7}
            pathOptions={{
              color: "#FFFFFF",
              weight: 3,
              fillColor: "#111111",
              fillOpacity: 1
            }}
            >
              <Popup>Start: {data.start.address}</Popup>
            </CircleMarker>
        )
      }

      {
        validCoordinate(data?.end?.coordinates) && (
          <CircleMarker
            center={data.end.coordinates}
            radius={7}
            pathOptions={{
              color: "#FFFFFF",
              weight: 3,
              fillColor: "#111111",
              fillOpacity: 1
            }}
          >
            <Popup>Destination: {data.end.address}</Popup>
          </CircleMarker>
        )
      }

      {
        validCoordinate(currentLocation) && (
          <CircleMarker
            center={currentLocation}
            radius={8}
            pathOptions={{
              color: "#D7E3DE",
              weight: 5,
              fillColor: "#66856B",
              fillOpacity: 1,
            }}
          >
            <Popup>Your current Location</Popup>
          </CircleMarker>
        )
      }
      
      <MapEffects routeCoordinates={routeCoordinates} currentLocation={currentLocation} />
    </MapContainer>
  );
}

export default MapView