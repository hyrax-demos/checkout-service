# Extract the JWT token helper functions out of src/utils/tokens.ts into a new mo…

**Tool:** `task`
**Severity:** unspecified

## What's wrong

Extract the JWT token helper functions out of src/utils/tokens.ts into a new module src/tokenClaims.ts, and have src/utils/tokens.ts re-export them so every existing import keeps working. Pure refactor: no behaviour change, no new dependencies.
