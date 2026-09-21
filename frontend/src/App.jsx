// App.jsx

import { useMemo, useState } from "react";
import {
  ArrowUpDown,
  Bike,
  Car,
  Circle,
  Footprints,
  LoaderCircle,
  LocateFixed,
  MapPin,
  Navigation,
  Search
} from "lucide-react";
import MapView from "./components/Mapview.jsx";

const MODES = [
  {
    id: "driving",
    label: "Drive",
    Icon: Car
  },
  {
    id: "walking",
    label: "Walk",
    Icon: Footprints
  },
  {
    id: "cycling",
    label: "Bike",
    Icon: Bike
  }
];

function formatDuration(minutes) {
  const rounded = Math.round(minutes);

  if (rounded < 60) {
    return `${rounded} min`;
  }

  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  
  if (remainingMinutes === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${remainingMinutes} min`;
}

function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`
  }

  return `${Math.round(meters)} m`
}

function makeDirectionText(step) {
  if (step.instruction) {
    return step.instruction;
  }

  const type = step.type || "";
  const modifier = step.modifier || "";
  const road = step.road || "";

  let text = "";

  if (type === "depart") {
    text = "Start";

    if (modifier) {
      text += ` heading ${modifier}`;
    }
  }

  else if (type === "arrive") {
    return "Arrive at your destination";
  }

  else if (type === "turn") {
    text = "Turn";

    if (modifier) {
      text += `${modifier}`;
    }
  }

  else if (type === "continue") {
    text = "Continue";

    if (modifier) {
      text += `${modifier}`;
    }
  }

  else if (type === "end of road") {
    text = "At the end of the road";

    if (modifier) {
      text += `, turn ${modifier}`;
    }
  }

  else if (type === "roundabout") {
    text = "Enter the roundabout";
  }

  else {
    text = type.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
    if (modifier) {
      text += `${modifier}`;
    }
  }

  if (road && type !== "arrive") {
    text += ` onto ${road}`;
  }

  if (!text) {
    return road || "Continue";
  }

  return text;
}

function getRouteModeName(mode) {
  if (mode === "walking") {
    return "Walking route";
  }

  if (mode === "cycling") {
    return "Cycling route";
  }

  return null;
}

export default function App() {
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState("driving");
  const [data, setData] = useState(null);
  const [selectedRouteNumber, setSelectedRouteNumber] = useState(1);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Enter a starting point and destination.");
  const [currentLocation, setCurrentLocation] = useState(null);
  const selecteRoute = useMemo(() => {
    return (
      data?.routes?.find(
        route =>
          route.route_number === selectedRouteNumber
      ) || null
    );
  }, [data, selectedRouteNumber]);
  const displayedRouteMode = data?.mode || mode;
  async function searchRoutes(
    requestedMode = mode,
    requestedStart = start,
    requestedDestination = destination
  ) {
    const cleanStart = requestedStart.trim();
    const cleanDestination = requestedDestination.trim();

    if (!cleanStart || !cleanDestination) {
      setError(true);
      setStatus("Enter both a starting point and destination.");
      return;
    }

    setLoading(true);
    setError(false);

    if (requestedMode === "walking") {
      setStatus("finding walking route...");
    }

    else if (requestedMode === "cycling") {
      setStatus("Finding cycling route...");
    }

    else {
      setStatus("Finding driving routes...");
    }

    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode
        })
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "No route could be found.");
      }
      
      setData(result);

      setSelectedRouteNumber(result.fastest_route_number);

      if (requestedmode === "walking") {
        setStatus("Walking route found");
      }

      else if (requestedMode === "cycling") {
        setStatus("Cycling route found");
      }

      else {
        const count = result.routes.length;

        setStatus(`${count} driving route${count === 1 ? "" : "s"} found`);
      }
    }

    catch (routeError) {
      console.error("Route search error:", routeError);
      setError(true);
      SetStatus(routeError.message || "Something went wrong while finding the route.");
    }

    finally {
      setLoading(false);
    }
  }

  
}
