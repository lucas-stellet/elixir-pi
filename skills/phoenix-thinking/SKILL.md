---
name: phoenix-thinking
description: Use when working on Phoenix, LiveView, controllers, contexts, PubSub, routes, HEEx templates, components, or request/live navigation flows.
license: Apache-2.0
---
# Phoenix Thinking

Use this skill for Phoenix and LiveView changes.

## Principles

- Keep authorization and tenancy context explicit through the call chain.
- Keep controllers thin: parse request, call context, render response.
- Use contexts as domain boundaries; avoid leaking schema internals everywhere.
- In LiveView, `mount/3` sets up socket state and subscriptions; `handle_params/3` reacts to URL state.
- Avoid expensive database queries directly in `mount/3` when URL params or live navigation should drive the data.
- Use PubSub topics that include tenant/user/scope identifiers when data is scoped.
- For HEEx, keep assigns explicit and push complex logic into functions/components.

## Workflow

1. Determine whether the change belongs in router/controller, LiveView, component, or context.
2. Thread scope/current user/current account explicitly.
3. Update tests at the context and web boundary levels.
4. Validate with `mix format`, `mix compile --warnings-as-errors`, and focused Phoenix tests.
