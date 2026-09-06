import { useCallback, useEffect, useState } from 'react';
import type { Scan } from '../../../shared/types.ts';
import { api } from '../lib.ts';

interface Project {
  company: string;
  specified: { url?: string; tracker?: string; path?: string; testCommand?: string };
  discovered: { url?: string; tracker?: string };
  source: Record<string, 'specified' | 'discovered' | 'default' | 'none'>;
  effective: { url?: string; tracker?: string; path?: string; testCommand?: string };
  workspace: string | null;
}

const FIELDS = [
  {
    key: 'url' as const,
    label: 'Code',
    what: 'Where the source lives. Cloned shallow on first use, read-only — the fix runner copies it before touching anything.',
    placeholder: 'https://github.com/owner/name.git',
  },
  {
    key: 'tracker' as const,
    label: 'Bug tracker',
    what:
      'Where existing issues are read from, folded into the corpus so triage can merge a filed bug '
      + 'with the people grumbling about the same thing. GitHub, GitLab and Bugzilla are understood. '
      + 'Defaults to the code host; set it when the tracker lives somewhere else.',
    placeholder: 'https://bugs.kde.org/rest/bug?product=krita',
  },
  {
    key: 'testCommand' as const,
    label: 'Test command',
    what: 'Only needed when it cannot be detected. pytest, npm test, cargo test and go test are recognised.',
    placeholder: 'pytest -q',
  },
];

/** Where this company's code and issues actually are.
 *
 *  Discovery answers these from a name and a website, which is usually right
 *  and occasionally confidently wrong — and a wrong repository does not fail,
 *  it produces a perfectly plausible diagnosis of the wrong software. So both
 *  answers are shown: what was worked out, and what somebody said. Typed values
 *  win, and clearing one hands the question back to discovery rather than
 *  leaving a hole.
 *
 *  Kept per company rather than per scan. That a project's tracker is a
 *  Bugzilla on another host is a durable fact about the project; losing it on
 *  the next scan would mean typing it in again every time.
 */
export function ProjectPanel({ scan }: { scan: Scan }) {
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setProject(await api<Project>(`api/scans/${scan.id}/project`));
    } catch {
      setProject(null);
    }
  }, [scan.id]);

  useEffect(() => { setDraft({}); void load(); }, [load]);

  const save = async (key: string) => {
    setSaving(key);
    setMessage(null);
    try {
      const next = await api<Project>(`api/scans/${scan.id}/project`, {
        method: 'PUT', body: JSON.stringify({ [key]: draft[key] ?? '' }),
      });
      setProject(next);
      setDraft((d) => { const { [key]: _gone, ...rest } = d; void _gone; return rest; });
      setMessage({ kind: 'ok', text: 'Saved. It applies to the next diagnosis or scan.' });
    } catch (error) {
      setMessage({ kind: 'err', text: String(error).replace(/^Error:\s*/, '').slice(0, 240) });
    } finally {
      setSaving(null);
    }
  };

  if (!project) return <div className="panel"><div className="set-loading">Loading project settings…</div></div>;

  return (
    <div className="panel card-stack">
      <div className="set-head">
        <strong>{scan.company}</strong>
        <span className="tag plain">config/repos.json</span>
      </div>
      <p className="set-desc">
        Where this project's code and issues are. Each is worked out automatically where it can be —
        a wrong guess does not fail loudly, it produces a plausible diagnosis of the wrong software,
        so what was guessed is shown next to what you can set. Anything you type wins; clear it and
        the guess applies again.
      </p>

      <div className="project-fields">
        {FIELDS.map((field) => {
          const specified = project.specified[field.key] ?? '';
          const discovered = field.key === 'testCommand' ? '' : (project.discovered[field.key] ?? '');
          const effective = project.effective[field.key] ?? '';
          const value = draft[field.key] ?? specified;
          const dirty = draft[field.key] !== undefined && draft[field.key] !== specified;

          return (
            <div key={field.key} className="project-field">
              <div className="project-field-head">
                <strong>{field.label}</strong>
                {/* Four states, because "discovered" was covering two of them
                    and one of those was not a discovery at all. */}
                {{
                  specified: <span className="tag good">you set this</span>,
                  discovered: <span className="tag plain">discovered</span>,
                  default: <span className="tag plain">defaulted</span>,
                  none: <span className="tag warning">not known</span>,
                }[project.source[field.key] ?? (specified ? 'specified' : effective ? 'default' : 'none')]}
              </div>
              <p className="project-field-what">{field.what}</p>

              <div className="actions">
                <input
                  className="conn-url"
                  value={value}
                  spellCheck={false}
                  placeholder={discovered || field.placeholder}
                  onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                />
                <button className="primary" disabled={!dirty || saving === field.key} onClick={() => save(field.key)}>
                  {saving === field.key ? 'Saving…' : 'Save'}
                </button>
                {specified && (
                  <button
                    className="ghost"
                    disabled={saving === field.key}
                    onClick={() => { setDraft({ ...draft, [field.key]: '' }); void save(field.key); }}
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Only worth saying when the two differ — otherwise it is the
                  same string printed twice. */}
              {specified && discovered && specified !== discovered && (
                <p className="project-field-note">
                  Discovery said <code>{discovered}</code>, and is being overruled.
                </p>
              )}
              {!specified && discovered && (
                <p className="project-field-note">Using what discovery found.</p>
              )}
              {/* The tracker's default, said out loud. It was the one badge on
                  this screen with no explanation under it, because the branch
                  that would have written one requires a discovered value and
                  nothing ever discovers a tracker. */}
              {project.source[field.key] === 'default' && effective && (
                <p className="project-field-note">
                  Nothing discovered this. Defaulting to <code>{effective}</code>, because a GitHub
                  or GitLab repository is its own issue tracker — set it here if this project files
                  bugs somewhere else.
                </p>
              )}
              {!effective && (
                <p className="project-field-note">
                  Nothing to use — the steps that need this are unavailable until it is set.
                </p>
              )}
            </div>
          );
        })}

        <div className="project-field">
          <div className="project-field-head">
            <strong>Local checkout</strong>
            {project.workspace
              ? <span className="tag good">{project.workspace}</span>
              : <span className="tag plain">none</span>}
          </div>
          <p className="project-field-what">
            For private code, where there is no clone URL this app could use — and no credential it
            should be holding. Clone it into the workspace yourself and pick it under{' '}
            <b>Health → Go into the source</b>. It beats everything above when set.
          </p>
        </div>
      </div>

      {message && <div className={`set-message ${message.kind}`} style={{ padding: '0 16px 14px' }}>{message.text}</div>}
    </div>
  );
}
