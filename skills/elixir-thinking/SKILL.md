---
name: elixir-thinking
description: Use when designing or changing Elixir modules, data flow, processes, protocols, behaviours, supervision, or general BEAM application structure.
license: Apache-2.0
---
# Elixir Thinking

Use this skill to reason about Elixir as a functional, concurrent BEAM language rather than an object-oriented language.

## Principles

- Modules group functions and names; they are not runtime objects.
- Use processes only when there is a runtime reason: concurrency, isolation, fault recovery, periodic work, or independent state.
- Keep pure transformations as plain functions and push side effects to boundaries.
- Prefer explicit data structures over hidden state.
- Use pattern matching and function heads to make control flow visible.
- Prefer behaviours for compile-time contracts, protocols for data polymorphism, and message passing for runtime coordination.

## Workflow

1. Identify the data shape and ownership.
2. Separate pure transformations from effects.
3. Decide whether a process is needed. If not, use a module of pure functions.
4. When a process is needed, define the lifecycle, supervision, failure mode, back-pressure, and observability.
5. Validate with `mix format`, `mix compile --warnings-as-errors`, and focused tests.
