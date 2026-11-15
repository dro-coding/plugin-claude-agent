/**
 * The Claude panel: the conversation about the map in front, the composer, the model and
 * effort pickers, settings, and what the chat has cost. Every word goes through `t()`
 * (src/i18n.ts), so it shows in the editor's language.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Eye, FileText, Paperclip, Pencil, RotateCcw, Send, Settings, Square, Undo2, X } from "lucide-react";
import { MAX_FILES, type Attachment, type AttachmentKind } from "../attachments";
import type { AgentController } from "../controller";
import { msg, t } from "../i18n";
import type { AgentSession, SentFile, TranscriptItem } from "../session";
import { EFFORTS, MODELS, type AgentSettings, type ApprovalMode, type Effort, type Placement } from "../settings";
import { Markdown } from "./Markdown";

const SUGGESTIONS = [
  msg("Describe this map: players, layout, and what its triggers do."),
  msg("Check the map for problems and fix the ones you safely can."),
  msg("Give every start location a standard mineral line and a geyser."),
  msg("Add a victory trigger for each player when all their enemies' buildings are destroyed."),
  msg("Make Player 2 a Zerg computer that runs a default AI script."),
];

/** Re-render whenever a source with a `subscribe` says it changed. */
function useRerender(source: { subscribe(fn: () => void): () => void }): void {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => source.subscribe(bump), [source]);
}

export function AgentPanel({ controller }: { controller: AgentController }) {
  const [session, setSession] = useState<AgentSession>(() => controller.current());
  // The map in front, or its undo stack, changed: show that map's conversation, and let the
  // turn rows decide again whether their "Undo these changes" still applies.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => controller.subscribe(() => { setSession(controller.current()); bump(); }), [controller]);
  useRerender(session);
  useRerender(controller.settings);
  const settings = controller.settings.get();
  const ready = controller.settings.ready();
  const [showSettings, setShowSettings] = useState(!ready);
  const attach = useAttachments(session);
  const [dragging, setDragging] = useState(false);
  const dragTimer = useRef<number | null>(null);

  // A file dropped on the panel is an attachment. The editor opens a map dropped anywhere
  // in the window; cancelling here, and stopping the event, keeps it from doing that with
  // a file meant for Claude.
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current);
    dragTimer.current = window.setTimeout(() => { dragTimer.current = null; setDragging(false); }, 400);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    void attach.add([...e.dataTransfer.files]);
  };

  return (
    <div className={`cla-root${dragging ? " cla-dropping" : ""}`} onDragOver={onDragOver} onDrop={onDrop}>
      <div className="cla-bar">
        <select className="select cla-model" value={settings.model} title={t("Model")} onChange={(e) => controller.settings.set({ model: e.target.value })}>
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select className="select cla-effort" value={settings.effort} title={t("How hard Claude thinks: more is slower and costs more")} onChange={(e) => controller.settings.set({ effort: e.target.value as Effort })}>
          {EFFORTS.map((e) => <option key={e.id} value={e.id}>{t(e.label)}</option>)}
        </select>
        <button type="button" className="btn icon sm ghost" title={t("New conversation")} disabled={session.busy || session.items.length === 0} onClick={() => session.reset()}><RotateCcw size={14} /></button>
        <button type="button" className={`btn icon sm ghost${showSettings ? " is-active" : ""}`} title={t("Settings")} onClick={() => setShowSettings(!showSettings)}><Settings size={14} /></button>
      </div>
      {showSettings && (
        <SettingsForm
          settings={settings}
          onChange={(p) => {
            controller.settings.set(p);
            if (p.placement !== undefined) controller.reopen();
          }}
          onClose={() => setShowSettings(false)}
          canClose={ready}
        />
      )}
      <Transcript session={session} onSuggestion={(s) => void session.send(s)} ready={ready} onSettings={() => setShowSettings(true)} />
      <Composer session={session} ready={ready} attach={attach} />
      <Footer session={session} />
      {dragging && <div className="cla-drop-hint"><Paperclip size={16} /> {t("Drop to attach: pictures, PDFs, text, .trg")}</div>}
    </div>
  );
}

/* ── Attachments ────────────────────────────────────────── */

interface Attach {
  files: Attachment[];
  errors: string[];
  reading: number;
  add(list: File[]): Promise<void>;
  remove(index: number): void;
  clear(): void;
}

