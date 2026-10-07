# ADR 0002 — Two staff surfaces, and therefore two staff roles

- **Status:** accepted
- **Date:** 2026-10-07
- **Supersedes:** the five-role model (`CUSTOMER`, `MERCHANT`, `OPERATOR`,
  `SUPPORT`, `ADMIN`) introduced with the initial schema.

## Context

The platform shipped with five roles and two console surfaces:

| Role | Intended job | Console |
| --- | --- | --- |
| `ADMIN` | everything | `/admin` (+ `/support`) |
| `SUPPORT` | customer records, goodwill refunds | `/support` |
| `OPERATOR` | gate scanning only | `/admin/scan` |
| `MERCHANT` | a partner's own products and payouts | parts of `/admin` |
| `CUSTOMER` | shopping | storefront |

In practice the last two were not separate systems:

- `OPERATOR` existed to hold *one* capability (verify and redeem a ticket). Its
  route gate was already `requireRole('OPERATOR', 'ADMIN', 'MERCHANT')` — three
  roles allowed to do one thing.
- `MERCHANT` widened *downward*: a merchant login could read the admin dashboard
  and the promo banners, but owned no catalogue of its own. The `Merchant` **data
  model** is what carries partner inventory (`Product.merchantId`,
  `commissionBps`, `MerchantStatus`); the *role* added nothing on top of it.

So the role list described four staff logins for two consoles, and every
authorization decision had to enumerate roles that behaved identically.

## Decision

Collapse the staff roles to exactly the two surfaces:

```prisma
enum UserRole {
  CUSTOMER
  SUPPORT   // customer service console
  ADMIN     // operations console — includes gate scanning
}
```

- **`OPERATOR` is absorbed into `ADMIN`.** Gate scanning is an operations
  capability, and it is now the ADMIN gate on `/scan/*`.
- **`MERCHANT` is removed as a role, kept as a data model.** `Merchant` still
  owns inventory and settles commissions; the partner's login is simply an
  `ADMIN` account. Nothing about the partner model changed.
- **Authorization is one role wide at the gate.** `requireRole('ADMIN')` replaces
  every `requireRole('OPERATOR', 'ADMIN', 'MERCHANT')`.
- **`SUPPORT` stays below `ADMIN`.** That ordering was always the point: SUPPORT
  can correct a record and issue a goodwill refund, and still cannot touch
  pricing or simulate a payment.

### Migration

`pnpm migrate:roles` folds existing `OPERATOR`/`MERCHANT` accounts into `ADMIN`
**before** the schema push, because Postgres cannot drop an enum value that rows
still use and `prisma db push` casts every row through the new label set. The
statement casts `role::text` so it is a no-op when the labels are already gone,
which makes it safe to run unconditionally.

Seeding then retires the two demo logins (`operator@`, `merchant@`) so the demo
surface matches the role list rather than outliving it.

## Consequences

<http://a.com>

- One authorization rule per capability. A new route cannot be "accidentally
  allowed for MERCHANT".
- The role list matches the console list, so the mental model is checkable: two
  staff surfaces, two staff roles.
- `STAFF_ROLES` (realtime) drops from four entries to two, which narrows the set
  of sockets that receive cross-customer events.

## Another section

- A gate operator and a partner manager now hold full ADMIN. Mitigated by the
  audit trail (`AuditLog` on every mutation, `WalletTransaction` on every money
  move) rather than by role separation. If a partner-facing surface is needed
  later, it should be a *scoped* view over `Merchant.ownerUserId`, not a fourth
  role.
- Removing enum values is a breaking schema change. It is a one-way door for
  existing rows, handled by the migration script above.

## Alternatives considered

1. **Keep five roles, show two consoles.** Rejected: the roles would still be
   enumerated at every gate, which is the cost without the benefit.
2. **Keep `OPERATOR` as a third role.** Rejected: one capability does not justify
   a role, and `ADMIN` already holds it. The gate scanner has its own *page*
   (`/admin/scan`), which is where the separation actually helps.
3. **Give `MERCHANT` a real partner console.** Rejected for now: it would need a
   merchant-scoped catalogue, settlements UI and payout flows. That is a product
   decision larger than a role rename, and the data model is already ready for
   it.
