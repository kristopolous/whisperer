import type { Scan } from '../../../shared/types.ts';
import { counts, fmtScore } from '../lib.ts';

export type OverviewTab = 'presence' | 'discovery' | 'health' | 'integrity';

/** The headline figures for a whole scan — presence, discussion, issues,
 *  integrity and sentiment. Kept above the tabs so the summary is always on
 *  screen no matter which part is being drilled into; clicking a card jumps to
 *  that tab (sentiment has nowhere interesting to go, so it stays flat). */
export function StatCards({
  scan,
  onDrill,
}: {
  scan: Scan;
  onDrill: (tab: OverviewTab) => void;
}) {
  const profiles = scan.profiles ?? [];
  const mentions = scan.mentions ?? [];
  const issues = scan.issues ?? [];
  const abuse = scan.abuse ?? [];
  const venues = counts(mentions);
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const direction = scan.net.delta > 0.05 ? 'rising' : scan.net.delta < -0.05 ? 'falling' : 'flat';

  const cards: {
    key: OverviewTab | null;
    label: string;
    value: string;
    unit: string;
    line: string;
    tone: 'pos' | 'neg' | 'mid';
  }[] = [
    {
      key: 'presence',
      label: 'Presence',
      value: String(profiles.length),
      unit: profiles.length === 1 ? 'channel' : 'channels',
      line: `${profiles.filter((p) => p.official).length} official · ${profiles.filter((p) => !p.official).length} unofficial`,
      tone: 'mid',
    },
    {
      key: 'discovery',
      label: 'Discussion',
      value: String(mentions.length),
      unit: mentions.length === 1 ? 'mention' : 'mentions',
      line: venues.length
        ? `across ${venues.length} ${venues.length === 1 ? 'venue' : 'venues'} · ${mentions.filter((m) => m.date).length} dated`
        : 'nothing found yet',
      tone: 'mid',
    },
    {
      key: 'health',
      label: 'Issues',
      value: String(issues.length),
      unit: issues.length === 1 ? 'issue' : 'issues',
      line: critical ? `${critical} critical — ready to file` : 'nothing critical',
      tone: critical ? 'neg' : 'mid',
    },
    {
      key: 'integrity',
      label: 'Integrity',
      value: String(abuse.length),
      unit: abuse.length === 1 ? 'finding' : 'findings',
      line: abuse.length
        ? abuse[0].kind.replace(/-/g, ' ') + (abuse.length > 1 ? ' & more' : '')
        : 'name is clean',
      tone: abuse.length ? 'neg' : 'mid',
    },
    {
      key: null,
      label: 'Sentiment',
      value: fmtScore(scan.net.now),
      unit: 'net',
      line: `${direction === 'flat' ? 'holding' : direction}`,
      tone: scan.net.now >= 0 ? 'pos' : 'neg',
    },
  ];

  return (
    <section className="ocards">
      {cards.map((c) => (
        <button
          key={c.label}
          className="ocard"
          onClick={c.key ? () => onDrill(c.key!) : undefined}
        >
          <span className="ok">{c.label}</span>
          <span className="oval">
            {c.value}
            <span className="ounit">{c.unit}</span>
          </span>
          <span className={`oline ${c.tone}`}>{c.line}</span>
        </button>
      ))}
    </section>
  );
}
