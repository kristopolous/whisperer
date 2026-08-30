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
            {cred?.where && <span className="cred-where">{cred.where}</span>}
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
    api<Health>('api/health').then(setHealth).catch(() => setHealth(null));
    api<Inference>('api/inference').then(applyInference).catch(() => setInference(null));
    refreshConnectors();
  }, [refreshConnectors, applyInference]);

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
      if (draftRoles.length) body.roles = draftRoles;

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
          Open a row to set its credentials and endpoint. Endpoints are written to{' '}
          <code>config/connectors.json</code>; credentials are stored on this machine and never
          shown back to you. Saving re-probes, so you find out immediately whether a key works.
        </p>

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
                    <span className={`tag ${STATUS_TAG[c.status]}`}>{STATUS_LABEL[c.status]}</span>
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
                          This channel is not built yet — filling these in will not make it send anything.
                          They are here so the credentials are ready when it is.
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
