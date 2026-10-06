import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MdCenterFocusStrong, MdMap, MdMyLocation, MdSatelliteAlt } from "react-icons/md";
import { PiSunFill } from "react-icons/pi";
import { TbMoonStars } from "react-icons/tb";

import MapView from "./components/MapView.jsx";
import RoutePanel from "./components/RoutePanel.jsx";
import SearchPanel from "./components/SearchPanel.jsx";

const PREFERENCES_KEY = "map-router-preferences-v1";

const VALID_MODES = new Set(["driving", "walking", "cycling", "transit"]);
const VALID_CYCLING_TYPES = new Set(["regular", "road", "mountain", "electric"]);
const VALID_MAP_STYLES = new Set(["street", "satellite"]);
const VALID_TIMING_MODES = new Set(["now", "scheduled"]);
const VALID_TRANSIT_PREFERENCES = new Set([
  "balanced",
  "less_walking",
  "fastest",
]);

// Capture the page-load time outside React rendering. React's purity lint rule
// correctly rejects Date.now() when it is called during a component render.
const PAGE_LOAD_TIME = Date.now();

function readSharedRoute() {
  try {
    const params = new URLSearchParams(window.location.search);
    const sharedMode = params.get("mode");
    const sharedBike = params.get("bike");
    const sharedTransit = params.get("transit");
    const sharedTiming = params.get("timing");

    return {
      start: params.get("start") || "",
      destination: params.get("destination") || "",
      mode: VALID_MODES.has(sharedMode) ? sharedMode : null,
      cyclingType: VALID_CYCLING_TYPES.has(sharedBike) ? sharedBike : null,
      transitPreference: VALID_TRANSIT_PREFERENCES.has(sharedTransit)
        ? sharedTransit
        : null,
      timingMode: VALID_TIMING_MODES.has(sharedTiming) ? sharedTiming : null,
      departureDate: params.get("date") || "",
      departureTime: params.get("time") || "",
    };
  } catch (error) {
    console.warn("Could not read shared route URL:", error);
    return {};
  }
}

function loadPreferences() {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return {};
    }

    const saved = JSON.parse(raw);
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    console.warn("Could not load saved map preferences:", error);
    return {};
  }
}

function validSavedValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeInputValue(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function initialScheduledTime(nowMs) {
  const date = new Date(nowMs + 15 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
  return {
    date: toDateInputValue(date),
    time: toTimeInputValue(date),
  };
}

const DEFAULT_INITIAL_SCHEDULE = initialScheduledTime(PAGE_LOAD_TIME);

function coordinateString(location) {
  if (!Array.isArray(location) || location.length < 2) {
    return "";
  }

  return `${Number(location[0]).toFixed(7)}, ${Number(location[1]).toFixed(7)}`;
}

export default function App() {
  const savedPreferences = useMemo(() => loadPreferences(), []);
  const sharedRoute = useMemo(() => readSharedRoute(), []);
  const initialSchedule = useMemo(() => {
    const fallback = DEFAULT_INITIAL_SCHEDULE;
    const savedDate = sharedRoute.departureDate || savedPreferences.departureDate;
    const savedTime = sharedRoute.departureTime || savedPreferences.departureTime;

    if (!savedDate || !savedTime) {
      return fallback;
    }

    const savedDeparture = new Date(`${savedDate}T${savedTime}:00`);
    if (
      Number.isNaN(savedDeparture.getTime()) ||
      savedDeparture.getTime() < PAGE_LOAD_TIME
    ) {
      return fallback;
    }

    return { date: savedDate, time: savedTime };
  }, [savedPreferences, sharedRoute]);

  const sharedUsesCurrentLocation = sharedRoute.start === "Current location";
  const [start, setStart] = useState(() =>
    sharedRoute.start ||
    (savedPreferences.startUsesCurrentLocation ? "Current location" : "")
  );
  const [startUsesCurrentLocation, setStartUsesCurrentLocation] = useState(() =>
    sharedRoute.start
      ? sharedUsesCurrentLocation
      : savedPreferences.startUsesCurrentLocation === true
  );
  const [destination, setDestination] = useState(() => sharedRoute.destination || "");
  const [mode, setMode] = useState(() =>
    sharedRoute.mode ||
    validSavedValue(savedPreferences.mode, VALID_MODES, "driving")
  );
  const [cyclingType, setCyclingType] = useState(() =>
    sharedRoute.cyclingType ||
    validSavedValue(
      savedPreferences.cyclingType,
      VALID_CYCLING_TYPES,
      "regular"
    )
  );
  const [selectedRouteNumber, setSelectedRouteNumber] = useState(1);
  const [hoveredRouteNumber, setHoveredRouteNumber] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState(
    "Enter a starting point and destination."
  );
  const [currentLocation, setCurrentLocation] = useState(null);
  const [locationFocusKey, setLocationFocusKey] = useState(0);
  const [routeFocusKey, setRouteFocusKey] = useState(0);
  const [stepFocusKey, setStepFocusKey] = useState(0);
  const [stepFocusCoordinate, setStepFocusCoordinate] = useState(null);
  const [startMapCoordinate, setStartMapCoordinate] = useState(null);
  const [destinationMapCoordinate, setDestinationMapCoordinate] = useState(null);
  const [data, setData] = useState(null);
  const [darkMode, setDarkMode] = useState(
    () => savedPreferences.darkMode === true
  );
  const [mapStyle, setMapStyle] = useState(() =>
    validSavedValue(savedPreferences.mapStyle, VALID_MAP_STYLES, "street")
  );
  const [timingMode, setTimingMode] = useState(() =>
    sharedRoute.timingMode ||
    validSavedValue(savedPreferences.timingMode, VALID_TIMING_MODES, "now")
  );
  const [transitPreference, setTransitPreference] = useState(() =>
    sharedRoute.transitPreference ||
    validSavedValue(
      savedPreferences.transitPreference,
      VALID_TRANSIT_PREFERENCES,
      "balanced"
    )
  );
  const [departureDate, setDepartureDate] = useState(initialSchedule.date);
  const [departureTime, setDepartureTime] = useState(initialSchedule.time);

  const initialLocationRequested = useRef(false);
  const searchRequestId = useRef(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({
          mode,
          cyclingType,
          startUsesCurrentLocation,
          darkMode,
          mapStyle,
          timingMode,
          transitPreference,
          departureDate,
          departureTime,
        })
      );
    } catch (error) {
      console.warn("Could not save map preferences:", error);
    }
  }, [
    mode,
    cyclingType,
    startUsesCurrentLocation,
    darkMode,
    mapStyle,
    timingMode,
    transitPreference,
    departureDate,
    departureTime,
  ]);

  const selectedRoute = useMemo(
    () =>
      data?.routes?.find(
        route => route.route_number === selectedRouteNumber
      ) || data?.routes?.[0] || null,
    [data, selectedRouteNumber]
  );

  function getDepartureDateTime(requestedTimingMode = timingMode) {
    if (requestedTimingMode !== "scheduled") {
      return null;
    }

    if (!departureDate || !departureTime) {
      throw new Error("Choose both a departure date and time.");
    }

    const value = `${departureDate}T${departureTime}:00`;
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Choose a valid departure date and time.");
    }

    if (parsed.getTime() < Date.now() - 2 * 60 * 1000) {
      throw new Error("Scheduled departure must be in the future.");
    }

    return value;
  }

  async function searchRoutes({
    requestedMode = mode,
    requestedCyclingType = cyclingType,
    requestedStart = start,
    requestedDestination = destination,
    requestedTimingMode = timingMode,
    requestedUseCurrentLocation = startUsesCurrentLocation,
    requestedTransitPreference = transitPreference,
  } = {}) {
    const cleanStart =
      requestedUseCurrentLocation && currentLocation
        ? coordinateString(currentLocation)
        : requestedStart.trim();
    const cleanDestination = requestedDestination.trim();

    if (requestedUseCurrentLocation && !currentLocation) {
      setError(true);
      setStatus("Current location is not available yet.");
      return;
    }

    if (!cleanStart || !cleanDestination) {
      setError(true);
      setStatus("Enter both locations.");
      return;
    }

    const effectiveTimingMode =
      requestedMode === "transit" ? requestedTimingMode : "now";

    let departureDatetime;
    try {
      departureDatetime = getDepartureDateTime(effectiveTimingMode);
    } catch (scheduleError) {
      setError(true);
      setStatus(scheduleError.message);
      return;
    }

    const requestId = ++searchRequestId.current;
    setLoading(true);
    setError(false);
    setStatus(
      effectiveTimingMode === "scheduled"
        ? "Finding your scheduled route..."
        : "Finding route..."
    );

    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode,
          route_type: requestedCyclingType,
          departure_datetime: departureDatetime,
          transit_preference: requestedTransitPreference,
        }),
      });

      const result = await response.json();

      if (requestId !== searchRequestId.current) {
        return;
      }

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Route could not be found.");
      }

      const displayedResult =
        requestedUseCurrentLocation && result.start
          ? {
              ...result,
              start: {
                ...result.start,
                address: "Current location",
              },
            }
          : result;

      setData(displayedResult);
      setStartMapCoordinate(result.start?.coordinates || null);
      setDestinationMapCoordinate(result.end?.coordinates || null);
      setSelectedRouteNumber(result.fastest_route_number || 1);
      setRouteFocusKey(key => key + 1);

      const scheduledSuffix =
        effectiveTimingMode === "scheduled" ? " • scheduled" : "";

      if (requestedMode === "driving") {
        const routeCount = result.routes.length;
        setStatus(
          `${routeCount} driving route${
            routeCount === 1 ? "" : "s"
          } found${scheduledSuffix}`
        );
      } else if (requestedMode === "walking") {
        setStatus(`Walking route found${scheduledSuffix}`);
      } else if (requestedMode === "cycling") {
        const typeName =
          requestedCyclingType.charAt(0).toUpperCase() +
          requestedCyclingType.slice(1);
        setStatus(`${typeName} cycling route found${scheduledSuffix}`);
      } else if (requestedMode === "transit") {
        const realtime = result.routes?.[0]?.realtime;

        if (effectiveTimingMode === "scheduled") {
          setStatus("Scheduled transit route found");
        } else if (realtime?.available && realtime?.used_live_updates) {
          setStatus("Transit route found • live predictions used");
        } else if (realtime?.available) {
          setStatus("Transit route found • live feed connected");
        } else {
          setStatus("Transit route found • scheduled data");
        }
      } else {
        setStatus(`Route found${scheduledSuffix}`);
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

  function handleStartChange(nextStart) {
    setStart(nextStart);
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(null);
  }

  function handleDestinationChange(nextDestination) {
    setDestination(nextDestination);
    setDestinationMapCoordinate(null);
  }

  function setStartFromMap(coordinate, { reroute = true } = {}) {
    const value = coordinateString(coordinate);
    if (!value) {
      return;
    }

    setStart(value);
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(coordinate);
    setError(false);
    setStatus("Starting point set from the map.");

    if (reroute && destination.trim()) {
      searchRoutes({
        requestedStart: value,
        requestedDestination: destination,
        requestedUseCurrentLocation: false,
      });
    }
  }

  function setDestinationFromMap(coordinate, { reroute = true } = {}) {
    const value = coordinateString(coordinate);
    if (!value) {
      return;
    }

    setDestination(value);
    setDestinationMapCoordinate(coordinate);
    setError(false);
    setStatus("Destination set from the map.");

    const canRoute = startUsesCurrentLocation ? Boolean(currentLocation) : start.trim();
    if (reroute && canRoute) {
      searchRoutes({
        requestedDestination: value,
      });
    }
  }

  function changeMode(nextMode) {
    setMode(nextMode);

    if (start.trim() && destination.trim()) {
      searchRoutes({ requestedMode: nextMode });
    }
  }

  function changeCyclingType(nextType) {
    setCyclingType(nextType);

    if (mode === "cycling" && start.trim() && destination.trim()) {
      searchRoutes({
        requestedMode: "cycling",
        requestedCyclingType: nextType,
      });
    }
  }

  function changeTransitPreference(nextPreference) {
    setTransitPreference(nextPreference);

    if (mode === "transit" && start.trim() && destination.trim()) {
      searchRoutes({
        requestedMode: "transit",
        requestedTransitPreference: nextPreference,
      });
    }
  }

  function changeTimingMode(nextMode) {
    if (nextMode === "scheduled") {
      const selected = new Date(`${departureDate}T${departureTime}:00`);

      if (Number.isNaN(selected.getTime()) || selected.getTime() < Date.now()) {
        const next = initialScheduledTime(Date.now());
        setDepartureDate(next.date);
        setDepartureTime(next.time);
      }
    }

    setTimingMode(nextMode);
  }

  function swapLocations() {
    const nextStart = destination;
    const nextDestination =
      startUsesCurrentLocation && currentLocation
        ? coordinateString(currentLocation)
        : start;

    setStart(nextStart);
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(null);
    setDestination(nextDestination);
    setDestinationMapCoordinate(null);

    if (nextStart.trim() && nextDestination.trim()) {
      searchRoutes({
        requestedStart: nextStart,
        requestedDestination: nextDestination,
        requestedUseCurrentLocation: false,
      });
    }
  }

  const findLocation = useCallback(({
    focus = true,
    quiet = false,
    useAsStart = false,
  } = {}) => {
    if (!navigator.geolocation) {
      if (!quiet) {
        setError(true);
        setStatus("Location is not supported by this browser.");
      }
      return;
    }

    if (useAsStart && currentLocation) {
      setStart("Current location");
      setStartUsesCurrentLocation(true);
      setStartMapCoordinate(currentLocation);
      setError(false);
      setStatus("Using your current location as the starting point.");
      return;
    }

    if (!quiet) {
      setError(false);
      setStatus("Getting your location...");
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const location = [
          position.coords.latitude,
          position.coords.longitude,
        ];
        setCurrentLocation(location);

        if (useAsStart) {
          setStart("Current location");
          setStartUsesCurrentLocation(true);
          setStartMapCoordinate(location);
        }

        if (focus) {
          setLocationFocusKey(key => key + 1);
        }

        if (!quiet) {
          setStatus(
            useAsStart
              ? "Using your current location as the starting point."
              : "Current location found."
          );
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
  }, [currentLocation]);

  function selectRoute(routeNumber) {
    setSelectedRouteNumber(routeNumber);
    setHoveredRouteNumber(null);
    setRouteFocusKey(key => key + 1);
  }

  function focusStep(step) {
    if (!Array.isArray(step?.coordinates) || step.coordinates.length < 2) {
      return;
    }

    setStepFocusCoordinate(step.coordinates);
    setStepFocusKey(key => key + 1);
  }

  async function shareRoute() {
    if (!start.trim() || !destination.trim()) {
      setError(true);
      setStatus("Choose a start and destination before sharing.");
      return;
    }

    const params = new URLSearchParams();
    params.set(
      "start",
      startUsesCurrentLocation ? "Current location" : start.trim()
    );
    params.set("destination", destination.trim());
    params.set("mode", mode);

    if (mode === "cycling") {
      params.set("bike", cyclingType);
    }

    if (mode === "transit") {
      params.set("transit", transitPreference);
      params.set("timing", timingMode);

      if (timingMode === "scheduled") {
        params.set("date", departureDate);
        params.set("time", departureTime);
      }
    }

    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, "", url);

    try {
      await navigator.clipboard.writeText(url);
      setError(false);
      setStatus("Route link copied to clipboard.");
    } catch (clipboardError) {
      console.warn("Clipboard copy failed:", clipboardError);
      window.prompt("Copy this route link:", url);
    }
  }

  useEffect(() => {
    if (initialLocationRequested.current) {
      return;
    }

    initialLocationRequested.current = true;
    findLocation({ focus: false, quiet: true });
  }, [findLocation]);

  const displayedMode = data?.mode || mode;
  const controlSurface = darkMode
    ? "border-button bg-charcoal/95 text-darkmode-gray"
    : "border-white/80 bg-white/95 text-charcoal";

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden ${
        darkMode ? "bg-charcoal" : "bg-green"
      }`}
    >
      <aside
        className={`z-[1000] flex h-screen w-[360px] flex-shrink-0 flex-col border-r shadow-xl ${
          darkMode
            ? "border-button/50 bg-charcoal"
            : "border-button-light/70 bg-white"
        } max-[760px]:absolute max-[760px]:bottom-3 max-[760px]:left-3 max-[760px]:right-3 max-[760px]:h-[60vh] max-[760px]:w-auto max-[760px]:overflow-hidden max-[760px]:rounded-2xl max-[760px]:border`}
      >
        <header className="px-5 pb-4 pt-4">
          <div className="flex items-center justify-between">
            <a
              href="https://github.com/kus001/map"
              target="_blank"
              rel="noreferrer"
              className={`inline-block text-2xl font-bold tracking-tight transition-all duration-200 active:scale-95 hover:tracking-wider ${
                darkMode ? "text-blue-light hover:text-blue" : "text-green hover:text-green-dark"
              }`}
            >
              Map Router
            </a>

            <button
              type="button"
              onClick={() => setDarkMode(value => !value)}
              title="Toggle dark mode"
              className={`rounded-lg border p-2 transition hover:-translate-y-px active:scale-90 ${
                darkMode
                  ? "border-button bg-charcoal-light text-blue-light"
                  : "border-button-light bg-white text-green-dark"
              }`}
            >
              {darkMode ? <PiSunFill /> : <TbMoonStars />}
            </button>
          </div>

          <div
            className={`mt-1 text-[11px] ${
              darkMode ? "text-darkmode-gray" : "text-button-darkest"
            }`}
          >
            Drive. Walk. Bike. Transit. Sleep.
          </div>
        </header>

        <SearchPanel
          start={start}
          destination={destination}
          setStart={handleStartChange}
          setDestination={handleDestinationChange}
          mode={mode}
          cyclingType={cyclingType}
          onModeChange={changeMode}
          onCyclingTypeChange={changeCyclingType}
          transitPreference={transitPreference}
          onTransitPreferenceChange={changeTransitPreference}
          onSearch={searchRoutes}
          onSwap={swapLocations}
          loading={loading}
          darkMode={darkMode}
          timingMode={timingMode}
          onTimingModeChange={changeTimingMode}
          departureDate={departureDate}
          departureTime={departureTime}
          onDepartureDateChange={setDepartureDate}
          onDepartureTimeChange={setDepartureTime}
          usingCurrentLocation={startUsesCurrentLocation}
          onUseCurrentLocation={() =>
            findLocation({ focus: false, quiet: false, useAsStart: true })
          }
        />

        <RoutePanel
          data={data}
          selectedRoute={selectedRoute}
          selectedRouteNumber={selectedRouteNumber}
          onSelectRoute={selectRoute}
          onRouteHover={setHoveredRouteNumber}
          onStepSelect={focusStep}
          onShareRoute={shareRoute}
          displayedMode={displayedMode}
          status={status}
          error={error}
          darkMode={darkMode}
        />

        <footer
          className={`flex items-center justify-center gap-2 border-t py-3 text-[11px] ${
            darkMode
              ? "border-button/40 text-darkmode-gray"
              : "border-button-light/50 text-button"
          }`}
        >
          <span>made by</span>
          <a
            href="https://github.com/kus001"
            target="_blank"
            rel="noreferrer"
            className={`hover:underline duration-100 hover:tracking-wider ${darkMode ? "hover:text-blue-light" : "hover:text-green"}`}
          >
            Kush
          </a>
          <span>•</span>
          <a
            href="https://github.com/BigBrain244466666"
            target="_blank"
            rel="noreferrer"
            className={`hover:underline duration-100 hover:tracking-wider ${darkMode ? "hover:text-blue-light" : "hover:text-green"}`}
          >
            Victor
          </a>
          <span>•</span>
          <a
            href="https://github.com/roc-ket-cod-er"
            target="_blank"
            rel="noreferrer"
            className={`hover:underline duration-100 hover:tracking-wider ${darkMode ? "hover:text-blue-light" : "hover:text-green"}`}
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
          hoveredRouteNumber={hoveredRouteNumber}
          displayedMode={displayedMode}
          onSelectRoute={selectRoute}
          onHoverRoute={setHoveredRouteNumber}
          currentLocation={currentLocation}
          startCoordinate={
            startUsesCurrentLocation ? currentLocation : startMapCoordinate
          }
          destinationCoordinate={destinationMapCoordinate}
          startLabel={start}
          destinationLabel={destination}
          startDraggable={!startUsesCurrentLocation}
          onSetMapStart={coordinate => setStartFromMap(coordinate)}
          onSetMapDestination={coordinate => setDestinationFromMap(coordinate)}
          onMoveStart={coordinate => setStartFromMap(coordinate)}
          onMoveDestination={coordinate => setDestinationFromMap(coordinate)}
          locationFocusKey={locationFocusKey}
          routeFocusKey={routeFocusKey}
          stepFocusCoordinate={stepFocusCoordinate}
          stepFocusKey={stepFocusKey}
          darkMode={darkMode}
          mapStyle={mapStyle}
        />

        <div className="absolute bottom-4 right-4 z-[500] flex items-center gap-2 max-[760px]:bottom-[62vh]">
          <div
            className={`flex overflow-hidden rounded-xl border shadow-lg backdrop-blur ${controlSurface}`}
          >
            <button
              type="button"
              onClick={() => setMapStyle("street")}
              title="Street map"
              className={`flex h-11 items-center gap-1.5 px-3 text-sm font-semibold transition ${
                mapStyle === "street"
                  ? darkMode
                    ? "bg-blue text-white"
                    : "bg-green text-white"
                  : darkMode
                    ? "text-darkmode-gray hover:bg-blue/10"
                    : "text-charcoal hover:bg-green/10"
              }`}
            >
              <MdMap className="text-lg" />
              <span className="max-[900px]:hidden">Map</span>
            </button>

            <button
              type="button"
              onClick={() => setMapStyle("satellite")}
              title="Satellite map"
              className={`flex h-11 items-center gap-1.5 border-l px-3 text-sm font-semibold transition ${
                darkMode ? "border-button" : "border-button-light"
              } ${
                mapStyle === "satellite"
                  ? darkMode
                    ? "bg-blue text-white"
                    : "bg-green text-white"
                  : darkMode
                    ? "text-darkmode-gray hover:bg-blue/10"
                    : "text-charcoal hover:bg-green/10"
              }`}
            >
              <MdSatelliteAlt className="text-lg" />
              <span className="max-[900px]:hidden">Satellite</span>
            </button>
          </div>

          {selectedRoute?.route_coordinates?.length > 1 && (
            <button
              type="button"
              onClick={() => setRouteFocusKey(key => key + 1)}
              title="Fit route"
              className={`flex size-11 items-center justify-center rounded-xl border text-xl shadow-lg backdrop-blur transition hover:-translate-y-px hover:bg-green hover:text-white ${controlSurface}`}
            >
              <MdCenterFocusStrong />
            </button>
          )}

          <button
            type="button"
            onClick={() => findLocation({ focus: true, quiet: false })}
            title="My location"
            className={`flex size-11 items-center justify-center rounded-xl border text-xl shadow-lg backdrop-blur transition hover:-translate-y-px hover:bg-green hover:text-white ${controlSurface}`}
          >
            <MdMyLocation />
          </button>
        </div>
      </main>
    </div>
  );
}
