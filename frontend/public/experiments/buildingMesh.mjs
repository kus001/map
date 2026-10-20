const facades = ["glass", "brick", "concrete", "stone", "metal", "wood", "plaster", "default"];

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

const addTriangle = (vertices, a, b, c, uva, uvb, uvc, normal) => {
  for (const [position, uv] of [[a, uva], [b, uvb], [c, uvc]]) {
    vertices.push(...position, ...uv, ...normal);
  }
};

export function createBuildingMesh(items = buildings) {
  const surfaces = new Map(facades.map(name => [name, { walls: [], roofs: [] }]));
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
      const footprint = cleanRing(rings[0].map(point => toLocalMetres(point, origin)));
      if (footprint.length < 3 || footprint.length > 1000 || Math.abs(polygonArea(footprint)) < 18) continue;
      if (rings.length > 1) skippedHoles++;
      const area = polygonArea(footprint);
      const material = height >= 65 ? "glass" : height >= 30 ? "concrete" : area >= 800 ? "stone" : area >= 250 ? "brick" : "plaster";
      result.push({ id: `${properties.OBJECTID ?? feature.id ?? result.length}:${p}`, points: footprint, h: height, material, measuredHeight: heightKnown });
      if (heightKnown) recordedHeights++; else estimatedHeights++;
    }
  }
  return { buildings: result, recordedHeights, estimatedHeights, skippedHoles };
}

export function createPolygonBuildingMesh(buildings) {
  const surfaces = new Map(facades.map(name => [name, { walls: [], roofs: [] }]));
  for (const item of buildings) {
    const points = item.points;
    const height = item.h;
    if (!points || points.length < 3 || !Number.isFinite(height) || height <= 0) continue;
    const group = surfaces.get(item.material) || surfaces.get("default");
    for (let i = 0; i < points.length; i++) {
      const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length];
      const len = Math.hypot(bx - ax, bz - az);
      if (len <= 0.07) continue;
      const normal = [(bz - az) / len, 0, -(bx - ax) / len];
      const a = [ax, 0, az], b = [bx, 0, bz], ta = [ax, height, az], tb = [bx, height, bz];
      const u = len / 9, v = height / 9;
      addTriangle(group.walls, a, b, tb, [0, 0], [u, 0], [u, v], normal);
      addTriangle(group.walls, a, tb, ta, [0, 0], [u, v], [0, v], normal);
    }
    for (const [i, j, k] of triangulateRoof(points)) {
      const a = points[i], b = points[j], c = points[k];
      addTriangle(group.roofs, [a[0], height, a[1]], [c[0], height, c[1]], [b[0], height, b[1]],
        [0, 0], [1, 1], [1, 0], [0, 1, 0]);
    }
  }
  return surfaces;
}

export function polygonSceneStats(items) {
  const mesh = createPolygonBuildingMesh(items);
  return {
    buildings: items.length,
    wallTriangles: [...mesh.values()].reduce((sum, part) => sum + part.walls.length / 24, 0),
    roofTriangles: [...mesh.values()].reduce((sum, part) => sum + part.roofs.length / 24, 0),
    materials: [...mesh.entries()].filter(([, part]) => part.walls.length).map(([name]) => name),
  };
}
