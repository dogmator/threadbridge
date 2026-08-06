-- Deterministic data for the limited demonstrational platform adapter.
--
-- The account and post make the second registered provider reachable through the public REST API
-- without credentials or network access. Their external identifiers match the fixtures in
-- apps/api/src/adapters/demo/limited-demo-comments-gateway.ts.

insert into accounts (id, platform, external_account_id, credential_reference)
values ('0198f000-0000-7000-8000-000000000003', 'demo-limited', 'demo-limited-account-1', null)
on conflict (platform, external_account_id) do nothing;

insert into posts (id, account_id, external_post_id, published_at)
values (
    '0198f000-0000-7000-8000-000000000004',
    '0198f000-0000-7000-8000-000000000003',
    'limited-post-1',
    timestamptz '2026-01-01 00:01:00+00'
)
on conflict (account_id, external_post_id) do nothing;
