import type { ActionProposal, OrbitEvent } from "../api/client";

export type AgentLoopStatus =
  | "idle"
  | "proposing"
  | "tool-running"
  | "reauth_required"
  | "resuming"
  | "proposed"
  | "approved"
  | "rejected"
  | "verifying"
  | "completed"
  | "error";

export interface AgentLoopState {
  status: AgentLoopStatus;
  proposal: ActionProposal | null;
  completionEvent: OrbitEvent | null;
  changeNote: string;
  error: string | null;
  pendingRunId: string | null;
  pendingToolCallId: string | null;
  pendingToolName:
    | "scombz_page_summary"
    | "google_calendar_availability"
    | null;
}

export const initialAgentLoopState: AgentLoopState = {
  status: "idle",
  proposal: null,
  completionEvent: null,
  changeNote: "",
  error: null,
  pendingRunId: null,
  pendingToolCallId: null,
  pendingToolName: null,
};

export type AgentLoopAction =
  | { type: "propose-started" }
  | {
      type: "tool-started";
      runId: string;
      toolCallId: string;
      toolName: "scombz_page_summary" | "google_calendar_availability";
    }
  | { type: "reauth-required"; error: string }
  | { type: "resume-started" }
  | { type: "proposal-received"; proposal: ActionProposal }
  | { type: "proposal-failed"; error: string }
  | { type: "note-changed"; note: string }
  | { type: "approved" }
  | { type: "rejected" }
  | { type: "verify-started" }
  | { type: "verification-received"; event: OrbitEvent }
  | { type: "verification-failed"; error: string };

export function agentLoopReducer(
  state: AgentLoopState,
  action: AgentLoopAction,
): AgentLoopState {
  switch (action.type) {
    case "propose-started":
      return {
        ...initialAgentLoopState,
        status: "proposing",
      };
    case "proposal-received":
      return {
        ...state,
        status: "proposed",
        proposal: action.proposal,
        completionEvent: null,
        error: null,
        pendingRunId: null,
        pendingToolCallId: null,
        pendingToolName: null,
      };
    case "tool-started":
      return {
        ...state,
        status: "tool-running",
        pendingRunId: action.runId,
        pendingToolCallId: action.toolCallId,
        pendingToolName: action.toolName,
        error: null,
      };
    case "reauth-required":
      return {
        ...state,
        status: "reauth_required",
        error: action.error,
      };
    case "resume-started":
      return {
        ...state,
        status: "resuming",
        error: null,
      };
    case "proposal-failed":
      return {
        ...initialAgentLoopState,
        status: "error",
        error: action.error,
      };
    case "note-changed":
      return {
        ...state,
        changeNote: action.note,
      };
    case "approved":
      return state.status === "proposed" && state.proposal
        ? { ...state, status: "approved", error: null }
        : state;
    case "rejected":
      return state.status === "proposed" && state.proposal
        ? { ...state, status: "rejected", error: null }
        : state;
    case "verify-started":
      return state.status === "approved"
        ? { ...state, status: "verifying", error: null }
        : state;
    case "verification-received":
      return state.status === "verifying"
        ? {
            ...state,
            status: "completed",
            completionEvent: action.event,
            error: null,
          }
        : state;
    case "verification-failed":
      return state.status === "verifying"
        ? {
            ...state,
            status: "approved",
            error: action.error,
          }
        : state;
  }
}
