import { routes, stops, tripRouteById, tripStopTimesByTripId } from '../generated/gtfsStaticData';

export { routes, stops, tripRouteById, tripStopTimesByTripId };

export const routesById = Object.fromEntries(routes.map((route) => [route.id, route]));
export const stopsById = Object.fromEntries(stops.map((stop) => [stop.id, stop]));
