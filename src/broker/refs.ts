import { createHash } from "node:crypto";
import type { ContextSource } from "./types.js";

export function codeRef(repo: string, sourcePath: string, start: number, end: number, symbol?: string): string {
  const fragment = symbol ? `symbol=${encodeURIComponent(symbol)}&L=${start}-${end}` : `L=${start}-${end}`;
  return `code://${encodeURIComponent(repo)}/${sourcePath.split("/").map(encodeURIComponent).join("/")}#${fragment}`;
}
export function externalRef(source: "docs", identity: string): string { return `${source}://item/${encodeURIComponent(identity)}`; }
export function vaultRef(identity: string): string {
  if (!/^[0-9a-z]+$/.test(identity)) throw new Error("Invalid Vault reference identity");
  return `v:${identity}`;
}
export function docsRef(metadata: { framework?: string; version?: string; source?: string; heading?: string; commit?: string }, fallback: string): string {
  const fields = [metadata.framework || "", metadata.version || "", metadata.source || "", metadata.heading || "", metadata.commit || ""];
  const identity = JSON.stringify([...fields, fallback]);
  return externalRef("docs", createHash("sha256").update(identity).digest("hex"));
}
export function gitCommitRef(repo: string, commit: string): string { return `git://${encodeURIComponent(repo)}/commit/${commit}`; }
export function gitFileRef(repo: string, commit: string, sourcePath: string): string {
  return `git://${encodeURIComponent(repo)}/file/${sourcePath.split("/").map(encodeURIComponent).join("/")}?commit=${commit}`;
}

export function parseContextRef(value: string): { source: ContextSource; repo?: string; path?: string; identity?: string; start?: number; end?: number; symbol?: string; commit?: string; kind?: string } {
  const shortVault = value.match(/^v:([0-9a-z]+)$/);
  if (shortVault) return { source: "vault", identity: shortVault[1] };
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid context reference"); }
  const source = url.protocol.slice(0, -1) as ContextSource;
  if (!(["code", "docs", "vault", "git"] as string[]).includes(source)) throw new Error("Unsupported context reference scheme");
  if (source === "code") {
    const params = new URLSearchParams(url.hash.slice(1));
    const range = params.get("L")?.match(/^(\d+)-(\d+)$/);
    return { source, repo: decodeURIComponent(url.hostname), path: url.pathname.slice(1).split("/").map(decodeURIComponent).join("/"),
      start: range ? Number(range[1]) : 1, end: range ? Number(range[2]) : undefined, symbol: params.get("symbol") || undefined };
  }
  if (source === "git") {
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    const kind = parts.shift();
    if (kind === "commit") return { source, repo: decodeURIComponent(url.hostname), kind, commit: parts[0] };
    if (kind === "file" || kind === "blame") return { source, repo: decodeURIComponent(url.hostname), kind,
      path: parts.join("/"), commit: url.searchParams.get("commit") || undefined };
    throw new Error("Unsupported Git reference kind");
  }
  if (url.hostname !== "item") throw new Error(`Unsupported ${source} reference kind`);
  return { source, identity: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}
