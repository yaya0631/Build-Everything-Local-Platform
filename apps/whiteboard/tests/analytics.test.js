import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { track } from "../src/analytics.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the page loads no external analytics", () => {
  const html = read("../index.html");
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//i);
});

test("track forwards named events with properties, and is a no-op without a sink", () => {
  const calls = [];
  globalThis.__everythingAnalytics = (...args) => calls.push(args);
  try {
    track("Board exported", { format: "pdf", scope: "board" });
    track("Board shared");
    assert.deepEqual(calls, [
      ["Board exported", { props: { format: "pdf", scope: "board" } }],
      ["Board shared", undefined],
    ]);
    delete globalThis.__everythingAnalytics;
    assert.doesNotThrow(() => track("Board created", { template: "blank" }));
    globalThis.__everythingAnalytics = () => {
      throw Error("blocked");
    };
    assert.doesNotThrow(() => track("Board created"));
  } finally {
    delete globalThis.__everythingAnalytics;
  }
});

test("the five value events are sent from where the value happens", () => {
  const main = read("../src/main.js"),
    facilitation = read("../src/facilitation/ui.js");
  assert.match(main, /track\("Board created", \{ template \}\)/);
  assert.match(main, /track\("Board shared"\)/);
  assert.match(main, /if \(created\) track\("Shared board joined"\)/);
  assert.match(main, /track\("Board exported", \{ format, scope \}\)/);
  assert.match(
    facilitation,
    /if \(started\) \{?\s*track\("Workshop activity started", \{ kind: "vote" \}\)/,
  );
  assert.match(
    facilitation,
    /if \(started\) \{?\s*track\("Workshop activity started", \{ kind: "poll" \}\)/,
  );
});
