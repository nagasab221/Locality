// Metadata match scoring. The regression that motivated these: a movie named
// "Obsession 2026" wouldn't match because TMDB's year-filtered search returned
// a non-empty set of wrong-title candidates from that year, nothing cleared
// the confidence bar, and there was no second pass. pickBestMatch returning
// null on such sets is what triggers the caller's unfiltered retry.
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickBestMatch } = require("../dist/test/lib.cjs");

const m = (title, year, popularity = 0) => ({ title, year, popularity });

test("exact title + exact year is picked", () => {
  const best = pickBestMatch([m("Obsession", 2026), m("Fixation", 2026)], "Obsession", 2026);
  assert.equal(best.title, "Obsession");
});

test("same-year wrong-title candidates pick nothing (drives the retry)", () => {
  // What a year-filtered TMDB search can return via AKA/original-title hits:
  // right year, no visible title correspondence. Year + popularity alone must
  // not clear the bar, else we'd tag a random film from that year.
  const best = pickBestMatch([m("Skyline Heist", 2026, 20), m("Paper Crowns", 2026, 15)], "Obsession", 2026);
  assert.equal(best, null);
});

test("on an unfiltered pass the year ranks: 2026 beats the 1976 classic", () => {
  const best = pickBestMatch(
    [m("Obsession", 1976, 50), m("Obsession", 2026, 5), m("Obsessions", 2010, 10)],
    "Obsession",
    2026
  );
  assert.equal(best.year, 2026);
});

test("a year off by one still matches (festival vs wide release dates)", () => {
  const best = pickBestMatch([m("Obsession", 2025, 5), m("Mania", 2026, 90)], "Obsession", 2026);
  assert.equal(best.title, "Obsession");
});

test("no parsed year: popularity breaks the tie between exact titles", () => {
  const best = pickBestMatch([m("Obsession", 1976, 50), m("Obsession", 2015, 4)], "Obsession", null);
  assert.equal(best.year, 1976);
});

test("empty input picks nothing", () => {
  assert.equal(pickBestMatch([], "Obsession", 2026), null);
});
