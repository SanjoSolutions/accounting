CREATE TABLE "TenantMembership" (
    "ownerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL CHECK ("role" IN ('ADMIN', 'ACCOUNTANT', 'READ_ONLY')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TenantMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("ownerId", "userId")
);

CREATE INDEX "TenantMembership_userId_ownerId_idx" ON "TenantMembership"("userId", "ownerId");
