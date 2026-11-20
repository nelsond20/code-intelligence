import path from "node:path";

const DIRS = new Set([".git", ".ci-runtime", "node_modules", "dist", "build", "coverage", "vendor", ".next", ".cache", "target", "__pycache__"]);
const SECRET_PATTERNS = [
  /^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i,
  /^credentials($|\.)/i, /^secrets?($|\.)/i, /\.p12$/i, /\.pfx$/i,
];
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf", ".ico", ".exe", ".dll", ".so", ".dylib", ".class", ".jar"]);

export function isGloballyIgnored(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => DIRS.has(part))) return true;
  const base = parts.at(-1) || "";
  if (SECRET_PATTERNS.some((pattern) => pattern.test(base))) return true;
  return BINARY_EXTENSIONS.has(path.extname(base).toLowerCase());
}

export function defaultRgGlobs(): string[] {
  return [
    "!.git/**", "!**/.ci-runtime/**", "!node_modules/**", "!dist/**", "!build/**", "!coverage/**", "!vendor/**",
    "!.next/**", "!.cache/**", "!**/.env*", "!**/*.pem", "!**/*.key", "!**/id_rsa*",
    "!**/id_ed25519*", "!**/credentials*", "!**/secrets*",
  ];
}
