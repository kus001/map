const facades = ["glass", "brick", "concrete", "stone", "metal", "wood", "plaster", "plain", "default"];

export const buildings = [
  { x: -62, z: -50, w: 23, d: 21, h: 24, material: "brick" },
  { x: -31, z: -51, w: 20, d: 23, h: 38, material: "stone" },
  { x: 1, z: -54, w: 26, d: 25, h: 78, material: "glass" },
  { x: 37, z: -52, w: 25, d: 21, h: 43, material: "metal" },
  { x: 73, z: -48, w: 19, d: 22, h: 18, material: "plaster" },
  { x: -66, z: -10, w: 24, d: 24, h: 27, material: "wood" },
  { x: -28, z: -15, w: 20, d: 27, h: 53, material: "concrete" },
  { x: 6, z: -9, w: 18, d: 24, h: 125, material: "glass" },
  { x: 41, z: -10, w: 24, d: 26, h: 73, material: "default" },
  { x: 79, z: -8, w: 24, d: 21, h: 28, material: "brick" },
  { x: -64, z: 32, w: 25, d: 22, h: 32, material: "concrete" },
  { x: -28, z: 31, w: 19, d: 24, h: 46, material: "glass" },
  { x: 9, z: 36, w: 22, d: 23, h: 30, material: "stone" },
  { x: 44, z: 35, w: 22, d: 19, h: 22, material: "wood" },
  { x: 83, z: 34, w: 22, d: 24, h: 17, material: "plaster" },
];

