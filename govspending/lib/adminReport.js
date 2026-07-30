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

/** Wall-clock outage age (hours) before elevating prolonged egress to P0. */
export const EXTENDED_OUTAGE_HOURS_THRESHOLD = 12;

/** Consecutive degraded runs before elevating prolonged egress to P0. */
export const EXTENDED_OUTAGE_STREAK_THRESHOLD = 12;

/** Gap (hours) between runs before flagging missed hourly cadence. */
export const MISSED_CADENCE_HOURS_THRESHOLD = 2.5;

/** Healthy hourly cadence upper bound used when validating outage markers. */
const HEALTHY_CADENCE_HOURS = 2.5;

/**
 * Re-runs inside this window do not increment degradedStreak (same hourly
 * slot / manual re-check), so admin streak tracks distinct hourly failures.
 */
export const SAME_HOUR_RERUN_HOURS = 0.75;

/** Reject outage markers older than this (likely bad clock / stale restore). */
const ABSURD_OUTAGE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Advance one hourly slot when local VM clock is behind prior ranAt. */
const HOURLY_SLOT_MS = 60 * 60 * 1000;

/**
 * Resolve the wall-clock used for lookback windows and ranAt.
 * Cloud agent VMs can boot with clocks days behind trusted prior runs; when
 * that happens, prefer GOVSPENDING_NOW / MONITOR_NOW, else advance one hourly
 * slot from the previous last-run so search windows keep progressing.
 *
 * @param {object} [input]
 * @param {Date|string|number|null} [input.now] Explicit override (tests / CLI)
 * @param {string|null|undefined} [input.previousRanAt]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {Date|string|number|null} [input.localNow] Injectable local clock
 * @returns {{ now: Date, source: "explicit"|"env"|"previous-ran-at-plus-hour"|"local", clockCorrected: boolean }}
 */
