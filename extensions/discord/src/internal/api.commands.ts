import { Routes, type APIApplicationCommand } from "discord-api-types/v10";
import type { RequestClient } from "./rest.js";

export const DISCORD_COMMAND_DEPLOY_TIMEOUT_MS = 60_000;

function commandDeployRequest(body?: unknown) {
  return { body, timeoutMs: DISCORD_COMMAND_DEPLOY_TIMEOUT_MS };
}

export async function listApplicationCommands(
  rest: RequestClient,
  clientId: string,
): Promise<APIApplicationCommand[]> {
  return (await rest.get(Routes.applicationCommands(clientId))) as APIApplicationCommand[];
}

export async function createApplicationCommand(
  rest: RequestClient,
  clientId: string,
  body: unknown,
): Promise<unknown> {
  return await rest.post(Routes.applicationCommands(clientId), commandDeployRequest(body));
}

export async function editApplicationCommand(
  rest: RequestClient,
  clientId: string,
  commandId: string,
  body: unknown,
): Promise<unknown> {
  return await rest.patch(
    Routes.applicationCommand(clientId, commandId),
    commandDeployRequest(body),
  );
}

export async function deleteApplicationCommand(
  rest: RequestClient,
  clientId: string,
  commandId: string,
): Promise<void> {
  await rest.delete(Routes.applicationCommand(clientId, commandId), commandDeployRequest());
}

export async function overwriteApplicationCommands(
  rest: RequestClient,
  clientId: string,
  body: unknown,
): Promise<void> {
  await rest.put(Routes.applicationCommands(clientId), commandDeployRequest(body));
}

export async function overwriteGuildApplicationCommands(
  rest: RequestClient,
  clientId: string,
  guildId: string,
  body: unknown,
): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), commandDeployRequest(body));
}
