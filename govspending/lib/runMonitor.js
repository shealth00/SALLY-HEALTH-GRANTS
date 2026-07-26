import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UsaSpendingClient,
  buildSearchRequest,
} from "./usaspendingClient.js";
import { normalizeOpportunity, dedupeOpportunities } from "./normalize.js";
import { computeWindow, diffOpportunities } from "./diff.js";
import { buildAdminReport } from "./adminReport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GOVSPENDING_ROOT = path.resolve(__dirname, "..");

/**
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {boolean} [options.useFixtures]
 * @param {boolean} [options.write]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Date} [options.now]
 */
export async function runMonitor(options = {}) {
  const rootDir = options.rootDir || GOVSPENDING_ROOT;
  const configPath = path.join(rootDir, "config.json");
  const dataDir = path.join(rootDir, "data");
  const opportunitiesPath = path.join(dataDir, "opportunities.json");
  const lastRunPath = path.join(dataDir, "last-run.json");
  const fixturesPath = path.join(rootDir, "fixtures", "sample-response.json");

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const window = computeWindow(options.now || new Date(), config.lookbackDays);

  let previous = { opportunities: [], generatedAt: null, source: {} };
  try {
    previous = JSON.parse(await readFile(opportunitiesPath, "utf8"));
  } catch {
    previous = { opportunities: [], generatedAt: null, source: {} };
  }

  const client = new UsaSpendingClient({
    apiBase: config.source.apiBase,
    awardSearchPath: config.source.awardSearchPath,
    fetchImpl: options.fetchImpl,
  });

  const queryReports = [];
  const collected = [];
  let sourceMode = options.useFixtures ? "fixtures" : "live";
  let liveError = null;
  let preservedLiveSnapshot = false;

  if (!options.useFixtures) {
    let liveSuccesses = 0;
    let liveFailures = 0;
    const liveErrors = [];

    for (const query of config.queries) {
      try {
        const body = buildSearchRequest(config, query, window);
        const payload = await client.searchSpendingByAward(body);
        const rows = Array.isArray(payload.results) ? payload.results : [];
        queryReports.push({
          queryId: query.id,
          label: query.label,
          count: rows.length,
          mode: "live",
        });
        liveSuccesses += 1;
        for (const row of rows) {
          collected.push(
            normalizeOpportunity(row, {
              queryId: query.id,
              queryLabel: query.label,
              subawards: query.subawards,
              portalBase: config.source.portalBase,
            })
          );
        }
      } catch (error) {
        liveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        liveErrors.push(`${query.id}: ${message}`);
        queryReports.push({
          queryId: query.id,
          label: query.label,
          count: 0,
          mode: "live-failed",
          error: message,
        });
      }
    }

    if (liveSuccesses === 0) {
      sourceMode = "fixtures-fallback";
      liveError = liveErrors.join("; ") || "USAspending live API unreachable";
    } else if (liveFailures > 0) {
      sourceMode = "live-partial";
      liveError = liveErrors.join("; ");
    } else {
      sourceMode = "live";
    }
  }

  // Keep live failure details for admin even if we later load fixtures.
  const adminQueryReports = queryReports.map((q) => ({ ...q }));

  if (sourceMode === "fixtures" || sourceMode === "fixtures-fallback") {
    const previousWasLive =
      previous?.source?.mode === "live" ||
      previous?.source?.mode === "live-partial";

    if (sourceMode === "fixtures-fallback" && previousWasLive) {
      // Admin safeguard: never replace a live snapshot with fixtures.
      preservedLiveSnapshot = true;
      const generatedAt = (options.now || new Date()).toISOString();
      const admin = buildAdminReport({
        sourceMode,
        liveError,
        queryReports: adminQueryReports,
        summary: previous.summary || {
          total: (previous.opportunities || []).length,
          subawards: 0,
          primeAwards: 0,
          added: 0,
          removed: 0,
          changed: 0,
        },
        preservedLiveSnapshot,
      });

      const lastRun = {
        ranAt: generatedAt,
        sourceMode,
        liveError,
        window,
        summary: {
          total: (previous.opportunities || []).length,
          subawards: (previous.opportunities || []).filter(
            (o) => o.kind === "subaward"
          ).length,
          primeAwards: (previous.opportunities || []).filter(
            (o) => o.kind === "prime_award"
          ).length,
          added: 0,
          removed: 0,
          changed: 0,
        },
        newOpportunityIds: [],
        removedOpportunityIds: [],
        hasChanges: false,
        preservedLiveSnapshot: true,
        admin,
      };

      if (options.write !== false) {
        await mkdir(dataDir, { recursive: true });
        await writeFile(lastRunPath, `${JSON.stringify(lastRun, null, 2)}\n`);
      }

      return {
        snapshot: previous,
        lastRun,
        diff: { added: [], removed: [], changed: [], hasChanges: false },
        paths: { opportunitiesPath, lastRunPath },
      };
    }

    const fixtures = JSON.parse(await readFile(fixturesPath, "utf8"));
    collected.length = 0;
    queryReports.length = 0;

    for (const query of config.queries) {
      const payload = fixtures[query.id] || { results: [] };
      const rows = Array.isArray(payload.results) ? payload.results : [];
      const priorLive = adminQueryReports.find((q) => q.queryId === query.id);
      queryReports.push({
        queryId: query.id,
        label: query.label,
        count: rows.length,
        mode: sourceMode,
        ...(priorLive?.error ? { liveError: priorLive.error } : {}),
      });
      for (const row of rows) {
        collected.push(
          normalizeOpportunity(row, {
            queryId: query.id,
            queryLabel: query.label,
            subawards: query.subawards,
            portalBase: config.source.portalBase,
          })
        );
      }
    }
  }

  const opportunities = dedupeOpportunities(collected);
  const diff = diffOpportunities(previous.opportunities || [], opportunities);
  const generatedAt = (options.now || new Date()).toISOString();

  const snapshot = {
    generatedAt,
    organization: config.organization,
    source: {
      name: config.source.name,
      note:
        "Official federal spending portal is USAspending.gov (govspending.gov does not resolve).",
      mode: sourceMode,
      window,
      liveError,
    },
    summary: {
      total: opportunities.length,
      subawards: opportunities.filter((o) => o.kind === "subaward").length,
      primeAwards: opportunities.filter((o) => o.kind === "prime_award").length,
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
    },
    queries: queryReports,
    opportunities,
  };

  const admin = buildAdminReport({
    sourceMode,
    liveError,
    queryReports:
      sourceMode === "fixtures-fallback" ? adminQueryReports : queryReports,
    summary: snapshot.summary,
    preservedLiveSnapshot,
  });

  const lastRun = {
    ranAt: generatedAt,
    sourceMode,
    liveError,
    window,
    summary: snapshot.summary,
    newOpportunityIds: diff.added.map((o) => o.opportunityId),
    removedOpportunityIds: diff.removed.map((o) => o.opportunityId),
    hasChanges: diff.hasChanges,
    preservedLiveSnapshot,
    admin,
  };

  if (options.write !== false) {
    await mkdir(dataDir, { recursive: true });
    // Admin: avoid churning opportunities.json on no-delta fixture fallbacks.
    const writeOpportunities =
      sourceMode !== "fixtures-fallback" || diff.hasChanges;
    if (writeOpportunities) {
      await writeFile(
        opportunitiesPath,
        `${JSON.stringify(snapshot, null, 2)}\n`
      );
    }
    await writeFile(lastRunPath, `${JSON.stringify(lastRun, null, 2)}\n`);
  }

  return {
    snapshot,
    lastRun,
    diff,
    paths: { opportunitiesPath, lastRunPath },
  };
}
