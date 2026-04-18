# Bloomington Transit -- Realtime Transit App

A React Native app that shows live bus positions, routes, stop schedules, and arrival alerts for Bloomington Transit.

---

## Prerequisites

- Node.js 18+
- Expo CLI installed globally
- Expo Go app on your phone (iOS or Android)

---

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the static transit data by running the build script with your GTFS zip file as the argument. This generates route, stop, and shape data bundled into the app. Skip this if the repo already contains the generated file.

3. Generate stop marker images by running the marker generation script. This creates colored PNG assets for each route and a matching image map.

4. Start the dev server:
   ```bash
   npm start
   ```
   Then scan the QR code in Expo Go on your phone.

You can also run directly on an Android emulator, iOS simulator, or in a web browser using the respective npm scripts.

---

## Architecture

The app follows **MVVM (Model-View-ViewModel)** architecture:

| Layer | Role |
|---|---|
| **Models** (`models/`) | Route, Stop, Vehicle -- shared data contracts agreed on before development |
| **Services** (`services/`) | GTFS static parsing and realtime protobuf decoding, fully decoupled |
| **ViewModels** (`viewmodels/`) | Custom hooks (useRoutes, useSchedule, useBusTracker) that manage state and polling |
| **Screens** (`screens/`) | MapScreen, ScheduleScreen, BusTrackerScreen -- consume viewmodel hooks only |
| **Navigation** (`navigation/`) | AppNavigator handles screen routing |

## Team

- Rujul Jadav Prakash
- Nesar Bhaskar Ganguli
- Shashank M Lingaraju

---

## Realtime API

The app polls **Bloomington Transit's GTFS Realtime feed** hosted on AWS S3.

**Base URL:** `https://s3.amazonaws.com/etatransit.gtfs/bloomingtontransit.etaspot.net`

| Endpoint | Description |
|---|---|
| `/position_updates.pb` | Live vehicle positions (lat, lon, bearing) |
| `/trip_updates.pb` | Trip delays and next stop ETAs |
| `/alerts.pb` | Service alerts |

All three feeds are Protocol Buffer encoded GTFS Realtime messages, fetched every 10 seconds.

### Vehicle Data Fields

| Field | Description |
|---|---|
| `id` | Vehicle ID |
| `routeId` | Route the vehicle is serving |
| `lat` / `lon` | Current position |
| `bearing` | Direction of travel in degrees |
| `nextStopId` | ID of the next stop |
| `nextStopName` | Name of the next stop |
| `etaToNextStop` | "Due" or "X min" |
| `delaySeconds` | Seconds behind schedule |
| `status` | ON_TIME, DELAYED, INCOMING, or STOPPED |

---

## Static GTFS Data

Sourced from [Bloomington Transit GTFS](https://bloomingtontransit.com/gtfs/).

| Dataset | Count |
|---|---|
| Routes | 15 |
| Stops | 511 |
| Trips | 1,209 |
| Stop time records | 28,511 |
| Shape points | 5,614 |

---

## Features

- Live bus tracking updated every 10 seconds
- Route selection with select/deselect all
- Color-coded stop markers matching route colors
- Arrival alerts -- notifies when a bus is within 250m, 500m, 1km, or 2km of a stop
- Draggable bottom sheet with Routes and More Info tabs
- Android edge-to-edge support

---

## License

Bloomington Transit GTFS data is publicly licensed. All app source code is owned by the team.
