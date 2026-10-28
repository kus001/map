import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MdCenterFocusStrong, MdMap, MdMyLocation, MdSatelliteAlt } from "react-icons/md";
import { IoLayers, IoClose } from "react-icons/io5";
import { PiSunFill } from "react-icons/pi";
import { TbMoonStars } from "react-icons/tb";
import { MdOpenInNew } from "react-icons/md";
import { IoIosArrowUp } from "react-icons/io";

import MapView from "./components/MapView.jsx";
import Scene3D from "./components/Scene3D.jsx";
import LayersPanel from "./components/LayersPanel.jsx";
import RoutePanel from "./components/RoutePanel.jsx";
import SearchPanel from "./components/SearchPanel.jsx";
import { haversineMeters, navigationSnapshot as buildNavigationSnapshot } from "./utils/navigation.js";
import { liveDelayInfo } from "./utils/format.js";
import {
  fetchApproxLocation,
  loadCachedApproxLocation,
  saveApproxLocation,
} from "./utils/approxLocation.js";

                                                                
// same walk might show up twice when transit options get rebuilt
function walkId(start, end) {
  return [...start, ...end].map(value => Number(value).toFixed(6)).join(",");
}

function transferCheck(steps) {
  let lastRide = null;
  let walking = 0;
  const transfers = [];
  for (const step of steps) {
    if (step.type === "transit") {
      if (lastRide) {
        const arrive = clockMinutes(lastRide.arrival_time);
        let depart = clockMinutes(step.departure_time);
        if (arrive != null && depart != null) {
          if (arrive >= 18 * 60 && depart <= 6 * 60) depart += 1440;
          const minutes = Math.floor((depart - arrive - walking) * 2) / 2;
          const status = minutes < 5 ? "critical" : minutes < 7 ? "tight"
            : minutes < 11 ? "moderate" : "comfortable";
          const label = {
            critical: "Connection at risk", tight: "Tight transfer",
            moderate: "Limited buffer", comfortable: "Comfortable transfer"}[status];

          transfers.push({ from_route: lastRide.route, to_route: step.route,
            stop: step.from, margin_min: minutes, status, label,
            live_adjusted: Boolean(lastRide.realtime || step.realtime) });
        }
      }
      lastRide = step;
      walking = 0;
    } else if (lastRide && (step.type === "walk" || step.type === "transfer")) {
      walking += Number(step.duration_min || 0);
    }
  }
  if (!transfers.length) return { status: "direct", label: "No connections", transfers: [] };
  const ranks = { critical: 0, tight: 1, moderate: 2, comfortable: 3 };
  const worst = transfers.reduce((a, b) => ranks[a.status] <= ranks[b.status] ? a : b);
  return { status: worst.status, label: worst.label, transfers };
}

// redo arrival times when the departure clock changes
function replayArrival(steps, departureISO) {
  let t = Date.parse(departureISO);
  if (!Number.isFinite(t)) return null;
  let missedMin = 0;
  for (const step of steps || []) {
    if (step.type === "transit") {
      const dep = Date.parse(step.departure_datetime);
      const arr = Date.parse(step.arrival_datetime);
      if (!Number.isFinite(dep) || !Number.isFinite(arr)) return null;
      if (t - dep > 30000) missedMin = Math.max(missedMin, (t - dep) / 60000);
      t = arr;
    } else {
      t += Number(step.duration_min || 0) * 60000;
    }
  }
  return { arrival: new Date(t), missedMin };
}

function applyWalkShapes(route, shapes) {
  if (!route?.pending_walks?.length) return route;
  const available = Object.keys(shapes);
  if (!available.length) return route;

  const segments = (route.segments || []).map(segment => {
    const shape = shapes[segment.walk_id];
    return shape?.coordinates?.length
      ? { ...segment, coordinates: shape.coordinates }
      : segment;
  });
  let timeChange = 0;
  let distanceChange = 0;
  const steps = (route.steps || []).map(step => {
    const shape = shapes[step.walk_id];
    if (!shape?.coordinates?.length) return step;
    timeChange += Number(shape.duration_min || 0) - Number(step.duration_min || 0);
    distanceChange += Number(shape.distance_m || 0) - Number(step.distance_m || 0);
    return { ...step, duration_min: shape.duration_min,
      distance_m: shape.distance_m, directions: shape.steps || [],
      coordinates: shape.coordinates[0] || step.coordinates };
  });
  const stillWaiting = route.pending_walks.filter(
    item => !shapes[walkId(item.start, item.end)]
  );
  const replay = replayArrival(steps, route.departure_datetime);
  let duration = Math.max(0, Number(route.duration_min || 0) + timeChange);
  let arrival = route.arrival_estimate_datetime;
  if (replay) {
    arrival = replay.arrival.toISOString();
    duration = Math.max(0, (replay.arrival.getTime() - new Date(route.departure_datetime).getTime()) / 60000);
  } else if (route.departure_datetime && timeChange) {
    const t = new Date(route.departure_datetime).getTime();
    if (Number.isFinite(t)) arrival = new Date(t + duration * 60000).toISOString();
  }
  return { ...route, segments, steps, stops: steps,
    missed_connection: replay ? replay.missedMin > 0 : route.missed_connection,
    pending_walks: stillWaiting,
    route_coordinates: segments.flatMap(segment => segment.coordinates || []),
    duration_min: duration,
    distance_km: Math.max(0, Number(route.distance_km || 0) + distanceChange / 1000),
    arrival_estimate_datetime: arrival,
    transfer_reliability: transferCheck(steps) };
}

