// Colour themes. The actual palettes live as CSS variables in index.css
// (:root = default "warm", each :root[data-theme] block overrides it). Here we
// keep the picker's metadata + a few preview swatch colours that mirror those
// palettes, plus the tiny apply/persist helpers.
//
// Theme is a per-device preference: it's stored in localStorage, not synced to
// the cloud account, so an OLED laptop and a desktop can each keep their own.

export interface Theme {
  id: string;
  name: string;
  hint: string;
  // Swatch colours for the preview card (hex mirrors of the CSS palette).
  bg: string;
  surface: string;
  accent: string;
  text: string;
}

export const THEMES: Theme[] = [
  { id: "warm", name: "Classic", hint: "Tan & gold (default)", bg: "#0D0D0D", surface: "#1B1815", accent: "#C4A47C", text: "#E9E1D2" },
  { id: "midnight", name: "Midnight", hint: "Deep blue", bg: "#090C14", surface: "#141B2B", accent: "#5C94E8", text: "#CDD6E6" },
  { id: "amethyst", name: "Amethyst", hint: "Purple & magenta", bg: "#100A16", surface: "#21162C", accent: "#C660D2", text: "#E0D2E8" },
  { id: "burgundy", name: "Burgundy", hint: "Wine red", bg: "#160A0C", surface: "#2C1519", accent: "#C84E5C", text: "#E8D4D5" },
  { id: "oled", name: "OLED", hint: "Pure black", bg: "#000000", surface: "#121214", accent: "#E0E2E8", text: "#D6D8E0" },
  { id: "emerald", name: "Emerald", hint: "Forest green", bg: "#08100D", surface: "#13211C", accent: "#3EBE82", text: "#D0E2D8" },
  { id: "graphite", name: "Graphite", hint: "Neutral slate", bg: "#0F1012", surface: "#1E2024", accent: "#4FB6B0", text: "#D2D6DC" },
  { id: "paper", name: "Paper", hint: "Warm light", bg: "#EEEAE3", surface: "#FAF7F2", accent: "#B68E56", text: "#40382E" },
  { id: "frost", name: "Frost", hint: "Cool light", bg: "#EBEFF5", surface: "#F7FAFD", accent: "#2169CC", text: "#2E3A4A" },
];

const KEY = "locality.theme";
const DEFAULT = "warm";

const isKnown = (id: string | null): id is string => !!id && THEMES.some((t) => t.id === id);

export function getTheme(): string {
  try {
    const id = localStorage.getItem(KEY);
    return isKnown(id) ? id : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function applyTheme(id: string) {
  const theme = isKnown(id) ? id : DEFAULT;
  // "warm" is the :root default, so it needs no attribute (and none of the
  // data-theme blocks match) — remove it to fall back cleanly.
  if (theme === DEFAULT) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
}
