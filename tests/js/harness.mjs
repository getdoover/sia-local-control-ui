// Minimal DOM shim for rendering dashboard.html + dashboard.js under node,
// with no npm dependencies. It supports exactly what dashboard.js uses:
// getElementById, querySelector(All) with "#id", ".class", "tag" and
// descendant selectors, classList, textContent/innerHTML, style.width,
// attributes, click listeners and a fake socket.io client.
import fs from "node:fs";
import vm from "node:vm";

const VOID = new Set(["img", "meta", "link", "br", "input", "hr"]);

class FakeElement {
  constructor(tag, attrs, parent) {
    this.tagName = tag;
    this.attrs = attrs;
    this.id = attrs.id || null;
    this.classList = new FakeClassList(attrs.class);
    this.children = [];
    this.parent = parent;
    this.text = null;
    this.style = {};
    this.disabled = false;
    this.listeners = {};
  }
  get className() {
    return [...this.classList.set].join(" ");
  }
  set className(v) {
    this.classList = new FakeClassList(v);
  }
  get textContent() {
    return this.text || "";
  }
  set textContent(v) {
    this.text = String(v);
  }
  set innerHTML(v) {
    this.text = String(v);
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  click() {
    if (this.disabled) return; // browsers don't fire click on disabled buttons
    for (const fn of this.listeners.click || []) fn({ target: this });
  }
  *descendants() {
    for (const c of this.children) {
      yield c;
      yield* c.descendants();
    }
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const out = [];
    for (const el of this.descendants()) {
      if (matchesChain(el, parts, this)) out.push(el);
    }
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeClassList {
  constructor(value) {
    this.set = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }
  add(c) {
    this.set.add(c);
  }
  remove(c) {
    this.set.delete(c);
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
}

function matchesSimple(el, simple) {
  const re = /([#.]?)([\w-]+)/g;
  let m;
  while ((m = re.exec(simple))) {
    if (m[1] === "#" && el.id !== m[2]) return false;
    if (m[1] === "." && !el.classList.contains(m[2])) return false;
    if (m[1] === "" && el.tagName !== m[2]) return false;
  }
  return true;
}

function matchesChain(el, parts, root) {
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let node = el.parent;
  while (i >= 0 && node && node !== root.parent) {
    if (matchesSimple(node, parts[i])) i -= 1;
    node = node.parent;
  }
  return i < 0;
}

export function parseHtml(html) {
  const root = new FakeElement("#root", {}, null);
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let node = root;
  let m;
  while ((m = tagRe.exec(body))) {
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) {
      while (node !== root && node.tagName !== tag) node = node.parent;
      if (node !== root) node = node.parent;
      continue;
    }
    const attrs = {};
    const attrRe = /([\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      attrs[a[1]] = a[2] ?? a[3] ?? "";
    }
    const el = node.appendChild(new FakeElement(tag, attrs, node));
    if (!VOID.has(tag) && !m[0].endsWith("/>")) node = el;
  }
  return root;
}

// Load a template + script pair and return a controllable dashboard.
export function loadDashboard(htmlPath, jsPath) {
  const root = parseHtml(fs.readFileSync(htmlPath, "utf8"));
  const docListeners = {};
  const document = {
    getElementById: (id) =>
      [...root.descendants()].find((e) => e.id === id) || null,
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    createElement: (tag) => new FakeElement(tag, {}, null),
    addEventListener: (type, fn) => (docListeners[type] ||= []).push(fn),
  };
  const socket = {
    handlers: {},
    emits: [],
    ackReply: { ok: true },
    // With deferAcks, acks queue in `pending` until the test calls ackNext().
    deferAcks: false,
    pending: [],
    ackNext(reply = { ok: true }) {
      this.pending.shift()(reply);
    },
    on(event, fn) {
      this.handlers[event] = fn;
    },
    emit(event, payload, ack) {
      // JSON round-trip: payloads come from the vm realm (other prototypes).
      const copy = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
      this.emits.push([event, copy]);
      if (typeof ack !== "function") return;
      if (this.deferAcks) this.pending.push(ack);
      else ack(this.ackReply);
    },
    fire(event, payload) {
      this.handlers[event](payload);
    },
  };
  const window = {};
  const context = vm.createContext({
    document,
    window,
    io: () => socket,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(fs.readFileSync(jsPath, "utf8"), context);
  for (const fn of docListeners.DOMContentLoaded || []) fn();
  socket.fire("connect");
  return { root, document, socket, context, dashboard: window.dashboard };
}

// Serialise the rendered tree (tag, id, classes, text, width, children) so
// two renders can be compared. Elements whose id is in `skipIds` are dropped.
export function snapshot(node, skipIds = new Set()) {
  return node.children
    .filter((c) => !(c.id && skipIds.has(c.id)))
    .map((c) => {
      const out = { tag: c.tagName };
      if (c.id) out.id = c.id;
      const cls = [...c.classList.set].sort();
      if (cls.length) out.class = cls;
      if (c.text != null) out.text = c.text;
      if (c.style.width) out.width = c.style.width;
      const kids = snapshot(c, skipIds);
      if (kids.length) out.children = kids;
      return out;
    });
}

// True when the element or any ancestor carries the `hidden` class.
export function isHidden(el) {
  for (let n = el; n; n = n.parent) {
    if (n.classList && n.classList.contains("hidden")) return true;
  }
  return false;
}
