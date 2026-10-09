export interface SourceChunk {
  start_line: number;
  end_line: number;
  text: string;
  symbol?: string;
  signature?: string;
}

interface ChunkSymbol {
  name: string;
  qualified_name?: string;
  kind?: string;
  signature: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
}

function contains(outer: ChunkSymbol, inner: ChunkSymbol): boolean {
  if (outer === inner || outer.start_line > inner.start_line || outer.end_line < inner.end_line) return false;
  const startsBefore = outer.start_line < inner.start_line || (outer.start_column ?? 0) <= (inner.start_column ?? 0);
  const endsAfter = outer.end_line > inner.end_line || (outer.end_column ?? Number.MAX_SAFE_INTEGER) >= (inner.end_column ?? Number.MAX_SAFE_INTEGER);
  const strictlyLarger = outer.start_line < inner.start_line || outer.end_line > inner.end_line
    || (outer.start_column ?? 0) < (inner.start_column ?? 0)
    || (outer.end_column ?? Number.MAX_SAFE_INTEGER) > (inner.end_column ?? Number.MAX_SAFE_INTEGER);
  return startsBefore && endsAfter && strictlyLarger;
}

function symbolsForChunking(symbols: ChunkSymbol[]): ChunkSymbol[] {
  const droppedTypes = new Set(symbols.filter((outer) => ["type", "module"].includes(outer.kind || "")
    && symbols.some((inner) => contains(outer, inner) && inner.kind === "method" && inner.signature.includes("{ … }"))));
  return symbols.filter((symbol) => {
    if (droppedTypes.has(symbol)) return false;
    if (["function", "method"].includes(symbol.kind || "")
      && symbols.some((outer) => contains(outer, symbol) && ["function", "method"].includes(outer.kind || ""))) return false;
    if (symbol.kind === "method" && symbols.some((outer) => contains(outer, symbol)
      && ["type", "module"].includes(outer.kind || "") && !droppedTypes.has(outer))) return false;
    return true;
  }).sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
}

export function chunkSource(source: string, maxLines = 80, overlap = 12, symbols: ChunkSymbol[] = []): SourceChunk[] {
  const lines = source.split(/\r?\n/);
  if (symbols.length) {
    const output: SourceChunk[] = [];
    let cursor = 0;
    const append = (start: number, end: number, symbol?: ChunkSymbol): void => {
      for (let offset = start; offset < end; offset += maxLines) {
        const chunkEnd = Math.min(end, offset + maxLines);
        const text = lines.slice(offset, chunkEnd).join("\n");
        if (!text.trim()) continue;
        output.push({ start_line: offset + 1, end_line: chunkEnd, text,
          symbol: symbol?.qualified_name || symbol?.name, signature: symbol?.signature });
      }
    };
    for (const symbol of symbolsForChunking(symbols)) {
      const start = Math.max(cursor, symbol.start_line - 1);
      const end = Math.min(lines.length, symbol.end_line);
      if (cursor < start) append(cursor, start);
      if (start < end) append(start, end, symbol);
      cursor = Math.max(cursor, end);
    }
    if (cursor < lines.length) append(cursor, lines.length);
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
