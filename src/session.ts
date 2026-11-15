/**
 * One conversation with Claude about one open map: the message history, the transcript
 * the panel draws, and the tool-use loop.
 *
 * The loop is the Messages API's manual one, streamed: send the history, show the text and
 * the tool calls as they arrive, run the tools the turn asked for (in order — they change
 * the map, so order matters), send every result back in one user message, and go round
 * until Claude ends its turn. The history is only ever appended to, never edited, which is
 * what keeps both the prompt cache and Claude's earlier reasoning valid from turn to turn.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { PluginApi } from "@scm-js/plugin-api";
import {
  AttachmentError, attachmentBlocks, attachmentBytes, MAX_CONVERSATION_BYTES, readAttachment, scaleInBrowser,
  type Attachment, type AttachmentKind, type PickedFile,
} from "./attachments";
import { t } from "./i18n";
import { SYSTEM_PROMPT } from "./prompt";
import { validate } from "./schema";
import { mapState } from "./tools/map";
import { TOOL_BY_NAME, TOOL_DEFINITIONS } from "./tools/index";
import { effectOf, LABEL_PREFIX, ToolError, type AnyTool, type ToolContext, type ToolEffect, type ToolOutput, type Touched } from "./tools/types";
import { MODELS, requestCost, type AgentSettings } from "./settings";

export type ToolStatus = "streaming" | "approval" | "running" | "done" | "error" | "denied" | "stopped";

/** What the transcript keeps of an attachment: enough to show it, and a picture's preview. */
export interface SentFile {
  name: string;
  kind: AttachmentKind;
  size: number;
  /** A data URL, for pictures. */
  preview?: string;
}

export type TranscriptItem =
  | { kind: "user"; id: number; text: string; files?: SentFile[] }
  | { kind: "text"; id: number; text: string; done: boolean }
  | { kind: "thinking"; id: number; text: string; done: boolean }
  | {
    kind: "tool"; id: number; toolUseId: string; name: string; title: string; status: ToolStatus; effect: ToolEffect;
    input?: unknown; result?: string; images?: string[];
  }
  | { kind: "notice"; id: number; level: "info" | "warn" | "error"; text: string; action?: "settings" }
  | {
    kind: "turn"; id: number;
    /** Undo steps the turn left on its map's stack (counted from the stack, so a call that leaves an editor-labelled step counts too). */
    edits: number;
    undone: boolean; seconds: number;
    /** The map the steps are on, and the undo stack as the turn's last step left it: "Undo these changes" only works while it is still so. */
    docId: number | null; endDepth: number; endTop: string | null;
    /** False when something else changed that map between the turn's own steps, so they are not one run to take back. */
    undoable: boolean;
  };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** The size of the last request's prompt, which is how full the context is. */
  context: number;
}

type Listener = () => void;

const MAX_ROUNDS = 60;
const TEXT_LIMIT = 100_000;

let nextId = 1;

