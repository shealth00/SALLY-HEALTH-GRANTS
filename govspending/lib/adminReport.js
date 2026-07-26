/**
 * Admin-level health report for the govspending subcontractor workflow.
 */

/** Domains the hourly monitor needs on the cloud egress allowlist for live mode. */
export const REQUIRED_EGRESS_DOMAINS = [
  "api.usaspending.gov",
  "www.usaspending.gov",
];

/**
 * @param {string|null|undefined} liveError
 */
export function isEgressLikeFailure(liveError) {
  if (!liveError) return false;
  return /network\/egress|fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|egress blocked|Connection reset/i.test(
    liveError
  );
}

/** Consecutive degraded hourly runs before escalating admin attention. */
export const PROLONGED_DEGRADED_THRESHOLD = 3;

/**
 * Compute consecutive degraded-run streak and last known live success.
 * @param {string} overall
 * @param {string} sourceMode
 * @param {string} ranAt
 * @param {object|null|undefined} previousAdmin
 * @param {string|null|undefined} previousRanAt
 * @param {string|null|undefined} previousSourceMode
 */
export function computeContinuity({
  overall,
  sourceMode,
  ranAt,
  previousAdmin = null,
  previousRanAt = null,
  previousSourceMode = null,
}) {
  let priorStreak = Number(previousAdmin?.degradedStreak);
  // Legacy last-run files predate degradedStreak; if they were already
  // degraded/fallback, treat that as a prolonged outage so admin escalates.
  if (!Number.isFinite(priorStreak) || priorStreak < 0) {
    priorStreak =
      previousAdmin?.overall === "degraded" ||
      previousSourceMode === "fixtures-fallback"
        ? PROLONGED_DEGRADED_THRESHOLD
        : 0;
  }

  const degradedStreak = overall === "degraded" ? priorStreak + 1 : 0;

  let lastLiveSuccessAt = previousAdmin?.lastLiveSuccessAt || null;
  if (sourceMode === "live" || sourceMode === "live-partial") {
    lastLiveSuccessAt = ranAt;
  } else if (
    !lastLiveSuccessAt &&
    (previousSourceMode === "live" || previousSourceMode === "live-partial") &&
    previousRanAt
  ) {
    lastLiveSuccessAt = previousRanAt;
  }

  let firstDegradedAt = null;
  if (overall === "degraded") {
    const ranMs = Date.parse(ranAt);
    const priorStartMs = previousAdmin?.firstDegradedAt
      ? Date.parse(previousAdmin.firstDegradedAt)
      : NaN;
    // Keep prior marker only when age is consistent with hourly streak.
    // Reject clock-skewed (too old) or reset (too young) markers.
    const maxAgeMs = Math.max(priorStreak + 1, 1) * 3 * 60 * 60 * 1000;
    const minAgeMs =
      priorStreak > 1
        ? Math.max(priorStreak - 1, 0) * 0.5 * 60 * 60 * 1000
        : 0;
    const priorAgeOk =
      Number.isFinite(priorStartMs) &&
      Number.isFinite(ranMs) &&
      priorStartMs <= ranMs &&
      ranMs - priorStartMs <= maxAgeMs &&
      ranMs - priorStartMs >= minAgeMs;

    if (priorAgeOk) {
      firstDegradedAt = previousAdmin.firstDegradedAt;
    } else if (priorStreak > 0 && Number.isFinite(ranMs)) {
      // Legacy / skewed: estimate outage start from hourly cadence.
      firstDegradedAt = new Date(
        ranMs - priorStreak * 60 * 60 * 1000
      ).toISOString();
    } else {
      firstDegradedAt = ranAt;
    }
  }

  return { degradedStreak, lastLiveSuccessAt, firstDegradedAt };
}

/**
 * @param {object} input
 * @param {string} input.sourceMode
 * @param {string|null} input.liveError
 * @param {object[]} input.queryReports
 * @param {object} input.summary
 * @param {boolean} [input.preservedLiveSnapshot]
 * @param {number} [input.degradedStreak]
 * @param {string|null} [input.lastLiveSuccessAt]
 * @param {string|null} [input.firstDegradedAt]
 * @param {string|null} [input.ranAt]
 * @param {number} [input.prolongedDegradedThreshold]
 */
