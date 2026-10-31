import { useRef } from "react";
import { BsPersonWalking } from "react-icons/bs";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline, IoTimeOutline } from "react-icons/io5";
import {
  MdCalendarMonth,
  MdDirectionsTransit,
  MdNavigation,
  MdShare,
  MdClose,
} from "react-icons/md";

import {
  directionText,
  formatDistance,
  formatDuration,
  liveDelayInfo,
  routeLateness,
} from "../utils/format.js";
import { passedTransitStops } from "../utils/navigation.js";

const DELAY_TONE = {
  late: ["text-red-600", "text-red-400"],
  cancelled: ["text-red-600", "text-red-400"],
  early: ["text-blue-600", "text-sky-300"],
  ontime: ["text-green-700", "text-emerald-400"],
};

function delayToneClass(tone, darkMode) {
  return (DELAY_TONE[tone] || DELAY_TONE.ontime)[darkMode ? 1 : 0];
}

const PAGE_CLOCK_MS = Date.now();

const MODE_INFO = {
  driving: { name: "Driving route", Icon: IoCarOutline },
  walking: { name: "Walking route", Icon: BsPersonWalking },
  cycling: { name: "Cycling route", Icon: IoMdBicycle },
  transit: { name: "Transit route", Icon: MdDirectionsTransit },
};

function StepIcon({ step }) {
  const type = step?.type || "";
  const modifier = String(step?.modifier || "").toLowerCase();

  if (type === "walk") {
    return <BsPersonWalking />;
  }

  if (type === "transfer" || type === "transit") {
    return <MdDirectionsTransit />;
  }

  if (type === "arrive") {
    return <span className="text-sm font-bold">✓</span>;
  }

  if (type === "u_turn") {
    return <span className="text-lg leading-none">↶</span>;
  }

  if (type === "roundabout" || type === "roundabout_exit") {
    return <span className="text-base leading-none">↻</span>;
  }

  if (modifier.includes("left")) {
    return <span className="text-lg leading-none">↰</span>;
  }

  if (modifier.includes("right")) {
    return <span className="text-lg leading-none">↱</span>;
  }

  if (type === "depart" || type === "continue") {
    return <span className="text-lg leading-none">↑</span>;
  }

  return <span className="text-xs">•</span>;
}

// only show the live bits that exist for this trip
function TransitMeta({ step, darkMode }) {
  const pieces = [];

  const live = liveDelayInfo(step);

  if (step.realtime) {
    pieces.push(step.live_source && `${step.live_source}`);
  } else if (!step.cancelled) {
    const agencyName = step.agency_label || step.live_source;
    pieces.push(agencyName ? `${agencyName}` : "Scheduled");
  }

  if (step.platform) {
    pieces.push(`platform ${step.platform}`);
  }

  if (step.stops) {
    pieces.push(`${step.stops} ${step.stops === 1 ? "stop" : "stops"}`);
  }

  if (step.wait_min >= 0.5) {
    pieces.push(`wait ${Math.round(step.wait_min)} min`);
  }

  if (step.ride_duration_min >= 0.5) {
    pieces.push(`ride ${Math.round(step.ride_duration_min)} min`);
  }

  if (step.departure_time && step.arrival_time) {
    pieces.push(`${step.departure_time} → ${step.arrival_time}`);
  }

  if (!pieces.length && !live) {
    return null;
  }

  return (
    <div
      className={`mt-1 text-xs ${
        darkMode ? "text-darkmode-gray" : "text-button-darkest"
      }`}
    >
      {live && (
        <span className={`font-bold ${delayToneClass(live.tone, darkMode)}`}>
          {live.label}
        </span>
      )}
      {live && pieces.length > 0 && " • "}
      {pieces.join(" • ")}
    </div>
  );
}

