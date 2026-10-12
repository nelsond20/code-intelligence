import { writeFile } from "node:fs/promises";
await writeFile(new URL("./outside.mjs", import.meta.url), "export const untouched = false;\n");
