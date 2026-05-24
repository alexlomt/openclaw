import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";

function command(name: string): NativeCommandSpec {
  return {
    name,
    description: `${name} command`,
    acceptsArgs: false,
  };
}

function skill(name: string) {
  return {
    name,
    skillName: name,
    description: `${name} skill`,
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv & { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

describe("resolveDiscordProviderCommandSpecs", () => {
  it("publishes a curated capped surface instead of removing every skill command", async () => {
    const runtime = createRuntime();
    const skills = Array.from({ length: 6 }, (_, index) => skill(`skill_${index}`));

    const result = await resolveDiscordProviderCommandSpecs({
      cfg: {},
      runtime,
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      maxDiscordCommands: 5,
      listSkillCommandsForAgents: () => skills,
      listNativeCommandSpecsForConfig: (_cfg, params) => [
        command("help"),
        command("status"),
        ...(params?.skillCommands ?? []).map((item) => command(item.name)),
      ],
      getPluginCommandSpecs: () => [
        {
          name: "plugin_sync",
          description: "Plugin sync",
          acceptsArgs: false,
        },
      ],
    });

    expect(result.skillCommands).toHaveLength(6);
    expect(result.commandSpecs.map((item) => item.name)).toEqual([
      "help",
      "status",
      "plugin_sync",
      "skill_0",
      "skill_1",
    ]);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "discord: 9 commands exceeds limit; publishing 5 curated commands and hiding 4 skill commands",
      ),
    );
  });

  it("lets pinned skill commands occupy the front of the published Discord surface", async () => {
    const runtime = createRuntime();
    const skills = Array.from({ length: 4 }, (_, index) => skill(`skill_${index}`));

    const result = await resolveDiscordProviderCommandSpecs({
      cfg: {},
      runtime,
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      maxDiscordCommands: 4,
      surfaceConfig: { pinned: ["skill_3"] },
      listSkillCommandsForAgents: () => skills,
      listNativeCommandSpecsForConfig: (_cfg, params) => [
        command("help"),
        command("status"),
        ...(params?.skillCommands ?? []).map((item) => command(item.name)),
      ],
      getPluginCommandSpecs: () => [],
    });

    expect(result.commandSpecs.map((item) => item.name)).toEqual([
      "skill_3",
      "help",
      "status",
      "skill_0",
    ]);
  });
});
