-- DropIndex
DROP INDEX "SystemObservation_systemId_observedAt_idx";

-- CreateIndex
CREATE INDEX "SystemObservation_systemId_receivedAt_idx" ON "SystemObservation"("systemId", "receivedAt");
