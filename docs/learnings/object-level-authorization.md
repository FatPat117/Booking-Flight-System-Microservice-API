# Object-level authorization (BOLA)

## The problem it solves

Until Day 44 anyone who knew a booking id could cancel it with `DELETE /api/bookings/:id`: no token, no owner. The ids are UUIDs, but ids leak through logs, shared URLs, `Location` headers and screenshots. "Hard to guess" is not access control.

The name for this bug is **BOLA** (Broken Object Level Authorization, also called IDOR). It is #1 in the OWASP API Security Top 10. The system checks *"are you logged in / do you have the right role?"* but not *"is **this particular** object yours?"*

Two different checks:

| Check | Question | Where it can live |
|---|---|---|
| Function level | May role `user` call this endpoint at all? | Middleware (`requireRole`, Day 34) |
| Object level | Does booking `abc` belong to the caller? | Only where the data is read: middleware doesn't know who owns `abc` |

## How it works

### 1. Ownership is part of the query, not an `if` after it

Two ways to check ownership:

1. Read the booking by id, then `if (booking.ownerAccountId !== caller) return 404` in each use case.
2. Put the owner into the query itself: `WHERE id = $1 AND owner_account_id = $2`.

Option 1 works until one use case forgets the `if`. Option 2 makes it impossible to read a booking without saying *as whom*. Every `BookingRepository` method that reads or changes a booking by id takes a scope (`api/src/bookings/booking-repository.ts`):

```ts
type BookingAccessScope =
  | { kind: "owner"; accountId: string }
  | { kind: "admin" };
```

A union, not `ownerAccountId?: string`. With an optional field, a forgotten argument (`undefined`) silently becomes "no filter, see everything". With the union, "see everything" has to be asked for by name (`admin`).

The adapter turns the scope into SQL in one helper (`scopeFilter` in `postgres-booking-repository.ts`). The HTTP side turns a verified JWT into a scope in one helper too (`toBookingAccessScope` in `api/src/auth/booking-access.ts`). One place decides "admins see everything"; route handlers never branch on the role themselves.

### 2. Every query in the flow is scoped, including the one that picks the error

`cancel` is a conditional `UPDATE … WHERE status = 'active'` (ADR-004). When it matches 0 rows, a second `SELECT` decides between `not-found` and `already-cancelled`. If only the `UPDATE` is scoped:

- User B cancels user A's **already-cancelled** booking.
- The `UPDATE` matches nothing (scoped, correct).
- The follow-up `SELECT` (unscoped) finds the row and answers `already-cancelled` → `409`.
- B now knows the booking exists. The response code leaked it.

Rule: **every** query in an authorized flow carries the scope, even one that only chooses an error message. The contract test `"cancel of another account's already-cancelled booking is not-found, not already-cancelled"` exists for exactly this, and it failed (alone) when the scope was removed from the follow-up read.

### 3. `404`, never `403`, for someone else's object

`403 Forbidden` means "it exists, but not for you". That confirms existence and enables enumeration, the same leak Day 32 avoided by answering "unknown email" and "wrong password" identically. Another account's booking returns the **same status and the same body** as a missing one (BR-AUTH-02). A malformed id is also `404`: an id that cannot exist does not exist.

`403` is still right for **function-level** refusals, such as an admin trying to *create* a booking (`requireRole("user")`). It reveals nothing about any specific object.

### 4. Use cases receive identity explicitly

Routes read the JWT and pass `scope` / `actor` into use cases as plain arguments. Use cases never call `getAuthenticatedUser()`. That keeps them testable with no HTTP context and runnable from jobs and consumers, where there is no request at all.

### 5. Adding a required column to a table that has data: expand → contract

`owner_account_id NOT NULL` cannot be added directly to a table with ownerless rows:

1. **Expand** (`AddBookingOwner`): add the column as nullable, plus the index the new query needs (`owner_account_id, created_at DESC, id DESC`).
2. **Backfill**: only a human can decide who owns old rows. For dev data the decision was "reset"; nothing is backfilled.
3. **Contract** (`RequireBookingOwner`): refuse with a clear message if any `NULL` remains, otherwise `SET NOT NULL`.

The contract migration **never deletes** rows. A migration that fails loudly on unexpected data is the safe habit; one that quietly `DELETE`s is how production data gets lost.

## Trade-offs / when NOT to use

- **No foreign key to the owner.** Accounts live in `identity_db`; Postgres can't reference across databases, and that separation is intentional. Deleting an account leaves its bookings. If that ever matters, it becomes an event (`account-deleted`), not a constraint.
- **Scoping in queries is per repository.** It protects bookings because `BookingRepository` enforces it. A new resource with an owner needs the same treatment, and nothing enforces that automatically except review and contract tests.
- **Public data doesn't need it.** Flights are readable by anyone. Adding scopes there would be ceremony.

## How it is tested

- **Contract** (`api/tests/contracts/booking-repository.contract.ts`, fake + Postgres): out-of-scope `findById` → `undefined`; out-of-scope cancel of an active booking → `not-found` and it stays active; out-of-scope cancel of an already-cancelled booking → `not-found`; admin sees all; `findPage` filters before `limit`/`offset`.
- **HTTP** (`api/tests/bookings.api.test.ts`): `401` on all four routes without a token; B's `GET`/`DELETE` on A's booking gives the **same body** as a missing id; admin create/cancel → `403`; `Location` resolves via `GET`. Mutation check: making `toBookingAccessScope` return admin for everyone fails exactly the four BOLA tests.

## Gotchas

- Express 5 loses route-param typing when middleware sits before the handler. Annotate `Request<{ id: string }>` instead of casting.
- A non-UUID id sent to a Postgres `uuid` column throws `22P02` → `500`. Validate the format first and answer `404`.

## Related

- `docs/product/domain-model.md`: BR-AUTH-01/02/03, permission matrix
- `docs/adr/004-optimistic-concurrency-control.md`: the conditional UPDATE + follow-up read shape
- `docs/learnings/domain-model-and-aggregates.md`: why `403` vs `404` is a domain decision
- `.cursor/progress/DAY-44.md`
