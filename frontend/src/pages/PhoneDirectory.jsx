import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiMagnify, mdiPhoneOutline } from '@mdi/js';
import api from '../lib/api';

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function PhoneDirectory() {
  const [search, setSearch] = useState('');
  const inputRef = useRef(null);
  const q = useDebounced(search);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['phone-directory', q],
    queryFn:  () => api.get(`/phones/directory-search?q=${encodeURIComponent(q)}`),
    enabled:  q.trim().length >= 2,
    staleTime: 30_000,
  });

  const showResults = q.trim().length >= 2;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Phone Directory</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Search by name, extension, or building
        </p>
      </div>

      <div className="relative mb-6">
        <MdiIcon
          path={mdiMagnify}
          size="1.1em"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
        />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search name, extension, or building…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="input w-full pl-9"
          autoFocus
        />
        {isFetching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        )}
      </div>

      {!showResults && (
        <div className="card p-10 text-center text-slate-400">
          <MdiIcon path={mdiPhoneOutline} size="2.5em" className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Type at least 2 characters to search</p>
        </div>
      )}

      {showResults && !isFetching && results.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <p className="text-sm">No directory entries found for <strong className="text-slate-600">"{q}"</strong></p>
        </div>
      )}

      {showResults && results.length > 0 && (
        <div className="card divide-y divide-slate-100 overflow-hidden">
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                <MdiIcon path={mdiPhoneOutline} size="1em" className="text-blue-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-slate-900">
                  {r.display_name || '—'}
                </div>
                <div className="text-xs text-slate-500">
                  {[r.building, r.room_number].filter(Boolean).join(' · ')}
                </div>
              </div>
              {r.extension && (
                <a
                  href={`tel:${r.extension}`}
                  className="text-sm font-mono font-semibold text-primary-600 hover:text-primary-700 flex-shrink-0"
                >
                  ext. {r.extension}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
