# Claude Agent

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It adds a panel where Claude reads and edits the open map with you:
terrain, units, locations, doodads, sprites, fog of war, triggers, the mission briefing,
strings, switches, players and forces, unit / upgrade / technology settings and the map's
properties. It can look at the map as a picture, and read the editor's own documentation.

Every change goes through the editor's plugin API, as one undo step labelled `Claude: …`,
so Ctrl+Z takes back any of it. A reply ends with **Undo these changes**, which takes back
that reply's steps for as long as they are the newest on the undo stack.

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/dro-coding/plugin-claude-agent
```

and press **Add**. Then **Tools ▸ Claude Agent** (Ctrl+Alt+C), or the **Claude** cell in the
status bar, opens the panel. It asks for an Anthropic API key the first time.

## Your key, and where things go

The plugin calls the Anthropic API from your browser, with your own key. There is no server
of its own. The key goes from the browser straight to the API address in the panel's
settings (`https://api.anthropic.com` unless you name a proxy) and nowhere else. It is kept
in memory until the page closes, or in the browser's local storage if you tick **Remember
the key on this device**; anything that runs on the page, other plugins included, can read
local storage.

What is sent with each message: a short description of the open map (`<map_state>`), your
words and any files you attach, and what the tools read from the map when Claude asks.

## How it behaves

- **One map at a time.** A conversation belongs to the map it started on, and each open map
  has its own. Claude's tools act on the map in front, so if another map comes to the front
  while Claude is replying, the reply stops before its next change, and says so. Switch back
  and say "continue". The one exception is **new_map**: the conversation moves with Claude
  to the map it made.
- **Asking first.** The settings choose whether Claude asks before every change, only before
  one that deletes or replaces work (the default), or never.
- **Map text is not instructions.** Strings, trigger text and names come from whoever made
  the map. Claude is told to treat them as content and to tell you when one asks it to do
  something.
- **Cost.** The footer shows the tokens in context and an estimate of what the conversation
  has cost at list prices.

## Files

- `plugin.ts` registers the menu item, the hotkey and the status-bar cell; everything else
  is imported the first time the panel opens.
- `src/session.ts` is one conversation: the tool-use loop over the Messages API, approvals,
  and the undo bookkeeping. `src/controller.ts` keeps one per open map.
- `src/tools/` are the tools Claude calls, over the plugin API only. `src/ui/` is the panel
  (React).
- `src/generated/docs.ts` is the editor's `docs/triggers.md` and `docs/guide.md` at a
  release tag, for the `read_docs` tool. `npm run docs [tag]` copies them again.
- `ko.ts` holds the Korean for every word the plugin shows. `tests/ko.test.ts` checks it.
- `dist/plugin.js` is the bundle the editor loads (`build` in `plugin.json`). Build it with
  `npm run build` and commit it; CI fails when it is not what the source builds to.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests run without the editor: the tool set, attachments and prices directly, and the
conversation loop against a scripted Messages API and a stand-in editor with an undo stack
per map. The tools against a real map are tested where an editor is at hand: the
[dro-coding/scm-js](https://github.com/dro-coding/scm-js) fork compiles this plugin in and
runs them in `tests/claude-agent-plugin.test.ts`.

## License

MIT. `src/generated/docs.ts` is scmJS's documentation, MIT, copyright scmJS.
