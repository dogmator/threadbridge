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

[`SPECIFICATION.md`](../SPECIFICATION.md) is the source of truth for required behavior, assumptions, and non-goals. This document explains the intended implementation boundaries without redefining that contract.

## HTTP API

The HTTP layer is responsible for:

- parsing and validating transport input;
- translating requests into application input;
- mapping application results and errors to HTTP responses;
- avoiding business rules and platform-specific branching.

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
- transaction management;
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

## Persistence and consistency

The external platform remains the source of truth for published comments and provider identifiers. PostgreSQL stores the latest known normalized projection.

The comment hierarchy uses an adjacency-list relationship through a parent comment identifier. Root comments and direct replies are retrieved separately; recursively loading an arbitrary subtree is outside the current scope.

Repeated synchronization of the same external comment must not create duplicates.

## Reply publication

Reply publication is synchronous:

1. validate the request body and the idempotency key;
2. load the parent comment, its post, and the connected account;
3. check whether the idempotency key was already used;
4. resolve the platform adapter and call the external platform outside a database transaction;
5. persist the confirmed result in a short transaction;
6. return the normalized reply.

The same idempotency key with the same input returns the existing result. Reusing the key with different input produces a conflict.

When the external result is indeterminate and provider idempotency is unknown, the application returns a typed error rather than retrying automatically.

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
