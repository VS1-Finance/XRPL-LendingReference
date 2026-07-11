-- CreateTable
CREATE TABLE "Session" (
    "setupId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vaultId" TEXT,
    "brokerId" TEXT,
    "domainId" TEXT,
    "shareMptId" TEXT,
    "env" JSONB NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("setupId")
);

-- CreateTable
CREATE TABLE "SeatOccupancy" (
    "setupId" TEXT NOT NULL,
    "seatKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "participant" TEXT,

    CONSTRAINT "SeatOccupancy_pkey" PRIMARY KEY ("setupId","seatKey")
);

-- CreateTable
CREATE TABLE "ActionLog" (
    "id" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "hash" TEXT,
    "params" JSONB,

    CONSTRAINT "ActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionLog_setupId_seq_idx" ON "ActionLog"("setupId", "seq");

-- AddForeignKey
ALTER TABLE "SeatOccupancy" ADD CONSTRAINT "SeatOccupancy_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Session"("setupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionLog" ADD CONSTRAINT "ActionLog_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Session"("setupId") ON DELETE CASCADE ON UPDATE CASCADE;
