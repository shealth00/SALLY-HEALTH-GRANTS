/**
 * Minimal USAspending.gov API client for award / subaward search.
 * Note: site is USAspending.gov (there is no govspending.gov).
 */

const DEFAULT_TIMEOUT_MS = 25000;

export class UsaSpendingClient {
  /**
   * @param {object} options
   * @param {string} options.apiBase
   * @param {string} options.awardSearchPath
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   */
  constructor({
    apiBase,
    awardSearchPath = "/search/spending_by_award/",
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (!apiBase) throw new Error("apiBase is required");
    this.apiBase = apiBase.replace(/\/$/, "");
    this.awardSearchPath = awardSearchPath.startsWith("/")
      ? awardSearchPath
      : `/${awardSearchPath}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {object} body
   * @returns {Promise<object>}
   */
  async searchSpendingByAward(body) {
    const url = `${this.apiBase}${this.awardSearchPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `USAspending API ${response.status}: ${text.slice(0, 300) || response.statusText}`
        );
      }

      return response.json();
    } catch (error) {
      throw classifyUsaSpendingFetchError(error, this.timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Normalize transport failures so admin oversight can distinguish
 * timeouts / egress blocks from HTTP API errors.
 * @param {unknown} error
 * @param {number} timeoutMs
 */
export function classifyUsaSpendingFetchError(error, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (error instanceof Error) {
    // Already classified / HTTP API errors — pass through.
    if (
      error.message.startsWith("USAspending API ") ||
      error.message.startsWith("USAspending request timed out") ||
      error.message.startsWith("USAspending network/egress failure:")
    ) {
      return error;
    }

    if (error.name === "AbortError") {
      return new Error(`USAspending request timed out after ${timeoutMs}ms`);
    }

    if (
      /fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate|network|SOCKS|TLS/i.test(
        error.message
      )
    ) {
      return new Error(`USAspending network/egress failure: ${error.message}`);
    }

    return error;
  }

  return new Error(String(error));
}

/**
 * Build a spending_by_award request body from monitor config + query definition.
 * @param {object} config
 * @param {object} query
 * @param {{ startDate: string, endDate: string }} window
 */
export function buildSearchRequest(config, query, window) {
  const awardTypes =
    query.awardTypes === "contracts"
      ? config.awardTypeCodes.contracts
      : query.awardTypes === "grants"
        ? config.awardTypeCodes.grants
        : [
            ...config.awardTypeCodes.contracts,
            ...config.awardTypeCodes.grants,
          ];

  const filters = {
    award_type_codes: awardTypes,
    time_period: [
      {
        start_date: window.startDate,
        end_date: window.endDate,
      },
    ],
  };

  if (query.useKeywords && Array.isArray(config.keywords) && config.keywords.length) {
    filters.keywords = config.keywords;
  }

  if (query.useNaics && Array.isArray(config.naicsCodes) && config.naicsCodes.length) {
    filters.naics_codes = config.naicsCodes;
  }

  if (query.useAgencies && Array.isArray(config.agencies) && config.agencies.length) {
    filters.agencies = config.agencies;
  }

  if (
    query.useIllinoisPop &&
    Array.isArray(config.placeOfPerformanceStates) &&
    config.placeOfPerformanceStates.length
  ) {
    filters.place_of_performance_locations = config.placeOfPerformanceStates.map(
      (state) => ({ country: "USA", state })
    );
  }

  if (typeof config.minAwardAmount === "number" && config.minAwardAmount > 0) {
    filters.award_amounts = [{ lower_bound: config.minAwardAmount }];
  }

  const fields = query.subawards
    ? [
        "Sub-Award ID",
        "Sub-Award Amount",
        "Sub-Award Date",
        "Sub-Award Description",
        "Sub-Awardee Name",
        "Sub-Recipient UEI",
        "Prime Award ID",
        "Prime Recipient Name",
        "Awarding Agency",
        "Awarding Sub Agency",
        "NAICS",
        "Sub-Award Type",
        "prime_award_generated_internal_id",
      ]
    : [
        "Award ID",
        "Recipient Name",
        "Recipient UEI",
        "Award Amount",
        "Start Date",
        "End Date",
        "Description",
        "Awarding Agency",
        "Awarding Sub Agency",
        "NAICS",
        "Award Type",
        "Contract Award Type",
        "generated_internal_id",
      ];

  return {
    subawards: Boolean(query.subawards),
    limit: config.limit || 25,
    page: 1,
    sort: query.subawards ? "Sub-Award Date" : "Start Date",
    order: "desc",
    filters,
    fields,
  };
}
