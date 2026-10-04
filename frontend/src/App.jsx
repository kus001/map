import { useEffect, useMemo, useRef, useState } from "react";
import { MdMyLocation } from "react-icons/md";
import { PiSunFill } from "react-icons/pi";
import { TbMoonStars } from "react-icons/tb";

import MapView from "./components/MapView.jsx";
import RoutePanel from "./components/RoutePanel.jsx";
import SearchPanel from "./components/SearchPanel.jsx";

export default function App() {
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState("driving");
  const [cyclingType, setCyclingType] = useState("regular");
  const [selectedRouteNumber, setSelectedRouteNumber] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState("Enter a starting point and destination.");
  const [currentLocation, setCurrentLocation] = useState(null);
  const [locationFocusKey, setLocationFocusKey] = useState(0);
  const [data, setData] = useState(null);
  const [darkMode, setDarkMode] = useState(false);

  const initialLocationRequested = useRef(false);
  const searchRequestId = useRef(0);

  const selectedRoute = useMemo(
    () =>
      data?.routes?.find(
        route => route.route_number === selectedRouteNumber
      ) || data?.routes?.[0] || null,
    [data, selectedRouteNumber]
  );

  async function searchRoutes(
    requestedMode = mode,
    requestedCyclingType = cyclingType,
    requestedStart = start,
    requestedDestination = destination
  ) {
    const cleanStart = requestedStart.trim();
    const cleanDestination = requestedDestination.trim();

    if (!cleanStart || !cleanDestination) {
      setError(true);
      setStatus("Enter both locations.");
      return;
    }

    const requestId = ++searchRequestId.current;
    setLoading(true);
    setError(false);
    setStatus("Finding route...");
    setData(null);
    setSelectedRouteNumber(1);

    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode,
          route_type: requestedCyclingType,
        }),
      });

      const result = await response.json();

      if (requestId !== searchRequestId.current) {
        return;
      }

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Route could not be found.");
      }

      setData(result);
      setSelectedRouteNumber(result.fastest_route_number || 1);

      if (requestedMode === "driving") {
        const routeCount = result.routes.length;
        setStatus(`${routeCount} driving route${routeCount === 1 ? "" : "s"} found`);
      } else if (requestedMode === "walking") {
        setStatus("Walking route found");
      } else if (requestedMode === "cycling") {
        const typeName =
          requestedCyclingType.charAt(0).toUpperCase() + requestedCyclingType.slice(1);
        setStatus(`${typeName} cycling route found`);
      } else if (requestedMode === "transit") {
        const realtime = result.routes?.[0]?.realtime;

        if (realtime?.available && realtime?.used_live_updates) {
          setStatus("Transit route found • live predictions used");
        } else if (realtime?.available) {
          setStatus("Transit route found • live feed connected");
        } else {
          setStatus("Transit route found • scheduled data");
        }
      } else {
        setStatus("Route found");
      }
    } catch (routeError) {
      if (requestId !== searchRequestId.current) {
        return;
      }

      console.error("Route search failed:", routeError);
      setError(true);
      setStatus(routeError.message || "Something went wrong.");
    } finally {
      if (requestId === searchRequestId.current) {
        setLoading(false);
      }
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

  function findLocation({ focus = true, quiet = false } = {}) {
    if (!navigator.geolocation) {
      if (!quiet) {
        setError(true);
        setStatus("Location is not supported by this browser.");
      }
      return;
    }

    if (!quiet) {
      setError(false);
      setStatus("Getting your location...");
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const location = [position.coords.latitude, position.coords.longitude];
        setCurrentLocation(location);

        if (focus) {
          setLocationFocusKey(key => key + 1);
        }

        if (!quiet) {
          setStatus("Current location found.");
        }
      },
      locationError => {
        console.error("Location error:", locationError);

        if (!quiet) {
          setError(true);
          setStatus("Could not access your location.");
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  }

  useEffect(() => {
    if (initialLocationRequested.current) {
      return;
    }

    initialLocationRequested.current = true;
    findLocation({ focus: false, quiet: true });
  }, []);

  const displayedMode = data?.mode || mode;

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden ${
        darkMode ? "bg-green-light" : "bg-green"
      }`}
    >
      <aside
        className={`z-[1000] flex h-screen w-[360px] flex-shrink-0 flex-col border-r-2 border-charcoal shadow-xl ${
          darkMode ? "bg-charcoal" : "bg-white"
        } max-[760px]:absolute max-[760px]:bottom-3 max-[760px]:left-3 max-[760px]:right-3 max-[760px]:h-[58vh] max-[760px]:w-auto max-[760px]:overflow-hidden max-[760px]:rounded-xl max-[760px]:border-2`}
      >
        <header className="px-5 pb-4 pt-4">
          <div className="flex items-center justify-between">
            <a
              href="https://github.com/kus001/map"
              target="_blank"
              rel="noreferrer"
              className={`inline-block text-2xl font-bold tracking-tight transition-all duration-200 active:scale-95 hover:tracking-wide hover:text-green-dark ${
                darkMode ? "text-green-light" : "text-green"
              }`}
            >
              Map Router
            </a>

            <button
              type="button"
              onClick={() => setDarkMode(value => !value)}
              title="Toggle theme"
              className="rounded-lg p-2"
            >
              {darkMode ? (
                <PiSunFill className="text-xl text-green-light transition-transform hover:scale-110" />
              ) : (
                <TbMoonStars className="text-xl text-green transition-transform hover:scale-110" />
              )}
            </button>
          </div>

          <div
            className={`mt-0.5 text-[11px] ${
              darkMode ? "text-darkmode-gray" : "text-charcoal"
            }`}
          >
            Drive. Walk. Bike. Transit.
          </div>
        </header>

        <SearchPanel
          start={start}
          destination={destination}
          setStart={setStart}
          setDestination={setDestination}
          mode={mode}
          cyclingType={cyclingType}
          onModeChange={changeMode}
          onCyclingTypeChange={changeCyclingType}
          onSearch={searchRoutes}
          onSwap={swapLocations}
          loading={loading}
          darkMode={darkMode}
        />

        <RoutePanel
          data={data}
          selectedRoute={selectedRoute}
          selectedRouteNumber={selectedRouteNumber}
          onSelectRoute={setSelectedRouteNumber}
          displayedMode={displayedMode}
          status={status}
          error={error}
          darkMode={darkMode}
        />

        <footer
          className={`flex items-center justify-center gap-2 border-t border-button-light/50 py-3 text-[11px] ${
            darkMode ? "text-darkmode-gray" : "text-button"
          }`}
        >
          <span>made by</span>
          <a
            href="https://github.com/kus001"
            target="_blank"
            rel="noreferrer"
            className="transition-all hover:font-bold hover:text-green hover:underline"
          >
            Kush
          </a>
          <span>•</span>
          <a
            href="https://github.com/BigBrain244466666"
            target="_blank"
            rel="noreferrer"
            className="transition-all hover:font-bold hover:text-green hover:underline"
          >
            Victor
          </a>
          <span>•</span>
          <a
            href="https://github.com/roc-ket-cod-er"
            target="_blank"
            rel="noreferrer"
            className="transition-all hover:font-bold hover:text-green hover:underline"
          >
            Madhav
          </a>
        </footer>
      </aside>

      <main className="relative min-w-0 flex-1">
        <MapView
          data={data}
          selectedRoute={selectedRoute}
          selectedRouteNumber={selectedRouteNumber}
          displayedMode={displayedMode}
          onSelectRoute={setSelectedRouteNumber}
          currentLocation={currentLocation}
          locationFocusKey={locationFocusKey}
          darkMode={darkMode}
        />

        <button
          type="button"
          onClick={() => findLocation({ focus: true, quiet: false })}
          title="My Location"
          className="absolute bottom-[85px] right-[10px] z-[500] flex size-11 items-center justify-center rounded-lg border-2 border-charcoal bg-white text-xl text-charcoal shadow-lg transition-all duration-200 hover:-translate-y-1 hover:border-green hover:bg-green hover:text-white hover:shadow-xl active:translate-y-0 max-[750px]:bottom-[61vh]"
        >
          <MdMyLocation />
        </button>
      </main>
    </div>
  );
}
