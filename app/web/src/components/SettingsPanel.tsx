import { useEffect, useState } from 'react';
import { api } from '../lib.ts';

interface RedditKeys {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
}

const EMPTY: RedditKeys = {
  clientId: '',
  clientSecret: '',
  username: '',
  password: '',
  userAgent: '',
};

/** Health of one MCP connector exactly as the server reports it. */
interface ConnectorStatus {
  name: string;
  status: 'ok' | 'needs-auth' | 'down';
  authStatus?: string;
  tools: number;
  error?: string;
}

const STATUS_LABEL: Record<ConnectorStatus['status'], string> = {
  ok: 'ok',
  'needs-auth': 'needs auth',
  down: 'down',
};

/** API keys for the search connectors. Reddit's are collected here because the
 *  Reddit MCP connector is unreliable — this app talks straight to Reddit's
 *  official API with PRAW instead. */
export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const [keys, setKeys] = useState<RedditKeys>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    api<RedditKeys>('api/settings/reddit')
      .then((s) => setKeys({ ...EMPTY, ...s }))
      .catch(() => setKeys(EMPTY))
      .finally(() => setLoaded(true));
    refreshConnectors();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  function refreshConnectors() {
    setConnError(null);
    api<ConnectorStatus[]>('api/connectors')
      .then(setConnectors)
      .catch(() => { setConnectors(null); setConnError('Could not reach TrueForge to check connectors.'); });
  }
  const reconnect = async () => {
    setReconnecting(true);
    setConnError(null);
    try {
      setConnectors(await api<ConnectorStatus[]>('api/connectors/reconnect', { method: 'POST' }));
    } catch {
      setConnError('Reconnect failed.');
    } finally {
      setReconnecting(false);
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
        <p>Search-connector API keys. Reddit is queried directly via its official API.</p>
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>Reddit API keys</strong>
          <span className="tag plain">official API via PRAW</span>
        </div>
        <p className="set-desc">
          Create an app at reddit.com/prefs/apps (script type) and paste the credentials below. They are
          stored on this machine only and never shown back to you once saved.
        </p>

        {!loaded ? (
          <div className="set-loading">Loading…</div>
        ) : (
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
        )}

        <div className="set-actions">
          <button className="primary" onClick={save} disabled={!loaded || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="ghost" onClick={test} disabled={!loaded || testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {message && <span className={`set-message ${message.kind}`}>{message.text}</span>}
        </div>
      </div>

      <div className="panel">
        <div className="set-head">
          <strong>Connector integrity</strong>
          <span className="tag plain">TrueForge MCP servers</span>
        </div>
        <div className="set-actions">
          <button className="ghost" onClick={reconnect} disabled={reconnecting}>
            {reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </button>
        </div>
        <p className="set-desc">
          The search connectors registered on this TrueForge instance, as TrueForge reports them. A healthy server
          mounts one or more tools; <b>needs auth</b> means it is registered but waiting on credentials, and <b>down</b> means
          the dial failed. Discovery only searches what is actually up.
        </p>
        {connError && <div className="set-message err" style={{ padding: '12px 16px' }}>{connError}</div>}
        {connectors === null && !connError && <div className="set-loading">Checking connectors…</div>}
        {connectors && (
          <div className="conn-list">
            {connectors.length === 0 && <div className="set-desc">No connectors registered.</div>}
            {connectors.map((c) => (
              <div key={c.name} className="conn-row">
                <span className="conn-dot" data-status={c.status} />
                <span className="conn-name">{c.name}</span>
                <span className={`tag ${c.status === 'ok' ? 'good' : c.status === 'needs-auth' ? 'warning' : 'critical'}`}>
                  {STATUS_LABEL[c.status]}
                </span>
                <span className="conn-meta">{c.tools} tools</span>
                {c.error && <span className="conn-err">{c.error}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
