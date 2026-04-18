import Pbf from 'pbf';

const BASE = 'https://s3.amazonaws.com/etatransit.gtfs/bloomingtontransit.etaspot.net';
const ALERTS = `${BASE}/alerts.pb`;
const POSITIONS = `${BASE}/position_updates.pb`;
const TRIPS = `${BASE}/trip_updates.pb`;

const fetchFeedBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Feed request failed: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
};

const readFeedMessage = (bytes) => new Pbf(bytes).readFields(readFeedField, { entity: [] });

const readFeedField = (tag, feed, pbf) => {
  if (tag === 1) {
    feed.header = pbf.readMessage(readFeedHeader, {});
  } else if (tag === 2) {
    feed.entity.push(pbf.readMessage(readFeedEntity, {}));
  }
};

const readFeedHeader = (tag, header, pbf) => {
  if (tag === 1) {
    header.version = pbf.readString();
  } else if (tag === 3) {
    header.timestamp = pbf.readVarint();
  }
};

const readFeedEntity = (tag, entity, pbf) => {
  if (tag === 1) {
    entity.id = pbf.readString();
  } else if (tag === 3) {
    entity.tripUpdate = pbf.readMessage(readTripUpdate, {});
  } else if (tag === 4) {
    entity.vehicle = pbf.readMessage(readVehiclePosition, {});
  } else if (tag === 5) {
    entity.alert = pbf.readMessage(readAlert, {});
  }
};

const readTripDescriptor = (tag, trip, pbf) => {
  if (tag === 1) {
    trip.tripId = pbf.readString();
  } else if (tag === 2) {
    trip.startTime = pbf.readString();
  } else if (tag === 3) {
    trip.startDate = pbf.readString();
  } else if (tag === 5) {
    trip.routeId = pbf.readString();
  }
};

const readVehicleDescriptor = (tag, vehicle, pbf) => {
  if (tag === 1) {
    vehicle.id = pbf.readString();
  } else if (tag === 2) {
    vehicle.label = pbf.readString();
  } else if (tag === 3) {
    vehicle.licensePlate = pbf.readString();
  }
};

const readPosition = (tag, position, pbf) => {
  if (tag === 1) {
    position.latitude = pbf.readFloat();
  } else if (tag === 2) {
    position.longitude = pbf.readFloat();
  } else if (tag === 3) {
    position.bearing = pbf.readFloat();
  } else if (tag === 5) {
    position.speed = pbf.readFloat();
  }
};

const readVehiclePosition = (tag, vehicle, pbf) => {
  if (tag === 1) {
    vehicle.trip = pbf.readMessage(readTripDescriptor, {});
  } else if (tag === 2) {
    vehicle.position = pbf.readMessage(readPosition, {});
  } else if (tag === 4) {
    vehicle.currentStatus = pbf.readVarint();
  } else if (tag === 5) {
    vehicle.timestamp = pbf.readVarint();
  } else if (tag === 7) {
    vehicle.stopId = pbf.readString();
  } else if (tag === 8) {
    vehicle.vehicle = pbf.readMessage(readVehicleDescriptor, {});
  }
};

const readStopTimeEvent = (tag, event, pbf) => {
  if (tag === 1) {
    event.delay = pbf.readVarint(true);
  } else if (tag === 2) {
    event.time = pbf.readVarint();
  }
};

const readStopTimeUpdate = (tag, update, pbf) => {
  if (tag === 1) {
    update.stopSequence = pbf.readVarint();
  } else if (tag === 2) {
    update.arrival = pbf.readMessage(readStopTimeEvent, {});
  } else if (tag === 3) {
    update.departure = pbf.readMessage(readStopTimeEvent, {});
  } else if (tag === 4) {
    update.stopId = pbf.readString();
  }
};

const readTripUpdate = (tag, tripUpdate, pbf) => {
  if (tag === 1) {
    tripUpdate.trip = pbf.readMessage(readTripDescriptor, {});
  } else if (tag === 2) {
    if (!tripUpdate.stopTimeUpdate) {
      tripUpdate.stopTimeUpdate = [];
    }
    tripUpdate.stopTimeUpdate.push(pbf.readMessage(readStopTimeUpdate, {}));
  } else if (tag === 3) {
    tripUpdate.vehicle = pbf.readMessage(readVehicleDescriptor, {});
  } else if (tag === 4) {
    tripUpdate.timestamp = pbf.readVarint();
  } else if (tag === 5) {
    tripUpdate.delay = pbf.readVarint(true);
  }
};

const readAlert = (tag, alert, pbf) => {
  if (tag === 7) {
    if (!alert.headerText) {
      alert.headerText = [];
    }
    alert.headerText.push(pbf.readMessage(readTranslatedString, {}));
  } else if (tag === 8) {
    if (!alert.descriptionText) {
      alert.descriptionText = [];
    }
    alert.descriptionText.push(pbf.readMessage(readTranslatedString, {}));
  }
};

const readTranslatedString = (tag, translated, pbf) => {
  if (tag === 1) {
    if (!translated.translation) {
      translated.translation = [];
    }
    translated.translation.push(pbf.readMessage(readTranslation, {}));
  }
};

