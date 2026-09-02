import { describe, expect, it } from "vitest";
import { ScombzTabSessionRegistry } from "./scombz-tab-session";

describe("ScombzTabSessionRegistry", () => {
  it("pins one conversation to one source generation", () => {
    let now = 1_000;
    const registry = new ScombzTabSessionRegistry("epoch-1", 100, () => now);
    expect(
      registry.pin("conversation-1", {
        tabId: 10,
        contentScriptGeneration: "generation-1",
        adapterVersion: "scombz-student-v1",
      }),
    ).toBe("pinned");
    expect(registry.resolve("conversation-1").status).toBe("known");
    now = 1_101;
    expect(registry.resolve("conversation-1")).toEqual({
      status: "unavailable",
      reason_code: "scombz_handle_expired",
    });
  });

  it("rejects tab switches and source reloads", () => {
    const registry = new ScombzTabSessionRegistry("epoch-1");
    const source = {
      tabId: 10,
      contentScriptGeneration: "generation-1",
      adapterVersion: "scombz-student-v1" as const,
    };
    expect(registry.pin("conversation-1", source)).toBe("pinned");
    expect(registry.pin("conversation-1", { ...source, tabId: 11 })).toBe(
      "scombz_source_tab_changed",
    );
    expect(
      registry.pin("conversation-1", {
        ...source,
        contentScriptGeneration: "generation-2",
      }),
    ).toBe("scombz_source_reloaded");
  });

  it("invalidates every binding owned by a removed tab", () => {
    const registry = new ScombzTabSessionRegistry("epoch-1");
    for (const conversationId of ["conversation-1", "conversation-2"]) {
      registry.pin(conversationId, {
        tabId: 10,
        contentScriptGeneration: "generation-1",
        adapterVersion: "scombz-student-v1",
      });
    }
    registry.invalidateTab(10);
    expect(registry.resolve("conversation-1").status).toBe("unavailable");
    expect(registry.resolve("conversation-2").status).toBe("unavailable");
  });
});
