import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  normalizeFreshness,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  assertHttpUrlTargetsPrivateNetwork,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  type BraveLlmContextResponse,
  mapBraveLlmContextResults,
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveConfig,
  resolveBraveMode,
} from "./brave-web-search-provider.shared.js";

const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com";
const BRAVE_SEARCH_ENDPOINT_PATH = "/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT_PATH = "/res/v1/llm/context";
const DEFAULT_BRAVE_SEARCH_MONTHLY_LIMIT = 1000;
const DEFAULT_BRAVE_SEARCH_STOP_AT = 950;
const braveHttpLogger = createSubsystemLogger("brave/http");
type BraveEndpointMode = "selfHosted" | "strict";

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type BraveHttpDiagnostics = {
  enabled?: boolean;
};

type BraveBudgetGuard = {
  enabled: boolean;
  monthlyLimit: number;
  stopAt: number;
  stateDir: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function resolveBraveBudgetGuard(
  braveConfig: { budgetGuard?: unknown } | undefined,
): BraveBudgetGuard | undefined {
  const rawGuard = isRecord(braveConfig?.budgetGuard) ? braveConfig.budgetGuard : {};
  const enabled =
    rawGuard.enabled === true ||
    process.env.OPENCLAW_BRAVE_SEARCH_BUDGET_GUARD === "1" ||
    process.env.OPENCLAW_BRAVE_SEARCH_BUDGET_GUARD === "true";
  if (!enabled) {
    return undefined;
  }
  const monthlyLimit =
    readPositiveInteger(rawGuard.monthlyLimit) ??
    readPositiveInteger(process.env.OPENCLAW_BRAVE_SEARCH_MONTHLY_LIMIT) ??
    DEFAULT_BRAVE_SEARCH_MONTHLY_LIMIT;
  const stopAt =
    readPositiveInteger(rawGuard.stopAt) ??
    readPositiveInteger(process.env.OPENCLAW_BRAVE_SEARCH_STOP_AT) ??
    Math.min(monthlyLimit, DEFAULT_BRAVE_SEARCH_STOP_AT);
  const stateDirRaw =
    typeof rawGuard.stateDir === "string" && rawGuard.stateDir.trim()
      ? rawGuard.stateDir.trim()
      : process.env.OPENCLAW_BRAVE_SEARCH_BUDGET_STATE_DIR;
  const stateDir =
    stateDirRaw && stateDirRaw.trim()
      ? stateDirRaw.trim()
      : path.join(os.homedir(), ".openclaw", "runtime", "web-search");
  return {
    enabled: true,
    monthlyLimit,
    stopAt: Math.min(stopAt, monthlyLimit),
    stateDir,
  };
}

function recordBraveBudgetUse(guard: BraveBudgetGuard | undefined): void {
  if (!guard?.enabled) {
    return;
  }
  const month = new Date().toISOString().slice(0, 7);
  fs.mkdirSync(guard.stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(guard.stateDir, `brave-search-usage-${month}.json`);
  let count = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed?.month === month && Number.isInteger(parsed.count) && parsed.count > 0) {
      count = parsed.count;
    }
  } catch {
    count = 0;
  }
  if (count >= guard.stopAt) {
    throw new Error(
      `Brave Search budget guard reached ${count}/${guard.monthlyLimit} monthly requests; refusing to spend more Brave quota before paid usage starts.`,
    );
  }
  const next = {
    month,
    count: count + 1,
    monthlyLimit: guard.monthlyLimit,
    stopAt: guard.stopAt,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, statePath);
}

function logBraveHttp(
  diagnostics: BraveHttpDiagnostics | undefined,
  event: string,
  meta?: Record<string, unknown>,
): void {
  if (!diagnostics?.enabled) {
    return;
  }
  braveHttpLogger.info(`brave http ${event}`, meta);
}

function describeBraveRequestUrl(url: URL): {
  url: string;
  query: string;
  params: Record<string, string>;
} {
  return {
    url: url.toString(),
    query: url.searchParams.get("q") ?? "",
    params: Object.fromEntries(url.searchParams.entries()),
  };
}

function resolveBraveApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["BRAVE_API_KEY"])
  );
}

