-- A reply must belong to the post its parent belongs to.
--
-- Nothing in the application constructs a cross-post reply, but the invariant was only implied by
-- application code. It is declared here instead, so a bug or a manual write cannot attach a reply
-- to a parent from another post.
--
-- The composite foreign key needs a unique key on the referenced columns. (id) is already the
-- primary key, so (id, post_id) is unique by construction; the extra unique constraint records
-- that for PostgreSQL rather than introducing a new rule.
--
-- The foreign key uses the default MATCH SIMPLE semantics: it is not enforced when any referencing
-- column is null. parent_comment_id is null exactly for root comments and post_id is never null,
-- so root comments stay valid while every reply is checked. Reply depth remains unrestricted,
-- because a reply is checked against its own parent and not against a root.

alter table comments
    add constraint comments_id_post_id_key
        unique (id, post_id);

alter table comments
    add constraint comments_parent_comment_same_post_fkey
        foreign key (parent_comment_id, post_id)
        references comments (id, post_id);
