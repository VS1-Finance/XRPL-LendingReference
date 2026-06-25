-- CreateTable
CREATE TABLE "transactions" (
    "txHash" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "ledgerIndex" INTEGER NOT NULL,
    "resetEpoch" INTEGER NOT NULL DEFAULT 0,
    "txType" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("txHash")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "correlationId" TEXT,
    "type" TEXT NOT NULL,
    "ledgerIndex" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "persistedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_cursor" (
    "setupId" TEXT NOT NULL,
    "lastLedgerIndex" INTEGER NOT NULL,
    "resetEpoch" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingest_cursor_pkey" PRIMARY KEY ("setupId")
);

-- CreateTable
CREATE TABLE "state_vault" (
    "setupId" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "assetsTotal" BIGINT NOT NULL DEFAULT 0,
    "assetsAvailable" BIGINT NOT NULL DEFAULT 0,
    "lossUnrealized" BIGINT NOT NULL DEFAULT 0,
    "shareOutstanding" BIGINT NOT NULL DEFAULT 0,
    "updatedLedger" INTEGER NOT NULL,
    "resetEpoch" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "state_vault_pkey" PRIMARY KEY ("setupId")
);

-- CreateTable
CREATE TABLE "state_loan" (
    "setupId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "principalOutstanding" BIGINT NOT NULL DEFAULT 0,
    "totalOutstanding" BIGINT NOT NULL DEFAULT 0,
    "paymentRemaining" INTEGER NOT NULL DEFAULT 0,
    "updatedLedger" INTEGER NOT NULL,
    "resetEpoch" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "state_loan_pkey" PRIMARY KEY ("setupId","loanId")
);

-- CreateTable
CREATE TABLE "state_broker" (
    "setupId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "coverAvailable" BIGINT NOT NULL DEFAULT 0,
    "debtTotal" BIGINT NOT NULL DEFAULT 0,
    "updatedLedger" INTEGER NOT NULL,
    "resetEpoch" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "state_broker_pkey" PRIMARY KEY ("setupId")
);

-- CreateTable
CREATE TABLE "state_credential" (
    "setupId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updatedLedger" INTEGER NOT NULL,
    "resetEpoch" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "state_credential_pkey" PRIMARY KEY ("setupId","subject","credentialType")
);

-- CreateIndex
CREATE INDEX "transactions_setupId_idx" ON "transactions"("setupId");

-- CreateIndex
CREATE INDEX "transactions_ledgerIndex_idx" ON "transactions"("ledgerIndex");

-- CreateIndex
CREATE INDEX "transactions_setupId_ledgerIndex_idx" ON "transactions"("setupId", "ledgerIndex");

-- CreateIndex
CREATE INDEX "events_setupId_idx" ON "events"("setupId");

-- CreateIndex
CREATE INDEX "events_correlationId_idx" ON "events"("correlationId");

-- CreateIndex
CREATE INDEX "events_setupId_ledgerIndex_seq_idx" ON "events"("setupId", "ledgerIndex", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_txHash_key" ON "outbox"("txHash");

-- CreateIndex
CREATE INDEX "outbox_persistedAt_idx" ON "outbox"("persistedAt");

-- CreateIndex
CREATE INDEX "state_loan_setupId_idx" ON "state_loan"("setupId");

-- CreateIndex
CREATE INDEX "state_credential_setupId_idx" ON "state_credential"("setupId");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_txHash_fkey" FOREIGN KEY ("txHash") REFERENCES "transactions"("txHash") ON DELETE CASCADE ON UPDATE CASCADE;
