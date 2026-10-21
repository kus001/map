import { TORONTO_ORIGIN, toLocalMetres } from "./buildingMesh.mjs";

// Only imagery has geographic tiles. The building meshes keep their fixed local coordinates.
const EARTH = 6378137;
const DEG = Math.PI / 180;
const GROUND_HALF_SIZE = 1250;
const SATELLITE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export function satelliteTileURL(z, x, y, template = SATELLITE_URL) {
  return template.replaceAll("{z}", String(z)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y));
}
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = (lon + 180) / 360 * n;
  const sine = Math.sin(latitude * DEG);
  const y = (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * n;
  return [x, y];
}
export function tileCorner(x, y, z) {
  const n = 2 ** z;
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / DEG];
}
export function sceneToLonLat(x, z) {
  return [TORONTO_ORIGIN.lon + x / (EARTH * DEG * Math.cos(TORONTO_ORIGIN.lat * DEG)),
    TORONTO_ORIGIN.lat - z / (EARTH * DEG)];
}
export function tilesForSquare(centerX, centerZ, halfSize, zoom) {
  const [west, north] = sceneToLonLat(centerX - halfSize, centerZ - halfSize);
  const [east, south] = sceneToLonLat(centerX + halfSize, centerZ + halfSize);
  const [xMin, yMin] = lonLatToTile(west, north, zoom);
  const [xMax, yMax] = lonLatToTile(east, south, zoom);
  const tiles = [];
  for (let y = Math.floor(yMin); y <= Math.floor(yMax); y++) {
    for (let x = Math.floor(xMin); x <= Math.floor(xMax); x++) {
      const [lon0, lat0] = tileCorner(x, y, zoom);
      const [lon1, lat1] = tileCorner(x + 1, y + 1, zoom);
      const nw = toLocalMetres([lon0, lat0], TORONTO_ORIGIN);
      const se = toLocalMetres([lon1, lat1], TORONTO_ORIGIN);
      // Don't render imagery outside our finite sample area.
      if (nw[0] > GROUND_HALF_SIZE || se[0] < -GROUND_HALF_SIZE || nw[1] > GROUND_HALF_SIZE || se[1] < -GROUND_HALF_SIZE) continue;
      tiles.push({ key: `${zoom}/${x}/${y}`, zoom, x, y, west: nw[0], north: nw[1], east: se[0], south: se[1] });
    }
  }
  return tiles;
}
export function satelliteTileVertices(tile) {
  const { west, east, north, south, zoom } = tile;
  // Higher resolution imagery sits just above coarser imagery, below roads and parks.
  const elevation = zoom >= 19 ? -0.106 : zoom >= 18 ? -0.110 : -0.115;
  const nw = [west, elevation, north], ne = [east, elevation, north];
  const sw = [west, elevation, south], se = [east, elevation, south];
  // Textures use UNPACK_FLIP_Y_WEBGL=true: v=0 corresponds to the image's top edge.
  const vertices = [];
  for (const [p, uv] of [[nw,[0,0]],[sw,[0,1]],[se,[1,1]], [nw,[0,0]],[se,[1,1]],[ne,[1,0]]]) {
    vertices.push(...p, ...uv, 0, 1, 0);
  }
  return vertices;
}
export function desiredSatelliteTiles(distance, target) {
  const result = tilesForSquare(0, 0, GROUND_HALF_SIZE, 16);
  if (distance < 600) result.push(...tilesForSquare(target[0], target[2], Math.max(170, Math.min(320, distance * 0.70)), 18));
  if (distance < 115) result.push(...tilesForSquare(target[0], target[2], Math.max(70, Math.min(135, distance * 1.15)), 19));
  return result;
}
