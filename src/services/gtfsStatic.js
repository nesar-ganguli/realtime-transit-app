import { routes, stops, tripRouteById } from '../generated/gtfsStaticData';

export { routes, stops, tripRouteById };

export const routesById = Object.fromEntries(routes.map((route) => [route.id, route]));
export const stopsById = Object.fromEntries(stops.map((stop) => [stop.id, stop]));
