const EARTH_RADIUS_M = 6371000;

function radians(value) {
  return (Number(value) * Math.PI) / 180;
}

export function validCoordinate(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

export function haversineMeters(a, b) {
  if (!validCoordinate(a) || !validCoordinate(b)) {
    return Infinity;
  }

  const lat1 = radians(a[0]);
  const lat2 = radians(b[0]);
  const dLat = lat2 - lat1;
  const dLon = radians(Number(b[1]) - Number(a[1]));

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function projectAround(origin, point) {
  const lat0 = radians(origin[0]);
  const x = radians(Number(point[1]) - Number(origin[1])) * Math.cos(lat0) * EARTH_RADIUS_M;
  const y = radians(Number(point[0]) - Number(origin[0])) * EARTH_RADIUS_M;
  return [x, y];
}

function distanceToSegmentMeters(point, a, b) {
  const [ax, ay] = projectAround(point, a);
  const [bx, by] = projectAround(point, b);
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSquared = vx * vx + vy * vy;

  if (lengthSquared <= 0.0001) {
    return { distance: Math.hypot(ax, ay), t: 0 };
  }

  const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / lengthSquared));
  const closestX = ax + vx * t;
  const closestY = ay + vy * t;
  return { distance: Math.hypot(closestX, closestY), t };
}

export function routePosition(location, coordinates) {
  const route = (coordinates || []).filter(validCoordinate);
  if (!validCoordinate(location) || route.length < 2) {
    return null;
  }

  let best = {
    distance_m: Infinity,
    segment_index: 0,
    segment_progress: 0,
  };

  for (let index = 0; index < route.length - 1; index += 1) {
    const candidate = distanceToSegmentMeters(location, route[index], route[index + 1]);
    if (candidate.distance < best.distance_m) {
      best = {
        distance_m: candidate.distance,
        segment_index: index,
        segment_progress: candidate.t,
      };
    }
  }

  return best;
}

function nearestRouteIndex(coordinate, routeCoordinates) {
  if (!validCoordinate(coordinate)) {
    return null;
  }

  let bestIndex = null;
  let bestDistance = Infinity;

  for (let index = 0; index < routeCoordinates.length; index += 1) {
    const distance = haversineMeters(coordinate, routeCoordinates[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function routeDistanceFrom(routeCoordinates, segmentIndex, segmentProgress) {
  if (!routeCoordinates?.length) {
    return 0;
  }

  let total = 0;
  const start = Math.max(0, Math.min(segmentIndex, routeCoordinates.length - 2));
  const firstSegment = haversineMeters(routeCoordinates[start], routeCoordinates[start + 1]);
  total += firstSegment * (1 - Math.max(0, Math.min(1, segmentProgress || 0)));

  for (let index = start + 1; index < routeCoordinates.length - 1; index += 1) {
    total += haversineMeters(routeCoordinates[index], routeCoordinates[index + 1]);
  }

  return total;
}

export function navigationSnapshot(location, route) {
  const routeCoordinates = (route?.route_coordinates || []).filter(validCoordinate);
  const steps = route?.steps || route?.stops || [];
  const position = routePosition(location, routeCoordinates);

  if (!position) {
    return null;
  }

  const stepLocations = steps
    .map((step, index) => ({
      step,
      index,
      routeIndex: nearestRouteIndex(step?.coordinates, routeCoordinates),
    }))
    .filter(item => item.routeIndex !== null);

  const currentRouteIndex = position.segment_index + position.segment_progress;
  let next = stepLocations.find(item => item.routeIndex > currentRouteIndex + 1.25);

  if (!next && stepLocations.length) {
    next = stepLocations[stepLocations.length - 1];
  }

  const distanceToNext = next?.step?.coordinates
    ? haversineMeters(location, next.step.coordinates)
    : null;

  return {
    off_route_m: position.distance_m,
    route_index: currentRouteIndex,
    remaining_m: routeDistanceFrom(
      routeCoordinates,
      position.segment_index,
      position.segment_progress
    ),
    next_step: next?.step || null,
    next_step_index: next?.index ?? null,
    distance_to_next_m: distanceToNext,
  };
}
