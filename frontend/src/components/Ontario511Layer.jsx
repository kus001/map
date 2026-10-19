import { Fragment, useEffect, useState } from "react";
import { CircleMarker, Marker, Polyline, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { TileLayer } from "react-leaflet";

const COLORS = {
  incidents: "#DC5349",
  construction: "#E89B3C",
  cameras: "#427FC7",
  winter: "#6D8CB6",
};
const MIN_ZOOM = { incidents: 9, construction: 9, cameras: 12, winter: 9 };
const FEEDS = Object.keys(COLORS);
const CAMERA_ICON = L.divIcon({
  className: "",
  html: '<div style="width:28px;height:28px;display:grid;place-items:center;background:#427FC7;border:2px solid white;border-radius:8px;box-shadow:0 2px 8px #0005;font-size:15px">📷</div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});


// bbox tells the backend which road reports we actually need
function mapView(map) {
  const bounds = map.getBounds();
  return {
    zoom: map.getZoom(),
    bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
      .map(value => value.toFixed(5)).join(","),
  };
}

// cycle camera shots, pause while someone is hovering
function CameraViews({ images, name }) {
  const [index, setIndex] = useState(0);
  const [failedUrl, setFailedUrl] = useState(null);
  const [paused, setPaused] = useState(false);
  const count = images.length;

  useEffect(() => {
    if (count < 2 || paused) return undefined;
    const timer = setInterval(() => setIndex(i => (i + 1) % count), 6500);
    return () => clearInterval(timer);
  }, [count, paused]);

  const current = images[index];
  if (!current) return <p className="mt-2 text-xs text-slate-600">Image unavailable</p>;

  const change = next => {
    setIndex((next + count) % count);
    setFailedUrl(null);
    setPaused(true);
  };

  return (
    <div className="mt-2 w-[260px] max-w-full" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="overflow-hidden rounded-lg bg-slate-100">
        {failedUrl !== current.url ? (
          <img
            key={current.url}
            src={current.url}
            alt={`${name}: ${current.label}`}
            loading="lazy"
            className="h-40 w-full object-contain"
            onError={() => setFailedUrl(current.url)}
          />
        ) : (
          <div className="flex h-40 items-center justify-center px-3 text-center text-xs text-slate-500">
            Image unavailable
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button type="button" onClick={() => change(index - 1)} disabled={count < 2}
          aria-label="Previous camera view"
          className="rounded-md border border-slate-200 px-2 py-1 text-slate-800 disabled:opacity-30">‹</button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-xs font-medium text-slate-800" title={current.label}>{current.label}</div>
          {count > 1 && <div className="text-[11px] text-slate-500">{index + 1} of {count}</div>}
        </div>
        <button type="button" onClick={() => change(index + 1)} disabled={count < 2}
          aria-label="Next camera view"
          className="rounded-md border border-slate-200 px-2 py-1 text-slate-800 disabled:opacity-30">›</button>
      </div>
    </div>
  );
}

function Info({ item }) {
  const report = item.kind === "construction" || item.kind === "incidents";
  return (
    <div className="max-w-[280px] text-sm leading-snug text-slate-900">
      <div className="font-semibold">{item.title}</div>
      {item.direction && <div className="mt-0.5 text-xs text-slate-600">{item.direction}</div>}
      {item.closure && <div className="mt-2 font-semibold text-red-700">Road closed</div>}
      {report ? (
        <>
          {item.summary && <p className="my-2 text-sm text-slate-800">{item.summary}</p>}
          {item.impact && item.impact !== item.summary && <p className="my-1 text-xs text-slate-700">{item.impact}</p>}
          {item.lanes && <p className="my-1 text-xs text-slate-600">{item.lanes}</p>}
          {item.details && (
            <details className="mt-2 border-t border-slate-200 pt-2 text-xs">
              <summary className="cursor-pointer select-none font-medium text-slate-700">Details</summary>
              <p className="mt-2 max-h-48 overflow-auto whitespace-pre-line break-words text-slate-600">{item.details}</p>
            </details>
          )}
        </>
      ) : item.kind !== "cameras" && item.details ? (
        <p className="my-2 whitespace-pre-line text-slate-700">{item.details}</p>
      ) : null}
      {item.kind === "cameras" && <CameraViews images={item.images || []} name={item.title} />}
    </div>
  );
}

function SingleFeed({ kind, active, view, onStatus }) {
  const [items, setItems] = useState([]);
  const [refresh, setRefresh] = useState(0);
  const visible = active && view.zoom >= MIN_ZOOM[kind];

  useEffect(() => {
    if (!visible) return undefined;
    const interval = setInterval(() => setRefresh(n => n + 1), 120000);
    return () => clearInterval(interval);
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ kind, bbox: view.bbox });
    fetch(`/api/layers/ontario511?${params}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Layer service returned ${response.status}`);
        return response.json();
      })
      .then(result => {
        if (controller.signal.aborted) return;
        setItems(result.items || []);
        onStatus(kind, result.enabled === false ? result.message : result.message || "");
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          onStatus(kind, "Unable to load Ontario 511 data right now.");
          console.warn("Ontario 511 layer:", error);
        }
      });
    return () => controller.abort();
  }, [visible, view.bbox, kind, onStatus, refresh]);

  if (!visible) return null;
  return items.map(item => (
    <Fragment key={`${kind}-${item.id}`}>
      {(item.lines || []).map((line, index) => (
        <Polyline
          key={`${item.id}-line-${index}`}
          positions={line}
          pathOptions={{ color: COLORS[kind], weight: kind === "winter" ? 5 : 4, opacity: 0.8 }}
        >
          <Popup><Info item={item} /></Popup>
        </Polyline>
      ))}
      {item.point && kind === "cameras" && (
        <Marker position={item.point} icon={CAMERA_ICON}>
          <Popup><Info item={item} /></Popup>
        </Marker>
      )}
      {item.point && kind !== "winter" && kind !== "cameras" && (
        <CircleMarker
          center={item.point} radius={8}
          pathOptions={{ color: "#fff", weight: 2, fillColor: COLORS[kind], fillOpacity: 0.96 }}>
          <Popup><Info item={item} /></Popup>
        </CircleMarker>
      )}
      {item.point && kind === "winter" && !(item.lines || []).length && (
        <CircleMarker center={item.point} radius={7}
          pathOptions={{ color: "white", weight: 2, fillColor: COLORS[kind], fillOpacity: 0.9 }}>
          <Popup><Info item={item} /></Popup>
        </CircleMarker>
      )}
    </Fragment>
  ));
}

