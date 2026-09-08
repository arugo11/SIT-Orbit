import { CAST_ENTRY_URL, CAST_ORIGIN } from "../content/cast-reader";
import { MOODLE_LOGIN_URL, MOODLE_ORIGIN } from "../content/moodle-reader";
import {
  MY_LIBRARY_ENTRY_URL,
  MY_LIBRARY_ORIGIN,
} from "../content/my-library-reader";
import {
  SCOMBZ_ORIGIN,
  SITRUS_LOGIN_URL,
  SITRUS_ORIGIN,
} from "../content/page-context";

export const FIRST_USE_SETUP_STORAGE_KEY = "orbit-first-use-setup-v1";

export interface FirstUseSetupRecord {
  startedAt: string;
  completedAt?: string;
}

export interface CampusLoginTarget {
  id: "scombz" | "sitrus" | "moodle" | "my-library" | "cast";
  label: string;
  origin: string;
  url: string;
}

export interface CampusLoginOpenResult {
  opened: CampusLoginTarget["id"][];
  failed: CampusLoginTarget["id"][];
}

export const CAMPUS_LOGIN_TARGETS: readonly CampusLoginTarget[] = [
  {
    id: "scombz",
    label: "ScombZ",
    origin: SCOMBZ_ORIGIN,
    url: `${SCOMBZ_ORIGIN}/portal/home`,
  },
  {
    id: "sitrus",
    label: "SITRUS",
    origin: SITRUS_ORIGIN,
    url: SITRUS_LOGIN_URL,
  },
  {
    id: "moodle",
    label: "SIT Moodle",
    origin: MOODLE_ORIGIN,
    url: MOODLE_LOGIN_URL,
  },
  {
    id: "my-library",
    label: "My Library",
    origin: MY_LIBRARY_ORIGIN,
    url: MY_LIBRARY_ENTRY_URL,
  },
  {
    id: "cast",
    label: "CAST",
    origin: CAST_ORIGIN,
    url: CAST_ENTRY_URL,
  },
];

function localStorageAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.local?.get === "function" &&
    typeof chrome.storage?.local?.set === "function"
  );
}

export function managedIdentityAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.identity?.getRedirectURL === "function" &&
    typeof chrome.identity?.launchWebAuthFlow === "function"
  );
}

function isSetupRecord(value: unknown): value is FirstUseSetupRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.startedAt === "string" &&
    (candidate.completedAt === undefined ||
      typeof candidate.completedAt === "string")
  );
}

export async function readFirstUseSetup(): Promise<FirstUseSetupRecord | null> {
  if (!localStorageAvailable()) return null;
  try {
    const stored = await chrome.storage.local.get(FIRST_USE_SETUP_STORAGE_KEY);
    const value = stored?.[FIRST_USE_SETUP_STORAGE_KEY];
    return isSetupRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function markFirstUseSetupStarted(): Promise<boolean> {
  if (!localStorageAvailable()) return false;
  const record = {
    startedAt: new Date().toISOString(),
  } satisfies FirstUseSetupRecord;
  try {
    await chrome.storage.local.set({
      [FIRST_USE_SETUP_STORAGE_KEY]: record,
    });
    const readBack = await readFirstUseSetup();
    return readBack?.startedAt === record.startedAt;
  } catch {
    return false;
  }
}

export async function markFirstUseSetupCompleted(): Promise<boolean> {
  if (!localStorageAvailable()) return false;
  try {
    const current = await readFirstUseSetup();
    const record = {
      startedAt: current?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } satisfies FirstUseSetupRecord;
    await chrome.storage.local.set({
      [FIRST_USE_SETUP_STORAGE_KEY]: record,
    });
    const readBack = await readFirstUseSetup();
    return (
      readBack?.startedAt === record.startedAt &&
      readBack.completedAt === record.completedAt
    );
  } catch {
    return false;
  }
}

export async function clearFirstUseSetup(): Promise<void> {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.storage?.local?.remove !== "function"
  ) {
    return;
  }
  await chrome.storage.local.remove(FIRST_USE_SETUP_STORAGE_KEY);
}

async function openTarget(
  target: CampusLoginTarget,
  active: boolean,
): Promise<boolean> {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.tabs?.query !== "function" ||
    typeof chrome.tabs?.create !== "function"
  ) {
    return false;
  }
  try {
    const existing = await chrome.tabs.query({ url: `${target.origin}/*` });
    if (existing.some((tab) => tab.id !== undefined)) return true;
    await chrome.tabs.create({ url: target.url, active });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the known campus login origins without reading or filling credentials.
 * Existing tabs are reused so retrying setup does not create a tab storm.
 */
export async function openCampusLoginTabs(): Promise<CampusLoginOpenResult> {
  const opened: CampusLoginTarget["id"][] = [];
  const failed: CampusLoginTarget["id"][] = [];
  let activatedTab = false;
  for (const target of CAMPUS_LOGIN_TARGETS) {
    const success = await openTarget(target, !activatedTab);
    if (success) {
      opened.push(target.id);
      activatedTab = true;
    } else {
      failed.push(target.id);
    }
  }
  return { opened, failed };
}
