/**
 * Claude Agent: a plugin for the scmJS map editor (https://github.com/scm-js/scm-js). A
 * panel where Claude reads and edits the open map with the user, through the plugin API
 * alone: every change is one `document.edit` / `document.update`, one undo step labelled
 * "Claude: …". Tools ▸ Claude Agent (Ctrl+Alt+C) and the status-bar cell open it.
 *
 * This file is all that runs at startup. The controller, the tools, the Anthropic SDK and
 * the panel are imported the first time the panel opens (an editor that compiles the plugin
 * in loads them then; the published bundle carries them in the one file).
 */
import type { PanelHandle, PanelSpec, PluginApi } from "@scm-js/plugin-api";
import { KO } from "./ko";
import { setTranslator, t } from "./src/i18n";
import type { AgentController } from "./src/controller";
import type { Placement } from "./src/settings";

export function activate(api: PluginApi): () => void {
  const catalogue = api.i18n.register({ ko: KO });
  setTranslator((text, params) => api.i18n.t(text, params));
  let panel: PanelHandle | null = null;
  let controller: Promise<AgentController> | null = null;

  const status = api.ui.statusItem({ text: "Claude", title: t("Claude Agent (Ctrl+Alt+C)"), onClick: () => toggle() });

  const load = (): Promise<AgentController> => {
    controller ??= import("./src/controller").then((m) => new m.AgentController(api, status, reopen));
    return controller;
  };

  /** A floating window tall enough to read a conversation in; the docks size themselves. */
  const where = (): Pick<PanelSpec, "dock" | "grow" | "width" | "height" | "resizable" | "maximizable" | "flush"> => {
    const placement = api.storage.get<{ placement?: Placement }>("settings", {}).placement ?? "float";
    if (placement === "right") return { dock: "right", grow: true };
    if (placement === "bottom") return { dock: "bottom", height: 280 };
    return { dock: "float", width: 400, height: Math.max(360, Math.min(760, Math.round(window.innerHeight * 0.72))), resizable: true, maximizable: true };
  };

  const open = () => {
    if (panel?.isOpen()) return;
    panel = api.ui.panel({
      title: "Claude",
      ...where(),
      mount(body) {
        let cleanup: (() => void) | null = null;
        let gone = false;
        void Promise.all([load(), import("./src/ui/mount")]).then(([c, ui]) => {
          if (!gone) cleanup = ui.mountAgent(body, c);
        }).catch((err) => {
          body.textContent = t("The Claude panel could not load: {error}", { error: err instanceof Error ? err.message : String(err) });
        });
        return () => { gone = true; cleanup?.(); };
      },
      onClose: () => { panel = null; },
    });
  };

  /** Close and open again, after the placement setting changed. The conversations live in the controller and carry on. */
  function reopen(): void {
    panel?.close();
    panel = null;
    open();
  }

  const toggle = () => (panel?.isOpen() ? panel.close() : open());

  // Nothing opens by itself: a window appearing over the map on a first visit would be in
  // the way. The status-bar cell is always there to find it by. The menu label is the
  // product's name, which needs no translation.
  api.menu.add("Tools", { label: "Claude Agent", shortcut: "Ctrl+Alt+C", icon: "plugin", run: toggle });
  api.hotkeys.add("Ctrl+Alt+C", toggle);

  // Turned off: what the editor registered goes by itself; a reply still running is stopped.
  return () => {
    void controller?.then((c) => c.dispose());
    setTranslator(null);
    catalogue.dispose();
  };
}

export default activate;
