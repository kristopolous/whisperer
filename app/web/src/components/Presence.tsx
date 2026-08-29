import type { Profile } from '../../../shared/types.ts';

export function Presence({ profiles }: { profiles: Profile[] }) {
  if (profiles.length === 0) return null;
  return (
    <div className="presence">
      {profiles.map((p) => (
        <a className="chip" key={p.url} href={p.url} target="_blank" rel="noreferrer">
          {p.platform} <b>{p.handle}</b>
        </a>
      ))}
    </div>
  );
}
