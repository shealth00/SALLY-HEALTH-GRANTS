import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSearchRequest } from "../lib/usaspendingClient.js";
import { normalizeOpportunity, dedupeOpportunities } from "../lib/normalize.js";
import { diffOpportunities, computeWindow } from "../lib/diff.js";
import { runMonitor, GOVSPENDING_ROOT } from "../lib/runMonitor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("computeWindow uses UTC lookback days", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");
  const window = computeWindow(now, 90);
  assert.equal(window.endDate, "2026-07-26");
  assert.equal(window.startDate, "2026-04-27");
});

test("buildSearchRequest includes keywords and agencies for subaward query", async () => {
  const config = JSON.parse(
    await readFile(path.join(GOVSPENDING_ROOT, "config.json"), "utf8")
  );
  const query = config.queries.find((q) => q.id === "health-subawards");
  const body = buildSearchRequest(config, query, {
    startDate: "2026-01-01",
    endDate: "2026-07-26",
  });

  assert.equal(body.subawards, true);
  assert.ok(body.filters.keywords.includes("wound care"));
  assert.ok(body.filters.agencies.length >= 1);
  assert.ok(body.fields.includes("Sub-Award ID"));
});

test("normalizeOpportunity tags wound-care relevance", () => {
  const opportunity = normalizeOpportunity(
    {
      "Sub-Award ID": "S1",
      "Sub-Award Amount": "1000",
      "Sub-Award Date": "2026-06-01",
      "Sub-Award Description": "Advanced wound care clinic support",
      "Sub-Awardee Name": "Example LLC",
      "Prime Award ID": "P1",
      "Prime Recipient Name": "Prime Co",
      "Awarding Agency": "Department of Veterans Affairs",
      prime_award_generated_internal_id: "CONT_AWD_P1",
    },
    {
      queryId: "health-subawards",
      queryLabel: "Health subawards",
      subawards: true,
      portalBase: "https://www.usaspending.gov",
    }
  );

  assert.equal(opportunity.kind, "subaward");
  assert.equal(opportunity.amount, 1000);
  assert.ok(opportunity.relevanceTags.includes("wound-care"));
  assert.match(opportunity.portalUrl, /\/award\//);
});

test("diffOpportunities detects adds and removals", () => {
  const previous = [{ opportunityId: "a", amount: 1, date: "2026-01-01" }];
  const current = [
    { opportunityId: "b", amount: 2, date: "2026-02-01" },
    { opportunityId: "a", amount: 3, date: "2026-01-01", description: "changed" },
  ];
  const diff = diffOpportunities(previous, current);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.hasChanges, true);
});

test("dedupeOpportunities keeps unique ids", () => {
  const items = dedupeOpportunities([
    { opportunityId: "x", date: "2026-01-02", amount: 1 },
    { opportunityId: "x", date: "2026-01-02", amount: 1 },
    { opportunityId: "y", date: "2026-01-03", amount: 5 },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].opportunityId, "y");
});

test("runMonitor fixtures mode writes snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "govspending-"));
  try {
    await cp(path.join(GOVSPENDING_ROOT, "config.json"), path.join(tempDir, "config.json"));
    await cp(
      path.join(GOVSPENDING_ROOT, "fixtures"),
      path.join(tempDir, "fixtures"),
      { recursive: true }
    );

    const result = await runMonitor({
      rootDir: tempDir,
      useFixtures: true,
      now: new Date("2026-07-26T14:00:00.000Z"),
    });

    assert.equal(result.snapshot.source.mode, "fixtures");
    assert.ok(result.snapshot.opportunities.length >= 3);
    assert.equal(result.lastRun.hasChanges, true);

    const written = JSON.parse(
      await readFile(path.join(tempDir, "data", "opportunities.json"), "utf8")
    );
    assert.equal(written.organization, "Sally Health");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runMonitor falls back to fixtures when live API fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "govspending-"));
  try {
    await cp(path.join(GOVSPENDING_ROOT, "config.json"), path.join(tempDir, "config.json"));
    await cp(
      path.join(GOVSPENDING_ROOT, "fixtures"),
      path.join(tempDir, "fixtures"),
      { recursive: true }
    );

    const failingFetch = async () => {
      throw new Error("network blocked");
    };

    const result = await runMonitor({
      rootDir: tempDir,
      fetchImpl: failingFetch,
      now: new Date("2026-07-26T14:00:00.000Z"),
    });

    assert.equal(result.snapshot.source.mode, "fixtures-fallback");
    assert.match(result.snapshot.source.liveError, /network blocked/);
    assert.ok(result.snapshot.opportunities.length >= 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
