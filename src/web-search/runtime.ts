import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { hasAuthProfileForProvider } from "../agents/tools/model-config.helpers.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry-contributions.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "../web/provider-runtime-shared.js";
import type {
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig as WebSearchConfig,
} from "./runtime-types.js";

export type {
  ListWebSearchProvidersParams,
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig,
  RuntimeWebSearchProviderEntry,
  RuntimeWebSearchToolDefinition,
} from "./runtime-types.js";

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  return resolveWebProviderConfig(cfg, "search") as NonNullable<WebSearchConfig> | undefined;
}

function resolveWebSearchRuntimeConfig(params?: {
  config?: OpenClawConfig;
  preferInputConfig?: boolean;
}): OpenClawConfig | undefined {
  if (params?.preferInputConfig && params.config) {
    return params.config;
  }
  return selectApplicableRuntimeConfig({
    inputConfig: params?.config,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  });
}

export function resolveWebSearchEnabled(params: {
  search?: WebSearchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "authProviderId"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getConfiguredCredentialFallback"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
  agentDir?: string,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: search as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig),
    resolveFallbackRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialFallback?.(currentConfig)?.value,
    resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) =>
      (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
      readWebProviderEnvValue(currentProvider.envVars),
    resolveProviderAuthValue: (providerId) =>
      hasAuthProfileForProvider({
        provider: providerId,
        agentDir: agentDir?.trim() || resolveDefaultAgentDir(config ?? {}),
      }),
  });
}

export function isWebSearchProviderConfigured(params: {
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "authProviderId"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getConfiguredCredentialFallback"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  const config = resolveWebSearchRuntimeConfig({ config: params.config });
  return hasEntryCredential(params.provider, config, resolveSearchConfig(config));
}

export function listWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({ config: params?.config });
  return resolveRuntimeWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
}

export function listConfiguredWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({ config: params?.config });
  return resolvePluginWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
}

export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  agentDir?: string;
  providers?: PluginWebSearchProviderEntry[];
}): string {
  const config = resolveWebSearchRuntimeConfig({ config: params.config });
  const search = params.search ?? resolveSearchConfig(config);
  const providers = sortWebSearchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebSearchProviders({
        config,
        bundledAllowlistCompat: true,
      }),
  );
  const raw =
    search && "provider" in search ? normalizeLowercaseStringOrEmpty(search.provider) : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  if (!raw) {
    let keylessFallbackProviderId = "";
    for (const provider of providers) {
      if (!providerRequiresCredential(provider)) {
        keylessFallbackProviderId ||= provider.id;
        continue;
      }
      if (!hasEntryCredential(provider, config, search, params.agentDir)) {
        continue;
      }
      logVerbose(
        `web_search: no provider configured, auto-detected "${provider.id}" from available credentials`,
      );
      return provider.id;
    }
    if (keylessFallbackProviderId) {
      logVerbose(
        `web_search: no provider configured and no credentials found, falling back to keyless provider "${keylessFallbackProviderId}"`,
      );
      return keylessFallbackProviderId;
    }
  }

  return providers[0]?.id ?? "";
}

function resolveExplicitWebSearchProviderId(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  includeRuntimeSelection?: boolean;
}): string | undefined {
  const callerProviderId = normalizeOptionalLowercaseString(params.providerId);
  if (callerProviderId) {
    return callerProviderId;
  }

  if (params.includeRuntimeSelection && params.runtimeWebSearch?.providerSource === "configured") {
    const runtimeProviderId = normalizeOptionalLowercaseString(
      params.runtimeWebSearch.selectedProvider ?? params.runtimeWebSearch.providerConfigured,
    );
    if (runtimeProviderId) {
      return runtimeProviderId;
    }
  }

  const configuredProviderId =
    params.search && "provider" in params.search
      ? normalizeOptionalLowercaseString(params.search.provider)
      : undefined;
  if (configuredProviderId) {
    return configuredProviderId;
  }
  return undefined;
}

function resolveConfiguredWebSearchProviderIds(search?: WebSearchConfig): string[] {
  const rawProviders = search && "providers" in search ? search.providers : undefined;
  if (!Array.isArray(rawProviders)) {
    return [];
  }
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const rawProvider of rawProviders) {
    if (typeof rawProvider !== "string") {
      continue;
    }
    const providerId = normalizeLowercaseStringOrEmpty(rawProvider);
    if (!providerId || seen.has(providerId)) {
      continue;
    }
    seen.add(providerId);
    providerIds.push(providerId);
  }
  return providerIds;
}