export function resolveEffectiveNow({
  now = null,
  previousRanAt = null,
  env = process.env,
  localNow = null,
} = {}) {
  if (now != null) {
    const explicit = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (!Number.isNaN(explicit.getTime())) {
      return { now: explicit, source: "explicit", clockCorrected: false };
    }
  }

  const envRaw = env?.GOVSPENDING_NOW || env?.MONITOR_NOW;
  if (envRaw) {
    const envMs = Date.parse(envRaw);
    if (Number.isFinite(envMs)) {
      return {
        now: new Date(envMs),
        source: "env",
        clockCorrected: true,
      };
    }
  }

  const local =
    localNow instanceof Date
      ? new Date(localNow.getTime())
      : localNow != null
        ? new Date(localNow)
        : new Date();
  const prevMs = previousRanAt ? Date.parse(previousRanAt) : NaN;
  if (Number.isFinite(prevMs) && local.getTime() < prevMs) {
    return {
      now: new Date(prevMs + HOURLY_SLOT_MS),
      source: "previous-ran-at-plus-hour",
      clockCorrected: true,
    };
  }

  return { now: local, source: "local", clockCorrected: false };
}

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

  const ranMs = Date.parse(ranAt);
  const prevMs = previousRanAt ? Date.parse(previousRanAt) : NaN;
  // Cloud agent VMs can boot with clocks behind prior run timestamps.
  const backwardClockSkew =
    Number.isFinite(ranMs) && Number.isFinite(prevMs) && ranMs < prevMs;

  let cadenceGapHours = null;
  if (Number.isFinite(prevMs) && Number.isFinite(ranMs) && ranMs >= prevMs) {
    cadenceGapHours = (ranMs - prevMs) / (60 * 60 * 1000);
  }

  const sameHourRerun =
    overall === "degraded" &&
    previousAdmin?.overall === "degraded" &&
    cadenceGapHours != null &&
    cadenceGapHours < SAME_HOUR_RERUN_HOURS;

  const degradedStreak =
    overall === "degraded"
      ? sameHourRerun
        ? priorStreak
        : priorStreak + 1
      : 0;

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
    const priorStartMs = previousAdmin?.firstDegradedAt
      ? Date.parse(previousAdmin.firstDegradedAt)
      : NaN;
    // Keep prior marker when age fits the streak. When hourly runs were
    // missed (large cadence gap), allow wall-clock growth up to an absurd
    // cap so outage age is not understated. With healthy cadence, still
    // reject clock-skewed (too old) or reset (too young) markers.
    const healthyCadence =
      cadenceGapHours == null || cadenceGapHours <= HEALTHY_CADENCE_HOURS;
    const streakMaxAgeMs = Math.max(priorStreak + 1, 1) * 3 * 60 * 60 * 1000;
    const maxAgeMs = healthyCadence ? streakMaxAgeMs : ABSURD_OUTAGE_AGE_MS;
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
    } else if (
      backwardClockSkew &&
      previousAdmin?.overall === "degraded" &&
      previousAdmin?.firstDegradedAt &&
      Number.isFinite(priorStartMs)
    ) {
      // Keep the established outage marker when this VM clock is behind the
      // previous run (otherwise age collapses to a fresh local estimate).
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

  return {
    degradedStreak,
    lastLiveSuccessAt,
    firstDegradedAt,
    cadenceGapHours,
    backwardClockSkew,
  };
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
 * @param {number|null} [input.cadenceGapHours]
 * @param {boolean} [input.backwardClockSkew]
 * @param {number} [input.prolongedDegradedThreshold]
 * @param {number} [input.extendedOutageHoursThreshold]
 * @param {number} [input.extendedOutageStreakThreshold]
 * @param {number} [input.missedCadenceHoursThreshold]
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
  cadenceGapHours = null,
  backwardClockSkew = false,
  prolongedDegradedThreshold = PROLONGED_DEGRADED_THRESHOLD,
  extendedOutageHoursThreshold = EXTENDED_OUTAGE_HOURS_THRESHOLD,
  extendedOutageStreakThreshold = EXTENDED_OUTAGE_STREAK_THRESHOLD,
  missedCadenceHoursThreshold = MISSED_CADENCE_HOURS_THRESHOLD,
}) {
  const alerts = [];
  const failedQueries = queryReports.filter((q) => q.error);
  const outageAgeHours = (() => {
    if (!firstDegradedAt || !ranAt) return null;
    const startMs = Date.parse(firstDegradedAt);
    const endMs = Date.parse(ranAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    if (endMs >= startMs) {
      return Math.round((endMs - startMs) / (60 * 60 * 1000));
    }
    // Backward VM clock: firstDegradedAt is ahead of local ranAt. Prefer a
    // streak-based age so P0 wall-clock escalation is not understated.
    if (degradedStreak > 0) {
      return Math.max(degradedStreak - 1, 0);
    }
    return null;
  })();
  const roundedCadenceGapHours =
    cadenceGapHours == null || !Number.isFinite(cadenceGapHours)
      ? null
      : Math.round(cadenceGapHours * 10) / 10;

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
    roundedCadenceGapHours != null &&
    roundedCadenceGapHours > missedCadenceHoursThreshold
  ) {
    alerts.push({
      severity: "warning",
      code: "MISSED_HOURLY_CADENCE",
      message: `Hourly monitor cadence gap is ~${roundedCadenceGapHours}h (threshold ${missedCadenceHoursThreshold}h). Confirm the grants automation schedule is healthy.`,
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

  const extendedOutage =
    sourceMode === "fixtures-fallback" &&
    ((outageAgeHours != null && outageAgeHours >= extendedOutageHoursThreshold) ||
      degradedStreak >= extendedOutageStreakThreshold);

  if (extendedOutage) {
    const agePart =
      outageAgeHours != null ? `~${outageAgeHours}h wall-clock` : "unknown age";
    alerts.push({
      severity: "critical",
      code: "EXTENDED_OUTAGE",
      message: `Live USAspending monitoring outage is extended (${agePart}, streak=${degradedStreak}). Admin must restore egress/API reachability before opportunity alerts can resume.`,
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
    if (extendedOutage && egressBlocked) {
      actionRequired = `P0: Live USAspending monitoring outage extended (${outageAgeHours != null ? `~${outageAgeHours}h` : `${degradedStreak} runs`}). Add api.usaspending.gov and www.usaspending.gov to the Cursor cloud egress allowlist (environment/team Network access), then re-run node govspending/monitor.js --admin and confirm sourceMode is live or live-partial.`;
    } else if (prolonged && egressBlocked) {
      actionRequired = `P1: Live USAspending monitoring degraded for ${degradedStreak} consecutive run(s). Add api.usaspending.gov and www.usaspending.gov to the Cursor cloud egress allowlist (environment/team network policy), then re-run node govspending/monitor.js --admin and confirm sourceMode is live or live-partial.`;
    } else if (egressBlocked) {
      actionRequired =
        "Allow cloud egress to api.usaspending.gov and www.usaspending.gov, then re-run the monitor in live mode.";
    } else if (extendedOutage) {
      actionRequired = `P0: Live USAspending monitoring outage extended (${outageAgeHours != null ? `~${outageAgeHours}h` : `${degradedStreak} runs`}). Restore API reachability, then re-run the monitor in live mode.`;
    } else if (prolonged) {
      actionRequired = `P1: Live USAspending monitoring degraded for ${degradedStreak} consecutive run(s). Restore API reachability, then re-run the monitor in live mode.`;
    } else {
      actionRequired =
        "Restore USAspending API reachability, then re-run the monitor in live mode.";
    }
  } else if (overall === "attention") {
    if (
      alerts.some((a) => a.code === "MISSED_HOURLY_CADENCE") &&
      !alerts.some((a) => a.code === "PARTIAL_LIVE_QUERY_FAILURE") &&
      !alerts.some((a) => a.code === "PRESERVED_LIVE_SNAPSHOT")
    ) {
      actionRequired =
        "Hourly monitor cadence slipped. Confirm the grants automation schedule is healthy.";
    } else {
      actionRequired =
        "Review failed query lanes and confirm opportunity deltas before acting.";
    }
  }

  const productionAlertsSuppressed =
    sourceMode === "fixtures-fallback" ||
    alerts.some((a) => a.code === "PRODUCTION_ALERTS_SUPPRESSED");

  const priority =
    overall === "degraded"
      ? extendedOutage
        ? "P0"
        : prolonged
          ? "P1"
          : "P2"
      : overall === "attention"
        ? "P3"
        : "P4";

  /** Machine-readable ops checklist for admin / automation consumers. */
  const ops = {
    priority,
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
    cadenceGapHours: roundedCadenceGapHours,
    backwardClockSkew: Boolean(backwardClockSkew),
    extendedOutage,
    nextChecks: [
      ...(extendedOutage
        ? [
            "P0: escalate to environment admin — allowlist api.usaspending.gov and www.usaspending.gov in Cursor Cloud Network access (team/environment policy)",
          ]
        : []),
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
      ...(roundedCadenceGapHours != null &&
      roundedCadenceGapHours > missedCadenceHoursThreshold
        ? [
            "Verify Cursor automation cron for grants workflow is firing hourly",
            "Inspect prior cloud-agent runs for crashes or skipped hours",
          ]
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
