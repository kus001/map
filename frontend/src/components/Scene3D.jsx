import { useEffect, useRef, useState } from "react";

// kmaps v10.20.9: native Esri aerial provider and OSM alignment comparison.
// Building coordinates are NEVER shifted to compensate for mismatched photos.
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
function coordsToCartesians(C, points) {
  return (points || []).filter(validLatLon).map(item => degreesPoint(C, item, 5));
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
  const point = ground || viewer.camera.pickEllipsoid(pixel) || viewer.camera.positionWC;
  if (!point) return null;
  const c = C.Cartographic.fromCartesian(point);
  return { lon: C.Math.toDegrees(c.longitude), lat: C.Math.toDegrees(c.latitude) };
}
function initialFocus(C, viewer, camera) {
  const [lon, lat] = Array.isArray(camera?.center) ? camera.center : TORONTO;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const pitch = Number.isFinite(camera?.pitch) ? camera.pitch : 48;
  const bearing = Number.isFinite(camera?.bearing) ? camera.bearing : 0;
  viewer.camera.setView({
    destination: C.Cartesian3.fromDegrees(lon, lat, cameraHeight(camera?.zoom ?? 13)),
    orientation: { heading: C.Math.toRadians(bearing), pitch: C.Math.toRadians(Math.max(-75, Math.min(-42, pitch - 90))), roll: 0 },
  });
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

// Return the providers in bottom-to-top order. OSM comparison is deliberately
// temporary; it never modifies the 3D building tileset or its geolocation.
async function imageryFor(C, style, compareOSM = false) {
  if (compareOSM || style === "street") {
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
  if (!context) return;
  const center = centerOfCamera(context.C, context.viewer);
  const inside = center && insideToronto(center.lon, center.lat);
  const useCity = Boolean(context.cityLoaded && inside);
  if (context.city) context.city.show = context.buildingsEnabled && useCity;
  if (context.osm) context.osm.show = context.buildingsEnabled && context.terrainReady && !useCity;
  context.viewer.scene.requestRender();
}

function floatingStyles(darkMode) {
  return {
    background: darkMode ? "rgba(16,24,32,.94)" : "rgba(250,251,251,.94)",
    color: darkMode ? "#e7f3ef" : "#21342b", border: "1px solid rgba(155,183,173,.35)",
    borderRadius: 12, padding: "10px 12px", boxShadow: "0 6px 22px #0003", fontSize: 12,
  };
}

export default function Scene3D({
  data, selectedRoute, selectedRouteNumber = 1, displayedMode, onSelectRoute,
  currentLocation, navigationActive, startCoordinate, destinationCoordinate, startLabel, destinationLabel,
  startDraggable, onSetMapStart, onSetMapDestination, onMoveStart, onMoveDestination,
  locationFocusKey, routeFocusKey, stepFocusCoordinate, stepFocusKey,
  mapStyle = "street", darkMode = true, globe, initialCamera, onCameraChange, onDisable3D,
  enabledLayers = [], onLayerStatus = () => {},
}) {
  const holder = useRef(null);
  const scene = useRef(null);
  const callbacks = useRef({});
  const routeData = useRef({});
  const [error, setError] = useState("");
  const [info, setInfo] = useState("Loading CesiumJS…");
  const [ready, setReady] = useState(false);
  const ionToken = CESIUM_ION_TOKEN;
  const torontoUrl = TORONTO_TILES_ENV || TORONTO_I3S_ENV;
  const [cityStatus, setCityStatus] = useState("Toronto 2025: not configured");
  const [osmStatus, setOsmStatus] = useState("OSM Buildings: waiting for token");
  const [buildingsOn, setBuildingsOn] = useState(true);
  const [terrainStatus, setTerrainStatus] = useState("Terrain: waiting for Cesium ion");
  const [compareOSM, setCompareOSM] = useState(false);
  const [imageryStatus, setImageryStatus] = useState("");
  const lastGlobeMode = useRef(null);
  const localView = useRef(null);
  const [menu, setMenu] = useState(null);
  const [tip, setTip] = useState("");
  const layersKey = enabledLayers.join("|");
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
        });
        viewer.scene.globe.enableLighting = false;
        viewer.scene.globe.showGroundAtmosphere = true;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
        if (viewer.scene.skyBox) viewer.scene.skyBox.show = true;
        viewer.scene.fog.enabled = true;
        viewer.scene.backgroundColor = C.Color.fromCssColorString("#c8ddeb");
        viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
        viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
        viewer.scene.screenSpaceCameraController.minimumZoomDistance = 2.5;
        viewer.scene.screenSpaceCameraController.maximumZoomDistance = 30_000_000;
        initialFocus(C, viewer, initialCameraRef.current);
        scene.current = { C, viewer, osm: null, city: null, cityLoaded: false,
          currentCityUrl: null, overlays: [], markers: [], dynamic: [], cityLoading: false,
          buildingGen: 0, buildingsEnabled: true, terrainReady: false, terrainProviderReady: false, terrainGen: 0, stops: [] };

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
          const coord = groundCoordinate(evt.position);
          if (!coord) return;
          setMenu({ x: evt.position.x, y: evt.position.y, point: coord });
        }, C.ScreenSpaceEventType.RIGHT_CLICK);
        handler.setInputAction(evt => {
          setMenu(null);
          const picked = viewer.scene.pick(evt.position);
          const entity = picked?.id;
          if (entity?.kmapsRoute) callbacks.current.onSelectRoute?.(entity.kmapsRoute);
          if (entity?.kmapsStop) {
            const label = entity.kmapsStop.name || "Transit stop";
            setTip(`${label} · ${entity.kmapsStop.agency || "Transit"}`);
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
          const pos = groundCoordinate(evt.endPosition);
          if (pos) setTip(`Move ${drag === "start" ? "start" : "destination"}: ${pos[0].toFixed(5)}, ${pos[1].toFixed(5)}`);
        }, C.ScreenSpaceEventType.MOUSE_MOVE);
        handler.setInputAction(evt => {
          if (!drag) return;
          const pos = groundCoordinate(evt.position);
          if (pos) (drag === "start" ? callbacks.current.onMoveStart : callbacks.current.onMoveDestination)?.(pos);
          drag = null;
          viewer.scene.screenSpaceCameraController.enableRotate = true;
          setTip("");
        }, C.ScreenSpaceEventType.LEFT_UP);
        changed = () => {
          const current = scene.current;
          if (!current || current.viewer !== viewer) return;
          const center = centerOfCamera(C, viewer);
          const height = C.Cartographic.fromCartesian(viewer.camera.positionWC)?.height;
          if (center && Number.isFinite(height)) {
            callbacks.current.onCameraChange?.({ center: [center.lon, center.lat], zoom: inferredZoom(height),
              pitch: C.Math.toDegrees(viewer.camera.pitch) + 90, bearing: C.Math.toDegrees(viewer.camera.heading) });
            syncBuildings(current);
          }
        };
        viewer.camera.moveEnd.addEventListener(changed);
        setReady(true);
        setError("");
        setInfo("Cesium 3D ready · waiting for aligned terrain and buildings");
      } catch (e) { if (!disposed) { setError(String(e.message || e)); setInfo(""); } }
    })();
    return () => {
      disposed = true;
      setReady(false);
      if (handler && !handler.isDestroyed()) handler.destroy();
      if (viewer) {
        if (changed) viewer.camera.moveEnd.removeEventListener(changed);
        if (!viewer.isDestroyed()) viewer.destroy();
      }
      if (scene.current?.viewer === viewer) scene.current = null;
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
      setTerrainStatus("Terrain unavailable: add VITE_CESIUM_ION_TOKEN with asset 1 access");
      return;
    }
    let cancelled = false;
    let removeLoadListener = null;
    let removePostListener = null;
    let removeTerrainError = null;
    setTerrainStatus("Loading Cesium World Terrain…");
    (async () => {
      try {
        const provider = await C.CesiumTerrainProvider.fromIonAssetId(1, { requestVertexNormals: false });
        if (cancelled || scene.current !== context || version !== context.terrainGen) return;
        viewer.terrainProvider = provider;
        removeTerrainError = provider.errorEvent?.addEventListener(error => {
          if (cancelled || scene.current !== context || version !== context.terrainGen) return;
          context.terrainProviderReady = false;
          context.terrainReady = false;
          setTerrainStatus(`Terrain tile error: ${String(error.message || error).slice(0, 85)}. OSM hidden to prevent floating buildings.`);
          syncBuildings(context);
        });
        context.terrainProviderReady = true;
        setTerrainStatus("Loading ground elevations…");
        // Wait until the ground tiles are actually displayed before revealing OSM buildings.
        const finishIfLoaded = () => {
          if (cancelled || scene.current !== context || version !== context.terrainGen || !context.terrainProviderReady) return;
          if (!viewer.scene.globe.tilesLoaded) return;
          context.terrainReady = true;
          setTerrainStatus("Cesium World Terrain: ready");
          if (context.osm) setOsmStatus("Cesium OSM Buildings: loaded worldwide");
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
        setTerrainStatus(`Terrain unavailable: ${String(e.message || e).slice(0, 110)}. OSM hidden to prevent floating buildings.`);
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
      setOsmStatus("OSM Buildings: set VITE_CESIUM_ION_TOKEN in frontend/.env, then restart Vite");
      return;
    }
    setOsmStatus("Loading Cesium OSM Buildings…");
    (async () => {
      try {
        const previous = context.osm;
        const next = await C.createOsmBuildingsAsync();
        if (scene.current !== context || version !== context.buildingGen) { next.destroy(); return; }
        if (previous) viewer.scene.primitives.remove(previous);
        context.osm = viewer.scene.primitives.add(next);
        next.show = false;
        syncBuildings(context);
        setOsmStatus(context.terrainReady ? "Cesium OSM Buildings: loaded worldwide" : "OSM Buildings loaded · waiting for ground elevations");
        viewer.scene.requestRender();
      } catch (e) { if (scene.current === context && version === context.buildingGen) setOsmStatus(`OSM Buildings unavailable: ${e.message}`); }
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
    if (!cityUrl) { setCityStatus("Toronto 2025: not configured (OSM fallback)"); return; }
    let cancelled = false;
    const currentUrl = cityUrl;
    context.currentCityUrl = cityUrl;
    setCityStatus("Toronto 2025: checking source…");
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
          : await C.Cesium3DTileset.fromUrl(cityUrl, { maximumScreenSpaceError: 12 });
        if (cancelled || scene.current !== context || context.currentCityUrl !== currentUrl) {
          tiles.destroy?.(); return;
        }
        if (context.city) viewer.scene.primitives.remove(context.city);
        context.city = viewer.scene.primitives.add(tiles);
        context.cityLoaded = true;
        syncBuildings(context);
        setCityStatus(`Toronto 2025 massing: ${type === "i3s" ? "I3S" : "3D Tiles"} loaded`);
        viewer.scene.requestRender();
      } catch (e) {
        if (cancelled || scene.current !== context) return;
        context.cityLoaded = false;
        setCityStatus(`Toronto 2025 unavailable: ${String(e.message || e).slice(0, 115)} · OSM fallback`);
        const old = context.city;
        context.city = null;
        if (old) viewer.scene.primitives.remove(old);
        syncBuildings(context);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, torontoUrl]);

  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    current.buildingsEnabled = buildingsOn;
    syncBuildings(current);
  }, [ready, buildingsOn]);

  // Alignment check: compare building positions against OSM's own streets.
  // Satellite orthophotos and OSM building footprints may be from different
  // years or have different local mapping accuracy. NEVER globally offset OSM.
  useEffect(() => {
    const context = scene.current;
    if (!ready || !context) return;
    const { viewer, C } = context;
    let cancelled = false;
    const activeSource = compareOSM ? "OpenStreetMap reference" : mapStyle === "street" ? "OpenStreetMap streets" : "Esri World Imagery";
    setImageryStatus(`Loading ${activeSource}…`);
    (async () => {
      try {
        const providers = await imageryFor(C, mapStyle, compareOSM);
        if (cancelled || scene.current !== context || viewer.isDestroyed()) return;
        // Swap only after metadata/provider setup finishes, so a slow Esri
        // response cannot erase a newer OSM comparison selection.
        viewer.imageryLayers.removeAll();
        for (const provider of providers) viewer.imageryLayers.addImageryProvider(provider);
        setImageryStatus(activeSource);
        viewer.scene.requestRender();
      } catch (e) {
        if (cancelled) return;
        setImageryStatus(`Imagery error: ${String(e.message || e).slice(0, 90)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, mapStyle, compareOSM]);

  // Globe button zooms out to a globe view and back; it no longer morphs to
  // Columbus View, because that projection removes Cesium's sky atmosphere.
  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { viewer, C } = current;
    if (lastGlobeMode.current === globe) return;
    const previous = lastGlobeMode.current;
    lastGlobeMode.current = globe;
    if (globe) {
      const location = centerOfCamera(C, viewer);
      if (location) localView.current = {
        center: [location.lon, location.lat],
        range: Math.max(400, C.Cartographic.fromCartesian(viewer.camera.positionWC).height),
        heading: viewer.camera.heading,
      };
      const target = localView.current?.center || initialCameraRef.current?.center || TORONTO;
      viewer.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(target[0], target[1]), 1), {
        offset: new C.HeadingPitchRange(0, C.Math.toRadians(-85), 5_500_000), duration: previous === null ? 0 : 1.2,
      });
    } else if (previous === true && localView.current) {
      const saved = localView.current;
      viewer.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(saved.center[0], saved.center[1]), 1), {
        offset: new C.HeadingPitchRange(saved.heading, C.Math.toRadians(-52), Math.max(500, saved.range)), duration: 1.0,
      });
    }
    viewer.scene.requestRender();
  }, [ready, globe]);

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
    function marker(pair, text, kind, color) {
      if (!validLatLon(pair)) return;
      const entity = viewer.entities.add({
        position: degreesPoint(C, pair, 3),
        point: { pixelSize: 13, color: css(C, color), outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: C.HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text, font: "bold 13px system-ui", fillColor: C.Color.WHITE,
          style: C.LabelStyle.FILL_AND_OUTLINE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          pixelOffset: new C.Cartesian2(0, -23), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      entity.kmapsMarker = kind;
      current.markers.push(entity);
    }
    if (!navigationActive) marker(startCoordinate || data?.start?.coordinates, "A", "start", "#5cb78a");
    marker(destinationCoordinate || data?.end?.coordinates, "B", "end", "#ee6d5e");
    marker(currentLocation, "●", "location", "#4ba4fc");
    for (const vehicle of route?.live_vehicles || []) {
      if (Number.isFinite(Number(vehicle.lat)) && Number.isFinite(Number(vehicle.lon))) marker([vehicle.lat, vehicle.lon], "BUS", "bus", "#f2aa66");
    }
    viewer.scene.requestRender();
  }, [ready, route, startCoordinate, destinationCoordinate, currentLocation, data, navigationActive]);

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
      controller?.abort();
      controller = new AbortController();
      const center = centerOfCamera(C, viewer);
      if (!center) return;
      const span = Math.max(0.05, Math.min(1.0, C.Cartographic.fromCartesian(viewer.camera.positionWC).height / 30000));
      const bbox = [center.lon-span,center.lat-span*0.7,center.lon+span,center.lat+span*0.7].map(n=>n.toFixed(4)).join(",");
      for (const entity of current.dynamic) viewer.entities.remove(entity);
      current.dynamic = [];
      for (const kind of kinds) {
        if (!active.has(kind)) continue;
        try {
          const response = await fetch(`/api/layers/ontario511?${new URLSearchParams({kind,bbox})}`, {signal:controller.signal});
          if (!response.ok) throw new Error("Unavailable");
          const payload = await response.json();
          if (cancelled || !scene.current || controller.signal.aborted) return;
          callbacks.current.onLayerStatus?.(kind, payload.message || "");
          for (const item of (payload.items || []).slice(0, 150)) {
            if (!validLatLon(item.point)) continue;
            const color = { incidents: "#f26c65", construction: "#e3ac58", cameras: "#6ca7ff", winter: "#90b7df" }[kind];
            current.dynamic.push(viewer.entities.add({
              position: degreesPoint(C, item.point, 1),
              point: { pixelSize: 9, color: css(C, color), outlineColor: C.Color.WHITE, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
              label: { text: (item.title || kind).slice(0, 32), font: "11px system-ui", pixelOffset: new C.Cartesian2(0, -15), fillColor: C.Color.WHITE,
                style: C.LabelStyle.FILL_AND_OUTLINE, outlineColor: C.Color.BLACK, outlineWidth: 2, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 8000) },
              description: item.summary || item.details || item.title || kind,
            }));
          }
        } catch (e) { if (e.name !== "AbortError") callbacks.current.onLayerStatus?.(kind, "Unavailable in 3D"); }
      }
      viewer.scene.requestRender();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(redraw, 550); };
    viewer.camera.moveEnd.addEventListener(schedule);
    schedule();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); viewer.camera.moveEnd.removeEventListener(schedule);
      for (const entity of current.dynamic) if (!viewer.isDestroyed()) viewer.entities.remove(entity); current.dynamic = []; };
  }, [ready, layersKey]);

  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    let traffic = null;
    if (enabledLayers.includes("traffic")) {
      traffic = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: `/api/layers/traffic/tile/{z}/{x}/{y}.png?style=${darkMode ? "dark" : "light"}`, maximumLevel: 20,
      }));
      traffic.alpha = 0.77;
    }
    return () => { if (traffic && !viewer.isDestroyed()) viewer.imageryLayers.remove(traffic); };
  }, [ready, layersKey, darkMode, mapStyle, enabledLayers]);

  // Nearby transit stops remain usable in the Cesium scene at street-level zoom.
  useEffect(() => {
    const current = scene.current;
    if (!ready || !current) return;
    const { C, viewer } = current;
    let cancelled = false, timeout, controller;
    const refresh = () => {
      clearTimeout(timeout);
      timeout = setTimeout(async () => {
        controller?.abort();
        controller = new AbortController();
        for (const entity of current.stops) viewer.entities.remove(entity);
        current.stops = [];
        if (mode !== "transit") return;
        const center = centerOfCamera(C, viewer);
        const range = C.Cartographic.fromCartesian(viewer.camera.positionWC).height;
        if (!center || range > 1750) return;
        try {
          const query = new URLSearchParams({ lat: String(center.lat), lon: String(center.lon), radius: "900" });
          const result = await fetch(`/api/transit/stops?${query}`, { signal: controller.signal }).then(r => r.json());
          if (cancelled || controller.signal.aborted) return;
          for (const stop of (result.stops || []).slice(0, 120)) {
            if (!validLatLon(stop.coordinates)) continue;
            const entity = viewer.entities.add({
              position: degreesPoint(C, stop.coordinates, 2),
              point: { pixelSize: 7, color: C.Color.fromCssColorString("#a888f2"),
                outlineColor: C.Color.WHITE, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
            });
            entity.kmapsStop = stop;
            current.stops.push(entity);
          }
          viewer.scene.requestRender();
        } catch (e) { if (e.name !== "AbortError") console.debug("3D transit stops unavailable", e); }
      }, 350);
    };
    viewer.camera.moveEnd.addEventListener(refresh);
    refresh();
    return () => { cancelled = true; clearTimeout(timeout); controller?.abort();
      viewer.camera.moveEnd.removeEventListener(refresh);
      if (!viewer.isDestroyed()) for (const entity of current.stops) viewer.entities.remove(entity);
      current.stops = [];
    };
  }, [ready, mode]);

  const reset = () => {
    const current = scene.current;
    if (!current) return;
    initialFocus(current.C, current.viewer, initialCameraRef.current);
  };
  const recenterToronto = () => {
    const current = scene.current;
    if (!current) return;
    flyTo(current.C, current.viewer, [TORONTO[1], TORONTO[0]], 2200);
  };

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: darkMode ? "#101b27" : "#e2eef7" }}>
      <div ref={holder} style={{ position: "absolute", inset: 0 }} aria-label="Cesium 3D globe and Toronto building massing" />
      <div style={{ position: "absolute", right: 12, top: 14, zIndex: 490, maxWidth: "min(340px, 75vw)", ...floatingStyles(darkMode) }}>
        <strong>Cesium 3D · v10.20.9</strong>
        <div style={{ marginTop: 5, fontSize: 11, opacity: .82 }}>{error || (ready ? osmStatus : info)}</div>
        {ready && <div style={{ marginTop: 4, fontSize: 11, opacity: .82 }}>{terrainStatus}</div>}
        {ready && <div style={{ marginTop: 4, fontSize: 11, opacity: .82 }}>{cityStatus}</div>}
        {ready && <div style={{ marginTop: 4, fontSize: 11, opacity: .82 }}>{imageryStatus}</div>}
        {!ionToken && <div style={{ marginTop: 6 }}>Add VITE_CESIUM_ION_TOKEN to map/frontend/.env and restart Vite to enable OSM Buildings.</div>}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <button type="button" onClick={recenterToronto} style={{ padding: "3px 6px", background: "#407a62", borderRadius: 5, color: "white" }}>Toronto</button>
          <button type="button" onClick={reset} style={{ padding: "3px 6px" }}>Reset</button>
          <button type="button" onClick={() => setBuildingsOn(v => !v)} style={{ padding: "3px 6px" }}>Buildings {buildingsOn ? "on" : "off"}</button>
          <button type="button" aria-pressed={compareOSM} onClick={() => setCompareOSM(v => !v)} style={{ padding: "3px 6px", borderRadius: 5, background: compareOSM ? "#407a62" : "transparent", color: compareOSM ? "white" : "inherit" }}>{compareOSM ? "Back to aerial" : "Compare OSM"}</button>
        </div>
        {compareOSM && <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.4, opacity: .86 }}>Compare the grey buildings with OSM streets. If they align here but not with aerial imagery, the datasets likely differ in date or registration. No model coordinates have been changed.</div>}
        {tip && <div style={{ fontSize: 11, marginTop: 6 }}>{tip}</div>}
        {error && <button type="button" onClick={onDisable3D} style={{ marginTop: 8, textDecoration: "underline" }}>Return to 2D</button>}
      </div>
      {menu && <div style={{ position: "absolute", left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 90), zIndex: 491, ...floatingStyles(darkMode), display: "grid", gap: 4 }}>
        <button type="button" onClick={() => { callbacks.current.onSetMapStart?.(menu.point); setMenu(null); }}>Set as start</button>
        <button type="button" onClick={() => { callbacks.current.onSetMapDestination?.(menu.point); setMenu(null); }}>Set as destination</button>
        <button type="button" onClick={() => setMenu(null)}>Cancel</button>
      </div>}
    </div>
  );
}
