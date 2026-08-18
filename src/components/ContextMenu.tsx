import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MenuEntry {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Lightweight right-click menu. Renders at the cursor (clamped to the
 * viewport), closes on any click, Escape, scroll or another context menu.
 */
export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Delay so the opening right-click doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("keydown", onKey);
      window.addEventListener("resize", close);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const W = 208;
  const estH = entries.length * 34 + 12;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - estH - 8);

  // Portal to <body>: position:fixed inside an animated/transformed ancestor
  // resolves against that ancestor, not the viewport — the menu drifted.
  return createPortal(
    <div
      ref={ref}
      className="modal-in fixed z-50 w-52 py-1.5 rounded-lg bg-raised border border-cardborder shadow-2xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((m) => (
        <button
          key={m.label}
          disabled={m.disabled}
          onClick={() => {
            onClose();
            m.onClick();
          }}
          className={`w-full text-left px-3.5 py-1.5 text-sm transition-colors disabled:opacity-40 ${
            m.danger ? "text-danger hover:bg-danger/10" : "text-body hover:bg-hov hover:text-heading"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
