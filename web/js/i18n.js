// Übersetzung der Oberfläche. Quelltexte sind Deutsch; feste Texte im DOM werden automatisch
// übersetzt (Textknoten, title, placeholder), dynamische Texte laufen über t('… {x} …', { x }).
import { DICT } from './i18n-data.js';

export const LANGUAGES = [
  ['de', 'Deutsch'], ['en', 'English'], ['fr', 'Français'], ['es', 'Español'],
  ['it', 'Italiano'], ['nl', 'Nederlands'], ['pl', 'Polski'],
];
const LOCALES = { de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL' };

let lang = 'de';
let dict = {};
const original = new WeakMap(); // Textknoten -> Originaltext
const written = new WeakMap(); // Textknoten -> zuletzt von uns geschriebener Text
const ATTRS = ['title', 'placeholder', 'aria-label'];

export function detectLanguage() {
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const c = String(l).slice(0, 2).toLowerCase();
    if (LANGUAGES.some(([k]) => k === c)) return c;
  }
  return 'en';
}
export const getLanguage = () => lang;
export const locale = () => LOCALES[lang] || 'en-GB';

export function t(s, vars) {
  let r = (lang !== 'de' && dict[s]) || s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return r;
}

function translateText(node) {
  const cur = node.nodeValue;
  if (written.get(node) === cur) return;
  original.set(node, cur);
  const key = cur.trim();
  if (!key) return;
  const tr = lang !== 'de' && dict[key];
  const next = tr ? cur.replace(key, tr) : cur;
  written.set(node, next);
  if (next !== cur) node.nodeValue = next;
}
function restoreAndTranslateText(node) {
  const src = original.has(node) && written.get(node) === node.nodeValue ? original.get(node) : node.nodeValue;
  const key = src.trim();
  const tr = key && lang !== 'de' && dict[key];
  const next = tr ? src.replace(key, tr) : src;
  original.set(node, src);
  written.set(node, next);
  if (node.nodeValue !== next) node.nodeValue = next;
}
function translateAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute?.(a)) continue;
    const store = 'data-i18n-' + a, wstore = 'data-i18n-w-' + a;
    const cur = el.getAttribute(a);
    const src = el.getAttribute(store) !== null && cur === el.getAttribute(wstore) ? el.getAttribute(store) : cur;
    const next = (lang !== 'de' && dict[src]) || src;
    el.setAttribute(store, src);
    el.setAttribute(wstore, next);
    if (cur !== next) el.setAttribute(a, next);
  }
}
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
function walk(root, full) {
  if (root.nodeType === 3) { (full ? restoreAndTranslateText : translateText)(root); return; }
  if (root.nodeType !== 1 || SKIP.has(root.nodeName)) return;
  translateAttrs(root);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && SKIP.has(n.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = tw.nextNode())) {
    if (n.nodeType === 3) (full ? restoreAndTranslateText : translateText)(n);
    else translateAttrs(n);
  }
}

let observer = null;
export function setLanguage(l) {
  lang = DICT[l] || l === 'de' ? l : 'en';
  dict = DICT[lang] || {};
  document.documentElement.lang = lang;
  walk(document.body, true);
  if (!observer) {
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach((n) => walk(n, false));
        else if (m.type === 'characterData') translateText(m.target);
        else if (m.type === 'attributes') translateAttrs(m.target);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
}

/** Ein Text in allen Sprachen (zum Wiedererkennen von Standardnamen). */
export function allTranslations(s) {
  return [s, ...Object.values(DICT).map((d) => d[s]).filter(Boolean)];
}
