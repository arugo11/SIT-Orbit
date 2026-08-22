export type LocalPromptAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export class LocalPromptUnavailableError extends Error {
  constructor(message = "Chrome Prompt API is unavailable on this device.") {
    super(message);
    this.name = "LocalPromptUnavailableError";
  }
}

interface PromptSession {
  prompt(input: string, options?: Record<string, unknown>): Promise<string>;
  destroy?(): void | Promise<void>;
}

interface PromptApiConstructor {
  availability(
    options?: Record<string, unknown>,
  ): LocalPromptAvailability | Promise<LocalPromptAvailability>;
  create(options?: Record<string, unknown>): Promise<PromptSession>;
}

interface PromptApiGlobal {
  LanguageModel?: PromptApiConstructor;
}

function getPromptApi(): PromptApiConstructor | null {
  const candidate = (globalThis as typeof globalThis & PromptApiGlobal)
    .LanguageModel;
  if (
    !candidate ||
    typeof candidate.availability !== "function" ||
    typeof candidate.create !== "function"
  ) {
    return null;
  }
  return candidate;
}

function normalizeAvailability(value: unknown): LocalPromptAvailability {
  if (
    value === "available" ||
    value === "downloadable" ||
    value === "downloading" ||
    value === "unavailable"
  ) {
    return value;
  }
  return "unavailable";
}

export async function getLocalPromptAvailability(): Promise<LocalPromptAvailability> {
  const promptApi = getPromptApi();
  if (!promptApi) {
    return "unavailable";
  }
  try {
    return normalizeAvailability(await promptApi.availability());
  } catch {
    return "unavailable";
  }
}

export interface LocalPromptRequest<T> {
  prompt: string;
  responseConstraint: Record<string, unknown>;
  parse: (value: unknown) => T;
}

/**
 * Runs a structured prompt only through Chrome's on-device Prompt API.
 * This function deliberately has no remote-provider fallback.
 */
export async function runLocalPrompt<T>(
  request: LocalPromptRequest<T>,
): Promise<T> {
  const promptApi = getPromptApi();
  if (!promptApi) {
    throw new LocalPromptUnavailableError();
  }
  const availability = normalizeAvailability(await promptApi.availability());
  if (availability !== "available") {
    throw new LocalPromptUnavailableError(
      `Chrome Prompt API is ${availability}; local model is not ready.`,
    );
  }

  const session = await promptApi.create({
    responseConstraint: request.responseConstraint,
  });
  try {
    const response = await session.prompt(request.prompt, {
      responseConstraint: request.responseConstraint,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response);
    } catch {
      throw new Error("Chrome Prompt API returned non-JSON output.");
    }
    return request.parse(parsed);
  } finally {
    await session.destroy?.();
  }
}
