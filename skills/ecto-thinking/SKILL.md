---
name: ecto-thinking
description: Use when changing Ecto schemas, changesets, contexts, queries, migrations, Repo calls, preloads, transactions, or multi-tenant data access.
license: Apache-2.0
---
# Ecto Thinking

Use this skill for persistence and data modeling decisions.

## Principles

- Schemas model persistence; contexts model domain operations.
- Prefer context functions that accept explicit scope/current user/current account where authorization matters.
- Use changesets as boundary validators; multiple changesets per schema are normal.
- Keep cross-context references as IDs unless both sides belong to the same bounded domain.
- Choose preload strategy based on data shape: separate preloads for fan-out, joins for filtering/sorting, and explicit selects for large data.
- Use `Ecto.Multi` when multiple operations must succeed or fail together and need names for error handling.
- Migrations should be reversible or explain why not.

## Workflow

1. Identify ownership and boundary of the data.
2. Decide whether the change belongs in schema, changeset, query, context, or migration.
3. Add tests for valid changes, invalid changes, authorization/scope, and transaction failure paths.
4. Validate with `mix format`, `mix compile --warnings-as-errors`, and focused tests.
