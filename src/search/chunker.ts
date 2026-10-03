export interface SourceChunk {
  start_line: number;
  end_line: number;
  text: string;
}

export function chunkSource(source: string, maxLines = 80, overlap = 12): SourceChunk[] {
  const lines = source.split(/\r?\n/);
  if (lines.length <= maxLines) return [{ start_line: 1, end_line: lines.length, text: source }];
  const chunks: SourceChunk[] = [];
  const step = Math.max(1, maxLines - overlap);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + maxLines);
    chunks.push({ start_line: start + 1, end_line: end, text: lines.slice(start, end).join("\n") });
    if (end === lines.length) break;
  }
  return chunks;
}
