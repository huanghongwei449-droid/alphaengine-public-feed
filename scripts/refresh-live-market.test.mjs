import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveMarketPayload, collectMarketSummary } from "./refresh-live-market.mjs";

function page(diff, total) {
  return { data: { total, diff } };
}

test("partial rows remain usable and expose coverage instead of nulling market", async () => {
  const calls = [];
  const result = await collectMarketSummary({
    page: async (params) => {
      calls.push(params.pn);
      return params.pn === "1"
        ? page([
          { f12: "000001", f3: "1", f6: "100000000", f62: "1000000" },
          { f12: "000002", f3: "-1", f6: "200000000", f62: "-1000000" },
        ], 3)
        : page([{ f12: "000003", f3: "2", f6: "200000000", f62: "2000000" }], 3);
    },
    sleepFn: async () => {},
  });
  assert.deepEqual(calls, ["1"]);
  assert.equal(result.complete, false);
  assert.equal(result.rows, 2);
  assert.equal(result.total, 3);
  assert.equal(result.coverage.usableRows, 2);
  assert.equal(result.coverage.missingRows, 1);
  assert.equal(result.coverage.coverageRatio, 0.6667);
  assert.equal(result.coverage.pagination.expectedPages, 1);
});

test("pagination cap is reported and cannot be marked complete", async () => {
  const result = await collectMarketSummary({
    maxPages: 1,
    page: async () => page([{ f12: "000001", f3: "1", f6: "100000000", f62: "1000000" }], 401),
    sleepFn: async () => {},
  });
  assert.equal(result.complete, false);
  assert.equal(result.coverage.pagination.capped, true);
  assert.equal(result.coverage.pagination.expectedPages, 3);
  assert.equal(result.coverage.pagination.fetchedPages, 1);
});

test("a later page HTTP failure is recorded as a gap", async () => {
  const result = await collectMarketSummary({
    page: async (params) => {
      if (params.pn === "1") return page([{ f12: "000001", f3: "1", f6: "100000000", f62: "1000000" }], 201);
      throw new Error("eastmoney HTTP 502");
    },
    sleepFn: async () => {},
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverage.pagination.pagesWithErrors, [2]);
  assert.match(result.coverage.pageErrors[0].error, /502/);
});

test("partial market status keeps usable snapshot and coverage in the payload", async () => {
  const payload = await buildLiveMarketPayload({
    quoteFn: async (symbol) => ({ code: symbol, asOfDate: "2026-08-27", price: 100, change: 1, changePct: 1, source: "test" }),
    page: async () => page([
      { f12: "000001", f3: "1", f6: "100000000", f62: "1000000" },
      { f12: "000002", f3: "-1", f62: "-1000000" },
    ], 3),
    boardFn: async () => [],
    sleepFn: async () => {},
    now: () => new Date("2026-08-27T03:30:00Z"),
  });
  assert.equal(payload.sourceStatus.market.status, "partial");
  assert.ok(payload.market);
  assert.equal(payload.market.coverage.total, 3);
  assert.equal(payload.market.coverage.usableRows, 1);
  assert.equal(payload.market.coverage.missingRows, 2);
  assert.equal(payload.market.complete, false);
});
