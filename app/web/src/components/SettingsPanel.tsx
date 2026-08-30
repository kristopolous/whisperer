import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.ts';

interface RedditKeys {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
}

const EMPTY: RedditKeys = { clientId: '', clientSecret: '', username: '', password: '', userAgent: '' };

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
}

interface Credential {
  name: string;
  /** Connectors and channels that want this one. */
  usedBy: string[];
  kind: 'connector' | 'channel';
  source: 'dashboard' | 'environment' | 'missing';
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

interface Inference {
  default: string;
  active: string;
  isExample: boolean;
  hosts: InferenceHost[];
}

interface Health {
  servers: string[];
  model: string;
  inference: { host: string; baseUrl: string; isExample: boolean };
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
export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const [keys, setKeys] = useState<RedditKeys>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftUrl, setDraftUrl] = useState('');

  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [channels, setChannels] = useState<ChannelState[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  const [inference, setInference] = useState<Inference | null>(null);
  const [hostKey, setHostKey] = useState('');
  const [draft, setDraft] = useState({ baseUrl: '', modelId: '', apiKey: '', contextLength: '', maxOutputTokens: '' });
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
    api<RedditKeys>('api/settings/reddit')
      .then((s) => setKeys({ ...EMPTY, ...s }))
      .catch(() => setKeys(EMPTY))
      .finally(() => setLoaded(true));
    api<Credential[]>('api/credentials').then(setCredentials).catch(() => setCredentials(null));
    api<ChannelState[]>('api/channels').then(setChannels).catch(() => setChannels(null));
    api<Health>('api/health').then(setHealth).catch(() => setHealth(null));
    api<Inference>('api/inference').then(applyInference).catch(() => setInference(null));
    refreshConnectors();
  }, [refreshConnectors, applyInference]);

  const selectHost = (key: string) => {
    const host = inference?.hosts.find((h) => h.key === key);
    setHostKey(key);
    setInfMessage(null);
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
  const saveCredentials = async () => {
    const filled = Object.fromEntries(Object.entries(entries).filter(([, v]) => v.trim()));
    if (Object.keys(filled).length === 0) return;
    setSavingKeys(true);
    setKeyMessage(null);
    try {
      setConnectors(await api<ConnectorStatus[]>('api/credentials', {
        method: 'PUT',
        body: JSON.stringify(filled),
      }));
      setEntries({});
      setCredentials(await api<Credential[]>('api/credentials'));
      setChannels(await api<ChannelState[]>('api/channels').catch(() => null) as ChannelState[] | null);
      setKeyMessage({ kind: 'ok', text: `Saved ${Object.keys(filled).length} credential(s) and re-probed.` });
    } catch (error) {
      setKeyMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '') });
    } finally {
      setSavingKeys(false);
    }
  };

  const clearCredential = async (name: string) => {
    setSavingKeys(true);
    try {
      setConnectors(await api<ConnectorStatus[]>('api/credentials', {
        method: 'PUT',
        body: JSON.stringify({ [name]: '' }),
      }));
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

  const set = (field: keyof RedditKeys) => (value: string) => {
    setKeys((k) => ({ ...k, [field]: value }));
    setMessage(null);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<RedditKeys>('api/settings/reddit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keys),
      });
      setKeys({ ...EMPTY, ...saved });
      setMessage({ kind: 'ok', text: 'Saved.' });
    } catch {
      setMessage({ kind: 'err', text: 'Could not save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch('api/settings/reddit/test', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setMessage(
        data.ok
          ? { kind: 'ok', text: 'Connected to Reddit. Keys work.' }
          : { kind: 'err', text: data.error || 'Connection failed.' },
      );
    } catch {
      setMessage({ kind: 'err', text: 'Could not reach the server.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section>
      {onClose && (
        <button className="ghost back-to-scans" onClick={onClose}>← Back to scans</button>
      )}
      <div className="rubric">
        <h2>Settings</h2>
        <p>The connectors this instance reads from, the channels it can write to, and where inference runs.</p>
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
        </div>
        <p className="set-desc">
          Each connector is an MCP endpoint dialled directly over HTTP — nothing brokers these, so a row
          below is the result of an actual <code>tools/list</code> against that service. <b>ok</b> means it
          answered and mounted tools. <b>no credentials</b> means the environment variables it declares are
          missing, so it was never dialled. <b>down</b> means it was dialled and failed, with the reason.
          Endpoint edits are written to <code>config/connectors.json</code>; credentials go in the
          Credentials panel below and are stored on this machine.
        </p>

        {connError && <div className="set-message err" style={{ padding: '12px 16px' }}>{connError}</div>}
        {connectors === null && !connError && <div className="set-loading">Probing connectors…</div>}

        {connectors && (
          <div className="conn-list">
            {connectors.length === 0 && <div className="set-desc">No connectors are enabled.</div>}
            {connectors.map((c) => (
              <div key={c.name}>
                <div className="conn-row">
                  <span className="conn-dot" data-status={c.status} />
                  <span className="conn-name">
                    {c.name}
                    <span className="agent-desc"> — {c.description}</span>
                  </span>
                  <span className={`tag ${STATUS_TAG[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                  <span className="conn-meta">
                    {c.status === 'ok' ? `${c.tools} tools${c.ms ? ` · ${c.ms}ms` : ''}` : ''}
                  </span>

                  {c.missing.length > 0 && (
                    <span className="conn-err">
                      needs {c.missing.join(', ')} — add {c.missing.length === 1 ? 'it' : 'them'} under
                      Credentials below
                    </span>
                  )}
                  {c.error && <span className="conn-err">{c.error}</span>}

                  <span className="conn-err conn-edit">
                    {editing === c.name ? (
                      <>
                        <input
                          className="conn-url"
                          value={draftUrl}
                          onChange={(e) => setDraftUrl(e.target.value)}
                          spellCheck={false}
                          autoFocus
                        />
                        <button className="ghost" onClick={() => patch(c.name, { url: draftUrl })}>save</button>
                        <button className="ghost" onClick={() => setEditing(null)}>cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          className="ghost conn-link"
                          onClick={() => { setEditing(c.name); setDraftUrl(''); }}
                          title="Change this connector's endpoint"
                        >
                          edit endpoint
                        </button>
                        <button
                          className="ghost conn-link"
                          onClick={() => patch(c.name, { enabled: false })}
                          title="Take this connector out of the running set"
                        >
                          disable
                        </button>
                      </>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="set-desc">
          A disabled connector stays documented in the config with the reason it was switched off, and can
          be turned back on by setting <code>"enabled": true</code> there.
        </p>
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>Credentials</strong>
          <span className="tag plain">stored on this machine</span>
        </div>
        <p className="set-desc">
          Every key the configured connectors and channels ask for, by name. Entered here they are
          written to <code>data/secrets.json</code> on this machine and take precedence over anything
          exported in the environment — nothing is sent anywhere and nothing is ever read back into
          this page. Saving re-probes the connectors, so you find out immediately whether a key works.
        </p>

        {credentials === null ? (
          <div className="set-loading">Loading…</div>
        ) : credentials.length === 0 ? (
          <div className="set-desc">No connector or channel declares a credential.</div>
        ) : (
          <>
            <div className="conn-list">
              {credentials.map((cred) => (
                <div key={cred.name} className="conn-row cred-row">
                  <span className="conn-dot" data-status={cred.source === 'missing' ? 'unconfigured' : 'ok'} />
                  <span className="conn-name">
                    <code>{cred.name}</code>
                    <span className="agent-desc"> — {cred.usedBy.join(', ')}</span>
                  </span>
                  <span className={`tag ${cred.source === 'missing' ? 'warning' : 'good'}`}>
                    {cred.source === 'missing' ? 'not set' : cred.source === 'dashboard' ? 'set here' : 'from .env'}
                  </span>
                  <span className="conn-meta">
                    {cred.source === 'dashboard' && (
                      <button className="ghost conn-link" onClick={() => clearCredential(cred.name)} disabled={savingKeys}>
                        remove
                      </button>
                    )}
                  </span>
                  <span className="conn-err cred-input">
                    <input
                      type="password"
                      className="conn-url"
                      value={entries[cred.name] ?? ''}
                      onChange={(e) => setEntries({ ...entries, [cred.name]: e.target.value })}
                      placeholder={cred.source === 'missing' ? `paste ${cred.name}` : 'set — type to replace'}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </span>
                </div>
              ))}
            </div>
            <div className="set-actions">
              <button
                className="primary"
                onClick={saveCredentials}
                disabled={savingKeys || Object.values(entries).every((v) => !v.trim())}
              >
                {savingKeys ? 'Saving…' : 'Save & re-probe'}
              </button>
              {keyMessage && <span className={`set-message ${keyMessage.kind}`}>{keyMessage.text}</span>}
            </div>
          </>
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
            {channels.map((channel) => (
              <div key={channel.id} className="conn-row">
                <span className="conn-dot" data-status={channel.readiness === 'ready' ? 'ok' : channel.readiness === 'needs-credentials' ? 'unconfigured' : 'planned'} />
                <span className="conn-name">{channel.label}</span>
                <span className={`tag ${READINESS_TAG[channel.readiness]}`}>
                  {READINESS_LABEL[channel.readiness]}
                </span>
                <span className="conn-meta">{channel.kind}</span>
                <span className="conn-err">
                  {channel.missing.length > 0 ? `needs ${channel.missing.join(', ')} (add above) — ` : ''}
                  {channel.notes}
                </span>
              </div>
            ))}
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
              {inference.hosts.map((host) => (
                <button
                  key={host.key}
                  className={host.key === hostKey ? 'primary' : 'ghost'}
                  onClick={() => selectHost(host.key)}
                >
                  {host.key}{host.key === inference.active ? ' ·' : ''}
                </button>
              ))}
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

      <div className="panel">
        <div className="set-head">
          <strong>Reddit API keys</strong>
          <span className="tag plain">official API via PRAW</span>
        </div>
        <p className="set-desc">
          Create an app at reddit.com/prefs/apps (script type) and paste the credentials below. They are
          stored on this machine only and never shown back to you once saved. Scans do not use these —
          Reddit pages are read through the scraping connector, because Reddit blocks unauthenticated
          requests from this network. These are here for the Reddit write channel above, which is not
          built yet.
        </p>

        {!loaded ? (
          <div className="set-loading">Loading…</div>
        ) : (
          <>
            <div className="set-grid">
              <label>
                <span>Client ID</span>
                <input value={keys.clientId} onChange={(e) => set('clientId')(e.target.value)}
                  placeholder="e.g. xyzABC123" autoComplete="off" spellCheck={false} />
              </label>
              <label>
                <span>Client secret</span>
                <input type="password" value={keys.clientSecret} onChange={(e) => set('clientSecret')(e.target.value)}
                  placeholder="••••••••" autoComplete="off" spellCheck={false} />
              </label>
              <label>
                <span>Username</span>
                <input value={keys.username} onChange={(e) => set('username')(e.target.value)}
                  placeholder="your reddit username" autoComplete="username" spellCheck={false} />
              </label>
              <label>
                <span>Password</span>
                <input type="password" value={keys.password} onChange={(e) => set('password')(e.target.value)}
                  placeholder="••••••••" autoComplete="current-password" spellCheck={false} />
              </label>
              <label className="set-wide">
                <span>User agent</span>
                <input value={keys.userAgent} onChange={(e) => set('userAgent')(e.target.value)}
                  placeholder="whisperer-rep-forensics/1.0 (reputation monitoring)" autoComplete="off" spellCheck={false} />
              </label>
            </div>
            <div className="set-actions">
              <button className="primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="ghost" onClick={test} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {message && <span className={`set-message ${message.kind}`}>{message.text}</span>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