function resolveExplicitWebSearchProviderPluginIds(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  includeRuntimeSelection?: boolean;
}): readonly string[] | undefined {
  const providerIds = [
    ...resolveConfiguredWebSearchProviderIds(params.search),
    resolveExplicitWebSearchProviderId(params),
  ].filter((providerId): providerId is string => Boolean(providerId));
  const uniqueProviderIds = [...new Set(providerIds)];
  if (uniqueProviderIds.length === 0) {
    return undefined;
  }
  const ownerPluginIds: string[] = [];
  for (const providerId of uniqueProviderIds) {
    const ownerPluginId = resolveManifestContractOwnerPluginId({
      config: params.config,
      contract: "webSearchProviders",
      value: providerId,
    });
    if (!ownerPluginId) {
      return undefined;
    }
    if (!ownerPluginIds.includes(ownerPluginId)) {
      ownerPluginIds.push(ownerPluginId);
    }
  }
  return ownerPluginIds;
}

function resolveWebSearchProviderLoadScope(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  includeRuntimeSelection?: boolean;
}): { onlyPluginIds?: readonly string[] } {
  const onlyPluginIds = resolveExplicitWebSearchProviderPluginIds(params);
  return onlyPluginIds ? { onlyPluginIds } : {};
}

export function resolveWebSearchDefinition(
  options?: ResolveWebSearchDefinitionParams,
): { provider: PluginWebSearchProviderEntry; definition: WebSearchProviderToolDefinition } | null {
  const config = resolveWebSearchRuntimeConfig({
    config: options?.config,
    preferInputConfig: options?.preferInputConfig,
  });
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const loadScope = resolveWebSearchProviderLoadScope({
    config,
    search,
    runtimeWebSearch,
    providerId: options?.providerId,
    includeRuntimeSelection: Boolean(options?.preferRuntimeProviders),
  });
  const providers = sortWebSearchProvidersForAutoDetect(
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          ...loadScope,
        })
      : resolvePluginWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          ...loadScope,
        }),
  );
  return resolveWebProviderDefinition({
    config,
    toolConfig: search as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebSearch,
    sandboxed: options?.sandboxed,
    providerId: options?.providerId,
    providers,
    resolveEnabled: ({ toolConfig, sandboxed }) =>
      resolveWebSearchEnabled({
        search: toolConfig as WebSearchConfig | undefined,
        sandboxed,
      }),
    resolveAutoProviderId: ({ config, toolConfig, providers }) =>
      resolveWebSearchProviderId({
        config,
        agentDir: options?.agentDir,
        search: toolConfig as WebSearchConfig | undefined,
        providers,
      }),
    resolveFallbackProviderId: ({ config, toolConfig, providers }) =>
      resolveWebSearchProviderId({
        config,
        agentDir: options?.agentDir,
        search: toolConfig as WebSearchConfig | undefined,
        providers,
      }) || providers[0]?.id,
    createTool: ({ provider, config, toolConfig, runtimeMetadata }) =>
      provider.createTool({
        config,
        agentDir: options?.agentDir,
        searchConfig: toolConfig,
        runtimeMetadata,
      }),
  });
}

function resolveWebSearchCandidates(
  options?: ResolveWebSearchDefinitionParams,
): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({
    config: options?.config,
    preferInputConfig: options?.preferInputConfig,
  });
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  if (!resolveWebSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return [];
  }
  const loadScope = resolveWebSearchProviderLoadScope({
    config,
    search,
    runtimeWebSearch,
    providerId: options?.providerId,
    includeRuntimeSelection: Boolean(options?.preferRuntimeProviders),
  });

  const providers = sortWebSearchProvidersForAutoDetect(
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          ...loadScope,
        })
      : resolvePluginWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          ...loadScope,
        }),
  ).filter(Boolean);
  if (providers.length === 0) {
    return [];
  }

  const configuredProviderIds = resolveConfiguredWebSearchProviderIds(search);
  const preferredIds = [
    options?.providerId,
    ...configuredProviderIds,
    ...(configuredProviderIds.length > 0
      ? []
      : [
          runtimeWebSearch?.selectedProvider,
          runtimeWebSearch?.providerConfigured,
          resolveWebSearchProviderId({ config, agentDir: options?.agentDir, search, providers }),
        ]),
  ].filter(
    (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index,
  );

  const explicitProviderId = options?.providerId?.trim();
  if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) {
    throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
  }
  for (const providerId of configuredProviderIds) {
    if (!providers.some((entry) => entry.id === providerId)) {
      throw new Error(`Unknown web_search provider "${providerId}".`);
    }
  }

  const orderedProviders = [
    ...preferredIds
      .map((id) => providers.find((entry) => entry.id === id))
      .filter((entry): entry is PluginWebSearchProviderEntry => Boolean(entry)),
    ...providers.filter((entry) => !preferredIds.includes(entry.id)),
  ];
  return orderedProviders;
}

