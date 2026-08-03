-- Task 8 fix round 1 (C2b): a run-level record of every external sweep,
-- separate from "ExternalProbeResult" and written on EVERY run including
-- one that reached nothing -- the fleet-wide banner needs a directly
-- queryable "when did the last sweep run, and did it reach anything" fact
-- instead of an inference over per-hostname rows with no time bound. See
-- schema.prisma's own docstring on this model for the full reasoning.
--
-- Purely additive, same as ExternalProbeResult before it: nothing to
-- backfill, nothing for old code to be broken by.
-- CreateTable
CREATE TABLE "ExternalProbeRun" (
    "id" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reachedAnything" BOOLEAN NOT NULL,

    CONSTRAINT "ExternalProbeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalProbeRun_ranAt_idx" ON "ExternalProbeRun"("ranAt");