function formatScheduledDeparture(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

                                                                                
                                                                                  
                                                                    
function requiredLeaveTime(route) {
  let walkMs = 0;
  for (const step of route?.steps || []) {
    if (step?.type === "transit") {
      const boards = Date.parse(step.departure_datetime);
      if (Number.isFinite(boards)) {
        return new Date(boards - walkMs).toISOString();
      }
      break;
    }
    walkMs += Number(step?.duration_min || 0) * 60000;
  }
  return route?.departure_datetime || null;
}

                                                                              
function formatLeaveClock(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (date.toDateString() !== new Date(PAGE_CLOCK_MS).toDateString()) {
    return formatScheduledDeparture(value);
  }

  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

                                                                                   
function transitNavigationSummary(info) {
  const step = info?.current_step;
  if (!step) {
    return null;
  }

  const toEnd = info.distance_to_step_end_m;
  const lines = [];
  let headline;

  if (step.type === "transit") {
    const nearStop = Number.isFinite(toEnd) && toEnd <= 250;
    headline = nearStop && step.to ? `Get off at ${step.to}` : directionText(step);
    if (Number.isFinite(toEnd)) {
      lines.push(
        nearStop ? `${formatDistance(toEnd)} to your stop` : `${formatDistance(toEnd)} to ${step.to || "your stop"}`
      );
    }
    if (step.arrival_time) {
      lines.push(`Arrives ${step.arrival_time}`);
    }
    if (step.live_status && step.live_status !== "On time") {
      lines.push(step.live_status);
    }
  } else {
    const turn = info.next_turn;
    headline = turn ? directionText(turn) : directionText(step);
    if (turn && Number.isFinite(info.distance_to_turn_m)) {
      lines.push(`${formatDistance(info.distance_to_turn_m)} to turn`);
    }
    if (Number.isFinite(toEnd)) {
      lines.push(
        turn && step.to
          ? `${formatDistance(toEnd)} to ${step.to}`
          : `${formatDistance(toEnd)} to go`
      );
    }
    const board = info.next_transit_step;
    if (board) {
      const minutes = info.minutes_to_departure;
      const scheduled = info.scheduled_minutes_to_departure;
      const delay = info.departure_delay_min || 0;
      let when = "";
      if (Number.isFinite(minutes)) {
        if (minutes <= 0) {
          when = " (now)";
        } else if (delay !== 0 && Number.isFinite(scheduled) && scheduled > 0 && scheduled + delay === minutes) {
          // delayed (or early) vehicle: show the timetable wait and what the delay adds
          when = ` (in ${scheduled}${delay > 0 ? "+" : "\u2212"}${Math.abs(delay)} min)`;
        } else {
          when = ` (in ${minutes} min)`;
        }
      }
      lines.push(
        `Board ${board.vehicle ? `${board.vehicle} ` : ""}route ${board.route} at ${board.departure_time}${when}`
      );
      if (board.live_status && board.live_status !== "On time") {
        lines.push(board.live_status);
      }
    }
  }

  return { headline, lines };
}

                                                                        
                                                                                     
function bestTies(routes, valueOf, tolerance) {
  const values = routes.map(route => ({ route, value: Number(valueOf(route)) }))
    .filter(item => Number.isFinite(item.value));
  if (values.length < 2) return new Set();
  const best = Math.min(...values.map(item => item.value));
  if (!values.some(item => item.value - best > tolerance)) return new Set();
  return new Set(
    values.filter(item => item.value - best <= tolerance).map(item => item.route.route_number)
  );
}

function transferCount(route) {
  const legs = (route?.steps || []).filter(step => step?.type === "transit").length;
  return Math.max(0, legs - 1);
}

export default function RoutePanel({
  data,
  selectedRoute,
  selectedRouteNumber = 1,
  onSelectRoute = () => {},
  onRouteHover = () => {},
  onStepSelect = () => {},
  mapStyle,
  onShareRoute = () => {},
  onClearRoute = () => {},
  displayedMode,
  navigationActive = false,
  navOnly = false,
  navigationInfo = null,
  navigationAccuracy = null,
  navigationSpeedMps = null,
  onStartNavigation = () => {},
  onStopNavigation = () => {},
  status,
  error,
  darkMode,
  timingMode,
}) {
  // stops already crossed off per transit leg; only ever grows while navigating, so GPS jitter can't un-cross one
  const passedLatch = useRef({});
  const mode = displayedMode || data?.mode || "driving";
  

  if (!data?.routes?.length) {
    return (
      <div className={`min-h-0 flex-1 max-[760px]:flex-none px-5 py-3 ${
        !error && status === "Enter a starting point and destination."
          ? "max-[760px]:hidden"
          : ""
      }`}>
        <div
          className={`rounded-xl border p-3 text-sm min-[761px]:@max-[295px]/sidebar:h-9 min-[761px]:@max-[295px]/sidebar:p-2.5 min-[761px]:@max-[295px]/sidebar:text-xs ${
            error
              ? darkMode 
                ? "bg-button-500/70 bg-red-950/30 text-red-300"
                : "border-red-300 bg-red-75 text-red-700"
              : darkMode
                ? mapStyle === "hybrid"
                  ? "border-hybrid-purple bg-hybrid-charcoal-light text-darkmode-gray"
                  : mapStyle === "satellite"
                    ? "border-green bg-green/10 text-darkmode-gray"
                    : "border-blue bg-charcoal-light text-darkmode-gray"
                : "border-button-light bg-white text-button-darkest"
          }`}
        >
          {status}
        </div>
      </div>
    );
  }

  const modeInfo = MODE_INFO[mode] || MODE_INFO.driving;
  const ModeIcon = modeInfo.Icon;
  const activeRoute =
    selectedRoute ||
    data.routes.find(route => route.route_number === selectedRouteNumber) ||
    data.routes[0];
  const steps = activeRoute?.steps || activeRoute?.stops || [];
  if (!navigationActive) {
    passedLatch.current = {};
  }
  const passedStopsFor = (step, index) => {
    const total = step?.stop_list?.length || 0;
    const currentIndex = navigationInfo?.current_step_index;
    if (!navigationActive || !total || currentIndex == null) {
      return 0;
    }
    let count = 0;
    if (index < currentIndex) {
      count = total;
    } else if (index === currentIndex) {
      count = passedTransitStops(activeRoute, step, navigationInfo.route_index);
    }
    const key = `${step.trip_id || "leg"}:${index}`;
    const kept = Math.max(passedLatch.current[key] || 0, count);
    passedLatch.current[key] = kept;
    return kept;
  };
  const alerts = data?.alerts ?? [];
  const arrivalLabel = route => {
    if (route.arrival_estimate_datetime) {
      const computed = new Date(route.arrival_estimate_datetime);
      if (!Number.isNaN(computed.getTime())) return computed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    const startingTime = route.departure_datetime || data?.requested_departure_datetime;
    const initialMs = startingTime ? new Date(startingTime).getTime() : PAGE_CLOCK_MS;
    return new Date(initialMs + Number(route.duration_min || 0) * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  const scheduledDeparture = formatScheduledDeparture(
    data.requested_departure_datetime || data.departure_datetime
  );
  const leaveBy =
    mode === "transit"
      ? formatScheduledDeparture(requiredLeaveTime(activeRoute))
      : null;
  const navigationOffRouteThreshold = Math.max(
    70,
    Number(navigationAccuracy || 0) * 2
  );
                                                                                 
  const ridingTransit =
    mode === "transit" && navigationInfo?.current_step?.type === "transit";
  const navigationOffRoute =
    navigationActive &&
    !ridingTransit &&
    navigationInfo?.off_route_m > navigationOffRouteThreshold;
  const transitNav =
    navigationActive && mode === "transit"
      ? transitNavigationSummary(navigationInfo)
      : null;
                                        
  const isTransit = mode === "transit";
  const earliestArrival = isTransit
    ? bestTies(data.routes, route => Date.parse(route.arrival_estimate_datetime), 30000)        
    : new Set();
  const fastestRoutes = bestTies(data.routes, route => route.duration_min, 0.5);                 
  const shortestRoutes = bestTies(data.routes, route => route.distance_km, 0.025);               
  const leastTransfers = isTransit ? bestTies(data.routes, transferCount, 0) : new Set();

  const navigationCard = navigationActive ? (
        <div
          className={`${
            navOnly
              // minimized phone panel: the panel itself is the card, so no second box inside it
              ? `px-3 pb-1 pt-0 ${
                  navigationOffRoute
                    ? "border-l-4 border-amber-400 pl-2.5 text-amber-500"
                    : darkMode
                      ? "text-darkmode-gray"
                      : "text-charcoal"
                }`
              : `mb-3 rounded-2xl border p-3.5 ${
            navigationOffRoute
              ? "border-amber-400 bg-amber-50 text-amber-950"
              : darkMode
                ? mapStyle === "hybrid"
                  ? "border-hybrid-purple bg-hybrid-charcoal-light text-darkmode-gray"
                  : mapStyle === "satellite"
                    ? "border-green/50 bg-green/10 text-darkmode-gray"
                    : "border-blue/50 bg-blue/10 text-darkmode-gray"
                : "border-green/40 bg-green/10 text-charcoal"
          }`
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em]">
              <MdNavigation className="text-base" />
              {navigationOffRoute ? "Off route" : "Navigating"}
            </div>
            <button
              type="button"
              onClick={onStopNavigation}
              className="rounded-lg border border-current/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition hover:bg-black/5"
            >
              Stop
            </button>
          </div>

          <div className="mt-2 text-base font-bold leading-5">
            {transitNav
              ? transitNav.headline
              : navigationInfo?.next_step
                ? directionText(navigationInfo.next_step)
                : "Following route…"}
          </div>

          {transitNav?.lines.length > 0 && (
            <div className="mt-1 space-y-0.5 text-xs font-semibold opacity-90">
              {transitNav.lines.map(line => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs opacity-80">
            {!transitNav && Number.isFinite(navigationInfo?.distance_to_next_m) && (
              <span>{formatDistance(navigationInfo.distance_to_next_m)} to turn</span>
            )}
            {                                                       
                                                                                                         
                   }
            {Number.isFinite(Number(navigationAccuracy)) && (
              <span>• GPS ±{Math.round(Number(navigationAccuracy))} m</span>
            )}
            {Number.isFinite(Number(navigationSpeedMps)) && navigationSpeedMps > 0.3 && (
              <span>• {Math.round(navigationSpeedMps * 3.6)} km/h</span>
            )}
          </div>

          {navigationOffRoute && (
            <div className="mt-2 text-xs font-semibold">
              About {Math.round(navigationInfo.off_route_m)} m from the route. kmaps will reroute automatically after repeated GPS fixes.
            </div>
          )}
        </div>
  ) : null;

  if (navOnly) {
    return navigationCard;
  }

  return (
    <div className="map-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3 max-[760px]:flex-none max-[760px]:overflow-visible min-[761px]:@max-[295px]/sidebar:h-9 min-[761px]:@max-[295px]/sidebar:text-sm">
      <div
        className={`mb-3 rounded-xl border px-3 py-2.5 text-xs ${
          error
            ? "border-red-300 bg-red-50 text-red-700"
            : darkMode
              ? mapStyle === "hybrid"
                ? "border-hybrid-purple bg-hybrid-charcoal-light text-darkmode-gray"
                : mapStyle === "satellite"
                  ? "border-green bg-green/10 text-darkmode-gray"
                  : "border-blue bg-charcoal-light text-darkmode-gray"
              : "border-button-light bg-white text-button-darkest"
        }`}
      >
        {status}
      </div>

      {navigationCard}

      {mode === "transit" && timingMode === "arrive_by" && data?.arrive_by_datetime && (
        <div className={`mb-3 rounded-xl border px-3 py-2.5 text-xs font-semibold ${
          darkMode 
            ? mapStyle === "hybrid"
              ? "border-hybrid-purple/40 bg-hybrid-purple/10 text-darkmode-gray" 
              : mapStyle === "satellite"
                ? "border-green/40 bg-green/10 text-darkmode-gray"
                : "border-blue/40 bg-blue/10 text-darkmode-gray"
            : "border-green/30 bg-green/10 text-green-dark"
          }`}>
          <MdCalendarMonth className="mr-2 inline text-base" />
          Arrive by {formatScheduledDeparture(data.arrive_by_datetime)} · Leave by {leaveBy}
        </div>
      )}

      {scheduledDeparture && timingMode !== "arrive_by" && (
        <div
          className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold ${
            darkMode
              ? mapStyle === "hybrid" 
                ? "border-hybrid-purple bg-hybrid-purple/15 text-white"
                : mapStyle === "street"
                  ? "border-blue bg-blue/15 text-white"
                  : "border-green bg-green/15 text-white"
              : "border-green/30 bg-green/10 text-green-dark"
          }`}
        >
          <MdCalendarMonth className="mr-2 inline text-base" />
          {leaveBy ? `Leave by ${leaveBy}` : `Departing ${scheduledDeparture}`}
        </div>
      )}
      {
         }

      {data.routing_provider === "tomtom_ev" && (
        <div className={`mb-3 rounded-xl border p-3 text-xs ${darkMode ? "border-white/15 text-slate-200" : "border-blue-200 bg-blue-50 text-slate-800"}`}>
          <strong>EV route · live traffic-aware</strong>
          <div className="mt-1">Charging: {activeRoute.total_charging_min ?? 0} min · Traffic delay: {activeRoute.traffic_delay_min ?? 0} min</div>
          <div>Estimated charge on arrival: {activeRoute.remaining_charge_kwh == null ? "unknown" : `${Number(activeRoute.remaining_charge_kwh).toFixed(1)} kWh`}</div>
          <div className="mt-1 opacity-65">Generic battery and charging estimates; not vehicle-specific predictions.</div>
        </div>
      )}
      {mode === "transit" && alerts.length > 0 && (
        <details className="group mb-3 rounded-xl border border-amber-300 bg-amber-50 text-xs text-amber-900">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-bold [&::-webkit-details-marker]:hidden">
            <span>
              {alerts.length === 1 ? "1 service alert" : `${alerts.length} service alerts`}
            </span>
            <span
              aria-hidden="true"
              className="text-[10px] transition-transform duration-200 group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="space-y-2 border-t border-amber-300/70 px-3 py-2">
            {alerts.map(alert => (
              <div key={`${alert.agency}:${alert.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="font-bold">{alert.header}</div>
                  {alert.agency && (
                    <span className="shrink-0 rounded-full border border-amber-400/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                      {alert.agency_label || String(alert.agency).toUpperCase()}
                    </span>
                  )}
                </div>
                {alert.description && (
                  <div className="mt-1">{alert.description}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {mode === "transit" && data.alternatives_loading && (
        <div className="mb-2 text-xs opacity-80" role="status"> <span className={`${darkMode ? "text-darkmode-gray" : "text-charcoal"}`}>Finding other transit options…</span></div>
      )}
      <div className="space-y-2">
        {data.routes.map(route => {
          const selected = route.route_number === activeRoute.route_number;
          const labels = [];
          const transitLegs = (route.steps || [])
            .filter(step => step?.type === "transit")
            .map(step => ({
              name: String(step.route || "Transit"),
              color: /^#[0-9a-fA-F]{6}$/.test(step.route_color || "") ? step.route_color : null,
            }));
          const transitSummary = transitLegs.filter(
            (value, index) => index === 0 || transitLegs[index - 1].name !== value.name
          );
          const transferRisk = route.transfer_reliability;
          if (mode === "transit" && transferRisk?.status === "critical") labels.push("RISKY TRANSFER");
          if (mode === "transit" && transferRisk?.status === "tight") labels.push("TIGHT TRANSFER");
      
          if (route.route_variant === "walking") labels.push("WALK ONLY");
          const arrivesEarliest = earliestArrival.has(route.route_number);
          if (arrivesEarliest) labels.push("ARRIVES EARLIEST");
          if (fastestRoutes.has(route.route_number) && !arrivesEarliest) labels.push("FASTEST");
          if (leastTransfers.has(route.route_number)) labels.push("LEAST TRANSFERS");
          if (shortestRoutes.has(route.route_number)) {
            labels.push(isTransit ? "SHORTEST WALK" : "SHORTEST");
          }

          return (
            <button
              type="button"
              key={route.route_number}
              onClick={() => onSelectRoute(route.route_number)}
              onMouseEnter={() => onRouteHover(route.route_number)}
              onMouseLeave={() => onRouteHover(null)}
              className={`w-full rounded-xl border p-4 text-left transition-all ${
                selected
                  ? darkMode
                    ? mapStyle === "hybrid"
                      ? "border-hybrid-purple bg-hybrid-purple/10 shadow-sm"
                      : mapStyle === "satellite"
                        ? "border-green bg-green/10 shadow-sm"
                        : "border-blue bg-blue/10 shadow-sm"
                    : "border-green bg-green/10 shadow-sm"
                  : darkMode
                    ? mapStyle == "hybrid"
                      ? "border-button bg-hybrid-charcoal-light hover:border-hybrid-purple hover:bg-hybrid-purple/10"
                      : mapStyle === "satellite"
                        ? "border-button bg-charcoal-light hover:border-green hover:bg-green/10"
                        : "border-button bg-charcoal-light hover:border-blue hover:bg-blue/10"
                    : "border-button-light bg-white hover:border-green hover:shadow-sm"
              }`}
            >
              <div className="flex flex-col gap-2.5">
                {labels.length > 0 && (
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-bold uppercase leading-4 tracking-wide">
                    {labels.map((label, index) => (
                      <span
                        key={label}
                        className={`whitespace-nowrap ${
                          label.includes("TRANSFER") && !label.includes("LEAST")
                            ? darkMode ? "text-amber-300" : "text-amber-700"
                            : darkMode
                              ? "text-hybrid-purple-light"
                              : "text-green"
                        }`}
                      >
                        {label}
                        {index < labels.length - 1 && (
                          <span className="ml-2 opacity-50" aria-hidden="true">•</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                <div>
                  <div
                    className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${
                      darkMode ? "text-darkmode-gray" : "text-charcoal"
                    }`}
                  >
                    <span className="whitespace-nowrap text-xl font-bold">
                      {formatDuration(route.duration_min)}
                    </span>
                    <span className="whitespace-nowrap text-base font-semibold opacity-80">
                      {arrivalLabel(route)}
                    </span>
                  </div>

                  <div
                    className={`mt-1 flex flex-wrap items-center gap-x-2 text-xs ${
                      darkMode ? "text-darkmode-gray" : "text-button-darkest"
                    }`}
                  >
                    <ModeIcon />
                    <span>{modeInfo.name}</span>
                    <span>•</span>
                    <span>
                      {Number(route.distance_km || 0).toFixed(1)} km
                      {mode === "transit" ? " walking" : ""                                       }
                    </span>
                  </div>


                  {mode === "transit" && transferRisk?.status != "comfortable" && transferRisk.status !== "direct" && (
                    <div className={`mt-1 text-[11px] font-semibold ${
                      ["critical", "tight"].includes(transferRisk.status)
                        ? darkMode ? "text-amber-300" : "text-amber-700"
                        : darkMode ? "text-darkmode-gray" : "text-button-darkest"
                    }`}>
                      {transferRisk.label}
                      {transferRisk.transfers?.length ? ` · ${transferRisk.transfers.map(item => `${item.margin_min} min buffer`).join(" / ")}` : ""}
                    </div>
                  )}
                  {mode === "transit" && requiredLeaveTime(route) && (
                    <div
                      className={`mt-2 text-[14.5px] font-semibold tabular-nums ${
                        darkMode ? "text-darkmode-gray" : "text-charcoal"
                      }`}
                    >
                      {formatLeaveClock(requiredLeaveTime(route))}
                      {route.arrival_estimate_datetime && ` ·  ${formatLeaveClock(route.arrival_estimate_datetime)}`}
                    </div>
                  )}
                  {mode === "transit" && transitSummary.length > 0 && (
                    <div
                      className={`mt-2 text-xs font-semibold leading-5 ${
                        darkMode ? "text-blue-light" : "text-green-dark"
                      }`}
                    >
                      {transitSummary.map((leg, index) => (
                        <span key={`${leg.name}-${index}`}>
                          {index > 0 && <span className="mx-1">→</span>}
                          <span style={leg.color ? { borderLeft: `3px solid ${leg.color}`, paddingLeft: 5 } : undefined}>
                            {leg.name}
                          </span>
                        </span>
                      ))}
                      {(() => {
                        const lateness = routeLateness(route.steps);
                        return lateness ? (
                          <span>
                            {" • "}
                            <span className={delayToneClass(lateness.tone, darkMode)}>
                              {"LIVE · "}{lateness.label}
                            </span>
                          </span>
                        ) : null;
                      })()}
                    </div>
                  )}

                  {mode === "cycling" && (route.ascent_m || route.descent_m) && (
                    <div
                      className={`mt-1 text-xs ${
                        darkMode ? "text-darkmode-gray" : "text-button-darkest"
                      }`}
                    >
                      {route.ascent_m ? `↑ ${Math.round(route.ascent_m)} m` : ""}
                      {route.ascent_m && route.descent_m ? " • " : ""}
                      {route.descent_m ? `↓ ${Math.round(route.descent_m)} m` : ""}
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="my-4 border-t border-button-light/60" />

      <div className="mb-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2
            className={`text-base font-bold ${
              darkMode ? "text-darkmode-gray" : "text-charcoal"
            }`}
          >
            Directions
          </h2>
          <span className={`text-xs opacity-70 ${darkMode ? "text-darkmode-gray" : "text-charcoal"}`}>
            {steps.length} {steps.length === 1 ? "step" : "steps"}
          </span>
        </div>

        <div className="flex items-center w-full gap-2">
          {(
            <button
              type="button"
              onClick={navigationActive ? onStopNavigation : onStartNavigation}
              title={navigationActive ? "Stop navigation" : "Start navigation"}
              aria-label={navigationActive ? "Stop navigation" : "Start navigation"}
              className={`flex h-8 items-center flex-1 justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition ${
                navigationActive
                  ? darkMode 
                    ? mapStyle === "hybrid"
                      ? "border-hybrid-purple bg-hybrid-purple text-white"
                      : mapStyle === "satellite"  
                        ? "border-green bg-green text-white"
                        : "border-blue bg-blue text-white"
                  : "border-green bg-green text-white"
                  : darkMode
                    ? mapStyle === "hybrid"
                      ? "border-button bg-hybrid-charcoal-light text-hybrid-purple-light hover:border-hybrid-purple hover:bg-hybrid-purple/15"
                    : mapStyle === "satellite"
                      ? "border-button bg-charcoal-light text-green-light hover:border-green hover:bg-green/15"
                      : "border-button bg-charcoal-light text-blue-light hover:border-blue hover:bg-blue/15"
                    : "border-button-light bg-white text-green-dark hover:border-green hover:bg-green/10"
              }`}
            >
              <MdNavigation />
              {navigationActive ? "Stop" : "Navigate"}
            </button>
          )}
          <button
            type="button"
            onClick={onClearRoute}
            title="Clear route and start over"
            aria-label="Clear route"
            className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-xs font-semibold transition hover:opacity-80 ${
                darkMode
                  ? mapStyle === "hybrid"
                    ? "border-button bg-hybrid-charcoal-light text-hybrid-purple-light hover:border-hybrid-purple hover:bg-hybrid-purple/15"
                  : mapStyle === "satellite"
                    ? "border-button bg-charcoal-light text-green-light hover:border-green hover:bg-green/15"
                    : "border-button bg-charcoal-light text-blue-light hover:border-blue hover:bg-blue/15"
                  : "border-button-light bg-white text-green-dark hover:border-green hover:bg-green/10"
            }`}
          >
            <MdClose />
          </button>
          <button
            type="button"
            onClick={onShareRoute}
            title="Copy shareable route link"
            aria-label="Copy shareable route link"
            className={`flex size-8 items-center justify-center rounded-lg border text-sm transition ${
                  darkMode
                    ? mapStyle === "hybrid"
                      ? "border-button bg-hybrid-charcoal-light text-hybrid-purple-light hover:border-hybrid-purple hover:bg-hybrid-purple/15"
                    : mapStyle === "satellite"
                      ? "border-button bg-charcoal-light text-green-light hover:border-green hover:bg-green/15"
                      : "border-button bg-charcoal-light text-blue-light hover:border-blue hover:bg-blue/15"
                    : "border-button-light bg-white text-green-dark hover:border-green hover:bg-green/10"

            }`}
          >
            <MdShare />
          </button>
        </div>
      </div>

      {steps.length === 0 ? (
        <div
          className={`rounded-xl border p-4 text-sm ${
            darkMode
              ? "border-button bg-charcoal-light text-white"
              : "border-button-light bg-white text-button-darkest"
          }`}
        >
          No directions were returned for this route.
        </div>
      ) : (
        <div
          className={`overflow-hidden rounded-xl border ${
            darkMode
              ? mapStyle === "hybrid" 
                ? "border-button bg-hybrid-charcoal-light"
                : "border-button bg-charcoal-light"
              : "border-button-light bg-white"
          }`}
        >
          {steps.map((step, index) => {
            const canFocus =
              Array.isArray(step?.coordinates) && step.coordinates.length >= 2;

            const directions = Array.isArray(step?.directions)
              ? step.directions.filter(item => directionText(item))
              : [];
            const stopList = step?.type === "transit" && Array.isArray(step.stop_list)
              ? step.stop_list
              : [];
            const passedStops = passedStopsFor(step, index);
            const ridingThisLeg =
              navigationActive && navigationInfo?.current_step_index === index;

            return (
              <div
                key={`${step.type || "step"}-${index}`}
                className={`border-b last:border-b-0 ${
                  darkMode ? "border-button/50" : "border-button-light/60"
                }`}
              >
              <button
                type="button"
                onClick={() => canFocus && onStepSelect(step, index)}
                disabled={!canFocus}
                title={canFocus ? "Show this step on the map" : undefined}
                className={`flex w-full gap-3 p-3 text-left ${
                  canFocus
                    ? darkMode
                      ? mapStyle === "hybrid"
                        ? "transition hover:bg-hybrid-purple/10"
                        : mapStyle === "satellite"
                          ? "transition hover:bg-green-dark/10"
                          : "transition hover:bg-blue/10"
                      : "transition hover:bg-green/10"
                    : "cursor-default"
                }`}
              >
                <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white ${
                  darkMode
                    ? mapStyle === "hybrid"
                      ? "bg-hybrid-purple"
                      : mapStyle === "satellite"
                        ? "bg-green"
                        : "bg-blue"
                    : "bg-green"
                }`}>
                  <StepIcon step={step} />
                </div>

                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm font-medium leading-5 ${
                      darkMode ? "text-darkmode-gray" : "text-charcoal"
                    }`}
                  >
                    {directionText(step)}
                  </div>

                  {step.type === "transit" ? (
                    <TransitMeta step={step} darkMode={darkMode} />
                  ) : (
                    <div
                      className={`mt-1 flex flex-wrap items-center gap-x-2 text-xs ${
                        darkMode ? "text-darkmode-gray" : "text-button-darkest"
                      }`}
                    >
                      {step.duration_min >= 0.5 && (
                        <span className="flex items-center gap-1">
                          <IoTimeOutline />
                          {formatDuration(step.duration_min)}
                        </span>
                      )}
                      {step.distance_m > 0 && (
                        <span>{formatDistance(step.distance_m)}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>

              {directions.length > 1 && (
                <details
                  className={`pb-3 pl-14 pr-3 text-xs ${
                    darkMode ? "text-darkmode-gray" : "text-button-darkest"
                  }`}
                >
                  <summary className="cursor-pointer select-none font-semibold">
                    Walking directions ({directions.length} steps)
                  </summary>
                  <ol className="mt-1.5 space-y-0.5">
                    {directions.map((direction, directionIndex) => {
                      const canFocusDirection =
                        Array.isArray(direction?.coordinates) &&
                        direction.coordinates.length >= 2;

                      return (
                        <li key={`${directionIndex}-${direction.road || ""}`}>
                          <button
                            type="button"
                            onClick={() =>
                              canFocusDirection && onStepSelect(direction, directionIndex)
                            }
                            disabled={!canFocusDirection}
                            className={`flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left ${
                              canFocusDirection
                                ? darkMode
                                  ? mapStyle === "hybrid"
                                    ? "hover:bg-purple/10"
                                    : mapStyle === "satellite"
                                      ? "hover:bg-green/10"
                                      : "hover:bg-blue/10"
                                  : "hover:bg-green/10"
                                : "cursor-default"
                            }`}
                          >
                            <span>{directionText(direction)}</span>
                            {direction.distance_m > 0 && (
                              <span className="shrink-0 opacity-70">
                                {formatDistance(direction.distance_m)}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}

              {stopList.length > 0 && (
                <details
                  open={ridingThisLeg}
                  className={`pb-3 pl-14 pr-3 text-xs ${
                    darkMode ? "text-darkmode-gray" : "text-button-darkest"
                  }`}
                >
                  <summary className="cursor-pointer select-none font-semibold">
                    Stops ({stopList.length})
                  </summary>
                  <ol className="mt-1.5 space-y-0.5">
                    {stopList.map((stop, stopIndex) => {
                      const crossedOff = stopIndex < passedStops;
                      const isNext = ridingThisLeg && stopIndex === passedStops;
                      const isLast = stopIndex === stopList.length - 1;
                      const canFocusStop =
                        Array.isArray(stop?.coordinates) && stop.coordinates.length >= 2;

                      return (
                        <li key={`${stop.stop_id || stopIndex}-${stopIndex}`}>
                          <button
                            type="button"
                            onClick={() => canFocusStop && onStepSelect(stop, stopIndex)}
                            disabled={!canFocusStop}
                            className={`flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left ${
                              canFocusStop
                                ? darkMode
                                  ? mapStyle === "hybrid"
                                    ? "hover:bg-hybrid-purple/10"
                                    : mapStyle === "satellite"
                                      ? "hover:bg-green/10"
                                      : "hover:bg-blue/10"
                                  : "hover:bg-green/10"
                                : "cursor-default"
                            } ${crossedOff ? "line-through opacity-50" : ""} ${
                              isNext ? "font-bold" : ""
                            }`}
                          >
                            <span>{stop.name}</span>
                            {!crossedOff && (isLast || isNext) && (
                              <span className="shrink-0 opacity-70">
                                {isLast ? "Get off" : "Next"}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
