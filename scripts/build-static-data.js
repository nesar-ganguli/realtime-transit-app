const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const zipPath = process.argv[2];

if (!zipPath) {
  console.error('Usage: node scripts/build-static-data.js /path/to/gtfs.zip');
  process.exit(1);
}

const readZipFile = (fileName) =>
  execFileSync('unzip', ['-p', zipPath, fileName], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });

const parseCsv = (text) => {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }

      row.push(current);
      current = '';

      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    current += char;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  const [header, ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']))
  );
};

const unique = (items) => Array.from(new Set(items));

const routesCsv = parseCsv(readZipFile('routes.txt'));
const stopsCsv = parseCsv(readZipFile('stops.txt'));
const tripsCsv = parseCsv(readZipFile('trips.txt'));
const stopTimesCsv = parseCsv(readZipFile('stop_times.txt'));
const shapesCsv = parseCsv(readZipFile('shapes.txt'));

const stopsById = Object.fromEntries(
  stopsCsv.map((stop) => [
    stop.stop_id,
    {
      id: stop.stop_id,
      name: stop.stop_name,
      lat: Number(stop.stop_lat),
      lon: Number(stop.stop_lon),
      routeIds: [],
      upcomingArrivals: [],
    },
  ])
);

const shapePointsById = {};
for (const point of shapesCsv) {
  const shapeId = point.shape_id;
  if (!shapeId) {
    continue;
  }

  if (!shapePointsById[shapeId]) {
    shapePointsById[shapeId] = [];
  }

  shapePointsById[shapeId].push({
    lat: Number(point.shape_pt_lat),
    lon: Number(point.shape_pt_lon),
    sequence: Number(point.shape_pt_sequence),
  });
}

for (const shapeId of Object.keys(shapePointsById)) {
  shapePointsById[shapeId].sort((a, b) => a.sequence - b.sequence);
}

const tripRecords = tripsCsv.map((trip) => ({
  routeId: trip.route_id,
  tripId: trip.trip_id,
  shapeId: trip.shape_id,
  directionId: trip.direction_id,
}));

const tripsById = Object.fromEntries(tripRecords.map((trip) => [trip.tripId, trip]));

const stopTimesByTripId = {};
for (const row of stopTimesCsv) {
  const tripId = row.trip_id;
  if (!tripsById[tripId]) {
    continue;
  }

  if (!stopTimesByTripId[tripId]) {
    stopTimesByTripId[tripId] = [];
  }

  stopTimesByTripId[tripId].push({
    stopId: row.stop_id,
    sequence: Number(row.stop_sequence),
  });
}

for (const tripId of Object.keys(stopTimesByTripId)) {
  stopTimesByTripId[tripId].sort((a, b) => a.sequence - b.sequence);
}

const representativeTripByRoute = {};
const representativeTripByRouteAndDirection = {};
for (const trip of tripRecords) {
  if (!trip.routeId || !trip.shapeId) {
    continue;
  }

  const stopCount = stopTimesByTripId[trip.tripId]?.length ?? 0;
  const current = representativeTripByRoute[trip.routeId];
  if (!current) {
    representativeTripByRoute[trip.routeId] = { ...trip, stopCount };
    continue;
  }

  if (stopCount > current.stopCount) {
    representativeTripByRoute[trip.routeId] = { ...trip, stopCount };
    continue;
  }

  if (stopCount === current.stopCount && current.directionId !== '0' && trip.directionId === '0') {
    representativeTripByRoute[trip.routeId] = { ...trip, stopCount };
  }

  const directionKey = `${trip.routeId}::${trip.directionId || 'x'}`;
  const currentByDirection = representativeTripByRouteAndDirection[directionKey];
  if (!currentByDirection || stopCount > currentByDirection.stopCount) {
    representativeTripByRouteAndDirection[directionKey] = { ...trip, stopCount };
  }
}

const routeIdsByStopId = {};
for (const trip of tripRecords) {
  const stopTimes = stopTimesByTripId[trip.tripId];
  if (!stopTimes?.length) {
    continue;
  }

  for (const stopTime of stopTimes) {
    if (!routeIdsByStopId[stopTime.stopId]) {
      routeIdsByStopId[stopTime.stopId] = new Set();
    }
    routeIdsByStopId[stopTime.stopId].add(trip.routeId);
  }
}

const routes = routesCsv
  .map((route) => {
    const representativeTrip = representativeTripByRoute[route.route_id];
    const directionTrips = ['0', '1']
      .map((directionId) => representativeTripByRouteAndDirection[`${route.route_id}::${directionId}`])
      .filter(Boolean);

    const stopTimes = unique(
      directionTrips.flatMap((trip) => (stopTimesByTripId[trip.tripId] ?? []).map((stopTime) => stopTime.stopId))
    ).map((stopId) => ({ stopId }));

    const shapeVariants = directionTrips
      .map((trip) =>
        (shapePointsById[trip.shapeId] ?? []).map((point) => ({
          lat: point.lat,
          lon: point.lon,
        }))
      )
      .filter((shape) => shape.length > 1);

    const fallbackShape = representativeTrip?.shapeId
      ? (shapePointsById[representativeTrip.shapeId] ?? []).map((point) => ({
          lat: point.lat,
          lon: point.lon,
        }))
      : [];

    const shape = shapeVariants.length ? shapeVariants.flat() : fallbackShape;

    return {
      id: route.route_id,
      shortName: route.route_short_name || route.route_id,
      longName: route.route_long_name || route.route_short_name || route.route_id,
      color: route.route_color || null,
      textColor: route.route_text_color || null,
      shapeVariants,
      shape,
      stops: stopTimes.map((stopTime) => stopTime.stopId).filter(Boolean),
    };
  })
  .filter((route) => route.shape.length > 1 || route.stops.length > 0)
  .sort((left, right) => left.shortName.localeCompare(right.shortName, undefined, { numeric: true }));

const routeIdsInUse = new Set(routes.map((route) => route.id));
const tripRouteById = Object.fromEntries(
  tripRecords
    .filter((trip) => trip.tripId && routeIdsInUse.has(trip.routeId))
    .map((trip) => [trip.tripId, trip.routeId])
);

const stops = Object.values(stopsById)
  .map((stop) => ({
    ...stop,
    routeIds: Array.from(routeIdsByStopId[stop.id] ?? []).filter((routeId) => routeIdsInUse.has(routeId)),
  }))
  .filter((stop) => stop.routeIds.length > 0)
  .sort((left, right) => left.name.localeCompare(right.name));

const output = `export const routes = ${JSON.stringify(routes, null, 2)};\n\nexport const stops = ${JSON.stringify(
  stops,
  null,
2
)};\n\nexport const tripRouteById = ${JSON.stringify(tripRouteById, null, 2)};\n`;

const outputDir = path.join(process.cwd(), 'src', 'generated');
const outputFile = path.join(outputDir, 'gtfsStaticData.js');

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, output);

console.log(`Wrote ${routes.length} routes and ${stops.length} stops to ${outputFile}`);
