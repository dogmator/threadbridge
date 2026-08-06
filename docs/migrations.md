# Migration operations

ThreadBridge supports PostgreSQL 18 or newer. The checked-in schema uses PostgreSQL 18's built-in
`uuidv7()` function, and the migration runner validates `server_version_num` before it takes the
migration lock or executes any DDL.

ThreadBridge applies every checked-in migration in filename order. The runner reserves one database
session, takes a session-level advisory lock for the whole run, and executes each migration in its
own transaction. Applied files are recorded with SHA-256 checksums and must never be edited in
place.

## Supported deployment shapes

| Deployment shape | Built-in migration runner |
| --- | --- |
| Clean installation on PostgreSQL 18+ | Supported |
| Small or moderate existing database in a controlled deployment window | Supported after measuring the migration on representative data |
| Large database with an acceptable maintenance window | Deployment-specific; proceed only after measuring lock and backfill time |
| Large database requiring a zero-downtime schema change | Not supported by the built-in runner |
| `CREATE INDEX CONCURRENTLY` or `DROP INDEX CONCURRENTLY` | Requires an external non-transactional operational procedure |

Merging a schema change does not establish that it is safe to apply automatically to an arbitrary
large production database. A concrete large deployment still needs a representative-data rehearsal,
a recoverable backup or snapshot, and an execution window based on observed lock time.

## Provider-boundary hardening migration

Migration `0004_provider_boundary_hardening.sql` separates column creation, data backfill, and
nullability/default enforcement. This makes the transition explicit and testable, but it does not
make the migration lock-free:

- the lifecycle backfill updates every existing comment row;
- the final `NOT NULL` and check constraints may scan or lock the table;
- replacing `comments_idempotency_key_idx` and creating `comments_active_parent_idx` use ordinary
  transactional index DDL.

The migration verifies the exact catalog definition of the baseline
`comments_idempotency_key_idx` before removing it. A missing index, a non-unique replacement, a
changed column, or a changed predicate is treated as schema drift. The migration stops instead of
removing an unknown object.

## Why concurrent index DDL is not embedded

`CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` cannot run inside a transaction. Every
checked-in migration intentionally runs in its own transaction, so concurrent index DDL is outside
the current runner contract.

A high-volume installation that needs online index replacement must design and rehearse a separate
non-transactional procedure around its own traffic, replication, backup, and rollout constraints.
Adding a second migration execution mode or publishing a universal concurrent-index recipe is outside
the current runtime contract.

## Failure policy

Known schema objects are referenced by their exact checked-in definitions rather than guarded with
`IF EXISTS`. A missing or structurally different object indicates schema drift, and failing with a
specific diagnostic is safer than silently certifying an unexpected database state.

Before a concrete deployment, operators should at minimum verify PostgreSQL 18+, rehearse the
migration against representative data, measure blocking statements, and confirm a recovery path.