function hasExplicitWebSearchSelection(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  providers?: PluginWebSearchProviderEntry[];
}): boolean {
  if (params.providerId?.trim()) {
    return true;
  }
  const configuredProviderIds = resolveConfiguredWebSearchProviderIds(params.search);
  const availableProviderIds = new Set(
    (params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)),
  );
  if (configuredProviderIds.length > 1) {
    return false;
  }
  if (configuredProviderIds.length === 1 && availableProviderIds.has(configuredProviderIds[0])) {
    return true;
  }
  const configuredProviderId =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? normalizeLowercaseStringOrEmpty(params.search.provider)
      : "";
  if (configuredProviderId && availableProviderIds.has(configuredProviderId)) {
    return true;
  }
  const runtimeConfiguredId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (
    params.runtimeWebSearch?.providerSource === "configured" &&
    runtimeConfiguredId &&
    availableProviderIds.has(runtimeConfiguredId)
  ) {
    return true;
  }
  return false;
}

function isStructuredAvailabilityError(result: unknown): result is { error: string } {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return false;
  }
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && /^missing_[a-z0-9_]*api_key$/i.test(error);
}

function hasConfiguredWebSearchFallback(search?: WebSearchConfig): boolean {
  return resolveConfiguredWebSearchProviderIds(search).length > 1;
}

function isFallbackSafeWebSearchProviderError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (
    /\b(api[_ -]?key|auth|unauthori[sz]ed|forbidden|invalid|missing_[a-z0-9_]*api_key)\b/u.test(
      message,
    ) ||
    message.includes("base url must")
  ) {
    return false;
  }
  if (message.includes("budget guard")) {
    return true;
  }
  return (
    /\b(408|409|425|429|5\d\d)\b/u.test(message) ||
    /\b(timeout|timed out|temporar(?:y|ily)|unavailable|overloaded|econnreset|etimedout|eai_again)\b/u.test(
      message,
    )
  );
}

export async function runWebSearch(params: RunWebSearchParams): Promise<RunWebSearchResult> {
  const config = resolveWebSearchRuntimeConfig({
    config: params.config,
    preferInputConfig: params.preferInputConfig,
  });
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = params.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const candidates = resolveWebSearchCandidates({
    ...params,
    config,
    runtimeWebSearch,
    preferRuntimeProviders: params.preferRuntimeProviders ?? true,
  });
  if (candidates.length === 0) {
    throw new Error("web_search is disabled or no provider is available.");
  }
  const allowFallback = !hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: params.providerId,
    providers: candidates,
  });
  const configuredFallback = allowFallback && hasConfiguredWebSearchFallback(search);
  let lastError: unknown;
  let sawUnavailableProvider = false;

  for (const candidate of candidates) {
    try {
      const definition = candidate.createTool({
        config,
        agentDir: params.agentDir,
        searchConfig: search as Record<string, unknown> | undefined,
        runtimeMetadata: runtimeWebSearch,
      });
      if (!definition) {
        if (!allowFallback) {
          throw new Error(`web_search provider "${candidate.id}" is not available.`);
        }
        sawUnavailableProvider = true;
        continue;
      }
      const executed = await definition.execute(params.args, { signal: params.signal });
      if (allowFallback && isStructuredAvailabilityError(executed)) {
        lastError = new Error(`web_search provider "${candidate.id}" returned ${executed.error}`);
        if (configuredFallback) {
          throw lastError;
        }
        continue;
      }
      return {
        provider: candidate.id,
        result: executed,
      };
    } catch (error) {
      lastError = error;
      if (!allowFallback) {
        throw error;
      }
      if (configuredFallback && !isFallbackSafeWebSearchProviderError(error)) {
        throw error;
      }
    }
  }

  if (sawUnavailableProvider && lastError === undefined) {
    throw new Error("web_search is enabled but no provider is currently available.");
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const testing = {
  resolveSearchConfig,
  resolveSearchProvider: resolveWebSearchProviderId,
  resolveWebSearchProviderId,
  resolveWebSearchCandidates,
  resolveExplicitWebSearchProviderId,
  resolveExplicitWebSearchProviderPluginIds,
  resolveConfiguredWebSearchProviderIds,
  hasExplicitWebSearchSelection,
  isFallbackSafeWebSearchProviderError,
};
export { testing as __testing };
