import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSearchRequest,
  classifyUsaSpendingFetchError,
} from "../lib/usaspendingClient.js";
import { normalizeOpportunity, dedupeOpportunities } from "../lib/normalize.js";
import { diffOpportunities, computeWindow } from "../lib/diff.js";
import {
  buildAdminReport,
  computeContinuity,
  isEgressLikeFailure,
  PROLONGED_DEGRADED_THRESHOLD,
  EXTENDED_OUTAGE_HOURS_THRESHOLD,
  EXTENDED_OUTAGE_STREAK_THRESHOLD,
} from "../lib/adminReport.js";
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
      throw new Error("fetch failed");
    };

    const result = await runMonitor({
      rootDir: tempDir,
      fetchImpl: failingFetch,
      now: new Date("2026-07-26T14:00:00.000Z"),
    });

    assert.equal(result.snapshot.source.mode, "fixtures-fallback");
    assert.match(result.snapshot.source.liveError, /network\/egress failure/);
    assert.ok(result.snapshot.opportunities.length >= 1);
    assert.equal(result.lastRun.admin.overall, "degraded");
    assert.ok(
      result.lastRun.admin.alerts.some((a) => a.code === "EGRESS_BLOCKED")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runMonitor keeps successful lanes when one live query fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "govspending-"));
  try {
    await cp(path.join(GOVSPENDING_ROOT, "config.json"), path.join(tempDir, "config.json"));
    await cp(
      path.join(GOVSPENDING_ROOT, "fixtures"),
      path.join(tempDir, "fixtures"),
      { recursive: true }
    );

    let calls = 0;
    const partialFetch = async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error("lane timeout");
      }
      return {
        ok: true,
        async json() {
          return {
            results: [
              {
                "Award ID": `LIVE-${calls}`,
                "Recipient Name": `Live Recipient ${calls}`,
                "Award Amount": 75000,
                "Start Date": "2026-06-15",
                "Description": "telehealth chronic care",
                "Awarding Agency": "Department of Health and Human Services",
                generated_internal_id: `CONT_AWD_LIVE_${calls}`,
              },
            ],
          };
        },
      };
    };

    const result = await runMonitor({
      rootDir: tempDir,
      fetchImpl: partialFetch,
      now: new Date("2026-07-26T14:00:00.000Z"),
    });

    assert.equal(result.snapshot.source.mode, "live-partial");
    assert.equal(result.lastRun.admin.overall, "attention");
    assert.ok(result.snapshot.opportunities.length >= 1);
    assert.ok(
      result.snapshot.queries.some((q) => q.mode === "live-failed")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fixtures-fallback preserves previous live snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "govspending-"));
  try {
    await cp(path.join(GOVSPENDING_ROOT, "config.json"), path.join(tempDir, "config.json"));
    await cp(
      path.join(GOVSPENDING_ROOT, "fixtures"),
      path.join(tempDir, "fixtures"),
      { recursive: true }
    );

    const dataDir = path.join(tempDir, "data");
    await mkdir(dataDir, { recursive: true });
    const liveSnapshot = {
      generatedAt: "2026-07-26T10:00:00.000Z",
      organization: "Sally Health",
      source: { mode: "live", liveError: null },
      summary: {
        total: 1,
        subawards: 0,
        primeAwards: 1,
        added: 0,
        removed: 0,
        changed: 0,
      },
      opportunities: [
        {
          opportunityId: "live|prime|keep-me",
          kind: "prime_award",
          recipientName: "Keep Me LLC",
          amount: 100000,
        },
      ],
    };
    await writeFile(
      path.join(dataDir, "opportunities.json"),
      `${JSON.stringify(liveSnapshot, null, 2)}\n`
    );

    const result = await runMonitor({
      rootDir: tempDir,
      fetchImpl: async () => {
        throw new Error("egress blocked");
      },
      now: new Date("2026-07-26T15:00:00.000Z"),
    });

    assert.equal(result.lastRun.sourceMode, "fixtures-fallback");
    assert.equal(result.lastRun.preservedLiveSnapshot, true);
    assert.equal(result.snapshot.opportunities[0].opportunityId, "live|prime|keep-me");
    assert.equal(result.lastRun.hasChanges, false);

    const written = JSON.parse(
      await readFile(path.join(dataDir, "opportunities.json"), "utf8")
    );
    assert.equal(written.source.mode, "live");
    assert.equal(written.opportunities[0].recipientName, "Keep Me LLC");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildAdminReport marks fixture fallback as degraded", () => {
  const report = buildAdminReport({
    sourceMode: "fixtures-fallback",
    liveError: "fetch failed",
    queryReports: [],
    summary: { added: 0 },
  });
  assert.equal(report.overall, "degraded");
  assert.equal(report.egressBlocked, true);
  assert.equal(report.productionAlertsSuppressed, true);
  assert.deepEqual(report.requiredEgressDomains, [
    "api.usaspending.gov",
    "www.usaspending.gov",
  ]);
  assert.ok(report.alerts.some((a) => a.code === "EGRESS_BLOCKED"));
  assert.ok(report.alerts.some((a) => a.code === "PRODUCTION_ALERTS_SUPPRESSED"));
  assert.match(report.actionRequired, /api\.usaspending\.gov/);
  assert.equal(report.ops.priority, "P2");
  assert.equal(report.ops.blockedOn, "cloud-egress-allowlist");
  assert.equal(report.ops.acceptOpportunityDeltas, false);
  assert.ok(report.ops.nextChecks.some((c) => /allowlist/i.test(c)));
});

