import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PhotoSliceGameScreen } from "./src/screens/PhotoSliceGameScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <PhotoSliceGameScreen />
    </SafeAreaProvider>
  );
}