// Keep each building's look stable. None of this depends on camera or frame time.
function hashId(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const MATERIAL_WEIGHTS = [
  [65, ["glass", "glass", "glass", "metal", "metal", "concrete", "stone"]],
  [30, ["glass", "glass", "metal", "concrete", "concrete", "stone", "stone", "brick"]],
  [15, ["glass", "concrete", "concrete", "stone", "stone", "brick", "brick", "plaster"]],
  [0, ["brick", "brick", "stone", "concrete", "plaster", "plaster", "wood", "default"]],
];

export function chooseBuildingAppearance(identity, height) {
  const hash = hashId(identity);
  const pool = MATERIAL_WEIGHTS.find(([minimum]) => height >= minimum)[1];
  return { material: pool[hash % pool.length], variant: (hash >>> 8) % 5 };
}

const addTriangle = (vertices, a, b, c, uva, uvb, uvc, normal) => {
  for (const [position, uv] of [[a, uva], [b, uvb], [c, uvc]]) {
    vertices.push(...position, ...uv, ...normal);
  }
};

// One small HVAC unit on a sufficiently wide, exposed roof triangle.
// It sits inside the triangle rather than outside concave Toronto footprints.
function addRoofUnit(group, triangles, height) {
  if (height < 12 || !triangles.length) return;
  let best = null;
  for (const [a, b, c] of triangles) {
    const ab = Math.hypot(a[0]-b[0], a[1]-b[1]);
    const bc = Math.hypot(b[0]-c[0], b[1]-c[1]);
    const ca = Math.hypot(c[0]-a[0], c[1]-a[1]);
    const area = Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
    const perimeter = ab+bc+ca;
    const radius = perimeter > 0 ? 2*area/perimeter : 0;
    if (!best || radius > best.radius) {
      const cx=(bc*a[0]+ca*b[0]+ab*c[0])/perimeter;
      const cz=(bc*a[1]+ca*b[1]+ab*c[1])/perimeter;
      best={cx,cz,radius};
    }
  }
  if (!best || best.radius < 2.2) return;
  const half = Math.min(2.25, best.radius*0.38);
  const x=best.cx, z=best.cz, y=height+0.035, top=y+Math.min(1.25,half*0.8);
  const corners=[[x-half,z-half*0.65],[x+half,z-half*0.65],[x+half,z+half*0.65],[x-half,z+half*0.65]];
  for(let i=0;i<4;i++){
    const a=corners[i],b=corners[(i+1)%4];
    const edge=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const normal=[(b[1]-a[1])/edge,0,-(b[0]-a[0])/edge];
    const loA=[a[0],y,a[1]],loB=[b[0],y,b[1]],hiA=[a[0],top,a[1]],hiB=[b[0],top,b[1]];
    addTriangle(group.details,loA,loB,hiB,[0,0],[1,0],[1,1],normal);
    addTriangle(group.details,loA,hiB,hiA,[0,0],[1,1],[0,1],normal);
  }
  const v=corners.map(([a,b])=>[a,top,b]);
  addTriangle(group.details,v[0],v[2],v[1],[0,0],[1,1],[1,0],[0,1,0]);
  addTriangle(group.details,v[0],v[3],v[2],[0,0],[0,1],[1,1],[0,1,0]);
}

export function createBuildingMesh(items = buildings) {
  const surfaces = new Map(facades.map(name => [name, { walls: [], roofs: [], details: [] }]));
  for (const item of items) {
    const x = item.x;
    const z = item.z;
    const x2 = x + item.w;
    const z2 = z + item.d;
    const h = item.h;
    const group = surfaces.get(item.material) || surfaces.get("default");
    const points = [[x, z], [x2, z], [x2, z2], [x, z2]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[(i + 1) % 4];
      const length = Math.hypot(bx - ax, bz - az);
      const normal = [(bz - az) / length, 0, -(bx - ax) / length];
      const a = [ax, 0, az], b = [bx, 0, bz];
      const topA = [ax, h, az], topB = [bx, h, bz];
      const u = length / 9;
      const v = h / 9;
      addTriangle(group.walls, a, b, topB, [0, 0], [u, 0], [u, v], normal);
      addTriangle(group.walls, a, topB, topA, [0, 0], [u, v], [0, v], normal);
    }
    const corners = [[x, h, z], [x2, h, z], [x2, h, z2], [x, h, z2]];
    addTriangle(group.roofs, corners[0], corners[2], corners[1], [0, 0], [1, 1], [1, 0], [0, 1, 0]);
    addTriangle(group.roofs, corners[0], corners[3], corners[2], [0, 0], [0, 1], [1, 1], [0, 1, 0]);
    addRoofUnit(group, [[points[0],points[1],points[2]], [points[0],points[2],points[3]]], h);
  }
  return surfaces;
}

export function sceneStats(items = buildings) {
  const mesh = createBuildingMesh(items);
  return {
    buildings: items.length,
    wallTriangles: [...mesh.values()].reduce((count, part) => count + part.walls.length / 24, 0),
    roofTriangles: [...mesh.values()].reduce((count, part) => count + part.roofs.length / 24, 0),
    materials: [...mesh.entries()].filter(([, part]) => part.walls.length > 0).map(([name]) => name),
  };
}

// Toronto uses geographic polygons instead of the sample rectangles.
export const TORONTO_ORIGIN = Object.freeze({ lat: 43.65135, lon: -79.3819 });
const RADIANS = Math.PI / 180;
const EARTH_RADIUS = 6378137;

export function toLocalMetres(point, origin = TORONTO_ORIGIN) {
  const [lon, lat] = point;
  return [
    (lon - origin.lon) * RADIANS * EARTH_RADIUS * Math.cos(origin.lat * RADIANS),
    -(lat - origin.lat) * RADIANS * EARTH_RADIUS,
  ];
}

function ringLonLatBounds(raw) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const point of raw || []) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    minLon = Math.min(minLon, point[0]); maxLon = Math.max(maxLon, point[0]);
    minLat = Math.min(minLat, point[1]); maxLat = Math.max(maxLat, point[1]);
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, maxLon, minLat, maxLat, lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
}

function insideGeoBox(point, box) {
  return point && point.lon >= box.minLon && point.lon <= box.maxLon && point.lat >= box.minLat && point.lat <= box.maxLat;
}

