import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Circle, Marker, Polyline } from "react-native-maps";

import {
  routes,
  routesById,
  stops,
  stopsById,
  tripRouteById,
} from "./src/services/gtfsStatic";
import stopMarkerImages from "./src/generated/stopMarkerImages";
import { startRealtimePolling } from "./src/services/gtfsRealtime";
import {
  stopSchedule,
  serviceCalendar,
  calendarExceptions,
} from "./src/generated/stopSchedule";

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
  if (route.shapeVariants?.some((s) => s.length > 1)) return true;
  return Array.isArray(route.shape) && route.shape.length > 1;
}

function buildStopArrivals(vehicles) {
  const map = {};
  for (const v of vehicles) {
    if (!v.nextStopId || !v.etaToNextStop) continue;
    if (!map[v.nextStopId]) map[v.nextStopId] = [];
    map[v.nextStopId].push({ label: v.etaToNextStop, routeId: v.routeId });
  }
  return map;
}

function fmt12(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const hh = h % 24;
  const ampm = hh >= 12 ? "PM" : "AM";
  return `${hh % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function getActiveServiceIds(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const dayKey = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][d.getDay()];

  const active = new Set();
  for (const [sid, cal] of Object.entries(serviceCalendar)) {
    if (
      cal.startDate <= dateStr &&
      cal.endDate >= dateStr &&
      cal[dayKey] === 1
    ) {
      const exc = calendarExceptions[dateStr]?.[sid];
      if (exc !== 2) active.add(sid);
    }
  }
  for (const [sid, excType] of Object.entries(
    calendarExceptions[dateStr] || {},
  )) {
    if (excType === 1) active.add(sid);
  }

  if (active.size === 0) {
    return new Set(Object.keys(serviceCalendar));
  }

  return active;
}

function getScheduledArrivals(stop, limitToNext = false) {
  const entries = stopSchedule[stop.id];
  if (!entries || entries.length === 0) return [];

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let active = getActiveServiceIds(0);
  let results = entries
    .filter((e) => active.has(e.s))
    .map((e) => {
      const [h, m] = e.t.split(":").map(Number);
      return { routeId: e.r, timeStr: e.t, minutes: h * 60 + m };
    });

  if (limitToNext) {
    const upcoming = results.filter((e) => e.minutes > nowMin);
    if (upcoming.length > 0) {
      return upcoming.slice(0, 3).map((e) => ({
        ...e,
        label: `Next at ${fmt12(e.timeStr)}`,
        isScheduled: true,
      }));
    }
    active = getActiveServiceIds(1);
    results = (stopSchedule[stop.id] || [])
      .filter((e) => active.has(e.s))
      .map((e) => {
        const [h, m] = e.t.split(":").map(Number);
        return { routeId: e.r, timeStr: e.t, minutes: h * 60 + m };
      });
    return results.slice(0, 3).map((e) => ({
      ...e,
      label: `Next at ${fmt12(e.timeStr)} tomorrow`,
      isScheduled: true,
    }));
  }

  return results
    .filter((e) => e.minutes >= nowMin)
    .sort((a, b) => a.minutes - b.minutes)
    .filter(
      (e, i, arr) =>
        i ===
        arr.findIndex(
          (x) => x.routeId === e.routeId && x.timeStr === e.timeStr,
        ),
    );
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getArrivalsForStop(stop, allVehicles) {
  const seen = new Set();
  const live = [];
  for (const v of allVehicles) {
    if (!stop.routeIds.includes(v.routeId)) continue;
    if (seen.has(v.routeId)) continue;
    const dist = haversine(v.lat, v.lon, stop.lat, stop.lon);
    if (dist > 1200) continue;
    const etaSec = dist / 7;
    const label =
      etaSec < 30 ? "Due" : `${Math.max(1, Math.round(etaSec / 60))} min`;
    live.push({ routeId: v.routeId, label, isScheduled: false });
    seen.add(v.routeId);
  }
  if (live.length > 0) {
    return live.sort((a, b) => {
      const n = (x) => (x.label === "Due" ? 0 : parseInt(x.label));
      return n(a) - n(b);
    });
  }
  return getScheduledArrivals(stop, true);
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
  const [stopArrivals, setStopArrivals] = useState({});
  const [selectedStop, setSelectedStop] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);

  useEffect(() => {
    return startRealtimePolling({
      stopsById,
      tripRouteById,
      onUpdate: ({ vehicles: v }) => {
        setVehicles(v);
        setStopArrivals(buildStopArrivals(v));
      },
      onError: () => {
        setVehicles([]);
      },
    });
  }, []);

  const handleStopPress = (stop) => {
    setSelectedStop(stop);
    setShowSchedule(false);
    Animated.spring(sheetY, {
      toValue: SNAP_BOTTOM,
      useNativeDriver: false,
      bounciness: 0,
    }).start();
  };

  const handleCloseStop = () => {
    setSelectedStop(null);
    setShowSchedule(false);
    Animated.spring(sheetY, {
      toValue: SNAP_MID,
      useNativeDriver: false,
      bounciness: 0,
    }).start();
  };

  const selectedRoutes = useMemo(() => {
    const picked = routes.filter(
      (r) => selectedIds.includes(r.id) && canDraw(r),
    );
    if (picked.length) return picked;
    if (selectedIds.length) {
      const fallback = routes.find((r) => canDraw(r));
      return fallback ? [fallback] : [];
    }
    return [];
  }, [selectedIds]);

  const primaryRoute = selectedRoutes[0] ?? null;

  const selectedStops = useMemo(() => {
    if (!selectedRoutes.length) return [];
    const ids = [...new Set(selectedRoutes.flatMap((r) => r.stops))];
    return ids.map((id) => stops.find((s) => s.id === id)).filter(Boolean);
  }, [selectedRoutes]);

  const visibleVehicles = useMemo(() => {
    if (!selectedIds.length) return [];
    if (!selectedRoutes.length) return vehicles;
    const ids = new Set(selectedRoutes.map((r) => r.id));
    const filtered = vehicles.filter((v) => ids.has(v.routeId));
    return filtered.length ? filtered : vehicles;
  }, [selectedIds, selectedRoutes, vehicles]);

  const activeBus = useMemo(() => {
    return (
      visibleVehicles.find((v) => v.id === activeBusId) ??
      visibleVehicles[0] ??
      null
    );
  }, [visibleVehicles, activeBusId]);

  useEffect(() => {
    if (!visibleVehicles.length) {
      setActiveBusId(null);
      return;
    }
    setActiveBusId((cur) => {
      const still = visibleVehicles.some((v) => v.id === cur);
      return still ? cur : (visibleVehicles[0]?.id ?? null);
    });
  }, [visibleVehicles]);

  useEffect(() => {
    if (!selectedRoutes.length) return;
    const shapes = selectedRoutes.flatMap((r) =>
      r.shapeVariants?.length ? r.shapeVariants : [r.shape],
    );
    const pts = shapes
      .flat()
      .map((p) => ({ latitude: p.lat, longitude: p.lon }))
      .filter((p) => isFinite(p.latitude) && isFinite(p.longitude));

    if (pts.length > 1 && mapRef.current) {
      mapRef.current.fitToCoordinates(pts, {
        edgePadding: { top: 130, right: 80, bottom: 320, left: 80 },
        animated: true,
      });
    }
  }, [selectedRoutes]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6,
        onPanResponderGrant: () => {
          sheetY.stopAnimation((v) => {
            dragStart.current = v;
          });
        },
        onPanResponderMove: (_, g) => {
          sheetY.setValue(
            Math.max(SNAP_TOP, Math.min(SNAP_BOTTOM, dragStart.current + g.dy)),
          );
        },
        onPanResponderRelease: (_, g) => {
          const projected = dragStart.current + g.dy + g.vy * 120;
          const snap = SNAPS.reduce((a, b) =>
            Math.abs(b - projected) < Math.abs(a - projected) ? b : a,
          );
          Animated.spring(sheetY, {
            toValue: snap,
            useNativeDriver: false,
            bounciness: 0,
          }).start();
        },
      }),
    [sheetY],
  );

  const liveRoutes = useMemo(() => {
    const live = new Set(vehicles.map((v) => v.routeId));
    return routes.filter((r) => live.has(r.id) && canDraw(r));
  }, [vehicles]);

  const allSelected = liveRoutes.every((r) => selectedIds.includes(r.id));

  const toggleAll = () => {
    userPickedRoute.current = true;
    setSelectedIds(allSelected ? [] : liveRoutes.map((r) => r.id));
  };

  const pickRoute = (id) => {
    if (!canDraw(routes.find((r) => r.id === id))) return;
    userPickedRoute.current = true;
    setSelectedIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
    Animated.spring(sheetY, {
      toValue: SNAP_MID,
      useNativeDriver: false,
      bounciness: 0,
    }).start();
  };

  const shapes = selectedRoutes.flatMap((r) => {
    const base = r.shapeVariants?.length ? r.shapeVariants : [r.shape];
    return base.map((s) => ({
      routeId: r.id,
      color: `#${r.color || "1565C0"}`,
      points: s.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    }));
  });

  const mapKey = useMemo(
    () =>
      selectedRoutes
        .map((r) => r.id)
        .sort()
        .join("|") || "empty",
    [selectedRoutes],
  );

  const arrivals = selectedStop
    ? getArrivalsForStop(selectedStop, vehicles)
    : [];
  const fullSchedule =
    selectedStop && showSchedule
      ? getScheduledArrivals(selectedStop, false)
      : [];

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
          {shapes.map((s, i) =>
            s.points.length ? (
              <Fragment key={`${s.routeId}-${i}`}>
                <Polyline
                  coordinates={s.points}
                  strokeColor="rgba(15,23,42,0.3)"
                  strokeWidth={5}
                  lineCap="round"
                  lineJoin="round"
                />
                <Polyline
                  coordinates={s.points}
                  strokeColor={s.color}
                  strokeWidth={3}
                  lineCap="round"
                  lineJoin="round"
                />
              </Fragment>
            ) : null,
          )}

          {selectedStops.map((stop) => {
            const color = (
              stop.routeIds
                .filter((id) => selectedIds.includes(id))
                .map((id) => routesById[id]?.color)
                .find(Boolean) ||
              stop.routeIds.map((id) => routesById[id]?.color).find(Boolean) ||
              "1565C0"
            ).toUpperCase();
            return (
              <Marker
                key={stop.id}
                coordinate={{ latitude: stop.lat, longitude: stop.lon }}
                anchor={{ x: 0.5, y: 0.5 }}
                tracksViewChanges={false}
                image={stopMarkerImages[color] ?? stopMarkerImages["1565C0"]}
                onPress={() => handleStopPress(stop)}
              />
            );
          })}

          {visibleVehicles.map((v) => (
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
              <Tab
                label="Routes"
                active={tab === "routes"}
                onPress={() => setTab("routes")}
              />
              <Tab
                label="Messages"
                active={tab === "messages"}
                onPress={() => setTab("messages")}
              />
            </View>
          </View>

          {tab === "routes" ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollInner}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.sectionTitle}>Pick a route</Text>
              <Text style={styles.sectionSub}>
                Tap to add or remove routes. Stops and buses update
                automatically.
              </Text>

              <Pressable style={styles.toggleAllBtn} onPress={toggleAll}>
                <Text style={styles.toggleAllText}>
                  {allSelected ? "Deselect All" : "Select All"}
                </Text>
              </Pressable>

              {liveRoutes.map((r) => {
                const active = selectedIds.includes(r.id);
                const busCount = vehicles.filter(
                  (v) => v.routeId === r.id,
                ).length;
                return (
                  <Pressable
                    key={r.id}
                    onPress={() => pickRoute(r.id)}
                    style={[styles.routeCard, active && styles.routeCardActive]}
                  >
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: `#${r.color || "1565C0"}` },
                      ]}
                    />
                    <View style={{ flex: 1 }}>
                      <View style={styles.routeRow}>
                        <Text style={styles.routeNum}>{r.shortName}</Text>
                        <View style={styles.badges}>
                          <Text style={styles.busBadge}>
                            {busCount} {busCount === 1 ? "bus" : "buses"}
                          </Text>
                          {active && (
                            <Text style={styles.selectedBadge}>Selected</Text>
                          )}
                        </View>
                      </View>
                      <Text style={styles.routeName}>{r.longName}</Text>
                      <Text style={styles.routeMeta}>
                        {r.stops.length} stops
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollInner}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.sectionTitle}>Messages</Text>
              <Text style={styles.sectionSub}>
                Service alerts and arrival info show up here.
              </Text>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Upcoming arrivals</Text>
                {selectedStops.slice(0, 4).map((s, i) => (
                  <View key={s.id} style={styles.arrivalRow}>
                    <View>
                      <Text style={styles.stopName}>{s.name}</Text>
                      <Text style={styles.stopMeta}>
                        {s.routeIds.slice(0, 2).join(", ") ||
                          primaryRoute?.shortName ||
                          "Route"}{" "}
                        · Stop {i + 1}
                      </Text>
                    </View>
                    <Text style={styles.eta}>
                      {stopArrivals[s.id]?.[0]?.label ?? "No data"}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Service alerts</Text>
                <View style={styles.alertBox}>
                  <Text style={styles.alertTitle}>All clear</Text>
                  <Text style={styles.alertBody}>
                    No active alerts at the moment.
                  </Text>
                </View>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </View>

      {selectedStop && (
        <View style={styles.popupOverlay}>
          <Pressable style={styles.popupBackdrop} onPress={handleCloseStop} />
          <View
            style={[
              styles.popupCard,
              showSchedule && { maxHeight: screenHeight * 0.72 },
            ]}
          >
            <Pressable style={styles.popupClose} onPress={handleCloseStop}>
              <Text style={styles.popupCloseText}>✕</Text>
            </Pressable>

            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 8 }}
            >
              <Text style={styles.popupStopName}>{selectedStop.name}</Text>
              <Text style={styles.popupStopSub}>Stop {selectedStop.id}</Text>
              <View style={styles.popupDivider} />

              {arrivals.length === 0 ? (
                <Text style={styles.popupEmpty}>
                  No service information available
                </Text>
              ) : (
                arrivals.map((arrival, i) => {
                  const route = routesById[arrival.routeId];
                  return (
                    <View key={i} style={styles.popupRow}>
                      <View
                        style={[
                          styles.popupBadge,
                          { backgroundColor: `#${route?.color || "1565C0"}` },
                        ]}
                      >
                        <Text style={styles.popupBadgeText}>
                          {(route?.shortName ?? arrival.routeId).replace(
                            /"/g,
                            "",
                          )}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.popupEta,
                          arrival.isScheduled && styles.popupEtaScheduled,
                        ]}
                      >
                        {arrival.label}
                      </Text>
                    </View>
                  );
                })
              )}

              <Pressable
                style={styles.scheduleToggleBtn}
                onPress={() => setShowSchedule((s) => !s)}
              >
                <Text style={styles.scheduleToggleText}>
                  {showSchedule ? "▲ Hide Schedule" : "▼ View Full Schedule"}
                </Text>
              </Pressable>

              {showSchedule && (
                <>
                  <View style={styles.popupDivider} />
                  <Text style={styles.scheduleHeader}>
                    Today's Remaining Arrivals
                  </Text>
                  {fullSchedule.length === 0 ? (
                    <Text style={styles.popupEmpty}>
                      No more departures today
                    </Text>
                  ) : (
                    fullSchedule.map((item, i) => {
                      const route = routesById[item.routeId];
                      return (
                        <View key={i} style={styles.scheduleRow}>
                          <View
                            style={[
                              styles.scheduleBadge,
                              {
                                backgroundColor: `#${route?.color || "1565C0"}`,
                              },
                            ]}
                          >
                            <Text style={styles.scheduleBadgeText}>
                              {(route?.shortName ?? item.routeId).replace(
                                /"/g,
                                "",
                              )}
                            </Text>
                          </View>
                          <Text style={styles.scheduleTime}>
                            {fmt12(item.timeStr)}
                          </Text>
                        </View>
                      );
                    })
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

function Tab({ active, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive]}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function BusMarker({ active, color }) {
  return (
    <View style={[styles.busWrap, active && styles.busWrapActive]}>
      <View
        style={[
          styles.busBody,
          { backgroundColor: color || "#8b5a2b" },
          active && styles.busBodyActive,
        ]}
      >
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
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2.5,
    borderColor: "#f8fafc",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f172a",
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 8,
    elevation: 8,
  },
  busBodyActive: { borderColor: "#fff" },
  busGlyph: { width: 15, alignItems: "center" },
  glyphTop: {
    width: 15,
    height: 7,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    backgroundColor: "#f8fafc",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    marginBottom: 1,
  },
  glyphWindow: {
    width: 4,
    height: 3,
    borderRadius: 1,
    backgroundColor: "#fff",
  },
  glyphDoor: {
    width: 15,
    height: 6,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: "#f8fafc",
    marginBottom: 1,
  },
  glyphWheels: {
    width: 15,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: -1,
  },
  glyphWheel: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: "#f8fafc",
  },

  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: "#f8fafc",
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: "hidden",
    shadowColor: "#0f172a",
    shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: -10 },
    shadowRadius: 24,
    elevation: 18,
  },
  handleArea: {
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 14,
    backgroundColor: "#f8fafc",
  },
  handle: {
    width: 56,
    height: 6,
    borderRadius: 999,
    alignSelf: "center",
    backgroundColor: "#cbd5e1",
    marginBottom: 14,
  },
  tabs: {
    flexDirection: "row",
    backgroundColor: "#e2e8f0",
    borderRadius: 16,
    padding: 4,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 12,
  },
  tabActive: { backgroundColor: "#0f172a" },
  tabText: { color: "#334155", fontWeight: "600" },
  tabTextActive: { color: "#f8fafc" },

  scroll: { flex: 1 },
  scrollInner: { paddingHorizontal: 18, paddingBottom: 40 },
  sectionTitle: {
    color: "#0f172a",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 6,
  },
  sectionSub: {
    color: "#64748b",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },

  toggleAllBtn: {
    alignSelf: "flex-end",
    backgroundColor: "#0f172a",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    marginBottom: 14,
  },
  toggleAllText: { color: "#f8fafc", fontSize: 13, fontWeight: "700" },

  routeCard: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  routeCardActive: { borderColor: "#0f172a", backgroundColor: "#eff6ff" },
  swatch: { width: 12, borderRadius: 999, marginRight: 14 },
  routeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  routeNum: { color: "#0f172a", fontSize: 24, fontWeight: "700" },
  badges: { flexDirection: "row", alignItems: "center", gap: 6 },
  busBadge: {
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: "#dbeafe",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  selectedBadge: {
    color: "#166534",
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: "#dcfce7",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  routeName: {
    color: "#1e293b",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  routeMeta: { color: "#64748b", fontSize: 13 },

  panel: {
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  panelTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 14,
  },
  arrivalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
  },
  stopName: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 3,
  },
  stopMeta: { color: "#64748b", fontSize: 12 },
  eta: { color: "#1d4ed8", fontSize: 15, fontWeight: "700" },
  alertBox: { backgroundColor: "#f8fafc", borderRadius: 18, padding: 14 },
  alertTitle: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 5,
  },
  alertBody: { color: "#64748b", fontSize: 13, lineHeight: 19 },

  popupOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 999,
  },
  popupBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(15,23,42,0.45)",
  },
  popupCard: {
    backgroundColor: "#fff",
    borderRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 28,
    width: "80%",
    shadowColor: "#0f172a",
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 30,
  },
  popupClose: {
    position: "absolute",
    top: 14,
    right: 14,
    backgroundColor: "#f1f5f9",
    borderRadius: 999,
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  popupCloseText: { color: "#475569", fontSize: 13, fontWeight: "700" },
  popupStopName: {
    color: "#0f172a",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 4,
    paddingRight: 32,
    lineHeight: 22,
  },
  popupStopSub: { color: "#94a3b8", fontSize: 12, marginBottom: 16 },
  popupDivider: { height: 1, backgroundColor: "#e2e8f0", marginBottom: 16 },
  popupEmpty: {
    color: "#94a3b8",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 8,
  },
  popupRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  popupBadge: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999 },
  popupBadgeText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  popupEta: { color: "#1d4ed8", fontSize: 18, fontWeight: "800" },
  popupEtaScheduled: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: "600",
  },
  scheduleToggleBtn: {
    alignSelf: "center",
    marginTop: 14,
    paddingVertical: 8,
    paddingHorizontal: 18,
    backgroundColor: "#f1f5f9",
    borderRadius: 999,
  },
  scheduleToggleText: {
    color: "#475569",
    fontSize: 13,
    fontWeight: "700",
  },
  scheduleHeader: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 4,
  },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  scheduleBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    marginRight: 12,
  },
  scheduleBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  scheduleTime: {
    color: "#1e293b",
    fontSize: 14,
    fontWeight: "500",
  },
});
