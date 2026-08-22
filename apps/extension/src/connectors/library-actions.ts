import type {
  LibraryActionOptionsResult,
  LibraryOperation,
} from "../api/client";

export const LIBRARY_ACTION_TYPES = [
  "visit_shelf",
  "open_online",
  "reserve",
  "intercampus_transfer",
  "renew",
  "purchase_request",
  "ill_loan",
  "ill_copy",
] as const;

export type LibraryActionType = (typeof LIBRARY_ACTION_TYPES)[number];

export type LibraryActionInput =
  | "pickup_campus"
  | "reason"
  | "receiver"
  | "payment"
  | "fee"
  | "page_range";

export type LibraryActionOption = {
  action_type: LibraryActionType;
  available: boolean;
  reason_code: string;
  required_inputs: LibraryActionInput[];
};

export type LibraryActionOptionsProjection = LibraryActionOptionsResult;

/** Values the local confirmation UI may edit; no provider fields are accepted. */
export type LibraryActionEditableInputs =
  | { action_type: "visit_shelf"; values: Record<string, never> }
  | { action_type: "open_online"; values: Record<string, never> }
  | { action_type: "reserve"; values: { pickup_campus: "omiya" | "toyosu" } }
  | {
      action_type: "intercampus_transfer";
      values: { pickup_campus: "omiya" | "toyosu" };
    }
  | { action_type: "renew"; values: Record<string, never> }
  | { action_type: "purchase_request"; values: { reason: string } }
  | {
      action_type: "ill_loan";
      values: { receiver: string; payment: string; fee: string | null };
    }
  | {
      action_type: "ill_copy";
      values: {
        receiver: string;
        payment: string;
        fee: string | null;
        page_range: string;
      };
    };

export type LibraryActionPreviewOfficial = {
  title: string | null;
  holdings: Array<{
    campus: "toyosu" | "omiya" | "unknown";
    location: string | null;
    call_number: string | null;
  }>;
  pickup_campus: "omiya" | "toyosu" | null;
  current_due_date: string | null;
  resulting_due_date: string | null;
  receiver: string | null;
  payment: string | null;
  fee: string | null;
  page_range: string | null;
};

export function readOnlyInputsForOperation(
  operation: LibraryOperation,
): LibraryActionEditableInputs | null {
  switch (operation.action_type) {
    case "visit_shelf":
    case "open_online":
      return { action_type: operation.action_type, values: {} };
    default:
      return null;
  }
}

export function isLibraryActionEditableInputs(
  actionType: LibraryOperation["action_type"],
  value: unknown,
): value is LibraryActionEditableInputs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { action_type?: unknown; values?: unknown };
  if (candidate.action_type !== actionType) return false;
  if (!candidate.values || typeof candidate.values !== "object") return false;
  const values = candidate.values as Record<string, unknown>;
  const hasOnly = (keys: readonly string[]) => {
    const actual = Object.keys(values).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
    );
  };
  if (
    actionType === "visit_shelf" ||
    actionType === "open_online" ||
    actionType === "renew"
  ) {
    return hasOnly([]);
  }
  if (actionType === "reserve" || actionType === "intercampus_transfer") {
    return (
      hasOnly(["pickup_campus"]) &&
      (values.pickup_campus === "omiya" || values.pickup_campus === "toyosu")
    );
  }
  if (actionType === "purchase_request") {
    return (
      hasOnly(["reason"]) &&
      typeof values.reason === "string" &&
      values.reason.trim().length > 0 &&
      values.reason.length <= 500
    );
  }
  const common =
    typeof values.receiver === "string" &&
    values.receiver.trim().length > 0 &&
    values.receiver.length <= 200 &&
    typeof values.payment === "string" &&
    values.payment.trim().length > 0 &&
    values.payment.length <= 100 &&
    (values.fee === null ||
      (typeof values.fee === "string" && values.fee.length <= 100));
  if (actionType === "ill_loan") {
    return hasOnly(["receiver", "payment", "fee"]) && common;
  }
  return (
    hasOnly(["receiver", "payment", "fee", "page_range"]) &&
    common &&
    typeof values.page_range === "string" &&
    values.page_range.trim().length > 0 &&
    values.page_range.length <= 100
  );
}

export type FixtureLibraryWriteState =
  | { state: "previewed"; action_type: LibraryActionType }
  | { state: "submitted"; action_type: LibraryActionType }
  | { state: "verified"; action_type: LibraryActionType };

/**
 * Deterministic submit/read-back seam used by fixtures only. Live providers
 * never call this state machine and remain explicitly unavailable.
 */
export class FixtureLibraryWriteStateMachine {
  private current: FixtureLibraryWriteState | null = null;

  preview(actionType: LibraryActionType): FixtureLibraryWriteState {
    this.current = { state: "previewed", action_type: actionType };
    return this.current;
  }

  submit(actionType: LibraryActionType): FixtureLibraryWriteState {
    if (
      this.current?.state !== "previewed" ||
      this.current.action_type !== actionType
    ) {
      throw new Error("Fixture library action preview is not current.");
    }
    this.current = { state: "submitted", action_type: actionType };
    return this.current;
  }

  verify(actionType: LibraryActionType): FixtureLibraryWriteState {
    if (
      this.current?.state !== "submitted" ||
      this.current.action_type !== actionType
    ) {
      throw new Error("Fixture library action has no verified read-back.");
    }
    this.current = { state: "verified", action_type: actionType };
    return this.current;
  }
}

export function isLibraryActionType(
  value: unknown,
): value is LibraryActionType {
  return (
    typeof value === "string" &&
    (LIBRARY_ACTION_TYPES as readonly string[]).includes(value)
  );
}

export function unavailableLibraryActionOptions(
  resource_ref: string,
  reason_code: string,
  data_classification: "public" | "personal" = "public",
): LibraryActionOptionsProjection {
  return {
    schema_version: "v1",
    status: "unavailable",
    resource_ref,
    options: [],
    data_classification,
    reason_code,
  };
}