function rectPoints(minX, minZ, maxX, maxZ) {
  return [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
}

function insetBoundsRect(box, fx0, fz0, fx1, fz1) {
  const x0 = box.minX + (box.maxX - box.minX) * fx0;
  const x1 = box.minX + (box.maxX - box.minX) * fx1;
  const z0 = box.minZ + (box.maxZ - box.minZ) * fz0;
  const z1 = box.minZ + (box.maxZ - box.minZ) * fz1;
  return rectPoints(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function surroundInnerRect(box, inner, minSpan = 4.0) {
  const pieces = [];
  const add = (x0, z0, x1, z1) => {
    const width = Math.abs(x1 - x0), depth = Math.abs(z1 - z0);
    if (width < minSpan || depth < minSpan) return;
    pieces.push(rectPoints(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)));
  };
  add(box.minX, box.minZ, box.maxX, inner.minZ);
  add(box.minX, inner.maxZ, box.maxX, box.maxZ);
  add(box.minX, inner.minZ, inner.minX, inner.maxZ);
  add(inner.maxX, inner.minZ, box.maxX, inner.maxZ);
  return pieces;
}

function innerRectFromFractions(box, fx0, fz0, fx1, fz1, margin = 2.0) {
  const minX = box.minX + (box.maxX - box.minX) * clamp01(fx0) + margin;
  const maxX = box.minX + (box.maxX - box.minX) * clamp01(fx1) - margin;
  const minZ = box.minZ + (box.maxZ - box.minZ) * clamp01(fz0) + margin;
  const maxZ = box.minZ + (box.maxZ - box.minZ) * clamp01(fz1) - margin;
  return { minX: Math.min(minX, maxX), minZ: Math.min(minZ, maxZ), maxX: Math.max(minX, maxX), maxZ: Math.max(minZ, maxZ) };
}

function footprintMetrics(points) {
  const box = bounds(points);
  return { box, width: box.maxX - box.minX, depth: box.maxZ - box.minZ, area: Math.abs(polygonArea(points)) };
}

const LANDMARK_ZONES = {
  eaton: { minLon: -79.3826, maxLon: -79.3781, minLat: 43.6512, maxLat: 43.6549 },
  sheraton: { minLon: -79.3847, maxLon: -79.3810, minLat: 43.6496, maxLat: 43.6525 },
  nathanPhillips: { minLon: -79.3852, maxLon: -79.3822, minLat: 43.6515, maxLat: 43.6535 },
};

function createRefinedLandmarkParts(footprint, height, look, centroid, identity, measuredHeight) {
  const { box, width, depth, area } = footprintMetrics(footprint);
  const tallEnough = height > 32;

  // Decorative arches at Nathan Phillips Square are not facade-bearing buildings.
  if (insideGeoBox(centroid, LANDMARK_ZONES.nathanPhillips) && area < 240 && Math.min(width, depth) < 5.5 && Math.max(width, depth) > 20) {
    return [{ id: `${identity}:arch`, points: footprint, h: Math.min(height, 11), material: "plain", variant: 0, measuredHeight, skipRoofUnit: true }];
  }

  // The previous patch broke roofs by stacking overlapping masses.
  // Use only conservative, non-overlapping box pieces for the biggest known offenders.

  if (insideGeoBox(centroid, LANDMARK_ZONES.eaton) && area > 7000 && width > 80 && depth > 45 && tallEnough) {
    const podiumHeight = Math.max(18, Math.min(28, height * 0.32));
    const towerBox = innerRectFromFractions(box, 0.58, 0.10, 0.86, 0.44, 1.8);
    const podiumPieces = surroundInnerRect(box, towerBox, 6.0);
    const pieces = podiumPieces.map((points, index) => ({
      id: `${identity}:podium:${index}`, points, h: podiumHeight, material: 'stone', variant: look.variant, measuredHeight, skipRoofUnit: false
    }));
    pieces.push({ id: `${identity}:tower`, points: rectPoints(towerBox.minX, towerBox.minZ, towerBox.maxX, towerBox.maxZ), h: height, material: 'glass', variant: (look.variant + 1) % 5, measuredHeight, skipRoofUnit: false });
    return pieces;
  }

  if (insideGeoBox(centroid, LANDMARK_ZONES.sheraton) && area > 4500 && width > 55 && depth > 35 && tallEnough) {
    const podiumHeight = Math.max(16, Math.min(24, height * 0.30));
    const towerBox = innerRectFromFractions(box, 0.63, 0.08, 0.89, 0.58, 1.8);
    const podiumPieces = surroundInnerRect(box, towerBox, 5.5);
    const pieces = podiumPieces.map((points, index) => ({
      id: `${identity}:podium:${index}`, points, h: podiumHeight, material: 'stone', variant: look.variant, measuredHeight, skipRoofUnit: false
    }));
    pieces.push({ id: `${identity}:tower`, points: rectPoints(towerBox.minX, towerBox.minZ, towerBox.maxX, towerBox.maxZ), h: height, material: 'concrete', variant: look.variant, measuredHeight, skipRoofUnit: false });
    return pieces;
  }

  return null;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function triangleArea(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function cleanRing(raw) {
  if (!Array.isArray(raw)) return [];
  const points = [];
  for (const item of raw) {
    if (!Array.isArray(item) || !item.every(Number.isFinite)) continue;
    if (!points.length || Math.hypot(item[0] - points.at(-1)[0], item[1] - points.at(-1)[1]) > 0.035) {
      points.push(item.slice(0, 2));
    }
  }
  if (points.length > 2 && Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]) < 0.035) points.pop();
  for (let pass = 0; pass < 2 && points.length > 3; pass++) {
    for (let i = points.length - 1; i >= 0; i--) {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[i], c = points[(i + 1) % points.length];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (l1 < 0.07 || l2 < 0.07 || Math.abs(triangleArea(a, b, c)) / (l1 * l2) < 0.00015) points.splice(i, 1);
    }
  }
  if (polygonArea(points) < 0) points.reverse();
  return points;
}

function insideTriangle(p, a, b, c) {
  const t1 = triangleArea(a, b, p), t2 = triangleArea(b, c, p), t3 = triangleArea(c, a, p);
  return t1 >= -0.0001 && t2 >= -0.0001 && t3 >= -0.0001;
}

// Ear clipping works for concave roof outlines too. Courtyard holes are a later milestone.
export function triangulateRoof(points) {
  const order = points.map((_, i) => i);
  const triangles = [];
  let attempts = 0;
  while (order.length > 3 && attempts++ < points.length * points.length) {
    let clipped = false;
    for (let i = 0; i < order.length; i++) {
      const ia = order[(i - 1 + order.length) % order.length];
      const ib = order[i];
      const ic = order[(i + 1) % order.length];
      const a = points[ia], b = points[ib], c = points[ic];
      if (triangleArea(a, b, c) <= 0.0001) continue;
      if (order.some(index => index !== ia && index !== ib && index !== ic && insideTriangle(points[index], a, b, c))) continue;
      triangles.push([ia, ib, ic]);
      order.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return [];
  }
  if (order.length === 3) triangles.push(order);
  return triangles;
}

export function convertTorontoGeoJSON(geojson, origin = TORONTO_ORIGIN) {
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) throw new Error("Unexpected Toronto building data format");
  const result = [];
  let recordedHeights = 0;
  let estimatedHeights = 0;
  let skippedHoles = 0;
  const sharedLooks = new Map();
  for (const feature of geojson.features) {
    const geom = feature.geometry;
    if (!geom || !["Polygon", "MultiPolygon"].includes(geom.type)) continue;
    const properties = feature.properties || {};
    const heightValue = Number(properties.DERIVED_HEIGHT ?? properties.derived_height ?? properties.height);
    const heightKnown = Number.isFinite(heightValue) && heightValue >= 3 && heightValue <= 700;
    const height = heightKnown ? heightValue : 12;
    const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (let p = 0; p < polygons.length; p++) {
      const rings = polygons[p];
      if (!Array.isArray(rings) || !rings.length) continue;
      const outerRing = rings[0];
      const footprint = cleanRing(outerRing.map(point => toLocalMetres(point, origin)));
      if (footprint.length < 3 || footprint.length > 1000 || Math.abs(polygonArea(footprint)) < 18) continue;
      if (rings.length > 1) skippedHoles++;
      const id = properties.OBJECTID ?? feature.id ?? result.length;
      const buildingId = properties.BUILDINGID ?? properties.buildingid ?? id;
      const identity = String(buildingId).trim() || String(id);
      if (!sharedLooks.has(identity)) sharedLooks.set(identity, chooseBuildingAppearance(identity, height));
      const look = sharedLooks.get(identity);
      const centroid = ringLonLatBounds(outerRing);
      const refined = createRefinedLandmarkParts(footprint, height, look, centroid, `${id}:${p}`, heightKnown);
      if (refined?.length) {
        for (const piece of refined) result.push(piece);
      } else {
        result.push({ id: `${id}:${p}`, points: footprint, h: height, material: look.material,
          variant: look.variant, measuredHeight: heightKnown, skipRoofUnit: false });
      }
      if (heightKnown) recordedHeights++; else estimatedHeights++;
    }
  }
  return { buildings: result, recordedHeights, estimatedHeights, skippedHoles };
}

// One footprint can overlap several sections of the same building. Resolve the
// hidden walls and roofs before sending anything to WebGL.
const GEO_EPS = 0.00001;
const NEAR_EDGE = 0.08;

function bounds(points) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

function boundsTouch(a, b, gap = 0) {
  return a.minX <= b.maxX + gap && a.maxX >= b.minX - gap &&
    a.minZ <= b.maxZ + gap && a.maxZ >= b.minZ - gap;
}

function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onEdge(p, a, b, tolerance = NEAR_EDGE) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length2 = dx * dx + dz * dz;
  if (!length2) return false;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length2;
  if (t < -0.0001 || t > 1.0001) return false;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz) <= tolerance;
}

