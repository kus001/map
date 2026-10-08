import { BsPersonWalking } from "react-icons/bs";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline, IoTimeOutline } from "react-icons/io5";
import {
  MdCalendarMonth,
  MdDirectionsTransit,
  MdNavigation,
  MdShare,
} from "react-icons/md";

import {
  directionText,
  formatDistance,
  formatDuration,
} from "../utils/format.js";

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

export default function RoutePanel({
  data,
  selectedRoute,
  selectedRouteNumber = 1,
  onSelectRoute = () => {},
  onRouteHover = () => {},
  onStepSelect = () => {},
  onShareRoute = () => {},
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
                ? "border-button bg-charcoal-light text-darkmode-gray"
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
  const realtime = activeRoute?.realtime;
  const alerts = data?.alerts ?? [];
  const scheduledDeparture = formatScheduledDeparture(
    data.requested_departure_datetime || data.departure_datetime
  );
  const hasGoStep = steps.some(step => step?.agency === "go");
  const navigationOffRouteThreshold = Math.max(
    70,
    Number(navigationAccuracy || 0) * 2
  );
  const navigationOffRoute =
    navigationActive &&
    navigationInfo?.off_route_m > navigationOffRouteThreshold;

  return (
    <div className="map-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4">
      <div
        className={`mb-3 rounded-xl border px-3 py-2.5 text-xs ${
          error
            ? "border-red-300 bg-red-50 text-red-700"
            : darkMode
              ? "border-button bg-charcoal-light text-darkmode-gray"
              : "border-button-light bg-white text-button-darkest"
        }`}
      >
        {status}
      </div>

      {navigationActive && mode !== "transit" && (
        <div
          className={`mb-3 rounded-2xl border p-3.5 ${
            navigationOffRoute
              ? "border-amber-400 bg-amber-50 text-amber-950"
              : darkMode
                ? "border-blue/50 bg-blue/10 text-darkmode-gray"
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
            {navigationInfo?.next_step
              ? directionText(navigationInfo.next_step)
              : "Following route…"}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs opacity-80">
            {Number.isFinite(navigationInfo?.distance_to_next_m) && (
              <span>{formatDistance(navigationInfo.distance_to_next_m)} to turn</span>
            )}
            {Number.isFinite(navigationInfo?.remaining_m) && (
              <span>• {formatDistance(navigationInfo.remaining_m)} remaining</span>
            )}
            {Number.isFinite(Number(navigationAccuracy)) && (
              <span>• GPS ±{Math.round(Number(navigationAccuracy))} m</span>
            )}
            {Number.isFinite(Number(navigationSpeedMps)) && navigationSpeedMps > 0.3 && (
              <span>• {Math.round(navigationSpeedMps * 3.6)} km/h</span>
            )}
          </div>

          {navigationOffRoute && (
            <div className="mt-2 text-xs font-semibold">
              About {Math.round(navigationInfo.off_route_m)} m from the route. MAP will reroute automatically after repeated GPS fixes.
            </div>
          )}
        </div>
      )}

      {scheduledDeparture && (
        <div
          className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold ${
            darkMode
              ? "border-green/40 bg-green/10 text-green-light"
              : "border-green/30 bg-green/10 text-green-dark"
          }`}
        >
          <MdCalendarMonth className="text-base" />
          Departing {scheduledDeparture}
        </div>
      )}

      {mode === "transit" && realtime && (
        <div
          className={`mb-3 rounded-xl border px-3 py-2 text-xs font-semibold ${
            realtime.available
              ? "border-green/40 bg-green/10 text-green-dark"
              : darkMode
                ? "border-button bg-charcoal-light text-darkmode-gray"
                : "border-button-light bg-white text-button-darkest"
          }`}
        >
          {realtime.available
            ? `Live ${
                realtime.live_sources?.length
                  ? realtime.live_sources.join(" + ")
                  : "transit"
              } connected${
                realtime.grt_connected && realtime.feed_age_seconds != null
                  ? ` • GRT ${realtime.feed_age_seconds}s old`
                  : ""
              }${realtime.used_live_updates ? " • live prediction used" : ""}`
            : realtime.suppressed_for_scheduled_trip
              ? "Future trip — using the scheduled timetable until closer to departure"
              : "Realtime unavailable — using scheduled transit data"}
        </div>
      )}

      {mode === "transit" && hasGoStep && realtime?.go_configured === false && (
        <div
          className={`mb-3 rounded-xl border px-3 py-2 text-xs ${
            darkMode
              ? "border-button bg-charcoal-light text-darkmode-gray"
              : "border-button-light bg-white text-button-darkest"
          }`}
        >
          GO routing is working from the timetable. Add a server-side
          <span className="font-mono font-semibold"> METROLINX_API_KEY </span>
          to enable live GO delays, vehicles, alerts, and station departure boards.
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

      <div className="space-y-2">
        {data.routes.map(route => {
          const selected = route.route_number === activeRoute.route_number;
          const labels = [];
          const transitLegs = (route.steps || [])
            .filter(step => step?.type === "transit")
            .map(step => String(step.route || step.vehicle || "Transit"));
          const transitSummary = transitLegs.filter(
            (value, index) => index === 0 || transitLegs[index - 1] !== value
          );

          if (
            data.routes.length > 1 &&
            route.route_number === data.fastest_route_number
          ) {
            labels.push("FASTEST");
          }

          if (
            data.routes.length > 1 &&
            route.route_number === data.shortest_route_number
          ) {
            labels.push("SHORTEST");
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
                  ? "border-green bg-green/10 shadow-sm"
                  : darkMode
                    ? "border-button bg-charcoal-light hover:border-green hover:bg-green/10"
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
                    {formatDuration(route.duration_min)}
                  </div>

                  <div
                    className={`mt-1 flex flex-wrap items-center gap-x-2 text-xs ${
                      darkMode ? "text-darkmode-gray" : "text-button-darkest"
                    }`}
                  >
                    <ModeIcon />
                    <span>{modeInfo.name}</span>
                    <span>•</span>
                    <span>{Number(route.distance_km || 0).toFixed(2)} km</span>
                  </div>

                  {mode === "transit" && transitSummary.length > 0 && (
                    <div
                      className={`mt-1 line-clamp-1 text-xs font-semibold ${
                        darkMode ? "text-blue-light" : "text-green-dark"
                      }`}
                    >
                      {transitSummary.join(" → ")}
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
                  <div className="text-right text-[10px] font-bold tracking-wide text-green">
                    {labels.join(" • ")}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="my-4 border-t border-button-light/60" />

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2
          className={`text-base font-bold ${
            darkMode ? "text-darkmode-gray" : "text-charcoal"
          }`}
        >
          Directions
        </h2>

        <div className="flex items-center gap-2">
          <span
            className={`text-xs ${
              darkMode ? "text-darkmode-gray" : "text-button-darkest"
            }`}
          >
            {steps.length} {steps.length === 1 ? "step" : "steps"}
          </span>
          {mode !== "transit" && (
            <button
              type="button"
              onClick={navigationActive ? onStopNavigation : onStartNavigation}
              title={navigationActive ? "Stop navigation" : "Start navigation"}
              aria-label={navigationActive ? "Stop navigation" : "Start navigation"}
              className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition ${
                navigationActive
                  ? "border-green bg-green text-white"
                  : darkMode
                    ? "border-button bg-charcoal-light text-blue-light hover:border-blue hover:bg-blue/15"
                    : "border-button-light bg-white text-green-dark hover:border-green hover:bg-green/10"
              }`}
            >
              <MdNavigation />
              {navigationActive ? "Stop" : "Navigate"}
            </button>
          )}
          <button
            type="button"
            onClick={onShareRoute}
            title="Copy shareable route link"
            aria-label="Copy shareable route link"
            className={`flex size-8 items-center justify-center rounded-lg border text-sm transition ${
              darkMode
                ? "border-button bg-charcoal-light text-blue-light hover:border-blue hover:bg-blue/15"
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
              ? "border-button bg-charcoal-light text-darkmode-gray"
              : "border-button-light bg-white text-button-darkest"
          }`}
        >
          No directions were returned for this route.
        </div>
      ) : (
        <div
          className={`overflow-hidden rounded-xl border ${
            darkMode
              ? "border-button bg-charcoal-light"
              : "border-button-light bg-white"
          }`}
        >
          {steps.map((step, index) => {
            const canFocus =
              Array.isArray(step?.coordinates) && step.coordinates.length >= 2;

            return (
              <button
                type="button"
                key={`${step.type || "step"}-${index}`}
                onClick={() => canFocus && onStepSelect(step, index)}
                disabled={!canFocus}
                title={canFocus ? "Show this step on the map" : undefined}
                className={`flex w-full gap-3 border-b p-3 text-left last:border-b-0 ${
                  darkMode ? "border-button/50" : "border-button-light/60"
                } ${
                  canFocus
                    ? darkMode
                      ? "transition hover:bg-blue/10"
                      : "transition hover:bg-green/10"
                    : "cursor-default"
                }`}
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green text-white">
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
            );
          })}
        </div>
      )}
    </div>
  );
}
