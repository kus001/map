import { useEffect, useRef, useState } from "react";
import { StopBoard } from "./MapView.jsx";
import { Info as Ontario511Info } from "./Ontario511Layer.jsx";

// Production Cesium 3D scene. Building positions are not shifted to match imagery.
// CesiumJS itself is Apache-2.0/free; Cesium ion OSM data requires a scoped ion token.
// Toronto 2025 is loaded only as real hosted 3D Tiles or I3S, never synthesized footprints.
const CESIUM_VERSION = "1.146";
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;
const ESRI_MAPSERVER = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_IMAGERY = `${ESRI_MAPSERVER}/tile/{z}/{y}/{x}`;
const TORONTO = [-79.3832, 43.6525];
const TORONTO_BOUNDS = { west: -79.64, south: 43.58, east: -79.10, north: 43.86 };
const COLORS = { driving: "#70a9f2", walking: "#e5f4ea", cycling: "#7fdab2", transit: "#c099ff" };
const DEFAULT_CAMERA = { center: TORONTO, zoom: 14, pitch: 48, bearing: 0 };
const CESIUM_ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN || "").trim();
const TORONTO_TILES_ENV = (import.meta.env.VITE_TORONTO_2025_TILES_URL || "").trim();
const TORONTO_I3S_ENV = (import.meta.env.VITE_TORONTO_2025_I3S_URL || "").trim();

