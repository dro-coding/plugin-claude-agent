/**
 * What outlives the panel: the settings and one conversation per open map, keyed by the
 * document's id, so closing the panel mid-turn does not stop Claude, and switching map tabs
 * brings back that map's conversation. Loaded the first time the panel opens, with the
 * Anthropic SDK behind it, so an editor that never opens the agent never loads either.
 *
 * A conversation's tools act on the map in front, so every change of map is passed to every
 * conversation: one whose map went behind in the middle of a turn stops it there
 * (`AgentSession.documentChanged`). `new_map` is the exception: the conversation that made
 * the map moves to it (`moved`).
 */
import type { PluginApi, StatusItemHandle } from "@scm-js/plugin-api";
import { t } from "./i18n";
import { AgentSession } from "./session";
import { SettingsStore } from "./settings";

type Key = number | "none";
const keyOf = (id: number | null): Key => id ?? "none";

export class AgentController {
  readonly api: PluginApi;
  readonly settings: SettingsStore;
  /** Close and open the panel again, where the placement setting now says. */
  readonly reopen: () => void;
  private readonly status: StatusItemHandle;
  private sessions = new Map<Key, AgentSession>();
  private listeners = new Set<() => void>();
  private busyCount = 0;

  constructor(api: PluginApi, status: StatusItemHandle, reopen: () => void) {
    this.api = api;
    this.status = status;
    this.reopen = reopen;
    this.settings = new SettingsStore(api);
    api.events.on("document", (e) => {
      for (const session of [...this.sessions.values()]) session.documentChanged(e.id);
      if (e.reason === "close") {
        for (const id of this.sessions.keys()) {
          if (id !== "none" && !api.document.list().some((d) => d.id === id)) {
            this.sessions.get(id)?.stop();
            this.sessions.delete(id);
          }
        }
      }
      this.notify();
    });
    // Edits, undos and redos move the undo stack, which decides whether a reply's
    // "Undo these changes" still applies.
    api.events.on("commit", () => this.notify());
  }

  /** The conversation about the map in front. */
  current(): AgentSession {
    const id = this.api.document.id();
    let s = this.sessions.get(keyOf(id));
    if (!s) {
      const session: AgentSession = new AgentSession(this.api, id, () => this.settings.get(), (busy) => this.busyChanged(busy), (from, to) => this.moved(session, from, to));
      s = session;
      this.sessions.set(keyOf(id), s);
    }
    return s;
  }

  /** A conversation's turn opened a map and carries on there; the map it left starts a fresh one when next in front. */
  private moved(session: AgentSession, from: number | null, to: number | null): void {
    if (this.sessions.get(keyOf(from)) === session) this.sessions.delete(keyOf(from));
    const there = this.sessions.get(keyOf(to));
    if (there && there !== session) there.stop();
    this.sessions.set(keyOf(to), session);
    this.notify();
  }

  /** Fires when the map in front, or its undo stack, changes, so the panel shows what is current. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** The plugin is being turned off: stop every reply in progress. */
  dispose(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.listeners.clear();
  }

  private busyChanged(busy: boolean): void {
    this.busyCount = Math.max(0, this.busyCount + (busy ? 1 : -1));
    this.status.set({ text: this.busyCount ? t("Claude · working") : "Claude", busy: this.busyCount > 0 });
  }
}
