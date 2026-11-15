/**
 * The tool set's shape, input validation and effects, the attachments, and the price table,
 * with no editor: the tools against a real map are tested in the editor's own repository,
 * which compiles this plugin in (scm-js tests/claude-agent-plugin.test.ts in the
 * dro-coding fork).
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { describe, expect, it } from "vitest";
import {
  AttachmentError, attachmentBlocks, attachmentBytes, MAX_CONVERSATION_BYTES, MAX_IMAGE_BYTES, readAttachment, toBase64, type PickedFile,
} from "../src/attachments";
import { validate } from "../src/schema";
import { AgentSession } from "../src/session";
import { DEFAULTS, MODELS, requestCost } from "../src/settings";
import { TOOL_BY_NAME, TOOL_DEFINITIONS, TOOLS } from "../src/tools/index";
import { effectOf } from "../src/tools/types";

describe("the agent's tool set", () => {
  it("has unique names, object schemas that refuse unknown fields, and a description for each", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^[a-z_]{3,64}$/);
      expect(t.description.length, t.name).toBeGreaterThan(30);
      expect(t.schema.type, t.name).toBe("object");
      expect((t.schema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
    expect(TOOL_DEFINITIONS.every((d) => d.eager_input_streaming === true)).toBe(true);
  });

  it("validates inputs before a tool runs", () => {
    const place = TOOL_BY_NAME.get("place_units")!;
    expect(validate(place.schema, {})).toEqual(["input.units is required"]);
    expect(validate(place.schema, { units: [{ player: 13 }] })[0]).toMatch(/at most 12/);
    expect(validate(place.schema, { units: [{ player: 1, color: "red" }] })[0]).toMatch(/not a known field/);
    expect(validate(TOOL_BY_NAME.get("find")!.schema, { kind: "planets", query: "x" })[0]).toMatch(/one of/);
    expect(validate(place.schema, { units: [{ player: 1, unitId: 0, tx: 1, ty: 1 }] })).toEqual([]);
  });

  it("asks before deleting or replacing much, never before reading", () => {
    expect(effectOf(TOOL_BY_NAME.get("map_overview")!, {})).toBe("read");
    expect(effectOf(TOOL_BY_NAME.get("place_units")!, {})).toBe("write");
    for (const name of ["delete_units", "delete_locations", "delete_triggers", "resize_map", "change_tileset", "delete_doodads", "delete_sprites"]) {
      expect(effectOf(TOOL_BY_NAME.get(name)!, {}), name).toBe("destructive");
    }
    const replace = TOOL_BY_NAME.get("replace_triggers")!;
    expect(effectOf(replace, { count: 2 })).toBe("write");
    expect(effectOf(replace, { count: 6 })).toBe("destructive");
    expect(effectOf(TOOL_BY_NAME.get("unit_property_slots")!, {})).toBe("read");
    expect(effectOf(TOOL_BY_NAME.get("unit_property_slots")!, { set: [{ slot: 1 }] })).toBe("write");
  });

  it("has one tool that opens a map, which the conversation follows", () => {
    expect(TOOLS.filter((t) => t.opensMap).map((t) => t.name)).toEqual(["new_map"]);
  });

  it("describes every call in a line that names what it does", () => {
    const samples: Record<string, Record<string, unknown>> = {
      place_units: { units: [{ player: 2, unitName: "Zerg Zergling", count: 12 }] },
      add_triggers: { text: 'Trigger("Player 1"){\nConditions:\nActions:\n}\nTrigger("Player 2"){\nConditions:\nActions:\n}' },
      replace_triggers: { start: 3, count: 2, text: "" },
      paint_terrain: { area: { x0: 0, y0: 0, x1: 4, y1: 2 }, terrainId: 5 },
    };
    expect(TOOL_BY_NAME.get("place_units")!.describe(samples.place_units)).toBe("Place 12 × Zerg Zergling for Player 2");
    expect(TOOL_BY_NAME.get("add_triggers")!.describe(samples.add_triggers)).toBe("Add 2 trigger(s)");
    expect(TOOL_BY_NAME.get("replace_triggers")!.describe(samples.replace_triggers)).toBe("Rewrite triggers #3–#4");
    expect(TOOL_BY_NAME.get("paint_terrain")!.describe(samples.paint_terrain)).toBe("Paint terrain 5 over 4×2 tiles");
  });
});

describe("trigger text with a mistake in it", () => {
  /**
   * An editor from before scm-js/scm-js#259, as it behaves: `fromText` interns the text's
   * strings as it reads and then throws on the bad line, and nothing marks the string table
   * as changed (the editor only does that when the parse returns), so the update records no
   * step for them. A change made through `tx.strings` is recorded, as one step, even when
   * the builder then throws.
   */
  function oldEditor() {
    let strings: (string | null)[] = ["", "Map name"];
    const stack: { label: string; strings: (string | null)[] }[] = [];
    const api = {
      document: {
        scenario: () => ({}),
        info: () => ({ viewOnly: false }),
        history: () => ({ undo: stack.at(-1)?.label ?? null, redo: null, undoDepth: stack.length, redoDepth: 0 }),
        undo: () => { const step = stack.pop(); if (step) strings = step.strings; return step?.label ?? null; },
        update: (label: string, build: (tx: unknown) => void) => {
          const before = [...strings];
          let touched = false;
          const tx = {
            strings: { list: () => [...strings], apply: (list: (string | null)[]) => { strings = [...list]; touched = true; } },
            triggers: {
              count: () => 0,
              fromText: (text: string) => {
                for (const m of text.matchAll(/"([^"]*)"/g)) if (!strings.includes(m[1])) strings.push(m[1]);
                throw new Error("Line 6: No Such Action is not an action");
              },
            },
          };
          try { build(tx); } catch (err) {
            if (touched) stack.push({ label, strings: before });
            throw err;
          }
          stack.push({ label, strings: before });
          return { changed: true, sections: [], notes: [] };
        },
      },
    } as unknown as PluginApi;
    return { api, strings: () => strings, depth: () => stack.length };
  }

  it("leaves the map's strings and undo stack as they were, on an editor that interned them first", async () => {
    const ed = oldEditor();
    const ctx = { api: ed.api, label: (s: string) => `Claude: ${s}`, touched: () => {}, signal: new AbortController().signal };
    const text = 'Trigger("Player 1"){\nConditions:\n\tAlways();\nActions:\n\tDisplay Text Message(Always Display, "A brand new string");\n\tNo Such Action(1);\n}';
    await expect(Promise.resolve().then(() => TOOL_BY_NAME.get("add_triggers")!.run({ text }, ctx))).rejects.toThrow(/Line 6.*Nothing was changed/);
    expect(ed.strings()).toEqual(["", "Map name"]);
    expect(ed.depth()).toBe(0);
  });
});