/** The files waiting to go with the next message, and why any were turned away. */
function useAttachments(session: AgentSession): Attach {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [reading, setReading] = useState(0);
  const current = useRef<Attachment[]>([]);
  current.current = files;
  // Another map's conversation: what was waiting belonged to this one.
  useEffect(() => { setFiles([]); setErrors([]); }, [session]);

  const add = async (list: File[]) => {
    if (list.length === 0) return;
    setErrors([]);
    setReading((n) => n + list.length);
    const ok: Attachment[] = [];
    const bad: string[] = [];
    for (const file of list) {
      try {
        ok.push(await session.readFile(file));
      } catch (err) {
        bad.push(err instanceof Error ? err.message : String(err));
      } finally {
        setReading((n) => n - 1);
      }
    }
    const room = Math.max(0, MAX_FILES - current.current.length);
    if (ok.length > room) bad.push(t("Up to {max} files go with one message; {left} left out.", { max: MAX_FILES, left: ok.length - room }));
    const next = [...current.current, ...ok.slice(0, room)];
    current.current = next;
    setFiles(next);
    setErrors(bad);
  };
  return {
    files, errors, reading, add,
    remove: (index) => setFiles((cur) => cur.filter((_, n) => n !== index)),
    clear: () => { setFiles([]); setErrors([]); },
  };
}

const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function FileChip({ name, kind, size, preview, onRemove }: { name: string; kind: AttachmentKind; size: number; preview?: string; onRemove?: () => void }) {
  return (
    <span className="cla-file" title={`${name} — ${sizeText(size)}`}>
      {preview ? <img src={preview} alt="" /> : <FileText size={13} />}
      <span className="cla-file-name">{name}</span>
      <span className="cla-dim">{kind === "pdf" ? "PDF" : kind === "image" ? sizeText(size) : t("text")}</span>
      {onRemove && <button type="button" className="cla-file-x" title={t("Remove")} onClick={onRemove}><X size={11} /></button>}
    </span>
  );
}

function SentFiles({ files }: { files: SentFile[] }) {
  const [big, setBig] = useState<string | null>(null);
  const pictures = files.filter((f) => f.preview);
  return (
    <div className="cla-sent-files">
      {pictures.length > 0 && (
        <div className="cla-images">
          {pictures.map((f) => <img key={f.name + f.size} src={f.preview} alt={f.name} title={f.name} className={big === f.preview ? "big" : ""} onClick={() => setBig(big === f.preview ? null : f.preview!)} />)}
        </div>
      )}
      {files.filter((f) => !f.preview).map((f) => <FileChip key={f.name + f.size} name={f.name} kind={f.kind} size={f.size} />)}
    </div>
  );
}

/* ── Settings ───────────────────────────────────────────── */

function SettingsForm({ settings, onChange, onClose, canClose }: { settings: AgentSettings; onChange: (p: Partial<AgentSettings>) => void; onClose: () => void; canClose: boolean }) {
  const [key, setKey] = useState(settings.apiKey);
  const [baseURL, setBaseURL] = useState(settings.baseURL);
  const save = () => { onChange({ apiKey: key.trim(), baseURL: baseURL.trim().replace(/\/+$/, "") }); if (key.trim() || baseURL.trim()) onClose(); };
  return (
    <div className="cla-settings">
      <label className="cla-field">
        <span>{t("Anthropic API key")}</span>
        <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.rememberKey} onChange={(e) => onChange({ rememberKey: e.target.checked })} />
        <span>{t("Remember the key on this device")}</span>
      </label>
      <p className="hint">{t("The key goes from this browser straight to the API address below and nowhere else. Unticked, it is forgotten when the page closes. Ticked, it is kept in this browser's local storage, readable by anything that runs on this page (plugins included).")}</p>
      <label className="cla-field">
        <span>{t("API address")}</span>
        <input className="input mono" placeholder={t("https://api.anthropic.com (default)")} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      </label>
      <p className="hint">{t("Leave blank for Anthropic's API. A proxy on your own network that adds the key itself can go here instead, and then the key can stay empty.")}</p>
      <label className="cla-field">
        <span>{t("Ask before a change")}</span>
        <select className="select" value={settings.approval} onChange={(e) => onChange({ approval: e.target.value as ApprovalMode })}>
          <option value="destructive">{t("Only when it deletes or replaces work")}</option>
          <option value="all">{t("Before every change")}</option>
          <option value="never">{t("Never")}</option>
        </select>
      </label>
      <label className="cla-field">
        <span>{t("Where the panel sits")}</span>
        <select className="select" value={settings.placement} onChange={(e) => onChange({ placement: e.target.value as Placement })}>
          <option value="float">{t("A window over the map (drag, resize, maximize)")}</option>
          <option value="right">{t("The right dock, under the built-in panels")}</option>
          <option value="bottom">{t("A strip under the map")}</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={settings.followEdits} onChange={(e) => onChange({ followEdits: e.target.checked })} /><span>{t("Bring each change on screen")}</span></label>
      <label className="check"><input type="checkbox" checked={settings.showThinking} onChange={(e) => onChange({ showThinking: e.target.checked })} /><span>{t("Show Claude's reasoning")}</span></label>
      <div className="row end">
        {canClose && <button type="button" className="btn sm ghost" onClick={onClose}>{t("Close")}</button>}
        <button type="button" className="btn sm primary" onClick={save}>{t("Save")}</button>
      </div>
    </div>
  );
}

