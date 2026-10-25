import { useEffect, useRef, useState } from "react";
import { BsPersonWalking } from "react-icons/bs";
import { GoDot } from "react-icons/go";
import { HiArrowsUpDown, HiChevronDown } from "react-icons/hi2";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import {
  MdDirectionsTransit,
  MdMyLocation,
} from "react-icons/md";
import { PiMapPinFill } from "react-icons/pi";

import Button from "./Button.jsx";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
                                                                  
const placeCache = new Map();
let mapTilerPauseUntil = 0;

// only use maptiler as extra results, cache them for a bit
async function extraPlaces(query, proximity, signal) {
  if (!MAPTILER_KEY || Date.now() < mapTilerPauseUntil) return [];
  const key = `${query.toLowerCase()}|${proximity.lat},${proximity.lon}`;
  const cached = placeCache.get(key);
  if (cached && cached.until > Date.now()) return cached.results;

  try {
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?` +
      new URLSearchParams({
        key: MAPTILER_KEY,
        autocomplete: "true",
        limit: "6",
        country: "ca",
        proximity: `${proximity.lon},${proximity.lat}`,
      });
    const response = await fetch(url, { signal });
    if ([401, 403, 429].includes(response.status)) {
                                                                                    
      mapTilerPauseUntil = Date.now() + (response.status === 429 ? 5 * 60_000 : 30 * 60_000);
      return [];
    }
    if (!response.ok) return [];
    const json = await response.json();
    const results = (json.features ?? []).map(feature => ({
      label: feature.place_name || feature.text || query,
      lat: Number(feature.center?.[1] ?? feature.geometry?.coordinates?.[1]),
      lon: Number(feature.center?.[0] ?? feature.geometry?.coordinates?.[0]),
      source: "maptiler",
      kind: feature.place_type?.[0],
    }));
    placeCache.set(key, { results, until: Date.now() + 10 * 60_000 });
    if (placeCache.size > 80) placeCache.delete(placeCache.keys().next().value);
    return results;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return [];
  }
}


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

const DEFAULT_BIAS = { lat: 43.46, lon: -80.52 };                      

// round nearby search locations so small map moves share cache entries
function roundedBias(bias) {
  if (!Array.isArray(bias)) {
    return null;
  }

  const lat = Number(bias[0]);
  const lon = Number(bias[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

                                                           
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

function sourceLabel(item) {
  if (item.source === "known") return "Known place";
  if (item.source === "local") return "Local address";
  if (item.source === "street") return "Street";
  return item.kind === "address" ? "Address" : "Place search";
}

                                                                               
                                                                                    
                                                                                  
                                                                                      
                                                             
function mergeSuggestions(serverResults, mapTilerResults, limit = 6) {
  const known = serverResults.filter(item => item.source === "known");
  const addresses = serverResults.filter(item => item.source === "local");
  const streets = serverResults.filter(item => item.source === "street");

  const prioritized = [
    ...known.slice(0, 2),
    ...addresses.slice(0, 4),
    ...mapTilerResults.slice(0, 3),
    ...streets.slice(0, 2),
    ...known.slice(2),
    ...addresses.slice(4),
    ...mapTilerResults.slice(3),
    ...streets.slice(2),
  ];

  const merged = [];
  const seenLabels = new Set();
  const addressPoints = [];

  for (const item of prioritized) {
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (!item?.label || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    const labelKey = item.label.trim().toLowerCase();
    if (seenLabels.has(labelKey)) {
      continue;
    }

    const addressLike = item.source === "local" || item.kind === "address";
    if (
      addressLike &&
      addressPoints.some(
        point =>
          Math.abs(point.lat - lat) < 0.0003 && Math.abs(point.lon - lon) < 0.0004
      )
    ) {
      continue;
    }

    seenLabels.add(labelKey);
    if (addressLike) {
      addressPoints.push({ lat, lon });
    }
    merged.push(item);

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

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
  mapStyle,
  darkMode,
  endAction = null,
  skipLookup = false,
  bias = null,
  onSelectLocation = () => {},
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const suppressNextLookup = useRef(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const moreController = useRef(null);


                                                                                  
                                                                                     
                                                                          
  const biasRef = useRef(null);
  useEffect(() => {
    biasRef.current = roundedBias(bias);
  });

  useEffect(() => {
    if (skipLookup) {
      return;
    }

    if (suppressNextLookup.current) {
      suppressNextLookup.current = false;
      return;
    }

    const query = value.trim();
                                                                    
    const coordMatch = query.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (query.length < 2 || (coordMatch &&
      Math.abs(Number(coordMatch[1])) <= 90 &&
      Math.abs(Number(coordMatch[2])) <= 180)) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const proximity = biasRef.current ?? DEFAULT_BIAS;
      const biasParams = biasRef.current
        ? `&lat=${biasRef.current.lat}&lon=${biasRef.current.lon}` : "";
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=8${biasParams}`,
          { signal: controller.signal }
        );
        const json = response.ok ? await response.json() : null;
        const local = json?.success ? json.results ?? [] : [];

                                                                  
                                                                       
        const external = local.length < 3
          ? await extraPlaces(query, proximity, controller.signal)
          : [];
        if (controller.signal.aborted) return;
        const merged = mergeSuggestions(local, external);
        setSuggestions(merged);
        setOpen(merged.length > 0 || Boolean(MAPTILER_KEY));
        setActiveIndex(-1);
      } catch (lookupError) {
        if (lookupError.name !== "AbortError") {
          setSuggestions([]);
          setOpen(Boolean(MAPTILER_KEY));
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, skipLookup]);

  async function findMorePlaces() {
    const query = value.trim();
    if (!MAPTILER_KEY || query.length < 2 || moreLoading) return;
    moreController.current?.abort();
    const controller = new AbortController();
    moreController.current = controller;
    setMoreLoading(true);
    try {
      const places = await extraPlaces(query, biasRef.current ?? DEFAULT_BIAS, controller.signal);
      if (!controller.signal.aborted) {
        setSuggestions(current => mergeSuggestions(current, places));
        setOpen(true);
      }
    } catch (error) {
      if (error.name !== "AbortError") console.warn("Place lookup failed", error);
    } finally {
      if (moreController.current === controller) setMoreLoading(false);
    }
  }

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
          moreController.current?.abort();
          setMoreLoading(false);
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
            ? mapStyle === "hybrid"
              ? "border-button bg-hybrid-charcoal-light text-darkmode-gray placeholder:text-darkmode-gray/55 focus:border-hybrid-purple focus:ring-hybrid-purple/15"
              : mapStyle === "satellite"
                ? "border-button bg-charcoal-light text-darkmode-gray placeholder:text-darkmode-gray/55 focus:border-green focus:ring-green/15"
                : "border-button bg-charcoal-light text-darkmode-gray placeholder:text-darkmode-gray/55 focus:border-blue focus:ring-blue/15"
            : "border-button-light bg-white text-charcoal focus:border-green focus:ring-green/15"
        }`}
      />

      {endAction && (
        <div className="absolute right-2 top-1/2 z-10 -translate-y-1/2">
          {endAction}
        </div>
      )}

      {!skipLookup && open && (suggestions.length > 0 || MAPTILER_KEY) && (
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
                  {sourceLabel(item)}
                </span>
              </span>
            </button>
          ))}
          {MAPTILER_KEY && (
            <button
              type="button"
              onMouseDown={event => event.preventDefault()}
              onClick={findMorePlaces}
              disabled={moreLoading}
              className={`w-full px-3 py-2.5 text-left text-xs font-semibold transition disabled:opacity-60 ${
                darkMode ? "text-darkmode-gray hover:bg-white/10" : "text-green-dark hover:bg-green/10"
              }`}
            >
              {moreLoading ? "Searching more places…" : "Search more places"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchPanel({
  start,
  destination,
  recentSearches,
  setStart,
  setDestination,
  mode,
  cyclingType,
  onModeChange,
  onCyclingTypeChange,
  onSearch,
  onSwap,
  loading,
  darkMode,
  mapStyle,
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
  startBias = null,
  destinationBias = null,
  addressIssue = null,
  onPickAddressOption = () => {},
}) {

  const fieldClass = `h-10 min-w-0 rounded-lg border px-2.5 text-xs outline-none transition ${
    darkMode
      ? mapStyle === "hybrid"
        ? "border-button bg-hybrid-charcoal-light/10 focus:border-hybrid-purple text-darkmode-gray"
        : "border-button bg-charcoal-light focus:border-blue text-darkmode-gray"
      : "border-button-light focus:border-green bg-white text-charcoal"
  }`;

  return (
    <div className="px-6 pb-5 max-[760px]:px-4 max-[760px]:pb-3">
      <div className="space-y-3 max-[760px]:space-y-2">
        <LocationInput
          key={usingCurrentLocation ? "current-location" : "typed-start"}
          value={start}
          mapStyle={mapStyle}
          onChange={setStart}
          onSearch={onSearch}
          placeholder="Starting location"
          disabled={loading}
          darkMode={darkMode}
          skipLookup={usingCurrentLocation}
          bias={startBias}
          onSelectLocation={onStartCoordinate}
          icon={
            <GoDot
              className={`text-xl ${
                darkMode 
                  ? mapStyle === "hybrid" 
                    ? "text-hybrid-purple-light" 
                    : mapStyle === "satellite"
                      ? "text-green"
                      : "text-blue-light" 
                    : "text-green"
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
                    ? mapStyle === "hybrid"
                      ? "border-hybrid-purple bg-hybrid-purple text-white"
                      : mapStyle === "satellite"
                        ? "border-green-dark bg-green-dark text-white"
                        : "border-blue bg-blue text-white" 
                    : "border-green bg-green text-white"
                  : darkMode
                    ? mapStyle === "hybrid"
                      ? "border-button bg-hybrid-charcoal text-hybrid-purple-light hover:border-hybrid-purple hover:bg-hybrid-purple/15"
                      : mapStyle === "satellite"
                        ? "border-button bg-charcoal text-green hover:border-green hover:bg-green/15"
                        : "border-button bg-charcoal text-blue-light hover:border-blue hover:bg-blue/15"
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
          mapStyle={mapStyle}
          placeholder="Destination"
          disabled={loading}
          darkMode={darkMode}
          bias={destinationBias}
          onSelectLocation={onDestinationCoordinate}
          icon={
            <PiMapPinFill
              className={`text-xl ${
                darkMode 
                  ? mapStyle === "hybrid" 
                    ? "text-hybrid-purple-light" 
                    : mapStyle === "satellite"
                      ? "text-green"
                      : "text-blue-light" 
                    : "text-green"
              }`}
            />
          }
        />
      </div>

      {addressIssue?.options?.length > 0 && (
        <div
          role="alert"
          className={`soft-enter mt-3 rounded-xl border p-3 ${
            darkMode
              ? "border-button bg-charcoal-light"
              : "border-button-light bg-white"
          }`}
        >
          <p
            className={`text-xs font-semibold ${
              darkMode ? "text-darkmode-gray" : "text-charcoal"
            }`}
          >
            {addressIssue.kind === "mismatch"
              ? "That street type doesn't exist there. Did you mean:"
              : `Which ${
                  addressIssue.field === "start" ? "starting point" : "destination"
                } did you mean?`}
          </p>

          <div className="mt-2 space-y-1.5">
            {addressIssue.options.map(option => (
              <button
                type="button"
                key={`${option.label}-${option.lat}-${option.lon}`}
                disabled={loading}
                onClick={() => onPickAddressOption(addressIssue, option)}
                className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
                  darkMode
                    ? "border-button/60 text-darkmode-gray hover:bg-green/15"
                    : "border-button-light text-charcoal hover:bg-green/10"
                }`}
              >
                <PiMapPinFill className="mt-0.5 shrink-0 text-green" />
                <span className="min-w-0 flex-1">{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* recent searches bois */}
      {recentSearches.length > 0 && (
        <div>
          <p>Recent Searches</p>

          {recentSearches.map((search, index) => (
            <div>
              <p>{search.start}</p>
              <p>{search.mode}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className={`text-[10px] whitespace-pre-line ${
            darkMode ? "text-darkmode-gray/70" : "text-button-darkest"
          }`}
        >
          Tip: right-click to set your start or destination.
        </span>

        <button
          type="button"
          onClick={onSwap}
          title="Swap locations"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base transition hover:text-white disabled:opacity-50 ${
            darkMode
              ? mapStyle === "hybrid"
                ? "bg-hybrid-charcoal-light hover:bg-hybrid-purple text-darkmode-gray"
                : mapStyle === "satellite"
                  ? "bg-charcoal-light hover:bg-green text-darkmode-gray"
                  : "bg-charcoal-light hover:bg-blue text-darkmode-gray"
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
            mapStyle={mapStyle}
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
              mapStyle={mapStyle}
              onClick={() => onCyclingTypeChange(option.id)}
              className={`rounded-lg border px-2 py-1.5 text-center text-[11px] font-semibold transition disabled:opacity-50 ${
                cyclingType === option.id
                  ? darkMode
                    ? mapStyle === "hybrid"
                      ? "border-hybrid-purple bg-hybrid-purple/15 text-hybrid-purple-light active:bg-hybrid-purple/25"
                      : mapStyle === "satellite"
                        ? "border-green bg-green/15 text-green-light active:bg-green/25"
                        : "border-blue bg-blue/15 text-blue-light active:bg-blue/25"
                    : "border-green bg-green/15 text-green active:bg-green/25"
                  : darkMode
                    ? mapStyle === "hybrid"
                      ? "border-button bg-hybrid-charcoal-light text-darkmode-gray hover:bg-hybrid-purple/10 hover:border-hybrid-purple/50 hover:text-hybrid-purple active:bg-hybrid-purple/20"
                      : mapStyle === "satellite"
                        ? "border-button bg-charcoal-light text-darkmode-gray hover:bg-green/10 hover:border-green/50 hover:text-green active:bg-green/20"
                        : "border-button bg-charcoal-light text-darkmode-gray hover:bg-blue/10 hover:border-blue/50 hover:text-blue active:bg-blue/20"
                    : "border-button-light bg-white text-charcoal hover:bg-green/10 active:bg-green/20"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {mode === "transit" && (
        <div className={`mt-3 rounded-xl border p-3 ${
          darkMode
            ? mapStyle === "hybrid"
              ? "border-hybrid-charcoal-light bg-hybrid-charcoal"
              : "border-button bg-charcoal-light"
            : "border-button-light bg-white"
        }`}>
          <label htmlFor="transit-time"
            className={`mb-2 block text-xs font-semibold ${
              darkMode ? "text-darkmode-gray" : "text-charcoal"
            }`}>
            Departure time
          </label>
          <div className="relative">
            <select
              id="transit-time"
              value={timingMode}
              onChange={event => onTimingModeChange(event.target.value)}
              className={`w-full appearance-none rounded-lg border px-3 py-2.5 pr-10 text-sm font-medium outline-none transition focus:ring-2 ${
                darkMode
                  ? mapStyle === "hybrid"
                    ? "border-hybrid-charcoal-light bg-hybrid-charcoal-light text-darkmode-gray focus:border-hybrid-purple focus:ring-hybrid-purple/20"
                    : mapStyle === "street"
                      ? "border-button bg-charcoal text-darkmode-gray focus:border-blue focus:ring-blue/20"
                      : "border-button bg-charcoal text-darkmode-gray focus:border-green focus:ring-green/20"
                  : "border-button-light bg-white text-charcoal focus:border-green focus:ring-green/20"
              }`}
            >
              <option value="now">Leave now</option>
              <option value="scheduled">Depart at</option>
              <option value="arrive_by">Arrive by</option>
            </select>
            <HiChevronDown aria-hidden="true"
              className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 ${
                darkMode ? "text-darkmode-gray" : "text-charcoal"
              }`} />
          </div>
          {timingMode !== "now" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input type="date" value={departureDate} min={todayInputValue()}
                disabled={loading} onChange={event => onDepartureDateChange(event.target.value)}
                className={fieldClass} aria-label="Journey date" />
              <input type="time" value={departureTime} disabled={loading}
                onChange={event => onDepartureTimeChange(event.target.value)}
                className={fieldClass} aria-label="Journey time" />
            </div>
          )}
        </div>
      )}

      <Button
        type="button"
        disabled={loading}
        onClick={() => onSearch()}
        darkMode={darkMode}
        mapStyle={mapStyle}
        className={`mt-4 h-11 w-full shadow-md active:scale-[0.99] 
        ${darkMode 
          ? mapStyle === "hybrid" ? "border-hybrid-charcoal bg-hybrid-charcoal-dark active:bg-hybrid-purple-dark/50" : "border-blue bg-blue active:bg-blue-dark" : "border-green bg-green active:bg-green-dark"
        }`}>
        {loading
          ? "Finding route..."
          : mode === "transit" && timingMode === "scheduled"
            ? "Find Scheduled Route"
            : mode === "transit" && timingMode === "arrive_by"
              ? "Find Arrival Route"
              : "Find Route"}
      </Button>
    </div>
  );
}