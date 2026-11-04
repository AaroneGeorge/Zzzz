import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, pidAlive } from "./zingo";

const noSleep = async () => {};
const deadPid = () => {
  const p = Bun.spawnSync(["true"]);
  return p.pid; // exited and reaped
};

describe("zingo session lock", () => {
  test("lock records our PID and release removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-lock-"));
    const release = await acquireLock(dir, noSleep, 0);
    const lock = join(dir, ".zr-session.lock");
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock whose PID is dead is stale and taken over at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-lock-"));
    const lock = join(dir, ".zr-session.lock");
    mkdirSync(lock);
    const pid = deadPid();
    expect(pidAlive(pid)).toBe(false);
    writeFileSync(join(lock, "pid"), String(pid));
    const release = await acquireLock(dir, noSleep, 0);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    release();
  });

  test("a lock held by a live PID is respected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-lock-"));
    const lock = join(dir, ".zr-session.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    await expect(acquireLock(dir, noSleep, 0)).rejects.toThrow(/busy/);
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    test(`${sig} on the holder removes the lock`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "zr-lock-"));
      const lock = join(dir, ".zr-session.lock");
      const script = `import { acquireLock } from ${JSON.stringify(join(import.meta.dir, "zingo.ts"))};
await acquireLock(${JSON.stringify(dir)});
console.log("held");
setInterval(() => {}, 1000);`;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("held");
      expect(existsSync(lock)).toBe(true);
      child.kill(sig);
      const code = await child.exited;
      expect(code).toBe(sig === "SIGINT" ? 130 : 143);
      expect(existsSync(lock)).toBe(false);
    });
  }
});
