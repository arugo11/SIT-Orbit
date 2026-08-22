import { afterEach, describe, expect, it } from "vitest";
import {
  CAREER_VAULT_SCHEMA_VERSION,
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
  type VaultRecordEnvelope,
} from "./career-vault";

const PASSPHRASE = "local career vault passphrase";

function createFixture(autoLockMs = 15 * 60 * 1000) {
  const store = new MemoryVaultStore();
  const session = new MemorySessionKeyStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: session,
    autoLockMs,
  });
  return { store, session, vault };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("CareerVault", () => {
  const activeVaults: CareerVault[] = [];

  afterEach(async () => {
    await Promise.all(activeVaults.splice(0).map((vault) => vault.lock()));
  });

  it("encrypts records and restores them only after unlocking", async () => {
    const { store, session, vault } = createFixture();
    activeVaults.push(vault);

    const metadata = await vault.create(PASSPHRASE);
    await vault.put("person-ref-1", {
      originalName: "山田 太郎",
      sourceIdentifier: "cast-person-123",
    });

    expect(metadata.schemaVersion).toBe(CAREER_VAULT_SCHEMA_VERSION);
    expect(vault.isUnlocked).toBe(true);
    expect(await session.get()).toBeInstanceOf(Uint8Array);
    expect(await vault.get("person-ref-1")).toEqual({
      originalName: "山田 太郎",
      sourceIdentifier: "cast-person-123",
    });

    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("山田 太郎");
    expect(persisted).not.toContain("cast-person-123");
    expect(persisted).toContain("ciphertext");

    await vault.lock();
    expect(vault.isUnlocked).toBe(false);
    await expect(vault.get("person-ref-1")).rejects.toThrow("locked");
  });

  it("rejects an invalid passphrase and accepts the session key", async () => {
    const { store, session, vault } = createFixture();
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);
    await vault.put("mission-1", { value: "private" });
    await vault.lock();

    await expect(vault.unlock("wrong passphrase")).rejects.toThrow(
      "Invalid Career Vault passphrase",
    );
    expect(vault.isUnlocked).toBe(false);

    await vault.unlock(PASSPHRASE);
    expect(await vault.get("mission-1")).toEqual({ value: "private" });

    const restored = new CareerVault({ store, sessionKeyStore: session });
    activeVaults.push(restored);
    await restored.initialize();
    expect(await restored.restoreSession()).toBe(true);
    expect(await restored.get("mission-1")).toEqual({ value: "private" });

    await vault.lock();
    const afterSessionClear = new CareerVault({
      store,
      sessionKeyStore: session,
    });
    activeVaults.push(afterSessionClear);
    await afterSessionClear.initialize();
    expect(await afterSessionClear.restoreSession()).toBe(false);

    await afterSessionClear.unlock(PASSPHRASE);
    expect(await afterSessionClear.get("mission-1")).toEqual({
      value: "private",
    });
  });

  it("uses a fresh IV for each encrypted record and rejects tampering", async () => {
    const { store, vault } = createFixture();
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);
    await vault.put("one", { value: 1 });
    await vault.put("two", { value: 2 });

    const first = await store.getRecord("one");
    const second = await store.getRecord("two");
    expect(first?.iv).toBeDefined();
    expect(second?.iv).toBeDefined();
    expect(first?.iv).not.toBe(second?.iv);

    if (!first) {
      throw new Error("Test record was not persisted.");
    }
    const tampered: VaultRecordEnvelope = {
      ...first,
      ciphertext: `${first.ciphertext}A`,
    };
    await store.saveRecord(tampered);
    await expect(vault.get("one")).rejects.toThrow();
  });

  it("derives a stable local HMAC without exposing the key", async () => {
    const { session, vault } = createFixture();
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);

    const first = await vault.hmac("person:山田 太郎");
    const second = await vault.hmac("person:山田 太郎");
    const other = await vault.hmac("person:佐藤 花子");
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(Array.from(first)).not.toEqual(Array.from(other));
    expect(await session.get()).not.toBeNull();

    await vault.lock();
    await expect(vault.hmac("person:山田 太郎")).rejects.toThrow("locked");
  });

  it("clears private records while retaining only the verification record", async () => {
    const { store, vault } = createFixture();
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);
    await vault.put("mapping", { value: "private" });

    await vault.clear();
    expect(await vault.get("mapping")).toBeNull();
    expect(store.snapshot().records).toHaveLength(1);

    await vault.lock();
    await vault.unlock(PASSPHRASE);
    expect(vault.isUnlocked).toBe(true);
  });

  it("destroys the encrypted vault only through an explicit unlocked operation", async () => {
    const { store, vault } = createFixture();
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);
    await vault.put("mapping", { value: "private" });

    await vault.destroy();

    expect(vault.isUnlocked).toBe(false);
    expect(store.snapshot()).toEqual({ metadata: null, records: [] });
    await expect(vault.create(PASSPHRASE)).resolves.toBeDefined();
  });

  it("locks after inactivity", async () => {
    const { session, vault } = createFixture(20);
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);
    await wait(60);

    expect(vault.isUnlocked).toBe(false);
    expect(await session.get()).toBeNull();
  });

  it("does not allow callers to overwrite or delete the verification record", async () => {
    const { vault } = createFixture();
    activeVaults.push(vault);
    await vault.create(PASSPHRASE);

    await expect(
      vault.put("__vault_probe__", { replacement: true }),
    ).rejects.toThrow("reserved");
    await expect(vault.delete("__vault_probe__")).rejects.toThrow("reserved");
  });
});
