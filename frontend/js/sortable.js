/**
 * Makes every <th> in a .data-table clickable for sorting.
 *
 * Usage: after rendering a table into the DOM, call
 *   makeSortable(containerElement)
 * where containerElement contains one or more .data-table elements.
 *
 * Columns with the class "col-check" or "col-actions" are skipped.
 * Sorting is client-side only — it reorders <tr> elements in the <tbody>.
 * A second click on the same header reverses the sort order.
 */

export function makeSortable(container) {
  if (!container) return;
  const tables = container.querySelectorAll
    ? container.matches?.(".data-table")
      ? [container]
      : container.querySelectorAll(".data-table")
    : [];

  for (const table of tables) {
    const headers = table.querySelectorAll("thead th");
    headers.forEach((th, colIdx) => {
      if (th.classList.contains("col-check") || th.classList.contains("col-actions")) return;
      if (th.textContent.trim() === "") return;
      th.classList.add("sortable-th");
      th.dataset.sortDir = "";
      th.addEventListener("click", () => sortTable(table, colIdx, th, headers));
    });
  }
}

function sortTable(table, colIdx, clickedTh, allHeaders) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;

  // Determine direction: toggle from current
  const prevDir = clickedTh.dataset.sortDir;
  const dir = prevDir === "asc" ? "desc" : "asc";

  // Reset all headers
  allHeaders.forEach((h) => {
    h.dataset.sortDir = "";
    h.classList.remove("sort-asc", "sort-desc");
  });
  clickedTh.dataset.sortDir = dir;
  clickedTh.classList.add(dir === "asc" ? "sort-asc" : "sort-desc");

  const rows = Array.from(tbody.querySelectorAll("tr"));
  rows.sort((a, b) => {
    const aCell = a.children[colIdx];
    const bCell = b.children[colIdx];
    if (!aCell || !bCell) return 0;
    const aText = cellSortValue(aCell);
    const bText = cellSortValue(bCell);

    // Try numeric first
    const aNum = parseFloat(aText);
    const bNum = parseFloat(bText);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return dir === "asc" ? aNum - bNum : bNum - aNum;
    }

    // Fallback to locale string compare
    const cmp = aText.localeCompare(bText, undefined, { sensitivity: "base", numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });

  // Re-append in sorted order (moves DOM nodes without cloning)
  for (const row of rows) tbody.appendChild(row);
}

/**
 * Extract a clean sort key from a table cell. Strips badges, buttons,
 * and prefers the text of the first <strong>, <a>, or <code> if present.
 */
function cellSortValue(td) {
  // Try the first meaningful element
  const primary = td.querySelector("strong, a, code");
  if (primary) return primary.textContent.trim().toLowerCase();
  return td.textContent.trim().toLowerCase();
}