/* ── Transcript ─────────────────────────────────────────── */

function Transcript({ session, onSuggestion, ready, onSettings }: { session: AgentSession; onSuggestion: (s: string) => void; ready: boolean; onSettings: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  return (
    <div className="cla-transcript" ref={box} onScroll={onScroll}>
      {session.items.length === 0 && (
        <div className="cla-empty">
          <p>{t("Ask Claude to read or change this map: terrain, units, locations, triggers, the briefing, players and forces, unit settings, strings. Every change is one undo step (Ctrl+Z).")}</p>
          {ready ? SUGGESTIONS.map((s) => <button key={s} type="button" className="cla-suggestion" onClick={() => onSuggestion(t(s))}>{t(s)}</button>)
            : <button type="button" className="btn sm primary" onClick={onSettings}>{t("Add your API key")}</button>}
        </div>
      )}
      {session.items.map((item) => <Item key={item.id} item={item} session={session} onSettings={onSettings} />)}
      {session.busy && !session.items.some((i) => (i.kind === "text" || i.kind === "thinking") && !i.done) && !session.items.some((i) => i.kind === "tool" && (i.status === "running" || i.status === "streaming" || i.status === "approval")) && (
        <div className="cla-working"><span className="spinner sm" /> {t("Thinking…")}</div>
      )}
    </div>
  );
}

function Item({ item, session, onSettings }: { item: TranscriptItem; session: AgentSession; onSettings: () => void }) {
  switch (item.kind) {
    case "user": return (
      <div className="cla-user">
        {item.text}
        {item.files?.length ? <SentFiles files={item.files} /> : null}
      </div>
    );
    case "text": return item.text.trim() ? <div className="cla-text"><Markdown text={item.text} /></div> : null;
    case "thinking": return <Thinking text={item.text} done={item.done} />;
    case "tool": return <ToolRow item={item} session={session} />;
    case "notice": return (
      <div className={`cla-notice ${item.level}`}>
        {item.level !== "info" && <AlertTriangle size={13} />}
        <span>{item.text}</span>
        {item.action === "settings" && <button type="button" className="btn sm ghost" onClick={onSettings}>{t("Settings")}</button>}
      </div>
    );
    case "turn": return <TurnRow item={item} session={session} />;
  }
}

/**
 * The end of a reply: how many undo steps it left and how long it took, and "Undo these
 * changes" while they are still the newest steps on its map's undo stack. Once anything
 * else is on top (a later reply, an edit of the user's, an undo), the button stays but is
 * off, and says why: those steps are then Edit ▸ Undo's to reach, not this button's.
 */
function TurnRow({ item, session }: { item: Extract<TranscriptItem, { kind: "turn" }>; session: AgentSession }) {
  const can = session.canUndoTurn(item.id);
  return (
    <div className="cla-turn">
      <span>{item.edits ? `${t("{n, plural, one {# change} other {# changes}}", { n: item.edits })} · ` : ""}{t("{s} s", { s: item.seconds })}</span>
      {item.edits > 0 && item.undoable && !item.undone && (
        <button
          type="button"
          className="btn sm ghost"
          disabled={!can}
          title={can ? t("Undo the changes this reply made") : session.busy ? t("Wait for the reply in progress to finish.") : t("Later changes are on top of these on the undo stack, so this button no longer applies. Edit ▸ Undo still reaches them.")}
          onClick={() => session.undoTurn(item.id)}
        >
          <Undo2 size={12} /> {t("Undo these changes")}
        </button>
      )}
      {item.undone && <span className="cla-dim">{t("undone")}</span>}
    </div>
  );
}

function Thinking({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cla-thinking">
      <button type="button" className="cla-thinking-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {done ? t("Reasoning") : t("Reasoning…")}
      </button>
      {open && <div className="cla-thinking-body">{text}</div>}
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

function ToolRow({ item, session }: { item: Extract<TranscriptItem, { kind: "tool" }>; session: AgentSession }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState<string | null>(null);
  const icon = item.status === "streaming" || item.status === "running" ? <span className="spinner sm" />
    : item.status === "error" ? <X size={13} className="cla-bad" />
      : item.status === "denied" ? <Ban size={13} className="cla-bad" />
        : item.status === "stopped" ? <Square size={11} className="cla-dim" />
          : item.status === "approval" ? <AlertTriangle size={13} className="cla-warn" />
            : item.effect === "read" ? <Eye size={13} className="cla-dim" /> : item.effect === "destructive" ? <Check size={13} className="cla-warn" /> : <Pencil size={13} className="cla-ok" />;
  const hasDetail = item.input !== undefined || item.result;
  return (
    <div className={`cla-tool ${item.status} ${item.effect}`}>
      <button type="button" className="cla-tool-head" onClick={() => hasDetail && setOpen(!open)} title={item.name}>
        {icon}
        <span className="cla-tool-title">{item.title}</span>
        {hasDetail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {item.status === "approval" && (
        <div className="cla-approve">
          <span>{item.effect === "destructive" ? t("This removes or replaces existing work (it can be undone).") : t("Allow this change?")}</span>
          <div className="row">
            <button type="button" className="btn sm primary" onClick={() => session.answer(item.id, true)}>{t("Allow")}</button>
            <button type="button" className="btn sm" onClick={() => session.answer(item.id, true, true)}>{t("Allow all this reply")}</button>
            <button type="button" className="btn sm ghost" onClick={() => session.answer(item.id, false)}>{t("Deny")}</button>
          </div>
        </div>
      )}
      {item.images?.length ? (
        <div className="cla-images">
          {item.images.map((src, n) => <img key={n} src={src} alt={t("The map as Claude saw it")} className={big === src ? "big" : ""} onClick={() => setBig(big === src ? null : src)} />)}
        </div>
      ) : null}
      {open && (
        <div className="cla-tool-detail">
          {item.input !== undefined && <pre>{clip(JSON.stringify(item.input, null, 1), 6000)}</pre>}
          {item.result && <pre className={item.status === "error" || item.status === "denied" ? "cla-bad" : ""}>{clip(item.result, 8000)}</pre>}
        </div>
      )}
    </div>
  );
}

/* ── Composer and footer ────────────────────────────────── */

function Composer({ session, ready, attach }: { session: AgentSession; ready: boolean; attach: Attach }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canSend = ready && !session.busy && attach.reading === 0 && (text.trim() !== "" || attach.files.length > 0);
  const send = () => {
    if (!canSend) return;
    const files = attach.files;
    setText("");
    attach.clear();
    void session.send(text.trim(), files);
  };
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, Math.max(54, el.scrollHeight + 2))}px`;
  }, [text]);
  return (
    <div className="cla-composer">
      {(attach.files.length > 0 || attach.reading > 0) && (
        <div className="cla-files">
          {attach.files.map((f, n) => (
            <FileChip key={`${n}-${f.name}`} name={f.name} kind={f.kind} size={f.size} preview={f.kind === "image" ? `data:${f.mediaType};base64,${f.data}` : undefined} onRemove={() => attach.remove(n)} />
          ))}
          {attach.reading > 0 && <span className="cla-file"><span className="spinner sm" /> {t("Reading…")}</span>}
        </div>
      )}
      {attach.errors.map((err) => <div key={err} className="cla-notice warn"><AlertTriangle size={13} /><span>{err}</span></div>)}
      <textarea
        ref={area}
        className="textarea"
        placeholder={ready ? t("Ask Claude to change the map… (drop or paste files to attach)") : t("Add your API key in settings first")}
        disabled={!ready}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
        onPaste={(e) => {
          // A pasted picture (a screenshot) is an attachment; pasted text stays text.
          const files = [...e.clipboardData.files];
          if (files.length === 0) return;
          e.stopPropagation();
          if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
          void attach.add(files);
        }}
      />
      <div className="cla-composer-row">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void attach.add(files);
          }}
        />
        <button type="button" className="btn sm ghost" title={t("Attach files: pictures, PDFs, text, .trg")} disabled={!ready || session.busy} onClick={() => picker.current?.click()}>
          <Paperclip size={12} /> {t("Attach")}
        </button>
        {session.busy
          ? <button type="button" className="btn sm danger" title={t("Stop")} onClick={() => session.stop()}><Square size={12} /> {t("Stop")}</button>
          : <button type="button" className="btn sm primary" title={t("Send (Enter)")} disabled={!canSend} onClick={send}><Send size={12} /> {t("Send")}</button>}
      </div>
    </div>
  );
}

function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function Footer({ session }: { session: AgentSession }) {
  const u = session.usage;
  if (!u.input && !u.output && !u.cacheRead) return null;
  const detail = t("Input {input}, cache read {read}, cache write {write}, output {output}. The cost is an estimate at list prices.", {
    input: tokens(u.input), read: tokens(u.cacheRead), write: tokens(u.cacheWrite), output: tokens(u.output),
  });
  return (
    <div className="cla-footer" title={detail}>
      <span>{u.context > 400_000 ? t("{tokens} tokens in context — consider a new conversation", { tokens: tokens(u.context) }) : t("{tokens} tokens in context", { tokens: tokens(u.context) })}</span>
      <span>≈ ${u.cost < 0.01 ? u.cost.toFixed(3) : u.cost.toFixed(2)}</span>
    </div>
  );
}
