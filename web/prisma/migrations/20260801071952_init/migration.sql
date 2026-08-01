-- CreateTable
CREATE TABLE "Host" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Host_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "System" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "System_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemObservation" (
    "id" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "health" TEXT NOT NULL,
    "containersTotal" INTEGER NOT NULL,
    "containersRunning" INTEGER NOT NULL,
    "deployedSha" TEXT,
    "deployedSubject" TEXT,
    "deployedAt" TIMESTAMP(3),
    "driftCommits" INTEGER,

    CONSTRAINT "SystemObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEnrolment" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "secretSealed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AgentEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Host_name_key" ON "Host"("name");

-- CreateIndex
CREATE UNIQUE INDEX "System_hostId_key_key" ON "System"("hostId", "key");

-- CreateIndex
CREATE INDEX "SystemObservation_systemId_observedAt_idx" ON "SystemObservation"("systemId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEnrolment_tokenHash_key" ON "AgentEnrolment"("tokenHash");

-- AddForeignKey
ALTER TABLE "System" ADD CONSTRAINT "System_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemObservation" ADD CONSTRAINT "SystemObservation_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "System"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEnrolment" ADD CONSTRAINT "AgentEnrolment_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;
