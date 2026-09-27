import { useEffect } from "react"
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  ZoomControl
} from "react-leaflet"

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

function MapEffects({
  route,
  currentLocation
}) {
  const map = useMap();

  useEffect(() => {
    if (!route?.route_coordinates?.length) {
      return;
    }
    map.fitBounds(route.route_coordinates, {
      padding: [60, 60],
      maxZoom: 17
    });
  }, [
    root, map
  ]);
  
  useEffect(() => {
    if (!currentLocation) {
      return;
    }
    map.flyTo(
      currentLocation,
      16,
      {
        duration: 0.7
      }
    );
  }, [
    currentLocation,
    map
  ]);

  return null;
}

export default function MapView({
  data, selectedRouteNumber, selectedMode, onSelectRoute, currentLocation
}) {
  const selectedRoute = data?.routes?.find(route => route.route_number === selectedRouteNumber);
  const COLORS = {
    driving: "#66856B",
    walking: "#2F3E46",
    cycling: "#4f7455",
    transit: "#8A6F4D"
  };
  const routeColor = COLORS[selectedMode] || COLORS.driving;
  const usingMapTiler = Boolean(MAPTILER_KEY);
  const titleURL = usingMapTiler ? (
    "https://api.maptiler.com/mapps/"
    + "streets-v4/256/"
    + "{z}/{x}/{y}.png"
    + `?key=${MAPTILER_KEY}`
  )
  : (
    "https://{s}."
    + "basemaps.cartocdn.com/"
    + "light_all/"
    + "{z}/{x}/{y}{r}.png"
  );
  const attribution = usingMapTiler ? (
    "&copy;MapTiler "
    + "&copy; OpenStreepMap contributors"
  )
  : (
    "&copy; OpenStreetMap contributors "
    + "&copy; CARTO"
  );

  return (
    <MapContainer center={[43.4829, -80.5249]} zoom={13} zoomControl={false} className="h-full w-full">
      <TileLayer url={titleUrl} maxZoom={20} attribution={attribution} />
      <ZoomControl position="bottomRight" />
      {data?.routes?.map(route => {
        if (
          route.route_number === selectedRouteNumber
        ) {
          return null;
        }
        if (
          !route.route_coordinates?.length
        ) {
          return null;
        }

        return (
          <Polyline
            key={`alternate=${route.route_number}`}
            positions={route.route_coordinates}
            pathOptions={{
              color: "#757575",
              weight: 6,
              opacity: 0.35,
              lineCap: "round",
              lineJoin:"round"
            }}
            eventHandlers={{
              click: () => onSelectedRoute(route.route_number)
            }}
          />
        );
      })}

      {
        selectedRoute && selectedMode !== "walking" && (
          <Polyline
            positions={selectedRoute.route_coordinates}
            pathOptions={{
              color: "#FFFFFF",
              weight: 11,
              opacity: 0.85,
              lineCap: "round",
              lineJoin: "round"
            }}
          />
        )
      }

      {
        selectedRoute && (
          <Polyline
            positions={selectedRoute.route_coordinates}
            pathOptions={{
              color: routeColor,
              weight: selectedMode === "walking" ? 6 : 7,
              opacity: 0.96,
              /* Walking - dotted, Transit - dashed, Driving/Biking - solid */
              dashArray: selectedMode === "walking" ? "1 10" : selectedMode === "transit" ? "10 7" : undefined,
              lineCap: "round",
              lineJoin: "round"
            }}
          />
        )
      }

      {
        selectedMode === "transit" && selectedRoute?.transit_stops?.map(
          (position, index) => (
            <CircleMarker
              key={`transit-stop-${index}`}
              center={position}
              radius={4}
              pathOptions={{
                color: "#FFFFFF",
                weight: 2,
                fillColor: routeColor,
                FillOpacity: 1
              }}
            />
          )
        )
      }

      {
        data?.start?.coordinates && (
          <CircleMarker
            center={data.start.coordinates}
            radius={7}
            pathOptions={{
              color: "#FFFFFF",
              weight: 3,
              fillColor: "668568",
              fillOpacity: 1
            }}
            >
              <Popup>
                <strong>Start</strong>
                <br />
                {data.start.address}
              </Popup>
            </CircleMarker>
        )
      }

      {
        data?.end?.coordinates && (
          <CircleMarker
            center={data.end.coordinates}
            radius={7}
            pathOptions={{
              color: "#FFFFFF",
              weight: 3,
              fillColor: "#2F3E46",
              fillOpacity: 1
            }}
          >
            <Popup>
              <strong>Destination</strong>
              <br />
              {data.end.address}
            </Popup>
          </CircleMarker>
        )
      }

      {
        crrentLocation && (
          <>
            <CircleMarker
              center={currentLocation}
              radius={14}
              pathOptions={{
                color: "#66856B",
                weight: 1,
                fillColor: "#66856B",
                fillOpacity: 0.15,
                opacity: 0.3
              }}
            />
            <CircleMarker
              center={currentLocation}
              radius={7}
              pathOptions={{
                color: "#FFFFFF",
                weight: 3,
                fillColor: "#66858B",
                fillOpacity: 1
              }}
            >
              <Popup>Your Location</Popup>
            </CircleMarker>
          </>
        )
      }
      
      <MapEffects route={selectedRoute} currentLocation={currentLocation} />
    </MapContainer>
  );
}