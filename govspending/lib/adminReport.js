/**
 * Admin-level health report for the govspending subcontractor workflow.
 */

/**
 * @param {object} input
 * @param {string} input.sourceMode
 * @param {string|null} input.liveError
 * @param {object[]} input.queryReports
 * @param {object} input.summary
 * @param {boolean} [input.preservedLiveSnapshot]
 */
export function buildAdminReport({
  sourceMode,
  liveError,
  queryReports = [],
  summary,
  preservedLiveSnapshot = false,
}) {
  const alerts = [];
  const failedQueries = queryReports.filter((q) => q.error);

  if (sourceMode === "fixtures-fallback") {
    alerts.push({
      severity: "critical",
      code: "LIVE_API_UNAVAILABLE",
      message:
        liveError ||
        "USAspending live API unreachable; using fixture fallback. Do not treat results as production alerts.",
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
      ? "Restore egress to api.usaspending.gov / www.usaspending.gov, then re-run the monitor in live mode."
      : overall === "attention"
        ? "Review failed query lanes and confirm opportunity deltas before acting."
        : null;

  return {
    overall,
    actionRequired,
    alerts,
    liveQuerySuccessCount: queryReports.filter((q) => q.mode === "live").length,
    liveQueryFailureCount: failedQueries.length,
  };
}
