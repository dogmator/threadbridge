# Architecture

## Overview

ThreadBridge is a deliberately small modular monolith using a simplified Hexagonal Architecture.

```text
Fastify HTTP adapter
        |
        v
Application use cases
        |
        v
Domain model and ports
        |
        v
PostgreSQL and social-platform adapters
```

[`SPECIFICATION.md`](../SPECIFICATION.md) is the behavioral and architectural contract. This
document explains the implementation boundaries and runtime invariants without creating a second
contract.

ThreadBridge has one application deployable unit. PostgreSQL is a separate infrastructure service.
No worker, broker, scheduler, outbox, or webhook runtime exists until concrete behavior requires it.

## HTTP boundary

The Fastify adapter owns transport concerns only:

- path, header, query, and JSON-body validation;
- request-body and field limits;
- conversion into application input;
- HTTP status, headers, DTOs, and safe error envelopes;
- server-generated request correlation IDs;
- liveness/readiness endpoints and structured request logging.

Business rules and provider-specific branching do not belong here.

A syntactically invalid identifier is rejected before an application port is called. A valid but
unknown identifier becomes the corresponding core not-found failure. Unexpected dependency errors
become one static `INTERNAL_ERROR` response; exception messages and infrastructure details are not
returned to the client.

### Request limits and connection containment

Fastify enforces a 64 KiB body limit on received bytes. `POST /comments` also checks the media type
before the use case runs. An oversized body (`413`) or unsupported media type (`415`) makes the
connection non-reusable and drains unread request bytes without buffering them, so leftover input
cannot be parsed as another request on the connection.

Transport-local field limits are 200 characters for an idempotency key after HTTP field-value
parsing with no additional application canonicalization, 10,000 for
reply content, and 4,096 for a cursor. Accepted content is never normalized or rewritten. Provider
cursors remain opaque and reach the selected adapter unchanged.

The request receive phase is bounded to 30 seconds. There is deliberately no generic application
handler timeout around reply publication: returning a timeout while an external non-idempotent write
continues would make the API claim an outcome it cannot know. Provider adapters must instead report
typed retryable or indeterminate outcomes according to what the provider can prove.

### Correlation and logging

Fastify generates the correlation ID through the configured request-ID factory. Caller-provided
`x-request-id` values do not become the trusted server request ID.

Production request logs contain only the generated request ID, HTTP method, route template, response
status, and elapsed time. Raw URLs and query strings, headers, bodies, credentials, and exception
messages are deliberately excluded. Successful `/health` and `/ready` requests are omitted from
completion logs; a failed readiness probe emits a sanitized warning.

### Liveness and readiness

`GET /health` is process liveness and does not depend on PostgreSQL or a provider.

`GET /ready` executes a minimal PostgreSQL query. It returns `200` only when the database is usable
and returns a detail-free `503` otherwise. Provider availability is intentionally not part of
readiness: a provider outage must not remove every API instance from service discovery.

## Application layer

Application use cases coordinate behavior through typed ports:

- `GetPostComments` retrieves one root-comment page;
- `GetCommentReplies` retrieves one page of direct children;
- `ReplyToComment` owns reply-publication orchestration and recovery.

Application code depends on domain types and ports, not Fastify, PostgreSQL, provider SDKs, or
container/runtime APIs. Provider names are not branch conditions in use cases. Adding a provider
means implementing the existing gateway port and registering the adapter in the composition root.

External platform calls must never execute while a PostgreSQL transaction or lock is held.

## Provider boundary

Each `SocialCommentsGateway` declares the operations it supports and whether reply publication has a
provider-side idempotency guarantee. Provider DTOs, cursor formats, credentials, and raw failures stay
inside the adapter.

The demo gateways prove multiple capability shapes without credentials or network access. Their
published data is in-memory fixture behavior; PostgreSQL durability does not turn those fixtures into
a real provider. A production adapter queries the external source of truth and owns provider-specific
timeouts and outcome classification.

## Persistence

PostgreSQL stores the latest normalized comment projection and durable reply-publication operation
state. The external platform remains the source of truth for published content and provider
identifiers.

The comment hierarchy is an adjacency list. A composite foreign key enforces that a reply belongs to
the same post as its parent while preserving arbitrary depth and null parents for root comments.

Comment imports upsert on external identity. The `version` column provides a verified
compare-and-set persistence boundary, although no current edit command consumes it.

### Connection lifecycle

The API PostgreSQL client uses a five-second connection-establishment timeout and an explicit
`application_name`. Shutdown closes the pool with a bounded deadline.

Statement and lock timeouts are deliberately not hard-coded as global application constants. Their
safe values depend on representative query and migration workloads and on the production database
or pooler topology. They belong to the deployment/database-role policy after measurement rather than
to an arbitrary transport constant.

## Reply publication

Reply publication uses a durable operation before an external write.

1. The transport validates `POST /comments` and passes the parent ID, exact content, and idempotency
   key to `ReplyToComment`.
2. The use case resolves the active parent comment context and provider gateway. If the projection
   is no longer active, the parent derives its owning account for a narrow account-and-key lookup
   that may replay an already completed operation; it never creates or resumes provider work
   without an active context.
3. `ReplyPublicationOperationRepository.begin` creates or loads the operation identified by
   `(account_id, idempotency_key)` and compares its parent/request fingerprint.
