/**
 * The plugin's words in the editor's language. `plugin.ts` registers the Korean catalogue
 * (`ko.ts`) and hands the editor's `api.i18n.t` to `setTranslator`; everything the plugin
 * shows goes through `t`, always with an English string literal and its params, so
 * tests/ko.test.ts can read the strings out of the source and check the catalogue has
 * them. `msg` marks a literal that is translated where it is shown, not where it is
 * written (an effort label, a list of suggestions).
 */
export type Params = Record<string, string | number>;
type Translate = (text: string, params?: Params) => string;

/** Until the plugin starts (and in tests): English, with `{name}` and `{n, plural, one {…} other {…}}` filled. */
const english: Translate = (text, params) => {
  if (!params) return text;
  return text
    .replace(/\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g, (_m, k: string, one: string, other: string) => (params[k] === 1 ? one : other).replace(/#/g, String(params[k])))
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
};
let current: Translate = english;

export function setTranslator(fn: Translate | null): void {
  current = fn ?? english;
}

export function t(text: string, params?: Params): string {
  return current(text, params);
}

/** Marks a literal for the catalogue test; the text is translated with `t(…)` where it is shown. */
export const msg = (text: string): string => text;
