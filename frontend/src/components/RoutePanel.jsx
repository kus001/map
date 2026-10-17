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
} from "../utils/format.js";

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

function TransitMeta({ step, darkMode }) {
  const pieces = [];

  if (step.realtime) {
    pieces.push(step.live_source === "GO Transit" ? "LIVE GO" : "LIVE");
  }

  if (step.live_status && step.live_status !== "On time") {
    pieces.push(step.live_status);
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

  if (Math.abs(step.delay_min || 0) >= 0.5) {
    pieces.push(
      `${step.delay_min > 0 ? "+" : ""}${Math.round(step.delay_min)} min`
    );
  }

  if (step.departure_time && step.arrival_time) {
    pieces.push(`${step.departure_time} → ${step.arrival_time}`);
  }

  if (!pieces.length) {
    return null;
  }

  return (
    <div
      className={`mt-1 text-xs ${
        step.cancelled
          ? "font-semibold text-red-600"
          : darkMode
            ? "text-darkmode-gray"
            : "text-button-darkest"
      }`}
    >
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

// Headline + detail lines for the navigation card while following a transit route.
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
      const when = Number.isFinite(minutes)
        ? minutes <= 0
          ? " (now)"
          : ` (in ${minutes} min)`
        : "";
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
  const mode = displayedMode || data?.mode || "driving";

  if (!data?.routes?.length) {
    return (
      <div className="min-h-0 flex-1 px-5 py-3">
        <div
          className={`rounded-xl border p-3 text-sm ${
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
  const navigationOffRouteThreshold = Math.max(
    70,
    Number(navigationAccuracy || 0) * 2
  );
  // While riding a vehicle the path is the vehicle's, so don't flag "off route".
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


  return (
    <div className="map-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4 max-[760px]:flex-none max-[760px]:overflow-visible">
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

      {navigationActive && (
        <div
          className={`mb-3 rounded-2xl border p-3.5 ${
            navigationOffRoute
              ? "border-amber-400 bg-amber-50 text-amber-950"
              : darkMode
                ? mapStyle === "hybrid"
                  ? "border-hybrid-purple bg-hybrid-charcoal-light text-darkmode-gray"
                  : mapStyle === "satellite"
                    ? "border-green/50 bg-green/10 text-darkmode-gray"
                    : "border-blue/50 bg-blue/10 text-darkmode-gray"
                : "border-green/40 bg-green/10 text-charcoal"
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
            {/*   {Number.isFinite(navigationInfo?.remaining_m) && (
              <span>{transitNav ? "" : "• "}{formatDistance(navigationInfo.remaining_m)} remaining</span>
            )}   */}
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
      )}

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
          Arrive by {formatScheduledDeparture(data.arrive_by_datetime)} · Suggested leave time {formatScheduledDeparture(activeRoute.departure_datetime)}
        </div>
      )}

      {scheduledDeparture && timingMode !== "arrive_by" && (
        <div
          className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold ${
            darkMode
              ? "border-hybrid-purple/50 bg-hybrid-purple/15 text-white"
              : "border-green/30 bg-green/10 text-green-dark"
          }`}
        >
          <MdCalendarMonth className="text-base" />
          Departing {scheduledDeparture}
        </div>
      )}



      {mode === "transit" && activeRoute?.transfer_reliability?.transfers?.some(item => ["critical", "tight"].includes(item.status)) && (
        <div className="mb-3 rounded-xl border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          <strong>Transfer warning:</strong> connection buffers are estimates; allow extra time for walking and delays.
        </div>
      )}

      {mode === "transit" && alerts.length > 0 && (
        <div className="mb-3 space-y-2">
          {alerts.map(alert => (
            <div
              key={alert.id}
              className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-bold">{alert.header}</div>
                {alert.agency && (
                  <span className="shrink-0 rounded-full border border-amber-400/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                    {alert.agency === "go" ? "GO" : "GRT"}
                  </span>
                )}
              </div>
              {alert.description && (
                <div className="mt-1 line-clamp-3">{alert.description}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {mode === "transit" && data.alternatives_loading && (
        <div className="mb-2 text-xs opacity-80" role="status">Finding other transit options…</div>
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

          if (
            mode !== "transit" &&
            data.routes.length > 1 &&
            route.route_number === data.fastest_route_number
          ) {
            labels.push("FASTEST");
          }

          if (
            mode !== "transit" &&
            data.routes.length > 1 &&
            route.route_number === data.shortest_route_number
          ) {
            if (mode === "transit") {
              labels.push("SHORTEST WALK");
            } else {
              labels.push("SHORTEST")
            }
          }

          return (
            <button
              type="button"
              key={route.route_number}
              onClick={() => onSelectRoute(route.route_number)}
              onMouseEnter={() => onRouteHover(route.route_number)}
              onMouseLeave={() => onRouteHover(null)}
              className={`w-full rounded-xl border p-3.5 text-left transition-all ${
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
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div
                    className={`text-xl font-bold ${
                      darkMode ? "text-darkmode-gray" : "text-charcoal"
                    }`}
                  >
                    {formatDuration(route.duration_min)}{" • "}
                    {arrivalLabel(route)}
                    {/*returns arrival time*/}
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
                      {mode === "transit" ? " walking" : ""}
                    </span>
                  </div>


                  {mode === "transit" && transferRisk?.status != "comfortable" && transferRisk.status !== "direct" && (
                    <div className={`mt-1 text-[11px] font-semibold ${
                      ["critical", "tight"].includes(transferRisk.status)
                        ? "text-amber-500"
                        : darkMode ? "text-darkmode-gray" : "text-button-darkest"
                    }`}>
                      {transferRisk.label}
                      {transferRisk.transfers?.length ? ` · ${transferRisk.transfers.map(item => `${item.margin_min} min buffer`).join(" / ")}` : ""}
                    </div>
                  )}
                  {mode === "transit" && timingMode === "arrive_by" && route.departure_datetime && (
                    <div className="mt-1 text-[11px] opacity-80">Leave {formatScheduledDeparture(route.departure_datetime)} · Arrive {formatScheduledDeparture(route.arrival_estimate_datetime)}</div>
                  )}
                  {mode === "transit" && transitSummary.length > 0 && (
                    <div
                      className={`mt-1 line-clamp-1 text-xs font-semibold ${
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
                      {(route.steps || []).some(
                        step => step?.type === "transit" && step?.realtime
                      ) && " • LIVE"}
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

                {labels.length > 0 && (
                  <div className={`text-right text-[10px] font-bold tracking-wide ${darkMode ? "text-hybrid-purple-light" : "text-green"}`}>
                    {labels.join(" • ")}
                  </div>
                )}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