export function buildAdminReport({
  sourceMode,
  liveError,
  queryReports = [],
  summary,
  preservedLiveSnapshot = false,
  degradedStreak = 0,
  lastLiveSuccessAt = null,
  firstDegradedAt = null,
  ranAt = null,
  prolongedDegradedThreshold = PROLONGED_DEGRADED_THRESHOLD,
}) {
  const alerts = [];
  const failedQueries = queryReports.filter((q) => q.error);
  const outageAgeHours = (() => {
    if (!firstDegradedAt || !ranAt) return null;
    const ms = Date.parse(ranAt) - Date.parse(firstDegradedAt);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.round(ms / (60 * 60 * 1000));
  })();

  if (sourceMode === "fixtures-fallback") {
    const egressBlocked = isEgressLikeFailure(liveError);
    alerts.push({
      severity: "critical",
      code: egressBlocked ? "EGRESS_BLOCKED" : "LIVE_API_UNAVAILABLE",
      message:
        liveError ||
        "USAspending live API unreachable; using fixture fallback. Do not treat results as production alerts.",
    });
    // Always suppress production opportunity actions on fixture fallback,
    // whether the live failure was egress or another API/runtime issue.
    alerts.push({
      severity: "critical",
      code: "PRODUCTION_ALERTS_SUPPRESSED",
      message:
        "Fixture-fallback results are not production opportunity alerts. Wait for live or live-partial sourceMode.",
    });
  }

  if (sourceMode === "live-partial") {
    alerts.push({
      severity: "warning",
      code: "PARTIAL_LIVE_QUERY_FAILURE",
      message: `${failedQueries.length} query lane(s) failed; continuing with successful live lanes.`,
      details: failedQueries.map((q) => ({
        queryId: q.queryId,
        error: q.error,
      })),
    });
  }

  if (sourceMode === "fixtures") {
    alerts.push({
      severity: "info",
      code: "FIXTURES_MODE",
      message: "Monitor ran in explicit fixtures mode (offline/CI).",
    });
  }

  if (preservedLiveSnapshot) {
    alerts.push({
      severity: "warning",
      code: "PRESERVED_LIVE_SNAPSHOT",
      message:
        "Fixture fallback did not overwrite a previous live opportunities snapshot.",
    });
  }

  if (
    degradedStreak >= prolongedDegradedThreshold &&
    sourceMode === "fixtures-fallback"
  ) {
    const agePart =
      outageAgeHours != null
        ? ` (~${outageAgeHours}h since ${firstDegradedAt})`
        : firstDegradedAt
          ? ` (since ${firstDegradedAt})`
          : "";
    alerts.push({
      severity: "critical",
      code: "PROLONGED_DEGRADED",
      message: `Live USAspending monitoring has been degraded for ${degradedStreak} consecutive run(s)${agePart}. Production opportunity alerts remain suppressed until live reachability is restored.`,
    });
  }

  if (summary?.added > 0 && (sourceMode === "live" || sourceMode === "live-partial")) {
    alerts.push({
      severity: "info",
      code: "NEW_OPPORTUNITIES",
      message: `${summary.added} new Sally Health–relevant opportunity(ies) detected.`,
    });
  }

  const severities = alerts.map((a) => a.severity);
  let overall = "healthy";
  if (severities.includes("critical")) overall = "degraded";
  else if (severities.includes("warning")) overall = "attention";

  const prolonged =
    degradedStreak >= prolongedDegradedThreshold &&
    sourceMode === "fixtures-fallback";
  const egressBlocked = isEgressLikeFailure(liveError);

  let actionRequired = null;
  if (overall === "degraded") {
    if (prolonged && egressBlocked) {
      actionRequired = `P1: Live USAspending monitoring degraded for ${degradedStreak} consecutive run(s). Add api.usaspending.gov and www.usaspending.gov to the Cursor cloud egress allowlist (environment/team network policy), then re-run node govspending/monitor.js --admin and confirm sourceMode is live or live-partial.`;
    } else if (egressBlocked) {
      actionRequired =
        "Allow cloud egress to api.usaspending.gov and www.usaspending.gov, then re-run the monitor in live mode.";
    } else if (prolonged) {
      actionRequired = `P1: Live USAspending monitoring degraded for ${degradedStreak} consecutive run(s). Restore API reachability, then re-run the monitor in live mode.`;
    } else {
      actionRequired =
        "Restore USAspending API reachability, then re-run the monitor in live mode.";
    }
  } else if (overall === "attention") {
    actionRequired =
      "Review failed query lanes and confirm opportunity deltas before acting.";
  }

  const productionAlertsSuppressed =
    sourceMode === "fixtures-fallback" ||
    alerts.some((a) => a.code === "PRODUCTION_ALERTS_SUPPRESSED");

  /** Machine-readable ops checklist for admin / automation consumers. */
  const ops = {
    priority:
      overall === "degraded" ? (prolonged ? "P1" : "P2") : overall === "attention" ? "P3" : "P4",
    blockedOn: egressBlocked
      ? "cloud-egress-allowlist"
      : sourceMode === "fixtures-fallback"
        ? "usaspending-api-reachability"
        : null,
    requiredDomains: [...REQUIRED_EGRESS_DOMAINS],
    suppressProductionAlerts: productionAlertsSuppressed,
    acceptOpportunityDeltas:
      !productionAlertsSuppressed &&
      (sourceMode === "live" || sourceMode === "live-partial"),
    outageStartedAt: firstDegradedAt,
    outageAgeHours,
    nextChecks: [
      ...(egressBlocked
        ? [
            "Add api.usaspending.gov and www.usaspending.gov to Cursor cloud agent network allowlist",
            "Re-run: node govspending/monitor.js --admin",
            "Confirm last-run.json sourceMode is live or live-partial and admin.overall is healthy/attention",
          ]
        : []),
      ...(sourceMode === "fixtures-fallback" && !egressBlocked
        ? [
            "Inspect liveError in last-run.json for non-egress API failures",
            "Re-run monitor after USAspending recovers",
          ]
        : []),
      ...(sourceMode === "live-partial"
        ? ["Inspect admin.alerts PARTIAL_LIVE_QUERY_FAILURE details", "Retry failed query lanes"]
        : []),
    ],
  };

  return {
    overall,
    actionRequired,
    alerts,
    liveQuerySuccessCount: queryReports.filter((q) => q.mode === "live").length,
    liveQueryFailureCount: failedQueries.length,
    egressBlocked,
    productionAlertsSuppressed,
    requiredEgressDomains: [...REQUIRED_EGRESS_DOMAINS],
    degradedStreak,
    lastLiveSuccessAt,
    firstDegradedAt,
    ops,
  };
}
