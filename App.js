import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
// import { decodeFeed } from "./app/services/gtfsRealtime";
import { useBusTracker } from "./app/viewmodels/useBusTracker";
export default function App() {
  // decodeFeed(
  //   "https://s3.amazonaws.com/etatransit.gtfs/bloomingtontransit.etaspot.net/alerts.pb",
  // ).
  const { realtimeData, lastUpdated } = useBusTracker();
  console.log("last updated:", lastUpdated);
  then((d) => console.log(JSON.stringify(d, null, 2)));
  return (
    <View style={styles.container}>
      <Text>Open up App.js to start working on your app!</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});
