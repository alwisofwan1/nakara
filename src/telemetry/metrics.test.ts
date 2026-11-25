import assert from "node:assert/strict";
import { test } from "node:test";

import { Counter, Histogram, Metrics } from "./metrics.ts";

test("counters render in the Prometheus text format with escaped, sorted labels", () => {
  const c = new Counter("t_total", "Help.");
  assert.equal(
    c.render(),
    "# HELP t_total Help.\n# TYPE t_total counter\nt_total 0",
  );
  c.inc({ z: "1", a: 'say "hi"\\\n' });
  c.inc({ a: 'say "hi"\\\n', z: "1" }, 2);
  c.inc({ a: "x" }, 0);
  assert.equal(
    c.render().split("\n")[2],
    't_total{a="say \\"hi\\"\\\\\\n",z="1"} 3',
  );
});

test("histograms count each observation in every bucket at or above it", () => {
  const h = new Histogram("t_seconds", "Help.", [1, 10]);
  h.observe({ agent: "a" }, 0.5);
  h.observe({ agent: "a" }, 5);
  h.observe({ agent: "a" }, 50);
  assert.deepEqual(h.render().split("\n").slice(2), [
    't_seconds_bucket{agent="a",le="1"} 1',
    't_seconds_bucket{agent="a",le="10"} 2',
    't_seconds_bucket{agent="a",le="+Inf"} 3',
    't_seconds_sum{agent="a"} 55.5',
    't_seconds_count{agent="a"} 3',
  ]);
});

test("the exposition ends with a newline and declares every metric once", () => {
  const text = new Metrics().render();
  assert.ok(text.endsWith("\n"));
  const types = text.match(/^# TYPE \S+/gm) ?? [];
  assert.equal(new Set(types).size, types.length);
  assert.equal(types.length, 8);
});
