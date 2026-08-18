/** Locality theme tokens.
 *  Colours are driven by CSS variables (RGB channels) so the whole palette can
 *  be swapped at runtime from Settings > Appearance. The channels live in
 *  src/index.css: :root holds the default "Warm" theme, and each
 *  :root[data-theme="…"] block overrides them. rgb(var(--c-x) / <alpha-value>)
 *  keeps Tailwind's /opacity modifiers (bg-surface/50, text-body/90) working. */
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: c("--c-bg"),
        surface: c("--c-surface"),
        raised: c("--c-raised"),
        hov: c("--c-hov"),
        input: c("--c-input"),
        inborder: c("--c-inborder"),
        cardborder: c("--c-cardborder"),
        divider: c("--c-divider"),
        accent: c("--c-accent"),
        accenthov: c("--c-accenthov"),
        accenttext: c("--c-accenttext"),
        track: c("--c-track"),
        heading: c("--c-heading"),
        body: c("--c-body"),
        muted: c("--c-muted"),
        hint: c("--c-hint"),
        warn: c("--c-warn"),
        ok: c("--c-ok"),
        danger: c("--c-danger"),
      },
      fontFamily: {
        display: ['"Palatino Linotype"', "Palatino", "Georgia", "serif"],
        sans: ['"Segoe UI"', "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
