#!/usr/bin/env node
/**
 * Hourly workflow monitor for Sally Health subcontractor opportunities
 * sourced from USAspending.gov.
 *
 * Usage:
 *   node govspending/monitor.js
 *   node govspending/monitor.js --fixtures
 *   node govspending/monitor.js --dry-run
 */

import { runMonitor } from "./lib/runMonitor.js";

function parseArgs(argv) {
  return {
    useFixtures: argv.includes("--fixtures"),
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
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

  if (result.diff.added.length) {
    console.log("\nNew opportunities:");
    for (const item of result.diff.added.slice(0, 10)) {
      console.log(
        `- [${item.kind}] ${item.recipientName || "Unknown"} | $${item.amount ?? "n/a"} | ${item.awardId || "n/a"}`
      );
    }
  }

  if (!args.dryRun) {
    console.log(`\nWrote ${result.paths.opportunitiesPath}`);
    console.log(`Wrote ${result.paths.lastRunPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
