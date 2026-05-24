export type CommandSurfaceKind = "native" | "custom" | "plugin" | "skill";

export type CommandSurfaceEntry<TCommand> = {
  name: string;
  kind: CommandSurfaceKind;
  command: TCommand;
};

export type CommandSurfaceConfig = {
  /** Maximum provider commands to publish. Provider hard caps still apply. */
  max?: number;
  /** Command names to publish first, without the leading slash. */
  pinned?: string[];
};

export type CommandSurfacePlan<TCommand> = {
  published: CommandSurfaceEntry<TCommand>[];
  hidden: CommandSurfaceEntry<TCommand>[];
  totalCommands: number;
  maxCommands: number;
  overflowCount: number;
  hiddenByKind: Record<CommandSurfaceKind, number>;
  missingPinned: string[];
};

const COMMAND_KIND_PRIORITY: Record<CommandSurfaceKind, number> = {
  native: 0,
  custom: 1,
  plugin: 2,
  skill: 3,
};

function normalizeCommandSurfaceName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/^\/+/, "").toLowerCase();
  return trimmed ? trimmed : undefined;
}

function normalizeCommandSurfaceAlias(value: string): string | undefined {
  const alias = value
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return alias ? alias : undefined;
}

function commandSurfaceNameKeys(value: unknown): Set<string> {
  const normalized = normalizeCommandSurfaceName(value);
  if (!normalized) {
    return new Set();
  }
  const keys = new Set([normalized]);
  const alias = normalizeCommandSurfaceAlias(normalized);
  if (alias) {
    keys.add(alias);
  }
  return keys;
}

function resolveCommandSurfaceMax(params: { configuredMax?: number; providerMax: number }): number {
  const configured =
    typeof params.configuredMax === "number" && Number.isFinite(params.configuredMax)
      ? Math.floor(params.configuredMax)
      : params.providerMax;
  return Math.max(0, Math.min(params.providerMax, configured));
}

export function planCommandSurface<TCommand>(params: {
  entries: CommandSurfaceEntry<TCommand>[];
  config?: CommandSurfaceConfig;
  providerMax: number;
}): CommandSurfacePlan<TCommand> {
  const maxCommands = resolveCommandSurfaceMax({
    configuredMax: params.config?.max,
    providerMax: params.providerMax,
  });
  const published: CommandSurfaceEntry<TCommand>[] = [];
  const publishedIndexes = new Set<number>();
  const entryKeys = params.entries.map((entry) => commandSurfaceNameKeys(entry.name));

  const publish = (index: number): boolean => {
    if (published.length >= maxCommands || publishedIndexes.has(index)) {
      return false;
    }
    publishedIndexes.add(index);
    published.push(params.entries[index]);
    return true;
  };

  const missingPinned: string[] = [];
  const seenPinned = new Set<string>();
  for (const rawPinned of params.config?.pinned ?? []) {
    const pinned = normalizeCommandSurfaceName(rawPinned);
    if (!pinned || seenPinned.has(pinned)) {
      continue;
    }
    seenPinned.add(pinned);
    const pinnedKeys = commandSurfaceNameKeys(pinned);
    const pinnedIndex = entryKeys.findIndex(
      (keys, index) =>
        !publishedIndexes.has(index) && Array.from(pinnedKeys).some((key) => keys.has(key)),
    );
    if (pinnedIndex === -1) {
      missingPinned.push(pinned);
      continue;
    }
    publish(pinnedIndex);
  }

  const rankedIndexes = params.entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => {
      const priorityDelta =
        COMMAND_KIND_PRIORITY[a.entry.kind] - COMMAND_KIND_PRIORITY[b.entry.kind];
      return priorityDelta || a.index - b.index;
    });

  for (const { index } of rankedIndexes) {
    if (published.length >= maxCommands) {
      break;
    }
    publish(index);
  }

  const hidden = params.entries.filter((_, index) => !publishedIndexes.has(index));
  const hiddenByKind: Record<CommandSurfaceKind, number> = {
    native: 0,
    custom: 0,
    plugin: 0,
    skill: 0,
  };
  for (const entry of hidden) {
    hiddenByKind[entry.kind] += 1;
  }

  return {
    published,
    hidden,
    totalCommands: params.entries.length,
    maxCommands,
    overflowCount: Math.max(0, params.entries.length - maxCommands),
    hiddenByKind,
    missingPinned,
  };
}

export function formatCommandSurfaceHiddenSummary(
  hiddenByKind: Record<CommandSurfaceKind, number>,
): string {
  return (["native", "custom", "plugin", "skill"] satisfies CommandSurfaceKind[])
    .map((kind) => {
      const count = hiddenByKind[kind];
      if (count <= 0) {
        return null;
      }
      return `${count} ${kind} command${count === 1 ? "" : "s"}`;
    })
    .filter((part): part is string => Boolean(part))
    .join(", ");
}
