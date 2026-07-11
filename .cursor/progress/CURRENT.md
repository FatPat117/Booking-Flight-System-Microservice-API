# CURRENT PROGRESS

**Last completed day:** Day 2 (mentor-reviewed & fixed)
**Current day:** Ready for Day 3
**Status:** Day 2 complete after corrections

## Day 2 key fixes applied

- `unknown` + pure `validateCreateFlightInput`
- Collect all field issues → `422 VALIDATION_FAILED`
- Duplicate `flightNumber + departureAt` → `409`
- Airport codes on origin/destination (not flightNumber)
- `availableSeats = 0` allowed
- No string→number coercion
- Explicit Flight mapping; UTC normalize
- Error contract `{ error: { code, message, details? } }`

## Architecture

```text
Client → express.json() → validate → normalize → rules → conflict → Flight[]
```
