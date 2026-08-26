## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For questions specifically about this project's codebase, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Only use Graphify for files, code, architecture, symbols, and relationships inside this project repository. Do NOT query Graphify for Claude configuration, plugins, ~/.claude, global tools, system files, external projects, or files outside this repository.
- For non-codebase questions or files outside this repository, use normal search and file tools directly without querying Graphify first.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

- Use Ponytail in lite mode for this project. Do not reduce test coverage or remove existing tests unless explicitly requested.