// Filename parsing is where scan bugs have historically hidden (anime absolute
// numbering, version suffixes, specials, season-in-title, marker-at-index-0).
// These lock in the behaviour so a regex tweak can't silently regress it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMediaPath, normalizeTitle, fingerprintFile } = require("../dist/test/lib.cjs");

const tv = (p) => parseMediaPath(p, "tv");
const movie = (p) => parseMediaPath(p, "movies");

test("movies: title and year from a release name", () => {
  const r = movie("Inception (2010)/Inception.2010.1080p.BluRay.x264.mkv");
  assert.equal(r.kind, "movie");
  assert.equal(r.title, "Inception");
  assert.equal(r.year, 2010);
  assert.ok(r.confidence >= 0.8, `expected confident match, got ${r.confidence}`);
});

test("movies: no year still parses a title, with lower confidence", () => {
  const r = movie("The Big Lebowski.mkv");
  assert.equal(r.kind, "movie");
  assert.equal(r.title, "The Big Lebowski");
  assert.equal(r.year, null);
});

test("tv: standard SxxExx", () => {
  const r = tv("Breaking Bad/Season 1/Breaking Bad - S01E02 - Cat's in the Bag.mkv");
  assert.equal(r.kind, "episode");
  assert.equal(r.title, "Breaking Bad");
  assert.equal(r.season, 1);
  assert.equal(r.episode, 2);
});

test("tv: episode marker at index 0 falls back to the show folder for the title", () => {
  // Regression: an empty title used to slip through as a per-episode "show".
  const r = tv("Severance/Season 1/S01E02 - Half Loop.mkv");
  assert.equal(r.kind, "episode");
  assert.equal(r.title, "Severance");
  assert.equal(r.season, 1);
  assert.equal(r.episode, 2);
});

test("tv: release-revision suffix (v2) does not break the episode number", () => {
  const r = tv("Some Show/Some Show - S01E01v2.mkv");
  assert.equal(r.season, 1);
  assert.equal(r.episode, 1);
});

test("tv: specials map to season 0", () => {
  const r = tv("Some Show/Some Show - S01SP1.mkv");
  assert.equal(r.kind, "episode");
  assert.equal(r.season, 0);
});

test("tv: anime absolute numbering with a release group", () => {
  const r = tv("Frieren/[SubsPlease] Frieren - 28 (1080p).mkv");
  assert.equal(r.kind, "episode");
  assert.equal(r.episode, 28);
  assert.equal(r.title, "Frieren");
});

test("tv: season carried in the title itself", () => {
  const r = tv("Vinland Saga/Vinland Saga S2 - 11.mkv");
  assert.equal(r.kind, "episode");
  assert.equal(r.title, "Vinland Saga");
  assert.equal(r.season, 2);
  assert.equal(r.episode, 11);
});

test("tv: folder layout with a bare episode number", () => {
  const r = tv("Show Name/Season 3/01 - Pilot.mkv");
  assert.equal(r.kind, "episode");
  assert.equal(r.title, "Show Name");
  assert.equal(r.season, 3);
  assert.equal(r.episode, 1);
});

test("normalizeTitle folds case, ampersands and punctuation", () => {
  assert.equal(normalizeTitle("Tom & Jerry: The Movie!"), normalizeTitle("tom and jerry the movie"));
});

test("fingerprint is path-independent but size-sensitive", () => {
  const a = fingerprintFile("F:/Movies/Inception.mkv", 1234);
  const b = fingerprintFile("/mnt/media/INCEPTION.MKV", 1234);
  const c = fingerprintFile("F:/Movies/Inception.mkv", 1235);
  assert.equal(a, b, "same filename+size on another machine must match");
  assert.notEqual(a, c, "a different size must not match");
  assert.match(a, /^fp_[0-9a-f]{20}$/);
});

test("fingerprint matches the Android implementation's recipe", () => {
  // The phone recomputes this independently (Repo.fingerprintOf); if the two
  // ever diverge, cross-device watch progress silently stops merging.
  const crypto = require("node:crypto");
  const expected =
    "fp_" + crypto.createHash("sha1").update("inception.mkv|1234").digest("hex").slice(0, 20);
  assert.equal(fingerprintFile("F:/Movies/Inception.mkv", 1234), expected);
});
