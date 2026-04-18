import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated, Dimensions, PanResponder, Platform,
  Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, View,
} from "react-native";
import MapView, { Circle, Marker, Polyline } from "react-native-maps";

import * as Notifications from "expo-notifications";
import { routes, routesById, stops, stopsById, tripRouteById } from "./src/services/gtfsStatic";
import stopMarkerImages from "./src/generated/stopMarkerImages";
import { startRealtimePolling } from "./src/services/gtfsRealtime";
import { haversine } from "./src/utils/distance";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const { height: screenHeight } = Dimensions.get("window");

const SNAP_TOP = 110;
const SNAP_MID = Math.round(screenHeight * 0.52);
const SNAP_BOTTOM = Math.round(screenHeight * 0.8);
const SNAPS = [SNAP_TOP, SNAP_MID, SNAP_BOTTOM];

const DEFAULT_REGION = {
  latitude: 39.1653,
  longitude: -86.5264,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

function canDraw(route) {
  if (!route) return false;
  if (route.shapeVariants?.some(s => s.length > 1)) return true;
  return Array.isArray(route.shape) && route.shape.length > 1;
}

export default function App() {
  const mapRef = useRef(null);
  const sheetY = useRef(new Animated.Value(SNAP_MID)).current;
  const dragStart = useRef(SNAP_MID);
  const userPickedRoute = useRef(false);

  const [tab, setTab] = useState("routes");
  const [selectedIds, setSelectedIds] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [activeBusId, setActiveBusId] = useState(null);
  const [alertDistance, setAlertDistance] = useState(500);
  const firedAlerts = useRef(new Set());

  useEffect(() => {
    Notifications.requestPermissionsAsync();
  }, []);

  useEffect(() => {
    if (!visibleVehicles.length || !selectedStops.length) return;
    visibleVehicles.forEach(v => {
      selectedStops.forEach(stop => {
        const dist = haversine(v.lat, v.lon, stop.lat, stop.lon);
        if (dist > alertDistance) return;
        const key = `${v.id}-${stop.id}`;
        if (firedAlerts.current.has(key)) return;
        firedAlerts.current.add(key);
        const route = routesById[v.routeId];
        Notifications.scheduleNotificationAsync({
          content: {
            title: `Bus approaching ${stop.name}`,
            body: `Route ${route?.shortName ?? v.routeId} is ${Math.round(dist)}m away.`,
          },
          trigger: null,
        });
        setTimeout(() => firedAlerts.current.delete(key), 2 * 60 * 1000);
      });
    });
  }, [visibleVehicles, selectedStops, alertDistance]);

  useEffect(() => {
    firedAlerts.current = new Set();
  }, [selectedIds]);

  useEffect(() => {
    return startRealtimePolling({
      stopsById,
      tripRouteById,
      onUpdate: ({ vehicles: v }) => { setVehicles(v); },
      onError: () => { setVehicles([]); },
    });
  }, []);

  const selectedRoutes = useMemo(() => {
    const picked = routes.filter(r => selectedIds.includes(r.id) && canDraw(r));
    if (picked.length) return picked;
    if (selectedIds.length) {
      const fallback = routes.find(r => canDraw(r));
      return fallback ? [fallback] : [];
    }
    return [];
  }, [selectedIds]);

  const primaryRoute = selectedRoutes[0] ?? null;

  const selectedStops = useMemo(() => {
    if (!selectedRoutes.length) return [];
    const ids = [...new Set(selectedRoutes.flatMap(r => r.stops))];
    return ids.map(id => stops.find(s => s.id === id)).filter(Boolean);
  }, [selectedRoutes]);

  const visibleVehicles = useMemo(() => {
    if (!selectedIds.length) return [];
    if (!selectedRoutes.length) return vehicles;
    const ids = new Set(selectedRoutes.map(r => r.id));
    const filtered = vehicles.filter(v => ids.has(v.routeId));
    return filtered.length ? filtered : vehicles;
  }, [selectedIds, selectedRoutes, vehicles]);

  const activeBus = useMemo(() => {
    return visibleVehicles.find(v => v.id === activeBusId) ?? visibleVehicles[0] ?? null;
  }, [visibleVehicles, activeBusId]);

  useEffect(() => {
    if (!visibleVehicles.length) { setActiveBusId(null); return; }
    setActiveBusId(cur => {
      const still = visibleVehicles.some(v => v.id === cur);
      return still ? cur : (visibleVehicles[0]?.id ?? null);
    });
  }, [visibleVehicles]);

  useEffect(() => {
    if (!selectedRoutes.length) return;
    const shapes = selectedRoutes.flatMap(r =>
      r.shapeVariants?.length ? r.shapeVariants : [r.shape]
    );
    const pts = shapes.flat()
      .map(p => ({ latitude: p.lat, longitude: p.lon }))
      .filter(p => isFinite(p.latitude) && isFinite(p.longitude));

    if (pts.length > 1 && mapRef.current) {
      mapRef.current.fitToCoordinates(pts, {
        edgePadding: { top: 130, right: 80, bottom: 320, left: 80 },
        animated: true,
      });
    }
  }, [selectedRoutes]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6,
    onPanResponderGrant: () => {
      sheetY.stopAnimation(v => { dragStart.current = v; });
    },
    onPanResponderMove: (_, g) => {
      sheetY.setValue(Math.max(SNAP_TOP, Math.min(SNAP_BOTTOM, dragStart.current + g.dy)));
    },
    onPanResponderRelease: (_, g) => {
      const projected = dragStart.current + g.dy + g.vy * 120;
      const snap = SNAPS.reduce((a, b) =>
        Math.abs(b - projected) < Math.abs(a - projected) ? b : a
      );
      Animated.spring(sheetY, { toValue: snap, useNativeDriver: false, bounciness: 0 }).start();
    },
  }), [sheetY]);

  const liveRoutes = useMemo(() => {
    const live = new Set(vehicles.map(v => v.routeId));
    return routes.filter(r => live.has(r.id) && canDraw(r));
  }, [vehicles]);

  const allSelected = liveRoutes.every(r => selectedIds.includes(r.id));

  const toggleAll = () => {
    userPickedRoute.current = true;
    setSelectedIds(allSelected ? [] : liveRoutes.map(r => r.id));
  };

  const pickRoute = (id) => {
    if (!canDraw(routes.find(r => r.id === id))) return;
    userPickedRoute.current = true;
    setSelectedIds(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
    Animated.spring(sheetY, { toValue: SNAP_MID, useNativeDriver: false, bounciness: 0 }).start();
  };

  const shapes = selectedRoutes.flatMap(r => {
    const base = r.shapeVariants?.length ? r.shapeVariants : [r.shape];
    return base.map(s => ({
      routeId: r.id,
      color: `#${r.color || "1565C0"}`,
      points: s.map(p => ({ latitude: p.lat, longitude: p.lon })),
    }));
  });

  const mapKey = useMemo(() =>
    selectedRoutes.map(r => r.id).sort().join("|") || "empty"
  , [selectedRoutes]);


  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />

      <View style={styles.container}>
        <MapView
          key={mapKey}
          ref={mapRef}
          style={styles.map}
          initialRegion={DEFAULT_REGION}
          showsCompass={false}
        >
          {shapes.map((s, i) => s.points.length ? (
            <Fragment key={`${s.routeId}-${i}`}>
              <Polyline coordinates={s.points} strokeColor="rgba(15,23,42,0.3)" strokeWidth={5} lineCap="round" lineJoin="round" />
              <Polyline coordinates={s.points} strokeColor={s.color} strokeWidth={3} lineCap="round" lineJoin="round" />
            </Fragment>
          ) : null)}

          {selectedStops.map(stop => {
            const color = (
              stop.routeIds.filter(id => selectedIds.includes(id)).map(id => routesById[id]?.color).find(Boolean) ||
              stop.routeIds.map(id => routesById[id]?.color).find(Boolean) ||
              "1565C0"
            ).toUpperCase();
            return (
              <Marker
                key={stop.id}
                coordinate={{ latitude: stop.lat, longitude: stop.lon }}
                title={stop.name}
                anchor={{ x: 0.5, y: 0.5 }}
                tracksViewChanges={false}
                image={stopMarkerImages[color] ?? stopMarkerImages["1565C0"]}
              />
            );
          })}

          {visibleVehicles.map(v => (
            <Marker
              key={v.id}
              coordinate={{ latitude: v.lat, longitude: v.lon }}
              title={v.nextStopName || "Bus"}
              onPress={() => setActiveBusId(v.id)}
              anchor={{ x: 0.5, y: 0.5 }}
              flat
              rotation={v.bearing || 0}
            >
              <BusMarker
                active={v.id === activeBus?.id}
                color={`#${routesById[v.routeId]?.color || "8b5a2b"}`}
              />
            </Marker>
          ))}

          {activeBus && (
            <Circle
              center={{ latitude: activeBus.lat, longitude: activeBus.lon }}
              radius={170}
              fillColor="rgba(249,168,37,0.18)"
              strokeColor="rgba(249,168,37,0.55)"
            />
          )}
        </MapView>


        <Animated.View style={[styles.sheet, { top: sheetY, bottom: 0 }]}>
          <View style={styles.handleArea} {...panResponder.panHandlers}>
            <View style={styles.handle} />
            <View style={styles.tabs}>
              <Tab label="Routes" active={tab === "routes"} onPress={() => setTab("routes")} />
              <Tab label="Messages" active={tab === "messages"} onPress={() => setTab("messages")} />
            </View>
          </View>

          {tab === "routes" ? (
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner} showsVerticalScrollIndicator={false}>
              <Text style={styles.sectionTitle}>Pick a route</Text>
              <Text style={styles.sectionSub}>Tap to add or remove routes. Stops and buses update automatically.</Text>

              <Pressable style={styles.toggleAllBtn} onPress={toggleAll}>
                <Text style={styles.toggleAllText}>{allSelected ? "Deselect All" : "Select All"}</Text>
              </Pressable>

              {liveRoutes.map(r => {
                const active = selectedIds.includes(r.id);
                const busCount = vehicles.filter(v => v.routeId === r.id).length;
                return (
                  <Pressable
                    key={r.id}
                    onPress={() => pickRoute(r.id)}
                    style={[styles.routeCard, active && styles.routeCardActive]}
                  >
                    <View style={[styles.swatch, { backgroundColor: `#${r.color || "1565C0"}` }]} />
                    <View style={{ flex: 1 }}>
                      <View style={styles.routeRow}>
                        <Text style={styles.routeNum}>{r.shortName}</Text>
                        <View style={styles.badges}>
                          <Text style={styles.busBadge}>{busCount} {busCount === 1 ? "bus" : "buses"}</Text>
                          {active && <Text style={styles.selectedBadge}>Selected</Text>}
                        </View>
                      </View>
                      <Text style={styles.routeName}>{r.longName}</Text>
                      <Text style={styles.routeMeta}>{r.stops.length} stops</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : (
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner} showsVerticalScrollIndicator={false}>
              <Text style={styles.sectionTitle}>Messages</Text>
              <Text style={styles.sectionSub}>Service alerts and arrival info show up here.</Text>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Upcoming arrivals</Text>
                {selectedStops.slice(0, 4).map((s, i) => (
                  <View key={s.id} style={styles.arrivalRow}>
                    <View>
                      <Text style={styles.stopName}>{s.name}</Text>
                      <Text style={styles.stopMeta}>
                        {s.routeIds.slice(0, 2).join(", ") || primaryRoute?.shortName || "Route"} · Stop {i + 1}
                      </Text>
                    </View>
                    <Text style={styles.eta}>{s.upcomingArrivals?.[0]?.label || `${6 + i * 3} min`}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Arrival alerts</Text>
                <Text style={styles.alertBody}>Notify me when a bus is within:</Text>
                <View style={styles.distanceRow}>
                  {[250, 500, 1000, 2000].map(d => (
                    <Pressable
                      key={d}
                      onPress={() => setAlertDistance(d)}
                      style={[styles.distanceBtn, alertDistance === d && styles.distanceBtnActive]}
                    >
                      <Text style={[styles.distanceBtnText, alertDistance === d && styles.distanceBtnTextActive]}>
                        {d >= 1000 ? `${d / 1000}km` : `${d}m`}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Service alerts</Text>
                <View style={styles.alertBox}>
                  <Text style={styles.alertTitle}>All clear</Text>
                  <Text style={styles.alertBody}>No active alerts at the moment.</Text>
                </View>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

function Tab({ active, label, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function BusMarker({ active, color }) {
  return (
    <View style={[styles.busWrap, active && styles.busWrapActive]}>
      <View style={[styles.busBody, { backgroundColor: color || "#8b5a2b" }, active && styles.busBodyActive]}>
        <View style={styles.busGlyph}>
          <View style={styles.glyphTop}>
            <View style={styles.glyphWindow} />
            <View style={styles.glyphWindow} />
          </View>
          <View style={styles.glyphDoor} />
          <View style={styles.glyphWheels}>
            <View style={styles.glyphWheel} />
            <View style={styles.glyphWheel} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0f172a",
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0,
  },
  container: { flex: 1, backgroundColor: "#0f172a" },
  map: { flex: 1 },


  busWrap: { alignItems: "center" },
  busWrapActive: { transform: [{ scale: 1.08 }] },
  busBody: {
    width: 34, height: 34, borderRadius: 17,
    borderWidth: 2.5, borderColor: "#f8fafc",
    alignItems: "center", justifyContent: "center",
    shadowColor: "#0f172a", shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 3 }, shadowRadius: 8, elevation: 8,
  },
  busBodyActive: { borderColor: "#fff" },
  busGlyph: { width: 15, alignItems: "center" },
  glyphTop: {
    width: 15, height: 7,
    borderTopLeftRadius: 3, borderTopRightRadius: 3,
    backgroundColor: "#f8fafc",
    flexDirection: "row", alignItems: "center", justifyContent: "space-evenly",
    marginBottom: 1,
  },
  glyphWindow: { width: 4, height: 3, borderRadius: 1, backgroundColor: "#fff" },
  glyphDoor: {
    width: 15, height: 6,
    borderBottomLeftRadius: 2, borderBottomRightRadius: 2,
    backgroundColor: "#f8fafc", marginBottom: 1,
  },
  glyphWheels: { width: 15, flexDirection: "row", justifyContent: "space-between", marginTop: -1 },
  glyphWheel: { width: 3, height: 3, borderRadius: 2, backgroundColor: "#f8fafc" },

  sheet: {
    position: "absolute", left: 0, right: 0,
    backgroundColor: "#f8fafc",
    borderTopLeftRadius: 30, borderTopRightRadius: 30,
    overflow: "hidden",
    shadowColor: "#0f172a", shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: -10 }, shadowRadius: 24, elevation: 18,
  },
  handleArea: { paddingTop: 10, paddingHorizontal: 18, paddingBottom: 14, backgroundColor: "#f8fafc" },
  handle: { width: 56, height: 6, borderRadius: 999, alignSelf: "center", backgroundColor: "#cbd5e1", marginBottom: 14 },
  tabs: { flexDirection: "row", backgroundColor: "#e2e8f0", borderRadius: 16, padding: 4 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12, borderRadius: 12 },
  tabActive: { backgroundColor: "#0f172a" },
  tabText: { color: "#334155", fontWeight: "600" },
  tabTextActive: { color: "#f8fafc" },

  scroll: { flex: 1 },
  scrollInner: { paddingHorizontal: 18, paddingBottom: 40 },
  sectionTitle: { color: "#0f172a", fontSize: 22, fontWeight: "700", marginBottom: 6 },
  sectionSub: { color: "#64748b", fontSize: 14, lineHeight: 20, marginBottom: 18 },

  toggleAllBtn: {
    alignSelf: "flex-end",
    backgroundColor: "#0f172a",
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 999, marginBottom: 14,
  },
  toggleAllText: { color: "#f8fafc", fontSize: 13, fontWeight: "700" },

  routeCard: {
    flexDirection: "row", alignItems: "stretch",
    backgroundColor: "#fff", borderRadius: 22,
    padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: "#e2e8f0",
  },
  routeCardActive: { borderColor: "#0f172a", backgroundColor: "#eff6ff" },
  swatch: { width: 12, borderRadius: 999, marginRight: 14 },
  routeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  routeNum: { color: "#0f172a", fontSize: 24, fontWeight: "700" },
  badges: { flexDirection: "row", alignItems: "center", gap: 6 },
  busBadge: {
    color: "#1d4ed8", fontSize: 12, fontWeight: "700",
    backgroundColor: "#dbeafe", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
  },
  selectedBadge: {
    color: "#166534", fontSize: 12, fontWeight: "700",
    backgroundColor: "#dcfce7", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
  },
  routeName: { color: "#1e293b", fontSize: 16, fontWeight: "600", marginBottom: 4 },
  routeMeta: { color: "#64748b", fontSize: 13 },

  panel: {
    backgroundColor: "#fff", borderRadius: 22,
    padding: 16, marginBottom: 14,
    borderWidth: 1, borderColor: "#e2e8f0",
  },
  panelTitle: { color: "#0f172a", fontSize: 18, fontWeight: "700", marginBottom: 14 },
  arrivalRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#e2e8f0",
  },
  stopName: { color: "#0f172a", fontSize: 15, fontWeight: "600", marginBottom: 3 },
  stopMeta: { color: "#64748b", fontSize: 12 },
  eta: { color: "#1d4ed8", fontSize: 15, fontWeight: "700" },
  alertBox: { backgroundColor: "#f8fafc", borderRadius: 18, padding: 14 },
  alertTitle: { color: "#0f172a", fontSize: 15, fontWeight: "700", marginBottom: 5 },
  alertBody: { color: "#64748b", fontSize: 13, lineHeight: 19 },
  distanceRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  distanceBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: "#e2e8f0",
    alignItems: "center",
  },
  distanceBtnActive: { backgroundColor: "#0f172a", borderColor: "#0f172a" },
  distanceBtnText: { fontSize: 13, fontWeight: "600", color: "#334155" },
  distanceBtnTextActive: { color: "#f8fafc" },
});
