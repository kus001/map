// An approximate (city-level) idea of where the visitor is, with no permission prompt.
// The server works it out from the host's edge headers (see /api/approx-location).
// It centres the first view of the map and ranks nearby search results. It is NOT the
// user's position: no blue dot, no "Current location" start point, no navigation.

const STORAGE_KEY = "map-approx-location";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function validApproxPoint(point) {
  if (!Array.isArray(point) || point.length < 2) return false;
  const lat = Number(point[0]);
  const lon = Number(point[1]);
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

// Last known value, so a returning visitor's map opens in the right place immediately.
export function loadCachedApproxLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && Date.now() - saved.savedAt < MAX_AGE_MS && validApproxPoint(saved.location)) {
      return [Number(saved.location[0]), Number(saved.location[1])];
    }
  } catch {
    // storage unavailable or corrupt: just start without one
  }
  return null;
}

export function saveApproxLocation(location) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ location, savedAt: Date.now() }));
  } catch {
    // private mode / storage full: the cache is only a convenience
  }
}

// [lat, lon] or null (the host gave no location, e.g. local development, or we're offline).
export async function fetchApproxLocation(signal) {
  try {
    const response = await fetch("/api/approx-location", { signal });
    if (!response.ok) return null;
    const body = await response.json();
    return validApproxPoint(body?.location)
      ? [Number(body.location[0]), Number(body.location[1])]
      : null;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return null;
  }
}
