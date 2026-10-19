import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

const GL_SCRIPT = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
const GL_CSS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
const LEAFLET_GL_SCRIPT = "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.js";
const CREDITS = '<a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

let loading;

function addScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error(`Could not load ${url}`));
    };
    document.head.appendChild(script);
  });
}

// load the leaflet/maplibre bridge just once
function ready() {
  if (L.maplibreGL) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      if (!document.querySelector('link[data-kmaps-gl="true"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = GL_CSS;
        link.dataset.kmapsGl = "true";
        document.head.appendChild(link);
      }
                                                                    
      window.L = L;
      if (!window.maplibregl) await addScript(GL_SCRIPT);
      await addScript(LEAFLET_GL_SCRIPT);
      if (!L.maplibreGL) throw new Error("MapLibre Leaflet adapter unavailable");
    })().catch(error => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

export default function FreeMapLayer({ darkMode }) {
  const map = useMap();

  useEffect(() => {
    let active = true;
    let layer;
    let failures = 0;
    let freeCredits = true;
    map.attributionControl?.addAttribution(CREDITS);

    // if the vector style fails, use basic osm tiles instead
    const showBackup = () => {
      if (!active || layer instanceof L.TileLayer) return;
      if (layer) map.removeLayer(layer);
      if (freeCredits) {
        map.attributionControl?.removeAttribution(CREDITS);
        freeCredits = false;
      }
                                                                            
      layer = L.tileLayer(import.meta.env.VITE_BACKUP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 22,
        maxNativeZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      });
      layer.addTo(map);
    };

    ready().then(() => {
      if (!active) return;
      const style = darkMode ? "dark" : "liberty";
      const custom = darkMode
        ? import.meta.env.VITE_OPEN_MAP_DARK_STYLE
        : import.meta.env.VITE_OPEN_MAP_LIGHT_STYLE;
      try {
        layer = L.maplibreGL({
          style: custom || `https://tiles.openfreemap.org/styles/${style}`,
          pane: "tilePane",
        });
        layer.addTo(map);
        const gl = layer.getMaplibreMap();
        gl.on("styleimagemissing", event => {
          if ((event.id === " " || event.id === "transportation:road_") && !gl.hasImage(event.id)) {
            gl.addImage(event.id, { width: 1, height: 1, data: new Uint8Array(4) });
          }
        });
        gl.on("error", event => {
          if (!active) return;
          const message = String(event?.error?.message || event?.message || "");
                                                                             
                                                                    
          if (/AbortError|signal is aborted|aborted without reason|missing image|sprite/i.test(message)) return;
          failures += 1;
          if (failures >= 4) showBackup();
        });
      } catch {
        showBackup();
      }
    }).catch(showBackup);

    return () => {
      active = false;
      if (layer) map.removeLayer(layer);
      if (freeCredits) map.attributionControl?.removeAttribution(CREDITS);
    };
  }, [map, darkMode]);

  return null;
}