describe("prices", () => {
  const model = (id: string) => MODELS.find((m) => m.id === id)!;

  it("reads the cache at the list prices", () => {
    // Opus 5.5 $0.20 and Sonnet 5.5 $0.10 per million cache-read tokens (0.05x input).
    expect(requestCost(model("claude-opus-5-5"), { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(0.2);
    expect(requestCost(model("claude-sonnet-5-5"), { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(0.1);
    expect(requestCost(model("claude-sonnet-5-5"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 })).toBeCloseTo(2.5);
  });

  it("charges Haiku 5.5 its higher rates once the prompt is over 100,000 tokens, cache included", () => {
    const haiku = model("claude-haiku-5-5");
    expect(requestCost(haiku, { input: 100_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.01 + 0.5);
    expect(requestCost(haiku, { input: 1_000, output: 1_000_000, cacheRead: 99_001, cacheWrite: 0 })).toBeCloseTo(0.0005 + 2.5 + 0.00495);
  });
});

describe("attachments", () => {
  const file = (name: string, bytes: Uint8Array | string, type = ""): PickedFile => {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    return { name, type, size: data.length, arrayBuffer: async () => data.slice().buffer };
  };

  it("sends text as a plain-text document named after the file, UTF-8 or else Latin-1", async () => {
    const utf8 = await readAttachment(file("notes.md", "# Plan\nTwo bases each, 한국어 too."));
    expect(utf8).toMatchObject({ kind: "text", mediaType: "text/plain", data: "# Plan\nTwo bases each, 한국어 too." });
    const latin1 = await readAttachment(file("export.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9])));
    expect(latin1.data).toBe("café");
    expect(attachmentBlocks([utf8])).toEqual([{ type: "document", title: "notes.md", source: { type: "text", media_type: "text/plain", data: utf8.data } }]);
  });

  it("sends a picture as a named image block, through the scaler, and a PDF as a document", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    let scaled = 0;
    const image = await readAttachment(file("Shot.PNG", png), { scale: async (bytes) => { scaled++; return { bytes: bytes.subarray(0, 4), type: "image/png" }; } });
    expect(scaled).toBe(1);
    expect(image).toMatchObject({ kind: "image", mediaType: "image/png", data: toBase64(png.subarray(0, 4)) });
    const pdf = await readAttachment(file("design.pdf", "%PDF-1.7 …", "application/pdf"));
    expect(pdf.kind).toBe("pdf");
    expect(attachmentBlocks([image, pdf])).toEqual([
      { type: "text", text: "Attached picture: Shot.PNG" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
      { type: "document", title: "design.pdf", source: { type: "base64", media_type: "application/pdf", data: pdf.data } },
    ]);
    expect(attachmentBytes([image, pdf])).toBe(image.data.length + pdf.data.length);
  });

  it("refuses map files, binary files and oversized ones with the reason", async () => {
    await expect(readAttachment(file("arena.scx", "MPQ\x1a"))).rejects.toThrow(/map file/);
    await expect(readAttachment(file("tool.exe", new Uint8Array([0x4d, 0x5a, 0, 0, 3, 0])))).rejects.toThrow(/pictures \(PNG, JPEG, GIF, WebP\), PDFs and text/);
    await expect(readAttachment(file("huge.png", new Uint8Array(MAX_IMAGE_BYTES + 1)))).rejects.toBeInstanceOf(AttachmentError);
    await expect(readAttachment(file("x.trg", new Uint8Array(2400)))).rejects.toThrow(/needs an open map/);
  });

  it("prints a .trg through the editor's own decoder and printer, against the open map", async () => {
    const printed: unknown[] = [];
    const api = {
      document: { scenario: () => ({}), id: () => 1 },
      exchange: { decodeTrg: (bytes: Uint8Array) => Array.from({ length: bytes.length / 2400 }, (_, n) => ({ n })) },
      triggers: { text: { print: (list: unknown[]) => { printed.push(...list); return 'Trigger("Player 1"){\nConditions:\n\tAlways();\nActions:\n\tVictory();\n}'; } } },
    } as unknown as PluginApi;
    const session = new AgentSession(api, 1, () => DEFAULTS, () => {});
    const trg = await session.readFile(file("old.trg", new Uint8Array(2400)));
    expect(printed).toEqual([{ n: 0 }]);
    expect(trg.kind).toBe("text");
    expect(trg.data).toMatch(/Victory\(\);/);
    expect(trg.note).toMatch(/1 trigger\(s\) from a binary \.trg/);
    expect(attachmentBlocks([trg])[0]).toMatchObject({ type: "document", title: "old.trg", context: trg.note });
    await expect(session.readFile(file("bad.trg", new Uint8Array(100)))).rejects.toThrow(/not a trigger file/);
  });

  it("keeps a conversation's attachments under the request size", () => {
    const session = new AgentSession({} as PluginApi, 1, () => DEFAULTS, () => {});
    expect(session.attachmentRoom()).toBe(MAX_CONVERSATION_BYTES);
    session.attachedBytes = MAX_CONVERSATION_BYTES - 10;
    expect(session.attachmentRoom()).toBe(10);
    session.reset();
    expect(session.attachmentRoom()).toBe(MAX_CONVERSATION_BYTES);
  });
});
