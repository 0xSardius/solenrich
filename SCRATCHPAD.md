# Lessons Learned — SolEnrich Build

Running log of issues encountered, workarounds found, and decisions made during implementation. Update this as you go.

---

## Template

```
### [Date] — Short title
**Problem:**
**Solution/Workaround:**
**Impact:**
```

---

## Log

### 2026-02-22 — Lucid SDK API differs from PRD
**Problem:** The PRD assumed `agent.entrypoint({ name, ... })` pattern. The actual SDK uses `createAgent({...}).use(http()).use(payments({config: paymentsFromEnv()})).build()` then `createAgentApp(agent)` which returns `{ app, addEntrypoint }`. Entrypoints use `key` not `name`. Price is a decimal string (`"0.1"`) not base units (`5000`). Handler returns `{ output: {...} }`.
**Solution/Workaround:** Follow the scaffold's actual API patterns (from `AGENTS.md` and `src/lib/agent.ts`) instead of the PRD's assumed patterns.
**Impact:** All entrypoint registrations and agent assembly code must use the real SDK API. The PRD's Phase 5-6 code samples need adaptation.

### 2026-02-22 — Lucid SDK env var names
**Problem:** Lucid SDK expects specific env var names for payments: `PAYMENTS_FACILITATOR_URL`, `PAYMENTS_NETWORK`, `PAYMENTS_RECEIVABLE_ADDRESS`, `PAYMENTS_DESTINATION`, `DEVELOPER_WALLET_PRIVATE_KEY`. The PRD used different names (`FACILITATOR_URL`, `NETWORK`, etc.).
**Solution/Workaround:** Use both — Lucid's vars for the SDK, our custom vars for data source config.
**Impact:** `.env` has both sets of vars. `src/config.ts` reads our custom vars, Lucid's `paymentsFromEnv()` reads its own.

### 2026-02-22 — Zod v4 in scaffold
**Problem:** The scaffold installed Zod v4 (`^4.1.12`), not Zod v3 which the PRD assumed. Zod v4 has API differences.
**Solution/Workaround:** Use Zod v4 since it came with the scaffold. Watch for API differences in schema definitions.
**Impact:** Minor — most basic schema patterns are the same.
