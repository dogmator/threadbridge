-- Deterministic demo data for the demonstrational platform adapter.
--
-- The specification defines no endpoint that creates accounts or posts, so the demo account and
-- the demo post are seeded here. The identifiers are fixed UUID v7 literals, which keeps the demo
-- post URL stable after every clean deployment. The external identifiers match the fixtures of the
-- demo gateway in apps/api/src/adapters/demo.

insert into accounts (id, platform, external_account_id, credential_reference)
values ('0198f000-0000-7000-8000-000000000001', 'demo', 'demo-account-1', null)
on conflict (platform, external_account_id) do nothing;

insert into posts (id, account_id, external_post_id, published_at)
values (
    '0198f000-0000-7000-8000-000000000002',
    '0198f000-0000-7000-8000-000000000001',
    'demo-post-1',
    timestamptz '2026-01-01 00:00:00+00'
)
on conflict (account_id, external_post_id) do nothing;
