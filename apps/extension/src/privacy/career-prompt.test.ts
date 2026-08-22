import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLocalPromptAvailability,
  LocalPromptUnavailableError,
  runLocalPrompt,
} from "./career-prompt";

type PromptApiGlobal = typeof globalThis & {
  LanguageModel?: {
    availability: (options?: Record<string, unknown>) => Promise<string>;
    create: (options?: Record<string, unknown>) => Promise<{
      prompt: (
        input: string,
        options?: Record<string, unknown>,
      ) => Promise<string>;
      destroy: () => void;
    }>;
  };
};

const promptGlobal = globalThis as PromptApiGlobal;

afterEach(() => {
  delete promptGlobal.LanguageModel;
});

describe("Chrome local Prompt API runtime", () => {
  it("reports unavailable without a LanguageModel implementation", async () => {
    expect(await getLocalPromptAvailability()).toBe("unavailable");
  });

  it("runs structured prompts on-device and destroys the session", async () => {
    const destroy = vi.fn();
    const create = vi.fn(async () => ({
      prompt: vi.fn(async () => JSON.stringify({ count: 3 })),
      destroy,
    }));
    const availability = vi.fn(async () => "available");
    promptGlobal.LanguageModel = { availability, create };

    const responseConstraint = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    };
    const result = await runLocalPrompt({
      prompt: "集計値だけを返してください",
      responseConstraint,
      parse: (value) => {
        if (
          !value ||
          typeof value !== "object" ||
          typeof (value as { count?: unknown }).count !== "number"
        ) {
          throw new Error("invalid response");
        }
        return value as { count: number };
      },
    });

    expect(result).toEqual({ count: 3 });
    expect(availability).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ responseConstraint });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when the local model is not ready", async () => {
    const create = vi.fn();
    promptGlobal.LanguageModel = {
      availability: vi.fn(async () => "downloadable"),
      create,
    };

    await expect(
      runLocalPrompt({
        prompt: "private CAST data",
        responseConstraint: { type: "object" },
        parse: (value) => value,
      }),
    ).rejects.toBeInstanceOf(LocalPromptUnavailableError);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not accept non-JSON output and still destroys the session", async () => {
    const destroy = vi.fn();
    promptGlobal.LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({
        prompt: vi.fn(async () => "not-json"),
        destroy,
      })),
    };

    await expect(
      runLocalPrompt({
        prompt: "private data",
        responseConstraint: { type: "object" },
        parse: (value) => value,
      }),
    ).rejects.toThrow("non-JSON");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
