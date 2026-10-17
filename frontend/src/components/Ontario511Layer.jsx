import { Fragment, useEffect, useState } from "react";
import { CircleMarker, Marker, Polyline, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";

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


function mapView(map) {
  const bounds = map.getBounds();
  return {
    zoom: map.getZoom(),
    bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
      .map(value => value.toFixed(5)).join(","),
  };
}

function Info({ item }) {
  return (
    <div className="max-w-[260px] text-sm leading-relaxed text-slate-900">
      <div className="font-semibold">{item.title}</div>
      {item.direction && <div className="text-xs text-slate-600">{item.direction}</div>}
      {item.closure && <div className="mt-1 font-semibold text-red-700">Full closure reported</div>}
      {item.details && <p className="my-1 whitespace-pre-line">{item.details}</p>}
      {item.lanes && <div className="text-xs">{item.lanes}</div>}
      {item.impact && <div className="text-xs">{item.impact}</div>}
      {item.images?.map((url, i) => (
        <a key={`${item.id}-view-${i}`} href={url} target="_blank" rel="noreferrer" className="mt-2 block text-blue-700 underline">
          {i === 0 && <img src={url} alt={`Highway camera: ${item.title}`} loading="lazy"
            className="mb-1 max-h-[160px] w-full rounded-md object-cover" />}
          Camera view {i + 1} <span aria-hidden="true">↗</span>
        </a>
      ))}
      <a href="https://511on.ca/" target="_blank" rel="noreferrer" className="mt-2 block text-[11px] text-blue-700 underline">
        Ontario 511 · Verify current conditions
      </a>
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

export default function Ontario511Layer({ enabled = [], onStatus = () => {} }) {
  const map = useMap();
  const [view, setView] = useState(() => mapView(map));

  // Panning should only trigger one request after the user has stopped moving.
  useMapEvents({
    moveend() { setView(mapView(map)); },
    zoomend() { setView(mapView(map)); },
  });

  return (
    <>
      {FEEDS.map(kind => (
        <SingleFeed key={kind} kind={kind} active={enabled.includes(kind)} view={view} onStatus={onStatus} />
      ))}
    </>
  );
}
