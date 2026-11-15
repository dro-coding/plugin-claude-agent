import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KO } from "../ko";

// Every string the plugin shows through `t("…")`, or marks as `msg("…")`, read from the source:
// plugin.ts and every .ts / .tsx under src/ (the copied editor docs aside).
const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = `${dir}/${e.name}`;
  if (e.isDirectory()) return e.name === "generated" ? [] : walk(rel);
  return /\.tsx?$/.test(e.name) ? [rel] : [];
});
const files = ["plugin.ts", ...walk("src")];
const sources = files.map((f) => readFileSync(join(root, f), "utf8"));
const keys = new Set(sources.flatMap((source) => [...source.matchAll(/\b(?:t|msg)\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)));

/** The placeholders a string fills: `{name}`, `{n, plural, …}`, `{name|을}` — not the words inside a plural's branches. */
const names = (s: string) => new Set([...s.matchAll(/\{(\w+)(?=[},|])/g)].map((m) => m[1]));
/** The ones only English needs: the count a plural chooses its branch by. */
const counts = (s: string) => new Set([...s.matchAll(/\{(\w+), plural/g)].map((m) => m[1]));

describe("the Korean catalogue", () => {
  it("reads strings from every file that shows text", () => {
    expect(files).toContain("src/ui/AgentPanel.tsx");
    expect(keys.size).toBeGreaterThan(100);
  });

  it("has every string the plugin shows", () => {
    expect([...keys].filter((k) => !(k in KO))).toEqual([]);
  });

  it("has nothing the plugin no longer shows", () => {
    expect(Object.keys(KO).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("keeps every placeholder, and adds none", () => {
    for (const [en, ko] of Object.entries(KO)) {
      const want = [...names(en)].filter((n) => !counts(en).has(n) || names(ko).has(n)).sort();
      expect([...names(ko)].sort(), en).toEqual(want);
    }
  });
});
