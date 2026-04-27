---
name: otp-thinking
description: Use when implementing GenServer, Supervisor, Task, Registry, PubSub, process state, retries, scheduling, queues, or BEAM fault-tolerance design.
license: Apache-2.0
---
# OTP Thinking

Use this skill when runtime behavior matters.

## Principles

- A GenServer is a serialization point; use it only when that bottleneck is intentional.
- Supervisors restart processes; design what state is lost, rebuilt, or persisted.
- Prefer Tasks for one-off concurrent work and GenServer for owned lifecycle/state.
- Use Registry or process names when discovery is required; avoid global names for per-tenant/per-user resources.
- Think about mailbox growth, back-pressure, timeouts, and crash loops.
- "Let it crash" means design recovery, not ignore errors.

## Workflow

1. Define the runtime reason for each process.
2. Define ownership of state and messages.
3. Pick supervision strategy and restart policy.
4. Specify observability: logs, telemetry, and failure signals.
5. Validate with focused unit tests plus concurrency/failure tests where useful.
