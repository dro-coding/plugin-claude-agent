/**
 * The conversation loop, run with a scripted stand-in for the Messages API and a stand-in
 * editor that keeps an undo stack per open map: the two bugs scm-js/scm-js#228's review
 * found, and what was done about them.
 *
 * 1. Edits landing on another map: a turn's tools act on the map in front, so a turn whose
 *    map goes behind stops before its next edit; new_map moves the conversation instead.
 * 2. "Undo these changes" undoing another reply's work: it applies only while the undo
 *    stack is exactly as its turn left it, and counts the steps the turn left, whatever
 *    their labels.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { PluginApi } from "@scm-js/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { obj, str } from "../src/schema";
import { AgentSession, type TranscriptItem } from "../src/session";
import { DEFAULTS, type AgentSettings } from "../src/settings";
import type { AnyTool } from "../src/tools/types";

/* ── A stand-in editor: maps by id, the one in front, an undo stack each ── */

function editor() {
  const stacks = new Map<number, string[]>([[1, []]]);
  let front: number | null = 1;
  let next = 2;
  const switched: ((id: number | null) => void)[] = [];
  const top = () => stacks.get(front!)!;
  const show = (id: number | null) => { front = id; for (const fn of switched) fn(id); };
  const api = {
    document: {
      id: () => front,
      info: () => ({ viewOnly: false }),
      scenario: () => ({}),
      list: () => [...stacks.keys()].map((id) => ({ id })),
      history: () => {
        const s = front === null ? [] : top();
        return { undo: s.at(-1) ?? null, redo: null, undoDepth: s.length, redoDepth: 0 };
      },
      undo: () => top().pop() ?? null,
      update: (label: string, build: (tx: unknown) => void) => { build({}); top().push(label); return { changed: true, sections: [], notes: [] }; },
      create: async () => { const id = next++; stacks.set(id, []); show(id); return true; },
    },
    log: () => {},
  } as unknown as PluginApi;
  return {
    api,
    stacks,
    /** Another open map, behind. */
    open(): number { const id = next++; stacks.set(id, []); return id; },
    /** The user brings another map to the front, as a tab click does. */
    show,
    /** A step of the user's own on the map in front. */
    userEdit(label: string) { top().push(label); },
    onSwitch(fn: (id: number | null) => void) { switched.push(fn); },
  };
}

/* ── Tools that only touch the stand-in's undo stack ── */

const TOOLS = new Map<string, AnyTool>([
  ["edit", {
    name: "edit", description: "An edit: one undo step labelled Claude: <label>.", schema: obj({ label: str() }, ["label"]), effect: "write",
    describe: (i) => `edit ${i.label}`,
    run: (i, ctx) => { ctx.api.document.update(ctx.label(String(i.label)), () => {}); return "done"; },
  }],
  ["resize", {
    name: "resize", description: "An edit the editor labels itself, as resize_map's is.", schema: obj({}), effect: "destructive",
    describe: () => "resize",
    run: (_i, ctx) => { ctx.api.document.update("Resize Map", () => {}); return "done"; },
  }],
  ["open", {
    name: "open", description: "Opens a new map in front, as new_map does.", schema: obj({}), effect: "write", opensMap: true,
    describe: () => "open",
    run: async (_i, ctx) => { await ctx.api.document.create({ width: 64, height: 64, tileset: "badlands" } as never); return "opened"; },
  }],
]);

/* ── A scripted Messages API: one round per request ── */

interface Round { tools?: { name: string; input?: Record<string, unknown> }[]; text?: string; before?: () => void }

function script(rounds: Round[]) {
  let n = 0;
  const stream = (_params: unknown, opts?: { signal?: AbortSignal }) => {
    const r = rounds[n++] ?? { text: "Done." };
    r.before?.();
    const content = [
      ...(r.text ? [{ type: "text", text: r.text }] : []),
      ...(r.tools ?? []).map((t, k) => ({ type: "tool_use", id: `toolu_${n}_${k}`, name: t.name, input: t.input ?? {} })),
    ];
    const message = {
      id: `msg_${n}`, type: "message", role: "assistant", model: "claude-opus-5-5", content,
      stop_reason: r.tools?.length ? "tool_use" : "end_turn", stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    return {
      async *[Symbol.asyncIterator]() {
        for (const [index, block] of content.entries()) {
          if (opts?.signal?.aborted) throw new Anthropic.APIUserAbortError();
          yield { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } };
          if (block.type === "text") yield { type: "content_block_delta", index, delta: { type: "text_delta", text: (block as { text: string }).text } };
          yield { type: "content_block_stop", index };
        }
        if (opts?.signal?.aborted) throw new Anthropic.APIUserAbortError();
      },
      finalMessage: async () => message,
    };
  };
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, requests: () => n };
}

