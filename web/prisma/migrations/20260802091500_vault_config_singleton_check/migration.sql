-- VaultConfig is meant to hold exactly one row. `id` defaulting to the
-- literal 'singleton' makes a second `create` collide on the primary key
-- ONLY when the caller omits `id` -- that is an application-level promise,
-- not a database guarantee. A caller that supplies any other id (e.g.
-- 'not-singleton') would otherwise create a second row with no violation,
-- and every later part of the vault assumes there is exactly one config row
-- holding the wrapped vault keys. This CHECK constraint closes that gap at
-- the database layer regardless of what any caller does; the @default is
-- kept for ergonomics, this constraint is the actual guarantee.
ALTER TABLE "VaultConfig" ADD CONSTRAINT "VaultConfig_singleton" CHECK (id = 'singleton');
