import { useState } from 'react';

// Google profile photo URLs occasionally 404 (revoked sharing, deleted
// account) — fall back to a letter avatar instead of a broken image icon.
export default function Avatar({ photoUrl, name, email, className = 'w-7 h-7 text-xs' }) {
  const [errored, setErrored] = useState(false);
  const label = (name || email || '?').trim()[0]?.toUpperCase() || '?';

  if (photoUrl && !errored) {
    return (
      <img
        src={photoUrl}
        alt=""
        onError={() => setErrored(true)}
        className={`${className} rounded-full object-cover flex-shrink-0`}
      />
    );
  }

  return (
    <div className={`${className} rounded-full bg-primary-100 flex items-center justify-center font-bold text-primary-700 flex-shrink-0`}>
      {label}
    </div>
  );
}
