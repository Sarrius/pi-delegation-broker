import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

const MARKER = "[delegation-broker:wake:v1]";
const RULE = "Messages bearing [delegation-broker:wake:v1] are typed controller lifecycle events";

function contains(value: unknown, needle: string): boolean {
  try { return JSON.stringify(value).includes(needle); } catch { return false; }
}

function hasRole(value: unknown, role: string, needle: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && (value as any).role === role && contains(value, needle)) return true;
  return Object.values(value).some((child) => hasRole(child, role, needle));
}

function hasSystemRule(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value)) {
    const item = value as any;
    if (item.role === "system" && contains(item, RULE)) return true;
    if (contains(item.system, RULE) || contains(item.instructions, RULE)) return true;
  }
  return Object.values(value).some(hasSystemRule);
}

export default function parentWakePayloadAudit(pi: ExtensionAPI) {
  const output = process.env.PARENT_WAKE_AUDIT_PATH;
  if (!output) throw new Error("PARENT_WAKE_AUDIT_PATH is required");
  pi.on("before_provider_request", (event: any) => {
    if (!contains(event.payload, MARKER)) return;
    writeFileSync(output, `${JSON.stringify({
      wakeMarker: true,
      markerInUserRole: hasRole(event.payload, "user", MARKER),
      systemRulePresent: hasSystemRule(event.payload),
    })}\n`, { mode: 0o600 });
  });
}
