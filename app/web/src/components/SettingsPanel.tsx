import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.ts';

/** One MCP connector as the server reports it after dialling it.
 *
 *  `unconfigured` and `down` are kept apart because they are different jobs:
 *  one needs a credential added to .env, the other needs a service started. */
interface ConnectorStatus {
  name: string;
  description: string;
  status: 'ok' | 'unconfigured' | 'down';
  tools: number;
  missing: string[];
  error?: string;
  ms?: number;
  url: string;
  roles: ConnectorRole[];
  bound: ConnectorRole[];
}

interface Credential {
  name: string;
  /** Connectors and channels that want this one. */
  usedBy: string[];
  kind: 'connector' | 'channel';
  source: 'dashboard' | 'environment' | 'missing';
  /** What it is, and where to get it. */
  what: string;
  where: string;
  /** False for usernames, domains and switches — shown as plain text, because
   *  masking a non-secret hides transpositions and protects nothing. */
  secret: boolean;
  url?: string;
  billingUrl?: string;
}

interface ChannelState {
  id: string;
  label: string;
  kind: 'ticket' | 'reply';
  readiness: 'ready' | 'needs-credentials' | 'planned';
  missing: string[];
  notes: string;
}

interface InferenceHost {
  key: string;
  baseUrl: string;
  modelId: string;
  /** Whether a key is stored — never the key itself. */
  hasKey: boolean;
  contextLength?: number;
  maxOutputTokens?: number;
}

type ModelRole = 'general' | 'coding';

const ROLE_MEANS: Record<ModelRole, string> = {
  general: 'reading text and judging it — sentiment, triage, themes',
  coding: 'reasoning about source — diagnosing a defect, writing a patch',
};

interface Inference {
  default: string;
  active: string;
  roles: Partial<Record<ModelRole, string>>;
  isExample: boolean;
  hosts: InferenceHost[];
}

interface Health {
  servers: string[];
  model: string;
  inference: { host: string; baseUrl: string; isExample: boolean };
  search?: { braveQuotaSpent: { at: string; detail: string } | null };
}

const STATUS_LABEL: Record<ConnectorStatus['status'], string> = {
  ok: 'ok',
  unconfigured: 'no credentials',
  down: 'down',
};

const STATUS_TAG: Record<ConnectorStatus['status'], string> = {
  ok: 'good',
  unconfigured: 'warning',
  down: 'critical',
};

const READINESS_LABEL: Record<ChannelState['readiness'], string> = {
  ready: 'ready',
  'needs-credentials': 'no credentials',
  planned: 'not built',
};

const READINESS_TAG: Record<ChannelState['readiness'], string> = {
  ready: 'good',
  'needs-credentials': 'warning',
  planned: 'plain',
};

/** Connectors, write channels and inference — the machinery, configured here.
 *
 *  Connectors are dialled directly over MCP from `config/connectors.json`;
 *  there is no broker in between, so what this screen shows is the result of an
 *  actual request to each service rather than a third party's opinion of it.
 *  URL and enabled are editable here because they are decisions; credentials
 *  are not, because they belong in .env and are named by each connector's
 *  `requires` list instead.
 */
/** The credential inputs for one connector or channel, shown inside its own
 *  row.
 *
 *  These used to live in a separate panel further down the page: a connector
 *  said "needs BRAVE_API_KEY — add it under Credentials below" and you had to
 *  go find a matching name in a list of identical boxes. That split is how a
 *  GitHub token ended up in the Bright Data field. A credential belongs to the
 *  thing that needs it, so it is entered there. */
type ConnectorRole = 'search' | 'scrape' | 'contact' | 'ticket' | 'exec';

interface ChainEntry {
  id: string;
  label: string;
  kind: 'built-in' | 'mcp';
  usable: boolean;
  problem?: string;
  hosts?: string[];
}

interface RoleInfo {
  id: ConnectorRole;
  label: string;
  uses: string;
  wired: boolean;
  chain: ChainEntry[];
}

interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  kind: 'built-in' | 'mcp';
  likely: ConnectorRole[];
  missing: string[];
  bound: ConnectorRole[];
}

interface Inspection {
  reachable: boolean;
  error?: string;
  tools: { name: string; description: string; args: string[] }[];
  suggested: Partial<Record<ConnectorRole, { tool: string; arg: string }>>;
}

interface SourceState {
  id: string;
  label: string;
  notes: string;
  requires: string[];
  optional?: string[];
  missing: string[];
  readiness: 'ready' | 'needs-credentials' | 'exhausted';
  exhaustedReason?: string;
  links: { name: string; get?: string; billing?: string }[];
}

function CredentialFields({
  names,
  credentials,
  entries,
  onChange,
  onClear,
}: {
  names: string[];
  credentials: Credential[];
  entries: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onClear: (name: string) => void;
}) {
  if (names.length === 0) return null;

  return (
    <div className="cred-fields">
      {names.map((name) => {
        const cred = credentials.find((c) => c.name === name);
        const set = cred && cred.source !== 'missing';
        return (
          <label key={name} className="cred-field">
            <span className="cred-field-head">
              <code>{name}</code>
              {set && <span className="tag good">{cred!.source === 'dashboard' ? 'set here' : 'from .env'}</span>}
              {set && cred!.source === 'dashboard' && (
                <button type="button" className="ghost conn-link" onClick={() => onClear(name)}>remove</button>
              )}
            </span>
            {cred?.what && <span className="cred-what">{cred.what}</span>}
            {(cred?.where || cred?.url) && (
              <span className="cred-where">
                {cred.where}
                {cred.url && (
                  <>
                    {cred.where ? ' · ' : ''}
                    <a href={cred.url} target="_blank" rel="noreferrer">get a key ↗</a>
                  </>
                )}
                {cred.billingUrl && (
                  <> · <a href={cred.billingUrl} target="_blank" rel="noreferrer">plan &amp; usage ↗</a></>
                )}
              </span>
            )}
            <input
              type={cred?.secret === false ? 'text' : 'password'}
              className="conn-url"
              value={entries[name] ?? ''}
              onChange={(e) => onChange(name, e.target.value)}
              placeholder={set ? 'set — type to replace' : `paste ${name}`}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        );
      })}
    </div>
  );
}

interface CreditRow {
  provider: string;
  unit: 'dollars' | 'requests';
  granted?: number;
  spent: number;
  remaining: number | null;
}

