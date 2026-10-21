// Camera math stays separate from WebGL so panning never touches building buffers.
export const FOV = Math.PI / 3;
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export function cameraEye(target, yaw, tilt, distance) {
  const horizontal = Math.cos(tilt) * distance;
  return [target[0] + horizontal * Math.sin(yaw), target[1] + Math.sin(tilt) * distance,
    target[2] + horizontal * Math.cos(yaw)];
}
function normalize(a) {
  const l = Math.hypot(...a) || 1;
  return a.map(x => x / l);
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function screenRay(x, y, width, height, target, yaw, tilt, distance) {
  const eye = cameraEye(target, yaw, tilt, distance);
  const backward = normalize(eye.map((n, i) => n - target[i]));
  const right = normalize(cross([0, 1, 0], backward));
  const up = cross(backward, right);
  const sx = (2 * x / width - 1) * Math.tan(FOV / 2) * width / height;
  const sy = (1 - 2 * y / height) * Math.tan(FOV / 2);
  const direction = normalize(backward.map((n, i) => -n + right[i] * sx + up[i] * sy));
  return { eye, direction };
}
export function hitHorizontalPlane(ray, height) {
  if (Math.abs(ray.direction[1]) < 0.00001) return null;
  const t = (height - ray.eye[1]) / ray.direction[1];
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return ray.eye.map((n, i) => n + ray.direction[i] * t);
}
function cross2(ax, az, bx, bz) { return ax * bz - az * bx; }
function inFootprint(x, z, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, az] = points[i], [bx, bz] = points[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}
export function cameraInsideBuildings(eye, buildings, padding = 0.35) {
  return buildings.some(({points,h}) => points?.length >= 3 &&
    eye[1] > -0.1 && eye[1] < h + padding && inFootprint(eye[0], eye[2], points));
}
// Raycast actual polygon walls and flat roofs, not rectangular screen-space guesses.
// This runs on wheel/double-click only, never inside the drawing loop.
export function hitBuildings(ray, buildings) {
  const [px, py, pz] = ray.eye;
  const [dx, dy, dz] = ray.direction;
  let bestDistance = Infinity;
  let best = null;
  for (const { points, h } of buildings) {
    if (!points || points.length < 3 || !(h > 0)) continue;
    if (Math.abs(dy) > 1e-8) {
      const t = (h - py) / dy;
      if (t > 0 && t < bestDistance && inFootprint(px + dx * t, pz + dz * t, points)) {
        bestDistance = t;
        best = [px + dx * t, h, pz + dz * t];
      }
    }
    for (let i = 0; i < points.length; i++) {
      const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length];
      const ex = bx - ax, ez = bz - az;
      const det = cross2(dx, dz, ex, ez);
      if (Math.abs(det) < 1e-10) continue;
      const qx = ax - px, qz = az - pz;
      const t = cross2(qx, qz, ex, ez) / det;
      if (t <= 0 || t >= bestDistance) continue;
      const s = cross2(qx, qz, dx, dz) / det;
      if (s < 0 || s > 1) continue;
      const hitY = py + t * dy;
      if (hitY < 0 || hitY > h) continue;
      bestDistance = t;
      best = [px + t * dx, hitY, pz + t * dz];
    }
  }
  return best;
}
export function zoomAt(target, yaw, tilt, oldDistance, newDistance, x, y, width, height, buildings = []) {
  const before = screenRay(x, y, width, height, target, yaw, tilt, oldDistance);
  const surface = hitBuildings(before, buildings);
  const planeHeight = surface?.[1] ?? target[1];
  const oldPoint = surface || hitHorizontalPlane(before, planeHeight);
  if (!oldPoint) return [...target];
  const after = screenRay(x, y, width, height, target, yaw, tilt, newDistance);
  const newPoint = hitHorizontalPlane(after, planeHeight);
  if (!newPoint) return [...target];
  return [target[0] + oldPoint[0] - newPoint[0], target[1], target[2] + oldPoint[2] - newPoint[2]];
}
export function panOnPlane(target, yaw, tilt, distance, startX, startY, endX, endY, width, height) {
  const prev = screenRay(startX, startY, width, height, target, yaw, tilt, distance);
  const next = screenRay(endX, endY, width, height, target, yaw, tilt, distance);
  const p = hitHorizontalPlane(prev, target[1]), q = hitHorizontalPlane(next, target[1]);
  if (p && q) return [target[0] + p[0] - q[0], target[1], target[2] + p[2] - q[2]];
  // Near the horizon, use projected screen-right/forward instead of an infinite pan.
  const scale = 2 * distance * Math.tan(FOV / 2) / height;
  const dx = endX - startX, dy = endY - startY;
  const forwardX = -Math.sin(yaw), forwardZ = -Math.cos(yaw);
  return [target[0] - Math.cos(yaw) * dx * scale + forwardX * dy * scale,
    target[1], target[2] + Math.sin(yaw) * dx * scale + forwardZ * dy * scale];
}
// Keep the near plane small at close range, without using an enormous far plane.
export function clippingPlanes(distance, sceneRadius) {
  return {
    near: clamp(distance * 0.008, 0.04, 4),
    far: Math.max(250, distance + sceneRadius * 2.2),
  };
}
