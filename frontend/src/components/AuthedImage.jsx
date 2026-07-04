import { useState, useEffect } from 'react';

// <img> for API endpoints behind Bearer auth — a plain <img src> can't send
// the Authorization header, so this fetches the bytes and renders a blob URL.
// Used for ClassPulse slide images and the safety-screenshot viewer.
export default function AuthedImage({ src, alt = '', className = '', style }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [failed,  setFailed]  = useState(false);

  useEffect(() => {
    let revoked = null;
    let cancelled = false;
    setBlobUrl(null);
    setFailed(false);

    const token = localStorage.getItem('cg_token');
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(blob => {
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setBlobUrl(revoked);
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [src]);

  if (failed) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 text-slate-400 text-xs ${className}`} style={style}>
        Image unavailable
      </div>
    );
  }
  if (!blobUrl) {
    return <div className={`animate-pulse bg-slate-100 ${className}`} style={style} />;
  }
  return <img src={blobUrl} alt={alt} className={className} style={style} />;
}