test("buildAdminReport suppresses production alerts for non-egress live failures", () => {
  const report = buildAdminReport({
    sourceMode: "fixtures-fallback",
    liveError: "USAspending API 503: service unavailable",
    queryReports: [
      {
        queryId: "health-subawards",
        mode: "live-failed",
        error: "USAspending API 503: service unavailable",
      },
    ],
    summary: { added: 2 },
  });
  assert.equal(report.overall, "degraded");
  assert.equal(report.egressBlocked, false);
  assert.equal(report.productionAlertsSuppressed, true);
  assert.ok(report.alerts.some((a) => a.code === "LIVE_API_UNAVAILABLE"));
  assert.ok(report.alerts.some((a) => a.code === "PRODUCTION_ALERTS_SUPPRESSED"));
  assert.ok(!report.alerts.some((a) => a.code === "NEW_OPPORTUNITIES"));
});

test("classifyUsaSpendingFetchError labels timeouts and egress failures", () => {
  const timeout = classifyUsaSpendingFetchError(
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    12000
  );
  assert.match(timeout.message, /timed out after 12000ms/);

  const egress = classifyUsaSpendingFetchError(new Error("fetch failed"));
  assert.match(egress.message, /network\/egress failure/);
  assert.equal(isEgressLikeFailure(egress.message), true);
});

