/**
 * Walk tracking: distance and time from the GPS points the walker's phone
 * sends while the walk is running.
 *
 * Points with poor accuracy, or that imply a speed no walker reaches, are
 * dropped: a phone indoors jumps hundreds of metres and would otherwise turn
 * a 20-minute park loop into a 5-mile report.
 */

export interface GpsPoint {
  lat: number;
  lng: number;
  /** Epoch ms. */
  at: number;
  /** Horizontal accuracy in metres, if the device reported one. */
  accuracy?: number | null;
}

const EARTH_RADIUS_M = 6_371_000;
const MAX_ACCURACY_M = 50;
/** About 12 mph: a dog at a sprint, faster than any walk. */
const MAX_SPEED_MPS = 5.5;
export const METERS_PER_MILE = 1609.344;

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

export function cleanTrack(points: readonly GpsPoint[]): GpsPoint[] {
  const sorted = [...points]
    .filter((p) => p.accuracy == null || p.accuracy <= MAX_ACCURACY_M)
    .sort((a, b) => a.at - b.at);
  const out: GpsPoint[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      const dt = (p.at - prev.at) / 1000;
      if (dt <= 0) continue;
      if (haversineMeters(prev, p) / dt > MAX_SPEED_MPS) continue;
    }
    out.push(p);
  }
  return out;
}

export interface WalkSummary {
  meters: number;
  miles: number;
  durationMs: number;
  points: number;
}

export function summarizeWalk(points: readonly GpsPoint[]): WalkSummary {
  const track = cleanTrack(points);
  let meters = 0;
  for (let i = 1; i < track.length; i++) meters += haversineMeters(track[i - 1]!, track[i]!);
  const durationMs = track.length > 1 ? track[track.length - 1]!.at - track[0]!.at : 0;
  return {
    meters: Math.round(meters),
    miles: Math.round((meters / METERS_PER_MILE) * 100) / 100,
    durationMs,
    points: track.length,
  };
}
