# Evolving an event contract without breaking consumers

## The problem it solves

`flight-created` is read by another process (`flight-notifier`) that is deployed separately. On Day 46 a flight gained `originAirportId`, `destinationAirportId`, `aircraftId` and `status`. If the parser started requiring them, every message already sitting in the outbox, the queue or the DLQ would be rejected. If the producer dropped `origin`/`destination`, the deployed consumer would reject every new message.

## How it works

The same expand → contract idea as a database migration, applied to a message:

1. **Expand**: add the new fields as **optional** in `packages/contracts` (`parseFlightCreatedEvent`). Missing is fine (old shape); present but empty or not a string is rejected (broken producer). Old fields stay required.
2. **Producer always sends them**: `toFlightCreatedPayload` in `create-flight.ts`.
3. **Consumers adopt them** at their own pace (`flight-notifier` logs `aircraftId`/`status` when present).
4. **Contract** (later, not done): make the new fields required, or drop old ones. Only once no old-shape message remains anywhere and no consumer reads the old fields.

Tests: a pre-Day-46 payload is still `processed`; the Day 46 payload logs the new fields; a present-but-empty field is `rejected`.

## Trade-offs / when NOT to use

- Optional fields push "is it there?" checks into every consumer until the contract step.
- For an event with no consumer and no stored messages, just change it. The care is only worth it once something is deployed and reading.

## Gotchas

- **Do not publish the domain object itself.** Until Step 5 the payload was `flight` as a whole, so the four new fields leaked into the event the moment `Flight` gained them. Nobody decided to publish them. An explicit field-by-field mapping makes every published field a decision.
- `packages/contracts` is consumed from `dist`, so it must be rebuilt (`npm run build -w @booking-flight-system/contracts`), and docker images rebuilt, before a service sees the change.
- `status` in the event is the status *at creation*. Later changes have no event yet; a consumer must not treat it as current.

## Related

- Code: `packages/contracts/src/flight-created-event.ts`, `api/src/flights/create-flight.ts`, `services/flight-notifier/src/messaging/flight-created-consumer.ts`
- `docs/learnings/object-level-authorization.md` (expand → contract for a required column)
- ADR-003 (shared contracts via npm workspaces)
