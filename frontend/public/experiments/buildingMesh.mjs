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