function insideFootprint(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onEdge(point, a, b, 0.0001)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function overlapCandidates(items) {
  const boxes = items.map(item => bounds(item.points));
  const neighbours = items.map(() => []);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!boundsTouch(boxes[i], boxes[j], 0.25)) continue;
      neighbours[i].push(j);
      neighbours[j].push(i);
    }
  }
  return { boxes, neighbours };
}

function edgeBreaks(a, b, polygon) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length2 = dx * dx + dz * dz;
  const breaks = [];
  for (let i = 0; i < polygon.length; i++) {
    const c = polygon[i], d = polygon[(i + 1) % polygon.length];
    const ex = d[0] - c[0], ez = d[1] - c[1];
    const denominator = dx * ez - dz * ex;
    const ax = c[0] - a[0], az = c[1] - a[1];
    if (Math.abs(denominator) < GEO_EPS) {
      if (Math.abs(dx * az - dz * ax) > GEO_EPS * Math.sqrt(length2)) continue;
      const t0 = (ax * dx + az * dz) / length2;
      const t1 = ((d[0] - a[0]) * dx + (d[1] - a[1]) * dz) / length2;
      if (t0 > 0 && t0 < 1) breaks.push(t0);
      if (t1 > 0 && t1 < 1) breaks.push(t1);
      continue;
    }
    const t = (ax * ez - az * ex) / denominator;
    const u = (ax * dz - az * dx) / denominator;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) breaks.push(t);
  }
  return breaks;
}

