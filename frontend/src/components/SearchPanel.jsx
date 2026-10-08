import { useEffect, useRef, useState } from "react";
import { BsPersonWalking } from "react-icons/bs";
import { GoDot } from "react-icons/go";
import { HiArrowsUpDown } from "react-icons/hi2";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import {
  MdAccessTime,
  MdCalendarMonth,
  MdDirectionsTransit,
  MdMyLocation,
} from "react-icons/md";
import { PiMapPinFill } from "react-icons/pi";

import Button from "./Button.jsx";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

const MODES = [
  { id: "driving", label: "Drive", Icon: IoCarOutline },
  { id: "walking", label: "Walk", Icon: BsPersonWalking },
  { id: "cycling", label: "Bike", Icon: IoMdBicycle },
  { id: "transit", label: "Transit", Icon: MdDirectionsTransit },
];

const BIKE_TYPES = [
  { id: "regular", label: "Regular" },
  { id: "road", label: "Road" },
  { id: "mountain", label: "MTB" },
  { id: "electric", label: "E-Bike" },
];

const TRANSIT_PREFERENCES = [
  { id: "balanced", label: "Balanced" },
  { id: "less_walking", label: "Less walk" },
  { id: "fastest", label: "Fastest" },
];

function todayInputValue() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function LocationInput({
  value,
  onChange,
  onSearch,
  placeholder,
  icon,
  disabled,
  darkMode,
  endAction = null,
  skipLookup = false,
  onSelectLocation = () => {},
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const suppressNextLookup = useRef(false);

  useEffect(() => {
    if (skipLookup) {
      return;
    }

    if (suppressNextLookup.current) {
      suppressNextLookup.current = false;
      return;
    }

    const query = value.trim();
    if (query.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const localPromise = fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=6`,
          { signal: controller.signal }
        )
          .then(response => response.json())
          .then(result => (result?.success ? result.results ?? [] : []))
          .catch(() => []);

        const mapTilerPromise = MAPTILER_KEY
          ? fetch(
              `https://api.maptiler.com/geocoding/${encodeURIComponent(
                query
              )}.json?key=${encodeURIComponent(
                MAPTILER_KEY
              )}&autocomplete=true&limit=6&country=ca&proximity=-80.52,43.46`,
              { signal: controller.signal }
            )
              .then(response =>
                response.ok ? response.json() : { features: [] }
              )
              .then(result =>
                (result.features ?? []).map(feature => ({
                  label: feature.place_name || feature.text || query,
                  lat: Number(
                    feature.center?.[1] ?? feature.geometry?.coordinates?.[1]
                  ),
                  lon: Number(
                    feature.center?.[0] ?? feature.geometry?.coordinates?.[0]
                  ),
                  source: "maptiler",
                }))
              )
              .catch(() => [])
          : Promise.resolve([]);

        const [localResults, mapTilerResults] = await Promise.all([
          localPromise,
          mapTilerPromise,
        ]);

        const merged = [];
        const seen = new Set();

        for (const item of [...localResults, ...mapTilerResults]) {
          if (
            !item?.label ||
            !Number.isFinite(Number(item.lat)) ||
            !Number.isFinite(Number(item.lon))
          ) {
            continue;
          }

          const key = item.label.trim().toLowerCase();
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          merged.push(item);

          if (merged.length >= 6) {
            break;
          }
        }

        setSuggestions(merged);
        setOpen(merged.length > 0);
        setActiveIndex(-1);
      } catch (lookupError) {
        if (lookupError.name !== "AbortError") {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, skipLookup]);

  function chooseSuggestion(item) {
    suppressNextLookup.current = true;
    onChange(item.label);
    onSelectLocation([Number(item.lat), Number(item.lon)], item.label);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);

    fetch("/api/remember-place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: item.label,
        lat: item.lat,
        lon: item.lon,
      }),
    }).catch(() => {});
  }

  function handleKeyDown(event) {
    if (open && suggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex(index => Math.min(index + 1, suggestions.length - 1));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(index => Math.max(index - 1, 0));
        return;
      }

      if (event.key === "Escape") {
        setOpen(false);
        return;
      }

      if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        chooseSuggestion(suggestions[activeIndex]);
        return;
      }
    }

    if (event.key === "Enter") {
      setOpen(false);
      onSearch();
    }
  }

  return (
    <div className="relative flex items-center gap-3">
      <div className="flex w-6 shrink-0 justify-center">{icon}</div>

      <input
        value={value}
        disabled={disabled}
        onChange={event => {
          const nextValue = event.target.value;
          onChange(nextValue);

          if (nextValue.trim().length < 2) {
            setSuggestions([]);
            setOpen(false);
            setActiveIndex(-1);
          }
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        autoComplete="off"
        className={`h-12 min-w-0 flex-1 rounded-xl border px-4 text-[15px] outline-none transition focus:ring-2 disabled:opacity-60 ${
          endAction ? "pr-12" : ""
        } ${
          darkMode
            ? "border-button bg-charcoal-light text-darkmode-gray placeholder:text-darkmode-gray/55 focus:border-blue focus:ring-blue/15"
            : "border-button-light bg-white text-charcoal focus:border-green focus:ring-green/15"
        }`}
      />

      {endAction && (
        <div className="absolute right-2 top-1/2 z-10 -translate-y-1/2">
          {endAction}
        </div>
      )}

      {!skipLookup && open && suggestions.length > 0 && (
        <div
          className={`map-scrollbar absolute left-9 right-0 top-[52px] z-[2000] max-h-72 overflow-y-auto rounded-xl border shadow-xl ${
            darkMode
              ? "border-button bg-charcoal"
              : "border-button-light bg-white"
          }`}
        >
          {suggestions.map((item, index) => (
            <button
              type="button"
              key={`${item.label}-${index}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => chooseSuggestion(item)}
              className={`flex w-full items-start gap-3 border-b px-3 py-3 text-left text-sm last:border-b-0 ${
                darkMode ? "border-button/40" : "border-button-light/50"
              } ${index === activeIndex ? "bg-green/20" : "hover:bg-green/10"}`}
            >
              <PiMapPinFill className="mt-0.5 shrink-0 text-green" />

              <span className="min-w-0 flex-1">
                <span
                  className={`block line-clamp-2 ${
                    darkMode ? "text-darkmode-gray" : "text-charcoal"
                  }`}
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-button">
                  {item.source === "local" ? "Local address" : "Place search"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SearchPanel({
  start,
  destination,
  setStart,
  setDestination,
  mode,
  cyclingType,
  onModeChange,
  onCyclingTypeChange,
  transitPreference,
  onTransitPreferenceChange,
  onSearch,
  onSwap,
  loading,
  darkMode,
  timingMode,
  onTimingModeChange,
  departureDate,
  departureTime,
  onDepartureDateChange,
  onDepartureTimeChange,
  usingCurrentLocation,
  onUseCurrentLocation,
  onStartCoordinate = () => {},
  onDestinationCoordinate = () => {},
}) {
  const fieldClass = `h-10 min-w-0 rounded-lg border px-2.5 text-xs outline-none transition ${
    darkMode
      ? "border-button bg-charcoal-light focus:border-blue text-darkmode-gray"
      : "border-button-light focus:border-green bg-white text-charcoal"
  }`;

  return (
    <div className="px-6 pb-5">
      <div className="space-y-3">
        <LocationInput
          key={usingCurrentLocation ? "current-location" : "typed-start"}
          value={start}
          onChange={setStart}
          onSearch={onSearch}
          placeholder="Starting location"
          disabled={loading}
          darkMode={darkMode}
          skipLookup={usingCurrentLocation}
          onSelectLocation={onStartCoordinate}
          icon={
            <GoDot
              className={`text-xl ${
                darkMode ? "text-blue-light" : "text-charcoal"
              }`}
            />
          }
          endAction={
            <button
              type="button"
              disabled={loading}
              onClick={onUseCurrentLocation}
              title="Use current location as start"
              aria-label="Use current location as start"
              className={`flex size-8 items-center justify-center rounded-lg border text-base transition disabled:opacity-50 ${
                usingCurrentLocation
                  ? darkMode
                    ? "border-blue bg-blue text-white" 
                    : "border-green bg-green text-white"
                  : darkMode
                    ? "border-button bg-charcoal text-blue-light hover:border-blue hover:bg-blue/15"
                    : "border-button-light bg-white text-green-dark hover:border-green hover:bg-green/10"
              }`}
            >
              <MdMyLocation />
            </button>
          }
        />

        <LocationInput
          value={destination}
          onChange={setDestination}
          onSearch={onSearch}
          placeholder="Destination"
          disabled={loading}
          darkMode={darkMode}
          onSelectLocation={onDestinationCoordinate}
          icon={
            <PiMapPinFill
              className={`text-xl ${
                darkMode ? "text-blue-light" : "text-green"
              }`}
            />
          }
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className={`text-[10px] ${
            darkMode ? "text-darkmode-gray/70" : "text-button-darkest"
          }`}
        >
          Tip: click the map to choose A or B.
        </span>

        <button
          type="button"
          disabled={loading}
          onClick={onSwap}
          title="Swap locations"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base transition hover:text-white disabled:opacity-50 ${
            darkMode
              ? "bg-charcoal-light hover:bg-blue text-darkmode-gray"
              : "bg-green/10 hover:bg-green text-green-dark"
          }`}
        >
          <HiArrowsUpDown />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2">
        {MODES.map(({ id, label, Icon }) => (
          <Button
            type="button"
            key={id}
            active={mode === id}
            disabled={loading}
            darkMode={darkMode}
            onClick={() => onModeChange(id)}
            title={label}
            className="h-10 px-2"
          >
            <Icon className="text-lg" />
          </Button>
        ))}
      </div>

      {mode === "cycling" && (
        <div className="soft-enter mt-2 grid grid-cols-4 gap-1.5">
          {BIKE_TYPES.map(option => (
            <button
              type="button"
              key={option.id}
              disabled={loading}
              onClick={() => onCyclingTypeChange(option.id)}
              className={`rounded-lg border px-2 py-1.5 text-center text-[11px] font-semibold transition disabled:opacity-50 ${
                cyclingType === option.id
                  ? darkMode
                    ? "border-blue bg-blue/15 text-blue-light active:bg-blue/25"
                    : "border-green bg-green/15 text-green active:bg-green/25"
                  : darkMode
                    ? "border-button bg-charcoal-light text-darkmode-gray hover:bg-blue/10 active:bg-blue/20"
                    : "border-button-light bg-white text-charcoal hover:bg-green/10 active:bg-green/20"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {mode === "transit" && (
        <div className="soft-enter mt-2">
          <div
            className={`mb-1.5 text-[10px] font-semibold uppercase tracking-wide ${
              darkMode ? "text-darkmode-gray" : "text-button-darkest"
            }`}
          >
            Transit preference
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {TRANSIT_PREFERENCES.map(option => (
              <button
                type="button"
                key={option.id}
                disabled={loading}
                onClick={() => onTransitPreferenceChange(option.id)}
                className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                  transitPreference === option.id
                    ? darkMode
                      ? "border-blue bg-blue/15 text-blue-light active:bg-blue/25"
                      : "border-green bg-green/15 text-green active:bg-green/25"
                    : darkMode
                      ? "border-button bg-charcoal-light text-darkmode-gray hover:bg-blue/10 active:bg-blue/20"
                      : "border-button-light bg-white text-charcoal hover:bg-green/10 active:bg-green/20"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === "transit" && (
      <div
          className={`mt-4 rounded-xl border p-2.5 ${
            darkMode
              ? "border-button bg-charcoal-light/60"
              : "border-button-light bg-green/5"
          }`}
        >
          <div className="grid grid-cols-2 gap-1 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => onTimingModeChange("now")}
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition ${
                timingMode === "now"
                  ? darkMode
                    ? "bg-blue text-white shadow-sm active:bg-blue-dark"
                    : "bg-green text-white shadow-sm active:bg-green-dark"
                  : darkMode
                    ? "text-darkmode-gray hover:bg-blue/10"
                    : "text-button-darkest hover:bg-white"
              }`}
            >
              <MdAccessTime />
              Leave now
            </button>
  
            <button
              type="button"
              onClick={() => onTimingModeChange("scheduled")}
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition ${
                timingMode === "scheduled"
                  ? darkMode
                    ? "bg-blue text-white shadow-sm active:bg-blue-dark"
                    : "bg-green text-white shadow-sm active:bg-green-dark"
                  : darkMode
                    ? "text-darkmode-gray hover:bg-blue/10"
                    : "text-button-darkest hover:bg-white"
              }`}
            >
              <MdCalendarMonth />
              Schedule
            </button>
          </div>
  
          {timingMode === "scheduled" && (
            <div className="soft-enter mt-2 grid grid-cols-2 gap-2">
              <input
                type="date"
                value={departureDate}
                min={todayInputValue()}
                disabled={loading}
                onChange={event => onDepartureDateChange(event.target.value)}
                className={fieldClass}
                aria-label="Departure date"
              />
  
              <input
                type="time"
                value={departureTime}
                disabled={loading}
                onChange={event => onDepartureTimeChange(event.target.value)}
                className={fieldClass}
                aria-label="Departure time"
              />
            </div>
          )}
        </div>
      )}

      <Button
        type="button"
        disabled={loading}
        onClick={() => onSearch()}
        darkMode={darkMode}
        className={`mt-4 h-11 w-full shadow-md active:scale-[0.99] ${darkMode? "border-blue bg-blue active:bg-blue-dark": "border-green bg-green active:bg-green-dark"}`}>
        {loading
          ? "Finding route..."
          : mode === "transit" && timingMode === "scheduled"
            ? "Find Scheduled Route"
            : "Find Route"}
      </Button>
    </div>
  );
}
