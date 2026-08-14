import { describe, expect, it } from "vitest";
import type { ActionProposal, OrbitEvent } from "../api/client";
import { agentLoopReducer, initialAgentLoopState } from "./loop-state";

const proposal: ActionProposal = {
  action_id: "act-b1-omiya",
  title: "合成関数の微分を2問確認する",
  reason: "明日の課題と利用可能時間に合うためです。",
  duration_minutes: 12,
  evidence: [
    {
      evidence_id: "ev-assignment-calculus-01",
      title: "微分積分学の課題は明日締切",
      source_type: "assignment",
      locator: "demo://scombz/assignments/calculus-01",
      data_classification: "synthetic",
    },
  ],
  external_action: "checklist_update",
  requires_confirmation: true,
  prompt_version: "fixture-b1-omiya-v1",
};

const completionEvent: OrbitEvent = {
  event_id: "evt-b1-omiya-completed",
  event_type: "action_completed",
  scenario_id: "b1-omiya-calculus",
  occurred_at: "2026-08-12T14:40:00+09:00",
  campus: "omiya",
  data_classification: "synthetic",
  payload: { action_id: proposal.action_id, notes: "例題を2問確認" },
};

describe("Side Panel agent loop state", () => {
  it("keeps the proposal pending until explicit approval and rejects without a write action", () => {
    const proposed = agentLoopReducer(initialAgentLoopState, {
      type: "proposal-received",
      proposal,
    });

    expect(proposed.status).toBe("proposed");
    expect(agentLoopReducer(proposed, { type: "verify-started" })).toEqual(
      proposed,
    );

    const rejected = agentLoopReducer(proposed, { type: "rejected" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.proposal).toEqual(proposal);
  });

  it("carries the optional note through approval and records the returned completion event", () => {
    let state = agentLoopReducer(initialAgentLoopState, {
      type: "proposal-received",
      proposal,
    });
    state = agentLoopReducer(state, {
      type: "note-changed",
      note: "例題を2問確認",
    });
    state = agentLoopReducer(state, { type: "approved" });
    expect(state.status).toBe("approved");
    expect(state.changeNote).toBe("例題を2問確認");

    state = agentLoopReducer(state, { type: "verify-started" });
    expect(state.status).toBe("verifying");
    state = agentLoopReducer(state, {
      type: "verification-received",
      event: completionEvent,
    });

    expect(state.status).toBe("completed");
    expect(state.completionEvent).toEqual(completionEvent);
  });

  it("returns to approved state after a completion request error so retry remains explicit", () => {
    let state = agentLoopReducer(initialAgentLoopState, {
      type: "proposal-received",
      proposal,
    });
    state = agentLoopReducer(state, { type: "approved" });
    state = agentLoopReducer(state, { type: "verify-started" });
    state = agentLoopReducer(state, {
      type: "verification-failed",
      error: "Agent API returned HTTP 422.",
    });

    expect(state.status).toBe("approved");
    expect(state.error).toBe("Agent API returned HTTP 422.");
  });
});
