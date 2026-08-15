import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Controller-side provisioning for a brokered child. The directory holds no
 * provider credential: its only persistent setting disables Pi-local retries.
 * Lease routing/capability stays ephemeral in the child's environment.
 */
export function provisionBrokeredAgentDir(path) {
  const agentDir = resolve(path);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const stat = statSync(agentDir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Brokered agent dir must be owner-only: ${agentDir}`);
  }
  const settings = {
    retry: {
      // The broker, rather than Pi's same-child retry loop, owns recovery and
      // any compatible replacement decision.
      enabled: false,
      provider: { maxRetries: 0 },
    },
  };
  const settingsPath = join(agentDir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { agentDir, settingsPath };
}
