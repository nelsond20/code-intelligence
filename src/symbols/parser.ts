import path from "node:path";
import { createRequire } from "node:module";

export interface ParsedSymbol {
  name: string;
  qualified_name: string;
  kind: string;
  signature: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
}

interface StructuralNode {
  kind(): string;
  text(): string;
  range(): { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } };
  namedChildren(): StructuralNode[];
  field(name: string): StructuralNode | null;
}

interface AstGrepModule {
  Lang: { JavaScript: string; TypeScript: string; Tsx: string };
  parse(language: string, source: string): { root(): StructuralNode };
}

const require = createRequire(import.meta.url);
let astGrep: AstGrepModule | undefined;
try { astGrep = require("@ast-grep/napi") as AstGrepModule; } catch { /* dependency/native binding remains fail-open */ }

const PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "type", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)[^\n]*/gm },
  { kind: "function", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function|def|func|fn)\s+([A-Za-z_$][\w$]*)[^\n]*/gm },
  { kind: "function", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^\n]*\)|[A-Za-z_$][\w$]*)\s*=>[^\n]*/gm },
  { kind: "method", regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*(?::[^={]+)?[{:][^\n]*/gm },
];

const TYPE_NODES = new Set(["class_declaration", "abstract_class_declaration", "interface_declaration", "type_alias_declaration", "enum_declaration"]);
const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_signature"]);
const METHOD_NODES = new Set(["method_definition", "method_signature", "abstract_method_signature"]);
const MODULE_NODES = new Set(["internal_module", "module"]);

function lineAt(source: string, offset: number): number { return source.slice(0, offset).split(/\r?\n/).length; }

export function languageForPath(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({ ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".jsx": "jsx", ".py": "python", ".go": "go",
    ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".cs": "csharp", ".rb": "ruby", ".php": "php" } as Record<string, string>)[extension] || extension.slice(1) || "text";
}

function fallbackSymbols(source: string): ParsedSymbol[] {
  const starts: Array<Omit<ParsedSymbol, "end_line" | "qualified_name">> = [];
  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) if (match[1]) starts.push({ name: match[1], kind, signature: match[0].trim().slice(0, 500), start_line: lineAt(source, match.index) });
  }
  starts.sort((a, b) => a.start_line - b.start_line || a.name.localeCompare(b.name));
  const total = source.split(/\r?\n/).length;
  return starts.map((item, index) => ({ ...item, qualified_name: item.name, end_line: Math.max(item.start_line, (starts[index + 1]?.start_line || total + 1) - 1) }));
}

function astLanguage(file: string): string | undefined {
  if (!astGrep) return undefined;
  const extension = path.extname(file).toLowerCase();
  if (extension === ".tsx") return astGrep.Lang.Tsx;
  if ([".ts", ".mts", ".cts"].includes(extension)) return astGrep.Lang.TypeScript;
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) return astGrep.Lang.JavaScript;
  return undefined;
}

function childField(node: StructuralNode, name: string): StructuralNode | undefined {
  try { return node.field(name) || undefined; } catch { return undefined; }
}

function symbolName(node: StructuralNode): string | undefined {
  const value = childField(node, "name")?.text().trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function signature(node: StructuralNode, callableValue?: StructuralNode): string {
  const full = node.text();
  const body = childField(node, "body") || (callableValue ? childField(callableValue, "body") : undefined);
  if (!body) return full.trim().replace(/\s+/g, " ").slice(0, 500);
  const bodyText = body.text();
  const bodyOffset = full.lastIndexOf(bodyText);
  const header = bodyOffset >= 0 ? full.slice(0, bodyOffset).trim() : full.split(/\r?\n/, 1)[0]!.trim();
  return `${header} ${bodyText.startsWith("{") ? "{ … }" : "…"}`.trim().replace(/\s+/g, " ").slice(0, 500);
}

function parsedSymbol(node: StructuralNode, scope: string[]): ParsedSymbol | undefined {
  const nodeKind = node.kind();
  let kind: string | undefined;
  let name = symbolName(node);
  let callableValue: StructuralNode | undefined;
  if (TYPE_NODES.has(nodeKind)) kind = "type";
  else if (FUNCTION_NODES.has(nodeKind)) kind = "function";
  else if (METHOD_NODES.has(nodeKind)) kind = "method";
  else if (MODULE_NODES.has(nodeKind)) kind = "module";
  else if (["variable_declarator", "public_field_definition", "pair"].includes(nodeKind)) {
    callableValue = childField(node, "value");
    if (!["arrow_function", "function_expression", "generator_function"].includes(callableValue?.kind() || "")) return undefined;
    if (!name && nodeKind === "pair") name = node.namedChildren()[0]?.text().trim();
    kind = "function";
  }
  if (!kind || !name) return undefined;
  const range = node.range();
  const startLine = range.start.line + 1;
  const endLine = Math.max(startLine, range.end.line + (range.end.column > 0 ? 1 : 0));
  return { name, qualified_name: [...scope, name].join("."), kind, signature: signature(node, callableValue), start_line: startLine, end_line: endLine,
    start_column: range.start.column, end_column: range.end.column };
}

function astSymbols(source: string, file: string): ParsedSymbol[] | undefined {
  const language = astLanguage(file);
  if (!language || !astGrep) return undefined;
  try {
    const output: ParsedSymbol[] = [];
    const visit = (node: StructuralNode, scope: string[]): void => {
      const symbol = parsedSymbol(node, scope);
      if (symbol) output.push(symbol);
      let childScope = symbol ? [...scope, symbol.name] : scope;
      if (node.kind() === "variable_declarator" && !symbol) {
        const name = symbolName(node); const value = childField(node, "value");
        if (name && value?.kind() === "object") childScope = [...scope, name];
      }
      for (const child of node.namedChildren()) visit(child, childScope);
    };
    visit(astGrep.parse(language, source).root(), []);
    return output.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line || a.qualified_name.localeCompare(b.qualified_name));
  } catch { return undefined; }
}

export function structuralParserForPath(file: string): "ast-grep" | "local-fallback" {
  return astLanguage(file) ? "ast-grep" : "local-fallback";
}

export function parseSymbols(source: string, file = ""): ParsedSymbol[] {
  return astSymbols(source, file) || fallbackSymbols(source);
}

export function containingSymbol(symbols: ParsedSymbol[], startLine: number, endLine = startLine): ParsedSymbol | undefined {
  return symbols.filter((symbol) => symbol.start_line <= startLine && symbol.end_line >= endLine)
    .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line)
      || ((a.end_column || 0) - (a.start_column || 0)) - ((b.end_column || 0) - (b.start_column || 0))
      || b.qualified_name.split(".").length - a.qualified_name.split(".").length)[0];
}