let cesiumPromise;
function loadCesium() {
  if (window.Cesium?.Viewer) return Promise.resolve(window.Cesium);
  if (cesiumPromise) return cesiumPromise;
  cesiumPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-kmaps-cesium]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${CESIUM_CDN}Widgets/widgets.css`;
      link.dataset.kmapsCesium = "true";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = `${CESIUM_CDN}Cesium.js`;
    script.async = true;
    script.onload = () => window.Cesium?.Viewer ? resolve(window.Cesium) : reject(new Error("CesiumJS failed to initialise"));
    script.onerror = () => reject(new Error("Cannot load CesiumJS from the Cesium CDN. Check network or content blocking."));
    document.head.appendChild(script);
  }).catch(error => { cesiumPromise = null; throw error; });
  return cesiumPromise;
}

function validLatLon(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1])) &&
    Math.abs(Number(value[0])) <= 90 && Math.abs(Number(value[1])) <= 180;
}
function degreesPoint(C, pair, altitude = 0) {
  return C.Cartesian3.fromDegrees(Number(pair[1]), Number(pair[0]), altitude);
}
function cameraHeight(zoom) {
  return Math.max(65, Math.min(17_000_000, 23_000_000 / 2 ** (Math.min(22, Math.max(1, zoom)) - 1)));
}
function inferredZoom(height) {
  return Math.max(1, Math.min(22, 1 + Math.log2(23_000_000 / Math.max(65, height))));
}
// Synchronize the actual ground footprint with Leaflet. Camera altitude alone
// is not a 2D zoom: it changes with pitch and the height of the terrain.
function readCameraFor2D(C, viewer) {
  if (!viewer || viewer.isDestroyed()) return null;
  const focus = centerOfCamera(C, viewer);
  if (!focus) return null;
  const canvas = viewer.scene.canvas;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  let zoom = inferredZoom(viewer.camera.positionCartographic?.height ?? 1500);
  if (width > 40 && height > 40) {
    const groundAt = (x, y) => {
      const pixel = new C.Cartesian2(x, y);
      const ray = viewer.camera.getPickRay(pixel);
      return (ray && viewer.scene.globe.pick(ray, viewer.scene)) || viewer.camera.pickEllipsoid(pixel);
    };
    // Compare two points at the same screen height around the centre. Taking
    // a local half-width works at oblique pitch and doesn't require sky hits.
    const left = groundAt(width * 0.25, height * 0.5);
    const right = groundAt(width * 0.75, height * 0.5);
    if (left && right) {
      const metres = C.Cartesian3.distance(left, right);
      const metresPerPixel = metres / (width * 0.5);
      const latitudeScale = 156543.03392804097 * Math.cos(C.Math.toRadians(focus.lat));
      if (Number.isFinite(metresPerPixel) && metresPerPixel > 0.005 && latitudeScale > 0) {
        zoom = Math.log2(latitudeScale / metresPerPixel);
      }
    }
  }
  return {
    center: [focus.lon, focus.lat],
    zoom: Math.max(0, Math.min(21, zoom)),
    pitch: C.Math.toDegrees(viewer.camera.pitch) + 90,
    bearing: C.Math.toDegrees(viewer.camera.heading),
  };
}

function coordsToCartesians(C, points) {
  return (points || []).filter(validLatLon).map(item => degreesPoint(C, item, 5));
}
// Lightweight haversine distance for selecting only stops in the visible area.
function distanceToStopMetres([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const a = (lat2 - lat1) * rad;
  const b = (lon2 - lon1) * rad;
  const h = Math.sin(a / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(b / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function css(C, value, fallback = "#71b0d4") {
  try { return C.Color.fromCssColorString(value || fallback) || C.Color.fromCssColorString(fallback); }
  catch { return C.Color.fromCssColorString(fallback); }
}
function insideToronto(lon, lat) {
  return lon >= TORONTO_BOUNDS.west && lon <= TORONTO_BOUNDS.east && lat >= TORONTO_BOUNDS.south && lat <= TORONTO_BOUNDS.north;
}
function centerOfCamera(C, viewer) {
  const canvas = viewer.scene.canvas;
  const pixel = new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(pixel);
  const ground = ray && viewer.scene.globe.pick(ray, viewer.scene);
  // A sky click is not a map location. Never use the camera's position as
  // a fake ground target: that made long-distance globe navigation drift.
  const point = ground || viewer.camera.pickEllipsoid(pixel);
  if (!point) return null;
  const c = C.Cartographic.fromCartesian(point);
  return { lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude) };
}
function initialFocus(C, viewer, camera) {
  // A Leaflet camera.center is the point ON THE MAP being viewed, not the
  // camera's geodetic position. The old setView(fromDegrees(center, altitude))
  // placed a pitched camera north/south of the intended focus.
  const [lon, lat] = Array.isArray(camera?.center) ? camera.center.map(Number) : TORONTO;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const bearing = Number.isFinite(camera?.bearing) ? camera.bearing : 0;
  const tiltFromVertical = Number.isFinite(camera?.pitch) ? camera.pitch : 45;
  const pitch = C.Math.toRadians(Math.max(-85, Math.min(-40, tiltFromVertical - 90)));
  const range = cameraHeight(camera?.zoom ?? 13);
  const target = C.Cartesian3.fromDegrees(lon, lat, 0);
  viewer.camera.lookAt(target, new C.HeadingPitchRange(C.Math.toRadians(bearing), pitch, range));
  // Restore Cesium's world transform so normal pan/tilt and globe gestures
  // work, but keep the world target established above.
  viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
}

function flyTo(C, viewer, pair, range = 550, seconds = 1) {
  if (!validLatLon(pair)) return;
  viewer.camera.flyToBoundingSphere(new C.BoundingSphere(degreesPoint(C, pair), 1), {
    offset: new C.HeadingPitchRange(viewer.camera.heading, C.Math.toRadians(-48), range), duration: seconds,
  });
}
function fitPath(C, viewer, points) {
  const filtered = (points || []).filter(validLatLon);
  if (filtered.length < 2) return;
  const lats = filtered.map(p => Number(p[0]));
  const lons = filtered.map(p => Number(p[1]));
  const rectangle = C.Rectangle.fromDegrees(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
  viewer.camera.flyTo({ destination: rectangle, duration: 1.0 });
}

// Return imagery providers in bottom-to-top order for the selected map style.
async function imageryFor(C, style) {
  if (style === "street") {
    return [new C.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })];
  }
  let aerial;
  try {
    // Read the ArcGIS service metadata and its real tiling scheme rather than
    // assuming the tile URL's coordinate system.
    aerial = await C.ArcGisMapServerImageryProvider.fromUrl(ESRI_MAPSERVER);
  } catch (error) {
    console.warn("Native ArcGIS imagery unavailable; using WebMercator tile fallback", error);
    aerial = new C.UrlTemplateImageryProvider({
      url: ESRI_IMAGERY, maximumLevel: 19, tilingScheme: new C.WebMercatorTilingScheme(),
      credit: new C.Credit("Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community"),
    });
  }
  const providers = [aerial];
  if (style === "hybrid") providers.push(new C.UrlTemplateImageryProvider({
    url: "https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png", maximumLevel: 19,
    tilingScheme: new C.WebMercatorTilingScheme(),
    credit: new C.Credit("Labels © CARTO, © OpenStreetMap contributors"),
  }));
  return providers;
}

function safeTorontoUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try { const parsed = new URL(value); return parsed.protocol === "https:" ? value : ""; }
  catch { return ""; }
}
function TorontoProviderType(url) {
  return /SceneServer|\/layers\/\d+/i.test(url) ? "i3s" : "tiles";
}

// Cesium OSM Buildings are positioned against Cesium World Terrain.
// Showing them over an ellipsoid (zero-elevation ground) causes floating boxes.
function syncBuildings(context) {
  if (!context || context.disposed || context.viewer.isDestroyed()) return;
  const center = centerOfCamera(context.C, context.viewer);
  const inside = center && insideToronto(center.lon, center.lat);
  const useCity = Boolean(context.cityLoaded && inside);
  // At regional/globe scale a single building is far smaller than a pixel.
  // Avoid loading and drawing thousands of useless 3D tiles in orbit.
  const height = context.viewer.camera.positionCartographic?.height ?? Infinity;
  const showBuildings = context.buildingsEnabled && Number.isFinite(height) && height < 180_000;
  if (context.city) context.city.show = showBuildings && useCity;
  if (context.osm) context.osm.show = showBuildings && context.terrainReady && !useCity;
  context.viewer.scene.requestRender();
}

function floatingStyles(darkMode) {
  return {
    background: darkMode ? "rgba(16,24,32,.94)" : "rgba(250,251,251,.94)",
    color: darkMode ? "#e7f3ef" : "#21342b", border: "1px solid rgba(155,183,173,.35)",
    borderRadius: 12, padding: "10px 12px", boxShadow: "0 6px 22px #0003", fontSize: 12,
  };
}

function BusDetails({ vehicle }) {
  const estimated = Boolean(vehicle.estimated);
  const delayAdjusted = vehicle.position_source === "schedule_adjusted";
  return (
    <div className="text-sm text-slate-900">
      <div className="font-semibold">{vehicle.agency_label || String(vehicle.agency || "").toUpperCase()} • {estimated ? "Scheduled estimate" : "Live"} {vehicle.route ? `route ${vehicle.route}` : "vehicle"}</div>
      {(vehicle.display_headsign || vehicle.headsign) && <div>toward {vehicle.display_headsign || vehicle.headsign}</div>}
      {vehicle.vehicle_label && <div>{vehicle.vehicle_label}</div>}
      {estimated ? (
        <div className="mt-1 text-[10px] opacity-70">
          {delayAdjusted ? "Estimated from the timetable with the latest known delay."
            : "Estimated from the scheduled timetable; not a GPS position."}
        </div>
      ) : vehicle.timestamp ? (
        <div className="mt-1 text-[10px] opacity-60">Position update {new Date(Number(vehicle.timestamp) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</div>
      ) : null}
    </div>
  );
}

export default function Scene3D({
  data, selectedRoute, selectedRouteNumber = 1, displayedMode, onSelectRoute,
  currentLocation, navigationActive, startCoordinate, destinationCoordinate, startLabel, destinationLabel,
  startDraggable, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination,
  locationFocusKey, routeFocusKey, stepFocusCoordinate, stepFocusKey,
  mapStyle = "street", darkMode = true, initialCamera, onCameraChange, onDisable3D, registerCameraGetter,
  enabledLayers = [], onLayerStatus = () => {},
}) {
  const holder = useRef(null);
  const scene = useRef(null);
  const callbacks = useRef({});
  const routeData = useRef({});
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [terrainProblem, setTerrainProblem] = useState("");
  const [buildingProblem, setBuildingProblem] = useState("");
  const [imageryProblem, setImageryProblem] = useState("");
  const ionToken = CESIUM_ION_TOKEN;
  const torontoUrl = TORONTO_TILES_ENV || TORONTO_I3S_ENV;
  const [popup, setPopup] = useState(null);
  const popupElement = useRef(null);
  const popupRef = useRef(null);
  const layersKey = enabledLayers.join("|");
  popupRef.current = popup;
  const mode = displayedMode || data?.mode || "driving";
  const route = selectedRoute || data?.routes?.find(r => r.route_number === selectedRouteNumber) || data?.routes?.[0];
  const initialCameraRef = useRef(initialCamera || DEFAULT_CAMERA);
  const focusKey = useRef([locationFocusKey, routeFocusKey, stepFocusKey]);

  useEffect(() => {
    callbacks.current = { onCameraChange, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute, onLayerStatus };
    routeData.current = { data, route, mode, startCoordinate, destinationCoordinate, currentLocation };
  }, [onCameraChange, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination, onSelectRoute, onLayerStatus, data, route, mode, startCoordinate, destinationCoordinate, currentLocation]);

  // Loading CesiumJS is independent of ion; the renderer itself does not require billing.
  useEffect(() => {
    let disposed = false;
    let viewer;
    let handler;
    let changed;
    (async () => {
      try {
        const C = await loadCesium();
        if (disposed || !holder.current) return;
        C.Ion.defaultAccessToken = ionToken || "";
        viewer = new C.Viewer(holder.current, {
          animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
          navigationHelpButton: false, sceneModePicker: false, fullscreenButton: false, infoBox: false,
          selectionIndicator: false, baseLayer: false, terrainProvider: new C.EllipsoidTerrainProvider(),
          sceneMode: C.SceneMode.SCENE3D, scene3DOnly: true,
          skyAtmosphere: new C.SkyAtmosphere(),
          requestRenderMode: true, maximumRenderTimeChange: Infinity,
          // Cesium's on-demand renderer saves GPU work between interactions.
          useBrowserRecommendedResolution: true,
          contextOptions: { webgl: { antialias: false, powerPreference: "high-performance" } },
        });
        viewer.scene.globe.enableLighting = false;
        viewer.scene.globe.showGroundAtmosphere = true;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
        if (viewer.scene.skyBox) viewer.scene.skyBox.show = true;
        viewer.scene.fog.enabled = true;
        viewer.scene.backgroundColor = C.Color.fromCssColorString("#c8ddeb");
        viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
        // Previous setting allowed 1.5x pixel scaling (2.25x fragment work).
        // Render at CSS pixel resolution; keep the atmosphere and 3D terrain.
        viewer.resolutionScale = 1.0;
        if (viewer.scene.msaaSupported) viewer.scene.msaaSamples = 2;
        viewer.scene.globe.maximumScreenSpaceError = 3.5;
        viewer.scene.globe.tileCacheSize = 80;
        const controls = viewer.scene.screenSpaceCameraController;
        controls.minimumZoomDistance = 8;
        controls.maximumZoomDistance = 23_000_000;
        controls.enableCollisionDetection = true;
        // Stop free-looking into space and large residual movement after mouseup.
        controls.enableLook = false;
        controls.minimumTrackBallHeight = Number.POSITIVE_INFINITY;
        controls.inertiaSpin = 0.18;
        controls.inertiaTranslate = 0.18;
        controls.inertiaZoom = 0.12;
        // Cesium's stock multiplier is 5.0. The old 2.6 together with an
        // unusually strict movement cap made touchscreen pinches feel sluggish.
        // Keep native pinch-pan/tilt rather than layering competing handlers.
        controls.zoomFactor = 5.5;
        controls.maximumMovementRatio = 0.22;
        controls.maximumTiltAngle = C.Math.toRadians(89);

        initialFocus(C, viewer, initialCameraRef.current);
        scene.current = { C, viewer, osm: null, city: null, cityLoaded: false,
          currentCityUrl: null, overlays: [], markers: [], dynamic: [], cityLoading: false,
          buildingGen: 0, buildingsEnabled: true, terrainReady: false, terrainProviderReady: false,
          terrainGen: 0, stops: [], baseImageryLayers: [], disposed: false };

        const groundCoordinate = pixel => {
          const ray = viewer.camera.getPickRay(pixel);
          const cartesian = ray && viewer.scene.globe.pick(ray, viewer.scene);
          const actual = cartesian || viewer.camera.pickEllipsoid(pixel);
          if (!actual) return null;
          const c = C.Cartographic.fromCartesian(actual);
          return [C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude)];
        };
        handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction(evt => {
          if (viewer.isDestroyed() || scene.current?.disposed) return;
          const coord = groundCoordinate(evt.position);
          if (!coord) return;
          setPopup({ kind: "picker", location: coord });
        }, C.ScreenSpaceEventType.RIGHT_CLICK);
        handler.setInputAction(evt => {
          if (viewer.isDestroyed() || scene.current?.disposed) return;
          const picked = viewer.scene.pick(evt.position);
          const entity = picked?.id;
          if (entity?.kmapsRoute) callbacks.current.onSelectRoute?.(entity.kmapsRoute);
          if (entity?.kmapsStop) {
            setPopup({ kind: "stop", location: entity.kmapsStop.coordinates, stop: entity.kmapsStop });
          } else if (entity?.kmapsVehicle) {
            const vehicle = entity.kmapsVehicle;
            setPopup({ kind: "bus", location: [vehicle.lat, vehicle.lon], vehicle });
          } else if (entity?.kmapsReport) {
            setPopup({ kind: "report", location: entity.kmapsReport.position, item: entity.kmapsReport.item });
          } else if (entity?.kmapsMarker && entity.kmapsMarker !== "bus") {
            setPopup({ kind: "marker", location: entity.kmapsPosition, title: entity.kmapsMarker === "start"
              ? `Start: ${routeData.current.data?.start?.address || startLabel || "Selected location"}`
              : entity.kmapsMarker === "end"
                ? `Destination: ${routeData.current.data?.end?.address || destinationLabel || "Selected location"}`
                : "Current location" });
          } else {
            // Match Leaflet: near-by stops are clickable even when their tiny
            // visible dot isn't exactly under the pointer.
            const current = scene.current;
            const height = viewer.camera.positionCartographic?.height ?? Infinity;
            let closest = null, closestPixels = 34;
            if (current && routeData.current.mode === "transit" && height < 1750) {
              for (const stopEntity of current.stops) {
                const position = stopEntity.position?.getValue(C.JulianDate.now());
                if (!position) continue;
                const projected = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, position);
                if (!projected) continue;
                const pixels = Math.hypot(projected.x - evt.position.x, projected.y - evt.position.y);
                if (pixels < closestPixels) { closest = stopEntity.kmapsStop; closestPixels = pixels; }
              }
            }
            if (closest) setPopup({ kind: "stop", location: closest.coordinates, stop: closest });
            else setPopup(null);
          }
        }, C.ScreenSpaceEventType.LEFT_CLICK);
        let drag = null;
        handler.setInputAction(evt => {
          const hit = viewer.scene.pick(evt.position)?.id;
          if (hit?.kmapsMarker === "start" && startDraggable) drag = "start";
          else if (hit?.kmapsMarker === "end") drag = "end";
          if (drag) viewer.scene.screenSpaceCameraController.enableRotate = false;
        }, C.ScreenSpaceEventType.LEFT_DOWN);
        handler.setInputAction(evt => {
          if (!drag) return;
          const pos = groundCoordinate(evt.position);
          if (pos) (drag === "start" ? callbacks.current.onMoveStart : callbacks.current.onMoveDestination)?.(pos);
          drag = null;
          viewer.scene.screenSpaceCameraController.enableRotate = true;
        }, C.ScreenSpaceEventType.LEFT_UP);
        changed = () => {
          const current = scene.current;
          if (!current || current.disposed || current.viewer !== viewer || viewer.isDestroyed()) return;
          const camera = readCameraFor2D(C, viewer);
          if (camera) {
            callbacks.current.onCameraChange?.(camera);
            syncBuildings(current);
          }
        };
        viewer.camera.moveEnd.addEventListener(changed);
        registerCameraGetter?.(() => readCameraFor2D(C, viewer));
        // Follow the selected geographic point every frame, including camera
        // tilt, touch pan, and terrain tile changes. This is NOT screen-fixed.
        const followPopup = () => {
          const pop = popupRef.current;
          const element = popupElement.current;
          if (!element || !pop || !validLatLon(pop.location) || viewer.isDestroyed()) return;
          const [lat, lon] = pop.location;
          const cartographic = C.Cartographic.fromDegrees(Number(lon), Number(lat));
          const ground = viewer.scene.globe.getHeight(cartographic);
          const world = C.Cartesian3.fromDegrees(Number(lon), Number(lat), (Number.isFinite(ground) ? ground : 0) + 4);
          const toward = C.Cartesian3.subtract(world, viewer.camera.positionWC, new C.Cartesian3());
          const facing = C.Cartesian3.dot(viewer.camera.directionWC, toward) > 0;
          const pixel = facing ? C.SceneTransforms.worldToWindowCoordinates(viewer.scene, world) : null;
          const width = holder.current?.clientWidth || 0;
          const height = holder.current?.clientHeight || 0;
          if (!pixel || !Number.isFinite(pixel.x) || !Number.isFinite(pixel.y) ||
              pixel.x < -35 || pixel.x > width + 35 || pixel.y < -35 || pixel.y > height + 35) {
            element.style.visibility = "hidden";
          } else {
            element.style.visibility = "visible";
            const halfWidth = Math.min(150, Math.max(12, width / 2 - 12));
            element.style.left = `${Math.max(halfWidth, Math.min(width - halfWidth, pixel.x))}px`;
            if (pixel.y < 275) {
              element.style.top = `${Math.max(12, pixel.y + 14)}px`;
              element.style.transform = "translate(-50%, 0)";
            } else {
              element.style.top = `${pixel.y - 14}px`;
              element.style.transform = "translate(-50%, -100%)";
            }
          }
        };
        scene.current.followPopup = followPopup;
        scene.current.removeFollowPopup = viewer.scene.postRender.addEventListener(followPopup);
        setReady(true);
        setError("");
      } catch (e) { if (!disposed) setError(String(e.message || e)); }
    })();
    return () => {
      disposed = true;
      registerCameraGetter?.(null);
      // Invalidate the scene before releasing WebGL resources: in-flight
      // Cesium/route callbacks must not update a destroyed renderer.
      const ownedScene = scene.current?.viewer === viewer ? scene.current : null;
      if (ownedScene) {
        ownedScene.disposed = true;
        ownedScene.removeFollowPopup?.();
        ownedScene.buildingGen++;
        ownedScene.terrainGen++;
        scene.current = null;
      }
      try { if (handler && !handler.isDestroyed()) handler.destroy(); }
      catch (error) { console.warn("3D picking cleanup", error); }
      if (viewer && !viewer.isDestroyed()) {
        try {
          viewer.camera.cancelFlight();
          if (changed) viewer.camera.moveEnd.removeEventListener(changed);
          viewer.destroy();
        } catch (error) { console.warn("Cesium cleanup", error); }
      }
      // The component is unmounting; avoid setState in this cleanup.
    };
    // Vite environment values are loaded at build/startup; no in-browser token entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cesium OSM Buildings are built against Cesium World Terrain (ion asset 1).
  // Do not show them over an ellipsoid: that is the root of the floating-box issue.
  useEffect(() => {
    const context = scene.current;
    if (!ready || !context) return;
    const { C, viewer } = context;
    const version = ++context.terrainGen;
    context.terrainReady = false;
    context.terrainProviderReady = false;
    syncBuildings(context);
    if (!ionToken) {
      setTerrainProblem("Cesium token required for 3D buildings and terrain.");
      return;
    }
    let cancelled = false;
    let removeLoadListener = null;
    let removePostListener = null;
    let removeTerrainError = null;
    setTerrainProblem("");
    (async () => {
      try {
        const provider = await C.CesiumTerrainProvider.fromIonAssetId(1, { requestVertexNormals: false });
        if (cancelled || scene.current !== context || version !== context.terrainGen) return;
        viewer.terrainProvider = provider;
        removeTerrainError = provider.errorEvent?.addEventListener(error => {
          if (cancelled || scene.current !== context || version !== context.terrainGen) return;
          context.terrainProviderReady = false;
          context.terrainReady = false;
          setTerrainProblem("Terrain couldn't load. Buildings are hidden to prevent floating geometry.");
          console.warn("Cesium terrain tile error", error);
          syncBuildings(context);
        });
        context.terrainProviderReady = true;
        // Wait until the ground tiles are actually displayed before revealing OSM buildings.
        const finishIfLoaded = () => {
          if (cancelled || scene.current !== context || version !== context.terrainGen || !context.terrainProviderReady) return;
          if (!viewer.scene.globe.tilesLoaded) return;
          context.terrainReady = true;
          setTerrainProblem("");
          syncBuildings(context);
          removeLoadListener?.(); removeLoadListener = null;
          removePostListener?.(); removePostListener = null;
        };
        removeLoadListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener(() => finishIfLoaded());
        removePostListener = viewer.scene.postRender.addEventListener(() => finishIfLoaded());
        viewer.scene.requestRender();
      } catch (e) {
        if (cancelled || scene.current !== context || version !== context.terrainGen) return;
        context.terrainProviderReady = false;
        context.terrainReady = false;
        setTerrainProblem("Terrain unavailable. Buildings are hidden to prevent floating geometry.");
        console.warn("Cesium World Terrain unavailable", e);
        syncBuildings(context);
      }
    })();
    return () => {
      cancelled = true;
      context.terrainGen++;
      removeLoadListener?.(); removePostListener?.(); removeTerrainError?.();
    };
  }, [ready, ionToken]);

  // OSM Buildings globally. No photorealistic/Google assets are requested.
  useEffect(() => {
    const context = scene.current;
    if (!ready || !context) return;
    const { C, viewer } = context;
    const version = ++context.buildingGen;
    C.Ion.defaultAccessToken = ionToken || "";
    if (!ionToken) {
      if (context.osm) { viewer.scene.primitives.remove(context.osm); context.osm = null; }
      setBuildingProblem("Add VITE_CESIUM_ION_TOKEN to frontend/.env to enable buildings.");
      return;
    }
    setBuildingProblem("");
    (async () => {
      try {
        const previous = context.osm;
        const next = await C.createOsmBuildingsAsync();
        if (scene.current !== context || version !== context.buildingGen) { next.destroy(); return; }
        if (previous) viewer.scene.primitives.remove(previous);
        context.osm = viewer.scene.primitives.add(next);
        // Trade a little distant facade detail for responsive camera movement.
        next.maximumScreenSpaceError = 24;
        next.dynamicScreenSpaceError = true;
        next.cullRequestsWhileMoving = true;
        next.preloadFlightDestinations = false;
        next.show = false;
        syncBuildings(context);
        setBuildingProblem("");
        viewer.scene.requestRender();
      } catch (e) {
        if (scene.current === context && version === context.buildingGen) {
          setBuildingProblem("OSM buildings couldn't load. Check your Cesium ion token and asset access.");
          console.warn("Cesium OSM Buildings unavailable", e);
        }
      }
    })();
    return () => { context.buildingGen++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ionToken]);

  // Toronto 2025 must be a real tiled city dataset supplied by the user/host.
  // raw SHP multipatch is not a 3D Tiles file. Don't silently fall back to fake buildings.
  useEffect(() => {
    const context = scene.current;
    if (!ready || !context) return;
    const { C, viewer } = context;
    const cityUrl = safeTorontoUrl(torontoUrl);
    if (!cityUrl) return;
    let cancelled = false;
    const currentUrl = cityUrl;
    context.currentCityUrl = cityUrl;
    (async () => {
      try {
        const type = TorontoProviderType(cityUrl);
        if (cityUrl.startsWith("/") || type === "tiles") {
          const head = await fetch(cityUrl, { method: "GET", cache: "no-store" });
          if (!head.ok) throw new Error(`${head.status} (tileset not hosted)`);
          const doc = await head.json();
          if (type === "tiles" && !doc.asset?.version && !doc.root) throw new Error("Not a 3D Tiles tileset.json");
        }
        if (cancelled || scene.current !== context) return;
        const tiles = type === "i3s"
          ? await C.I3SDataProvider.fromUrl(cityUrl)
          : await C.Cesium3DTileset.fromUrl(cityUrl, { maximumScreenSpaceError: 18,
              cullRequestsWhileMoving: true, preloadFlightDestinations: false });
        if (cancelled || scene.current !== context || context.currentCityUrl !== currentUrl) {
          tiles.destroy?.(); return;
        }
        if (context.city) viewer.scene.primitives.remove(context.city);
        context.city = viewer.scene.primitives.add(tiles);
        context.cityLoaded = true;
        syncBuildings(context);
        viewer.scene.requestRender();
      } catch (e) {
        if (cancelled || scene.current !== context) return;
        context.cityLoaded = false;
        console.warn("Toronto 2025 model unavailable; using OSM buildings", e);
        const old = context.city;
        context.city = null;
        if (old) viewer.scene.primitives.remove(old);
        syncBuildings(context);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, torontoUrl]);

  // Keep imagery matched to the user's selected basemap style.
  useEffect(() => {
    const context = scene.current;
    if (!ready || !context) return;
    const { viewer, C } = context;
    let cancelled = false;
    (async () => {
      try {
        const providers = await imageryFor(C, mapStyle);
        if (cancelled || scene.current !== context || viewer.isDestroyed()) return;
        // Swap only after provider setup finishes to avoid stale layer changes.
        // Replace ONLY the basemap layers. removeAll() also discarded
        // separate overlays (notably live traffic) during a style change.
        for (const layer of context.baseImageryLayers || []) {
          if (viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true);
        }
        context.baseImageryLayers = providers.map((provider, index) =>
          viewer.imageryLayers.addImageryProvider(provider, index));
        setImageryProblem("");
        viewer.scene.requestRender();
      } catch (e) {
        if (cancelled) return;
        setImageryProblem("Map imagery couldn't load. Check your network connection.");
        console.warn("Cesium imagery unavailable", e);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, mapStyle]);

  // Routes are displayed as georeferenced Cesium polylines (no MapLibre canvas).
  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    for (const entity of current.overlays) viewer.entities.remove(entity);
    current.overlays = [];
    function addLine(points, color, routeNumber, selected = false, walk = false) {
      const positions = coordsToCartesians(C, points);
      if (positions.length < 2) return;
      const entity = viewer.entities.add({
        polyline: { positions, clampToGround: true, width: selected ? 6 : 3,
          material: walk ? new C.PolylineDashMaterialProperty({ color: css(C, color), dashLength: 18 }) : css(C, color).withAlpha(selected ? 1 : 0.55) },
      });
      entity.kmapsRoute = routeNumber;
      current.overlays.push(entity);
    }
    for (const item of data?.routes || []) {
      if (item.route_number === route?.route_number) continue;
      addLine(item.route_coordinates, "#a2aab7", item.route_number, false);
    }
    if (mode === "transit" && Array.isArray(route?.segments)) {
      for (const segment of route.segments) {
        const walk = segment.type === "walking" || segment.mode === "walking";
        addLine(segment.coordinates, walk ? COLORS.walking : segment.color || COLORS.transit, route.route_number, true, walk);
      }
    } else if (route) {
      addLine(route.route_coordinates, COLORS[mode] || COLORS.driving, route.route_number, true, mode === "walking");
    }
    viewer.scene.requestRender();
  }, [ready, data, route, mode]);

  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    for (const entity of current.markers) viewer.entities.remove(entity);
    current.markers = [];
    function marker(pair, text, kind, color, payload) {
      if (!validLatLon(pair)) return;
      const location = [Number(pair[0]), Number(pair[1])];
      const entity = viewer.entities.add({
        position: degreesPoint(C, location),
        point: { pixelSize: kind === "bus" ? 14 : 13, color: css(C, color), outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND },
        label: { text, font: "bold 12px system-ui", fillColor: C.Color.WHITE,
          style: C.LabelStyle.FILL_AND_OUTLINE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          pixelOffset: new C.Cartesian2(0, -23), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 4500) },
      });
      entity.kmapsMarker = kind;
      entity.kmapsPosition = location;
      if (kind === "bus") entity.kmapsVehicle = payload;
      current.markers.push(entity);
    }
    if (!navigationActive) marker(startCoordinate || data?.start?.coordinates, "A", "start", "#5cb78a");
    marker(destinationCoordinate || data?.end?.coordinates, "B", "end", "#ee6d5e");
    marker(currentLocation, "●", "location", "#4ba4fc");
    if (mode === "transit") for (const vehicle of route?.live_vehicles || []) {
      const matchingTrip = (route.steps || []).some(step => step.type === "transit" &&
        String(step.agency) === String(vehicle.agency) && String(step.trip_id) === String(vehicle.trip_id));
      if (matchingTrip && validLatLon([vehicle.lat, vehicle.lon])) {
        marker([vehicle.lat, vehicle.lon], vehicle.route ? String(vehicle.route) : "BUS", "bus",
          vehicle.estimated ? "#64748B" : "#D97706", vehicle);
      }
    }
    viewer.scene.requestRender();
  }, [ready, route, mode, startCoordinate, destinationCoordinate, currentLocation, data, navigationActive]);

  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const before = focusKey.current;
    focusKey.current = [locationFocusKey, routeFocusKey, stepFocusKey];
    if (stepFocusKey !== before[2] && validLatLon(stepFocusCoordinate)) flyTo(current.C, current.viewer, stepFocusCoordinate, 320);
    else if (locationFocusKey !== before[0] && validLatLon(currentLocation)) flyTo(current.C, current.viewer, currentLocation, 1400);
    else if (routeFocusKey !== before[1]) fitPath(current.C, current.viewer, route?.route_coordinates);
  }, [ready, locationFocusKey, routeFocusKey, stepFocusKey, stepFocusCoordinate, currentLocation, route]);

  // Preserve Ontario 511 markers with the same API used by the old 3D mode.
  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    const active = new Set(layersKey.split("|").filter(Boolean));
    const kinds = ["incidents", "construction", "cameras", "winter"];
    let cancelled = false, timer = null, controller = null;
    const redraw = async () => {
      if (cancelled || current.disposed || viewer.isDestroyed()) return;
      controller?.abort();
      controller = new AbortController();
      const center = centerOfCamera(C, viewer);
      if (!center || cancelled || current.disposed || viewer.isDestroyed()) return;
      const cameraAltitude = viewer.camera.positionCartographic?.height ?? Infinity;
      if (!Number.isFinite(cameraAltitude) || cameraAltitude > 120_000 || !kinds.some(kind => active.has(kind))) return;
      const span = Math.max(0.05, Math.min(1.0, cameraAltitude / 30000));
      const bbox = [center.lon-span,center.lat-span*0.7,center.lon+span,center.lat+span*0.7].map(n=>n.toFixed(4)).join(",");
      for (const entity of current.dynamic) viewer.entities.remove(entity);
      current.dynamic = [];
      for (const kind of kinds) {
        if (!active.has(kind)) continue;
        try {
          const response = await fetch(`/api/layers/ontario511?${new URLSearchParams({kind,bbox})}`, {signal:controller.signal});
          if (!response.ok) throw new Error("Unavailable");
          const payload = await response.json();
          if (cancelled || scene.current !== current || current.disposed || viewer.isDestroyed() || controller.signal.aborted) return;
          callbacks.current.onLayerStatus?.(kind, payload.message || "");
          for (const item of (payload.items || []).slice(0, 150)) {
            const color = { incidents: "#f26c65", construction: "#e3ac58", cameras: "#6ca7ff", winter: "#90b7df" }[kind];
            for (const line of item.lines || []) {
              const positions = coordsToCartesians(C, line);
              if (positions.length < 2) continue;
              const route = viewer.entities.add({
                polyline: { positions, clampToGround: true, width: kind === "winter" ? 5 : 4,
                  material: css(C, color).withAlpha(0.82) },
              });
              route.kmapsReport = { item, position: line[Math.floor(line.length / 2)] };
              current.dynamic.push(route);
            }
            if (!validLatLon(item.point)) continue;
            const position = [Number(item.point[0]), Number(item.point[1])];
            const report = viewer.entities.add({
              position: degreesPoint(C, position),
              point: { pixelSize: 10, color: css(C, color), outlineColor: C.Color.WHITE,
                outlineWidth: 2, heightReference: C.HeightReference.CLAMP_TO_GROUND },
              label: { text: (item.title || kind).slice(0, 32), font: "11px system-ui", pixelOffset: new C.Cartesian2(0, -18),
                fillColor: C.Color.WHITE, style: C.LabelStyle.FILL_AND_OUTLINE, outlineColor: C.Color.BLACK,
                outlineWidth: 2, heightReference: C.HeightReference.CLAMP_TO_GROUND,
                distanceDisplayCondition: new C.DistanceDisplayCondition(0, 8000) },
            });
            report.kmapsReport = { item, position };
            current.dynamic.push(report);
          }
        } catch (e) {
          if (!cancelled && !current.disposed && !viewer.isDestroyed() && e.name !== "AbortError")
            callbacks.current.onLayerStatus?.(kind, "Unavailable in 3D");
        }
      }
      if (!cancelled && !current.disposed && !viewer.isDestroyed()) viewer.scene.requestRender();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(redraw, 550); };
    viewer.camera.moveEnd.addEventListener(schedule);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      if (!viewer.isDestroyed()) {
        viewer.camera.moveEnd.removeEventListener(schedule);
        for (const entity of current.dynamic) viewer.entities.remove(entity);
      }
      current.dynamic = [];
    };
  }, [ready, layersKey]);

  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    let traffic = null;
    if (layersKey.split("|").includes("traffic")) {
      traffic = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: `/api/layers/traffic/tile/{z}/{x}/{y}.png?style=${darkMode ? "dark" : "light"}`, maximumLevel: 20,
      }));
      traffic.alpha = 0.77;
    }
    return () => { if (traffic && !viewer.isDestroyed()) viewer.imageryLayers.remove(traffic); };
  }, [ready, layersKey, darkMode, mapStyle]);

  useEffect(() => {
    const current = scene.current;
    if (current && !current.disposed && !current.viewer.isDestroyed()) {
      current.followPopup?.();
      current.viewer.scene.requestRender();
    }
  }, [popup]);

  // Mirror the 2D stop layer: no stops below zoom 16, and only fetch the
  // visible neighborhood when the camera settles. Clear old entities *during*
  // a zoom-out, not only after a delayed moveEnd request has completed.
  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    let disposed = false;
    let timer = null;
    let request = null;
    let requestSerial = 0;
    let previousRequest = null;
    let lastFrameCheck = 0;
    let stopsWereInRange = false;
    let lastDrawnCenter = null;

    const alive = () => !disposed && !current.disposed &&
      scene.current === current && !viewer.isDestroyed();

    function zoomLevel() {
      const altitude = viewer.camera.positionCartographic?.height ?? Infinity;
      // At this altitude a stop-sized item is never useful. Fast-path
      // keeps globe-scale navigation cheap, even with oblique cameras.
      if (!Number.isFinite(altitude) || altitude > 1800) return -Infinity;
      return readCameraFor2D(C, viewer)?.zoom ?? inferredZoom(altitude);
    }

    function visibleAtCurrentZoom() {
      return mode === "transit" && zoomLevel() >= 16;
    }

    function cancelRequest() {
      requestSerial++;
      request?.abort();
      request = null;
    }

    function removeStops() {
      if (!alive()) return;
      if (current.stops.length) {
        viewer.entities.suspendEvents();
        try {
          for (const entity of current.stops) viewer.entities.remove(entity);
          current.stops = [];
        } finally { viewer.entities.resumeEvents(); }
        viewer.scene.requestRender();
      }
      lastDrawnCenter = null;
      if (popupRef.current?.kind === "stop") setPopup(null);
    }

    function unloadIfTooFar() {
      if (!alive()) return true;
      if (visibleAtCurrentZoom()) {
        stopsWereInRange = true;
        return false;
      }
      // When already outside the stop zoom range, don't repeatedly abort
      // empty requests or create renders on every Cesium postRender event.
      if (!stopsWereInRange && !timer && !request && !current.stops.length) return true;
      stopsWereInRange = false;
      clearTimeout(timer);
      timer = null;
      cancelRequest();
      previousRequest = null;
      removeStops();
      return true;
    }

    function updateEntities(rawStops, center) {
      if (!alive() || !visibleAtCurrentZoom()) return;
      const selectedStops = route?.transit_stops || [];
      const used = new Set();
      const localStops = [];
      // Route stops often span several kilometres. Never keep all of them
      // active when the camera only shows one neighborhood.
      for (const stop of [...selectedStops, ...(rawStops || [])]) {
        if (!validLatLon(stop?.coordinates)) continue;
        if (distanceToStopMetres(center, stop.coordinates) > 1050) continue;
        const key = String(stop.id ?? `${stop.coordinates[0]}:${stop.coordinates[1]}`);
        if (used.has(key)) continue;
        used.add(key);
        localStops.push(stop);
        if (localStops.length >= 180) break;
      }
      viewer.entities.suspendEvents();
      try {
        for (const entity of current.stops) viewer.entities.remove(entity);
        current.stops = [];
        for (const stop of localStops) {
          const entity = viewer.entities.add({
            position: degreesPoint(C, stop.coordinates),
            point: { pixelSize: 9, color: C.Color.fromCssColorString("#8A6F4D"),
              outlineColor: C.Color.WHITE, outlineWidth: 1.5,
              heightReference: C.HeightReference.CLAMP_TO_GROUND },
          });
          entity.kmapsStop = stop;
          current.stops.push(entity);
        }
      } finally { viewer.entities.resumeEvents(); }
      lastDrawnCenter = center;
      viewer.scene.requestRender();
    }

    function refresh() {
      if (!alive()) return;
      clearTimeout(timer);
      timer = null;
      if (unloadIfTooFar()) return;
      // Abort the previous region's request as soon as the camera settles;
      // an older response must never restore stops behind the user.
      cancelRequest();
      timer = setTimeout(async () => {
        if (!alive() || unloadIfTooFar()) return;
        const center = centerOfCamera(C, viewer);
        if (!center) { removeStops(); return; }
        const centrePair = [center.lat, center.lon];
        // A single fetched neighborhood covers small pans and zooms.
        // Avoid re-requesting hundreds of stops for every tiny gesture.
        if (previousRequest && Date.now() - previousRequest.at < 30000 &&
            distanceToStopMetres(centrePair, previousRequest.center) < 180) {
          if (!lastDrawnCenter || distanceToStopMetres(centrePair, lastDrawnCenter) > 85 || !current.stops.length)
            updateEntities(previousRequest.stops, centrePair);
          return;
        }
        cancelRequest();
        const serial = requestSerial;
        const controller = new AbortController();
        request = controller;
        try {
          const query = new URLSearchParams({ lat: String(center.lat), lon: String(center.lon), radius: "900" });
          const response = await fetch(`/api/transit/stops?${query}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          if (!alive() || controller.signal.aborted || serial !== requestSerial || !visibleAtCurrentZoom()) return;
          const stops = Array.isArray(payload.stops) ? payload.stops : [];
          previousRequest = { center: centrePair, at: Date.now(), stops };
          const now = centerOfCamera(C, viewer);
          if (now) updateEntities(stops, [now.lat, now.lon]);
        } catch (error) {
          if (alive() && error.name !== "AbortError") {
            console.warn("3D transit stops unavailable", error);
            // Route stops remain usable if the nearby-stop service fails.
            const now = centerOfCamera(C, viewer);
            if (now) updateEntities([], [now.lat, now.lon]);
          }
        } finally {
          if (request === controller) request = null;
        }
      }, 200);
    }

    // camera.changed detects zoom-out *while* the gesture is taking place.
    // postRender catches the globe-scale / inertial cases where moveEnd has
    // not fired yet. Fetch only once the camera has finished moving.
    const onCameraChanged = () => { if (alive()) unloadIfTooFar(); };
    const onFrame = () => {
      const now = Date.now();
      if (now - lastFrameCheck < 100) return;
      lastFrameCheck = now;
      if (alive()) unloadIfTooFar();
    };
    viewer.camera.changed.addEventListener(onCameraChanged);
    viewer.scene.postRender.addEventListener(onFrame);
    viewer.camera.moveEnd.addEventListener(refresh);
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelRequest();
      if (!viewer.isDestroyed()) {
        viewer.camera.changed.removeEventListener(onCameraChanged);
        viewer.camera.moveEnd.removeEventListener(refresh);
        viewer.scene.postRender.removeEventListener(onFrame);
        viewer.entities.suspendEvents();
        try { for (const entity of current.stops) viewer.entities.remove(entity); }
        finally { viewer.entities.resumeEvents(); }
      }
      current.stops = [];
    };
  }, [ready, mode, route]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: darkMode ? "#101b27" : "#e2eef7" }}>
      <div ref={holder} style={{ position: "absolute", inset: 0 }} aria-label="Cesium 3D globe and Toronto building massing" />
      {/* Production UI: only loading, actionable errors, and contextual map interactions. */}
      {(!ready || error || (ready && (terrainProblem || buildingProblem || imageryProblem))) && (
        <div role={error || terrainProblem || buildingProblem || imageryProblem ? "alert" : "status"}
          style={{ position: "absolute", right: 12, top: 14, zIndex: 490,
            maxWidth: "min(320px, calc(100vw - 24px))", ...floatingStyles(darkMode) }}>
          {error ? (
            <>
              <div>{error}</div>
              <button type="button" onClick={onDisable3D} style={{ marginTop: 8, textDecoration: "underline" }}>Return to 2D</button>
            </>
          ) : !ready ? (
            <span>Loading 3D map…</span>
          ) : (
            <span>{terrainProblem || buildingProblem || imageryProblem}</span>
          )}
        </div>
      )}
      {popup && (
        <div ref={popupElement} className="cesium-location-popup"
          style={{ position: "absolute", visibility: "hidden", zIndex: 650, width: "min(320px, calc(100% - 24px))",
            maxHeight: "min(380px, 65vh)", overflowY: "auto", transform: "translate(-50%, -100%)",
            background: "white", borderRadius: 12, boxShadow: "0 8px 28px #0005", color: "#17202b",
            padding: "14px 15px", pointerEvents: "auto" }}>
          <button type="button" onClick={() => setPopup(null)} aria-label="Close popup"
            style={{ position: "absolute", top: 5, right: 8, fontSize: 19, lineHeight: 1,
              border: 0, background: "transparent", cursor: "pointer", color: "#475569" }}>×</button>
          <div style={{ paddingRight: 12 }}>
            {popup.kind === "stop" && <StopBoard stop={popup.stop} />}
            {popup.kind === "bus" && <BusDetails vehicle={popup.vehicle} />}
            {popup.kind === "report" && <Ontario511Info item={popup.item} />}
            {popup.kind === "marker" && <div className="text-sm font-semibold">{popup.title}</div>}
            {popup.kind === "picker" && (
              <div className="min-w-[150px] text-slate-900">
                <div className="mb-2 text-xs font-semibold">Use this location</div>
                <div className="grid gap-1.5">
                  <button type="button" className="rounded-md bg-slate-100 px-2.5 py-1.5 text-left text-xs font-semibold hover:bg-green/15"
                    onClick={() => { callbacks.current.onSetMapStart?.(popup.location); setPopup(null); }}>Set as start</button>
                  <button type="button" className="rounded-md bg-slate-100 px-2.5 py-1.5 text-left text-xs font-semibold hover:bg-green/15"
                    onClick={() => { callbacks.current.onSetMapDestination?.(popup.location); setPopup(null); }}>Set as destination</button>
                </div>
                <div className="mt-2 text-[10px] opacity-60">{Number(popup.location[0]).toFixed(5)}, {Number(popup.location[1]).toFixed(5)}</div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
