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

  return { degradedStreak, lastLiveSuccessAt };
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
  prolongedDegradedThreshold = PROLONGED_DEGRADED_THRESHOLD,
}) {
  const alerts = [];
  const failedQueries = queryReports.filter((q) => q.error);

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
    alerts.push({
      severity: "critical",
      code: "PROLONGED_DEGRADED",
      message: `Live USAspending monitoring has been degraded for ${degradedStreak} consecutive run(s). Production opportunity alerts remain suppressed until live reachability is restored.`,
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

  const actionRequired =
    overall === "degraded"
      ? isEgressLikeFailure(liveError)
        ? "Allow cloud egress to api.usaspending.gov and www.usaspending.gov, then re-run the monitor in live mode."
        : "Restore USAspending API reachability, then re-run the monitor in live mode."
      : overall === "attention"
        ? "Review failed query lanes and confirm opportunity deltas before acting."
        : null;

  const productionAlertsSuppressed =
    sourceMode === "fixtures-fallback" ||
    alerts.some((a) => a.code === "PRODUCTION_ALERTS_SUPPRESSED");

  return {
    overall,
    actionRequired,
    alerts,
    liveQuerySuccessCount: queryReports.filter((q) => q.mode === "live").length,
    liveQueryFailureCount: failedQueries.length,
    egressBlocked: isEgressLikeFailure(liveError),
    productionAlertsSuppressed,
    requiredEgressDomains: [...REQUIRED_EGRESS_DOMAINS],
    degradedStreak,
    lastLiveSuccessAt,
  };
}
