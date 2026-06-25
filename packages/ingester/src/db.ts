import { PrismaClient } from "@prisma/client";

// A single Prisma client for the process. DATABASE_URL is read from the environment.
let client: PrismaClient | undefined;

export function db(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