const PREFERENCES_KEY = "map-router-preferences-v1";
const RECENT_SEARCH_KEY = "kmaps-recent-searches";
const VALID_MODES = new Set(["driving", "walking", "cycling", "transit"]);
const VALID_CYCLING_TYPES = new Set(["regular", "road", "mountain", "electric"]);
const VALID_MAP_STYLES = new Set(["street", "satellite", "hybrid"]);
const VALID_TIMING_MODES = new Set(["now", "scheduled", "arrive_by"]);
const VALID_TRANSIT_PREFERENCES = new Set(["balanced", "less_walking", "fastest"]);

                                                                               
                                                                            
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
    if (!raw) { // empty list return if nothing is saved
      return {};
    }

    const saved = JSON.parse(raw);
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    console.warn("Could not load saved map preferences:", error);
    return {};
  }
}

function recentSearch() {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCH_KEY);
    if (!raw) { // empty list return if nothing is saved
      return [];
    }
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved : [];
  } 
  catch (error) {
    console.warn("Could not load recent searches", error);
    return [];
  }
}
// console.log("Recent searches: ", recentSearch);

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

// dont show a transfer if the timings physically wont work
function impossibleTransitConnection(steps) {
  let previousTransit = null;
  let transferMinutes = 0;

  for (const step of steps || []) {
    if (step?.type === "transit") {
      if (previousTransit) {
        const arrival = clockMinutes(previousTransit.arrival_time);
        let departure = clockMinutes(step.departure_time);
        if (arrival != null && departure != null) {
                                                                            
                                                                           
                                                                         
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

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

export default function App() {
  const [recentSearches, setRecentSearches] = useState(recentSearch);
  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recentSearches));
    } catch (error) {
      console.warn("Could not save recent searches", error);
    }
  }, [recentSearches]);
  
  function removeLocation(location) { // remove location from saved recent
    setRecentSearches(current => current.filter(search => search.start !== location && search.destination !== location));
  }

  const [sidePanel, setIsSidePanel] = useState(false);
  const [mobileMin, setMobileMin] = useState(false)
  const overlayRef = useRef(null);
  const [measuredInsets, setMeasuredInsets] = useState(ZERO_INSETS);
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
  const [evEnabled, setEvEnabled] = useState(() => savedPreferences.evEnabled === true);
  const [evProfile, setEvProfile] = useState(() => ({
    battery_kwh: 60, charge_percent: 80, reserve_percent: 10,
    consumption_kwh_100km: 18, max_charge_kw: 120, plug: "ccs1",
    ...(savedPreferences.evProfile || {}),
  }));
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
  // city-level guess, no permission needed; never shown as "you are here"
  const [approxLocation, setApproxLocation] = useState(loadCachedApproxLocation);
  const [locationFocusKey, setLocationFocusKey] = useState(0);
  const [routeFocusKey, setRouteFocusKey] = useState(0);
  const [stepFocusKey, setStepFocusKey] = useState(0);
  const [stepFocusCoordinate, setStepFocusCoordinate] = useState(null);
  const [startMapCoordinate, setStartMapCoordinate] = useState(null);
  const [destinationMapCoordinate, setDestinationMapCoordinate] = useState(null);
                                                                               
  const [addressIssue, setAddressIssue] = useState(null);
  const [data, setData] = useState(null);
  const [darkMode, setDarkMode] = useState(
    () => savedPreferences.darkMode === true
  );
  const [mapStyle, setMapStyle] = useState("satellite");
  const [threeD, setThreeD] = useState(false);
  const mapCamera = useRef(null);
  const twoDCameraGetter = useRef(null);
  const threeDCamera = useRef(null);
  const threeDCameraGetter = useRef(null);
  const [return2DCamera, setReturn2DCamera] = useState(null);
  const leave3D = () => {
    // Read Cesium *before* it unmounts; moveEnd may not have fired yet if the
    // user changes modes while pinching or panning.
    let camera = null;
    try { camera = threeDCameraGetter.current?.() || threeDCamera.current; }
    catch (error) { console.warn("Unable to read 3D camera", error); camera = threeDCamera.current; }
    if (camera && Array.isArray(camera.center) && camera.center.length === 2 &&
        camera.center.every(Number.isFinite) && Number.isFinite(camera.zoom)) {
      mapCamera.current = camera;
      setReturn2DCamera({ ...camera });
    }
    setThreeD(false);
  };
  const [layersOpen, setLayersOpen] = useState(false);
  const [enabledLayers, setEnabledLayers] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("map-511-layers") || "[]");
      return Array.isArray(saved) ? saved.filter(id => ["traffic", "incidents", "construction", "cameras", "winter"].includes(id)) : [];
    } catch { return []; }
  });
  const [layerStatus, setLayerStatus] = useState({});
  const layerStatusChanged = useCallback((kind, message) => {
    setLayerStatus(current => current[kind] === message ? current : { ...current, [kind]: message });
  }, []);
  useEffect(() => {
    try { localStorage.setItem("map-511-layers", JSON.stringify(enabledLayers)); }
    catch { return; }
  }, [enabledLayers]);

  const mapStyles = () => {
    if (mapStyle === "street") {
      setMapStyle("satellite");
    } else if (mapStyle === "satellite") {
      setMapStyle("hybrid");
    } else {
      setMapStyle("street");
    }
  }
  const [timingMode, setTimingMode] = useState(() =>
    sharedRoute.timingMode ||
    validSavedValue(savedPreferences.timingMode, VALID_TIMING_MODES, "now")
  );
  const transitPreference = "balanced";
  const [departureDate, setDepartureDate] = useState(initialSchedule.date);
  const [departureTime, setDepartureTime] = useState(initialSchedule.time);
  const [navigationActive, setNavigationActive] = useState(false);
  const [navigationAccuracy, setNavigationAccuracy] = useState(null);
  const [navigationHeading, setNavigationHeading] = useState(null);
  const [navigationSpeedMps, setNavigationSpeedMps] = useState(null);
  const [navigationClockMs, setNavigationClockMs] = useState(PAGE_LOAD_TIME);

  const initialLocationRequested = useRef(false);
  const searchRequestId = useRef(0);
  const routeAbortController = useRef(null);
  const alternativesAbortController = useRef(null);
  const navigationWatchId = useRef(null);
  const navigationOffRouteSamples = useRef(0);
  const navigationLastRerouteAt = useRef(0);
  const transitLastAutoRerouteAt = useRef(0);
  const transitLiveRequestId = useRef(0);
  const selectedRouteRef = useRef(null);
  const searchRoutesRef = useRef(null);
  // the live-transit effect below doesn't re-run when these change, so it reads them through refs
  const startUsesCurrentLocationRef = useRef(startUsesCurrentLocation);
  const autoRerouteSignatureRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({
          mode,
          cyclingType,
          evEnabled,
          evProfile,
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
    evEnabled,
    evProfile,
    startUsesCurrentLocation,
    darkMode,
    mapStyle,
    timingMode,
    transitPreference,
    departureDate,
    departureTime,
  ]);

  const walkRequests = useMemo(() => {
    if (data?.mode !== "transit") return "";
    const legs = new Map();
    for (const route of data.routes || []) {
      for (const leg of route.pending_walks || []) {
        legs.set(walkId(leg.start, leg.end), leg);
      }
    }
    return JSON.stringify([...legs.values()]);
  }, [data]);

  useEffect(() => {
    if (!walkRequests || walkRequests === "[]") return undefined;
    const pairs = JSON.parse(walkRequests);
    const searchId = searchRequestId.current;
    let cancelled = false;
    const controllers = [];
    const timers = [1450, 3000, 5400].map(delay => window.setTimeout(async () => {
      if (cancelled || searchId !== searchRequestId.current) return;
      const controller = new AbortController();
      controllers.push(controller);
      try {
        const response = await fetch("/api/transit/walk-shapes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          signal: controller.signal, body: JSON.stringify({ pairs }),
        });
        if (!response.ok) return;
        const found = await response.json();
        if (cancelled || searchId !== searchRequestId.current || !found.success) return;
        const shapes = found.shapes || {};
        if (Object.keys(shapes).length) {
          setData(previous => previous?.mode === "transit"
            ? { ...previous, routes: (previous.routes || []).map(route => applyWalkShapes(route, shapes)) }
            : previous);
        }
      } catch (error) {
        if (error?.name !== "AbortError") console.warn("Walking map details unavailable", error);
      }
    }, delay));
    return () => {
      cancelled = true;
      timers.forEach(window.clearTimeout);
      controllers.forEach(controller => controller.abort());
    };
  }, [walkRequests, routeFocusKey]);

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
        ? buildNavigationSnapshot(currentLocation, selectedRoute, navigationClockMs)
        : null,
    [navigationActive, currentLocation, selectedRoute, navigationClockMs]
  );

                                                                                 
  useEffect(() => {
    if (!navigationActive || displayedMode !== "transit") {
      return undefined;
    }
    const tick = () => setNavigationClockMs(Date.now());
    const first = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 10000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [navigationActive, displayedMode]);

  useEffect(() => {
    selectedRouteRef.current = selectedRoute;
  }, [selectedRoute]);

  function getDepartureDateTime(requestedTimingMode = timingMode) {
    if (!["scheduled", "arrive_by"].includes(requestedTimingMode)) {
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
      throw new Error("Choose a future departure or arrival time.");
    }

    return value;
  }

  async function searchRoutes({
    requestedMode = mode,
    requestedCyclingType = cyclingType,
    requestedTransitPreference = transitPreference,
    requestedStart = start,
    requestedDestination = destination,
    requestedTimingMode = timingMode,
    requestedUseCurrentLocation = startUsesCurrentLocation,
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
    alternativesAbortController.current?.abort();
    const controller = new AbortController();
    routeAbortController.current = controller;
    setLoading(true);
    setError(false);
    setAddressIssue(null);
    setStatus(
      effectiveTimingMode === "arrive_by"
        ? "Finding a journey that arrives before your deadline..."
        : effectiveTimingMode === "scheduled"
          ? "Finding your scheduled route..."
          : "Finding route..."
    );

    const routeStartedMs = performance.now();
    try {
      const routeRequest = {
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode,
          ev_enabled: requestedMode === "driving" && evEnabled,
          ev_profile: requestedMode === "driving" && evEnabled ? evProfile : undefined,
          route_type: requestedMode === "walking"
            ? "regular"
            : requestedCyclingType,
          departure_datetime: departureDatetime,
          timing_mode: effectiveTimingMode,
          transit_preference: requestedTransitPreference,
          start_coordinates: requestedUseCurrentLocation
            ? effectiveCurrentLocation
            : requestedStartCoordinate,
          destination_coordinates: requestedDestinationCoordinate,
          // typed places resolve to the closest match to this
          bias: currentLocation || approxLocation || undefined,
      };
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(routeRequest),
      });

                                                                                  
                                                                   
      const rawResponse = await response.text();
      let result;
      try {
        result = JSON.parse(rawResponse);
      } catch {
        throw new Error(
          response.ok
            ? "The routing service returned an invalid response. Please try again."
            : `Routing service unavailable (HTTP ${response.status}). Please try again.`
        );
      }
      const elapsedMs = Math.round(performance.now() - routeStartedMs);
      console.info(`[MAP] ${requestedMode}: ${elapsedMs} ms end-to-end; ` +
        `${result.server_time_ms ?? "?"} ms server; stages:`, result.server_timing_ms || {});

      if (requestId !== searchRequestId.current) {
        return;
      }

      if (!response.ok || !result.success) {
        const issue = result?.address_issue;
        if (issue?.options?.length) {
          const place = issue.field === "start" ? "starting point" : "destination";
          setAddressIssue(issue);
          throw new Error(
            issue.kind === "mismatch"
              ? `Check the street type for your ${place}.`
              : `Choose which ${place} you meant.`
          );
        }
        throw new Error(result?.error || `Route could not be found (HTTP ${response.status}).`);
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

      setData(requestedMode === "transit"
        ? { ...displayedResult, alternatives_loading: true }
        : displayedResult);

      const newSearch = {
        start: requestedUseCurrentLocation ? "Current location" : requestedStart.trim(),
        destination: requestedDestination.trim(),
        mode: requestedMode
      }

      setRecentSearches(current => {
        const filtered = current.filter(search => search.start !== newSearch.start || 
         search.destination !== newSearch.destination ||
         search.mode !== newSearch.mode
        );
        return [newSearch, ...filtered].slice(0,3);
      });

      if (requestedMode === "transit") {
        const altController = new AbortController();
        alternativesAbortController.current = altController;
                                                                          
        window.setTimeout(async () => {
          if (requestId !== searchRequestId.current || altController.signal.aborted) return;
          // The primary transit route renders immediately. Prefer its detailed
          // sidewalk shapes before issuing the more expensive alternatives search.
          // The API only reads completed geometry; it never blocks on a new walk request.
          const primary = result.routes?.[0];
          if (primary?.pending_walks?.length) {
            let pending = primary.pending_walks.slice();
            const deadline = performance.now() + 1150;
            while (pending.length && performance.now() < deadline &&
                   requestId === searchRequestId.current && !altController.signal.aborted) {
              try {
                const walkResponse = await fetch("/api/transit/walk-shapes", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  signal: altController.signal, body: JSON.stringify({ pairs: pending }),
                });
                if (walkResponse.ok) {
                  const body = await walkResponse.json();
                  if (body.success && Object.keys(body.shapes || {}).length) {
                    const completed = applyWalkShapes(primary, body.shapes);
                    pending = completed.pending_walks || [];
                    if (requestId !== searchRequestId.current || altController.signal.aborted) return;
                    setData(current => current?.mode === "transit"
                      ? { ...current, routes: current.routes.map((r, i) =>
                          i === 0 ? applyWalkShapes(r, body.shapes) : r) } : current);
                  }
                }
              } catch (error) {
                if (error.name === "AbortError") return;
                break;
              }
              if (pending.length && performance.now() < deadline) {
                await new Promise(resolve => window.setTimeout(resolve, 170));
              }
            }
          }
          if (requestId !== searchRequestId.current || altController.signal.aborted) return;
          const existing = [result.routes[0]];
          try {
                                                                           
            const response = await fetch("/api/transit/alternatives", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: altController.signal,
              body: JSON.stringify({
                ...routeRequest, priority: "all",
                transit_preference: routeRequest.transit_preference,
                departure_datetime: result.next_service ? result.departure_datetime : routeRequest.departure_datetime,
                timing_mode: result.next_service ? "scheduled" : effectiveTimingMode,
                existing_routes: existing.map(route => ({
                  steps: (route.steps || []).filter(step => step.type === "transit")
                    .map(step => ({ type: "transit", agency: step.agency,
                      trip_id: step.trip_id, route_id: step.route_id, route: step.route })),
                })),
                start_coordinates: result.start?.coordinates || routeRequest.start_coordinates,
                destination_coordinates: result.end?.coordinates || routeRequest.destination_coordinates,
              }),
            });
            if (response.ok) {
              const more = await response.json();
              if (more.success && requestId === searchRequestId.current) {
                const signature = route => (route?.steps || [])
                  .filter(step => step.type === "transit")
                  .map(step => `${step.agency}:${step.trip_id}`).join("|");
                const fresh = [];
                for (const candidate of more.routes || (more.route ? [more.route] : [])) {
                  if ([...existing, ...fresh].some(route => signature(route) === signature(candidate))) continue;
                  fresh.push(candidate);
                }
                if (fresh.length) {
                  existing.push(...fresh);
                  setData(current => {
                    if (!current || current.mode !== "transit") return current;
                    const routes = [...current.routes];
                    for (const candidate of fresh) routes.push({ ...candidate, route_number: routes.length + 1 });
                    const fastest = routes.reduce((best, route) => Number(route.duration_min) < Number(best.duration_min) ? route : best);
                    const shortest = routes.reduce((best, route) => Number(route.distance_km) < Number(best.distance_km) ? route : best);
                    return { ...current, routes, fastest_route_number: fastest.route_number,
                      shortest_route_number: shortest.route_number };
                  });
                }
              }
            }
          } catch (error) {
            if (error.name !== "AbortError") console.warn("Alternative routes unavailable", error);
          }
          if (requestId === searchRequestId.current) {
            setData(current => current?.mode === "transit" ? { ...current, alternatives_loading: false } : current);
          }
        }, 80);
      }
      // A search that started from GPS while the start box says somewhere else (navigation
      // reroutes) must not overwrite that start's coordinate, or later searches would silently
      // keep routing from the GPS point while the box still shows the old place.
      const startedFromGpsOverride = requestedUseCurrentLocation && !startUsesCurrentLocation;
      if (!startedFromGpsOverride) {
        setStartMapCoordinate(result.start?.coordinates || null);
      }
      setDestinationMapCoordinate(result.end?.coordinates || null);
                                                                                       
      setSelectedRouteNumber(requestedMode === "transit" ? 1 : (result.fastest_route_number || 1));
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
        const nextTripTime = result.next_service && result.departure_datetime
          ? new Date(result.departure_datetime).toLocaleString([], {
              weekday: "short", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit",
            })
          : null;
        setStatus(nextTripTime
          ? `No route at this time. Showing a scheduled route from ${nextTripTime}.`
          : "Route(s) found"                                                          
        );
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
    startUsesCurrentLocationRef.current = startUsesCurrentLocation;
  });

  useEffect(() => {
    if (
      displayedMode !== "transit" ||
      timingMode !== "now" ||
      selectedRouteRef.current?.next_service ||
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
          const liveStep = {
            ...step,
            realtime: hasRealtime,
            delay_min: hasRealtime ? delayMin : 0,
            cancelled: hasRealtime ? Boolean(state.cancelled) : false,
          };
          return {
            ...liveStep,
            live_status: liveDelayInfo(liveStep)?.label ?? null,
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
        for (const [key, source] of Object.entries(live.sources || {})) {
          if (key !== "grt" && key !== "go" && (source?.trip_updates || source?.vehicles)) {
            liveSources.push(source.label || key.toUpperCase());
          }
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

        if (!cancelledStep && !connectionFailure && !departurePassed && !navigationActive) {
          return;
        }

        const cooldownPassed =
          nowMs - transitLastAutoRerouteAt.current > 30000;
        if (!cooldownPassed || !searchRoutesRef.current) {
          return;
        }

        // Your GPS position only says anything about this trip if you are navigating it or you
        // chose "Current location" as the start. For a trip planned from somewhere else (say
        // Toronto Pearson) a cancelled bus or broken connection must re-plan from THAT start;
        // using GPS here used to silently restart the route from wherever you are (home), while
        // the start box still showed the old place. It also stops this background check from
        // asking for location permission on a plain planning screen.
        if (!navigationActive && !startUsesCurrentLocationRef.current) {
          if (!cancelledStep && !connectionFailure) {
            return;
          }
          // a clock-based connection warning can persist on the replacement route; try once per route
          if (autoRerouteSignatureRef.current === selectedTransitSignature) {
            return;
          }
          autoRerouteSignatureRef.current = selectedTransitSignature;
          transitLastAutoRerouteAt.current = nowMs;
          setStatus(
            cancelledStep
              ? "Transit trip cancelled • finding the next best route..."
              : "A live delay breaks your connection • rerouting..."
          );
          // no start overrides: searchRoutes uses the start currently shown in the search box
          searchRoutesRef.current({
            requestedMode: "transit",
            requestedTimingMode: "now",
            requestedTransitPreference: transitPreference,
          });
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
                                                                             
                                                                                 
        const boardingCoordinates =
          boardingStop?.coordinates || firstRelevantStep.coordinates;
        const distanceToBoarding = boardingCoordinates
          ? haversineMeters(gps.location, boardingCoordinates)
          : Infinity;
        const nearBoarding =
          distanceToBoarding <= Math.max(50, Number(gps.accuracy || 0) * 1.75);
        const probablyNotOnVehicle =
          gps.speed == null || Number(gps.speed) < 2.5 || !nearBoarding ;

                                                                             
                                                                             
                                                                          
                                                                           
                                              
        const secondsLeft = departureMs != null ? (departureMs - nowMs) / 1000 : null;
        const cannotMakeIt =
          navigationActive &&
          probablyNotOnVehicle &&
          Number.isFinite(distanceToBoarding) &&
          secondsLeft != null &&
          (departurePassed
            ? distanceToBoarding > 150
            : distanceToBoarding / 1.4 > secondsLeft + 60);

        if (
          cancelledStep ||
          connectionFailure ||
          (departurePassed && nearBoarding && probablyNotOnVehicle) ||
          cannotMakeIt
        ) {
          transitLastAutoRerouteAt.current = nowMs;
          setStatus(
            cancelledStep
              ? "Transit trip cancelled • finding the next best route..."
              : connectionFailure
                ? "A live delay breaks your connection • rerouting..."
                : "Looks like you'll miss that departure • rerouting..."
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
    navigationActive,
  ]);

  useEffect(() => {
    if (!navigationActive || !navigationInfo) {
      navigationOffRouteSamples.current = 0;
      return undefined;
    }

                                                                             
                                                                           
                                                                            
    if (
      displayedMode === "transit" &&
      (timingMode !== "now" || navigationInfo.current_step?.type === "transit")
    ) {
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
    timingMode,
  ]);

  function handleStartChange(nextStart) {
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }
    setStart(nextStart);
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(null);
    setAddressIssue(null);
  }

  function handleDestinationChange(nextDestination) {
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }
    setDestination(nextDestination);
    setDestinationMapCoordinate(null);
    setAddressIssue(null);
  }

                                                                                   
  function pickAddressOption(issue, option) {
    const coordinate = [Number(option.lat), Number(option.lon)];
    if (!coordinate.every(Number.isFinite)) {
      return;
    }

    setAddressIssue(null);

    if (issue.field === "start") {
      setStart(option.label);
      setStartUsesCurrentLocation(false);
      setStartMapCoordinate(coordinate);
      searchRoutes({
        requestedStart: option.label,
        requestedUseCurrentLocation: false,
        requestedStartCoordinate: coordinate,
      });
    } else {
      setDestination(option.label);
      setDestinationMapCoordinate(coordinate);
      searchRoutes({
        requestedDestination: option.label,
        requestedDestinationCoordinate: coordinate,
      });
    }
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

  function changeTimingMode(nextMode) {
    if (nextMode === "scheduled" || nextMode === "arrive_by") {
      const selected = new Date(`${departureDate}T${departureTime}:00`);

      if (Number.isNaN(selected.getTime()) || selected.getTime() < Date.now()) {
        const next = initialScheduledTime(Date.now());
        setDepartureDate(next.date);
        setDepartureTime(next.time);``
      }
    }

    setTimingMode(nextMode);
  }

  function swapLocations() {
    if (navigationActive) {
      stopNavigation({ quiet: true });
    }

    const nextStart = destination;
    const oldStartPoint = startUsesCurrentLocation ? currentLocation : startMapCoordinate;
    const nextDestination = startUsesCurrentLocation && currentLocation
      ? coordinateString(currentLocation)
      : start;
    const nextStartPoint = destinationMapCoordinate;
    const nextEndPoint = oldStartPoint;

    if (startUsesCurrentLocation && !currentLocation) {
      setStatus("Get your current location before swapping.");
      return;
    }

    routeAbortController.current?.abort();
    setStart(nextStart);
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(nextStartPoint || null);
    setDestination(nextDestination);
    setDestinationMapCoordinate(nextEndPoint || null);

    if (nextStart.trim() && nextDestination.trim()) {
      searchRoutes({
        requestedStart: nextStart,
        requestedDestination: nextDestination,
        requestedUseCurrentLocation: false,
        requestedStartCoordinate: nextStartPoint || null,
        requestedDestinationCoordinate: nextEndPoint || null,
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

  function clearRoute() {
                                                                      
    searchRequestId.current += 1;
    transitLiveRequestId.current += 1;
    routeAbortController.current?.abort();
    alternativesAbortController.current?.abort();
    routeAbortController.current = null;
    alternativesAbortController.current = null;
    if (navigationActive) stopNavigation({ quiet: true });
    setData(null);
    setStart("");
    setDestination("");
    setStartUsesCurrentLocation(false);
    setStartMapCoordinate(null);
    setDestinationMapCoordinate(null);
    setSelectedRouteNumber(1);
    setHoveredRouteNumber(null);
    setStepFocusCoordinate(null);
    setAddressIssue(null);
    setLoading(false);
    setError(false);
    setStatus("Enter a starting point and destination.");
    window.history.replaceState({}, "", window.location.pathname);
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
      params.set("transit", "balanced");
      params.set("timing", timingMode);

      if (timingMode === "scheduled" || timingMode === "arrive_by") {
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
    const controller = new AbortController();
    fetchApproxLocation(controller.signal)
      .then(location => {
        if (!location) return;
        setApproxLocation(location);
        saveApproxLocation(location);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

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

                                                                                    
  const overlayVisible = sidePanel === true && navigationActive;
  const viewInsets = overlayVisible ? measuredInsets : ZERO_INSETS;

                                                                                
                                                                               
  useEffect(() => {
    if (!overlayVisible) {
      return undefined;
    }

    const overlay = overlayRef.current;
    const container = overlay?.parentElement;
    if (!overlay || !container) {
      return undefined;
    }

    const measure = () => {
      const o = overlay.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const next = { top: 0, right: 0, bottom: 0, left: 0 };

      if (o.width >= c.width * 0.8) {
                                                      
        next.bottom = Math.max(0, Math.round(c.bottom - o.top));
      } else {
                                                          
        next.left = Math.max(0, Math.round(o.right - c.left));
      }

      setMeasuredInsets(prev =>
        prev.left === next.left && prev.bottom === next.bottom ? prev : next
      );
    };
                                                      
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    observer.observe(container);
    return () => observer.disconnect();
  }, [overlayVisible]);

  const controlSurface = darkMode
    ? "border-button bg-charcoal/95 text-darkmode-gray"
    : "border-white/80 bg-white/95 text-charcoal";

                                                            
  const accentHover = darkMode
    ? mapStyle === "hybrid"
      ? "hover:bg-hybrid-purple active:bg-hybrid-purple-dark"
      : mapStyle === "satellite"
        ? "hover:bg-green active:bg-green-dark"
        : "hover:bg-blue active:bg-blue-dark"
    : "hover:bg-green hover:text-white active:bg-green-dark";

                                                                                            
  const smallButton = `rounded-lg border p-2 transition hover:-translate-y-px active:scale-90 ${
    darkMode
      ? mapStyle === "hybrid"
        ? "border-button bg-hybrid-charcoal-light text-hybrid-purple-light"
        : mapStyle === "satellite"
          ? "border-button bg-charcoal-light text-green-light"
          : "border-button bg-charcoal-light text-blue-light"
      : "border-button-light bg-white text-green-dark"
  }`;

                                                                                       
  const leftEdge = overlayVisible ? "left-4 md:left-87.5" : "left-4";
  const smallButtonY = overlayVisible ? "" : "top-4"
  const mapProps = {
    data, selectedRoute, selectedRouteNumber, hoveredRouteNumber, displayedMode,
    onSelectRoute: selectRoute, onHoverRoute: setHoveredRouteNumber,
    currentLocation, approxLocation, navigationActive, navigationAccuracy, navigationHeading,
    startCoordinate: startUsesCurrentLocation ? currentLocation : startMapCoordinate,
    destinationCoordinate: destinationMapCoordinate,
    startLabel: start, destinationLabel: destination,
    startDraggable: !startUsesCurrentLocation,
    onSetMapStart: setStartFromMap, onSetMapDestination: setDestinationFromMap,
    onMoveStart: setStartFromMap, onMoveDestination: setDestinationFromMap,
    locationFocusKey, routeFocusKey, stepFocusCoordinate, stepFocusKey,
    darkMode, mapStyle, viewInsets, enabledLayers, onLayerStatus: layerStatusChanged,
    initialCamera: mapCamera.current,
    returnCamera: threeD ? null : return2DCamera,
    onCameraChange: value => { mapCamera.current = value; },
    registerCameraGetter: getter => { twoDCameraGetter.current = getter; },
  };

  return (
    <div
      className={`flex h-dvh w-screen overflow-hidden ${
        darkMode ? mapStyle === "hybrid" ? "bg-hybrid-charcoal" : "bg-charcoal" : "bg-white"
      }`}
    >
      <aside
        className={`map-sidebar z-[1000] flex h-dvh flex-shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r shadow-xl transition-[width,min-width,max-width,opacity,transform] duration-300 ease-in-out ${sidePanel ? "map-sidebar-closed pointer-events-none !w-0 !min-w-0 !max-w-0 !border-0 opacity-0" : "w-[340px] min-w-[311px] md:max-w-[480px] md:resize-x"} ${
          darkMode
            ? mapStyle === "hybrid"
              ? "border-button/50 bg-hybrid-charcoal"
              : "border-button/50 bg-charcoal"
            : "border-button-light/70 bg-white"
        } max-[760px]:absolute max-[760px]:bottom-5 max-[760px]:left-3 max-[760px]:right-3 max-[760px]:rounded-2xl max-[760px]:border ${sidePanel ? "max-[760px]:!w-auto max-[760px]:!max-w-none max-[760px]:!-translate-x-[110%]" : "max-[760px]:translate-x-0"} max-[760px]:w-auto ${
          mobileMin
            ? "max-[760px]:h-[88px] max-[760px]:overflow-hidden"
            : "max-[760px]:h-[60vh] max-[760px]:overflow-y-auto"
        }`}
      >
        <header className="px-5 pb-2 pt-3">
          <div className="flex items-center justify-between">
            <a
              href="https://github.com/kus001/map"
              target="_blank"
              rel="noreferrer"
              className={`inline-block text-2xl font-bold tracking-tight transition-all duration-200 active:scale-95 hover:tracking-wider ${
                darkMode 
                ? mapStyle === "hybrid" 
                  ? "text-hybrid-purple-light hover:text-hybrid-purple-dark"
                  : mapStyle === "satellite"
                    ? "text-green hover:text-green-dark"
                    : "text-blue-light hover:text-blue" 
                : "text-green hover:text-green-dark"
              }`}
            >
              kmaps
            </a>
            <button className={`hidden max-[760px]:flex ${smallButton}`} onClick={() => setMobileMin(value => !value)}>
              <IoIosArrowUp />
            </button>
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
          recentSearches={recentSearches}
          setStart={handleStartChange}
          setDestination={handleDestinationChange}
          removeRecentLocation={removeLocation}
          mode={mode}
          cyclingType={cyclingType}
          onModeChange={changeMode}
          onCyclingTypeChange={changeCyclingType}
          evEnabled={evEnabled}
          onEvEnabledChange={setEvEnabled}
          evProfile={evProfile}
          onEvProfileChange={patch => setEvProfile(current => ({ ...current, ...patch }))}
          onSearch={searchRoutes}
          onSwap={swapLocations}
          loading={loading}
          darkMode={darkMode}
          mapStyle={mapStyle}
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
          startBias={currentLocation || destinationMapCoordinate || approxLocation}
          destinationBias={
            (startUsesCurrentLocation ? currentLocation : startMapCoordinate) ||
            currentLocation ||
            approxLocation
          }
          addressIssue={addressIssue}
          onPickAddressOption={pickAddressOption}
        />

        <RoutePanel
          data={data}
          selectedRoute={selectedRoute}
          selectedRouteNumber={selectedRouteNumber}
          onSelectRoute={selectRoute}
          onRouteHover={setHoveredRouteNumber}
          onStepSelect={focusStep}
          onShareRoute={shareRoute}
          onClearRoute={clearRoute}
          displayedMode={displayedMode}
          navigationActive={navigationActive}
          mapStyle={mapStyle}
          navigationInfo={navigationInfo}
          navigationAccuracy={navigationAccuracy}
          navigationSpeedMps={navigationSpeedMps}
          onStartNavigation={startNavigation}
          onStopNavigation={() => stopNavigation()}
          status={status}
          error={error}
          darkMode={darkMode}
          timingMode={timingMode}
          departureTime={departureTime}
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
            className={`hover:underline duration-100 hover:tracking-wider ${
              darkMode 
                ? mapStyle === "hybrid"
                  ? "hover:text-hybrid-purple-light"
                  : mapStyle === "street"
                    ? "hover:text-blue-light"
                    : "hover:text-green-light"
                : "hover:text-green"
              }`}
          >
            Kush
          </a>
          <span>•</span>
          <a
            href="https://github.com/BigBrain244466666"
            target="_blank"
            rel="noreferrer"
            className={`hover:underline duration-100 hover:tracking-wider ${
              darkMode 
                ? mapStyle === "hybrid"
                  ? "hover:text-hybrid-purple-light"
                  : mapStyle === "street"
                    ? "hover:text-blue-light"
                    : "hover:text-green-light"
                : "hover:text-green"
              }`}
          >
            Victor
          </a>
          <span>•</span>
          <a
            href="https://github.com/roc-ket-cod-er"
            target="_blank"
            rel="noreferrer"
            className={`hover:underline duration-100 hover:tracking-wider ${
              darkMode 
                ? mapStyle === "hybrid"
                  ? "hover:text-hybrid-purple-light"
                  : mapStyle === "street"
                    ? "hover:text-blue-light"
                    : "hover:text-green-light"
                : "hover:text-green"
              }`}
          >
            Madhav
          </a>
        </footer>
      </aside>

      <main className="relative h-full min-w-0 flex-1 overflow-hidden">
        <button
          type="button"
          onClick={() => setIsSidePanel(value => !value)}
          title={sidePanel ? "Open menu" : "Close menu"}
          aria-label={sidePanel ? "Open menu" : "Close menu"}
          className={`absolute ${smallButtonY} z-[500] ${leftEdge} ${smallButton}`}
        >
          {sidePanel ? <MdOpenInNew /> : <IoClose />}
        </button>

        <button
          type="button"
          onClick={() => setDarkMode(value => !value)}
          title="Toggle dark mode"
          className={`absolute top-15 z-[499] ${leftEdge} ${smallButton}`}
        >
          {darkMode ? <PiSunFill /> : <TbMoonStars />}
        </button>

        <button
          type="button"
          onClick={() => findLocation({ focus: true, quiet: false })}
          title="My location"
          aria-label="My location"
          className={`absolute top-26 z-[499] ${leftEdge} ${smallButton}`}
        >
          <MdMyLocation />
        </button>

        {selectedRoute?.route_coordinates?.length > 1 && (
          <button
            type="button"
            onClick={() => setRouteFocusKey(key => key + 1)}
            title="Fit route"
            aria-label="Fit route"
            className={`absolute top-37 z-[499] ${leftEdge} ${smallButton}`}
          >
            <MdCenterFocusStrong />
          </button>
        )}

        {overlayVisible && (
          <div ref={overlayRef} className={`absolute bottom-0 right-0 left-0 md:left-4 md:top-4 md:right-auto md:bottom-auto z-[500] rounded-xl p-2 w-full md:w-80 md:h-96 h-[40vh] overflow-hidden flex flex-col
            ${darkMode 
              ? mapStyle === "hybrid"
                ? "text-white bg-hybrid-charcoal-light"
                : "bg-charcoal-light text-white"
              : "text-black bg-white"
            }`}
          >
            <RoutePanel
              data={data}
              selectedRoute={selectedRoute}
              selectedRouteNumber={selectedRouteNumber}
              onSelectRoute={selectRoute}
              onRouteHover={setHoveredRouteNumber}
              onStepSelect={focusStep}
              onShareRoute={shareRoute}
              onClearRoute={clearRoute}
              mapStyle={mapStyle}
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
              timingMode={timingMode}
              departureTime={departureTime}
            />
          </div>
        )}

        {/* Keep Leaflet's live map and overlays mounted when 3D is active.
            Visibility preserves layout dimensions and Leaflet tile state. */}
        <div
          aria-hidden={threeD}
          inert={threeD}
          style={{ position: "absolute", inset: 0,
            visibility: threeD ? "hidden" : "visible",
            pointerEvents: threeD ? "none" : "auto" }}
        >
          <MapView {...mapProps} />
        </div>
        {threeD && (
          <div style={{ position: "absolute", inset: 0 }}>
            <Scene3D {...mapProps}
              initialCamera={mapCamera.current}
              onCameraChange={value => { threeDCamera.current = value; }}
              registerCameraGetter={getter => { threeDCameraGetter.current = getter; }}
              onDisable3D={leave3D} />
          </div>
        )}

        <div className={`absolute bottom-7 right-15 z-[500] flex gap-1 rounded-xl border p-1 shadow-lg backdrop-blur ${controlSurface}`}>
          <button type="button" onClick={() => {
            if (threeD) leave3D();
            else {
              // Leaflet may still be animating a zoom or pan. Capture its
              // *current* centre/zoom before hiding it, not its last moveend.
              let camera = null;
              try { camera = twoDCameraGetter.current?.(); }
              catch (error) { console.warn("Unable to read 2D camera", error); }
              if (camera && Array.isArray(camera.center) && camera.center.length === 2 &&
                  camera.center.every(Number.isFinite) && Number.isFinite(camera.zoom)) {
                mapCamera.current = camera;
              }
              threeDCamera.current = null;
              setReturn2DCamera(null);
              setThreeD(true);
            }
          }}
            aria-pressed={threeD} title="Toggle 3D map"
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition 
            ${threeD 
              ? mapStyle === "hybrid"
                ? "bg-hybrid-purple text-white" 
                : mapStyle === "street"
                  ? "bg-blue text-white"
                  : "bg-green text-white"
              : "hover:bg-black/10"}`}>
            {threeD ? "2D" : "3D"}
          </button>

        </div>

        <div className="absolute right-4 top-4 z-[1000] flex items-center gap-2">
          <button
            type="button"
            onClick={mapStyles}
            title="Change map style"
            className={`flex h-11 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-sm font-semibold shadow-lg backdrop-blur transition active:scale-95 hover:glass focus-visible:outline-none ${controlSurface} ${darkMode}`}
          >
            {mapStyle === "street" ? (
              <MdMap className="text-lg" />
            ) : mapStyle === "satellite" ? (
              <MdSatelliteAlt className="text-lg" />
            ) : (
              <IoLayers className="text-lg" />
            )}
            <span>{mapStyle === "street" ? "Satellite" : mapStyle === "satellite" ? "Hybrid" : "Street"}</span>
          </button>

          <LayersPanel
            open={layersOpen}
            onToggleOpen={() => setLayersOpen(current => !current)}
            enabled={enabledLayers}
            onChange={setEnabledLayers}
            status={layerStatus}
            darkMode={darkMode}
          />
        </div>
      </main>
    </div>
  );
}