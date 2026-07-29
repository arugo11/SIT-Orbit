import { StatusBar } from "expo-status-bar";
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.wordmark}>{"SIT//ORBIT"}</Text>
        <Text style={styles.campus}>OMIYA</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.eyebrow}>NEXT VECTOR · 12 MIN</Text>
        <Text style={styles.title}>合成関数の微分を{"\n"}2問確認する</Text>
        <Text style={styles.reason}>
          明日の課題に必要な内容で直近の誤答があり、次の授業までに完了できます。
        </Text>

        <View style={styles.evidence}>
          <Text style={styles.evidenceTitle}>TELEMETRY</Text>
          <Text style={styles.evidenceText}>課題締切まで21時間</Text>
          <Text style={styles.evidenceText}>直近2回の誤答</Text>
          <Text style={styles.evidenceText}>利用可能時間18分</Text>
        </View>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity accessibilityRole="button" style={styles.primary}>
          <Text style={styles.primaryText}>この行動を開始</Text>
        </TouchableOpacity>
        <Text style={styles.tagline}>Every action enters your orbit.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: "#060915",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 18,
  },
  wordmark: {
    color: "#f4f7ff",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  campus: {
    color: "#7df9ff",
    fontSize: 11,
    letterSpacing: 2,
  },
  content: {
    flex: 1,
    justifyContent: "center",
  },
  eyebrow: {
    marginBottom: 18,
    color: "#6cb7ff",
    fontSize: 11,
    letterSpacing: 2,
  },
  title: {
    color: "#f4f7ff",
    fontSize: 40,
    fontWeight: "800",
    lineHeight: 48,
    letterSpacing: -1.5,
  },
  reason: {
    marginTop: 20,
    color: "#9ba9c7",
    fontSize: 16,
    lineHeight: 27,
  },
  evidence: {
    marginTop: 32,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(108,183,255,0.25)",
    borderRadius: 18,
    backgroundColor: "rgba(15,23,50,0.72)",
  },
  evidenceTitle: {
    marginBottom: 12,
    color: "#6cb7ff",
    fontSize: 10,
    letterSpacing: 2,
  },
  evidenceText: {
    marginVertical: 4,
    color: "#c7d0e6",
    fontSize: 14,
  },
  footer: {
    paddingBottom: 24,
  },
  primary: {
    alignItems: "center",
    padding: 17,
    borderRadius: 999,
    backgroundColor: "#7df9ff",
  },
  primaryText: {
    color: "#06101e",
    fontSize: 15,
    fontWeight: "800",
  },
  tagline: {
    marginTop: 18,
    color: "#697895",
    fontSize: 11,
    textAlign: "center",
    letterSpacing: 1,
  },
});
