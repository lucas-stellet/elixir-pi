# elixir-pi

Pi package for Elixir projects: Mix post-edit hooks, Expert LSP bridge, commands, LLM tools, and Elixir/Phoenix/Ecto/OTP skills.

## Features

- **Auto-detection**: Detects Elixir projects via `mix.exs` and shows 🔮 Expert connection status
- **Post-edit hooks**: Runs `mix format`, `mix compile`, and `mix credo` automatically after file edits
- **Expert LSP bridge**: Full language server integration for diagnostics, hover, definitions, references, symbols, completions, rename, and formatting
- **LLM tools**: `elixir_mix` and `elixir_expert` tools callable by the agent
- **Slash commands**: `/elixir` and `/expert` with argument completions
- **Skills**: Domain-specific thinking skills for Elixir, Phoenix, Ecto, and OTP
- **Credo caching**: Checks credo availability once per project instead of on every edit

## Install

```bash
# Global (all projects)
pi install /path/to/elixir-pi

# Project-local (shareable via .pi/settings.json)
pi install -l /path/to/elixir-pi

# Try without installing
pi -e /path/to/elixir-pi
```

## Prerequisites

- `mix` on PATH
- `expert` on PATH (for LSP features)

## Structure

```
elixir-pi/
├── README.md
├── package.json
├── extensions/
│   ├── mix-format.ts        # Post-edit: mix format
│   ├── mix-compile.ts       # Post-edit: mix compile --warnings-as-errors
│   ├── mix-credo.ts         # Post-edit: mix credo (cached availability check)
│   ├── elixir-tools.ts      # elixir_mix tool + /elixir command
│   ├── elixir-expert.ts     # elixir_expert tool + /expert command + auto-start
│   ├── elixir-session.ts    # Project detection + system prompt guidance
│   └── lib/
│       ├── elixir-utils.ts      # Shared utilities (run commands, find mix root, etc.)
│       └── expert-lsp-client.ts # LSP client for Expert language server
└── skills/
    ├── elixir-thinking/     # General Elixir design patterns
    ├── phoenix-thinking/    # Phoenix and LiveView patterns
    ├── ecto-thinking/       # Ecto schemas, queries, migrations
    └── otp-thinking/        # OTP processes, supervisors, fault tolerance
```

## Slash Commands

### Mix helpers (`/elixir`)

```
/elixir doctor              # Check mix, expert, credo availability
/elixir format [file]       # Run mix format
/elixir compile             # Run mix compile --warnings-as-errors
/elixir credo               # Run mix credo
/elixir test [args...]      # Run mix test
```

### Expert LSP (`/expert`)

```
/expert status              # Show session status
/expert start               # Start Expert LSP
/expert restart             # Restart Expert LSP
/expert shutdown            # Shut down Expert LSP
/expert diagnostics [file]  # Show diagnostics
/expert hover <file> <line> <char>
/expert definition <file> <line> <char>
/expert references <file> <line> <char>
/expert symbols <file>
/expert completion <file> <line> <char>
/expert rename <file> <line> <char> <newName> [--apply]
/expert format <file> [--apply]
```

Positions are **1-based** for convenience. The extension converts to LSP's 0-based internally.

## LLM Tools

### `elixir_mix`

| Action | Description |
|--------|-------------|
| `doctor` | Check tool availability |
| `format` | Run mix format |
| `compile` | Run mix compile --warnings-as-errors |
| `credo` | Run mix credo (skips if not installed) |
| `test` | Run mix test |

### `elixir_expert`

| Action | Description |
|--------|-------------|
| `status` / `start` / `restart` / `shutdown` | Manage Expert sessions |
| `diagnostics` | Get published diagnostics |
| `hover` | Symbol information |
| `definition` | Go to definition |
| `references` | Find references |
| `document_symbols` | List file symbols |
| `completion` | Autocompletion candidates |
| `rename` | Preview/apply rename edits |
| `formatting` | Preview/apply formatting edits |

## Skills

| Skill | Use when |
|-------|----------|
| `/skill:elixir-thinking` | Designing modules, processes, protocols, behaviours |
| `/skill:phoenix-thinking` | Working on Phoenix, LiveView, controllers, contexts |
| `/skill:ecto-thinking` | Changing schemas, changesets, queries, migrations |
| `/skill:otp-thinking` | Implementing GenServer, Supervisor, Task, Registry |

## How Expert LSP Works

The bridge in `extensions/lib/expert-lsp-client.ts` implements a JSON-RPC/LSP client:

1. Starts one Expert process per project root on session start
2. Sends `initialize` with workspace/text-document capabilities
3. Responds to server requests (`client/registerCapability`, `workspace/configuration`, etc.)
4. Syncs `.ex`, `.exs`, `.heex`, `.leex` files with `didOpen`/`didChange`/`didSave`
5. Caches `textDocument/publishDiagnostics` notifications
6. Exposes LSP features as tools and commands
7. Applies text-only workspace edits inside the project root

## Configuration

### Environment variables

```bash
PI_ELIXIR_EXPERT_COMMAND=/path/to/expert   # Override Expert binary
PI_ELIXIR_EXPERT_ARGS="--stdio"            # Override Expert args
```

### Disable post-edit hooks

In `.pi/settings.json`:

```json
{
  "packages": [
    {
      "source": "/path/to/elixir-pi",
      "extensions": [
        "extensions/mix-format.ts",
        "extensions/elixir-tools.ts",
        "extensions/elixir-expert.ts",
        "extensions/elixir-session.ts"
      ]
    }
  ]
}
```

This keeps formatting, commands, Expert LSP, and skills but disables automatic compile/credo.

## Notes

- Expert starts automatically when opening an Elixir project
- Diagnostics depend on Expert publishing `textDocument/publishDiagnostics`; indexing may still be in progress after startup
- `rename` and `formatting` default to preview-only; pass `apply=true` or `--apply` to write edits
- Credo is only active when the dependency is installed in the project
