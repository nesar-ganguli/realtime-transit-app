import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated, Dimensions, PanResponder, Platform,
  Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, View,
} from "react-native";
import Constants from "expo-constants";
import MapView, { Marker, Polyline } from "react-native-maps";

import { routes, routesById, stops, stopsById, tripRouteById, tripStopTimesByTripId } from "./src/services/gtfsStatic";
import stopMarkerImages from "./src/generated/stopMarkerImages";
import { startRealtimePolling } from "./src/services/gtfsRealtime";
import { haversine } from "./src/utils/distance";

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

const TEST_ALERTS = [
  "Demo alert: Route 2W is running 8 minutes behind schedule near downtown because of heavy traffic near Walnut Street and 11th Street, riders should expect rolling delays, temporary stop crowding, and minor schedule adjustments through the afternoon until normal service spacing is restored across the corridor.",
];

function formatAlertDistance(meters) {
  if (!meters) return "Off";
  return `${(meters * 0.000621371).toFixed(1)} mi`;
}

function vehicleKey(vehicle, index = 0) {
  return [
    vehicle?.id || "vehicle",
    vehicle?.tripId || "trip",
    vehicle?.routeId || "route",
    vehicle?.lastUpdated || "time",
    index,
  ].join("-");
}

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
  const notificationsRef = useRef(null);
  const locationRef = useRef(null);
  const locationWatcherRef = useRef(null);

  const [tab, setTab] = useState("routes");
  const [selectedIds, setSelectedIds] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [activeBusId, setActiveBusId] = useState(null);
  const [popupBusId, setPopupBusId] = useState(null);
  const [alertDistance, setAlertDistance] = useState(500);
  const [notificationsReady, setNotificationsReady] = useState(false);
  const [alertExpanded, setAlertExpanded] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [mapHeading, setMapHeading] = useState(0);
  const firedAlerts = useRef(new Set());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (Constants.appOwnership === "expo") {
        setNotificationsReady(false);
        notificationsRef.current = null;
        return;
      }

      try {
        const Notifications = await import("expo-notifications");
        if (cancelled) return;

        notificationsRef.current = Notifications;
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: false,
          }),
        });
        await Notifications.requestPermissionsAsync();
        if (!cancelled) {
          setNotificationsReady(true);
        }
      } catch (error) {
        notificationsRef.current = null;
        if (!cancelled) {
          setNotificationsReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const Location = await import("expo-location");
        if (cancelled) return;

        locationRef.current = Location;

        const permission = await Location.requestForegroundPermissionsAsync();
        if (cancelled || permission.status !== "granted") {
          return;
        }

        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        if (!cancelled) {
          setUserLocation({
            latitude: current.coords.latitude,
            longitude: current.coords.longitude,
          });
        }

        locationWatcherRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 10000,
            distanceInterval: 20,
          },
          (position) => {
            if (cancelled) return;
            setUserLocation({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            });
          }
        );
      } catch (error) {
        locationRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
      locationWatcherRef.current?.remove?.();
      locationWatcherRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!notificationsReady || !alertDistance || !visibleVehicles.length || !selectedStops.length) return;
    visibleVehicles.forEach(v => {
      selectedStops.forEach(stop => {
        const dist = haversine(v.lat, v.lon, stop.lat, stop.lon);
        if (dist > alertDistance) return;
        const key = `${v.id}-${stop.id}`;
        if (firedAlerts.current.has(key)) return;
        firedAlerts.current.add(key);
        const route = routesById[v.routeId];
        notificationsRef.current?.scheduleNotificationAsync?.({
          content: {
            title: `Bus approaching ${stop.name}`,
            body: `Route ${route?.shortName ?? v.routeId} is ${Math.round(dist)}m away.`,
          },
          trigger: null,
        });
        setTimeout(() => firedAlerts.current.delete(key), 2 * 60 * 1000);
      });
    });
  }, [notificationsReady, visibleVehicles, selectedStops, alertDistance]);

  useEffect(() => {
    firedAlerts.current = new Set();
  }, [selectedIds]);

  useEffect(() => {
    setAlertExpanded(false);
  }, [alerts]);

  useEffect(() => {
    return startRealtimePolling({
      stopsById,
      tripRouteById,
      tripStopTimesByTripId,
      onUpdate: ({ vehicles: v, alerts: nextAlerts }) => {
        setVehicles(v);
        setAlerts(nextAlerts ?? []);
      },
      onError: () => {
        setVehicles([]);
        setAlerts([]);
      },
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
    return visibleVehicles.find((v, index) => vehicleKey(v, index) === activeBusId) ?? visibleVehicles[0] ?? null;
  }, [visibleVehicles, activeBusId]);

  const popupBus = useMemo(() => {
    return visibleVehicles.find((v, index) => vehicleKey(v, index) === popupBusId) ?? null;
  }, [visibleVehicles, popupBusId]);

  useEffect(() => {
    if (!visibleVehicles.length) { setActiveBusId(null); return; }
    setActiveBusId(cur => {
      const still = visibleVehicles.some((v, index) => vehicleKey(v, index) === cur);
      return still ? cur : vehicleKey(visibleVehicles[0], 0);
    });
  }, [visibleVehicles]);

  useEffect(() => {
    if (!popupBusId) return;
    if (!visibleVehicles.some((v, index) => vehicleKey(v, index) === popupBusId)) {
      setPopupBusId(null);
    }
  }, [popupBusId, visibleVehicles]);

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

  const centerOnUser = () => {
    if (!userLocation || !mapRef.current) return;

    mapRef.current.animateToRegion({
      latitude: userLocation.latitude,
      longitude: userLocation.longitude,
      latitudeDelta: 0.02,
      longitudeDelta: 0.02,
    }, 500);
  };

  const syncMapHeading = async () => {
    if (!mapRef.current?.getCamera) return;

    try {
      const camera = await mapRef.current.getCamera();
      setMapHeading(Number(camera?.heading) || 0);
    } catch (error) {
      // leave the last heading alone if camera lookup flakes
    }
  };

  const resetNorth = () => {
    if (!mapRef.current?.animateCamera) return;

    mapRef.current.animateCamera(
      {
        heading: 0,
      },
      { duration: 350 }
    );

    setMapHeading(0);
  };


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
          showsUserLocation={!!userLocation}
          showsMyLocationButton={false}
          onMapReady={syncMapHeading}
          onRegionChangeComplete={syncMapHeading}
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

          {visibleVehicles.map((v, index) => (
            <Marker
              key={vehicleKey(v, index)}
              coordinate={{ latitude: v.lat, longitude: v.lon }}
              title={v.nextStopName || "Bus"}
              onPress={() => {
                const key = vehicleKey(v, index);
                setActiveBusId(key);
                setPopupBusId(key);
              }}
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

        </MapView>

        <Pressable
          onPress={centerOnUser}
          style={[styles.locateBtn, !userLocation && styles.locateBtnDisabled]}
        >
          <View style={styles.locateIcon}>
            <View style={styles.locateIconRing} />
            <View style={styles.locateIconDot} />
          </View>
        </Pressable>

        <Pressable onPress={resetNorth} style={styles.compassBtn}>
          <View style={styles.compassFace}>
            <Animated.View
              style={[
                styles.compassNeedleWrap,
                { transform: [{ rotate: `${mapHeading}deg` }] },
              ]}
            >
              <View style={styles.compassNeedleNorth} />
              <View style={styles.compassNeedleSouth} />
            </Animated.View>
            <Text style={styles.compassLabel}>N</Text>
          </View>
        </Pressable>

        {popupBus ? (
          <View style={styles.busPopup}>
            <View style={[styles.busPopupHeader, { backgroundColor: `#${routesById[popupBus.routeId]?.color || "ef4444"}` }]}>
              <View>
                <Text style={styles.busPopupSubtitle}>
                  {routesById[popupBus.routeId]?.shortName || popupBus.routeId} · {routesById[popupBus.routeId]?.longName || "Transit"}
                </Text>
              </View>
              <Pressable onPress={() => setPopupBusId(null)} style={styles.busPopupClose}>
                <Text style={styles.busPopupCloseText}>x</Text>
              </Pressable>
            </View>

            <View style={styles.busPopupBody}>


              <View style={styles.busPopupTableHead}>
                <Text style={[styles.busPopupHeadCell, styles.busPopupStopCell]}>Stop</Text>
                <Text style={styles.busPopupHeadCell}>Scheduled</Text>
                <Text style={styles.busPopupHeadCell}>Estimated</Text>
              </View>

              {(popupBus.upcomingStops?.length ? popupBus.upcomingStops : [
                {
                  stopName: popupBus.nextStopName || "Waiting on next stop",
                  scheduledTime: "--",
                  estimatedTime: popupBus.etaToNextStop || "--",
                },
              ]).map((stop, index) => (
                <View key={`${popupBus.id}-${stop.stopId || index}`} style={styles.busPopupRow}>
                  <Text style={[styles.busPopupCell, styles.busPopupStopCell]}>{stop.stopName}</Text>
                  <Text style={styles.busPopupCell}>{stop.scheduledTime || "--"}</Text>
                  <Text style={styles.busPopupCell}>{stop.estimatedTime || "--"}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}


        <Animated.View style={[styles.sheet, { top: sheetY, bottom: 0 }]}>
          <View style={styles.handleArea} {...panResponder.panHandlers}>
            <View style={styles.handle} />
            {(alerts.length ? alerts : TEST_ALERTS).length ? (
              <AlertBanner
                alerts={alerts.length ? alerts : TEST_ALERTS}
                expanded={alertExpanded}
                onPress={() => setAlertExpanded((value) => !value)}
              />
            ) : null}
            <View style={styles.tabs}>
              <Tab label="Routes" active={tab === "routes"} onPress={() => setTab("routes")} />
              <Tab label="Settings" active={tab === "messages"} onPress={() => setTab("messages")} />
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


              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Arrival alerts</Text>
                <Text style={styles.alertBody}>Notify me when a bus is within:</Text>
                <View style={styles.distanceRow}>
                  {[0, 250, 500, 1000, 2000].map(d => (
                    <Pressable
                      key={d}
                      onPress={() => setAlertDistance(d)}
                      style={[styles.distanceBtn, alertDistance === d && styles.distanceBtnActive]}
                    >
                      <Text style={[styles.distanceBtnText, alertDistance === d && styles.distanceBtnTextActive]}>
                        {formatAlertDistance(d)}
                      </Text>
                    </Pressable>
                  ))}
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

function AlertBanner({ alerts, expanded, onPress }) {
  const text = useMemo(() => alerts.join("  •  "), [alerts]);

  return (
    <Pressable onPress={onPress} style={styles.alertBanner}>
      <Text style={styles.alertBannerLabel}>Alert</Text>
      <View style={styles.alertBannerTrack}>
        <Text
          numberOfLines={expanded ? 0 : 1}
          ellipsizeMode="tail"
          style={[styles.alertBannerText, expanded && styles.alertBannerTextExpanded]}
        >
          {text}
        </Text>
      </View>
      <Text style={styles.alertBannerToggle}>{expanded ? "Hide" : "More"}</Text>
    </Pressable>
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
  locateBtn: {
    position: "absolute",
    top: 18,
    right: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(248,250,252,0.96)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 8,
  },
  locateBtnDisabled: {
    opacity: 0.55,
  },
  compassBtn: {
    position: "absolute",
    top: 72,
    right: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(248,250,252,0.96)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 8,
  },
  compassFace: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#cbd5e1",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  compassNeedleWrap: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  compassNeedleNorth: {
    position: "absolute",
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderBottomWidth: 7,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "#ef4444",
  },
  compassNeedleSouth: {
    position: "absolute",
    bottom: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 3,
    borderRightWidth: 3,
    borderTopWidth: 7,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: "#0f172a",
  },
  compassLabel: {
    position: "absolute",
    top: -10,
    fontSize: 8,
    fontWeight: "700",
    color: "#0f172a",
  },
  busPopup: {
    position: "absolute",
    left: 18,
    right: 18,
    top: 132,
    backgroundColor: "#ffffff",
    borderRadius: 18,
    overflow: "hidden",
    shadowColor: "#0f172a",
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 16,
    elevation: 10,
  },
  busPopupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  busPopupTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
  busPopupSubtitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 20,
  },
  busPopupClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  busPopupCloseText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  busPopupBody: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  busPopupMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  busPopupMetaLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  busPopupMetaValue: {
    color: "#0f172a",
    fontSize: 13,
    fontWeight: "700",
  },
  busPopupTableHead: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 8,
  },
  busPopupHeadCell: {
    flex: 1,
    color: "#0f172a",
    fontSize: 12,
    fontWeight: "700",
  },
  busPopupRow: {
    flexDirection: "row",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  busPopupCell: {
    flex: 1,
    color: "#334155",
    fontSize: 12,
    lineHeight: 16,
  },
  busPopupStopCell: {
    flex: 1.7,
    paddingRight: 10,
  },
  locateIcon: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  locateIconRing: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#2563eb",
  },
  locateIconDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#2563eb",
  },
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
  alertBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#fff7ed",
    borderWidth: 1,
    borderColor: "#fed7aa",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
    minHeight: 40,
  },
  alertBannerLabel: {
    color: "#9a3412",
    fontSize: 12,
    fontWeight: "700",
    marginRight: 10,
  },
  alertBannerTrack: {
    flex: 1,
    paddingRight: 8,
  },
  alertBannerText: {
    color: "#7c2d12",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
  },
  alertBannerTextExpanded: {
    lineHeight: 18,
  },
  alertBannerToggle: {
    color: "#9a3412",
    fontSize: 11,
    fontWeight: "700",
    paddingTop: 2,
  },
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
