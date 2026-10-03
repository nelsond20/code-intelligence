const SECRET_ENV_PATTERNS = [
  /(^|_)API_?KEY$/i, /(^|_)SECRET(_|$)/i, /(^|_)TOKEN$/i,
  /OPENAI/i, /ANTHROPIC/i, /GEMINI/i, /GOOGLE.*KEY/i, /AWS_/i,
  /AZURE/i, /COHERE/i, /MISTRAL/i, /GROQ/i, /HUGGINGFACE/i, /HF_TOKEN/i,
];

export function sanitizedChildEnv(kind: "graphify" | "serena", source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    output[key] = value;
  }
  output.GRAPHIFY_QUERY_LOG_DISABLE = "1";
  output.SERENA_USAGE_REPORTING = "false";
  output.NO_COLOR = "1";
  output.CODE_INTELLIGENCE_CHILD = kind;
  return output;
}
