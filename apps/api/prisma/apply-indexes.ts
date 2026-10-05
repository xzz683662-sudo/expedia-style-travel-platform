import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';

/**
 * Splits a SQL file into individually executable statements.
 *
 * `$executeRawUnsafe` sends its argument through a *prepared statement*, and
 * Postgres rejects more than one command per prepared statement with
 * `42601: cannot insert multiple commands into a prepared statement`. So the
 * file has to be split rather than sent whole — a driver-level detail that has
 * nothing to do with the SQL, which is why it is handled here and not by making
 * the `.sql` file less readable.
 *
 * Dollar-quoted bodies (`$$ ... $$`, used by `search_unaccent`) legitimately
 * contain semicolons inside them, so a naive `split(';')` would cut the function
 * in half. Line comments are dropped for the same reason a `--` inside a
 * statement would otherwise be re-joined into nonsense.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;

  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (!inDollarQuote && (line === '' || line.startsWith('--'))) continue;

    current += `${rawLine}\n`;

    // A `$$` toggles the dollar-quoted region. Occurrences are counted rather
    // than tested for parity, because one line can open and close the body.
    const markers = line.split('$$').length - 1;
    if (markers % 2 === 1) inDollarQuote = !inDollarQuote;

    if (!inDollarQuote && line.endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Applies `prisma/indexes.sql`.
 *
 * Runs the file statement by statement, so it needs no `psql` binary and works
 * from the same `pnpm` context as `db:push`. The SQL itself is idempotent
 * (`create ... if not exists`, `create or replace`), so running this repeatedly
 * is safe and it can be wired into `pnpm setup` unconditionally.
 *
 * `prisma db push` does not remove these indexes, because they are not in
 * `schema.prisma` — which is the point: Prisma cannot express a trigram operator
 * class or a functional index, so they have to be owned outside it.
 */
async function main(): Promise<void> {
  const file = resolve(__dirname, 'indexes.sql');
  const statements = splitStatements(readFileSync(file, 'utf8'));

  try {
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
  } catch (error) {
    // A failure here is worth failing loudly: the whole point of this script is
    // that search performance depends on it, and a table with no trigram index
    // degrades silently to a Seq Scan rather than erroring at query time.
    logger.error('indexes.apply_failed', { file, reason: (error as Error).message });
    throw error;
  }

  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `select indexname from pg_indexes where tablename = 'SearchDocument' order by indexname`,
  );
  const added = rows.map((r) => r.indexname).filter((n) => n.includes('trgm'));
  logger.info('indexes.applied', { statements: statements.length, created: added, total: rows.length });
}

main()
  .catch(() => process.exitCode = 1)
  .finally(() => void prisma.$disconnect());
