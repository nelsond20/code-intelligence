import type { IndexProgress } from "../search/semantic.js";

type ProgressStream = Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns">;

function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

export function formatIndexProgress(repositoryId: string, progress: IndexProgress, width = 24): string {
  if (progress.phase === "scanning") return `[${repositoryId}] Scanning files...`;
  const ratio = progress.total === 0 ? 1 : progress.completed / progress.total;
  const filled = Math.min(width, Math.round(ratio * width));
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const elapsedSeconds = progress.elapsed_ms / 1000;
  const speed = elapsedSeconds > 0 ? progress.completed / elapsedSeconds : 0;
  const eta = speed > 0 ? (progress.total - progress.completed) / speed : progress.total === 0 ? 0 : Number.POSITIVE_INFINITY;
  const status = progress.phase === "complete" ? "done" : `ETA ${duration(eta)}`;
  return `[${repositoryId}] [${bar}] ${String(Math.round(ratio * 100)).padStart(3)}% `
    + `${progress.completed}/${progress.total} new | ${speed.toFixed(1)} chunks/s | ${status} | ${progress.reused} reused`;
}

export class IndexProgressRenderer {
  private lastRender = 0;

  constructor(private readonly stream: ProgressStream = process.stderr, private readonly now: () => number = () => performance.now()) {}

  render(repositoryId: string, progress: IndexProgress): void {
    const current = this.now();
    const important = progress.phase !== "embedding" || progress.completed === 0 || progress.completed === progress.total;
    if (!important && current - this.lastRender < 100) return;
    this.lastRender = current;
    const available = this.stream.columns || 100;
    const barWidth = Math.max(10, Math.min(30, available - 76));
    const line = formatIndexProgress(repositoryId, progress, barWidth);
    if (this.stream.isTTY) this.stream.write(`\r\x1b[2K${line}${progress.phase === "complete" ? "\n" : ""}`);
    else this.stream.write(`${line}\n`);
  }
}
