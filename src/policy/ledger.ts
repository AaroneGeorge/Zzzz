import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry } from "./types";

export interface Ledger {
  entries(): LedgerEntry[];
  append(e: LedgerEntry): void;
}

/** Append-only JSONL file. Lines are never rewritten; a corrupt line is skipped, not fatal. */
export class FileLedger implements Ledger {
  constructor(readonly path: string) {}

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const out: LedgerEntry[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // keep going: an audit log with one bad line is still an audit log
      }
    }
    return out;
  }

  append(e: LedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(e) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  /** Operator action (never exposed to the agent): move the log aside so the daily budget starts fresh. */
  archive(): string | null {
    if (!existsSync(this.path)) return null;
    // keep the .jsonl suffix so data/*.jsonl stays git-ignored
    const to = `${this.path.replace(/\.jsonl$/, "")}.archived-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    renameSync(this.path, to);
    return to;
  }
}

export class MemoryLedger implements Ledger {
  private list: LedgerEntry[];
  constructor(initial: LedgerEntry[] = []) {
    this.list = [...initial];
  }
  entries(): LedgerEntry[] {
    return [...this.list];
  }
  append(e: LedgerEntry): void {
    this.list.push({ ...e });
  }
}
