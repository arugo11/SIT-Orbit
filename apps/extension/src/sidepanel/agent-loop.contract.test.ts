import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("Side Panel B1 closed-loop contract", () => {
  it("keeps API calls behind explicit proposal, approval, and completion controls", () => {
    expect(appSource).toContain("agentApiClient.startRun");
    expect(appSource).toContain("agentApiClient.submitToolResult");
    expect(appSource).toContain("agentApiClient.verify");
    expect(appSource).toContain("onClick={() => void requestProposal()}");
    expect(appSource).toContain("onClick={approveProposal}");
    expect(appSource).toContain("onClick={rejectProposal}");
    expect(appSource).toContain("onClick={() => void verifyCompletion()}");
    expect(appSource).toContain("approved: true");
    expect(appSource).toContain("completed: true");
    expect(appSource).toContain("notes: loopState.changeNote.trim()");
  });

  it("renders the proposal evidence and returned action_completed event", () => {
    expect(appSource).toContain("loopState.proposal.title");
    expect(appSource).toContain("loopState.proposal.reason");
    expect(appSource).toContain("loopState.proposal.duration_minutes");
    expect(appSource).toContain("proposalEvidence(loopState.proposal)");
    expect(appSource).toContain('event.event_type === "action_completed"');
    expect(appSource).toContain("loopState.completionEvent.event_type");
  });
});
