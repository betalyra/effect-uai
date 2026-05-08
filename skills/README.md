# Agent skills for effect-uai

Drop-in skills that teach an AI coding agent how to build with
`effect-uai` — what the primitives are, how to wire providers, and
which recipe pattern to reach for in a given scenario. Distributed
via the [skills.sh](https://skills.sh) CLI.

## Layout

```
skills/
├── effect-uai/                              # main skill: philosophy + primitives + provider wiring
├── effect-uai-basic-usage/                  # canonical agent loop with tools
├── effect-uai-structured-output/            # one typed JSON object back from the model
├── effect-uai-streaming-structured-output/  # JSONL streamed object-by-object
├── effect-uai-tool-call-approval/           # human-in-the-loop verdicts
├── effect-uai-streaming-tool-output/        # tools that emit progress + a clean result
├── effect-uai-agentic-loop/                 # long-lived chat with a debounced input queue
├── effect-uai-model-retry/                  # retry transient failures with exponential backoff
├── effect-uai-multi-model-fallback/         # tier list — fall back on retryable errors
├── effect-uai-auto-compaction/              # summarize history when it exceeds a budget
├── effect-uai-pause-resume/                 # soft pause between turns via a Latch
├── effect-uai-mid-stream-abort/             # cancel an in-flight turn cleanly
├── effect-uai-multi-model-compare/          # fan one prompt to N providers; tag each delta
├── effect-uai-model-council/                # cross-evaluation; emit a winner
├── effect-uai-modify-output-stream/         # project the loop output as SSE / JSONL
└── effect-uai-embedding/                    # text + image embeddings, cross-modal & multivector
```

Each folder has one `SKILL.md` with frontmatter (`name`,
`description`) and a body. Skills load lazily — the agent reads only
the descriptions until one matches the user's intent — so installing
all 16 has no token cost until something triggers.

## Installation

Install via the [skills.sh](https://skills.sh) CLI. Both forms work
in any agent / IDE the CLI supports.

**All skills (main + every recipe)** — recommended for regular
`effect-uai` users:

```sh
npx skills add betalyra/effect-uai
```

The CLI auto-discovers the `skills/` directory in the repo and
installs every `SKILL.md` it finds.

**Just the main skill** — generic primer; recipe sub-skills not yet
indexed:

```sh
npx skills add betalyra/effect-uai/tree/main/skills/effect-uai
```

**Cherry-pick a recipe skill**:

```sh
npx skills add betalyra/effect-uai/tree/main/skills/effect-uai-model-retry
npx skills add betalyra/effect-uai/tree/main/skills/effect-uai-agentic-loop
# ...etc
```

The frontmatter follows the
[Agent Skills specification](https://agentskills.io/specification)
(`name`, `description`, `license`).

## How to use these

1. **Install all 16** if you're a regular `effect-uai` user. Skills
   only load when their description matches; the surface stays clean.
2. **Install only the main skill** if you want a generic primer for
   when you build agents in Effect — Claude will know the philosophy
   and primitives, then suggest the recipe sub-skills as you describe
   specific patterns.
3. **Cherry-pick recipe skills** for a project that needs only a few
   patterns (e.g. a chat backend might only want `effect-uai-basic-usage`,
   `effect-uai-agentic-loop`, `effect-uai-model-retry`,
   `effect-uai-modify-output-stream`).

## When the agent reaches for which

The main skill (`effect-uai`) loads on broad signals like "I'm
building an AI agent in Effect" or "wire up the LanguageModel
service." Each recipe skill loads on a specific scenario described
by the user; the skill's description is the trigger.

| User says (paraphrased)                                          | Skill                                         |
| ---------------------------------------------------------------- | --------------------------------------------- |
| "Build an agent that can call tools"                             | `effect-uai-basic-usage`                      |
| "Have the model return typed JSON / fill a form"                 | `effect-uai-structured-output`                |
| "Stream typed objects as the model writes them"                  | `effect-uai-streaming-structured-output`      |
| "Approve sensitive tool calls before execution"                  | `effect-uai-tool-call-approval`               |
| "Show progress while a tool runs"                                | `effect-uai-streaming-tool-output`            |
| "Long-lived chat agent with a queue"                             | `effect-uai-agentic-loop`                     |
| "Retry on rate limits / 5xx with exponential backoff"            | `effect-uai-model-retry`                      |
| "Fall back from one provider to another"                         | `effect-uai-multi-model-fallback`             |
| "Summarize history when it gets too long"                        | `effect-uai-auto-compaction`                  |
| "Pause the loop between turns and resume later"                  | `effect-uai-pause-resume`                     |
| "Stop button / abort the current model response"                 | `effect-uai-mid-stream-abort`                 |
| "Compare answers from multiple models side-by-side"              | `effect-uai-multi-model-compare`              |
| "Have models judge each other and pick a winner"                 | `effect-uai-model-council`                    |
| "Stream the output as SSE / JSONL"                               | `effect-uai-modify-output-stream`             |
| "Embed text or images / semantic search / RAG retrieval / multivector" | `effect-uai-embedding`                  |

## Authoring conventions

If you fork or extend these, keep the conventions:

- **Frontmatter is the trigger.** The `description` is what the
  agent sees by default; make it specific about *when* to use the
  skill, not what the skill is.
- **Skill body is short and practical.** Open with one paragraph on
  when to reach for it, then the loop body or pipeline shape, then a
  small set of gotchas / anti-patterns. Link to the recipe source for
  the full detail.
- **One skill per recipe.** Don't bundle multiple recipes into one
  skill — retrieval is description-keyed and bundling dilutes
  triggers.
- **Code samples are typecheck-clean.** They get pasted into user
  projects; broken samples cost more than missing ones.
- **Reference each other.** A "See also" section at the bottom of
  each skill lets the agent follow the chain — e.g.
  `effect-uai-agentic-loop` references `effect-uai-mid-stream-abort`
  and `effect-uai-pause-resume`.

## License

MIT — same as `effect-uai` itself.