function wallSegments(item, index, items, neighbours) {
  const result = [];
  const points = item.points;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.08) continue;
    const normal = [dz / len, 0, -dx / len];
    const portions = [0, 1];
    for (const j of neighbours[index]) portions.push(...edgeBreaks(a, b, items[j].points));
    portions.sort((x, y) => x - y);
    const stops = portions.filter((t, n) => n === 0 || t - portions[n - 1] > 0.0000001);
    for (let s = 0; s < stops.length - 1; s++) {
      const t0 = stops[s], t1 = stops[s + 1];
      if ((t1 - t0) * len < 0.06) continue;
      const midpoint = [a[0] + dx * (t0 + t1) / 2, a[1] + dz * (t0 + t1) / 2];
      const outside = [midpoint[0] + normal[0] * 0.06, midpoint[1] + normal[2] * 0.06];
      const inside = [midpoint[0] - normal[0] * 0.06, midpoint[1] - normal[2] * 0.06];
      let base = 0;
      let hidden = false;
      for (const j of neighbours[index]) {
        const other = items[j];
        if (insideFootprint(outside, other.points)) {
          // The other building occupies the front of this wall.
          base = Math.max(base, other.h);
        } else if (insideFootprint(inside, other.points)) {
          // Same-facing, coplanar walls: only the taller building draws it.
          const sameLine = other.points.some((c, k) => onEdge(midpoint, c, other.points[(k + 1) % other.points.length]));
          if (sameLine && (other.h > item.h + 0.01 || (Math.abs(other.h - item.h) <= 0.01 && j < index))) {
            hidden = true;
            break;
          }
        }
      }
      if (hidden || base >= item.h - 0.01) continue;
      result.push({
        a: [a[0] + dx * t0, a[1] + dz * t0],
        b: [a[0] + dx * t1, a[1] + dz * t1],
        normal, base, top: item.h, u0: (t0 * len) / 9, u1: (t1 * len) / 9,
      });
    }
  }
  return result;
}

