import type { components } from "@sit-orbit/api-client";

export type B1OrbitEvent = components["schemas"]["OrbitEvent"];
export type B1EvidenceLink = components["schemas"]["EvidenceLink"];

export const B1_OMIYA_EVENT: B1OrbitEvent = {
  event_id: "evt-b1-omiya-campus-entry",
  event_type: "campus_entered",
  scenario_id: "b1-omiya-calculus",
  occurred_at: "2026-08-12T14:24:00+09:00",
  campus: "omiya",
  data_classification: "synthetic",
  payload: {
    minutes_until_next_class: 31,
    available_minutes: 18,
  },
};

export const B1_OMIYA_CONTEXT: B1EvidenceLink[] = [
  {
    evidence_id: "ev-assignment-calculus-01",
    title: "微分積分学の課題は明日締切",
    source_type: "assignment",
    locator: "demo://scombz/assignments/calculus-01",
    data_classification: "synthetic",
  },
  {
    evidence_id: "ev-attempt-chain-rule-02",
    title: "合成関数の微分で直近2回誤答",
    source_type: "learning_history",
    locator: "demo://orbit/attempts/chain-rule",
    data_classification: "synthetic",
  },
  {
    evidence_id: "ev-calendar-window-18m",
    title: "次の授業まで18分利用可能",
    source_type: "calendar",
    locator: "demo://calendar/free-window",
    data_classification: "synthetic",
  },
];

export function isSyntheticOrPublic(value: string): boolean {
  return value === "synthetic" || value === "public";
}

export function isSafeB1Proposal(
  proposal: components["schemas"]["ActionProposal"],
): boolean {
  return proposal.evidence.every(
    (evidence) =>
      isSyntheticOrPublic(evidence.data_classification) ||
      (evidence.source_type === "calendar" &&
        evidence.data_classification === "personal" &&
        evidence.locator.startsWith("orbit-calendar://availability/")),
  );
}
