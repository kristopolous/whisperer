/** Who reported this, and how to get back to them.
 *
 *  The whole product ends here. Finding a complaint, confirming it, patching it
 *  and never telling the person who raised it is most of the work for none of
 *  the value — and `Issue.reporter` has been on the type all along with nothing
 *  ever writing to it, so every draft in the outbox was addressed to nobody.
 *
 *  Two rules shape what this is allowed to do.
 *
 *  **Reply where they spoke.** A public complaint deserves a public answer:
 *  everyone else who hits the same bug and finds that thread gets the answer
 *  too, and the person does not have to wonder how a company got their email.
 *  So `venue-reply` is always preferred, and the other routes exist for when it
 *  is genuinely impossible.
 *
 *  **Only what they published.** Every contact route here comes from something
 *  the person chose to make public and attach to the account that complained —
 *  the email on their own GitHub profile, the site they linked from it. This
 *  does not look people up. Resolving a pseudonymous account to a real identity
 *  through a data broker is a different activity with different ethics and a
 *  different legal footing, and it is not what "follow up with the reporter"
 *  means. A company that answers a Reddit gripe by emailing someone's work
 *  address has done something worse than the bug.
 *
 *  When there is no route, that is a finding and it is recorded as `none` with
 *  a reason, rather than left blank for somebody to mistake for "not tried".
 */

import type { Issue, Mention, Reporter } from '../shared/types.ts';
import { secret } from './secrets.ts';
import { abortable } from './run-context.ts';

/** Venues where a reply in the thread is a real thing the pipeline could post.
 *
 *  Read as: the venue has a write API at all. Whether the credentials for it
 *  exist is a separate question the dashboard answers — this is about whether
 *  the route can exist in principle. */
const CAN_REPLY_IN_THREAD = new Set(['reddit', 'github', 'hackernews', 'youtube', 'discord', 'x']);

/** A GitHub user's own public profile.
 *
 *  `email` here is the address the person deliberately set as public on their
 *  profile — GitHub returns null unless they chose to publish it, which makes
 *  it the clearest possible case of a route somebody offered rather than one
 *  that was dug up. `blog` is whatever link they put in the same place. */
async function githubProfile(login: string): Promise<{ email?: string; blog?: string } | null> {
  const token = secret('GITHUB_TOKEN');
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'whisperer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: abortable(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { email?: string | null; blog?: string | null };
    return { email: body.email ?? undefined, blog: body.blog || undefined };
  } catch {
    return null;
  }
}

const handleOf = (mention: Mention): string =>
  (mention.author ?? '').replace(/^u\//, '').replace(/^@/, '').trim();

/** The mention that best represents who raised this.
 *
 *  The earliest one with a named author. Earliest because the person who said
 *  it first is the reporter and the rest are people agreeing, and named because
 *  an anonymous row gives nothing to answer. */
function speaker(issue: Issue, mentions: Mention[]): Mention | undefined {
  const byId = new Map(mentions.map((m) => [m.id, m]));
  return (issue.evidence ?? [])
    .map((id) => byId.get(id))
    .filter((m): m is Mention => Boolean(m) && handleOf(m!).length > 0)
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0];
}

/** Work out how to reach whoever raised this issue.
 *
 *  Never throws and never blocks a scan: an unreachable GitHub API just means
 *  the public-profile upgrade does not happen and the thread reply stands. */
export async function resolveReporter(issue: Issue, mentions: Mention[]): Promise<Reporter | undefined> {
  const mention = speaker(issue, mentions);
  if (!mention) return undefined;

  const handle = handleOf(mention);
  const base = {
    handle,
    venue: mention.venue,
    sourceUrl: mention.url,
    confidence: 'high' as const,
  };

  // GitHub is the one venue where somebody routinely publishes an address next
  // to the account that filed the complaint. Offered, not discovered.
  if (mention.venue === 'github') {
    const profile = await githubProfile(handle);
    if (profile?.email) {
      return {
        ...base,
        channel: 'email',
        address: profile.email,
        basis: `the public email on github.com/${handle}'s own profile`,
      };
    }
  }

  if (CAN_REPLY_IN_THREAD.has(mention.venue)) {
    return {
      ...base,
      channel: 'venue-reply',
      address: mention.url,
      basis: `replying in the thread they posted in, as ${handle}'s complaint is public`,
    };
  }

  // Said rather than left empty. A blank reporter reads as "nobody looked",
  // and the difference between that and "looked, and there is no way to reach
  // them" is the difference between a task and a fact.
  return {
    ...base,
    channel: 'none',
    basis: `${mention.venue} has no reply route, and ${handle} published no contact details`,
    confidence: 'low',
  };
}
