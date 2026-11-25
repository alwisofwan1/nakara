// What a process Nakara starts for an agent sees of Nakara's environment
// (#113): the basics a shell and its tools need, and the harness's own
// credential. Nakara's tokens and the other harnesses' credentials stay out.

const BASE = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/** Each harness's credential; a harness without its own login file reads it from the environment. */
const CREDENTIALS: Record<string, (key: string) => boolean> = {
  claude: (k) => k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "ANTHROPIC_API_KEY",
  // The qwen wrapper reads its gateway from CLAUDE_QWEN_*; an Anthropic token would override it.
  qwen: (k) => k.startsWith("CLAUDE_QWEN_"),
  codex: (k) => k === "OPENAI_API_KEY" || k === "OPENAI_BASE_URL",
};

/** The part of `source` a host process for `harness` (none: a setup command) may see. */
export function hostEnv(
  harness?: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const credential = (harness && CREDENTIALS[harness]) || (() => false);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (
      value !== undefined &&
      (BASE.has(key) || key.startsWith("LC_") || credential(key))
    )
      env[key] = value;
  return env;
}
