/**
 * Diff opportunity snapshots for the hourly workflow monitor.
 */

/**
 * @param {object[]} previous
 * @param {object[]} current
 */
export function diffOpportunities(previous = [], current = []) {
  const prevIds = new Set(previous.map((o) => o.opportunityId));
  const currIds = new Set(current.map((o) => o.opportunityId));

  const added = current.filter((o) => !prevIds.has(o.opportunityId));
  const removed = previous.filter((o) => !currIds.has(o.opportunityId));

  const previousById = new Map(previous.map((o) => [o.opportunityId, o]));
  const changed = [];

  for (const item of current) {
    const prior = previousById.get(item.opportunityId);
    if (!prior) continue;
    if (
      prior.amount !== item.amount ||
      prior.date !== item.date ||
      prior.description !== item.description ||
      prior.recipientName !== item.recipientName
    ) {
      changed.push({
        opportunityId: item.opportunityId,
        before: prior,
        after: item,
      });
    }
  }

  return {
    added,
    removed,
    changed,
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

/**
 * @param {Date} [now]
 * @param {number} lookbackDays
 */
export function computeWindow(now = new Date(), lookbackDays = 90) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - lookbackDays);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}
