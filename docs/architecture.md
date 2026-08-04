# Architecture

## Overview

ThreadBridge uses a deliberately small Hexagonal Architecture.

```text
HTTP API
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

[`SPECIFICATION.md`](../SPECIFICATION.md) is ThreadBridge's behavioral and architectural contract:
it records the behavior the service commits to, project assumptions, design decisions, and
non-goals. This document explains the intended implementation boundaries without redefining that
contract.

## HTTP API

The HTTP layer is responsible for:

- parsing and validating transport input;
- translating requests into application input;
- mapping application results and errors to HTTP responses;
- avoiding business rules and platform-specific branching.

A malformed path identifier is a transport concern: it is rejected as a validation error before any port is called, so a syntactically impossible identifier never reaches PostgreSQL. A well-formed identifier that simply does not exist is a core failure and is reported as not found. An unexpected exception from any dependency becomes one uniform internal error with a fresh request identifier and no detail of what failed.

### Bounded request reading

The body of a publication request is read through a small reader that stops at 64 KiB. A
`Content-Length` above the limit is refused before the first chunk, but that header is a client
claim, so the limit is enforced on the bytes actually received: a wrong length and a chunked body
that declares no length are bounded the same way. Once the limit is passed, buffering stops and
what was already buffered is dropped; the `413` is written immediately. The connection is marked
non-reusable and any unread bytes are then drained rather than stored, so an unfinished upload
cannot delay the response or be parsed as a following request. The media type is checked before
the body is read at all, so an unsupported type costs nothing and is handled by the same
non-reusable-connection rule.

Field limits — 200 characters for an idempotency key after trimming, 10,000 for content, 4,096 for
a cursor — are transport-local too. None of them rewrites the input: content is measured, never
normalized, and the exact accepted bytes are what is published and later compared. A cursor is only
measured; it stays opaque and reaches the adapter unchanged.

## Application layer

Application use cases coordinate the required behavior:

- retrieve root comments for a post;
- retrieve direct replies to a comment;
- publish a reply with idempotency.

Application code depends on domain types and ports rather than concrete PostgreSQL or social-platform adapters. External platform calls must not be held inside database transactions.

## Domain and ports

The domain defines normalized comment data, typed identifiers, results, errors, and the contracts required by the application layer.

Expected ports include:

- comment persistence;
- published-post and reply-context resolution;
- social-platform comment operations.

The domain must not depend on HTTP types, PostgreSQL clients, provider SDKs, or framework-specific abstractions.

## Adapters

PostgreSQL adapters maintain the local normalized projection.

Social-platform adapters:

- communicate with one concrete provider;
- translate provider data into normalized domain data;
- preserve provider cursors behind the adapter boundary;
- translate provider failures into internal typed errors.

Application code must not branch on platform names. Adding a platform requires implementing the existing platform port and registering the adapter in the composition root.

The demo gateway exists to prove the port end to end without credentials or network access. Its
fixtures are static and its published replies live in the memory of one adapter instance, so they
are forgotten when the process restarts. Because retrieval reports what the platform returns, a
reply published before a restart is no longer listed afterwards, while the local projection and the
idempotency guarantees, which are owned by PostgreSQL, survive it. That asymmetry belongs to the
demonstrational adapter and not to the architecture: a real adapter queries a platform that keeps
its own history.

## Persistence and consistency

The external platform remains the source of truth for published comments and provider identifiers. PostgreSQL stores the latest known normalized projection.

The comment hierarchy uses an adjacency-list relationship through a parent comment identifier. Root comments and direct replies are retrieved separately; recursively loading an arbitrary subtree is outside the current scope.

Repeated synchronization of the same external comment must not create duplicates.

### Migration history

Migrations are plain numbered SQL files applied in filename order, each in its own transaction and
each recorded with the SHA-256 checksum of the file that was applied. The recorded history is
treated as evidence about a deployed schema, so the runner refuses to continue when that evidence
stops matching the files: an edited migration, a migration that has disappeared from the directory,
and a history that predates checksums but already records applied migrations are all reported and
nothing further is applied. A checksum is never invented, rewritten, or deleted to make a run pass.

The whole run is serialized across instances by one global advisory lock. The runner reserves a
single connection, takes the lock on it, and holds it across history setup, validation, and every
pending migration, so instances starting together cannot both execute the same DDL: the second one
waits, then observes a completed history and applies nothing. The lock is session-scoped rather
than transaction-scoped because each migration keeps its own transaction — obtaining a
transaction-scoped lock would mean wrapping every migration in one giant transaction, trading a
real guarantee for a worse one. Because the sequence must stay on the locked session, and the
reserved handle of the checked-in client exposes no `begin`, each migration transaction is driven
explicitly with `begin`/`commit`/`rollback`. The lock is released in a `finally`, whether the run
succeeded, was rejected by validation, or failed inside a migration, and a failed release never
replaces the error that caused it.

### Parent and post consistency

A reply belongs to the post its parent belongs to. That was previously only an application
convention; it is now declared in the schema with a unique key on `(id, post_id)` and a composite
self-referencing foreign key from `(parent_comment_id, post_id)`. The default MATCH SIMPLE
semantics leave root comments unaffected, since their parent is null, while every reply is checked.
Depth stays unrestricted, because a reply is checked against its own parent rather than a root.
The constraint is a boundary guard, not an API surface: its violation is an internal error, never a
detail returned to a client.

### Optimistic locking

Every comment row carries a `version`. It supports the standard compare-and-set pattern: an update
that matches the expected version advances it, and an update carrying a stale expected version
changes nothing. An integration test proves that behavior against the real `comments` table, and
re-importing a known comment increments the version of the projection.

No use case performs optimistic locking today. Editing and deletion are out of scope, so nothing
supplies an expected version, and no versioned mutation port exists. The column and its verified
behavior are the persistence-side boundary that such a command would build on.

## Reply publication

Reply publication is synchronous:

1. the transport validates the request body and the `Idempotency-Key` header;
2. the reply context is resolved from the internal parent comment identifier;
3. an existing comment is looked up by idempotency key;
4. a match on parent and exact content replays the stored reply; any other match is a conflict;
5. the platform adapter is resolved and called outside every database transaction;
6. the confirmed reply is persisted by one short transaction that opens only afterwards;
7. the persisted row is compared with the request once more, because a concurrent request may have
   stored first;
8. the reply is returned as created or as already existing.

The same idempotency key with the same parent and the exact same content returns the existing
result, and a sequential replay never calls the platform twice. Reusing the key with a different
parent or different content produces a conflict.

### Idempotency and concurrency

One local row exists per idempotency key: a partial unique index enforces it, and the publication
transaction converges concurrent writers onto a single row rather than failing. Requests sharing a
key are serialized by a transaction-scoped advisory lock derived from that key, so the key is
claimed exactly once even if the platform answers two of them with different external comment
identifiers.

The mirrored case is one external comment reached by two different keys, which happens when the
platform deduplicates on its own side. PostgreSQL identifies one row there, so exactly one key can
own it:

- a row imported by retrieval carries no key yet and adopts the requesting one, keeping its
  internal identifier and its local creation timestamp;
- a row already carrying the requesting key is returned as the existing result;
- a row already carrying a different key keeps it. The request is not credited with a row it never
  owned: it is reported as an idempotency conflict rather than as a successful replay, no duplicate
  is written, and no database constraint error reaches the caller.

Neither the stored nor the requested key is ever exposed in a response.

### Provider idempotency versus local convergence

The guarantee described above is local, and it is worth being precise about where it stops.

PostgreSQL decides how many *rows* exist. It cannot decide how many *replies the platform created*,
because the platform call deliberately happens outside every transaction and lock: holding one
across a network call is exactly the failure mode this design refuses. Two concurrent requests
sharing a key can therefore both reach the adapter, and only the provider can decide what the
second one does.

That is why the idempotency key is passed through to the adapter. An adapter forwards it as the
provider's idempotency token, or relies on an equivalent provider guarantee; the demo adapter
deduplicates on its own side and is externally idempotent, which is what its concurrency test
proves. An adapter that cannot deduplicate externally must not be presented as exactly-once. What
the application still guarantees in that case is unchanged: one row, one identifier, one result for
both callers.

Without provider idempotency, reservation states, reconciliation, or an outbox, an external call
may also complete while its outcome stays unknown. That case is reported as a typed indeterminate
result, nothing is persisted, and nothing is retried automatically. This is the intended current
behavior, not an omission.

### Why no transaction manager

Every implemented write is owned by one adapter and is atomic as seen by the application, so no use
case needs to compose two writes. The external call happens before persistence and never runs
inside a transaction, which is precisely what a transaction manager must not be allowed to make
easy. An abstraction is added when behavior requires it.

## Shutdown

One idempotent routine handles `SIGTERM` and `SIGINT`. A second signal joins the run already in
progress instead of starting a competing one, and the routine never rejects, because a signal
handler has nowhere to report a rejection to.

The order is fixed. The server stops accepting connections, idle keep-alive connections are closed
at once — they hold no request and would otherwise keep the server open for the whole grace period
— and connections still serving a request get five seconds. If the server has not closed by then,
the remaining connections are force-closed. PostgreSQL is closed only after the HTTP server has
stopped or been forced, and it is closed even when stopping the server failed, because leaving a
pool open is worse than a partially closed server.

A clean shutdown sets exit code 0. A failure writes one static diagnostic to stderr — deliberately
static, since a shutdown error can carry a connection string — and sets exit code 1. The process
exit code is set rather than `process.exit` being called, so pending work is not cut off, and the
deadline timer is always cleared so nothing keeps the loop alive.

## Dependency direction

Dependencies point inward:

- domain code has no infrastructure dependencies;
- application code depends on ports;
- adapters implement ports;
- the composition root creates and connects concrete implementations.

Dependencies are supplied explicitly through constructor injection. Mutable global state and Service Locator patterns are not used.

## Deliberate constraints

The project avoids speculative infrastructure and abstractions, including:

- Generic Repository;
- Active Record in the application layer;
- provider conditionals in use cases;
- background workers;
- message brokers;
- Transactional Outbox;
- webhook ingestion;
- automatic polling and reconciliation.

These remain possible extension points rather than current implementation requirements.
