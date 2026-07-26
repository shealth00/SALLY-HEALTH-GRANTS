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

  const { summary } = result.snapshot;
  console.log("USAspending subcontractor workflow monitor");
  console.log(`Mode: ${result.snapshot.source.mode}`);
  if (result.snapshot.source.liveError) {
    console.log(`Live API error: ${result.snapshot.source.liveError}`);
  }
  console.log(
    `Window: ${result.snapshot.source.window.startDate} → ${result.snapshot.source.window.endDate}`
  );
  console.log(
    `Opportunities: ${summary.total} (subawards=${summary.subawards}, primes=${summary.primeAwards})`
  );
  console.log(
    `Delta: +${summary.added} / -${summary.removed} / ~${summary.changed}`
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
    if (admin.actionRequired) {
      console.log(`Action required: ${admin.actionRequired}`);
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
