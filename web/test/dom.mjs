import { readFileSync } from 'node:fs';

// Event orchestration only: this fixture does not establish browser layout or device behavior.
export function domFixture() {
  const nodes = [], saved = new Map(), storage = new Map(), clipboardWrites = [], media = new Map();
  class Element extends EventTarget {
    constructor(tag) { super(); Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: new Map(), style: {}, value: '', hidden: false, disabled: false, textContent: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0 }); nodes.push(this); }
    append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
    replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.append(...items); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    insertBefore(item, next) { item.remove(); const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, item); item.parent = this; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    showPopover() { this.open = true; this.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' })); }
    hidePopover() { this.open = false; this.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' })); }
    matches(selector) { return selector === ':popover-open' && Boolean(this.open); }
    getBoundingClientRect() { return { left: 220, right: 252, top: 40, bottom: 72 }; }
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
    contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; }
    querySelectorAll() { return this.children.flatMap(node => [node, ...node.querySelectorAll()]).filter(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(node.tagName) || node.getAttribute('tabindex') != null); }
    requestSubmit() { this.dispatchEvent(new Event('submit', { cancelable: true })); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click', { cancelable: true })); }
  }
  const document = { body: new Element('body'), createElement: tag => new Element(tag),
    querySelector(selector) { return selector === '.work-layout' ? layout : nodes.findLast(node => node.id === selector.slice(1)) ?? null; } };
  const layout = new Element('div');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
    const node = new Element(match[1]); node.id = match[3]; node.textContent = match[4]; node.hidden = /\bhidden\b/.test(match[2]); document.body.append(node);
  }
  const location = { href: 'https://fixture.test/?thread=t' };
  const globals = { document, location, history: { replaceState(_state, _title, url) { location.href = String(url); } },
    window: { confirm: () => true, prompt: () => null, innerWidth: 1280, innerHeight: 820 }, navigator: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } },
    matchMedia: query => { if (!media.has(query)) { const value = new EventTarget(); value.matches = query === '(max-width: 760px)' ? window.innerWidth <= 760 : true; media.set(query, value); } return media.get(query); }, requestAnimationFrame: fn => queueMicrotask(fn),
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
  for (const [key, value] of Object.entries(globals)) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  return { document, location, clipboardWrites, get: id => document.querySelector('#' + id),
    resize(width) { window.innerWidth = width; for (const [query, value] of media) { const next = query === '(max-width: 760px)' ? width <= 760 : true; if (next !== value.matches) { value.matches = next; value.dispatchEvent(new Event('change')); } } },
    event(id, type, fields = {}) { const event = Object.assign(new Event(type, { cancelable: true }), fields); document.querySelector('#' + id).dispatchEvent(event); return event; },
    restore() { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } } };
}
