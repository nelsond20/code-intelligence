export interface SourceChunk {
  start_line: number;
  end_line: number;
  text: string;
  symbol?: string;
  signature?: string;
}

export function chunkSource(source: string, maxLines = 80, overlap = 12, symbols: Array<{ name: string; signature: string; start_line: number; end_line: number }> = []): SourceChunk[] {
  const lines = source.split(/\r?\n/);
  if (symbols.length) {
    const output: SourceChunk[] = [];
    for (const symbol of symbols) {
      for (let start = symbol.start_line - 1; start < symbol.end_line; start += maxLines) {
        const end = Math.min(symbol.end_line, start + maxLines);
        output.push({ start_line: start + 1, end_line: end, text: lines.slice(start, end).join("\n"), symbol: symbol.name, signature: symbol.signature });
      }
    }
    if (output.length) return output;
  }
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
