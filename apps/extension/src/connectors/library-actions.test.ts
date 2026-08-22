import { describe, expect, it } from "vitest";
import {
  FixtureLibraryWriteStateMachine,
  isLibraryActionEditableInputs,
  readOnlyInputsForOperation,
} from "./library-actions";

const ref = "orbit-library://record/ABCDEFGHIJKLMNOP";

describe("library action confirmation inputs", () => {
  it("does not derive write form values from an API operation", () => {
    const operation = {
      action_type: "ill_copy" as const,
      resource_ref: ref,
    };
    expect(readOnlyInputsForOperation(operation)).toBeNull();
    expect(
      isLibraryActionEditableInputs("ill_copy", {
        action_type: "ill_copy",
        values: {
          receiver: "library desk",
          payment: "student account",
          fee: null,
          page_range: "",
        },
      }),
    ).toBe(false);
    expect(
      isLibraryActionEditableInputs("ill_copy", {
        action_type: "ill_copy",
        values: {
          receiver: "library desk",
          payment: "student account",
          fee: null,
          page_range: "12-18",
          unknown: "not allowed",
        },
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
