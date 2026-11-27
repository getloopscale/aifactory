@AGENTS.md

## Claude Code Extensions

This project includes LoopZero-aware skills that activate automatically when you edit relevant files.

### Available Skills

| Skill             | Triggers when editing                                                  | What it provides                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loopzero-routes   | `src/server/routes/**`                                                 | the route() builder, Zod validation, HTTP methods, dynamic params                                                                                              |
| loopzero-gateways | `src/server/routes/**`, `**/*webhook*`                                 | handleChannelWebhook, the `@getloopscale/loopzero-gateway-*` adapters, signature validation, the onMessage seam                                                |
| loopzero-agents   | `**/*agent*`, `**/*tool*`, `**/*Agent*`, `**/*Tool*`                   | @Agent, @Tool, @Toolbox decorators, LLM integration                                                                                                            |
| loopzero-database | `**/*schema*`, `**/*db*`, `**/drizzle*`, `**/*migration*`, `**/*seed*` | Drizzle ORM, SQLite, schema patterns, migrations                                                                                                               |
| loopzero-frontend | `src/app/**`                                                           | File-based routing, layouts, loopZeroFetch, useAgent                                                                                                           |
| loopzero-ui       | `src/app/**`, `**/*Chat*`, `**/*Sidebar*`, `**/*Theme*`                | @getloopscale/loopzero-ui AI components: ChatThread, ChatMessage, ToolCallCard, theming (generic primitives like CodeBlock/Sidebar come from @getloopscale/ui) |
| loopzero-config   | `loopzero.config*`, `**/*config*`                                      | the config() builder, plugins, security, storage                                                                                                               |

### Settings

See `.claude/settings.json` for safe-default permissions.

### Customization

Add project-specific context below this line (team conventions, business domain, external APIs):

<!-- YOUR PROJECT CONTEXT HERE -->
