import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMonitor } from "../govspending/lib/runMonitor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../govspending/data");

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function createGovspendingRouter() {
  const router = Router();

  router.get("/opportunities", async (_req, res) => {
    const snapshot = await readJsonSafe(path.join(DATA_DIR, "opportunities.json"), null);
    if (!snapshot) {
      return res.status(404).json({
        error: "No opportunities snapshot yet. Run POST /api/govspending/refresh first.",
      });
    }
    res.json(snapshot);
  });

  router.get("/status", async (_req, res) => {
    const lastRun = await readJsonSafe(path.join(DATA_DIR, "last-run.json"), null);
    if (!lastRun) {
      return res.status(404).json({
        error: "Monitor has not run yet.",
      });
    }
    res.json({
      ...lastRun,
      admin: lastRun.admin || {
        overall: lastRun.sourceMode === "fixtures-fallback" ? "degraded" : "healthy",
        actionRequired:
          lastRun.sourceMode === "fixtures-fallback"
            ? "Restore egress to api.usaspending.gov, then re-run the monitor in live mode."
            : null,
        productionAlertsSuppressed: lastRun.sourceMode === "fixtures-fallback",
        egressBlocked: /network\/egress|fetch failed|ECONNRESET|ENOTFOUND/i.test(
          lastRun.liveError || ""
        ),
        alerts: [
          ...(lastRun.liveError
            ? [
                {
                  severity: "critical",
                  code: /network\/egress|fetch failed|ECONNRESET|ENOTFOUND/i.test(
                    lastRun.liveError
                  )
                    ? "EGRESS_BLOCKED"
                    : "LIVE_API_UNAVAILABLE",
                  message: lastRun.liveError,
                },
              ]
            : []),
          ...(lastRun.sourceMode === "fixtures-fallback"
            ? [
                {
                  severity: "critical",
                  code: "PRODUCTION_ALERTS_SUPPRESSED",
                  message:
                    "Fixture-fallback results are not production opportunity alerts. Wait for live or live-partial sourceMode.",
                },
              ]
            : []),
        ],
      },
    });
  });

  router.post("/refresh", async (req, res) => {
    try {
      const useFixtures = Boolean(req.body?.fixtures);
      const result = await runMonitor({ useFixtures });
      res.json({
        message: "Govspending monitor refresh complete.",
        sourceMode: result.snapshot.source.mode,
        summary: result.snapshot.summary,
        lastRun: result.lastRun,
      });
    } catch (error) {
      console.error("Govspending refresh failed:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Refresh failed",
      });
    }
  });

  return router;
}