4. Conflicting key reuse returns `IDEMPOTENCY_CONFLICT` without a provider call.
5. A `published` operation replays its stored comment.
6. Before any repeated provider call, the use case searches for a comment already stored under the
   account and key. If found, it marks the operation `published` and replays locally.
7. `indeterminate` and terminal `failed` operations replay their recorded outcome without another
   provider call.
8. A `pending` operation reaches a provider again only when that provider declares native
   publication idempotency. Otherwise it becomes `indeterminate` rather than risking a duplicate.
9. The provider is invoked with no PostgreSQL transaction or lock held.
10. A confirmed reply is stored in a short local transaction. Only afterwards is the durable
    operation marked `published`.
11. Provider failures are recorded as `retryable_failed`, `failed`, or `indeterminate` according to
    the adapter's typed outcome.

The operation table therefore owns durable request identity. The comment's optional idempotency key
is a recovery index, not global request ownership and not globally unique; the same client-chosen key
may be used by different connected accounts.

### Failure classification

A timeout, rate limit, or temporary unavailability is `retryable_failed` only when the adapter can
establish that no external write took effect. Authentication, permission, validation, unsupported
operation, and confirmed missing-resource failures are terminal for the unchanged request. When the
external side effect cannot be proven either way, the adapter reports
`INDETERMINATE_PLATFORM_RESULT` and ThreadBridge does not perform a blind retry.

If a provider reports that the parent resource no longer exists, the local projection can be marked
deleted through the explicit projection-state port. That local update remains separate from the
provider call.

Read-only operator diagnostics are documented in
[`publication-operations.md`](./publication-operations.md).

## Migrations

Migrations are numbered SQL files applied in filename order. Before any lock or DDL, the runner
verifies PostgreSQL 18+ because the schema uses the built-in `uuidv7()` function.

One reserved connection holds a session advisory lock for the complete migration run. Each pending
migration is then executed in its own transaction. Applied files are recorded with SHA-256 checksums.
The runner fails closed when an applied file was modified or removed, or when existing history cannot
be verified; it never rewrites history to make a run pass.

The application startup path runs migrations before creating the HTTP listener. The standalone
compiled migration entry point uses the same `migrateDatabase` implementation, so deployment tooling
can run migrations separately without maintaining a second migration contract.

Large-database and zero-downtime limitations are documented in [`migrations.md`](./migrations.md).

## Process and container lifecycle

The production image runs compiled JavaScript directly with Node.js as PID 1. There is no shell
wrapper in the normal runtime command. Startup performs migrations in the same Node process before
the API components are created and before the listener opens.

The final image runs as the non-root `node` user and contains only production dependencies, compiled
application artifacts, package metadata, and migration SQL. It does not contain source TypeScript,
tests, `tsx`, or other dev-only dependencies.

CI proves the runtime starts with a read-only root filesystem, all Linux capabilities dropped, and
`no-new-privileges`. The local Compose definition mirrors those restrictions and provides a small
`/tmp` tmpfs for runtime compatibility.

Base images are pinned by version and digest. The digest makes an identical repository commit build
against the same base artifact; it does not replace vulnerability scanning or periodic security
repinning.

## Shutdown

One idempotent routine handles `SIGTERM` and `SIGINT`. A second signal joins the existing shutdown
instead of starting competing cleanup.

Shutdown order is deliberate:

1. stop accepting new HTTP connections;
2. close idle keep-alive connections immediately;
3. allow active HTTP work up to five seconds;
4. force-close remaining HTTP connections after that deadline;
5. close PostgreSQL resources with their own bounded five-second window.

A clean shutdown sets exit code `0`. A failure writes one static diagnostic that cannot leak a
connection string and sets exit code `1`. `process.exit()` is not used.

Because the two bounded phases can consume up to ten seconds sequentially, the local Compose
scheduler gives the application 15 seconds before forced termination. Production schedulers must
provide at least the same termination budget.

## Dependency direction

Dependencies point inward:

- domain code depends only on domain code;
- ports may depend on domain types, never application or infrastructure;
- application code depends on domain and ports;
- adapters implement ports;
- the composition root creates concrete adapters and use cases.

These boundaries are enforced by type-aware ESLint import restrictions. Mutable global state,
Service Locator, Generic Repository, and Active Record patterns are not used.

## Asynchronous evolution

The current application is synchronous. A future scheduler, webhook receiver, or background
coordinator must invoke the same application use cases or narrow ports, persist durable cursors or
checkpoints in PostgreSQL, and keep provider calls outside database transactions.

Splitting that coordinator into another process is a later deployment decision. ThreadBridge does
not prebuild a worker service, message broker, Transactional Outbox, scheduler abstraction, webhook
infrastructure, polling tables, or a universal event model before concrete behavior requires it.

## Deliberate non-goals

The current project deliberately does not implement:

- authentication or authorization;
- provider credential management;
- deployment-wide TLS/ingress and abuse/rate-limit policy;
- metrics or distributed tracing;
- automatic polling, webhooks, reconciliation, or background workers;
- message brokers or Transactional Outbox;
- recursive loading of an entire comment subtree;
- a generic transaction manager around external calls.

Those are deployment or future-product concerns, not hidden guarantees of the current service.
