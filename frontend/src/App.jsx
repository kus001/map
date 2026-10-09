import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MdCenterFocusStrong, MdMap, MdMyLocation, MdSatelliteAlt, MdOutlineSatellite } from "react-icons/md";
import { PiSunFill } from "react-icons/pi";
import { TbMoonStars } from "react-icons/tb";
import { IoLayers, IoClose } from "react-icons/io5";
import { MdOpenInNew } from "react-icons/md";

import MapView from "./components/MapView.jsx";
import RoutePanel from "./components/RoutePanel.jsx";
import SearchPanel from "./components/SearchPanel.jsx";
import { haversineMeters, navigationSnapshot as buildNavigationSnapshot } from "./utils/navigation.js";

const PREFERENCES_KEY = "map-router-preferences-v1";

const VALID_MODES = new Set(["driving", "walking", "cycling", "transit"]);
const VALID_CYCLING_TYPES = new Set(["regular", "road", "mountain", "electric"]);
const VALID_MAP_STYLES = new Set(["street", "satellite", "hybrid"]);
const VALID_TIMING_MODES = new Set(["now", "scheduled"]);
const VALID_TRANSIT_PREFERENCES = new Set(["balanced", "less_walking", "fastest"]);

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

function shiftClockTime(value, minutes) {
  if (!value || !Number.isFinite(Number(minutes))) {
    return value || null;
  }

  const parts = String(value).split(":");
  if (parts.length < 2) {
    return value;
  }

  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return value;
  }

  const shifted = ((hour * 60 + minute + Math.round(Number(minutes))) % 1440 + 1440) % 1440;
  return `${String(Math.floor(shifted / 60)).padStart(2, "0")}:${String(shifted % 60).padStart(2, "0")}`;
}

function nearbyClockTimestamp(value, nowMs = Date.now()) {
  if (!value) {
    return null;
  }
  const [hour, minute] = String(value).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  const candidate = new Date(nowMs);
  candidate.setHours(hour, minute, 0, 0);
  let timestamp = candidate.getTime();
  if (timestamp - nowMs > 12 * 60 * 60 * 1000) {
    timestamp -= 24 * 60 * 60 * 1000;
  } else if (nowMs - timestamp > 12 * 60 * 60 * 1000) {
    timestamp += 24 * 60 * 60 * 1000;
  }
  return timestamp;
}

function transitStepKey(step) {
  return `${step?.agency || ""}:${step?.trip_id || ""}`;
}

