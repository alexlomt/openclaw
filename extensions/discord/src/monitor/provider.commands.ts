import {
  listNativeCommandSpecsForConfig,
  listSkillCommandsForAgents,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  formatCommandSurfaceHiddenSummary,
  planCommandSurface,
  type CommandSurfaceConfig,
  type CommandSurfaceEntry,
} from "openclaw/plugin-sdk/command-surface";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { danger, warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type GetPluginCommandSpecs =
  typeof import("openclaw/plugin-sdk/plugin-runtime").getPluginCommandSpecs;

let pluginRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/plugin-runtime")> | undefined;

async function loadPluginRuntime() {
  const promise = pluginRuntimePromise ?? import("openclaw/plugin-sdk/plugin-runtime");
  pluginRuntimePromise = promise;
  try {
    return await promise;
  } catch (error) {
    if (pluginRuntimePromise === promise) {
      pluginRuntimePromise = undefined;
    }
    throw error;
  }
}

async function resolvePluginCommandSpecs(params: {
  existingCommandSpecs: NativeCommandSpec[];
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  getPluginCommandSpecs?: GetPluginCommandSpecs;
}): Promise<NativeCommandSpec[]> {
  const existingNames = new Set(
    params.existingCommandSpecs
      .map((spec) => normalizeLowercaseStringOrEmpty(spec.name))
      .filter(Boolean),
  );
  const getPluginCommandSpecs =
    params.getPluginCommandSpecs ?? (await loadPluginRuntime()).getPluginCommandSpecs;
  const pluginCommandSpecs: NativeCommandSpec[] = [];
  for (const pluginCommand of getPluginCommandSpecs("discord", { config: params.cfg })) {
    const normalizedName = normalizeLowercaseStringOrEmpty(pluginCommand.name);
    if (!normalizedName) {
      continue;
    }
    if (existingNames.has(normalizedName)) {
      params.runtime.error?.(
        danger(
          `discord: plugin command "/${normalizedName}" duplicates an existing native command. Skipping.`,
        ),
      );
      continue;
    }
    existingNames.add(normalizedName);
    const commandSpec: NativeCommandSpec = {
      name: pluginCommand.name,
      description: pluginCommand.description,
      acceptsArgs: pluginCommand.acceptsArgs,
    };
    if (pluginCommand.descriptionLocalizations) {
      commandSpec.descriptionLocalizations = pluginCommand.descriptionLocalizations;
    }
    pluginCommandSpecs.push(commandSpec);
  }
  return pluginCommandSpecs;
}

export async function resolveDiscordProviderCommandSpecs(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  maxDiscordCommands?: number;
  surfaceConfig?: CommandSurfaceConfig;
  listSkillCommandsForAgents?: typeof listSkillCommandsForAgents;
  listNativeCommandSpecsForConfig?: typeof listNativeCommandSpecsForConfig;
  getPluginCommandSpecs?: GetPluginCommandSpecs;
}): Promise<{
  skillCommands: ReturnType<typeof listSkillCommandsForAgents>;
  commandSpecs: NativeCommandSpec[];
}> {
  const listSkillCommands = params.listSkillCommandsForAgents ?? listSkillCommandsForAgents;
  const listNativeCommandSpecs =
    params.listNativeCommandSpecsForConfig ?? listNativeCommandSpecsForConfig;
  const maxDiscordCommands = params.maxDiscordCommands ?? 100;
  const skillCommands =
    params.nativeEnabled && params.nativeSkillsEnabled
      ? listSkillCommands({ cfg: params.cfg })
      : [];
  const baseCommandSpecs = params.nativeEnabled
    ? listNativeCommandSpecs(params.cfg, {
        skillCommands: [],
        provider: "discord",
      })
    : [];
  const fullNativeCommandSpecs = params.nativeEnabled
    ? listNativeCommandSpecs(params.cfg, {
        skillCommands,
        provider: "discord",
      })
    : [];
  const skillCommandSpecs = fullNativeCommandSpecs.slice(baseCommandSpecs.length);
  let commandSpecs = [...baseCommandSpecs, ...skillCommandSpecs];
  if (params.nativeEnabled) {
    const pluginCommandSpecs = await resolvePluginCommandSpecs({
      existingCommandSpecs: commandSpecs,
      runtime: params.runtime,
      cfg: params.cfg,
      getPluginCommandSpecs: params.getPluginCommandSpecs,
    });
    const commandSurfaceEntries: Array<CommandSurfaceEntry<NativeCommandSpec>> = [
      ...baseCommandSpecs.map((command) => ({
        name: command.name,
        kind: "native" as const,
        command,
      })),
      ...pluginCommandSpecs.map((command) => ({
        name: command.name,
        kind: "plugin" as const,
        command,
      })),
      ...skillCommandSpecs.map((command) => ({
        name: command.name,
        kind: "skill" as const,
        command,
      })),
    ];
    const surfacePlan = planCommandSurface({
      entries: commandSurfaceEntries,
      config: params.surfaceConfig,
      providerMax: maxDiscordCommands,
    });
    commandSpecs = surfacePlan.published.map((entry) => entry.command);
    if (surfacePlan.overflowCount > 0) {
      const hiddenSummary = formatCommandSurfaceHiddenSummary(surfacePlan.hiddenByKind);
      params.runtime.log?.(
        warn(
          `discord: ${surfacePlan.totalCommands} commands exceeds limit; publishing ${commandSpecs.length} curated commands` +
            `${hiddenSummary ? ` and hiding ${hiddenSummary} from slash discovery` : ""}. ` +
            "Skills remain callable through /skill and visible in /commands.",
        ),
      );
    }
    if (surfacePlan.missingPinned.length > 0) {
      params.runtime.log?.(
        warn(
          `discord: command surface pinned unknown commands: ${surfacePlan.missingPinned.join(", ")}.`,
        ),
      );
    }
  }
  if (params.nativeEnabled && commandSpecs.length > maxDiscordCommands) {
    params.runtime.log?.(
      warn(
        `discord: ${commandSpecs.length} commands exceeds limit; some commands may fail to deploy.`,
      ),
    );
  }
  return { skillCommands, commandSpecs };
}