class ScriptedSession extends AgentSession {
  scripted: ReturnType<typeof script> | null = null;
  protected override client(): Anthropic { return this.scripted!.client; }
  protected override describeMap(): string { return "(a test map)"; }
  protected override tool(name: string): AnyTool | undefined { return TOOLS.get(name); }
}

function setup(settings: Partial<AgentSettings> = {}) {
  const ed = editor();
  const moved: [number | null, number | null][] = [];
  const session = new ScriptedSession(ed.api, 1, () => ({ ...DEFAULTS, apiKey: "test", approval: "never", ...settings }), () => {}, (from, to) => moved.push([from, to]));
  // What AgentController does: every change of map in front is passed on.
  ed.onSwitch((id) => session.documentChanged(id));
  const turn = async (rounds: Round[]) => { session.scripted = script(rounds); await session.send("go"); return session.scripted; };
  const turns = () => session.items.filter((i): i is Extract<TranscriptItem, { kind: "turn" }> => i.kind === "turn");
  const notices = () => session.items.filter((i) => i.kind === "notice").map((i) => (i as { text: string }).text);
  const toolStatus = () => session.items.filter((i) => i.kind === "tool").map((i) => (i as { status: string }).status);
  /** What the last tool results told Claude. */
  const lastResults = () => JSON.stringify(session.messages.at(-1));
  return { ed, session, moved, turn, turns, notices, toolStatus, lastResults };
}

describe("a turn only edits the map it belongs to", () => {
  it("stops before its next edit when another map comes to the front between two calls", async () => {
    const { ed, turn, notices, toolStatus, lastResults } = setup();
    const other = ed.open();
    TOOLS.set("edit_then_tab", { ...TOOLS.get("edit")!, name: "edit_then_tab", run: (i, ctx) => { ctx.api.document.update(ctx.label(String(i.label)), () => {}); ed.show(other); return "done"; } });
    const s = await turn([{ tools: [{ name: "edit_then_tab", input: { label: "one" } }, { name: "edit", input: { label: "two" } }] }, { text: "never asked" }]);
    TOOLS.delete("edit_then_tab");
    expect(ed.stacks.get(1)).toEqual(["Claude: one"]);
    expect(ed.stacks.get(other)).toEqual([]);
    expect(toolStatus()).toEqual(["done", "stopped"]);
    expect(lastResults()).toContain("Not run: the user switched to another map");
    expect(notices().at(-1)).toMatch(/another map came to the front/);
    expect(s.requests()).toBe(1);
  });

  it("stops while Claude is still writing the next request, before any of its calls run", async () => {
    const { ed, turn, notices } = setup();
    const other = ed.open();
    await turn([{ tools: [{ name: "edit", input: { label: "one" } }] }, { before: () => ed.show(other), tools: [{ name: "edit", input: { label: "two" } }] }]);
    expect(ed.stacks.get(1)).toEqual(["Claude: one"]);
    expect(ed.stacks.get(other)).toEqual([]);
    expect(notices().at(-1)).toMatch(/another map came to the front/);
  });

  it("never applies an approved change to another map: a tab change while asking stops the turn", async () => {
    const { ed, session, turn, toolStatus, lastResults } = setup({ approval: "all" });
    const other = ed.open();
    const done = turn([{ tools: [{ name: "edit", input: { label: "one" } }] }]);
    await vi.waitFor(() => expect(toolStatus()).toEqual(["approval"]));
    ed.show(other);
    await done;
    expect(session.busy).toBe(false);
    expect(toolStatus()).toEqual(["stopped"]);
    expect(lastResults()).toContain("Not run: the user switched to another map");
    expect(ed.stacks.get(1)).toEqual([]);
    expect(ed.stacks.get(other)).toEqual([]);
  });

  it("moves to the map new_map opens, and the rest of the turn works there", async () => {
    const { ed, session, moved, turn, turns, notices } = setup();
    await turn([{ tools: [{ name: "open" }] }, { tools: [{ name: "edit", input: { label: "on the new map" } }] }, { text: "Done." }]);
    expect(session.docId).toBe(2);
    expect(moved).toEqual([[1, 2]]);
    expect(ed.stacks.get(1)).toEqual([]);
    expect(ed.stacks.get(2)).toEqual(["Claude: on the new map"]);
    expect(notices()).toContain("This conversation moved to the new map. The map it started on keeps its changes, and gets a conversation of its own.");
    expect(turns()[0]).toMatchObject({ docId: 2, edits: 1, undoable: true });
  });
});

