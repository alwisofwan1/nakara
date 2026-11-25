# Reach comes from configuration, never from instructions

What an agent can reach (MCP servers, the secrets they use, and later write tools) is declared in the factory definition, which the **Operator** owns and reviews. It never follows from an agent's instructions, a **Work Item**'s request or what the **Foreman** decides in a turn. A secret reaches an agent only by name: the definition lists the names an agent may use (factory `secrets` plus the agent's own, or `agentDefaults`' when it lists none, as in Warp), MCP servers reference them as `{{NAME}}`, and the values come from a mode-600 secret store (`NAKARA_SECRETS_FILE`), never from Nakara's own environment. Names of Nakara's own credentials are refused, so no definition edit can hand an agent `CLAUDE_CODE_OAUTH_TOKEN` or the GitHub token.

Before this, `{{NAME}}` was substituted from Nakara's whole environment, so any MCP server in the definition could carry the OAuth token or `GH_TOKEN` to a third party, and the `secrets` lists were parsed but meant nothing. Warp, GitHub Copilot's coding agent and Factory.ai all scope credentials per agent in configuration; we follow them.

## Consequences

- A typo in a reference fails the definition load on its line instead of sending an empty string.
- A missing value fails the run before the harness starts, naming the secret, rather than starting an MCP server without its credential.
- Widening an agent's reach is a definition change the **Operator** approves before it applies (#133), including where it runs and its runner's egress (#135), and each foreman server names the tools the **Foreman** may call (#132).
