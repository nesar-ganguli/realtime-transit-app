import { routes, stops } from '../services/gtfsStatic';

const fallbackRouteId = routes[0]?.id ?? null;
const campusRouteId = routes.find((route) => route.shortName === '1')?.id ?? fallbackRouteId;
const downtownRouteId = routes.find((route) => route.shortName === '4W')?.id ?? fallbackRouteId;
const southRouteId = routes.find((route) => route.shortName === '7')?.id ?? fallbackRouteId;

const stopForRoute = (routeId, index) => {
  const route = routes.find((item) => item.id === routeId);
  const stopId = route?.stops[index] ?? route?.stops[0] ?? null;

  if (!stopId) {
    return null;
  }

  return stops.find((item) => item.id === stopId) ?? null;
};

const pointForRoute = (routeId, index) => {
  const route = routes.find((item) => item.id === routeId);
  const point = route?.shape[index] ?? route?.shape[0] ?? null;

  if (!point) {
    return { lat: 39.1653, lon: -86.5264 };
  }

  return point;
};

const busSeed = [
  {
    id: 'Bus 204',
    routeId: campusRouteId,
    pointIndex: 18,
    bearing: 220,
    etaToNextStop: '3 min',
    delaySeconds: 0,
    status: 'ON_TIME',
    nextStopIndex: 3,
  },
  {
    id: 'Bus 311',
    routeId: campusRouteId,
    pointIndex: 54,
    bearing: 310,
    etaToNextStop: '9 min',
    delaySeconds: 120,
    status: 'DELAYED',
    nextStopIndex: 5,
  },
  {
    id: 'Bus 118',
    routeId: downtownRouteId,
    pointIndex: 26,
    bearing: 146,
    etaToNextStop: '5 min',
    delaySeconds: null,
    status: 'APPROACHING',
    nextStopIndex: 2,
  },
  {
    id: 'Bus 409',
    routeId: southRouteId,
    pointIndex: 34,
    bearing: 88,
    etaToNextStop: null,
    delaySeconds: null,
    status: 'ON_TIME',
    nextStopIndex: 1,
  },
];

export { routes, stops };

export const vehicles = busSeed
  .filter((entry) => entry.routeId)
  .map((entry, index) => {
    const point = pointForRoute(entry.routeId, entry.pointIndex);
    const nextStop = stopForRoute(entry.routeId, entry.nextStopIndex);

    return {
      id: entry.id,
      tripId: `demo-trip-${index + 1}`,
      routeId: entry.routeId,
      lat: point.lat,
      lon: point.lon,
      bearing: entry.bearing,
      lastUpdated: Date.now() - (index + 1) * 13000,
      nextStopId: nextStop?.id ?? null,
      nextStopName: nextStop?.name ?? null,
      etaToNextStop: entry.etaToNextStop,
      delaySeconds: entry.delaySeconds,
      status: entry.status,
    };
  });