test("computeContinuity increments degraded streak and tracks last live success", () => {
  const first = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T16:00:00.000Z",
    previousAdmin: null,
  });
  assert.equal(first.degradedStreak, 1);
  assert.equal(first.lastLiveSuccessAt, null);
  assert.equal(first.firstDegradedAt, "2026-07-26T16:00:00.000Z");

  const legacy = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T16:30:00.000Z",
    previousAdmin: { overall: "degraded" },
    previousRanAt: "2026-07-26T15:30:00.000Z",
    previousSourceMode: "fixtures-fallback",
  });
  assert.equal(legacy.degradedStreak, PROLONGED_DEGRADED_THRESHOLD + 1);
  // Legacy files lack firstDegradedAt; estimate from hourly streak.
  assert.equal(legacy.firstDegradedAt, "2026-07-26T13:30:00.000Z");

  const missedCadence = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T21:00:00.000Z",
    previousAdmin: {
      degradedStreak: 7,
      firstDegradedAt: "2026-07-24T20:09:34.894Z",
    },
    previousRanAt: "2026-07-24T20:09:34.894Z",
  });
  assert.equal(missedCadence.degradedStreak, 8);
  // Large cadence gap: keep wall-clock outage start (do not understate age).
  assert.equal(missedCadence.firstDegradedAt, "2026-07-24T20:09:34.894Z");
  assert.ok(missedCadence.cadenceGapHours > 2.5);

  const skewedHealthyCadence = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T21:00:00.000Z",
    previousAdmin: {
      degradedStreak: 7,
      firstDegradedAt: "2026-07-24T20:09:34.894Z",
    },
    previousRanAt: "2026-07-26T20:00:00.000Z",
  });
  assert.equal(skewedHealthyCadence.degradedStreak, 8);
  // Healthy hourly cadence + impossible age → reject clock-skewed marker.
  assert.equal(skewedHealthyCadence.firstDegradedAt, "2026-07-26T14:00:00.000Z");

  const tooYoung = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T21:03:18.000Z",
    previousAdmin: {
      degradedStreak: 9,
      firstDegradedAt: "2026-07-26T21:02:45.721Z",
    },
    previousRanAt: "2026-07-26T21:02:45.721Z",
  });
  assert.equal(tooYoung.degradedStreak, 10);
  // Reject reset/young marker that cannot explain a long streak.
  assert.equal(tooYoung.firstDegradedAt, "2026-07-26T12:03:18.000Z");

  const second = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T17:00:00.000Z",
    previousAdmin: {
      degradedStreak: 2,
      lastLiveSuccessAt: "2026-07-26T10:00:00.000Z",
      firstDegradedAt: "2026-07-26T15:00:00.000Z",
    },
    previousRanAt: "2026-07-26T16:00:00.000Z",
  });
  assert.equal(second.degradedStreak, 3);
  assert.equal(second.lastLiveSuccessAt, "2026-07-26T10:00:00.000Z");
  assert.equal(second.firstDegradedAt, "2026-07-26T15:00:00.000Z");
  assert.equal(second.cadenceGapHours, 1);

  const sameHourRerun = computeContinuity({
    overall: "degraded",
    sourceMode: "fixtures-fallback",
    ranAt: "2026-07-26T21:10:00.000Z",
    previousAdmin: {
      overall: "degraded",
      degradedStreak: 11,
      firstDegradedAt: "2026-07-26T12:04:02.442Z",
    },
    previousRanAt: "2026-07-26T21:04:02.442Z",
    previousSourceMode: "fixtures-fallback",
  });
  assert.equal(sameHourRerun.degradedStreak, 11);
  assert.equal(sameHourRerun.firstDegradedAt, "2026-07-26T12:04:02.442Z");
  assert.ok(sameHourRerun.cadenceGapHours < 0.75);

  const recovered = computeContinuity({
    overall: "healthy",
    sourceMode: "live",
    ranAt: "2026-07-26T18:00:00.000Z",
    previousAdmin: {
      degradedStreak: 5,
      lastLiveSuccessAt: "2026-07-26T10:00:00.000Z",
      firstDegradedAt: "2026-07-26T15:00:00.000Z",
    },
  });
  assert.equal(recovered.degradedStreak, 0);
  assert.equal(recovered.lastLiveSuccessAt, "2026-07-26T18:00:00.000Z");
  assert.equal(recovered.firstDegradedAt, null);
});

