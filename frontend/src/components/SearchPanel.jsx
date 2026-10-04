import { useEffect, useRef, useState } from "react";
import { BsPersonWalking } from "react-icons/bs";
import { GoDot } from "react-icons/go";
import { HiArrowsUpDown } from "react-icons/hi2";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { MdDirectionsTransit } from "react-icons/md";
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

function LocationInput({
  value,
  onChange,
  onSearch,
  placeholder,
  icon,
  disabled,
  darkMode,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const suppressNextLookup = useRef(false);

  useEffect(() => {
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
  }, [value]);

  function chooseSuggestion(item) {
    suppressNextLookup.current = true;
    onChange(item.label);
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
        className={`h-14 min-w-0 flex-1 rounded-xl border-2 border-green-light px-4 text-lg outline-none transition-all duration-200 ease-out focus:border-green focus:ring-2 focus:ring-green/20 disabled:opacity-60 ${
          darkMode
            ? "bg-charcoal-light text-darkmode-gray placeholder:text-darkmode-gray/60"
            : "bg-white text-black"
        }`}
      />

      {open && suggestions.length > 0 && (
        <div
          className={`absolute left-9 right-0 top-[60px] z-[2000] max-h-72 overflow-y-auto rounded-xl border border-button-light shadow-xl ${
            darkMode ? "bg-charcoal" : "bg-white"
          }`}
        >
          {suggestions.map((item, index) => (
            <button
              type="button"
              key={`${item.label}-${index}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => chooseSuggestion(item)}
              className={`flex w-full items-start gap-3 border-b border-button-light/30 px-3 py-3 text-left text-sm last:border-b-0 ${
                index === activeIndex ? "bg-green/20" : "hover:bg-green/10"
              }`}
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
  onSearch,
  onSwap,
  loading,
  darkMode,
}) {
  return (
    <div className="px-8 pb-6">
      <div className="space-y-4">
        <LocationInput
          value={start}
          onChange={setStart}
          onSearch={onSearch}
          placeholder="Starting location"
          disabled={loading}
          darkMode={darkMode}
          icon={
            <GoDot
              className={`text-xl ${
                darkMode ? "text-green-light" : "text-charcoal"
              }`}
            />
          }
        />

        <LocationInput
          value={destination}
          onChange={setDestination}
          onSearch={onSearch}
          placeholder="Destination"
          disabled={loading}
          darkMode={darkMode}
          icon={
            <PiMapPinFill
              className={`text-xl ${
                darkMode ? "text-green-light" : "text-green"
              }`}
            />
          }
        />
      </div>

      <div className="mt-3 pl-9">
        <button
          type="button"
          disabled={loading}
          onClick={onSwap}
          title="Swap locations"
          className={`flex h-10 w-10 items-center justify-center rounded-xl text-xl text-white transition hover:bg-green disabled:opacity-50 ${
            darkMode ? "bg-green-light/40" : "bg-green/40"
          }`}
        >
          <HiArrowsUpDown />
        </button>
      </div>

      <div className="mt-7 grid grid-cols-4 gap-3">
        {MODES.map(({ id, label, Icon }) => (
          <Button
            type="button"
            key={id}
            active={mode === id}
            disabled={loading}
            darkMode={darkMode}
            onClick={() => onModeChange(id)}
            title={label}
            className="h-12 px-2 active:bg-green-dark"
          >
            <Icon className="text-lg" />
          </Button>
        ))}
      </div>

      {mode === "cycling" && (
        <div className="soft-enter mt-3 grid grid-cols-4 gap-2">
          {BIKE_TYPES.map(option => (
            <button
              type="button"
              key={option.id}
              disabled={loading}
              onClick={() => onCyclingTypeChange(option.id)}
              className={`rounded-lg border px-2 py-2 text-center text-xs font-semibold transition-all duration-150 hover:-translate-y-px disabled:opacity-50 ${
                cyclingType === option.id
                  ? `border-green-dark bg-green/15 ${
                      darkMode ? "text-green-light" : "text-green-dark"
                    }`
                  : darkMode
                    ? "border-green-light bg-charcoal text-darkmode-gray hover:bg-green/10"
                    : "border-green-dark bg-white text-charcoal hover:bg-green/10"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      <Button
        type="button"
        disabled={loading}
        onClick={() => onSearch()}
        darkMode={darkMode}
        className="mt-6 h-12 w-full border-green bg-green shadow-lg active:scale-[0.99] active:bg-green-dark"
      >
        {loading ? "Finding route..." : "Find Route"}
      </Button>
    </div>
  );
}