function TrafficFlow({ active, onStatus, darkMode }) {
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    fetch("/api/layers/traffic/status", { signal: controller.signal })
      .then(r => r.json())
      .then(info => {
        if (controller.signal.aborted) return;
        setReady(Boolean(info.enabled));
        setBroken(false);
        onStatus("traffic", info.message || "");
      })
      .catch(() => {
        if (!controller.signal.aborted) onStatus("traffic", "Traffic flow is unavailable.");
      });
    return () => controller.abort();
  }, [active, onStatus]);

  useEffect(() => {
    if (!active || !ready || broken) return undefined;
    const timer = setInterval(() => setRevision(n => n + 1), 120000);
    return () => clearInterval(timer);
  }, [active, ready, broken]);

  if (!active || !ready || broken) return null;
  return <TileLayer
    key={`${darkMode ? "dark" : "light"}-${revision}`}
    url={`/api/layers/traffic/tile/{z}/{x}/{y}.png?style=${darkMode ? "dark" : "light"}`}
    minZoom={8} maxZoom={22} maxNativeZoom={20}
    opacity={0.86} zIndex={650} keepBuffer={1}
    attribution="Traffic flow © TomTom"
    eventHandlers={{ tileerror: () => {
      setBroken(true);
      onStatus("traffic", "Traffic flow tiles are unavailable right now.");
    } }}
  />;
}

export default function Ontario511Layer({ enabled = [], onStatus = () => {}, darkMode = false }) {
  const map = useMap();
  const [view, setView] = useState(() => mapView(map));

  const has511 = FEEDS.some(kind => enabled.includes(kind));
  useEffect(() => {
    if (!has511 || !map.attributionControl) return undefined;
    map.attributionControl.addAttribution('Data: Ontario 511');
    return () => map.attributionControl.removeAttribution('Data: Ontario 511');
  }, [map, has511]);

                                                                               
  useMapEvents({
    moveend() { setView(mapView(map)); },
    zoomend() { setView(mapView(map)); },
  });

  return (
    <>
      <TrafficFlow active={enabled.includes("traffic")} onStatus={onStatus} darkMode={darkMode} />
      {FEEDS.map(kind => (
        <SingleFeed key={kind} kind={kind} active={enabled.includes(kind)} view={view} onStatus={onStatus} />
      ))}
    </>
  );
}
