# MORROW

A local-first AI operating environment: an operator that plans, uses tools with
permission, remembers with provenance, verifies its work and keeps persistent
project context — living on your machine.

This repository currently contains the **foundation**: process boundaries, typed
events, the task state machine, the tool and permission architecture, SQLite
persistence, the model and memory abstractions, and the MORROW shell.

- [Architecture](docs/architecture.md)
- [Design system](docs/design-system.md)
- [Development](docs/development.md)
- [Decisions](docs/decisions.md)

```bash
pnpm install && pnpm build:runtime && pnpm dev
```
