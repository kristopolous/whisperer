import { useRef, useState } from 'react';

/** Minimal demo sign-in. Real auth is out of scope; this just gates the
 *  dashboard behind a well-known local credential (demo / demo) and keeps the
 *  session for the tab so a refresh doesn't bounce you out. */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (user.trim() === 'demo' && pass === 'demo') {
      setError(false);
      onLogin();
    } else {
      setError(true);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="wordmark login-mark">Whis<span>·</span>perer</div>
        <p className="login-sub">reputation forensics — sign in to continue</p>

        <label className="login-label" htmlFor="login-user">Email or username</label>
        <input
          ref={inputRef}
          id="login-user"
          className="login-input"
          type="text"
          autoComplete="username"
          value={user}
          onChange={(event) => { setUser(event.target.value); setError(false); }}
          autoFocus
        />

        <label className="login-label" htmlFor="login-pass">Password</label>
        <input
          id="login-pass"
          className="login-input"
          type="password"
          autoComplete="current-password"
          value={pass}
          onChange={(event) => { setPass(event.target.value); setError(false); }}
        />

        {error && <div className="login-error">That's not right — try demo / demo.</div>}

        <button className="login-btn" type="submit" disabled={!user.trim() || !pass}>
          Sign in
        </button>
      </form>
    </div>
  );
}
