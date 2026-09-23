// Small render helpers shared by the page scripts.

import { icon } from "./icons.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

export function escAttr(s) {
  return esc(s).replace(/'/g, "&#39;");
}

export function tag(text, variant = "", extra = "") {
  const cls = variant ? `tag tag-${variant}` : "tag";
  return `<span class="${cls}"${extra ? ` ${extra}` : ""}>${text}</span>`;
}

export function relTime(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A "more" button that opens a small menu. items: [{ label, icon, danger, attrs }]
 * where attrs is a string of data attributes the page wires up itself.
 */
export function rowMenu(items, label = "More actions") {
  const buttons = items.map((it) =>
    `<button type="button" class="${it.danger ? "is-danger" : ""}" ${it.attrs ?? ""}>${it.icon ? icon(it.icon) : ""}${esc(it.label)}</button>`,
  ).join("");
  return `<span class="row-menu"><button type="button" class="icon-btn" data-menu-toggle aria-haspopup="menu" aria-expanded="false" title="${escAttr(label)}" aria-label="${escAttr(label)}">${icon("more")}</button><span class="row-menu-list hidden" role="menu">${buttons}</span></span>`;
}

let menuWired = false;

/** Opens and closes row menus under root. Safe to call after every render. */
export function wireRowMenus(root = document) {
  root.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const list = btn.nextElementSibling;
      const open = list.classList.contains("hidden");
      closeAllMenus();
      if (open) {
        list.classList.remove("hidden");
        btn.setAttribute("aria-expanded", "true");
      }
    });
    btn.nextElementSibling.addEventListener("click", () => closeAllMenus());
  });
  if (!menuWired) {
    menuWired = true;
    document.addEventListener("click", closeAllMenus);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllMenus(); });
  }
}

function closeAllMenus() {
  document.querySelectorAll(".row-menu-list:not(.hidden)").forEach((l) => {
    l.classList.add("hidden");
    l.previousElementSibling?.setAttribute("aria-expanded", "false");
  });
}

/** Thin stacked bar for match / differ / source only / dest only counts. */
export function stackBar(c) {
  const total = (c.match ?? 0) + (c.differ ?? 0) + (c.sourceOnly ?? 0) + (c.destOnly ?? 0);
  if (!total) return "";
  const seg = (n, cls) => (n ? `<span class="${cls}" style="flex:${n}"></span>` : "");
  return `<div class="stack-bar" role="img" aria-label="${escAttr(`${c.match ?? 0} match, ${c.differ ?? 0} differ, ${c.sourceOnly ?? 0} source only, ${c.destOnly ?? 0} destination only`)}">${seg(c.match, "s-match")}${seg(c.differ, "s-differ")}${seg(c.sourceOnly, "s-src")}${seg(c.destOnly, "s-dst")}</div>`;
}
