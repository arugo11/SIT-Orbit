import {
  type ActionProposal,
  B1_OMIYA_EVENT,
  createFoundationClient,
  type OrbitEvent,
} from "@sit-orbit/api-client";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const DEFAULT_API_BASE_URL = "http://localhost:8000";
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 18;

type Phase =
  | "loading"
  | "proposed"
  | "approved"
  | "rejected"
  | "verifying"
  | "completed"
  | "error";

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "APIとの通信に失敗しました。接続先とfixture設定を確認してください。";
}

function isCompletionEvent(
  event: OrbitEvent,
  proposal: ActionProposal,
): boolean {
  return (
    event.event_type === "action_completed" &&
    event.scenario_id === B1_OMIYA_EVENT.scenario_id &&
    event.campus === B1_OMIYA_EVENT.campus &&
    event.data_classification === "synthetic" &&
    event.payload?.action_id === proposal.action_id
  );
}

function formatPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

export default function App() {
  const apiBaseUrl =
    process.env.EXPO_PUBLIC_ORBIT_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const client = useMemo(
    () => createFoundationClient(apiBaseUrl),
    [apiBaseUrl],
  );
  const [phase, setPhase] = useState<Phase>("loading");
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [completionEvent, setCompletionEvent] = useState<OrbitEvent | null>(
    null,
  );
  const [durationText, setDurationText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadProposal = useCallback(async () => {
    setPhase("loading");
    setProposal(null);
    setCompletionEvent(null);
    setDurationText("");
    setError(null);

    try {
      const capabilities = await client.capabilities();
      if (capabilities.agent_backend !== "fixture") {
        throw new Error(
          "このモバイルデモはfixture backend専用です。外部モデルへは接続しません。",
        );
      }
      const nextProposal = await client.propose();
      if (
        nextProposal.duration_minutes < MIN_DURATION_MINUTES ||
        nextProposal.duration_minutes > MAX_DURATION_MINUTES
      ) {
        throw new Error("デモで選べる行動時間は1〜18分です。");
      }
      setProposal(nextProposal);
      setDurationText(String(nextProposal.duration_minutes));
      setPhase("proposed");
    } catch (loadError) {
      setPhase("error");
      setError(describeError(loadError));
    }
  }, [client]);

  useEffect(() => {
    void loadProposal();
  }, [loadProposal]);

  const duration = Number.parseInt(durationText, 10);
  const durationIsValid =
    Number.isInteger(duration) &&
    duration >= MIN_DURATION_MINUTES &&
    duration <= MAX_DURATION_MINUTES;
  const durationWasChanged =
    proposal !== null &&
    durationIsValid &&
    duration !== proposal.duration_minutes;

  const changeDuration = (nextDuration: number): void => {
    const bounded = Math.min(
      MAX_DURATION_MINUTES,
      Math.max(MIN_DURATION_MINUTES, nextDuration),
    );
    setDurationText(String(bounded));
    setError(null);
  };

  const approveProposal = (): void => {
    if (phase !== "proposed" || !proposal || !durationIsValid) {
      return;
    }
    setError(null);
    setPhase("approved");
  };

  const rejectProposal = (): void => {
    if (phase !== "proposed" || !proposal) {
      return;
    }
    setError(null);
    setPhase("rejected");
  };

  const verifyCompletion = async (): Promise<void> => {
    if (phase !== "approved" || !proposal || !durationIsValid) {
      return;
    }

    setPhase("verifying");
    setError(null);
    try {
      const notes = durationWasChanged
        ? `duration_minutes=${duration}; original_duration_minutes=${proposal.duration_minutes}`
        : `duration_minutes=${duration}`;
      const event = await client.verify(proposal.action_id, {
        scenario_id: B1_OMIYA_EVENT.scenario_id,
        campus: B1_OMIYA_EVENT.campus,
        approved: true,
        completed: true,
        notes,
      });
      if (!isCompletionEvent(event, proposal)) {
        throw new Error(
          "action_completedのsyntheticイベントを受け取れませんでした。",
        );
      }
      setCompletionEvent(event);
      setPhase("completed");
    } catch (verificationError) {
      setPhase("approved");
      setError(describeError(verificationError));
    }
  };

  const interactionLocked = phase === "loading" || phase === "verifying";
  const resetLabel =
    phase === "rejected" ? "別の提案を取得" : "最初からやり直す";

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.wordmark}>{"SIT//ORBIT"}</Text>
          <Text style={styles.campus}>OMIYA</Text>
        </View>

        <View style={styles.demoBanner} accessibilityRole="text">
          <View style={styles.demoDot} />
          <Text style={styles.demoLabel}>SYNTHETIC DEMO · FIXTURE ONLY</Text>
        </View>

        {phase === "loading" ? (
          <View style={styles.centerState}>
            <ActivityIndicator color="#7df9ff" size="large" />
            <Text style={styles.stateTitle}>提案を準備しています</Text>
            <Text style={styles.stateText}>
              合成イベントと根拠をAPIで確認中です。
            </Text>
          </View>
        ) : null}

        {phase === "error" ? (
          <View style={styles.stateCard}>
            <Text style={styles.stateTitle}>提案を取得できませんでした</Text>
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.stateText}>
              接続先: {apiBaseUrl}
              {"\n"}
              実機では同じWi-Fi上の開発マシンのホスト名またはIPを設定してください。
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="提案を再試行"
              style={styles.primary}
              onPress={() => void loadProposal()}
            >
              <Text style={styles.primaryText}>再試行</Text>
            </Pressable>
          </View>
        ) : null}

        {proposal ? (
          <View style={styles.content}>
            <Text style={styles.eyebrow}>
              {phase === "completed"
                ? "ACTION COMPLETED"
                : "NEXT VECTOR · PROPOSAL"}
            </Text>
            <Text style={styles.title}>{proposal.title}</Text>
            <Text style={styles.reason}>{proposal.reason}</Text>

            <View style={styles.evidence}>
              <Text style={styles.evidenceTitle}>EVIDENCE · 根拠</Text>
              {proposal.evidence.map((item) => (
                <View key={item.evidence_id} style={styles.evidenceRow}>
                  <View style={styles.evidenceMarker} />
                  <View style={styles.evidenceCopy}>
                    <Text style={styles.evidenceText}>{item.title}</Text>
                    <Text style={styles.evidenceMeta}>
                      {item.source_type} · {item.data_classification}
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            {phase === "proposed" ? (
              <View style={styles.controlCard}>
                <Text style={styles.controlTitle}>承認前に行動時間を確認</Text>
                <Text style={styles.controlText}>
                  1〜18分の範囲で変更できます。変更内容は完了時のメモに記録します。
                </Text>
                <View style={styles.durationRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="行動時間を1分短くする"
                    style={styles.stepper}
                    onPress={() => changeDuration(duration - 1)}
                    disabled={
                      interactionLocked || !durationIsValid || duration <= 1
                    }
                  >
                    <Text style={styles.stepperText}>−</Text>
                  </Pressable>
                  <TextInput
                    accessibilityLabel="行動時間（分）"
                    keyboardType="number-pad"
                    maxLength={2}
                    value={durationText}
                    onChangeText={(value) => {
                      setDurationText(value.replace(/[^0-9]/g, ""));
                      setError(null);
                    }}
                    style={styles.durationInput}
                  />
                  <Text style={styles.minutes}>分</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="行動時間を1分長くする"
                    style={styles.stepper}
                    onPress={() => changeDuration(duration + 1)}
                    disabled={
                      interactionLocked || !durationIsValid || duration >= 18
                    }
                  >
                    <Text style={styles.stepperText}>＋</Text>
                  </Pressable>
                </View>
                {!durationIsValid ? (
                  <Text style={styles.validationText}>
                    1〜18分で入力してください。
                  </Text>
                ) : null}
                <View style={styles.buttonStack}>
                  <Pressable
                    accessibilityRole="button"
                    style={[
                      styles.primary,
                      !durationIsValid && styles.disabled,
                    ]}
                    onPress={approveProposal}
                    disabled={interactionLocked || !durationIsValid}
                  >
                    <Text style={styles.primaryText}>提案を承認する</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.secondary}
                    onPress={rejectProposal}
                    disabled={interactionLocked}
                  >
                    <Text style={styles.secondaryText}>
                      却下（APIに送信しない）
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {phase === "approved" || phase === "verifying" ? (
              <View style={styles.controlCard}>
                <Text style={styles.controlTitle}>承認済み</Text>
                <Text style={styles.controlText}>
                  行動が完了したら、実際の完了イベントをAPIへ記録します。
                </Text>
                {durationWasChanged ? (
                  <Text style={styles.changeNote}>
                    変更後の時間: {duration}分（提案時:{" "}
                    {proposal.duration_minutes}分）
                  </Text>
                ) : null}
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                <Pressable
                  accessibilityRole="button"
                  style={[
                    styles.primary,
                    phase === "verifying" && styles.disabled,
                  ]}
                  onPress={() => void verifyCompletion()}
                  disabled={phase === "verifying"}
                >
                  {phase === "verifying" ? (
                    <ActivityIndicator color="#06101e" />
                  ) : (
                    <Text style={styles.primaryText}>
                      完了を確認して記録する
                    </Text>
                  )}
                </Pressable>
              </View>
            ) : null}

            {phase === "rejected" ? (
              <View style={styles.stateCard}>
                <Text style={styles.stateTitle}>提案を却下しました</Text>
                <Text style={styles.stateText}>
                  却下はAPIへ送信していません。
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {phase === "completed" && completionEvent ? (
          <View style={styles.completionCard}>
            <Text style={styles.completionTitle}>
              完了イベントを受信しました
            </Text>
            <Text style={styles.completionText}>
              APIが返した実際の action_completed イベントです。
            </Text>
            <View style={styles.eventDetails}>
              <Text style={styles.eventLabel}>EVENT TYPE</Text>
              <Text style={styles.eventValue}>
                {completionEvent.event_type}
              </Text>
              <Text style={styles.eventLabel}>SCENARIO</Text>
              <Text style={styles.eventValue}>
                {completionEvent.scenario_id}
              </Text>
              <Text style={styles.eventLabel}>CAMPUS</Text>
              <Text style={styles.eventValue}>{completionEvent.campus}</Text>
              <Text style={styles.eventLabel}>PAYLOAD</Text>
              <Text selectable style={styles.payload}>
                {formatPayload(completionEvent.payload)}
              </Text>
            </View>
          </View>
        ) : null}

        {phase === "rejected" || phase === "completed" ? (
          <Pressable
            accessibilityRole="button"
            style={styles.reset}
            onPress={() => void loadProposal()}
          >
            <Text style={styles.resetText}>{resetLabel}</Text>
          </Pressable>
        ) : null}

        <Text style={styles.tagline}>Every action enters your orbit.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#060915" },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 28,
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
  campus: { color: "#7df9ff", fontSize: 11, letterSpacing: 2 },
  demoBanner: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: "rgba(125,249,255,0.3)",
    borderRadius: 999,
    backgroundColor: "rgba(125,249,255,0.08)",
  },
  demoDot: {
    width: 6,
    height: 6,
    marginRight: 8,
    borderRadius: 3,
    backgroundColor: "#7df9ff",
  },
  demoLabel: {
    color: "#7df9ff",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.1,
  },
  content: { paddingTop: 44 },
  eyebrow: {
    marginBottom: 18,
    color: "#6cb7ff",
    fontSize: 11,
    letterSpacing: 2,
  },
  title: {
    color: "#f4f7ff",
    fontSize: 38,
    fontWeight: "800",
    lineHeight: 47,
    letterSpacing: -1.2,
  },
  reason: { marginTop: 20, color: "#9ba9c7", fontSize: 16, lineHeight: 27 },
  evidence: {
    marginTop: 30,
    padding: 19,
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
  evidenceRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginVertical: 6,
  },
  evidenceMarker: {
    width: 6,
    height: 6,
    marginTop: 7,
    marginRight: 10,
    borderRadius: 3,
    backgroundColor: "#7df9ff",
  },
  evidenceCopy: { flex: 1 },
  evidenceText: { color: "#c7d0e6", fontSize: 14, lineHeight: 20 },
  evidenceMeta: {
    marginTop: 2,
    color: "#697895",
    fontSize: 10,
    letterSpacing: 0.4,
  },
  controlCard: {
    marginTop: 18,
    padding: 19,
    borderWidth: 1,
    borderColor: "rgba(125,249,255,0.28)",
    borderRadius: 18,
    backgroundColor: "rgba(15,23,50,0.72)",
  },
  controlTitle: { color: "#f4f7ff", fontSize: 17, fontWeight: "700" },
  controlText: { marginTop: 8, color: "#9ba9c7", fontSize: 13, lineHeight: 21 },
  durationRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 18,
  },
  stepper: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(125,249,255,0.4)",
    borderRadius: 22,
  },
  stepperText: { color: "#7df9ff", fontSize: 24, lineHeight: 26 },
  durationInput: {
    minWidth: 62,
    marginLeft: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#7df9ff",
    color: "#f4f7ff",
    fontSize: 28,
    fontWeight: "800",
    textAlign: "right",
  },
  minutes: { marginHorizontal: 8, color: "#9ba9c7", fontSize: 16 },
  validationText: {
    marginTop: -8,
    marginBottom: 10,
    color: "#ffadad",
    fontSize: 12,
    textAlign: "center",
  },
  buttonStack: { gap: 10 },
  primary: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 17,
    borderRadius: 999,
    backgroundColor: "#7df9ff",
  },
  primaryText: { color: "#06101e", fontSize: 15, fontWeight: "800" },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 17,
    borderWidth: 1,
    borderColor: "rgba(108,183,255,0.35)",
    borderRadius: 999,
  },
  secondaryText: { color: "#c7d0e6", fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  stateCard: {
    marginTop: 44,
    padding: 22,
    borderWidth: 1,
    borderColor: "rgba(108,183,255,0.25)",
    borderRadius: 18,
    backgroundColor: "rgba(15,23,50,0.72)",
  },
  centerState: {
    flex: 1,
    minHeight: 330,
    alignItems: "center",
    justifyContent: "center",
  },
  stateTitle: {
    marginTop: 14,
    color: "#f4f7ff",
    fontSize: 18,
    fontWeight: "700",
  },
  stateText: { marginTop: 8, color: "#9ba9c7", fontSize: 14, lineHeight: 22 },
  errorText: { marginTop: 10, color: "#ffadad", fontSize: 14, lineHeight: 22 },
  completionCard: {
    marginTop: 18,
    padding: 19,
    borderWidth: 1,
    borderColor: "rgba(125,249,255,0.5)",
    borderRadius: 18,
    backgroundColor: "rgba(23,70,75,0.32)",
  },
  completionTitle: { color: "#7df9ff", fontSize: 18, fontWeight: "800" },
  completionText: {
    marginTop: 8,
    color: "#c7d0e6",
    fontSize: 13,
    lineHeight: 21,
  },
  eventDetails: {
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "rgba(125,249,255,0.2)",
  },
  eventLabel: {
    marginTop: 8,
    color: "#6cb7ff",
    fontSize: 10,
    letterSpacing: 1.4,
  },
  eventValue: { marginTop: 3, color: "#f4f7ff", fontSize: 14 },
  payload: {
    marginTop: 5,
    color: "#c7d0e6",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 17,
  },
  changeNote: { marginTop: 14, color: "#7df9ff", fontSize: 13 },
  reset: { alignItems: "center", marginTop: 24, paddingVertical: 12 },
  resetText: {
    color: "#9ba9c7",
    fontSize: 13,
    textDecorationLine: "underline",
  },
  tagline: {
    marginTop: "auto",
    paddingTop: 32,
    color: "#697895",
    fontSize: 11,
    textAlign: "center",
    letterSpacing: 1,
  },
});
