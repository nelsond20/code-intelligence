import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const memoryName = "mcp__code-intelligence__memory";
const converterPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/logs/0.24.7/libexec/lib/node_modules/@qwen-code/qwen-code/chunks/chunk-GKVFTPMJ.js",
);
const converterUrl = pathToFileURL(converterPath).href;
const marker = "parameters=convertSchema(parameters,schemaCompliance);parameters=relaxSchemaForFunctionCalling(parameters,canValidateLocally);";

export function restoreMemorySpecSetConstraints(name, source, converted) {
  if (name !== memoryName) return converted;
  const item = source?.properties?.requirements?.items;
  if (source?.additionalProperties !== false || item?.additionalProperties !== false ||
      !Number.isInteger(source?.properties?.summary?.maxLength) ||
      !Number.isInteger(item?.properties?.statement?.maxLength) ||
      !converted?.properties?.requirements?.items?.properties?.statement) {
    throw new Error("Qwen memory schema or converter changed; refusing an incomplete compatibility patch");
  }
  const result = structuredClone(converted);
  result.additionalProperties = false;
  result.properties.requirements.items.additionalProperties = false;
  result.properties.summary.maxLength = source.properties.summary.maxLength;
  result.properties.requirements.items.properties.statement.maxLength = item.properties.statement.maxLength;
  return result;
}

export function instrumentQwenConverter(source, compatUrl = import.meta.url) {
  if (source.split(marker).length !== 2) throw new Error("Qwen 0.24.7 converter hook changed");
  return `import { restoreMemorySpecSetConstraints } from ${JSON.stringify(compatUrl)};\n` +
    source.replace(marker, `${marker}parameters=restoreMemorySpecSetConstraints(func.name,sourceSchema,parameters);`);
}

if (process.env.QWEN_MEMORY_SCHEMA_COMPAT === "1") {
  // Fail before launch if the pinned bundle is missing or its hook moved.
  instrumentQwenConverter(readFileSync(converterPath, "utf8"));
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      return url === converterUrl ? { ...loaded, source: instrumentQwenConverter(String(loaded.source)) } : loaded;
    },
  });
}
