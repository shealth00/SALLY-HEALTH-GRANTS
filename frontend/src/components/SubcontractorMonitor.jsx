import React, { useEffect, useState } from "react";

const API_BASE =
  process.env.REACT_APP_API_BASE || "http://localhost:5001";

function formatAmount(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(amount));
}

function SubcontractorMonitor() {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    setError("");
    setLoading(true);
    try {
      const [opportunitiesRes, statusRes] = await Promise.all([
        fetch(`${API_BASE}/api/govspending/opportunities`),
        fetch(`${API_BASE}/api/govspending/status`),
      ]);

      if (!opportunitiesRes.ok) {
        throw new Error(
          "No opportunity snapshot yet. Refresh the USAspending monitor."
        );
      }

      const opportunitiesJson = await opportunitiesRes.json();
      const statusJson = statusRes.ok ? await statusRes.json() : null;
      setSnapshot(opportunitiesJson);
      setStatus(statusJson);
    } catch (err) {
      setSnapshot(null);
      setStatus(null);
      setError(err instanceof Error ? err.message : "Failed to load monitor");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/govspending/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error("Monitor refresh failed");
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="mx-auto my-8 w-11/12 max-w-5xl rounded border border-green-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-green-800">
            Subcontractor Opportunity Monitor
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Tracks Sally Health–relevant federal subawards and primes from{" "}
            <a
              className="underline"
              href="https://www.usaspending.gov/"
              target="_blank"
              rel="noreferrer"
            >
              USAspending.gov
            </a>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="rounded bg-green-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh monitor"}
        </button>
      </div>

      {loading && <p className="text-gray-600">Loading opportunities…</p>}
      {error && <p className="text-red-600">{error}</p>}

      {status?.admin && status.admin.overall !== "healthy" && (
        <div
          className={`mb-4 rounded border p-3 text-sm ${
            status.admin.overall === "degraded"
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          <p className="font-semibold">
            Admin status: {status.admin.overall}
            {status.admin.productionAlertsSuppressed
              ? " · production alerts suppressed"
              : ""}
          </p>
          {status.admin.actionRequired && (
            <p className="mt-1">{status.admin.actionRequired}</p>
          )}
          {(status.admin.degradedStreak > 0 ||
            status.admin.firstDegradedAt ||
            status.admin.lastLiveSuccessAt) && (
            <p className="mt-1">
              {status.admin.degradedStreak > 0
                ? `Degraded streak: ${status.admin.degradedStreak}`
                : null}
              {status.admin.degradedStreak > 0 && status.admin.firstDegradedAt
                ? " · "
                : ""}
              {status.admin.firstDegradedAt
                ? `Outage since: ${new Date(
                    status.admin.firstDegradedAt
                  ).toLocaleString()}${
                    status.admin.ops?.outageAgeHours != null
                      ? ` (~${status.admin.ops.outageAgeHours}h)`
                      : ""
                  }`
                : null}
              {(status.admin.degradedStreak > 0 || status.admin.firstDegradedAt) &&
              status.admin.lastLiveSuccessAt
                ? " · "
                : ""}
              {status.admin.lastLiveSuccessAt
                ? `Last live success: ${new Date(
                    status.admin.lastLiveSuccessAt
                  ).toLocaleString()}`
                : null}
            </p>
          )}
          {status.admin.egressBlocked &&
            Array.isArray(status.admin.requiredEgressDomains) &&
            status.admin.requiredEgressDomains.length > 0 && (
              <p className="mt-1">
                Required egress: {status.admin.requiredEgressDomains.join(", ")}
              </p>
            )}
          {status.admin.ops?.priority && (
            <p className="mt-1">
              Ops priority: {status.admin.ops.priority}
              {status.admin.ops.blockedOn
                ? ` · blocked on: ${status.admin.ops.blockedOn}`
                : ""}
              {status.admin.ops.extendedOutage
                ? " · extended outage"
                : ""}
              {status.admin.ops.backwardClockSkew
                ? " · VM clock behind prior run (age estimated from streak)"
                : ""}
              {status.admin.ops.clockCorrected
                ? ` · clock corrected (${status.admin.ops.clockSource || "override"})`
                : ""}
              {status.admin.ops.cadenceGapHours != null
                ? ` · cadence gap: ~${status.admin.ops.cadenceGapHours}h`
                : ""}
              {status.admin.ops.acceptOpportunityDeltas === false
                ? " · do not act on fixture opportunity deltas"
                : ""}
            </p>
          )}
          {Array.isArray(status.admin.ops?.nextChecks) &&
            status.admin.ops.nextChecks.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {status.admin.ops.nextChecks.slice(0, 4).map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            )}
          {(status.admin.alerts || []).slice(0, 4).map((alert, index) => (
            <p key={`${alert.code}-${index}`} className="mt-1">
              [{alert.severity}] {alert.code}: {alert.message}
            </p>
          ))}
        </div>
      )}

      {snapshot && (
        <>
          {(status?.admin?.productionAlertsSuppressed ||
            snapshot.source?.mode === "fixtures-fallback" ||
            snapshot.source?.mode === "fixtures") && (
            <p className="mb-4 rounded border border-gray-300 bg-gray-50 p-3 text-sm text-gray-700">
              Showing sample/fixture opportunities for workflow continuity. Do not
              treat these rows as live USAspending alerts until source mode is{" "}
              <code>live</code> or <code>live-partial</code>.
            </p>
          )}

          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded bg-green-50 p-3">
              <p className="text-xs uppercase text-green-700">Total</p>
              <p className="text-xl font-semibold">{snapshot.summary.total}</p>
            </div>
            <div className="rounded bg-green-50 p-3">
              <p className="text-xs uppercase text-green-700">Subawards</p>
              <p className="text-xl font-semibold">{snapshot.summary.subawards}</p>
            </div>
            <div className="rounded bg-green-50 p-3">
              <p className="text-xs uppercase text-green-700">Prime awards</p>
              <p className="text-xl font-semibold">{snapshot.summary.primeAwards}</p>
            </div>
            <div className="rounded bg-green-50 p-3">
              <p className="text-xs uppercase text-green-700">New since last run</p>
              <p className="text-xl font-semibold">
                {status?.admin?.productionAlertsSuppressed
                  ? "—"
                  : status?.summary?.added ?? snapshot.summary.added}
              </p>
            </div>
          </div>

          <p className="mb-3 text-xs text-gray-500">
            Source mode: {status?.sourceMode || snapshot.source?.mode || "unknown"}
            {status?.ranAt ? ` · Last run: ${new Date(status.ranAt).toLocaleString()}` : ""}
            {(status?.window || snapshot.source?.window)
              ? ` · Window: ${(status?.window || snapshot.source.window).startDate} → ${(status?.window || snapshot.source.window).endDate}`
              : ""}
          </p>

          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-gray-700">
                  <th className="px-2 py-2">Kind</th>
                  <th className="px-2 py-2">Recipient</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Agency</th>
                  <th className="px-2 py-2">Focus</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.opportunities || []).map((item) => (
                  <tr key={item.opportunityId} className="border-b align-top">
                    <td className="px-2 py-2 capitalize">{item.kind.replace("_", " ")}</td>
                    <td className="px-2 py-2">
                      <a
                        className="font-medium text-green-800 underline"
                        href={item.portalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.recipientName || "Unknown"}
                      </a>
                      {item.primeRecipientName && (
                        <div className="text-xs text-gray-500">
                          Prime: {item.primeRecipientName}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2">{formatAmount(item.amount)}</td>
                    <td className="px-2 py-2">{item.date || "n/a"}</td>
                    <td className="px-2 py-2">{item.awardingAgency || "n/a"}</td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(item.relevanceTags || []).slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default SubcontractorMonitor;