function resolveBraveBaseUrl(braveConfig: { baseUrl?: unknown } | undefined): string {
  const configured = readConfiguredSecretString(
    braveConfig?.baseUrl,
    "plugins.entries.brave.config.webSearch.baseUrl",
  );
  return configured?.replace(/\/+$/u, "") || DEFAULT_BRAVE_BASE_URL;
}

function buildBraveEndpointUrl(params: { baseUrl: string; endpointPath: string }): URL {
  const url = new URL(params.baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${params.endpointPath}`;
  url.search = "";
  return url;
}

async function braveEndpointTargetsPrivateNetwork(url: URL): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      policy: {
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
      },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

async function validateBraveBaseUrl(baseUrl: string): Promise<BraveEndpointMode> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Brave Search base URL must be a valid http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Brave Search base URL must use http:// or https://.");
  }

  if (parsed.protocol === "http:") {
    await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
      dangerouslyAllowPrivateNetwork: true,
      errorMessage:
        "Brave Search HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    });
    return "selfHosted";
  }

  return (await braveEndpointTargetsPrivateNetwork(parsed)) ? "selfHosted" : "strict";
}

function missingBraveKeyPayload() {
  return {
    error: "missing_brave_api_key",
    message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

async function runBraveLlmContextSearch(params: {
  baseUrl: string;
  endpointMode: BraveEndpointMode;
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  diagnostics?: BraveHttpDiagnostics;
  country?: string;
  search_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<{
  results: Array<{
    url: string;
    title: string;
    snippets: string[];
    siteName?: string;
  }>;
  sources?: BraveLlmContextResponse["sources"];
}> {
  const url = buildBraveEndpointUrl({
    baseUrl: params.baseUrl,
    endpointPath: BRAVE_LLM_CONTEXT_ENDPOINT_PATH,
  });
  url.searchParams.set("q", params.query);
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  }

  logBraveHttp(params.diagnostics, "request", {
    mode: "llm-context",
    ...describeBraveRequestUrl(url),
  });
  const startedAt = Date.now();
  const withEndpoint =
    params.endpointMode === "selfHosted"
      ? withSelfHostedWebSearchEndpoint
      : withTrustedWebSearchEndpoint;
  return withEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (response) => {
      logBraveHttp(params.diagnostics, "response", {
        mode: "llm-context",
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Brave LLM Context API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const data = await readProviderJsonResponse<BraveLlmContextResponse>(
        response,
        "Brave LLM Context API error",
      );
      return { results: mapBraveLlmContextResults(data), sources: data.sources };
    },
  );
}

async function runBraveWebSearch(params: {
  baseUrl: string;
  endpointMode: BraveEndpointMode;
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  diagnostics?: BraveHttpDiagnostics;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<Array<Record<string, unknown>>> {
  const url = buildBraveEndpointUrl({
    baseUrl: params.baseUrl,
    endpointPath: BRAVE_SEARCH_ENDPOINT_PATH,
  });
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }

  logBraveHttp(params.diagnostics, "request", {
    mode: "web",
    ...describeBraveRequestUrl(url),
  });
  const startedAt = Date.now();
  const withEndpoint =
    params.endpointMode === "selfHosted"
      ? withSelfHostedWebSearchEndpoint
      : withTrustedWebSearchEndpoint;
  return withEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (response) => {
      logBraveHttp(params.diagnostics, "response", {
        mode: "web",
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Brave Search API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const data = await readProviderJsonResponse<BraveSearchResponse>(
        response,
        "Brave Search API error",
      );
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

export async function executeBraveSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  options?: {
    diagnosticsEnabled?: boolean;
  },
): Promise<Record<string, unknown>> {
  const apiKey = resolveBraveApiKey(searchConfig);
  if (!apiKey) {
    return missingBraveKeyPayload();
  }

  const braveConfig = resolveBraveConfig(searchConfig);
  const braveMode = resolveBraveMode(braveConfig);
  const braveBaseUrl = resolveBraveBaseUrl(braveConfig);
  const braveEndpointMode = await validateBraveBaseUrl(braveBaseUrl);
  const budgetGuard = resolveBraveBudgetGuard(braveConfig);
  const query = readStringParam(args, "query", { required: true });
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const country = normalizeBraveCountry(readStringParam(args, "country"));
  const language = readStringParam(args, "language");
  const search_lang = readStringParam(args, "search_lang");
  const ui_lang = readStringParam(args, "ui_lang");
  const normalizedLanguage = normalizeBraveLanguageParams({
    search_lang: search_lang || language,
    ui_lang,
  });

  if (normalizedLanguage.invalidField === "search_lang") {
    return {
      error: "invalid_search_lang",
      message:
        "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (normalizedLanguage.invalidField === "ui_lang") {
    return {
      error: "invalid_ui_lang",
      message: "ui_lang must be a language-region locale like 'en-US'.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (normalizedLanguage.ui_lang && braveMode === "llm-context") {
    return {
      error: "unsupported_ui_lang",
      message:
        "ui_lang is not supported by Brave llm-context mode. Remove ui_lang or use Brave web mode for locale-based UI hints.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawFreshness = readStringParam(args, "freshness");
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "brave") : undefined;
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const parsedDateRange = parseIsoDateRange({
    rawDateAfter,
    rawDateBefore,
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }

  const { dateAfter, dateBefore } = parsedDateRange;
  if (braveMode === "llm-context") {
    const today = new Date().toISOString().slice(0, 10);
    if (dateAfter && !dateBefore && dateAfter > today) {
      return {
        error: "invalid_date_range",
        message: "date_after cannot be in the future for Brave llm-context mode.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (dateBefore && !dateAfter) {
      return {
        error: "unsupported_date_filter",
        message:
          "Brave llm-context mode requires date_after when date_before is set. Use a bounded date range or freshness.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
  }
  const llmContextDateEnd =
    braveMode === "llm-context" && dateAfter
      ? (dateBefore ?? new Date().toISOString().slice(0, 10))
      : dateBefore;
  const cacheKey = buildSearchCacheKey(
    braveMode === "llm-context"
      ? [
          "brave",
          braveMode,
          braveBaseUrl,
          query,
          country,
          normalizedLanguage.search_lang,
          freshness,
          dateAfter,
          llmContextDateEnd,
        ]
      : [
          "brave",
          braveMode,
          braveBaseUrl,
          query,
          resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
          country,
          normalizedLanguage.search_lang,
          normalizedLanguage.ui_lang,
          freshness,
          dateAfter,
          dateBefore,
        ],
  );
  const diagnostics: BraveHttpDiagnostics = { enabled: options?.diagnosticsEnabled === true };
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    logBraveHttp(diagnostics, "cache hit", { mode: braveMode, query, cacheKey });
    return cached;
  }
  logBraveHttp(diagnostics, "cache miss", { mode: braveMode, query, cacheKey });

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

  if (braveMode === "llm-context") {
    recordBraveBudgetUse(budgetGuard);
    const { results, sources } = await runBraveLlmContextSearch({
      baseUrl: braveBaseUrl,
      endpointMode: braveEndpointMode,
      query,
      apiKey,
      timeoutSeconds,
      diagnostics,
      country: country ?? undefined,
      search_lang: normalizedLanguage.search_lang,
      freshness,
      dateAfter,
      dateBefore,
    });
    const payload = {
      query,
      provider: "brave",
      mode: "llm-context" as const,
      count: results.length,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "brave",
        wrapped: true,
      },
      results: results.map((entry) => ({
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url,
        snippets: entry.snippets.map((snippet) => wrapWebContent(snippet, "web_search")),
        siteName: entry.siteName,
      })),
      sources,
    };
    writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
    logBraveHttp(diagnostics, "cache write", {
      mode: "llm-context",
      query,
      cacheKey,
      ttlMs: cacheTtlMs,
      count: results.length,
    });
    return payload;
  }

  recordBraveBudgetUse(budgetGuard);
  const results = await runBraveWebSearch({
    baseUrl: braveBaseUrl,
    endpointMode: braveEndpointMode,
    query,
    count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    apiKey,
    timeoutSeconds,
    diagnostics,
    country: country ?? undefined,
    search_lang: normalizedLanguage.search_lang,
    ui_lang: normalizedLanguage.ui_lang,
    freshness,
    dateAfter,
    dateBefore,
  });
  const payload = {
    query,
    provider: "brave",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "brave",
      wrapped: true,
    },
    results,
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  logBraveHttp(diagnostics, "cache write", {
    mode: "web",
    query,
    cacheKey,
    ttlMs: cacheTtlMs,
    count: results.length,
  });
  return payload;
}
