/**
 * Normalize heterogeneous USAspending award/subaward rows into a stable shape.
 */

/**
 * @param {object} row
 * @param {object} meta
 * @param {string} meta.queryId
 * @param {string} meta.queryLabel
 * @param {boolean} meta.subawards
 * @param {string} meta.portalBase
 */
export function normalizeOpportunity(row, meta) {
  const isSub = Boolean(meta.subawards);
  const amount = Number(
    isSub ? row["Sub-Award Amount"] : row["Award Amount"]
  );
  const awardId = isSub
    ? row["Sub-Award ID"] || row["Prime Award ID"]
    : row["Award ID"];
  const generatedId = isSub
    ? row.prime_award_generated_internal_id
    : row.generated_internal_id;

  const idParts = [
    meta.queryId,
    isSub ? "sub" : "prime",
    awardId || "unknown",
    row["Sub-Awardee Name"] || row["Recipient Name"] || "",
    row["Sub-Award Date"] || row["Start Date"] || "",
  ];

  const opportunityId = idParts
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const portalUrl = generatedId
    ? `${meta.portalBase.replace(/\/$/, "")}/award/${encodeURIComponent(generatedId)}`
    : meta.portalBase;

  return {
    opportunityId,
    kind: isSub ? "subaward" : "prime_award",
    queryId: meta.queryId,
    queryLabel: meta.queryLabel,
    awardId: awardId || null,
    primeAwardId: isSub ? row["Prime Award ID"] || null : awardId || null,
    generatedInternalId: generatedId || null,
    recipientName: isSub
      ? row["Sub-Awardee Name"] || null
      : row["Recipient Name"] || null,
    primeRecipientName: isSub ? row["Prime Recipient Name"] || null : null,
    recipientUei: isSub
      ? row["Sub-Recipient UEI"] || null
      : row["Recipient UEI"] || null,
    amount: Number.isFinite(amount) ? amount : null,
    date: isSub
      ? row["Sub-Award Date"] || null
      : row["Start Date"] || null,
    endDate: isSub ? null : row["End Date"] || null,
    description: isSub
      ? row["Sub-Award Description"] || null
      : row["Description"] || null,
    awardingAgency: row["Awarding Agency"] || null,
    awardingSubAgency: row["Awarding Sub Agency"] || null,
    naics: row.NAICS || row["NAICS"] || null,
    awardType:
      row["Sub-Award Type"] ||
      row["Award Type"] ||
      row["Contract Award Type"] ||
      null,
    portalUrl,
    relevanceTags: buildRelevanceTags(row, meta),
  };
}

function buildRelevanceTags(row, meta) {
  const tags = [meta.queryId];
  if (meta.subawards) tags.push("subcontractor-lane");
  else tags.push("prime-lane");

  const text = [
    row["Sub-Award Description"],
    row.Description,
    row["Sub-Awardee Name"],
    row["Recipient Name"],
    row["Prime Recipient Name"],
    row.NAICS,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const keywordHints = [
    ["wound", "wound-care"],
    ["chronic", "chronic-care"],
    ["remote patient", "rpm"],
    ["telehealth", "telehealth"],
    ["home health", "home-health"],
    ["care management", "care-management"],
    ["monitoring", "monitoring"],
  ];

  for (const [needle, tag] of keywordHints) {
    if (text.includes(needle)) tags.push(tag);
  }

  return [...new Set(tags)];
}

/**
 * @param {object[]} opportunities
 */
export function dedupeOpportunities(opportunities) {
  const map = new Map();
  for (const item of opportunities) {
    if (!map.has(item.opportunityId)) {
      map.set(item.opportunityId, item);
    }
  }
  return [...map.values()].sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    if (da !== db) return db.localeCompare(da);
    return (b.amount || 0) - (a.amount || 0);
  });
}
