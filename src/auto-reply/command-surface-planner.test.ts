import { describe, expect, it } from "vitest";
import {
  formatCommandSurfaceHiddenSummary,
  planCommandSurface,
  type CommandSurfaceEntry,
} from "./command-surface-planner.js";

function entry(
  name: string,
  kind: CommandSurfaceEntry<string>["kind"],
): CommandSurfaceEntry<string> {
  return { name, kind, command: name };
}

describe("planCommandSurface", () => {
  it("publishes core command kinds before skill overflow", () => {
    const plan = planCommandSurface({
      providerMax: 5,
      entries: [
        entry("skill_a", "skill"),
        entry("status", "native"),
        entry("custom_backup", "custom"),
        entry("plugin_sync", "plugin"),
        entry("skill_b", "skill"),
        entry("skill_c", "skill"),
        entry("help", "native"),
      ],
    });

    expect(plan.published.map((item) => item.name)).toEqual([
      "status",
      "help",
      "custom_backup",
      "plugin_sync",
      "skill_a",
    ]);
    expect(plan.hidden.map((item) => item.name)).toEqual(["skill_b", "skill_c"]);
    expect(plan.hiddenByKind).toEqual({ native: 0, custom: 0, plugin: 0, skill: 2 });
  });

  it("publishes pinned commands first and matches slash-prefixed sanitized names", () => {
    const plan = planCommandSurface({
      providerMax: 4,
      config: { pinned: ["/agent-run", "skill_b", "missing"] },
      entries: [
        entry("status", "native"),
        entry("agent_run", "skill"),
        entry("skill_a", "skill"),
        entry("skill_b", "skill"),
        entry("plugin_sync", "plugin"),
      ],
    });

    expect(plan.published.map((item) => item.name)).toEqual([
      "agent_run",
      "skill_b",
      "status",
      "plugin_sync",
    ]);
    expect(plan.missingPinned).toEqual(["missing"]);
  });

  it("formats hidden command summaries", () => {
    expect(formatCommandSurfaceHiddenSummary({ native: 1, custom: 0, plugin: 2, skill: 3 })).toBe(
      "1 native command, 2 plugin commands, 3 skill commands",
    );
  });
});