/** What is left of each provider's free allowance.
 *
 *  Retrieval is what this product costs, and while it is being demoed the
 *  introductory grants are the entire budget. Four vendor consoles is where
 *  that number lived; this is it on one screen, next to the chain that decides
 *  which of them gets asked first.
 *
 *  An allowance nobody has entered reads as unknown, not as zero — the chain
 *  treats it as unlimited, because refusing to search on the strength of a
 *  number nobody supplied would be the tool inventing a limit. */
function Credits() {
  const [rows, setRows] = useState<CreditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CreditRow[]>('api/credits').then(setRows).catch((e) => setError(String(e)));
  }, []);

  const save = async (provider: string, changes: Record<string, unknown>) => {
    try {
      const data = await api<{ credits: CreditRow[] }>(`api/credits/${provider}`, {
        method: 'PUT', body: JSON.stringify(changes),
      });
      setRows(data.credits);
      setError(null);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
    }
  };

  const money = (row: CreditRow, n: number) =>
    (row.unit === 'dollars' ? `$${n.toFixed(2)}` : n.toLocaleString());

  return (
    <div className="panel">
      <div className="set-head">
        <strong>Credit</strong>
        <span className="tag plain">what the searching costs</span>
      </div>
      <p className="set-desc">
        Every paid request is counted here as it happens, and a provider with nothing left is
        skipped rather than asked — an exhausted account answers with a refusal that still costs a
        round trip. Correct a figure by typing what the provider&apos;s own console says; the tally
        drifts whenever a response is lost.
      </p>

      {error && <div className="set-message err" style={{ padding: '0 16px 10px' }}>{error}</div>}

      <div className="conn-list">
        {rows?.map((row) => {
          const out = row.remaining !== null && row.remaining <= 0;
          const low = row.remaining !== null && row.granted ? row.remaining / row.granted < 0.15 : false;
          return (
            <div className="conn-row" key={row.provider}>
              <span className="conn-dot" data-run={out ? 'failed' : low ? 'running' : 'ok'} />
              <span className="conn-name">{row.provider}</span>
              <span className="conn-meta">
                {row.granted === undefined
                  ? `${money(row, row.spent)} used · no allowance recorded`
                  : `${money(row, row.remaining ?? 0)} left of ${money(row, row.granted)}`}
              </span>
              <label className="conn-meta">
                allowance{' '}
                <input
                  type="number"
                  defaultValue={row.granted ?? ''}
                  style={{ width: 84 }}
                  onBlur={(e) => save(row.provider, {
                    granted: e.target.value === '' ? null : Number(e.target.value),
                  })}
                />
              </label>
              <label className="conn-meta">
                used{' '}
                <input
                  type="number"
                  defaultValue={row.spent}
                  style={{ width: 84 }}
                  onBlur={(e) => save(row.provider, { spent: Number(e.target.value) })}
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ScheduleEntry {
  id: string;
  input: string;
  cadence: 'daily' | 'weekly';
  hour: number;
  enabled: boolean;
  deep?: boolean;
  lastRunAt?: string;
  lastScanId?: string;
  lastOutcome?: 'done' | 'error' | 'cancelled';
  lastError?: string;
  lastFound?: { mentions: number; issues: number };
  nextRunAt: string | null;
}

/** What runs on its own, and what happened last time it did.
 *
 *  The last column is the point. A schedule that only says when it will fire
 *  next cannot tell you it has been firing into a wall all week, and an
 *  automation nobody can see failing is worse than no automation. */
function Schedule() {
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ entries: ScheduleEntry[] }>('api/schedule')
      .then((data) => setEntries(data.entries))
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const save = async (body: Record<string, unknown>) => {
    try {
      const data = await api<{ entries: ScheduleEntry[] }>('api/schedule', {
        method: 'PUT', body: JSON.stringify(body),
      });
      setEntries(data.entries);
      setError(null);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
    }
  };

  const drop = async (id: string) => {
    const data = await api<{ entries: ScheduleEntry[] }>(`api/schedule/${id}`, { method: 'DELETE' });
    setEntries(data.entries);
  };

  const when = (iso?: string | null) =>
    (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <div className="panel">
      <div className="set-head">
        <strong>Schedule</strong>
        <span className="tag plain">runs while this server is up</span>
      </div>
      <p className="set-desc">
        Reputation is a series, and a series needs observations taken without somebody remembering
        to take them. Each run here is a new record rather than an overwrite, so the defects panel
        can say what is new since yesterday. It runs inside this process — stop the server and
        nothing fires.
      </p>

      {error && <div className="set-message err" style={{ padding: '0 16px 10px' }}>{error}</div>}

      <div className="conn-list">
        {entries?.map((entry) => (
          <div className="conn-row" key={entry.id}>
            <span className="conn-dot" data-run={entry.lastOutcome === 'error' ? 'failed' : entry.enabled ? 'ok' : 'idle'} />
            <span className="conn-name">{entry.input}</span>
            <select
              value={entry.cadence}
              onChange={(e) => save({ ...entry, cadence: e.target.value })}
            >
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
            </select>
            <select value={entry.hour} onChange={(e) => save({ ...entry, hour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
            <label className="conn-meta">
              <input type="checkbox" checked={Boolean(entry.deep)} onChange={(e) => save({ ...entry, deep: e.target.checked })} />
              {' '}deep
            </label>
            <label className="conn-meta">
              <input type="checkbox" checked={entry.enabled} onChange={(e) => save({ ...entry, enabled: e.target.checked })} />
              {' '}on
            </label>
            <span className="conn-meta">
              next {when(entry.nextRunAt)} · last {when(entry.lastRunAt)}
              {entry.lastFound && ` — ${entry.lastFound.mentions} mentions, ${entry.lastFound.issues} defects`}
              {entry.lastOutcome === 'error' && ` — failed: ${(entry.lastError ?? '').slice(0, 80)}`}
            </span>
            <button className="ghost" onClick={() => drop(entry.id)}>remove</button>
          </div>
        ))}
        {entries?.length === 0 && <div className="conn-row"><span className="q">Nothing is scheduled.</span></div>}
      </div>

      <div className="actions" style={{ padding: '10px 16px 14px' }}>
        <input
          value={input}
          placeholder="bolt.new"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) { save({ input: input.trim() }); setInput(''); } }}
        />
        <button className="ghost" disabled={!input.trim()} onClick={() => { save({ input: input.trim() }); setInput(''); }}>
          Watch this
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose?: () => void }) {

  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState('');
  /** Which connector or channel row is expanded. One at a time — these rows
   *  hold inputs, and several open at once is a form nobody can read. */
  const [openRow, setOpenRow] = useState<string | null>(null);

  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [channels, setChannels] = useState<ChannelState[] | null>(null);
  const [sources, setSources] = useState<SourceState[] | null>(null);
  const [roleInfo, setRoleInfo] = useState<RoleInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [roleMessage, setRoleMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadRoles = useCallback(async () => {
    try {
      const data = await api<{ roles: RoleInfo[]; providers: ProviderInfo[] }>('api/roles');
      setRoleInfo(data.roles);
      setProviders(data.providers);
    } catch {
      setRoleInfo([]);
      setProviders([]);
    }
  }, []);

  /** Write a role's chain back. The array is the whole membership in priority
   *  order, so this is both "reorder" and "add/remove". */
  const saveChain = useCallback(async (role: ConnectorRole, chain: string[]) => {
    setRoleMessage(null);
    try {
      const data = await api<{ roles: RoleInfo[]; providers: ProviderInfo[] }>(`api/roles/${role}`, {
        method: 'PUT', body: JSON.stringify({ chain }),
      });
      setRoleInfo(data.roles);
      setProviders(data.providers);
      setRoleMessage({ kind: 'ok', text: 'Saved — it takes effect on the next request.' });
    } catch (error) {
      setRoleMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '').slice(0, 240) });
    }
  }, []);
  /** Tool list for the row being bound, keyed by connector name. */
  const [inspection, setInspection] = useState<Record<string, Inspection>>({});
  const [draftBindings, setDraftBindings] = useState<Record<string, Partial<Record<ConnectorRole, { tool: string; arg: string }>>>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [newServer, setNewServer] = useState({ name: '', url: '', description: '' });
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  /** Dial a server and read its tools, so roles can be bound to real names
   *  rather than typed from memory. */
  const inspect = async (name: string) => {
    try {
      const result = await api<Inspection>(`api/connectors/${encodeURIComponent(name)}/tools`);
      setInspection((current) => ({ ...current, [name]: result }));
    } catch {
      setInspection((current) => ({
        ...current, [name]: { reachable: false, error: 'could not reach it', tools: [], suggested: {} },
      }));
    }
  };

  const saveRoles = async (name: string) => {
    try {
      setConnectors(await api<ConnectorStatus[]>(`api/connectors/${encodeURIComponent(name)}`, {
        method: 'PUT', body: JSON.stringify({ bindings: draftBindings[name] ?? {} }),
      }));
      setKeyMessage({ kind: 'ok', text: 'Bindings saved — they take effect on the next request.' });
    } catch (error) {
      setKeyMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '').slice(0, 240) });
    }
  };

  const addServer = async () => {
    setAdding(true);
    setAddMessage(null);
    try {
      const result = await api<{ connector: { name: string } } & Inspection>('api/connectors', {
        method: 'POST', body: JSON.stringify(newServer),
      });
      setInspection((current) => ({ ...current, [result.connector.name]: result }));
      setDraftBindings((current) => ({ ...current, [result.connector.name]: result.suggested }));
      setAddMessage(result.reachable
        ? { kind: 'ok', text: `Added. It answered with ${result.tools.length} tools — open its row to give it a role.` }
        : { kind: 'err', text: `Added, but it did not answer: ${result.error ?? 'no response'}. Fix that, then bind its roles.` });
      setNewServer({ name: '', url: '', description: '' });
      setAddOpen(false);
      await refreshConnectors();
      setOpenRow(result.connector.name);
    } catch (error) {
      setAddMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '').slice(0, 240) });
    } finally { setAdding(false); }
  };

  const removeServer = async (name: string) => {
    try {
      setConnectors(await api<ConnectorStatus[]>(`api/connectors/${encodeURIComponent(name)}`, { method: 'DELETE' }));
      setOpenRow(null);
    } catch (error) {
      setKeyMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '').slice(0, 240) });
    }
  };
  const [testing, setTesting] = useState<string | null>(null);

  /** Actually authenticate, rather than checking that a value is present. */
  const testSource = async (id: string) => {
    setTesting(id);
    setKeyMessage(null);
    try {
      await api<{ ok: boolean }>(`api/sources/${id}/test`, { method: 'POST', body: '{}' });
      setKeyMessage({ kind: 'ok', text: 'Authenticated — this source will contribute to the next scan.' });
    } catch (error) {
      setKeyMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '').slice(0, 240) });
    } finally {
      setTesting(null);
    }
  };
  const [health, setHealth] = useState<Health | null>(null);

  const [inference, setInference] = useState<Inference | null>(null);
  const [hostKey, setHostKey] = useState('');
  const [draft, setDraft] = useState({ baseUrl: '', modelId: '', apiKey: '', contextLength: '', maxOutputTokens: '' });
  const [draftRoles, setDraftRoles] = useState<ModelRole[]>([]);
  const [savingHost, setSavingHost] = useState(false);
  const [probing, setProbing] = useState(false);
  const [infMessage, setInfMessage] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  /** Load the host list and open whichever one is actually in use. The api key
   *  box always starts empty — it is write-only, and showing a placeholder for
   *  a stored key is the honest version of showing the key. */
  const applyInference = useCallback((value: Inference) => {
    setInference(value);
    const active = value.hosts.find((h) => h.key === value.active) ?? value.hosts[0];
    if (active) {
      setHostKey(active.key);
      setDraftRoles((['general', 'coding'] as ModelRole[]).filter((r) => value.roles?.[r] === active.key));
      setDraft({
        baseUrl: active.baseUrl,
        modelId: active.modelId,
        apiKey: '',
        contextLength: active.contextLength ? String(active.contextLength) : '',
        maxOutputTokens: active.maxOutputTokens ? String(active.maxOutputTokens) : '',
      });
    }
  }, []);

  const refreshConnectors = useCallback(() => {
    setConnError(null);
    api<ConnectorStatus[]>('api/connectors')
      .then(setConnectors)
      .catch(() => {
        setConnectors(null);
        setConnError('Could not reach the API to probe connectors — is `npm run api` running?');
      });
  }, []);

  useEffect(() => {
    api<Credential[]>('api/credentials').then(setCredentials).catch(() => setCredentials(null));
    api<ChannelState[]>('api/channels').then(setChannels).catch(() => setChannels(null));
    api<SourceState[]>('api/sources').then(setSources).catch(() => setSources(null));
    void loadRoles();
    api<Health>('api/health').then(setHealth).catch(() => setHealth(null));
    api<Inference>('api/inference').then(applyInference).catch(() => setInference(null));
    refreshConnectors();
  }, [refreshConnectors, applyInference, loadRoles]);

  const selectHost = (key: string) => {
    const host = inference?.hosts.find((h) => h.key === key);
    setHostKey(key);
    setInfMessage(null);
    setDraftRoles(
      (['general', 'coding'] as ModelRole[]).filter((r) => inference?.roles?.[r] === key),
    );
    setDraft({
      baseUrl: host?.baseUrl ?? '',
      modelId: host?.modelId ?? '',
      apiKey: '',
      contextLength: host?.contextLength ? String(host.contextLength) : '',
      maxOutputTokens: host?.maxOutputTokens ? String(host.maxOutputTokens) : '',
    });
  };

  const saveHost = async (makeDefault: boolean) => {
    setSavingHost(true);
    setInfMessage(null);
    try {
      const body: Record<string, unknown> = {
        host: hostKey.trim(),
        baseUrl: draft.baseUrl,
        modelId: draft.modelId,
        makeDefault,
      };
      // Only send the key when something was typed. An empty box means "leave
      // whatever is stored alone", not "delete it" — clearing is explicit.
      if (draft.apiKey.trim()) body.apiKey = draft.apiKey;
      if (draft.contextLength) body.contextLength = Number(draft.contextLength);
      if (draft.maxOutputTokens) body.maxOutputTokens = Number(draft.maxOutputTokens);
      // Always sent, including empty. Unlike the api key, an empty list is a
      // real instruction — "this host handles no roles" — and skipping it made
      // unticking the last one a silent no-op, so the box came back ticked.
      body.roles = draftRoles;

      applyInference(await api<Inference>('api/inference', { method: 'PUT', body: JSON.stringify(body) }));
      setInfMessage({ kind: 'ok', text: makeDefault ? 'Saved, and now the default.' : 'Saved.' });
      api<Health>('api/health').then(setHealth).catch(() => {});
    } catch (error) {
      setInfMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '') });
    } finally {
      setSavingHost(false);
    }
  };

  const clearKey = async () => {
    setSavingHost(true);
    setInfMessage(null);
    try {
      applyInference(await api<Inference>('api/inference', {
        method: 'PUT',
        body: JSON.stringify({ host: hostKey, apiKey: '' }),
      }));
      setInfMessage({ kind: 'info', text: 'Stored key removed.' });
    } catch (error) {
      setInfMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '') });
    } finally {
      setSavingHost(false);
    }
  };

  const probe = async () => {
    setProbing(true);
    setInfMessage(null);
    try {
      const result = await api<{ ok: boolean; ms: number; schemaHonoured?: boolean; error?: string }>(
        'api/inference/test', { method: 'POST' },
      );
      setInfMessage(
        result.ok
          ? {
            kind: result.schemaHonoured ? 'ok' : 'err',
            text: result.schemaHonoured
              ? `Answered in ${result.ms}ms and honoured the output schema.`
              : `Answered in ${result.ms}ms but ignored the schema — this endpoint will not work for scans.`,
          }
          : { kind: 'err', text: result.error ?? 'The endpoint did not answer.' },
      );
    } catch (error) {
      setInfMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '') });
    } finally {
      setProbing(false);
    }
  };

  /** Save every box that was typed into, then re-probe so the connector rows
   *  answer the actual question — did that key work. */
  const saveCredentials = async (only?: string[]) => {
    const filled = Object.fromEntries(
      Object.entries(entries)
        .filter(([name, v]) => v.trim() && (!only || only.includes(name))),
    );
    if (Object.keys(filled).length === 0) return;
    setSavingKeys(true);
    setKeyMessage(null);
    try {
      const saved = await api<{ connectors: ConnectorStatus[]; warnings: string[] }>('api/credentials', {
        method: 'PUT',
        body: JSON.stringify(filled),
      });
      setConnectors(saved.connectors);
      setEntries((current) => Object.fromEntries(
        Object.entries(current).filter(([name]) => !(name in filled)),
      ));
      setCredentials(await api<Credential[]>('api/credentials'));
      setChannels(await api<ChannelState[]>('api/channels').catch(() => null) as ChannelState[] | null);
      setSources(await api<SourceState[]>('api/sources').catch(() => null) as SourceState[] | null);
      setKeyMessage(saved.warnings.length
        ? { kind: 'err', text: `Saved, but: ${saved.warnings.join('; ')}` }
        : { kind: 'ok', text: `Saved ${Object.keys(filled).length} credential(s) and re-probed.` });
    } catch (error) {
      setKeyMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '') });
    } finally {
      setSavingKeys(false);
    }
  };

  const clearCredential = async (name: string) => {
    setSavingKeys(true);
    try {
      const cleared = await api<{ connectors: ConnectorStatus[] }>('api/credentials', {
        method: 'PUT',
        body: JSON.stringify({ [name]: '' }),
      });
      setConnectors(cleared.connectors);
      setCredentials(await api<Credential[]>('api/credentials'));
      setKeyMessage({ kind: 'ok', text: `${name} removed.` });
    } catch (error) {
      setKeyMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '') });
    } finally {
      setSavingKeys(false);
    }
  };

  const recheck = async () => {
    setRechecking(true);
    setConnError(null);
    try {
      setConnectors(await api<ConnectorStatus[]>('api/connectors/reconnect', { method: 'POST' }));
    } catch {
      setConnError('Re-check failed.');
    } finally {
      setRechecking(false);
    }
  };

  const patch = async (name: string, changes: { url?: string; enabled?: boolean }) => {
    setConnError(null);
    try {
      setConnectors(await api<ConnectorStatus[]>(`api/connectors/${name}`, {
        method: 'PUT',
        body: JSON.stringify(changes),
      }));
      setEditing(null);
    } catch (error) {
      setConnError(String(error).replace(/^Error:\s*/, ''));
    }
  };




  return (
    <section className="card-stack">
      {onClose && (
        <button className="ghost back-to-scans" onClick={onClose}>← Back to scans</button>
      )}
      <div className="rubric">
        <h2>Settings</h2>
        <p>The connectors this instance reads from, the channels it can write to, and where inference runs.</p>
      </div>

      <Credits />
      <Schedule />

      <div className="panel">
        <div className="set-head">
          <strong>Role chains</strong>
          <span className="tag plain">who does what, in what order</span>
        </div>
        <p className="set-desc">
          Each role is a list of providers tried in order, first choice first — drag to reorder. This
          is where priority lives: when the provider at the top runs out of credits or goes down, the
          next one answers. A provider can be first choice for one role and third for another, and
          anything can go in any role.
        </p>
        {roleMessage && (
          <div className={`set-message ${roleMessage.kind}`} style={{ padding: '0 16px 10px' }}>{roleMessage.text}</div>
        )}
        <div className="chain-list-wrap">
          {roleInfo.map((role) => (
            <RoleChain
              key={role.id}
              role={role}
              providers={providers}
              onChange={(chain) => void saveChain(role.id, chain)}
            />
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>MCP connectors</strong>
          <span className="tag plain">config/connectors.json</span>
        </div>
        <div className="set-actions">
          <button className="ghost" onClick={recheck} disabled={rechecking}>
            {rechecking ? 'Re-checking…' : 'Re-check all'}
          </button>
          <button className="ghost" onClick={() => setAddOpen(!addOpen)}>
            {addOpen ? 'Cancel' : '+ Add a server'}
          </button>
          {addMessage && <span className={`set-message ${addMessage.kind}`}>{addMessage.text}</span>}
        </div>

        {addOpen && (
          <div className="conn-detail">
            <p className="set-desc" style={{ padding: 0 }}>
              Any MCP server reachable over streamable HTTP. It is dialled as soon as it is added and
              its tools listed, so you can bind it to a role straight away. A server that does not
              answer is still saved — not running yet is a normal state, not a reason to lose the URL.
            </p>
            <div className="set-grid">
              <label>
                <span>name</span>
                <input
                  value={newServer.name}
                  onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                  placeholder="tavily"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>endpoint</span>
                <input
                  value={newServer.url}
                  onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                  placeholder="http://localhost:8096/mcp"
                  spellCheck={false}
                />
              </label>
              <label className="set-wide">
                <span>what it is for</span>
                <input
                  value={newServer.description}
                  onChange={(e) => setNewServer({ ...newServer, description: e.target.value })}
                  placeholder="shown in this list, and in the agent trace when it is called"
                />
              </label>
            </div>
            <div className="set-actions">
              <button
                className="primary"
                disabled={adding || !newServer.name.trim() || !newServer.url.trim()}
                onClick={addServer}
              >
                {adding ? 'Dialling…' : 'Add and dial it'}
              </button>
            </div>
          </div>
        )}
        <p className="set-desc">
          Each connector is an MCP endpoint dialled directly over HTTP — nothing brokers these, so a row
          below is the result of an actual <code>tools/list</code> against that service. <b>ok</b> means it
          answered and mounted tools. <b>no credentials</b> means the environment variables it declares are
          missing, so it was never dialled. <b>down</b> means it was dialled and failed, with the reason.
          Open a row to set its credentials and endpoint. Endpoints are written to{' '}
          <code>config/connectors.json</code>; credentials are stored on this machine and never
          shown back to you. Saving re-probes, so you find out immediately whether a key works.
        </p>

        {health?.search?.braveQuotaSpent && (
          <div className="notice" style={{ margin: '0 16px 12px' }}>
            <span className="tag warning">Brave quota spent</span>
            <span>
              Brave's free plan allows 2,000 queries a month and this month's are gone, so searches
              are being answered by whichever connector holds the <b>search</b> role instead. Nothing
              is broken and results are still real — but a scan is only as broad as the connectors
              below, so an empty panel now means "we ran out of search", not "nobody is talking about
              this product".
            </span>
          </div>
        )}

        {connError && <div className="set-message err" style={{ padding: '12px 16px' }}>{connError}</div>}
        {connectors === null && !connError && <div className="set-loading">Probing connectors…</div>}

        {connectors && (
          <div className="conn-list">
            {connectors.length === 0 && <div className="set-desc">No connectors are enabled.</div>}
            {connectors.map((c) => {
              const open = openRow === c.name;
              // Credentials this connector declares, so they can be filled in
              // on the row that is complaining about them.
              const wants = (credentials ?? []).filter((cred) => cred.usedBy.includes(c.name)).map((cred) => cred.name);

              return (
                <div key={c.name}>
                  <button
                    className="conn-row agent-row"
                    onClick={() => { setOpenRow(open ? null : c.name); setEditing(null); }}
                  >
                    <span className="conn-dot" data-status={c.status} />
                    <span className="conn-name">
                      {c.name}
                      <span className="agent-desc"> — {c.description}</span>
                    </span>
                    {/* One cell, not one per tag. The row is a grid with a
                        fixed column count, so loose tags each claimed a column
                        and pushed the rest onto new grid rows — bright-data
                        rendered over five lines and brave over six. */}
                    <span className="conn-tags">
                      <span className={`tag ${STATUS_TAG[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                      {/* A role that is declared but not bound to a tool does
                          nothing. Shown differently for exactly that reason —
                          looking configured while doing nothing is the state the
                          whole connector list used to be in. */}
                      {(c.roles ?? []).map((role) => (
                        <span
                          key={role}
                          className={`tag ${(c.bound ?? []).includes(role) ? 'good' : 'plain'}`}
                          title={(c.bound ?? []).includes(role)
                            ? `Used for ${role}`
                            : `Declared for ${role} but no tool is bound, so it is not used`}
                        >
                          {role}{(c.bound ?? []).includes(role) ? '' : '?'}
                        </span>
                      ))}
                    </span>
                    <span className="conn-meta">
                      {c.status === 'ok' ? `${c.tools} tools${c.ms ? ` · ${c.ms}ms` : ''}` : ''}
                    </span>
                    <span className="conn-meta">{open ? '−' : '+'}</span>
                    {c.missing.length > 0 && (
                      <span className="conn-err">
                        needs {c.missing.join(', ')} — {open ? 'below' : 'open this row to add ' + (c.missing.length === 1 ? 'it' : 'them')}
                      </span>
                    )}
                    {c.error && <span className="conn-err">{c.error}</span>}
                  </button>

                  {open && (
                    <div className="conn-detail">
                      <RoleEditor
                        connector={c}
                        roleInfo={roleInfo}
                        inspection={inspection[c.name]}
                        onInspect={() => inspect(c.name)}
                        bindings={draftBindings[c.name] ?? {}}
                        setBindings={(next) => setDraftBindings((cur) => ({ ...cur, [c.name]: next }))}
                        onSave={() => saveRoles(c.name)}
                        onRemove={() => removeServer(c.name)}
                      />

                      <CredentialFields
                        names={wants}
                        credentials={credentials ?? []}
                        entries={entries}
                        onChange={(name, value) => setEntries({ ...entries, [name]: value })}
                        onClear={clearCredential}
                      />

                      <label className="cred-field">
                        <span className="cred-field-head"><code>endpoint</code></span>
                        <span className="cred-what">Where this connector is dialled. Local containers use a loopback port.</span>
                        <input
                          className="conn-url"
                          value={editing === c.name ? draftUrl : ''}
                          onChange={(e) => { setEditing(c.name); setDraftUrl(e.target.value); }}
                          placeholder="leave blank to keep the current endpoint"
                          spellCheck={false}
                        />
                      </label>

                      <div className="set-actions">
                        <button
                          className="primary"
                          disabled={savingKeys}
                          onClick={async () => {
                            if (editing === c.name && draftUrl.trim()) await patch(c.name, { url: draftUrl.trim() });
                            if (wants.some((n) => entries[n]?.trim())) await saveCredentials(wants);
                            else await recheck();
                          }}
                        >
                          {savingKeys ? 'Saving…' : 'Save & re-probe'}
                        </button>
                        <button className="ghost" onClick={() => patch(c.name, { enabled: false })}>
                          Disable this connector
                        </button>
                        {keyMessage && <span className={`set-message ${keyMessage.kind}`}>{keyMessage.text}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="set-desc">
          A disabled connector stays documented in the config with the reason it was switched off, and can
          be turned back on by setting <code>"enabled": true</code> there.
        </p>
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>Direct sources</strong>
          <span className="tag plain">read</span>
        </div>
        <p className="set-desc">
          Venues this asks <i>directly</i>, rather than asking a search engine about them. Everything
          else in discovery goes through Brave as a <code>site:</code> query, which is capped by what a
          general-purpose ranker chose to index — asked directly, Hacker News returns thousands of
          comments where the search route returns dozens of links. Most of these need no credential at
          all. A row that says <b>needs credentials</b> is a source contributing nothing to your scans.
        </p>

        {sources === null && <div className="set-loading">Loading sources…</div>}
        {sources && (
          <div className="conn-list">
            {sources.map((source) => {
              const open = openRow === `source:${source.id}`;
              const wants = [...source.requires, ...(source.optional ?? [])];
              return (
                <div key={source.id}>
                  <button
                    className="conn-row agent-row"
                    onClick={() => setOpenRow(open ? null : `source:${source.id}`)}
                  >
                    <span
                      className="conn-dot"
                      data-status={source.readiness === 'ready' ? 'ok' : 'unconfigured'}
                    />
                    <span className="conn-name">
                      {source.label}
                      <span className="agent-desc"> — {source.notes}</span>
                    </span>
                    <span className={`tag ${
                      source.readiness === 'ready' ? 'good'
                        : source.readiness === 'exhausted' ? 'critical' : 'warning'}`}
                    >
                      {source.readiness === 'ready'
                        ? (source.requires.length ? 'ready' : 'no key needed')
                        : source.readiness === 'exhausted' ? 'no credits'
                          : 'needs credentials'}
                    </span>
                    <span className="conn-meta">{wants.length ? (open ? '−' : '+') : ''}</span>
                  </button>

                  {source.readiness === 'exhausted' && (
                    <div className="notice" style={{ margin: '0 16px 10px' }}>
                      <span className="tag critical">no credits</span>
                      <span>
                        {source.exhaustedReason} Nothing is misconfigured — the key works, the
                        allowance is spent. Scans keep running on the other sources, so a thin
                        result right now means "we ran out of search", not "nobody is talking about
                        this product".
                      </span>
                      {source.links.map((link) => (link.billing ? (
                        <a key={link.name} className="conn-link" href={link.billing} target="_blank" rel="noreferrer">
                          top up ↗
                        </a>
                      ) : null))}
                    </div>
                  )}

                  {open && wants.length > 0 && (
                    <div className="conn-detail">
                      {source.requires.length === 0 && (
                        <p className="set-desc" style={{ padding: 0 }}>
                          This source runs without a credential. The one below only raises its rate
                          limit, so a large scan gets further before it is throttled.
                        </p>
                      )}
                      <CredentialFields
                        names={wants}
                        credentials={credentials ?? []}
                        entries={entries}
                        onChange={(name, value) => setEntries({ ...entries, [name]: value })}
                        onClear={clearCredential}
                      />
                      <div className="set-actions">
                        <button
                          className="primary"
                          disabled={savingKeys || !wants.some((n) => entries[n]?.trim())}
                          onClick={() => saveCredentials(wants)}
                        >
                          {savingKeys ? 'Saving…' : 'Save'}
                        </button>
                        {source.requires.length > 0 && (
                          <button className="ghost" disabled={testing === source.id} onClick={() => testSource(source.id)}>
                            {testing === source.id ? 'Testing…' : 'Test connection'}
                          </button>
                        )}
                        {keyMessage && <span className={`set-message ${keyMessage.kind}`}>{keyMessage.text}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>Write channels</strong>
          <span className="tag plain">config/channels.json</span>
        </div>
        <p className="set-desc">
          Where this app can send something to a real person or system. Kept apart from the connectors
          above on purpose: a misconfigured read returns nothing, a misconfigured write posts in the
          company's name to a stranger. Drafting and sending are always separate actions — nothing goes
          out unless it is explicitly asked for.
        </p>
        {channels === null ? (
          <div className="set-loading">Loading channels…</div>
        ) : (
          <div className="conn-list">
            {channels.map((channel) => {
              const open = openRow === `channel:${channel.id}`;
              const wants = (credentials ?? [])
                .filter((cred) => cred.usedBy.includes(channel.label))
                .map((cred) => cred.name);

              return (
                <div key={channel.id}>
                  <button
                    className="conn-row agent-row"
                    onClick={() => setOpenRow(open ? null : `channel:${channel.id}`)}
                  >
                    <span
                      className="conn-dot"
                      data-status={channel.readiness === 'ready' ? 'ok' : channel.readiness === 'needs-credentials' ? 'unconfigured' : 'planned'}
                    />
                    <span className="conn-name">
                      {channel.label}
                      <span className="agent-desc"> — {channel.notes}</span>
                    </span>
                    <span className={`tag ${READINESS_TAG[channel.readiness]}`}>
                      {READINESS_LABEL[channel.readiness]}
                    </span>
                    <span className="conn-meta">{channel.kind}</span>
                    <span className="conn-meta">{wants.length ? (open ? '−' : '+') : ''}</span>
                  </button>

                  {open && wants.length > 0 && (
                    <div className="conn-detail">
                      {channel.readiness === 'planned' && (
                        <p className="set-desc" style={{ padding: 0 }}>
                          <b>Not built</b> means nothing here can <i>send</i> yet — filling these in will
                          not make this channel post anything. They are here so the credentials are ready
                          when it is.
                          {channel.id === 'reddit' && (
                            <> Reddit is the exception worth knowing about: these same credentials
                            {' '}<i>are</i> used, right now, to <b>read</b> Reddit in discovery. Set them under
                            Direct sources above and this row goes on saying "not built", correctly —
                            reading and replying are different problems.</>
                          )}
                        </p>
                      )}
                      <CredentialFields
                        names={wants}
                        credentials={credentials ?? []}
                        entries={entries}
                        onChange={(name, value) => setEntries({ ...entries, [name]: value })}
                        onClear={clearCredential}
                      />
                      <div className="set-actions">
                        <button
                          className="primary"
                          disabled={savingKeys || !wants.some((n) => entries[n]?.trim())}
                          onClick={() => saveCredentials(wants)}
                        >
                          {savingKeys ? 'Saving…' : 'Save'}
                        </button>
                        {keyMessage && <span className={`set-message ${keyMessage.kind}`}>{keyMessage.text}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>Inference</strong>
          <span className="tag plain">config/inference.json</span>
        </div>
        <p className="set-desc">
          Model calls go straight to an OpenAI-compatible <code>/chat/completions</code> endpoint with the
          output schema attached. Point this at the upstream endpoint rather than a proxy in front of it:
          a proxy that accepts <code>response_format</code> and forwards the request without it returns
          prose that looks like success. <b>Test</b> below checks that specifically.
        </p>

        {inference === null ? (
          <div className="set-loading">Loading…</div>
        ) : (
          <>
            {inference.isExample && (
              <div className="set-message err" style={{ padding: '0 16px 14px' }}>
                Running off <code>config/inference.example.json</code> — those endpoints are placeholders.
                Saving here writes a real <code>config/inference.json</code>, which is gitignored.
              </div>
            )}

            <div className="set-actions">
              {inference.hosts.map((host) => {
                const holds = (['general', 'coding'] as ModelRole[]).filter((r) => inference.roles?.[r] === host.key);
                return (
                  <button
                    key={host.key}
                    className={host.key === hostKey ? 'primary' : 'ghost'}
                    onClick={() => selectHost(host.key)}
                    title={holds.length ? `handles: ${holds.join(', ')}` : 'handles nothing yet'}
                  >
                    {host.key}{holds.length ? ` · ${holds.join('+')}` : ''}
                  </button>
                );
              })}
              <button className="ghost" onClick={() => selectHost('')} title="Add a new host">+ new</button>
            </div>

            <div className="set-grid">
              <label>
                <span>Host name</span>
                <input
                  value={hostKey}
                  onChange={(e) => setHostKey(e.target.value)}
                  placeholder="local"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Model name</span>
                <input
                  value={draft.modelId}
                  onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                  placeholder="qwen3.8:27b"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="set-wide">
                <span>Base URL</span>
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="set-wide">
                <span>
                  API key <span className="agent-desc">— optional; a local endpoint usually needs none</span>
                </span>
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder={
                    inference.hosts.find((h) => h.key === hostKey)?.hasKey
                      ? 'a key is stored — type to replace it'
                      : 'no key stored'
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Context length</span>
                <input
                  value={draft.contextLength}
                  onChange={(e) => setDraft({ ...draft, contextLength: e.target.value.replace(/\D/g, '') })}
                  placeholder="15000"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Max output tokens</span>
                <input
                  value={draft.maxOutputTokens}
                  onChange={(e) => setDraft({ ...draft, maxOutputTokens: e.target.value.replace(/\D/g, '') })}
                  placeholder="4096"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>

            <p className="set-desc">
              Set the two sizes honestly — they decide how many items go into one batch, and a context
              claimed larger than it is truncates the JSON mid-object and loses the whole batch.
            </p>

            <div className="role-picker">
              <span className="cred-field-head"><code>this host handles</code></span>
              {(['general', 'coding'] as ModelRole[]).map((role) => (
                <label key={role} className="role-option">
                  <input
                    type="checkbox"
                    checked={draftRoles.includes(role)}
                    onChange={(e) => setDraftRoles(
                      e.target.checked
                        ? [...draftRoles, role]
                        : draftRoles.filter((r) => r !== role),
                    )}
                  />
                  <span><b>{role}</b> — {ROLE_MEANS[role]}</span>
                </label>
              ))}
              <span className="cred-where">
                A capable general model scores sentiment as well as anything and is markedly worse at
                patching unfamiliar code. Point <code>coding</code> at a code model when you have one;
                leave both here and everything uses this host.
              </span>
            </div>

            <div className="set-actions">
              <button className="primary" onClick={() => saveHost(false)} disabled={savingHost || !hostKey.trim()}>
                {savingHost ? 'Saving…' : 'Save'}
              </button>
              <button className="ghost" onClick={() => saveHost(true)} disabled={savingHost || !hostKey.trim()}>
                Save &amp; make default
              </button>
              <button className="ghost" onClick={probe} disabled={probing}>
                {probing ? 'Testing…' : 'Test'}
              </button>
              {inference.hosts.find((h) => h.key === hostKey)?.hasKey && (
                <button className="ghost" onClick={clearKey} disabled={savingHost}>Remove stored key</button>
              )}
              {infMessage && <span className={`set-message ${infMessage.kind}`}>{infMessage.text}</span>}
            </div>

            <p className="set-desc">
              In use now: <code>{health?.model ?? `${inference.active}/…`}</code>. The environment variable{' '}
              <code>INFERENCE_HOST</code> overrides the default without editing anything.
            </p>
          </>
        )}
      </div>

    </section>
  );
}

/** Say which of a server's tools does each job it has been given.
 *
 *  Only the binding now. Which roles a server is *in*, and in what order, is
 *  decided on the role chains above — a set of checkboxes scattered across
 *  collapsed connector rows could express membership but never priority, and
 *  priority is the whole reason to have more than one provider for a job.
 *
 *  Binding stays here because it is a fact about this server rather than about
 *  the ordering: which tool, and what its argument is called. Both are shown
 *  and both are editable, because a tool bound to the wrong role fails loudly
 *  while a query passed in the wrong argument does not — most servers answer
 *  that with something plausible and empty.
 */
function RoleEditor({
  connector, roleInfo, inspection, onInspect, bindings, setBindings, onSave, onRemove,
}: {
  connector: ConnectorStatus;
  roleInfo: RoleInfo[];
  inspection?: Inspection;
  onInspect: () => void;
  bindings: Partial<Record<ConnectorRole, { tool: string; arg: string }>>;
  setBindings: (next: Partial<Record<ConnectorRole, { tool: string; arg: string }>>) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const roles = connector.roles ?? [];

  return (
    <div style={{ marginBottom: 14 }}>
      <span className="cred-field-head"><code>tool bindings</code></span>

      {roles.length === 0 ? (
        <p className="cred-what">
          This server is not in any role chain, so nothing calls it. Put it in one under{' '}
          <b>Role chains</b> above, then come back to say which of its tools does the job.
        </p>
      ) : (
        <p className="cred-what">
          In {roles.map((r) => roleInfo.find((i) => i.id === r)?.label ?? r).join(' and ')}. Bind the
          tool that does each job — a member with nothing bound is skipped, however high it sits.
        </p>
      )}

      {roles.length > 0 && (
        <>
          {!inspection && (
            <div className="set-actions">
              <button className="ghost" onClick={onInspect}>List its tools to bind them</button>
            </div>
          )}
          {inspection && !inspection.reachable && (
            <p className="conn-err">Could not read its tools: {inspection.error}</p>
          )}
          {inspection?.reachable && (
            <div className="set-grid">
              {roles.map((role) => {
                const bound = bindings[role] ?? { tool: '', arg: '' };
                return (
                  <label key={role} className="set-wide">
                    <span>{role} — tool and argument</span>
                    <div className="actions">
                      <select
                        className="conn-url"
                        value={bound.tool}
                        onChange={(e) => {
                          const tool = e.target.value;
                          const args = inspection.tools.find((t) => t.name === tool)?.args ?? [];
                          setBindings({
                            ...bindings,
                            [role]: { tool, arg: bound.arg && args.includes(bound.arg) ? bound.arg : (args[0] ?? '') },
                          });
                        }}
                      >
                        <option value="">— pick a tool —</option>
                        {inspection.tools.map((t) => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                        ))}
                      </select>
                      <select
                        className="conn-url"
                        value={bound.arg}
                        onChange={(e) => setBindings({ ...bindings, [role]: { ...bound, arg: e.target.value } })}
                      >
                        <option value="">— argument —</option>
                        {(inspection.tools.find((t) => t.name === bound.tool)?.args ?? []).map((a) => (
                          <option key={a} value={a}>{a}</option>
                        ))}
                      </select>
                    </div>
                    {bound.tool && (
                      <span className="cred-where">
                        {inspection.tools.find((t) => t.name === bound.tool)?.description || 'no description given'}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="set-actions">
        {roles.length > 0 && <button className="primary" onClick={onSave}>Save bindings</button>}
        <button className="ghost" onClick={onRemove} title={`Remove ${connector.name} from the config`}>
          Remove this server
        </button>
      </div>
    </div>
  );
}

/** One role's providers, in the order they are tried.
 *
 *  An ordered list rather than a set of checkboxes, because the ordering is the
 *  setting that matters. "Who can search" was never the interesting question;
 *  "who is asked first when the first choice is out of credits" is, and a set
 *  cannot express it. Position one is the whole chain most days.
 *
 *  Drag to reorder, with arrows beside it. The arrows are not a fallback for
 *  browsers without drag — they are for anyone using a keyboard, and for the
 *  ordinary case of nudging one row past another, which is fiddlier to drag
 *  than to click.
 */
function RoleChain({
  role, providers, onChange,
}: {
  role: RoleInfo;
  providers: ProviderInfo[];
  onChange: (chain: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const ids = role.chain.map((e) => e.id);
  const absent = providers.filter((p) => !ids.includes(p.id));

  const drop = (onto: string) => {
    if (!dragging || dragging === onto) return;
    const next = ids.filter((id) => id !== dragging);
    next.splice(next.indexOf(onto), 0, dragging);
    onChange(next);
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="chain">
      <div className="chain-head">
        {/* Name and action on their own line, description under it. Sharing one
            row put a sentence beside a heading and made both hard to scan —
            the eye wants the role names as a column it can run down. */}
        <div className="chain-title">
          <strong>{role.label}</strong>
          <span className="chain-count">
            {role.chain.length === 0 ? 'nobody' : role.chain.length === 1 ? '1 provider' : `${role.chain.length} providers`}
          </span>
          <button className="ghost" onClick={() => setAdding(!adding)} disabled={absent.length === 0}>
            {adding ? 'Cancel' : '+ Add'}
          </button>
        </div>
        <p className="chain-uses">{role.uses}</p>
      </div>

      {role.chain.length === 0 ? (
        <p className="chain-empty">
          Nothing serves this role, so the pipeline skips it entirely.
        </p>
      ) : (
        <div className="chain-list">
          {role.chain.map((entry, index) => (
            <div
              key={entry.id}
              className={`chain-row${dragging === entry.id ? ' dragging' : ''}${over === entry.id ? ' over' : ''}`}
              draggable
              onDragStart={() => setDragging(entry.id)}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onDragOver={(e) => { e.preventDefault(); setOver(entry.id); }}
              onDrop={(e) => { e.preventDefault(); drop(entry.id); }}
            >
              <span className="chain-rank">{index + 1}</span>
              <span className="chain-grip" aria-hidden>⠿</span>
              <span className="chain-name">
                {entry.label}
                <span className="tag plain">{entry.kind}</span>
                {/* A provider at the front of the chain that cannot run is the
                    single most misleading state here: the list says it goes
                    first and it is silently skipped. */}
                {entry.hosts && (
                  <span className="conn-meta">{entry.hosts.join(', ')} only</span>
                )}
                {!entry.usable && <span className="conn-err"> {entry.problem}</span>}
              </span>
              <button className="chain-remove ghost" title={`Take ${entry.label} out of ${role.label}`}
                onClick={() => onChange(ids.filter((id) => id !== entry.id))}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Names only. This was a bulleted list with a description, a "looks
          right" badge and a missing-credentials badge per row — an explanation
          of every provider, restated inside every role, when the connector list
          below already says what each one is. The question being asked here is
          just "which one", so it is a row of names. */}
      {adding && (
        <div className="chain-add">
          {absent.map((p) => (
            <button
              key={p.id}
              className="ghost"
              onClick={() => { onChange([...ids, p.id]); setAdding(false); }}
            >
              {p.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
