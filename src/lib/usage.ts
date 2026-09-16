import { readUsage, withLock, writeUsage } from "./store";
import { USAGE_PROVIDERS, type UsageFeature, type UsageProvider, type UsageReport, type UsageRow, type UsageTotals } from "./types";

export interface UsageEvent {
  provider: UsageProvider;
  model: string;
  feature: UsageFeature;
  input?: number;
  output?: number;
  cached?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Days follow this computer's clock, so "today" matches what you see. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cached: 0, calls: 0 });

/** Fire-and-forget: a failure to record usage must never break a lesson. */
export function recordUsage(event: UsageEvent): void {
  const day = localDay(new Date());
  withLock(async () => {
    const usage = await readUsage();
    const key = `${event.provider}|${event.model}|${event.feature}`;
    const totals = ((usage[day] ??= {})[key] ??= emptyTotals());
    totals.input += event.input ?? 0;
    totals.output += event.output ?? 0;
    totals.cached += event.cached ?? 0;
    totals.calls += 1;
    await writeUsage(usage);
  }).catch((err) => console.error("Couldn't record token usage", err));
}

function add(into: UsageTotals, from: UsageTotals) {
  into.input += from.input;
  into.output += from.output;
  into.cached += from.cached;
  into.calls += from.calls;
}

export async function usageReport(now = new Date()): Promise<UsageReport> {
  const usage = await readUsage();
  const today = localDay(now);
  const month = today.slice(0, 7);
  const monthDays = Object.keys(usage)
    .filter((d) => d.startsWith(month))
    .sort()
    .reverse();

  const rowsFor = (days: string[]): UsageRow[] => {
    const rows = new Map<string, UsageRow>();
    for (const day of days) {
      for (const [key, totals] of Object.entries(usage[day] ?? {})) {
        const [provider, model, feature] = key.split("|") as [UsageProvider, string, UsageFeature];
        const row = rows.get(key) ?? { provider, model, feature, ...emptyTotals() };
        add(row, totals);
        rows.set(key, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
  };

  const daily = monthDays.map((day) => {
    const totals = Object.fromEntries(USAGE_PROVIDERS.map((p) => [p, emptyTotals()])) as Record<UsageProvider, UsageTotals>;
    for (const [key, t] of Object.entries(usage[day])) {
      const provider = key.split("|")[0] as UsageProvider;
      if (totals[provider]) add(totals[provider], t);
    }
    return { day, totals };
  });

  return { today, month, todayRows: rowsFor([today]), monthRows: rowsFor(monthDays), daily };
}
