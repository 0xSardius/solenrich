import { z } from 'zod';
import { CheckAlertsInput } from '../schemas/alerts';
import type { AlertChecker } from '../enrichers/alert-checker';
import { formatResponse } from '../formatters';
import { formatAlertsBriefing } from '../formatters/llm-alerts';

type AddEntrypoint = (def: any) => void;

export function registerAlertEntrypoint(addEntrypoint: AddEntrypoint, checker: AlertChecker) {
  addEntrypoint({
    key: 'check-alerts',
    description:
      'Poll-based event detection. Pass a watchlist (tokens + wallets) and a `since` ISO 8601 timestamp; receive alerts fired since that time. Detects price spikes/drops, risk score changes, whale inflow/outflow, holder concentration shifts, portfolio value changes, and position additions/removals. Stateless: agent owns the `since` cursor. Watchlist capped at 10 tokens + 10 wallets per call. Step 1 of 3 (poll → SSE → webhooks).',
    input: CheckAlertsInput,
    handler: async (ctx: { input: z.infer<typeof CheckAlertsInput> }) => {
      const { tokens, wallets, since, criteria, format } = ctx.input;
      const data = await checker.check(tokens, wallets, since, criteria);
      return { output: formatResponse(data, format, formatAlertsBriefing) };
    },
  });
}
