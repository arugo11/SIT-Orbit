import { describe, expect, it } from "vitest";
import {
  editableInputsForOperation,
  FixtureLibraryWriteStateMachine,
  isLibraryActionEditableInputs,
} from "./library-actions";

const ref = "orbit-library://record/ABCDEFGHIJKLMNOP";

describe("library action confirmation inputs", () => {
  it("bounds editable fields and keeps page range for ILL copy", () => {
    const operation = {
      action_type: "ill_copy" as const,
      resource_ref: ref,
      arguments: {
        receiver: "library desk",
        payment: "student account",
        fee: null,
        page_range: "12-18",
      },
    };
    const inputs = editableInputsForOperation(operation);
    expect(isLibraryActionEditableInputs("ill_copy", inputs)).toBe(true);
    expect(
      isLibraryActionEditableInputs("ill_copy", {
        action_type: "ill_copy",
        values: { ...inputs.values, page_range: "" },
      }),
    ).toBe(false);
    expect(
      isLibraryActionEditableInputs("ill_copy", {
        action_type: "ill_copy",
        values: { ...inputs.values, unknown: "not allowed" },
      }),
    ).toBe(false);
  });

  it("requires preview, submit, and verified read-back in fixture state", () => {
    const machine = new FixtureLibraryWriteStateMachine();
    expect(machine.preview("renew").state).toBe("previewed");
    expect(machine.submit("renew").state).toBe("submitted");
    expect(machine.verify("renew").state).toBe("verified");
    expect(() => machine.submit("renew")).toThrow();
  });
});
