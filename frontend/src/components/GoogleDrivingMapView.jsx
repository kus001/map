import { useEffect, useRef, useState } from "react";

// Routes API polylines are only rendered on Google Maps. Do not reuse this
// component's route coordinates with Leaflet / MapTiler.
const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const DEFAULT_CENTER = { lat: 43.46426, lng: -80.52189 };
let loadingScript;

function loadGoogleMaps() {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (loadingScript) return loadingScript;
  loadingScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&v=weekly&loading=async`;
    script.async = true;
    script.onload = () => window.google?.maps?.Map
      ? resolve(window.google.maps)
      : reject(new Error("Google Maps did not initialize"));
    script.onerror = () => reject(new Error("Google Maps script could not load"));
    document.head.append(script);
  }).catch(error => {
    loadingScript = null;
    throw error;
  });
  return loadingScript;
}

function point(value) {
  if (!Array.isArray(value) || !Number.isFinite(+value[0]) || !Number.isFinite(+value[1])) return null;
  return { lat: +value[0], lng: +value[1] };
}

export default function GoogleDrivingMapView({
  data, selectedRoute, selectedRouteNumber = 1, hoveredRouteNumber,
  onSelectRoute = () => {}, onHoverRoute = () => {},
  currentLocation, navigationActive, navigationAccuracy,
  startCoordinate, destinationCoordinate, startDraggable = true,
  onSetMapStart = () => {}, onSetMapDestination = () => {},
  onUseFreeRouting = () => {},
  onMoveStart = () => {}, onMoveDestination = () => {},
  locationFocusKey = 0, routeFocusKey = 0,
  stepFocusCoordinate, stepFocusKey = 0, mapStyle = "street", darkMode,
}) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const previousLocationFocusKey = useRef(locationFocusKey);
  const mapItems = useRef([]);
  const positionItems = useRef([]);
  const callbacks = useRef({ onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute, onHoverRoute });
  useEffect(() => {
    callbacks.current = { onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute, onHoverRoute };
  }, [onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute, onHoverRoute]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let popup;
    loadGoogleMaps().then(maps => {
      if (cancelled || !container.current) return;
      const map = new maps.Map(container.current, {
        center: point(currentLocation) || DEFAULT_CENTER,
        zoom: 13,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        gestureHandling: "greedy",
      });
      mapRef.current = map;
      const traffic = new maps.TrafficLayer();
      traffic.setMap(map);
      mapItems.current.push(traffic);
      popup = new maps.InfoWindow();
      const showContextMenu = event => {
        const location = event.latLng;
        if (!location) return;
        const coords = [location.lat(), location.lng()];
        const buttons = document.createElement("div");
        buttons.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:5px";
        const header = document.createElement("strong");
        header.textContent = "Use this location";
        buttons.appendChild(header);
        for (const [label, fn] of [
          ["Set as start", "onSetMapStart"],
          ["Set as destination", "onSetMapDestination"],
        ]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.style.cssText = "padding:5px 9px;background:#edf2f5;border-radius:5px;text-align:left";
          button.addEventListener("click", () => {
            callbacks.current[fn](coords);
            popup.close();
          });
          buttons.appendChild(button);
        }
        popup.setContent(buttons);
        popup.setPosition(location);
        popup.open({ map });
      };
      // Google Maps JS now recommends contextmenu; rightclick supports older SDKs.
      map.addListener("contextmenu", showContextMenu);
      setReady(true);
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => {
      cancelled = true;
      popup?.close();
      mapItems.current.forEach(item => item.setMap(null));
      positionItems.current.forEach(item => item.setMap(null));
      mapItems.current = [];
      positionItems.current = [];
      if (mapRef.current) window.google?.maps?.event.clearInstanceListeners(mapRef.current);
      mapRef.current = null;
    };
    // Initialize one Google map per mount, not on every GPS update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    mapRef.current.setMapTypeId(mapStyle === "satellite" ? "satellite" : mapStyle === "hybrid" ? "hybrid" : "roadmap");
    mapRef.current.setOptions({
      styles: darkMode && mapStyle === "street" ? [
        { elementType: "geometry", stylers: [{ color: "#233241" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#a8bdcc" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#17232e" }] },
      ] : [],
    });
  }, [ready, mapStyle, darkMode]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const maps = window.google.maps;
    const map = mapRef.current;
    mapItems.current.filter(item => !(item instanceof maps.TrafficLayer)).forEach(item => item.setMap(null));
    mapItems.current = mapItems.current.filter(item => item instanceof maps.TrafficLayer);
    const items = mapItems.current;
    const chosen = selectedRoute || data?.routes?.find(r => r.route_number === selectedRouteNumber) || data?.routes?.[0];
    for (const route of data?.routes || []) {
      const active = route.route_number === chosen?.route_number;
      const highlighted = route.route_number === hoveredRouteNumber;
      const polyline = new maps.Polyline({
        path: (route.route_coordinates || []).map(point).filter(Boolean),
        geodesic: false, map,
        strokeColor: active ? "#54846c" : highlighted ? "#668e79" : "#879398",
        strokeOpacity: active ? 1 : highlighted ? 0.9 : 0.55,
        strokeWeight: active ? 7 : highlighted ? 7 : 5,
        zIndex: active ? 3 : highlighted ? 2 : 1,
      });
      polyline.addListener("click", () => callbacks.current.onSelectRoute(route.route_number));
      polyline.addListener("mouseover", () => callbacks.current.onHoverRoute(route.route_number));
      polyline.addListener("mouseout", () => callbacks.current.onHoverRoute(null));
      items.push(polyline);
    }
    // Route geometry only changes with routing/selection, not every GPS fix.
  }, [ready, data, selectedRoute, selectedRouteNumber, hoveredRouteNumber]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const maps = window.google.maps;
    const map = mapRef.current;
    positionItems.current.forEach(item => item.setMap(null));
    positionItems.current = [];
    const items = positionItems.current;
    for (const [coords, label, draggable, action] of [
      [startCoordinate || data?.start?.coordinates, "A", startDraggable && !navigationActive, "onMoveStart"],
      [destinationCoordinate || data?.end?.coordinates, "B", !navigationActive, "onMoveDestination"],
    ]) {
      if (!point(coords)) continue;
      const marker = new maps.Marker({
        map, position: point(coords), label, draggable,
      });
      marker.addListener("dragend", event => {
        if (event.latLng) callbacks.current[action]([event.latLng.lat(), event.latLng.lng()]);
      });
      items.push(marker);
    }
    if (point(currentLocation)) {
      const marker = new maps.Marker({
        map, position: point(currentLocation),
        icon: { path: maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#448bc2", fillOpacity: 1, strokeColor: "white", strokeWeight: 3 },
        title: "Your location",
      });
      items.push(marker);
      if (navigationActive && Number(navigationAccuracy) > 0) {
        items.push(new maps.Circle({ map, center: point(currentLocation), radius: +navigationAccuracy,
          strokeColor: "#448bc2", strokeOpacity: 0.3, fillColor: "#448bc2", fillOpacity: 0.08 }));
      }
    }
    // Render updates are lightweight; map tiles are not reloaded.
  }, [ready, data, startCoordinate, destinationCoordinate, startDraggable,
    navigationActive, currentLocation, navigationAccuracy]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const coords = selectedRoute?.route_coordinates || data?.routes?.[0]?.route_coordinates || [];
    if (coords.length < 2) return;
    const bounds = new window.google.maps.LatLngBounds();
    coords.map(point).filter(Boolean).forEach(position => bounds.extend(position));
    mapRef.current.fitBounds(bounds, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, routeFocusKey]);

  useEffect(() => {
    if (ready && point(stepFocusCoordinate)) {
      mapRef.current.panTo(point(stepFocusCoordinate));
      mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 13, 17));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stepFocusKey]);

  useEffect(() => {
    const requestedFocus = locationFocusKey !== previousLocationFocusKey.current;
    previousLocationFocusKey.current = locationFocusKey;
    if (ready && point(currentLocation) && (navigationActive || requestedFocus)) {
      mapRef.current.panTo(point(currentLocation));
      if (navigationActive) mapRef.current.setZoom(Math.max(17, mapRef.current.getZoom() || 13));
    }
  }, [ready, navigationActive, locationFocusKey, currentLocation]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {error && (
        <div className="absolute left-4 top-4 z-10 rounded bg-white p-3 text-sm text-red-700">
          Google Maps unavailable: {error}
          <button type="button" onClick={onUseFreeRouting} className="ml-3 underline">Use free OSRM routing</button>
        </div>
      )}
    </div>
  );
}
