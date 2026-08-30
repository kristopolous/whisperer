/** Outbound write channels — everywhere this app can say something to a real
 *  person or system.
 *
 *  Kept separate from the read connectors on purpose. A misconfigured read
 *  returns nothing and you find out immediately; a misconfigured write posts in
 *  the company's name to a stranger who did not ask to be contacted, and cannot
 *  be taken back. They deserve different config, different UI, and a different
 *  default (nothing sends unless the request explicitly says to).
 *
 *  Most of these are honestly marked `planned`. Each one is its own separate
 *  problem — email is a deliverability project, Reddit is an account-reputation
 *  project, X is a billing project — and a channel that looks available but
 *  silently does nothing is worse than one that says it is not built.
 */

import { loadConfig } from '../config.ts';
import { hasSecret } from '../secrets.ts';

export type ChannelStatus = 'implemented' | 'planned';

export interface OutboundChannel {
  id: string;
  label: string;
  kind: 'ticket' | 'reply';
  status: ChannelStatus;
  requires?: string[];
  notes: string;
}

export interface GithubTicketing {
  owner: string;
  repo: string;
  token: string;
  apiBase?: string;
}

export interface ChannelsConfig {
  ticketing: { provider: string; github?: GithubTicketing };
  outbound: OutboundChannel[];
}

let cache: ReturnType<typeof loadConfig<ChannelsConfig>> | null = null;

export function channelsConfig() {
  cache ??= loadConfig<ChannelsConfig>('channels');
  return cache;
}

export const reloadChannels = () => { cache = null; };

/** What a channel can actually do right now, which is what the settings panel
 *  has to show:
 *
 *    ready              built, credentials present — it will send
 *    needs-credentials  built, but nothing to authenticate with
 *    planned            not built; `notes` says what it would take
 */
export type ChannelReadiness = 'ready' | 'needs-credentials' | 'planned';

export interface ChannelState extends OutboundChannel {
  readiness: ChannelReadiness;
  missing: string[];
}

export function channelStates(): ChannelState[] {
  return channelsConfig().value.outbound.map((channel) => {
    const missing = (channel.requires ?? []).filter((key) => !hasSecret(key));
    const readiness: ChannelReadiness =
      channel.status !== 'implemented' ? 'planned' : missing.length ? 'needs-credentials' : 'ready';
    return { ...channel, readiness, missing };
  });
}

export const channelState = (id: string): ChannelState | undefined =>
  channelStates().find((channel) => channel.id === id);
