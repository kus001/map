// app.jsx

import {useMemo, useState} from "react";
import {MdMyLocation} from "react-icons/md"
import SearchPanel from "./components/SearchPanel.jsx";
import RoutePanel from "./components/RoutePanel.jsx";
import MapView from "./components/MapView.jsx";

export default function App() {
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState("driving");
  const [cyclingType, setCyclingType] = useState("regular");
  const [selectedRouteNumber, setSelectedRouteNumber] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useStatus("Enter a starting point and destination.");
  const [currentLocation, setCurrentLocation] = useState(null);
  const selectedRoute = useMemo(() => route?.routes?.find(route => route.route_number === selectedRouteNumber) || null, [data, selectedRouteNumber]);

  async function searchRoutes(
    requestedMode = mode,
    requestedCyclingType = cyclingType,
    requestedStart = start,
    requestedDestination = destination
  ) {
    const clearnStart = requestedStart.trim();
    const cleanDestination = requestedDestination.trim();
    if (!cleanStart || !cleanDestination) {
      setError(true);
      setStatus("Enter both locations.");
      return;
    }
    setLoading(true);
    setError(false);
    setStatus("Finding route...");
    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode,
          route_type: requestedCyclingType
        })
      });
      
      let result;

      try {
        result = await response.json();
      }

      catch {
        throw new Error("The routing server returned an invalid response.");
      }

      if (!response.ok || result.success) {
        throw new Error(
          result.error || "Route could not be found."
        );
      }
      
      setData(result);

      setSelectedRouteNumber(result.fastest_route_number || 1);

      if (requestedMode === "driving") {
        const routeCount = result.routes.length;
        setStatus(
          `${routeCount} driving route ${
            routeCount === 1 ? "" : "s"
          } found`
        );
      }

      else if (requestedMode === "walking") {
        setStatus("Walking route found");
      }

      else if (requestedMode === "cycling") {
        const typeName = requestedCyclingType.charAt(0).toUpperCase() + requestedCyclingType.slice(1);
        setStatus(`${typeName} cycling route found`);
      }

      else if (requestMode === "transit") {
        setStatus("Transit route found");
      }

      else {
        setStatus("Route found");
      }
    }

    catch (routeError) {
      console.error("Route search failed: ", routeError);
      setError(true);
      setStatus(RouteError.message || "Something went wrong.");
    }

    finally {
      setLoading(false);
    }
  }
  
  function changeMode(nextMode) {
    setMode(nextMode);
    if (start.trim() && destination.trim()) {
      searchRoutes(nextMode, cyclingType, start, destination);
    }
  }

  function changeCyclingType(nextType) {
    setCyclingType(nextType);
    if (mode === "cycling" && start.trim() && destination.trim()) {
      searchRoutes("cycling", nextType, start, destination);
    }
  }

  function swapLocations() {
    const nextStart = destination;
    const nextDestination = start;

    setStart(nextStart);
    setDestination(nextDestination);

    if (nextStart.trim() && nextDestination.trim()) {
      searchRoutes(mode, cyclingType, nextStart, nextDestination);
    }
  }

  function findLocation() {
    if (!navigator.geolocation) {
      setError(true);
      setStatus("Location is not supported by this browser");
      return;
    }

    setError(false);
    setStatus("Getting your location...");

    navigator.geolocation.getCurrentPosition(
      position => {
        const location = [position.coords.latitude, position.coords.longitude];
        setCurrentLocation(location);
        setStatus("Current location found.");
      },
      locationError => {
        console.error("Location error:", locationError)
        setError(true);
        setStatus("Could not access your location.");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000
      }
    );
  }

  const displayedMode = data?.mode || mode;

}