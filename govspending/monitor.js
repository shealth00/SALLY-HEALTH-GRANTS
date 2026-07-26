#!/usr/bin/env node
/**
 * Hourly workflow monitor for Sally Health subcontractor opportunities
 * sourced from USAspending.gov.
 *
 * Usage:
 *   node govspending/monitor.js
 *   node govspending/monitor.js --fixtures
 *   node govspending/monitor.js --dry-run
 *   node govspending/monitor.js --admin
 */

import { runMonitor } from "./lib/runMonitor.js";

function parseArgs(argv) {
  return {
    useFixtures: argv.includes("--fixtures"),
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
    admin: argv.includes("--admin"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runMonitor({
    useFixtures: args.useFixtures,
    write: !args.dryRun,
  });

  if (args.json) {
    console.log(JSON.stringify(result.lastRun, null, 2));
    return;
  }

  const summary = result.lastRun.summary || result.snapshot.summary || {};
  const window = result.lastRun.window || result.snapshot.source?.window;
  const sourceMode = result.lastRun.sourceMode || result.snapshot.source?.mode;
  const liveError =
    result.lastRun.liveError || result.snapshot.source?.liveError;

  console.log("USAspending subcontractor workflow monitor");
  console.log(`Mode: ${sourceMode}`);
  if (liveError) {
    console.log(`Live API error: ${liveError}`);
  }
  if (window?.startDate && window?.endDate) {
    console.log(`Window: ${window.startDate} → ${window.endDate}`);
  }
  console.log(
    `Opportunities: ${summary.total ?? 0} (subawards=${summary.subawards ?? 0}, primes=${summary.primeAwards ?? 0})`
  );
  console.log(
    `Delta: +${summary.added ?? 0} / -${summary.removed ?? 0} / ~${summary.changed ?? 0}`
  );

  if (result.lastRun.preservedLiveSnapshot) {
    console.log(
      "Admin safeguard: preserved previous live opportunities snapshot (fixtures not written)."
    );
  }

  if (args.admin || result.lastRun.admin) {
    const admin = result.lastRun.admin;
    console.log("\nAdmin oversight");
    console.log(`Overall: ${admin.overall}`);
    if (admin.degradedStreak != null) {
      console.log(`Degraded streak: ${admin.degradedStreak}`);
    }
    if (admin.lastLiveSuccessAt) {
      console.log(`Last live success: ${admin.lastLiveSuccessAt}`);
    }
    if (admin.actionRequired) {
      console.log(`Action required: ${admin.actionRequired}`);
    }
    if (
      admin.egressBlocked &&
      Array.isArray(admin.requiredEgressDomains) &&
      admin.requiredEgressDomains.length
    ) {
      console.log(
        `Required egress: ${admin.requiredEgressDomains.join(", ")}`
      );
    }
    if (admin.ops) {
      console.log(
        `Ops: priority=${admin.ops.priority}` +
          (admin.ops.blockedOn ? ` blockedOn=${admin.ops.blockedOn}` : "") +
          (admin.ops.acceptOpportunityDeltas
            ? " acceptDeltas=yes"
            : " acceptDeltas=no")
      );
      for (const check of admin.ops.nextChecks || []) {
        console.log(`  · ${check}`);
      }
    }
    for (const alert of admin.alerts) {
      console.log(`- [${alert.severity}] ${alert.code}: ${alert.message}`);
    }
  }

  if (result.diff.added.length) {
    console.log("\nNew opportunities:");
    for (const item of result.diff.added.slice(0, 10)) {
      console.log(
        `- [${item.kind}] ${item.recipientName || "Unknown"} | $${item.amount ?? "n/a"} | ${item.awardId || "n/a"}`
      );
    }
  }

  if (!args.dryRun) {
    if (result.wroteOpportunities) {
      console.log(`\nWrote ${result.paths.opportunitiesPath}`);
    } else {
      console.log("\nSkipped opportunities.json write (no-delta fixture fallback).");
    }
    if (result.wroteLastRun) {
      console.log(`Wrote ${result.paths.lastRunPath}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
