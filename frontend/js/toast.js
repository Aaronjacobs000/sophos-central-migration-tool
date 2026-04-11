// Minimal toast helper. Queues into #toast-stack if present, otherwise
// lazily creates the container.

function ensureStack() {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message, variant = "info", timeoutMs = 4000) {
  const stack = ensureStack();
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-fade");
    setTimeout(() => el.remove(), 400);
  }, timeoutMs);
}
