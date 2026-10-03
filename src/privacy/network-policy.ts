import net from "node:net";

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1") return true;
  if (net.isIP(clean) === 4) return clean.startsWith("127.");
  return false;
}

export function assertEndpointAllowed(value: string, policy: "loopback-only" | "unrestricted"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid endpoint URL: ${value}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) endpoints are supported");
  if (url.username || url.password) throw new Error("Credentials in endpoint URLs are not allowed");
  if (policy === "loopback-only" && !isLoopbackHostname(url.hostname)) {
    throw new Error(`Endpoint ${url.hostname} is not loopback; privacy.network_policy is loopback-only`);
  }
  return url;
}
