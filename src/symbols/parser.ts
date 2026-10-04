import path from "node:path";

export interface ParsedSymbol { name: string; qualified_name: string; kind: string; signature: string; start_line: number; end_line: number; }

const PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "type", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)[^\n]*/gm },
  { kind: "function", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function|def|func|fn)\s+([A-Za-z_$][\w$]*)[^\n]*/gm },
  { kind: "function", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^\n]*\)|[A-Za-z_$][\w$]*)\s*=>[^\n]*/gm },
  { kind: "method", regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*(?::[^={]+)?[{:][^\n]*/gm },
];

function lineAt(source: string, offset: number): number { return source.slice(0, offset).split(/\r?\n/).length; }

export function languageForPath(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({ ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".py": "python", ".go": "go",
    ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".cs": "csharp", ".rb": "ruby", ".php": "php" } as Record<string, string>)[extension] || extension.slice(1) || "text";
}

export function parseSymbols(source: string): ParsedSymbol[] {
  const starts: Array<Omit<ParsedSymbol, "end_line" | "qualified_name">> = [];
  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) if (match[1]) starts.push({ name: match[1], kind, signature: match[0].trim().slice(0, 500), start_line: lineAt(source, match.index) });
  }
  starts.sort((a, b) => a.start_line - b.start_line || a.name.localeCompare(b.name));
  const total = source.split(/\r?\n/).length;
  return starts.map((item, index) => ({ ...item, qualified_name: item.name, end_line: Math.max(item.start_line, (starts[index + 1]?.start_line || total + 1) - 1) }));
}

export function containingSymbol(symbols: ParsedSymbol[], startLine: number, endLine = startLine): ParsedSymbol | undefined {
  return symbols.filter((symbol) => symbol.start_line <= startLine && symbol.end_line >= endLine)
    .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
}
