-- Task 7a (slice 2a): store the external probe's results (Task 6) so the
-- board has a second axis to combine (Task 7) instead of reading
-- `unconfirmed` forever.
--
-- A brand-new table, purely additive: nothing to backfill, and nothing
-- for old code (running against this schema during the window between
-- "migrations applied" and "new code started" in a rolling deploy) to be
-- broken by -- old code simply never queries a table it does not know
-- exists. A rollback is symmetric for the same reason: new rows sit
-- unread by old code.
--
-- "status" and "certExpiresAt" are nullable because a failed probe (no
-- completed handshake) has neither -- see external-probe.ts's
-- `probeExternally` for why a certificate expiry is never inferred or
-- carried forward from a previous, different result. "outcome" and
-- "hostname" are NOT NULL: every stored row is the product of a probe
-- that actually ran against a named hostname, never a placeholder.
--
-- No unique constraint on "hostname": this table is a history (a fresh
-- row per run, matching "SystemObservation"'s shape), and "the latest
-- result" is the query in fleet-query.ts's `latestExternalResultsByHostname`
-- (DISTINCT ON "hostname" ORDER BY "observedAt" DESC), never a row
-- identity enforced here.
-- CreateTable
CREATE TABLE "ExternalProbeResult" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "status" INTEGER,
    "certExpiresAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalProbeResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalProbeResult_hostname_observedAt_idx" ON "ExternalProbeResult"("hostname", "observedAt");