function clipHalfPlane(polygon, a, b, keepLeft) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i], next = polygon[(i + 1) % polygon.length];
    const d0 = cross2(a, b, current), d1 = cross2(a, b, next);
    const in0 = keepLeft ? d0 >= -GEO_EPS : d0 <= GEO_EPS;
    const in1 = keepLeft ? d1 >= -GEO_EPS : d1 <= GEO_EPS;
    if (in0) result.push(current);
    if (in0 !== in1) {
      const t = d0 / (d0 - d1);
      result.push([current[0] + (next[0] - current[0]) * t, current[1] + (next[1] - current[1]) * t]);
    }
  }
  return result;
}

function subtractTriangle(polygon, clip) {
  const remain = [];
  let inside = polygon;
  for (let i = 0; i < 3 && inside.length >= 3; i++) {
    const a = clip[i], b = clip[(i + 1) % 3];
    const outside = clipHalfPlane(inside, a, b, false);
    if (outside.length >= 3 && polygonArea(outside) > 0.005) remain.push(outside);
    inside = clipHalfPlane(inside, a, b, true);
  }
  return remain;
}

function roofTriangles(item, index, items, neighbours, trianglesByItem) {
  const points = item.points;
  const result = [];
  const clips = [];
  for (const j of neighbours[index]) {
    const other = items[j];
    if (other.h + 0.01 < item.h) continue;
    if (Math.abs(other.h - item.h) <= 0.01 && j > index) continue;
    for (const [ia, ib, ic] of trianglesByItem[j]) clips.push([other.points[ia], other.points[ib], other.points[ic]]);
  }
  for (const [ia, ib, ic] of trianglesByItem[index]) {
    let visible = [[points[ia], points[ib], points[ic]]];
    for (const clip of clips) {
      const clipBox = bounds(clip);
      visible = visible.flatMap(poly => boundsTouch(bounds(poly), clipBox) ? subtractTriangle(poly, clip) : [poly]);
      if (!visible.length) break;
    }
    for (const poly of visible) {
      for (let k = 1; k < poly.length - 1; k++) {
        if (triangleArea(poly[0], poly[k], poly[k + 1]) > 0.005) result.push([poly[0], poly[k], poly[k + 1]]);
      }
    }
  }
  return result;
}

export function createPolygonBuildingMesh(items) {
  const surfaces = new Map(facades.map(name => [name, { walls: [], roofs: [], details: [] }]));
  const { neighbours } = overlapCandidates(items);
  const trianglesByItem = items.map(item => triangulateRoof(item.points || []));
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const height = item.h;
    if (!item.points || item.points.length < 3 || !Number.isFinite(height) || height <= 0) continue;
    const material = facades.includes(item.material) ? item.material : "default";
    const variant = Number.isInteger(item.variant) ? Math.max(0, Math.min(4, item.variant)) : 0;
    const groupName = Number.isInteger(item.variant) ? `${material}:${variant}` : material;
    if (!surfaces.has(groupName)) surfaces.set(groupName, { walls: [], roofs: [], details: [] });
    const group = surfaces.get(groupName);
    for (const segment of wallSegments(item, index, items, neighbours)) {
      const { a, b, normal, base, top, u0, u1 } = segment;
      const lowerA = [a[0], base, a[1]], lowerB = [b[0], base, b[1]];
      const upperA = [a[0], top, a[1]], upperB = [b[0], top, b[1]];
      addTriangle(group.walls, lowerA, lowerB, upperB, [u0, base / 9], [u1, base / 9], [u1, top / 9], normal);
      addTriangle(group.walls, lowerA, upperB, upperA, [u0, base / 9], [u1, top / 9], [u0, top / 9], normal);
    }
    const visibleRoof = roofTriangles(item, index, items, neighbours, trianglesByItem);
    for (const [a, b, c] of visibleRoof) {
      addTriangle(group.roofs, [a[0], height, a[1]], [c[0], height, c[1]], [b[0], height, b[1]],
        [0, 0], [1, 1], [1, 0], [0, 1, 0]);
    }
    if (!item.skipRoofUnit) addRoofUnit(group, visibleRoof, height);
  }
  return surfaces;
}

export function polygonSceneStats(items) {
  const mesh = createPolygonBuildingMesh(items);
  return {
    buildings: items.length,
    wallTriangles: [...mesh.values()].reduce((sum, part) => sum + part.walls.length / 24, 0),
    roofTriangles: [...mesh.values()].reduce((sum, part) => sum + part.roofs.length / 24, 0),
    materials: [...new Set([...mesh.entries()].filter(([, part]) => part.walls.length).map(([name]) => name.split(":")[0]))],
  };
}
