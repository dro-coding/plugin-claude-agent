// `node scripts/i18n-keys.mjs [--missing]`: every string the plugin shows, as tests/ko.test.ts
// reads them (t("…") and msg("…") literals in plugin.ts and src/), one JSON string per line;
// with --missing, only the ones ko.ts lacks. For keeping ko.ts complete.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = `${dir}/${e.name}`;
  if (e.isDirectory()) return e.name === "generated" ? [] : walk(rel);
  return /\.tsx?$/.test(e.name) ? [rel] : [];
});
const keys = new Set();
for (const f of ["plugin.ts", ...walk("src")]) {
  for (const m of readFileSync(join(root, f), "utf8").matchAll(/\b(?:t|msg)\("((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
}
let have = new Set();
if (process.argv.includes("--missing")) {
  const ko = readFileSync(join(root, "ko.ts"), "utf8");
  have = new Set([...ko.matchAll(/^\s*("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1])));
}
for (const k of keys) if (!have.has(k)) console.log(JSON.stringify(k));