function clockMinutes(value) {
  if (!value) {
    return null;
  }
  const [hour, minute] = String(value).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

function impossibleTransitConnection(steps) {
  let previousTransit = null;
  let transferMinutes = 0;

  for (const step of steps || []) {
    if (step?.type === "transit") {
      if (previousTransit) {
        const arrival = clockMinutes(previousTransit.arrival_time);
        let departure = clockMinutes(step.departure_time);
        if (arrival != null && departure != null) {
          // Only interpret a lower clock time as the following day when the
          // connection genuinely crosses midnight. A normal 10:05 -> 10:00
          // pair must remain an impossible connection, not a 23h55 wait.
          if (arrival >= 18 * 60 && departure <= 6 * 60) {
            departure += 24 * 60;
          }
          const connectionMargin = departure - arrival - transferMinutes;
          if (connectionMargin < 1) {
            return {
              from: previousTransit,
              to: step,
              margin_min: connectionMargin,
            };
          }
        }
      }
      previousTransit = step;
      transferMinutes = 0;
      continue;
    }

    if (previousTransit && ["walk", "transfer"].includes(step?.type)) {
      transferMinutes += Number(step.duration_min || 0);
    }
  }

  return null;
}

export default function App() {
  const savedPreferences = useMemo(() => loadPreferences(), []);
  const [sidePanel, setIsSidePanel] = useState();
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
  const [navigationActive, setNavigationActive] = useState(false);
  const [navigationAccuracy, setNavigationAccuracy] = useState(null);
  const [navigationHeading, setNavigationHeading] = useState(null);
  const [navigationSpeedMps, setNavigationSpeedMps] = useState(null);

  const initialLocationRequested = useRef(false);
  const searchRequestId = useRef(0);
  const routeAbortController = useRef(null);
  const navigationWatchId = useRef(null);
  const navigationOffRouteSamples = useRef(0);
  const navigationLastRerouteAt = useRef(0);
  const transitLastAutoRerouteAt = useRef(0);
  const transitLiveRequestId = useRef(0);
  const selectedRouteRef = useRef(null);
  const searchRoutesRef = useRef(null);

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
  const displayedMode = data?.mode || mode;
  const selectedTransitSignature = useMemo(
    () =>
      (selectedRoute?.steps || [])
        .filter(step => step?.type === "transit")
        .map(step => transitStepKey(step))
        .join("|"),
    [selectedRoute]
  );
  const navigationInfo = useMemo(
    () =>
      navigationActive && currentLocation && selectedRoute
        ? buildNavigationSnapshot(currentLocation, selectedRoute)
        : null,
    [navigationActive, currentLocation, selectedRoute]
  );

  useEffect(() => {
    selectedRouteRef.current = selectedRoute;
  }, [selectedRoute]);

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
    requestedStartCoordinate = startMapCoordinate,
    requestedDestinationCoordinate = destinationMapCoordinate,
  } = {}) {
    const effectiveCurrentLocation =
      requestedUseCurrentLocation && Array.isArray(requestedStartCoordinate)
        ? requestedStartCoordinate
        : currentLocation;
    const cleanStart =
      requestedUseCurrentLocation && effectiveCurrentLocation
        ? coordinateString(effectiveCurrentLocation)
        : requestedStart.trim();
    const cleanDestination = requestedDestination.trim();

    if (requestedUseCurrentLocation && !effectiveCurrentLocation) {
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
    routeAbortController.current?.abort();
    const controller = new AbortController();
    routeAbortController.current = controller;
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
        signal: controller.signal,
        body: JSON.stringify({
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode,
          route_type: requestedCyclingType,
          departure_datetime: departureDatetime,
          transit_preference: requestedTransitPreference,
          start_coordinates: requestedUseCurrentLocation
            ? effectiveCurrentLocation
            : requestedStartCoordinate,
          destination_coordinates: requestedDestinationCoordinate,
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
        const count = result.routes?.length || 1;
        const prefix = `${count} transit route${count === 1 ? "" : "s"} found`;

        if (effectiveTimingMode === "scheduled") {
          setStatus(`${prefix} • scheduled`);
        } else if (realtime?.available && realtime?.used_live_updates) {
          setStatus(`${prefix} • live predictions used`);
        } else if (realtime?.available) {
          setStatus(`${prefix} • live feed connected`);
        } else {
          setStatus(`${prefix} • scheduled data`);
        }
      } else {
        setStatus(`Route found${scheduledSuffix}`);
      }
    } catch (routeError) {
      if (routeError?.name === "AbortError") {
        return;
      }
      if (requestId !== searchRequestId.current) {
        return;
      }

      console.error("Route search failed:", routeError);
      setError(true);
      setStatus(routeError.message || "Something went wrong.");
    } finally {
      if (requestId === searchRequestId.current) {
        if (routeAbortController.current === controller) {
          routeAbortController.current = null;
        }
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    searchRoutesRef.current = searchRoutes;
  });

  useEffect(() => {
    if (
      displayedMode !== "transit" ||
      timingMode !== "now" ||
      !selectedTransitSignature ||
      !selectedRouteRef.current
    ) {
      return undefined;
    }

    let stopped = false;
    let intervalId = null;
    const routeSnapshot = selectedRouteRef.current;
    const routeNumber = routeSnapshot.route_number;
    const baseTransitSteps = (routeSnapshot.steps || []).filter(
      step => step?.type === "transit"
    );

    const getFreshLocation = () =>
      new Promise(resolve => {
        if (!navigator.geolocation) {
          resolve(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          position => {
            const location = [position.coords.latitude, position.coords.longitude];
            setCurrentLocation(location);
            setNavigationAccuracy(
              Number.isFinite(position.coords.accuracy)
                ? position.coords.accuracy
                : null
            );
            setNavigationSpeedMps(
              Number.isFinite(position.coords.speed) ? position.coords.speed : null
            );
            resolve({
              location,
              accuracy: Number.isFinite(position.coords.accuracy)
                ? position.coords.accuracy
                : null,
              speed: Number.isFinite(position.coords.speed)
                ? position.coords.speed
                : null,
            });
          },
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 6000, maximumAge: 8000 }
        );
      });

    async function refreshTransitLive() {
      const requestId = ++transitLiveRequestId.current;
      try {
        const response = await fetch("/api/transit/live-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ steps: baseTransitSteps }),
        });
        const live = await response.json();
        if (stopped || requestId !== transitLiveRequestId.current || !response.ok || !live.success) {
          return;
        }

        const stateByTrip = new Map(
          (live.trip_states || []).map(item => [
            `${item.agency || ""}:${item.trip_id || ""}`,
            item,
          ])
        );

        const updateStep = step => {
          if (step?.type !== "transit") {
            return step;
          }
          const state = stateByTrip.get(transitStepKey(step));
          if (!state) {
            return step;
          }
          const delayMin = Number(state.delay_seconds || 0) / 60;
          const hasRealtime = Boolean(state.realtime);
          const scheduledDeparture =
            step.scheduled_departure_time || step.departure_time;
          const scheduledArrival = step.scheduled_arrival_time || step.arrival_time;
          return {
            ...step,
            realtime: hasRealtime,
            delay_min: hasRealtime ? delayMin : 0,
            cancelled: hasRealtime ? Boolean(state.cancelled) : false,
            live_status: hasRealtime
              ? state.cancelled
                ? "Cancelled"
                : delayMin >= 1
                  ? "Delayed"
                  : delayMin <= -1
                    ? "Early"
                    : "On time"
              : null,
            departure_time: hasRealtime
              ? shiftClockTime(scheduledDeparture, delayMin)
              : scheduledDeparture,
            arrival_time: hasRealtime
              ? shiftClockTime(scheduledArrival, delayMin)
              : scheduledArrival,
          };
        };

        const liveSources = [];
        if (live.sources?.grt?.trip_updates || live.sources?.grt?.vehicles) {
          liveSources.push("GRT");
        }
        if (live.sources?.go?.trip_updates || live.sources?.go?.vehicles) {
          liveSources.push("GO Transit");
        }

        setData(previous => {
          if (!previous || previous.mode !== "transit") {
            return previous;
          }
          return {
            ...previous,
            alerts: live.alerts || [],
            routes: (previous.routes || []).map(routeItem => {
              if (routeItem.route_number !== routeNumber) {
                return routeItem;
              }
              const updatedSteps = (routeItem.steps || []).map(updateStep);
              return {
                ...routeItem,
                steps: updatedSteps,
                stops: updatedSteps,
                live_vehicles: live.live_vehicles || [],
                realtime: {
                  ...(routeItem.realtime || {}),
                  available: liveSources.length > 0,
                  feed_connected: liveSources.length > 0,
                  used_live_updates: (live.trip_states || []).some(
                    state => Boolean(state.realtime)
                  ),
                  scheduled_vehicle_fallback: Boolean(
                    live.scheduled_vehicle_fallback
                  ),
                  live_sources: liveSources,
                  grt_connected: Boolean(
                    live.sources?.grt?.trip_updates ||
                      live.sources?.grt?.vehicles ||
                      live.sources?.grt?.alerts
                  ),
                  go_connected: Boolean(
                    live.sources?.go?.trip_updates ||
                      live.sources?.go?.vehicles ||
                      live.sources?.go?.alerts
                  ),
                  go_configured: live.sources?.go?.configured !== false,
                },
              };
            }),
          };
        });

        const updatedRouteSteps = (routeSnapshot.steps || []).map(updateStep);
        const updatedTransitSteps = updatedRouteSteps.filter(
          step => step?.type === "transit"
        );
        const nowMs = Date.now();
        const firstRelevantStep = updatedTransitSteps.find(step => {
          const departureMs = nearbyClockTimestamp(step.departure_time, nowMs);
          return departureMs == null || departureMs >= nowMs - 4 * 60 * 1000;
        });
        if (!firstRelevantStep) {
          return;
        }

        const cancelledStep = updatedTransitSteps.find(step => {
          if (!step.cancelled) {
            return false;
          }
          const departure = nearbyClockTimestamp(step.departure_time, nowMs);
          return departure == null || departure >= nowMs - 4 * 60 * 1000;
        });
        const connectionFailure = impossibleTransitConnection(updatedRouteSteps);
        const departureMs = nearbyClockTimestamp(firstRelevantStep.departure_time, nowMs);
        const departurePassed =
          departureMs != null && nowMs > departureMs + 45 * 1000;

        if (!cancelledStep && !connectionFailure && !departurePassed) {
          return;
        }

        const cooldownPassed =
          nowMs - transitLastAutoRerouteAt.current > 30000;
        if (!cooldownPassed || !searchRoutesRef.current) {
          return;
        }

        const gps = await getFreshLocation();
        if (stopped || !gps?.location) {
          return;
        }

        const boardingStop = (routeSnapshot.transit_stops || []).find(
          stop =>
            String(stop.raw_id || stop.id) ===
              String(firstRelevantStep.from_stop_id || "") &&
            String(stop.agency || "") === String(firstRelevantStep.agency || "")
        );
        const distanceToBoarding = boardingStop?.coordinates
          ? haversineMeters(gps.location, boardingStop.coordinates)
          : Infinity;
        const nearBoarding =
          distanceToBoarding <= Math.max(120, Number(gps.accuracy || 0) * 1.75);
        const probablyNotOnVehicle =
          gps.speed == null || Number(gps.speed) < 2.5;

        if (
          cancelledStep ||
          connectionFailure ||
          (departurePassed && nearBoarding && probablyNotOnVehicle)
        ) {
          transitLastAutoRerouteAt.current = nowMs;
          setStatus(
            cancelledStep
              ? "Transit trip cancelled • finding the next best route..."
              : connectionFailure
                ? "A live delay breaks your connection • rerouting..."
                : "Looks like you missed that departure • rerouting..."
          );
          searchRoutesRef.current({
            requestedMode: "transit",
            requestedTimingMode: "now",
            requestedTransitPreference: transitPreference,
            requestedUseCurrentLocation: true,
            requestedStartCoordinate: gps.location,
          });
        }
      } catch (liveError) {
        if (!stopped) {
          console.warn("Transit live refresh failed:", liveError);
        }
      }
    }

    refreshTransitLive();
    intervalId = window.setInterval(refreshTransitLive, 15000);
    return () => {
      stopped = true;
      if (intervalId != null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    displayedMode,
    timingMode,
    selectedRouteNumber,
    selectedTransitSignature,
    transitPreference,
  ]);

  useEffect(() => {
    if (!navigationActive || !navigationInfo || displayedMode === "transit") {
      navigationOffRouteSamples.current = 0;
      return undefined;
    }

    const offRouteThreshold = Math.max(70, Number(navigationAccuracy || 0) * 2);
    if (navigationInfo.off_route_m > offRouteThreshold) {
      navigationOffRouteSamples.current += 1;
    } else {
      navigationOffRouteSamples.current = 0;
    }

    const enoughSamples = navigationOffRouteSamples.current >= 3;
    const rerouteCooldownPassed = Date.now() - navigationLastRerouteAt.current > 15000;

    if (
      !enoughSamples ||
      !rerouteCooldownPassed ||
      !destination.trim() ||
      !searchRoutesRef.current
    ) {
      return undefined;
    }

    navigationLastRerouteAt.current = Date.now();
    navigationOffRouteSamples.current = 0;

    const timer = window.setTimeout(() => {
      setStatus("Off route • rerouting from your current location...");
      searchRoutesRef.current?.({
        requestedMode: displayedMode,
        requestedCyclingType: cyclingType,
        requestedUseCurrentLocation: true,
        requestedTimingMode: "now",
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    navigationActive,
    navigationInfo,
    displayedMode,
    navigationAccuracy,
    destination,
    cyclingType,
  ]);

  function handleStartChange(nextStart) {
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }
    setStart(nextStart);
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(null);
  }

  function handleDestinationChange(nextDestination) {
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }
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
        requestedStartCoordinate: coordinate,
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
        requestedDestinationCoordinate: coordinate,
      });
    }
  }

  function changeMode(nextMode) {
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }
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
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }

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

  function stopNavigation({ quiet = false } = {}) {
    if (navigationWatchId.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(navigationWatchId.current);
      navigationWatchId.current = null;
    }

    setNavigationActive(false);
    setNavigationAccuracy(null);
    setNavigationHeading(null);
    setNavigationSpeedMps(null);
    navigationOffRouteSamples.current = 0;

    if (!quiet) {
      setError(false);
      setStatus("Navigation stopped.");
    }
  }

  function startNavigation() {
    if (!selectedRoute?.route_coordinates?.length) {
      setError(true);
      setStatus("Find a route before starting navigation.");
      return;
    }

    if (displayedMode === "transit") {
      setError(true);
      setStatus("Turn-by-turn navigation currently supports driving, walking, and cycling routes.");
      return;
    }

    if (!navigator.geolocation) {
      setError(true);
      setStatus("Live navigation is not supported by this browser.");
      return;
    }

    if (navigationWatchId.current != null) {
      navigator.geolocation.clearWatch(navigationWatchId.current);
    }

    setNavigationActive(true);
    setStart("Current location");
    setStartUsesCurrentLocation(true);
    setError(false);
    setStatus("Navigation started • waiting for a high-accuracy GPS fix...");

    navigationWatchId.current = navigator.geolocation.watchPosition(
      position => {
        const location = [position.coords.latitude, position.coords.longitude];
        setCurrentLocation(location);
        setStartMapCoordinate(location);
        setNavigationAccuracy(
          Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : null
        );
        setNavigationHeading(
          Number.isFinite(position.coords.heading)
            ? position.coords.heading
            : null
        );
        setNavigationSpeedMps(
          Number.isFinite(position.coords.speed) ? position.coords.speed : null
        );
        setStatus("Navigation active");
      },
      locationError => {
        console.error("Navigation GPS error:", locationError);
        setError(true);
        setStatus("Navigation lost access to your location.");
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 1000,
      }
    );
  }

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

  useEffect(() => {
    return () => {
      if (navigationWatchId.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(navigationWatchId.current);
      }
    };
  }, []);

  const controlSurface = darkMode
    ? "border-button bg-charcoal/95 text-darkmode-gray"
    : "border-white/80 bg-white/95 text-charcoal";

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden ${
        darkMode ? mapStyle == "hybrid" ? "bg-hybrid-charcoal" : "bg-charcoal" : "bg-white"
      }`}
    >
      <aside
        className={`z-[1000] flex h-screen w-[360px] flex-shrink-0 flex-col border-r shadow-xl ${
          darkMode
            ? mapStyle == "hybrid" 
              ? "border-button/50 bg-hybrid-charcoal"
              : "border-button/50 bg-charcoal"
            : "border-button-light/70 bg-white"
        } ${sidePanel ? "hidden" : ""} max-[760px]:absolute max-[760px]:bottom-3 max-[760px]:left-3 max-[760px]:right-3 max-[760px]:h-[60vh] max-[760px]:w-auto max-[760px]:overflow-hidden max-[760px]:rounded-2xl max-[760px]:border`}
      >
        <header className="px-5 pb-4 pt-4">
          <div className="flex items-center justify-between">
            <a
              href="https://github.com/kus001/map"
              target="_blank"
              rel="noreferrer"
              className={`inline-block text-2xl font-bold tracking-tight transition-all duration-200 active:scale-95 hover:tracking-wider ${
                darkMode 
                  ? mapStyle === "hybrid"
                    ? "text-hybrid-purple-light hover:text-hybrid-purple-dark" 
                    : "text-blue-light hover:text-blue" 
                  : "text-green hover:text-green-dark"
              }`}
            >
              Map Router
            </a>

            <div className="flex items-center gap-1">
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
          </div>

          <div
            className={`mt-1 text-[11px] whitespace-pre-line ${
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
          mapStyle={mapStyle}
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
          onStartCoordinate={coordinate => {
            setStartMapCoordinate(coordinate);
            setStartUsesCurrentLocation(false);
          }}
          onDestinationCoordinate={coordinate =>
            setDestinationMapCoordinate(coordinate)
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
          navigationActive={navigationActive}
          navigationInfo={navigationInfo}
          navigationAccuracy={navigationAccuracy}
          navigationSpeedMps={navigationSpeedMps}
          onStartNavigation={startNavigation}
          onStopNavigation={() => stopNavigation()}
          status={status}
          error={error}
          darkMode={darkMode}
        />

        <footer
          className={`flex items-center justify-center gap-2 border-t py-3 text-[11px] ${
            darkMode
              ? "border-button/40 text-darkmode-gray"
              : "border-button-light/50 text-button"
          } ${sidePanel ? "hidden" : ""}`}
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
        <button
          type="button"
          onClick={() => setIsSidePanel(value => !value)}
          title="Open/close menu"
          className={`rounded-lg absolute top-4 left-4 z-[500] border p-2 transition hover:-translate-y-px active:scale-90 ${
            darkMode
              ? "border-button bg-charcoal-light text-blue-light"
              : "border-button-light bg-white text-green-dark"
          }`}
        >
          {sidePanel ? <MdOpenInNew /> : <IoClose />}
        </button>
        <MapView
          data={data}
          selectedRoute={selectedRoute}
          selectedRouteNumber={selectedRouteNumber}
          hoveredRouteNumber={hoveredRouteNumber}
          displayedMode={displayedMode}
          onSelectRoute={selectRoute}
          onHoverRoute={setHoveredRouteNumber}
          currentLocation={currentLocation}
          navigationActive={navigationActive}
          navigationAccuracy={navigationAccuracy}
          navigationHeading={navigationHeading}
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

            <button
              type="button"
              onClick={() => setMapStyle("hybrid")}
              title="Hybrid map"
              className={`flex h-11 items-center gap-1.5 border-l px-3 text-sm font-semibold transition ${
                darkMode ? "border-button" : "border-button-light"
              } ${
                mapStyle === "hybrid"
                  ? darkMode
                    ? "bg-blue text-white"
                    : "bg-green text-white"
                  : darkMode
                    ? "text-darkmode-gray hover:bg-blue/10"
                    : "text-charcoal hover:bg-green/10"
              }`}
            >
              <IoLayers className="text-lg" />
              <span className="max-[900px]:hidden">Hybrid</span>
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
