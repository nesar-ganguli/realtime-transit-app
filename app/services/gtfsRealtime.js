//import protobuf from "protobufjs";
const protobuf = require("protobufjs");

const BASE =
  "https://s3.amazonaws.com/etatransit.gtfs/bloomingtontransit.etaspot.net";
const ALERTS = BASE + "/alerts.pb";
const POSITIONS = BASE + "/position_updates.pb";
const TRIPS = BASE + "/trip_updates.pb";
//raw binary from one of the .pb urls
export async function fetchFeed(url) {
  const res = await fetch(url);

  //check if res.ok

  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

const PROTO_URL =
  "https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto";

async function loadProto() {
  const root = await protobuf.load(PROTO_URL);
  return root.lookupType("transit_realtime.FeedMessage");
}
export async function decodeFeed(url) {
  const [bytes, FeedMessage] = await Promise.all([fetchFeed(url), loadProto()]);

  const decoded = FeedMessage.decode(bytes);
  return FeedMessage.toObject(decoded, { longs: String, enums: String });
}

// //temp testing
// decodeFeed(ALERTS).then((d) => console.log(JSON.stringify(d, null, 2)));
export function startPolling(onUpdate) {
  const tick = async () => {
    try {
      const [positions, trips, alerts] = await Promise.all([
        decodeFeed(POSITIONS),
        decodeFeed(TRIPS),
        decodeFeed(ALERTS),
      ]);
      onUpdate({ positions, trips, alerts });
    } catch (e) {
      // TODO: handle stale state here
    }
  };

  tick();
  const id = setInterval(tick, 10000);
  return id;
}

export function stopPolling(id) {
  clearInterval(id);
}