test("buildAdminReport escalates prolonged degraded outages", () => {
  const report = buildAdminReport({
    sourceMode: "fixtures-fallback",
    liveError: "USAspending network/egress failure: fetch failed",
    queryReports: [],
    summary: { added: 0 },
    degradedStreak: PROLONGED_DEGRADED_THRESHOLD,
    lastLiveSuccessAt: "2026-07-26T10:00:00.000Z",
    firstDegradedAt: "2026-07-26T14:00:00.000Z",
    ranAt: "2026-07-26T17:00:00.000Z",
    cadenceGapHours: 1,
  });
  assert.equal(report.overall, "degraded");
  assert.equal(report.degradedStreak, PROLONGED_DEGRADED_THRESHOLD);
  assert.equal(report.lastLiveSuccessAt, "2026-07-26T10:00:00.000Z");
  assert.equal(report.firstDegradedAt, "2026-07-26T14:00:00.000Z");
  assert.equal(report.ops.outageStartedAt, "2026-07-26T14:00:00.000Z");
  assert.equal(report.ops.outageAgeHours, 3);
  assert.equal(report.ops.cadenceGapHours, 1);
  assert.equal(report.ops.extendedOutage, false);
  assert.ok(report.alerts.some((a) => a.code === "PROLONGED_DEGRADED"));
  assert.ok(!report.alerts.some((a) => a.code === "EXTENDED_OUTAGE"));
  assert.ok(!report.alerts.some((a) => a.code === "MISSED_HOURLY_CADENCE"));
  assert.match(
    report.alerts.find((a) => a.code === "PROLONGED_DEGRADED").message,
    /~3h since/
  );
  assert.equal(report.ops.priority, "P1");
  assert.equal(report.ops.blockedOn, "cloud-egress-allowlist");
  assert.match(report.actionRequired, /^P1:/);
  assert.match(report.actionRequired, /consecutive run/);
});

test("buildAdminReport escalates extended outages to P0 and flags missed cadence", () => {
  const report = buildAdminReport({
    sourceMode: "fixtures-fallback",
    liveError: "USAspending network/egress failure: fetch failed",
    queryReports: [],
    summary: { added: 0 },
    degradedStreak: EXTENDED_OUTAGE_STREAK_THRESHOLD,
    firstDegradedAt: "2026-07-26T08:00:00.000Z",
    ranAt: "2026-07-26T20:00:00.000Z",
    cadenceGapHours: 4,
  });
  assert.equal(report.ops.outageAgeHours, EXTENDED_OUTAGE_HOURS_THRESHOLD);
  assert.equal(report.ops.extendedOutage, true);
  assert.equal(report.ops.priority, "P0");
  assert.equal(report.ops.cadenceGapHours, 4);
  assert.ok(report.alerts.some((a) => a.code === "EXTENDED_OUTAGE"));
  assert.ok(report.alerts.some((a) => a.code === "MISSED_HOURLY_CADENCE"));
  assert.match(report.actionRequired, /^P0:/);
  assert.ok(
    report.ops.nextChecks.some((c) => /automation cron/i.test(c))
  );
});

test("fixtures-fallback with no delta only refreshes last-run heartbeat", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "govspending-"));
  try {
    await cp(path.join(GOVSPENDING_ROOT, "config.json"), path.join(tempDir, "config.json"));
    await cp(
      path.join(GOVSPENDING_ROOT, "fixtures"),
      path.join(tempDir, "fixtures"),
      { recursive: true }
    );

    await runMonitor({
      rootDir: tempDir,
      useFixtures: true,
      now: new Date("2026-07-26T14:00:00.000Z"),
    });

    const opportunitiesPath = path.join(tempDir, "data", "opportunities.json");
    const before = await readFile(opportunitiesPath, "utf8");

    const result = await runMonitor({
      rootDir: tempDir,
      fetchImpl: async () => {
        throw new Error("fetch failed");
      },
      now: new Date("2026-07-26T16:00:00.000Z"),
    });

    assert.equal(result.lastRun.sourceMode, "fixtures-fallback");
    assert.equal(result.lastRun.hasChanges, false);
    assert.equal(result.lastRun.admin.overall, "degraded");
    assert.ok(result.lastRun.admin.alerts.some((a) => a.code === "EGRESS_BLOCKED"));
    assert.equal(result.lastRun.admin.firstDegradedAt, "2026-07-26T16:00:00.000Z");

    const after = await readFile(opportunitiesPath, "utf8");
    assert.equal(after, before);

    const lastRun = JSON.parse(
      await readFile(path.join(tempDir, "data", "last-run.json"), "utf8")
    );
    assert.equal(lastRun.ranAt, "2026-07-26T16:00:00.000Z");
    assert.equal(lastRun.admin.firstDegradedAt, "2026-07-26T16:00:00.000Z");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
