import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';

import { routes, stops, vehicles } from './src/mock/transitData';

const { height: screenHeight } = Dimensions.get('window');

const SHEET_MAX_TOP = 110;
const SHEET_MID_TOP = Math.round(screenHeight * 0.52);
const SHEET_MIN_TOP = Math.round(screenHeight * 0.8);
const SHEET_POSITIONS = [SHEET_MAX_TOP, SHEET_MID_TOP, SHEET_MIN_TOP];

const sheetContentHeight = screenHeight - SHEET_MAX_TOP;

const mapRegion = {
  latitude: 39.1653,
  longitude: -86.5264,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

const hasRenderableShape = (route) => {
  if (!route) {
    return false;
  }

  if (route.shapeVariants?.some((shape) => shape.length > 1)) {
    return true;
  }

  return Array.isArray(route.shape) && route.shape.length > 1;
};

export default function App() {
  const mapRef = useRef(null);
  const sheetTop = useRef(new Animated.Value(SHEET_MID_TOP)).current;
  const dragStart = useRef(SHEET_MID_TOP);

  const [activeTab, setActiveTab] = useState('routes');
  const [selectedRouteIds, setSelectedRouteIds] = useState(routes[0]?.id ? [routes[0].id] : []);
  const [selectedBusId, setSelectedBusId] = useState(vehicles[0]?.id ?? null);

  const selectedRoutes = useMemo(() => {
    const picked = routes.filter(
      (route) => selectedRouteIds.includes(route.id) && hasRenderableShape(route)
    );
    const fallback = routes.find((route) => hasRenderableShape(route));
    return picked.length ? picked : fallback ? [fallback] : [];
  }, [selectedRouteIds]);

  const primaryRoute = selectedRoutes[0] ?? null;

  const selectedStops = useMemo(() => {
    if (!selectedRoutes.length) {
      return [];
    }

    const stopIds = [...new Set(selectedRoutes.flatMap((route) => route.stops))];
    return stopIds.map((stopId) => stops.find((stop) => stop.id === stopId)).filter(Boolean);
  }, [selectedRoutes]);

  const routeVehicles = useMemo(() => {
    if (!selectedRoutes.length) {
      return [];
    }

    const routeIds = new Set(selectedRoutes.map((route) => route.id));
    return vehicles.filter((vehicle) => routeIds.has(vehicle.routeId));
  }, [selectedRoutes]);

  const selectedBus = useMemo(() => {
    const activeVehicle =
      routeVehicles.find((vehicle) => vehicle.id === selectedBusId) ?? routeVehicles[0] ?? null;

    return activeVehicle;
  }, [routeVehicles, selectedBusId]);

  useEffect(() => {
    if (!selectedRoutes.length) {
      return;
    }

    setSelectedBusId((current) => {
      const stillVisible = routeVehicles.some((vehicle) => vehicle.id === current);
      if (stillVisible) {
        return current;
      }

      return routeVehicles[0]?.id ?? null;
    });

    const baseShapes = selectedRoutes.flatMap((route) =>
      route.shapeVariants?.length ? route.shapeVariants : [route.shape]
    );

    const points = baseShapes
      .flat()
      .map((point) => ({
        latitude: point.lat,
        longitude: point.lon,
      }))
      .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));

    if (points.length > 1 && mapRef.current) {
      mapRef.current.fitToCoordinates(points, {
        edgePadding: { top: 130, right: 80, bottom: 320, left: 80 },
        animated: true,
      });
    }
  }, [routeVehicles, selectedRoutes]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 6,
        onPanResponderGrant: () => {
          sheetTop.stopAnimation((value) => {
            dragStart.current = value;
          });
        },
        onPanResponderMove: (_, gesture) => {
          const next = dragStart.current + gesture.dy;
          const clamped = Math.max(SHEET_MAX_TOP, Math.min(SHEET_MIN_TOP, next));
          sheetTop.setValue(clamped);
        },
        onPanResponderRelease: (_, gesture) => {
          const releasePoint = dragStart.current + gesture.dy;
          const withMomentum = releasePoint + gesture.vy * 120;
          const snapPoint = SHEET_POSITIONS.reduce((closest, candidate) => {
            if (Math.abs(candidate - withMomentum) < Math.abs(closest - withMomentum)) {
              return candidate;
            }

            return closest;
          }, SHEET_POSITIONS[0]);

          Animated.spring(sheetTop, {
            toValue: snapPoint,
            useNativeDriver: false,
            bounciness: 0,
          }).start();
        },
      }),
    [sheetTop]
  );

  const onRoutePress = (routeId) => {
    const route = routes.find((item) => item.id === routeId);
    if (!hasRenderableShape(route)) {
      return;
    }

    setSelectedRouteIds((current) => {
      if (current.includes(routeId)) {
        if (current.length === 1) {
          return current;
        }

        return current.filter((id) => id !== routeId);
      }

      return [...current, routeId];
    });

    Animated.spring(sheetTop, {
      toValue: SHEET_MID_TOP,
      useNativeDriver: false,
      bounciness: 0,
    }).start();
  };

  const onBusPress = (busId) => {
    setSelectedBusId(busId);
  };

  const routeShapeVariants = selectedRoutes.flatMap((route) => {
    const baseShapes = route.shapeVariants?.length ? route.shapeVariants : [route.shape];

    return baseShapes.map((shape) => ({
      routeId: route.id,
      color: `#${route.color || '1565C0'}`,
      points: shape.map((point) => ({
        latitude: point.lat,
        longitude: point.lon,
      })),
    }));
  });

  const titleLabel =
    selectedRoutes.length === 1
      ? primaryRoute?.longName ?? 'Transit Map'
      : `${selectedRoutes.length} routes selected`;

  const mapSelectionKey = useMemo(() => {
    const ids = selectedRoutes.map((route) => route.id).sort();
    return ids.length ? ids.join('|') : 'empty';
  }, [selectedRoutes]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />

      <View style={styles.container}>
        <MapView
          key={mapSelectionKey}
          ref={mapRef}
          style={styles.map}
          initialRegion={mapRegion}
          showsCompass={false}
        >
          {routeShapeVariants.map((shape, index) =>
            shape.points.length ? (
                <Fragment key={`${shape.routeId}-${index}`}>
                  <Polyline
                    coordinates={shape.points}
                    strokeColor="rgba(15, 23, 42, 0.35)"
                    strokeWidth={10}
                    lineCap="round"
                    lineJoin="round"
                  />
                  <Polyline
                  coordinates={shape.points}
                  strokeColor={shape.color}
                  strokeWidth={6}
                  lineCap="round"
                  lineJoin="round"
                />
                </Fragment>
              ) : null
          )}

          {selectedStops.map((stop) => (
            <Marker
              key={stop.id}
              coordinate={{ latitude: stop.lat, longitude: stop.lon }}
              title={stop.name}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={styles.stopOuter}>
                <View style={styles.stopInner} />
              </View>
            </Marker>
          ))}

          {routeVehicles.map((vehicle) => {
            const isActive = vehicle.id === selectedBus?.id;

            return (
              <Marker
                key={vehicle.id}
                coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
                title={vehicle.nextStopName || 'Transit vehicle'}
                onPress={() => onBusPress(vehicle.id)}
                anchor={{ x: 0.5, y: 0.5 }}
                flat
                rotation={vehicle.bearing || 0}
              >
                <BusMarker
                  active={isActive}
                  label={vehicle.routeId || 'BT'}
                  color={`#${routes.find((route) => route.id === vehicle.routeId)?.color || '8b5a2b'}`}
                />
              </Marker>
            );
          })}

          {selectedBus ? (
            <Circle
              center={{ latitude: selectedBus.lat, longitude: selectedBus.lon }}
              radius={170}
              fillColor="rgba(249, 168, 37, 0.18)"
              strokeColor="rgba(249, 168, 37, 0.55)"
            />
          ) : null}
        </MapView>

        <View style={styles.mapHeader}>
          <View>
            <Text style={styles.mapEyebrow}>Bloomington Transit</Text>
            <Text style={styles.mapTitle}>{titleLabel}</Text>
          </View>

          <View style={styles.mapBadge}>
            <Text style={styles.mapBadgeLabel}>{routeVehicles.length} live</Text>
          </View>
        </View>

        <Animated.View style={[styles.sheet, { top: sheetTop, height: sheetContentHeight }]}>
          <View style={styles.sheetHandleArea} {...panResponder.panHandlers}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetTabs}>
              <SheetTab
                label="Routes"
                active={activeTab === 'routes'}
                onPress={() => setActiveTab('routes')}
              />
              <SheetTab
                label="Messages"
                active={activeTab === 'messages'}
                onPress={() => setActiveTab('messages')}
              />
            </View>
          </View>

          {activeTab === 'routes' ? (
            <ScrollView
              style={styles.sheetContent}
              contentContainerStyle={styles.sheetContentInner}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.sectionTitle}>Pick a route</Text>
              <Text style={styles.sectionIntro}>
                Tap routes to add or remove them from the map. Selected routes, stops, and buses stay visible together.
              </Text>

              {routes.map((route) => {
                const active = selectedRouteIds.includes(route.id);
                const renderable = hasRenderableShape(route);
                const routeStopCount = route.stops.length;
                const routeBusCount = vehicles.filter((vehicle) => vehicle.routeId === route.id).length;

                return (
                  <Pressable
                    key={route.id}
                    onPress={() => onRoutePress(route.id)}
                    style={[
                      styles.routeCard,
                      active && styles.routeCardActive,
                      !renderable && styles.routeCardMuted,
                    ]}
                  >
                    <View
                      style={[
                        styles.routeSwatch,
                        { backgroundColor: `#${route.color || '1565C0'}` },
                      ]}
                    />
                    <View style={styles.routeCardBody}>
                      <View style={styles.routeRow}>
                        <Text style={styles.routeShort}>{route.shortName}</Text>
                        <Text style={styles.routeBusCount}>
                          {!renderable ? 'No shape' : active ? 'Selected' : `${routeBusCount} buses`}
                        </Text>
                      </View>
                      <Text style={styles.routeLong}>{route.longName}</Text>
                      <Text style={styles.routeMeta}>{routeStopCount} stops on this shape</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : (
            <ScrollView
              style={styles.sheetContent}
              contentContainerStyle={styles.sheetContentInner}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.sectionTitle}>Messages</Text>
              <Text style={styles.sectionIntro}>
                Schedule rows and service notes stay here while the map remains visible underneath.
              </Text>

              <View style={styles.messagePanel}>
                <Text style={styles.messagePanelTitle}>Upcoming arrivals</Text>
                {selectedStops.slice(0, 4).map((stop, index) => (
                  <View key={stop.id} style={styles.arrivalRow}>
                    <View>
                      <Text style={styles.arrivalStop}>{stop.name}</Text>
                      <Text style={styles.arrivalRoute}>
                        {stop.routeIds.slice(0, 2).join(', ') || primaryRoute?.shortName || 'Route'} • Stop {index + 1}
                      </Text>
                    </View>
                    <Text style={styles.arrivalEta}>
                      {stop.upcomingArrivals?.[0]?.label || `${6 + index * 3} min`}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={styles.messagePanel}>
                <Text style={styles.messagePanelTitle}>Service messages</Text>
                <View style={styles.noticeCard}>
                  <Text style={styles.noticeTitle}>No active alerts right now</Text>
                  <Text style={styles.noticeBody}>
                    Live service notices and arrival alerts will appear here when the realtime layer lands.
                  </Text>
                </View>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

function SheetTab({ active, label, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.sheetTab, active && styles.sheetTabActive]}>
      <Text style={[styles.sheetTabText, active && styles.sheetTabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function BusMarker({ active, label, color }) {
  return (
    <View style={[styles.busMarkerWrap, active && styles.busMarkerWrapActive]}>
      <View
        style={[
          styles.busMarkerBody,
          { backgroundColor: color || '#8b5a2b' },
          active && styles.busMarkerBodyActive,
        ]}
      >
        <View style={styles.busGlyph}>
          <View style={styles.busGlyphTop}>
            <View style={styles.busGlyphWindow} />
            <View style={styles.busGlyphWindow} />
          </View>
          <View style={styles.busGlyphDoor} />
          <View style={styles.busGlyphWheels}>
            <View style={styles.busGlyphWheel} />
            <View style={styles.busGlyphWheel} />
          </View>
        </View>
        <Text style={styles.busMarkerRoute}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  map: {
    flex: 1,
  },
  mapHeader: {
    position: 'absolute',
    top: 18,
    left: 18,
    right: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  mapEyebrow: {
    color: '#bfdbfe',
    fontSize: 12,
    marginBottom: 3,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  mapTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '700',
    maxWidth: 220,
  },
  mapBadge: {
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  mapBadgeLabel: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 12,
  },
  stopOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#0f172a',
  },
  stopInner: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#0f172a',
  },
  busMarkerWrap: {
    alignItems: 'center',
  },
  busMarkerWrapActive: {
    transform: [{ scale: 1.08 }],
  },
  busMarkerBody: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#8b5a2b',
    borderWidth: 2.5,
    borderColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 8,
    elevation: 8,
  },
  busMarkerBodyActive: {
    borderColor: '#ffffff',
  },
  busGlyph: {
    width: 15,
    alignItems: 'center',
  },
  busGlyphTop: {
    width: 15,
    height: 7,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    backgroundColor: '#f8fafc',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    marginBottom: 1,
  },
  busGlyphWindow: {
    width: 4,
    height: 3,
    borderRadius: 1,
    backgroundColor: '#ffffff',
  },
  busGlyphDoor: {
    width: 15,
    height: 6,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: '#f8fafc',
    marginBottom: 1,
  },
  busGlyphWheels: {
    width: 15,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -1,
  },
  busGlyphWheel: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#f8fafc',
  },
  busMarkerRoute: {
    position: 'absolute',
    bottom: -14,
    minWidth: 22,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(15, 23, 42, 0.84)',
    color: '#f8fafc',
    fontSize: 8,
    fontWeight: '700',
    textAlign: 'center',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: '#f8fafc',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
    shadowColor: '#0f172a',
    shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: -10 },
    shadowRadius: 24,
    elevation: 18,
  },
  sheetHandleArea: {
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 14,
    backgroundColor: '#f8fafc',
  },
  sheetHandle: {
    width: 56,
    height: 6,
    borderRadius: 999,
    alignSelf: 'center',
    backgroundColor: '#cbd5e1',
    marginBottom: 14,
  },
  sheetTabs: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderRadius: 16,
    padding: 4,
  },
  sheetTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
  },
  sheetTabActive: {
    backgroundColor: '#0f172a',
  },
  sheetTabText: {
    color: '#334155',
    fontWeight: '600',
  },
  sheetTabTextActive: {
    color: '#f8fafc',
  },
  sheetContent: {
    flex: 1,
  },
  sheetContentInner: {
    paddingHorizontal: 18,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: '#0f172a',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 6,
  },
  sectionIntro: {
    color: '#64748b',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  routeCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  routeCardActive: {
    borderColor: '#0f172a',
    backgroundColor: '#eff6ff',
  },
  routeCardMuted: {
    opacity: 0.65,
  },
  routeSwatch: {
    width: 12,
    borderRadius: 999,
    marginRight: 14,
  },
  routeCardBody: {
    flex: 1,
  },
  routeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  routeShort: {
    color: '#0f172a',
    fontSize: 24,
    fontWeight: '700',
  },
  routeBusCount: {
    color: '#1d4ed8',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: '#dbeafe',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  routeLong: {
    color: '#1e293b',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  routeMeta: {
    color: '#64748b',
    fontSize: 13,
  },
  messagePanel: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  messagePanelTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14,
  },
  arrivalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  arrivalStop: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 3,
  },
  arrivalRoute: {
    color: '#64748b',
    fontSize: 12,
  },
  arrivalEta: {
    color: '#1d4ed8',
    fontSize: 15,
    fontWeight: '700',
  },
  noticeCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 18,
    padding: 14,
  },
  noticeTitle: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 5,
  },
  noticeBody: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
  },
});