export class AgentSession {
  readonly messages: BetaMessageParam[] = [];
  items: TranscriptItem[] = [];
  usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0 };
  busy = false;
  /** What the attachments already in the history add to every request (`MAX_CONVERSATION_BYTES`). */
  attachedBytes = 0;
  private abort: AbortController | null = null;
  private listeners = new Set<Listener>();
  private approvals = new Map<number, (ok: boolean) => void>();
  private allowAllThisTurn = false;
  private following = true;
  /** Something to tell Claude at the start of the next message (the user undid a turn). */
  private pendingNote = "";
  /**
   * The map this conversation works on: the one in front when it started, or the one
   * `new_map` opened. The tools act on whatever map is in front, so a turn only runs while
   * this one is.
   */
  docId: number | null;
  /** Why the running turn was stopped, for what the transcript and Claude are told. */
  private stopReason: "user" | "tab" = "user";
  /** A tool that opens a map is running, so the map in front changing is the turn's own doing. */
  private opening = false;
  /** The undo stack of the turn's map: the lowest it went this turn, and as the turn's latest step left it. */
  private floor = 0;
  private lastDepth = 0;
  private lastTop: string | null = null;
  private contiguous = true;
  private readonly api: PluginApi;
  private readonly settings: () => AgentSettings;
  private readonly onBusy: (busy: boolean) => void;
  private readonly onMoved: (from: number | null, to: number | null) => void;

  constructor(
    api: PluginApi,
    docId: number | null,
    settings: () => AgentSettings,
    onBusy: (busy: boolean) => void,
    onMoved: (from: number | null, to: number | null) => void = () => {},
  ) {
    this.api = api;
    this.docId = docId;
    this.settings = settings;
    this.onBusy = onBusy;
    this.onMoved = onMoved;
  }

  /** The API client a turn talks through. tests/session.test.ts gives a scripted stand-in. */
  protected client(settings: AgentSettings): Anthropic {
    return new Anthropic({
      apiKey: settings.apiKey || (settings.baseURL ? "set-by-proxy" : ""),
      baseURL: settings.baseURL || undefined,
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
    });
  }

  /** The `<map_state>` block every message starts with. */
  protected describeMap(): string {
    return mapState(this.api);
  }

  /** A tool by the name Claude called it. */
  protected tool(name: string): AnyTool | undefined {
    return TOOL_BY_NAME.get(name);
  }

  /** Whether the map in front is this conversation's: the only map its tools may act on. */
  private onItsMap(): boolean {
    return this.api.document.id() === this.docId;
  }

  /**
   * The map in front changed (a tab, a close). A turn whose map went behind stops at once:
   * its tools would otherwise carry on against the map now in front. `new_map` changing it
   * is the turn's own doing and moves the conversation instead (`adoptFrontMap`).
   */
  documentChanged(front: number | null): void {
    if (this.busy && !this.opening && front !== this.docId) this.stop("tab");
  }

  /** What a tool call that did not run says, to the transcript and to Claude. */
  private notRun(): string {
    return this.stopReason === "tab"
      ? "Not run: the user switched to another map, so the turn was stopped before it could change that one."
      : "Not run: the user pressed Stop.";
  }

  /** The transcript's line for a stopped turn. */
  private stoppedNotice(): TranscriptItem {
    return this.stopReason === "tab"
      ? { kind: "notice", id: nextId++, level: "warn", text: t("Stopped: another map came to the front, and Claude only works on the map in front. Switch back and say \"continue\" to go on.") }
      : { kind: "notice", id: nextId++, level: "info", text: t("Stopped.") };
  }

  /** Take the undo stack's state as the turn's latest step left it (only while its map is in front). */
  private markStack(): void {
    if (!this.onItsMap()) return;
    const h = this.api.document.history();
    this.floor = Math.min(this.floor, h.undoDepth);
    this.lastDepth = h.undoDepth;
    this.lastTop = h.undo;
  }

  /** After `new_map`: the conversation goes on with the map now in front. */
  private adoptFrontMap(): void {
    const now = this.api.document.id();
    if (now === this.docId) return;
    const from = this.docId;
    this.docId = now;
    const h = this.api.document.history();
    this.floor = this.lastDepth = h.undoDepth;
    this.lastTop = h.undo;
    this.contiguous = true;
    this.onMoved(from, now);
    this.push({ kind: "notice", id: nextId++, level: "info", text: t("This conversation moved to the new map. The map it started on keeps its changes, and gets a conversation of its own.") });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.items = [...this.items];
    for (const fn of this.listeners) fn();
  }

  private push(item: TranscriptItem): TranscriptItem {
    this.items.push(item);
    this.emit();
    return item;
  }

  private update(id: number, patch: Partial<TranscriptItem>): void {
    const n = this.items.findIndex((i) => i.id === id);
    if (n >= 0) this.items[n] = { ...this.items[n], ...patch } as TranscriptItem;
    this.emit();
  }

  /** The user's answer to a change waiting for approval. `all` allows the rest of this turn's changes too. */
  answer(id: number, ok: boolean, all = false): void {
    if (all) this.allowAllThisTurn = true;
    this.approvals.get(id)?.(ok);
    this.approvals.delete(id);
  }

  stop(reason: "user" | "tab" = "user"): void {
    if (this.abort && !this.abort.signal.aborted) this.stopReason = reason;
    this.abort?.abort();
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
  }

  reset(): void {
    this.stop();
    this.messages.length = 0;
    this.items = [];
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0 };
    this.attachedBytes = 0;
    this.emit();
  }

  /** Room left for attachments in this conversation, in bytes as sent. */
  attachmentRoom(): number {
    return Math.max(0, MAX_CONVERSATION_BYTES - this.attachedBytes);
  }

  /** A picked or dropped file as an attachment; throws `AttachmentError` with the reason it cannot go. */
  readFile(file: PickedFile): Promise<Attachment> {
    return readAttachment(file, {
      scale: scaleInBrowser,
      trgToText: (bytes) => {
        if (!this.api.document.scenario()) throw new AttachmentError(t("{name}: a .trg is read against the open map; open one first.", { name: file.name }));
        return this.api.triggers.text.print(this.api.exchange.decodeTrg(bytes));
      },
    });
  }

  /**
   * Whether "Undo these changes" can take back this turn's steps: the turn's map is in front
   * and its undo stack is exactly as the turn's last step left it. Any later step (another
   * reply's, the user's, an undo or a redo) changes the depth or the label on top, and the
   * turn's steps are then no longer the newest, so they are not this button's to undo.
   */
  canUndoTurn(turnId: number): boolean {
    const turn = this.items.find((i) => i.id === turnId);
    if (!turn || turn.kind !== "turn" || turn.undone || !turn.undoable || turn.edits === 0 || this.busy) return false;
    if (this.api.document.id() !== turn.docId) return false;
    const h = this.api.document.history();
    return h.undoDepth === turn.endDepth && h.undo === turn.endTop;
  }

  /** Undo the steps one finished turn made, while they are still the newest on its map's undo stack. */
  undoTurn(turnId: number): void {
    const turn = this.items.find((i) => i.id === turnId);
    if (!turn || turn.kind !== "turn") return;
    if (!this.canUndoTurn(turnId)) {
      this.push({ kind: "notice", id: nextId++, level: "warn", text: t("Those changes are no longer the newest on the undo stack, so they were left alone. Edit ▸ Undo still reaches them.") });
      return;
    }
    for (let k = 0; k < turn.edits; k++) this.api.document.undo();
    this.update(turnId, { undone: true });
    this.push({ kind: "notice", id: nextId++, level: "info", text: t("{n, plural, one {Undid # change.} other {Undid # changes.}}", { n: turn.edits }) });
    // Claude does not see this in its history; tell it at the start of the next message.
    this.pendingNote = `(The user undid the ${turn.edits} change(s) you made in that turn; the map is as it was before it.)`;
  }

  /**
   * One user message, with any attached files, and the turn it starts. The files go between
   * the map state and the words, each picture labelled with its name.
   */
  async send(text: string, files: readonly Attachment[] = []): Promise<void> {
    if (this.busy || (!text.trim() && files.length === 0)) return;
    const size = attachmentBytes(files);
    if (size > this.attachmentRoom()) {
      this.push({ kind: "notice", id: nextId++, level: "warn", text: t("These files would make the conversation too large to send. Start a new conversation (the arrow at the top) to attach them.") });
      return;
    }
    const settings = this.settings();
    this.busy = true;
    this.onBusy(true);
    this.allowAllThisTurn = false;
    this.following = settings.followEdits;
    this.abort = new AbortController();
    this.stopReason = "user";
    const started = performance.now();
    const start = this.api.document.history();
    this.floor = this.lastDepth = start.undoDepth;
    this.lastTop = start.undo;
    this.contiguous = true;
    const sent: SentFile[] = files.map((f) => ({ name: f.name, kind: f.kind, size: f.size, ...(f.kind === "image" ? { preview: `data:${f.mediaType};base64,${f.data}` } : {}) }));
    this.push({ kind: "user", id: nextId++, text, ...(sent.length ? { files: sent } : {}) });
    const note = this.pendingNote ? `${this.pendingNote}\n\n` : "";
    this.pendingNote = "";
    const state = `<map_state>\n${this.describeMap()}\n</map_state>`;
    this.attachedBytes += size;
    this.messages.push({
      role: "user",
      content: files.length
        ? [{ type: "text", text: state }, ...attachmentBlocks(files), { type: "text", text: `${note}${text.trim() || "(No message: the attached files are what the user sent.)"}` }]
        : [{ type: "text", text: `${state}\n\n${note}${text}` }],
    });

    const client = this.client(settings);

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const message = await this.stream(client, settings);
        if (!message) return;
        this.messages.push({ role: "assistant", content: message.content as BetaContentBlockParam[] });
        const toolUses = message.content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");

        if (message.stop_reason === "refusal") {
          this.push({ kind: "notice", id: nextId++, level: "warn", text: message.stop_details?.explanation ? t("Claude declined to continue: {why}", { why: message.stop_details.explanation }) : t("Claude declined to continue.") });
          if (toolUses.length) this.messages.push({ role: "user", content: toolUses.map((t) => this.stoppedResult(t.id, "Not run: the turn ended in a refusal.")) });
          return;
        }
        if (message.stop_reason === "max_tokens" && toolUses.length) {
          this.push({ kind: "notice", id: nextId++, level: "error", text: t("The reply ran out of room in the middle of a tool call, so it was not run. Ask again with a smaller step.") });
          this.messages.push({ role: "user", content: toolUses.map((t) => this.stoppedResult(t.id, "Not run: the input was cut off at max_tokens.")) });
          return;
        }
        if (message.stop_reason === "pause_turn") continue;
        if (toolUses.length === 0) return;

        const results: BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          if (this.abort.signal.aborted) { results.push(this.stoppedResult(use.id, this.notRun())); this.markTool(use.id, { status: "stopped" }); continue; }
          results.push(await this.runTool(use));
        }
        this.messages.push({ role: "user", content: results });
        if (this.abort.signal.aborted) {
          this.push(this.stoppedNotice());
          return;
        }
      }
      this.push({ kind: "notice", id: nextId++, level: "warn", text: t("Stopped after {n} rounds of tool calls. Say \"continue\" to let it go on.", { n: MAX_ROUNDS }) });
    } catch (err) {
      this.fail(err);
    } finally {
      for (const item of this.items) if ((item.kind === "text" || item.kind === "thinking") && !item.done) item.done = true;
      // The stack as the turn's last step left it, read while its map was in front (`markStack`),
      // not now: a turn stopped by a tab change ends with another map in front.
      this.push({
        kind: "turn", id: nextId++, edits: Math.max(0, this.lastDepth - this.floor), undone: false,
        seconds: Math.round((performance.now() - started) / 1000),
        docId: this.docId, endDepth: this.lastDepth, endTop: this.lastTop, undoable: this.contiguous,
      });
      this.busy = false;
      this.abort = null;
      this.onBusy(false);
    }
  }

  /** One request, streamed into the transcript. Null when the user stopped it. */
  private async stream(client: Anthropic, settings: AgentSettings): Promise<BetaMessage | null> {
    const model = MODELS.find((m) => m.id === settings.model) ?? MODELS[0];
    const stream = client.beta.messages.stream({
      model: model.id,
      max_tokens: 64_000,
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      tools: TOOL_DEFINITIONS,
      messages: this.messages,
      thinking: { type: "adaptive", display: settings.showThinking ? "summarized" : "omitted" },
      output_config: { effort: settings.effort },
      cache_control: { type: "ephemeral" },
      // A safety decline on the chosen model is re-run on a fallback model in the same call.
      ...(model.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    }, { signal: this.abort!.signal });

    const blocks = new Map<number, number>();
    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const b = event.content_block;
          if (b.type === "text") blocks.set(event.index, this.push({ kind: "text", id: nextId++, text: b.text ?? "", done: false }).id);
          else if (b.type === "thinking" && settings.showThinking) blocks.set(event.index, this.push({ kind: "thinking", id: nextId++, text: b.thinking ?? "", done: false }).id);
          else if (b.type === "tool_use") {
            const tool = this.tool(b.name);
            blocks.set(event.index, this.push({ kind: "tool", id: nextId++, toolUseId: b.id, name: b.name, title: tool ? `${tool.name.replace(/_/g, " ")}…` : b.name, status: "streaming", effect: tool && typeof tool.effect === "string" ? tool.effect : "write" }).id);
          }
        } else if (event.type === "content_block_delta") {
          const id = blocks.get(event.index);
          if (id === undefined) continue;
          const item = this.items.find((i) => i.id === id);
          if (!item) continue;
          if (event.delta.type === "text_delta" && item.kind === "text") this.update(id, { text: item.text + event.delta.text });
          else if (event.delta.type === "thinking_delta" && item.kind === "thinking") this.update(id, { text: item.text + event.delta.thinking });
        } else if (event.type === "content_block_stop") {
          const id = blocks.get(event.index);
          const item = id !== undefined ? this.items.find((i) => i.id === id) : undefined;
          if (item && (item.kind === "text" || item.kind === "thinking")) this.update(item.id, { done: true });
        }
      }
      const message = await stream.finalMessage();
      this.count(message, settings);
      // Empty thinking rows (display omitted, or a block with no summary) are noise.
      this.items = this.items.filter((i) => !(i.kind === "thinking" && !i.text.trim()));
      this.emit();
      return message;
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || this.abort?.signal.aborted) {
        this.push(this.stoppedNotice());
        // A tool call cut off mid-stream was never added to the history, so its row is all that is left of it.
        for (const item of this.items) if (item.kind === "tool" && item.status === "streaming") item.status = "stopped";
        this.emit();
        return null;
      }
      throw err;
    }
  }

  private count(message: BetaMessage, settings: AgentSettings): void {
    const u = message.usage;
    // Priced as the model that answered: a server-side fallback may not be the one asked for.
    const model = MODELS.find((m) => m.id === message.model) ?? MODELS.find((m) => m.id === settings.model) ?? MODELS[0];
    const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
    this.usage = {
      input: this.usage.input + u.input_tokens,
      output: this.usage.output + u.output_tokens,
      cacheRead: this.usage.cacheRead + read,
      cacheWrite: this.usage.cacheWrite + write,
      cost: this.usage.cost + requestCost(model, { input: u.input_tokens, output: u.output_tokens, cacheRead: read, cacheWrite: write }),
      context: u.input_tokens + read + write,
    };
  }

  private markTool(toolUseId: string, patch: Partial<Extract<TranscriptItem, { kind: "tool" }>>): Extract<TranscriptItem, { kind: "tool" }> | undefined {
    const item = this.items.find((i): i is Extract<TranscriptItem, { kind: "tool" }> => i.kind === "tool" && i.toolUseId === toolUseId);
    if (item) this.update(item.id, patch);
    return item;
  }

  private stoppedResult(id: string, text: string): BetaToolResultBlockParam {
    return { type: "tool_result", tool_use_id: id, is_error: true, content: text };
  }

  private needsApproval(effect: ToolEffect): boolean {
    if (effect === "read" || this.allowAllThisTurn) return false;
    const mode = this.settings().approval;
    return mode === "all" || (mode === "destructive" && effect === "destructive");
  }

  private async runTool(use: { id: string; name: string; input: unknown }): Promise<BetaToolResultBlockParam> {
    const tool = this.tool(use.name);
    const fail = (text: string, status: ToolStatus = "error"): BetaToolResultBlockParam => {
      this.markTool(use.id, { status, result: text });
      return { type: "tool_result", tool_use_id: use.id, is_error: true, content: text };
    };
    // The tools act on the map in front: never let one run while another map is there.
    const wrongMap = (): BetaToolResultBlockParam => { this.stop("tab"); return fail(this.notRun(), "stopped"); };
    if (!this.onItsMap()) return wrongMap();
    if (!tool) return fail(`There is no tool called ${use.name}.`);
    const input = (use.input ?? {}) as Record<string, unknown>;
    const errors = validate(tool.schema, input);
    let title = tool.name;
    try { title = tool.describe(input); } catch { /* a malformed input describes badly; the validation error says why */ }
    const effect = effectOf(tool, input);
    this.markTool(use.id, { title, input, effect });
    if (errors.length) return fail(`The input does not fit the tool's schema: ${errors.join("; ")}. Fix it and call again.`);

    if (this.needsApproval(effect)) {
      const item = this.markTool(use.id, { status: "approval" });
      const ok = await new Promise<boolean>((resolve) => {
        if (!item || this.abort?.signal.aborted) return resolve(false);
        this.approvals.set(item.id, resolve);
      });
      if (!ok) return fail(this.abort?.signal.aborted ? this.notRun() : "The user declined this change. Ask what they would like instead, or carry on without it.", this.abort?.signal.aborted ? "stopped" : "denied");
      // Allow is pressed on this conversation's map, but check: the change must land on it.
      if (!this.onItsMap()) return wrongMap();
    }

    // Steps that are not this turn's (the user's own, an undo) between two of its steps break
    // the run that "Undo these changes" would take back.
    const before = this.api.document.history();
    if (before.undoDepth !== this.lastDepth || before.undo !== this.lastTop) this.contiguous = false;
    const opens = tool.opensMap === true;
    this.opening = opens;
    this.markTool(use.id, { status: "running" });
    const ctx: ToolContext = {
      api: this.api,
      label: (text) => `${LABEL_PREFIX}${text}`,
      touched: (t) => this.show(t),
      signal: this.abort!.signal,
    };
    try {
      const out: ToolOutput = await tool.run(input, ctx);
      const text = typeof out === "string" ? out : out.text;
      const images = typeof out === "string" ? [] : out.images ?? [];
      const clipped = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… (cut at ${TEXT_LIMIT} characters)` : text;
      this.markTool(use.id, { status: "done", result: clipped, images: images.map((im) => `data:${im.mediaType};base64,${im.data}`) });
      const content: BetaToolResultBlockParam["content"] = images.length
        ? [{ type: "text", text: clipped }, ...images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } }))]
        : clipped;
      return { type: "tool_result", tool_use_id: use.id, content };
    } catch (err) {
      const text = err instanceof ToolError ? err.message : `The tool failed: ${err instanceof Error ? err.message : String(err)}`;
      if (!(err instanceof ToolError)) this.api.log("tool failed", use.name, err);
      return fail(text);
    } finally {
      this.opening = false;
      if (opens) this.adoptFrontMap();
      this.markStack();
    }
  }

  /** Flash what an edit touched and, while the user leaves the view alone, bring it on screen. */
  private show(t: Touched): void {
    const api = this.api;
    if (t.units?.length) api.view.flash({ units: t.units });
    else if (t.locations?.length) api.view.flash({ locations: t.locations });
    else if (t.rect) api.view.flash({ rect: t.rect });
    const rect = t.rect;
    if (this.following && rect) {
      void api.view.reveal(rect, { fit: true }).then((shown) => { if (!shown) this.following = false; });
    }
  }

  private fail(err: unknown): void {
    let text: string;
    let action: "settings" | undefined;
    if (err instanceof Anthropic.AuthenticationError) { text = t("The Anthropic API refused the key. Check it in the agent's settings."); action = "settings"; }
    else if (err instanceof Anthropic.PermissionDeniedError) { text = t("The key may not use this model or feature: {error}", { error: err.message }); action = "settings"; }
    else if (err instanceof Anthropic.NotFoundError) { text = t("Not found: {error}. Check the model and the API address in settings.", { error: err.message }); action = "settings"; }
    else if (err instanceof Anthropic.RateLimitError) text = t("Rate limited by the API. Wait a moment and send again.");
    else if (err instanceof Anthropic.BadRequestError) text = t("The API rejected the request: {error}", { error: err.message });
    else if (err instanceof Anthropic.APIConnectionError) { text = t("Could not reach the API ({error}). Check the network, or the API address in settings.", { error: err.message }); action = "settings"; }
    else if (err instanceof Anthropic.APIError) text = t("API error {status}: {error}", { status: err.status ?? "", error: err.message });
    else text = err instanceof Error ? err.message : String(err);
    this.push({ kind: "notice", id: nextId++, level: "error", text, action });
    // A request that failed leaves the history ending in the user's message (or tool results),
    // which is a valid place to resume from: the next send appends after it.
  }
}
