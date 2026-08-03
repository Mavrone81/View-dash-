-- Fix round 1 (Task 9 review), M4: distinguishes "swept zero targets
-- because the fleet has no hostnames configured yet" from "swept some
-- targets and reached none of them" -- see schema.prisma's own docstring
-- on ExternalProbeRun.targetCount, and external-probe-runner.ts, for the
-- full reasoning. `DEFAULT 0` is a migration convenience only: this table
-- has never been deployed against live data (this whole slice is unshipped
-- as of this fix), so there is nothing real to backfill.
-- AlterTable
ALTER TABLE "ExternalProbeRun" ADD COLUMN     "targetCount" INTEGER NOT NULL DEFAULT 0;