describe("Undo these changes", () => {
  it("applies only while its turn's steps are the newest, so it never undoes another reply's", async () => {
    const { ed, session, turn, turns, notices } = setup();
    await turn([{ tools: [{ name: "edit", input: { label: "a" } }, { name: "edit", input: { label: "b" } }] }, { text: "Two." }]);
    await turn([{ tools: [{ name: "edit", input: { label: "c" } }] }, { text: "One." }]);
    const [first, second] = turns();
    expect([first.edits, second.edits]).toEqual([2, 1]);
    expect(session.canUndoTurn(first.id)).toBe(false);
    expect(session.canUndoTurn(second.id)).toBe(true);

    // Pressed on the older reply: nothing of the newer reply's is touched.
    session.undoTurn(first.id);
    expect(ed.stacks.get(1)).toEqual(["Claude: a", "Claude: b", "Claude: c"]);
    expect(notices().at(-1)).toMatch(/no longer the newest/);

    session.undoTurn(second.id);
    expect(ed.stacks.get(1)).toEqual(["Claude: a", "Claude: b"]);
    expect(notices().at(-1)).toBe("Undid 1 change.");
    // The older reply's steps are on top again, so its button applies again.
    expect(session.canUndoTurn(first.id)).toBe(true);
    session.undoTurn(first.id);
    expect(ed.stacks.get(1)).toEqual([]);
    expect(notices().at(-1)).toBe("Undid 2 changes.");
  });

  it("turns off once the user changes the map after the reply", async () => {
    const { ed, session, turn, turns } = setup();
    await turn([{ tools: [{ name: "edit", input: { label: "a" } }] }, { text: "Done." }]);
    ed.userEdit("Paint Terrain");
    expect(session.canUndoTurn(turns()[0].id)).toBe(false);
    session.undoTurn(turns()[0].id);
    expect(ed.stacks.get(1)).toEqual(["Claude: a", "Paint Terrain"]);
  });

  it("counts the steps a call leaves under the editor's own label", async () => {
    const { ed, session, turn, turns } = setup();
    await turn([{ tools: [{ name: "resize" }, { name: "edit", input: { label: "a" } }] }, { text: "Done." }]);
    expect(turns()[0].edits).toBe(2);
    session.undoTurn(turns()[0].id);
    expect(ed.stacks.get(1)).toEqual([]);
  });

  it("is not offered when the user's own steps came in between the reply's", async () => {
    const { ed, session, turn, turns } = setup();
    await turn([{ tools: [{ name: "edit", input: { label: "a" } }] }, { before: () => ed.userEdit("Mine"), tools: [{ name: "edit", input: { label: "b" } }] }, { text: "Done." }]);
    expect(turns()[0]).toMatchObject({ undoable: false });
    expect(session.canUndoTurn(turns()[0].id)).toBe(false);
  });

  it("reads the stack as the reply's last step left it, even when the reply was stopped by a tab change", async () => {
    const { ed, session, turn, turns } = setup();
    const other = ed.open();
    await turn([{ tools: [{ name: "edit", input: { label: "a" } }] }, { before: () => ed.show(other), tools: [{ name: "edit", input: { label: "b" } }] }]);
    expect(turns()[0]).toMatchObject({ docId: 1, edits: 1, endDepth: 1, endTop: "Claude: a" });
    expect(session.canUndoTurn(turns()[0].id)).toBe(false); // another map is in front
    ed.show(1);
    expect(session.canUndoTurn(turns()[0].id)).toBe(true);
  });
});
