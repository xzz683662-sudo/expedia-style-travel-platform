/**
 * One-shot: fold `OPERATOR` and `MERCHANT` into `ADMIN`.
 *
 * Why this exists
 * ---------------
 * The platform converged on two staff surfaces (`/admin`, `/support`), so the
 * `UserRole` enum no longer carries `OPERATOR` or `MERCHANT`. Postgres cannot
 * simply drop an enum value that rows still use, and `prisma db push` rebuilds
 * the type by casting every existing row through the new label set — so a
 * database that still holds an operator or a merchant login fails the push with
 * `invalid input value for enum`.
 *
 * This script clears the rows first. It is deliberately run *before* the push.
 *
 * Why it is order-independent
 * ---------------------------
 * The predicate casts `role` to text:
 *
 *     WHERE role::text IN ('OPERATOR', 'MERCHANT')
 *
 * A cast to text is always valid, so the statement is a no-op when those labels
 * have already gone (fresh database, or a second run) instead of raising
 * `invalid input value for enum UserRole: "OPERATOR"`. That makes it safe to run
 * unconditionally in the seed pipeline without a "has the schema changed yet?"
 * probe.
 *
 * Run with:  pnpm --filter @easytrip/api migrate:roles
 */

import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';

const RETIRED_ROLES = ['OPERATOR', 'MERCHANT'] as const;

async function main(): Promise<void> {
  // Read current enum labels so the log states what was actually found rather
  // than re-printing the assumption. `pg_enum` is the authority, not the code.
  const labels = await prisma.$queryRawUnsafe<{ label: string }[]>(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'UserRole'
      ORDER BY e.enumsortorder`,
  );
  const present = labels.map((row) => row.label);

  const affected = await prisma.$queryRawUnsafe<{ email: string; role: string }[]>(
    `SELECT email, role::text AS role
       FROM "User"
      WHERE role::text = ANY($1::text[])`,
    [...RETIRED_ROLES],
  );

  if (affected.length === 0) {
    logger.info('migrate_roles.noop', {
      enumLabels: present,
      note: 'no OPERATOR/MERCHANT rows — nothing to fold into ADMIN',
    });
    return;
  }

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "User"
        SET role = 'ADMIN'
      WHERE role::text = ANY($1::text[])`,
    [...RETIRED_ROLES],
  );

  logger.info('migrate_roles.done', {
    updated,
    accounts: affected.map((row) => `${row.email}:${row.role}`),
    note: 'retired staff logins now hold ADMIN',
  });
}

main()
  .catch((error: unknown) => {
    logger.error('migrate_roles.failed', { reason: (error as Error).message });
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