const readTranslation = (tag, translation, pbf) => {
  if (tag === 1) {
    translation.text = pbf.readString();
  } else if (tag === 2) {
    translation.language = pbf.readString();
  }
};

const minutesLabel = (seconds) => {
  if (!Number.isFinite(seconds)) {
    return null;
  }

  if (seconds <= 30) {
    return 'Due';
  }

  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
};

const normalizeDelayStatus = (delaySeconds, stopStatus) => {
  if (stopStatus === 1) {
    return 'STOPPED';
  }

  if (stopStatus === 0) {
    return 'INCOMING';
  }

  if (Number.isFinite(delaySeconds) && delaySeconds > 120) {
    return 'DELAYED';
  }

  return 'ON_TIME';
};

const normalizeTripUpdates = (tripFeed) => {
  const byTripId = {};

  for (const entity of tripFeed?.entity ?? []) {
    const tripUpdate = entity.tripUpdate;
    const tripId = tripUpdate?.trip?.tripId;
    if (!tripId) {
      continue;
    }

    const nextUpdate = tripUpdate.stopTimeUpdate?.[0];
    const delaySeconds = Number(nextUpdate?.arrival?.delay ?? nextUpdate?.departure?.delay);
    const arrivalTime = Number(nextUpdate?.arrival?.time ?? nextUpdate?.departure?.time);

    byTripId[tripId] = {
      tripId,
      routeId: tripUpdate.trip?.routeId ?? null,
      nextStopId: nextUpdate?.stopId ?? null,
      delaySeconds: Number.isFinite(delaySeconds) ? delaySeconds : null,
      etaToNextStop: Number.isFinite(arrivalTime)
        ? minutesLabel(arrivalTime - Math.floor(Date.now() / 1000))
        : null,
    };
  }

  return byTripId;
};

const normalizeVehicles = ({ positionsFeed, tripFeed, stopsById, tripRouteById }) => {
  const tripUpdatesByTripId = normalizeTripUpdates(tripFeed);

  return (positionsFeed?.entity ?? [])
    .map((entity, index) => {
      const vehicle = entity.vehicle;
      const tripId = vehicle?.trip?.tripId ?? null;
      const tripUpdate = tripId ? tripUpdatesByTripId[tripId] : null;
      const position = vehicle?.position;
      const latitude = Number(position?.latitude);
      const longitude = Number(position?.longitude);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      const routeId =
        vehicle?.trip?.routeId ?? tripUpdate?.routeId ?? (tripId ? tripRouteById?.[tripId] : null);
      if (!routeId) {
        return null;
      }

      const nextStopId = vehicle?.stopId ?? tripUpdate?.nextStopId ?? null;
      const nextStop = nextStopId ? stopsById[nextStopId] : null;
      const delaySeconds = tripUpdate?.delaySeconds ?? null;

      return {
        id: vehicle?.vehicle?.label ?? vehicle?.vehicle?.id ?? entity.id ?? `vehicle-${index}`,
        tripId,
        routeId,
        lat: latitude,
        lon: longitude,
        bearing: Number.isFinite(Number(position?.bearing)) ? Number(position.bearing) : 0,
        lastUpdated: Number(vehicle?.timestamp) ? Number(vehicle.timestamp) * 1000 : Date.now(),
        nextStopId,
        nextStopName: nextStop?.name ?? null,
        etaToNextStop: tripUpdate?.etaToNextStop ?? null,
        delaySeconds,
        status: normalizeDelayStatus(delaySeconds, vehicle?.currentStatus),
      };
    })
    .filter(Boolean);
};

export const fetchRealtimeSnapshot = async ({ stopsById, tripRouteById }) => {
  const [positionsBytes, tripBytes, alertBytes] = await Promise.all([
    fetchFeedBytes(POSITIONS),
    fetchFeedBytes(TRIPS),
    fetchFeedBytes(ALERTS),
  ]);

  const positionsFeed = readFeedMessage(positionsBytes);
  const tripFeed = readFeedMessage(tripBytes);
  const alertsFeed = readFeedMessage(alertBytes);
  const vehicles = normalizeVehicles({ positionsFeed, tripFeed, stopsById, tripRouteById });

  return {
    vehicles,
    alerts: alertsFeed?.entity ?? [],
    fetchedAt: Date.now(),
    debug: {
      positionEntities: positionsFeed?.entity?.length ?? 0,
      tripEntities: tripFeed?.entity?.length ?? 0,
      alertEntities: alertsFeed?.entity?.length ?? 0,
      normalizedVehicles: vehicles.length,
      sampleRouteIds: [...new Set(vehicles.map((vehicle) => vehicle.routeId))].slice(0, 6),
    },
  };
};

export const startRealtimePolling = ({
  stopsById,
  tripRouteById,
  onUpdate,
  onError,
  intervalMs = 10000,
}) => {
  let cancelled = false;

  const tick = async () => {
    try {
      const snapshot = await fetchRealtimeSnapshot({ stopsById, tripRouteById });
      if (!cancelled) {
        onUpdate(snapshot);
      }
    } catch (error) {
      if (!cancelled && onError) {
        onError(error);
      }
    }
  };

  tick();
  const intervalId = setInterval(tick, intervalMs);

  return () => {
    cancelled = true;
    clearInterval(intervalId);
  };
};
