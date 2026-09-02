export interface ScombzConversationBinding {
  tabId: number;
  expiresAt: number;
  contentScriptGeneration: string;
  adapterVersion: "scombz-student-v1";
  serviceWorkerEpoch: string;
}

export type ScombzBindingResolution =
  | { status: "known"; binding: ScombzConversationBinding }
  | {
      status: "unavailable";
      reason_code:
        | "scombz_source_not_pinned"
        | "scombz_handle_expired"
        | "scombz_handle_epoch_mismatch";
    };

export class ScombzTabSessionRegistry {
  private readonly bindings = new Map<string, ScombzConversationBinding>();

  constructor(
    private readonly serviceWorkerEpoch: string,
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  resolve(conversationId: string): ScombzBindingResolution {
    const binding = this.bindings.get(conversationId);
    if (!binding) {
      return { status: "unavailable", reason_code: "scombz_source_not_pinned" };
    }
    if (binding.expiresAt <= this.now()) {
      this.bindings.delete(conversationId);
      return { status: "unavailable", reason_code: "scombz_handle_expired" };
    }
    if (binding.serviceWorkerEpoch !== this.serviceWorkerEpoch) {
      this.bindings.delete(conversationId);
      return {
        status: "unavailable",
        reason_code: "scombz_handle_epoch_mismatch",
      };
    }
    return { status: "known", binding };
  }

  pin(
    conversationId: string,
    source: Omit<ScombzConversationBinding, "expiresAt" | "serviceWorkerEpoch">,
  ): "pinned" | "scombz_source_tab_changed" | "scombz_source_reloaded" {
    const existing = this.bindings.get(conversationId);
    if (existing && existing.tabId !== source.tabId) {
      return "scombz_source_tab_changed";
    }
    if (
      existing &&
      (existing.contentScriptGeneration !== source.contentScriptGeneration ||
        existing.serviceWorkerEpoch !== this.serviceWorkerEpoch)
    ) {
      this.bindings.delete(conversationId);
      return "scombz_source_reloaded";
    }
    this.bindings.set(conversationId, {
      ...source,
      expiresAt: this.now() + this.ttlMs,
      serviceWorkerEpoch: this.serviceWorkerEpoch,
    });
    return "pinned";
  }

  delete(conversationId: string): void {
    this.bindings.delete(conversationId);
  }

  invalidateTab(tabId: number): void {
    for (const [conversationId, binding] of this.bindings) {
      if (binding.tabId === tabId) this.bindings.delete(conversationId);
    }
  }

  clear(): void {
    this.bindings.clear();
  }
}
