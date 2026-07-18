import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import api from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

const ROLES = { student: 0, teacher: 1, admin: 2, superadmin: 3 };

const MD_COMPONENTS = {
  h1: (p) => <h1 className="text-xl font-bold text-slate-900 mt-4 mb-2" {...p} />,
  h2: (p) => <h2 className="text-lg font-semibold text-slate-900 mt-4 mb-2" {...p} />,
  h3: (p) => <h3 className="text-base font-semibold text-slate-800 mt-3 mb-1.5" {...p} />,
  p:  (p) => <p className="text-sm text-slate-700 mb-3 leading-relaxed" {...p} />,
  ul: (p) => <ul className="text-sm text-slate-700 mb-3 list-disc pl-5 space-y-1" {...p} />,
  ol: (p) => <ol className="text-sm text-slate-700 mb-3 list-decimal pl-5 space-y-1" {...p} />,
  li: (p) => <li {...p} />,
  strong: (p) => <strong className="font-semibold text-slate-900" {...p} />,
  code: (p) => <code className="bg-slate-100 text-slate-800 rounded px-1 py-0.5 text-xs font-mono" {...p} />,
  pre:  (p) => <pre className="bg-slate-900 text-slate-100 rounded p-3 text-xs overflow-x-auto mb-3" {...p} />,
  a:    (p) => <a className="text-primary-600 hover:underline" {...p} />,
  blockquote: (p) => <blockquote className="border-l-2 border-slate-300 pl-3 text-slate-500 italic mb-3" {...p} />,
};

function ArticleEditor({ article, onClose }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(article?.title || '');
  const [slug, setSlug] = useState(article?.slug || '');
  const [category, setCategory] = useState(article?.category || '');
  const [content, setContent] = useState(article?.content || '');
  const [pagePaths, setPagePaths] = useState((article?.page_paths || []).join(', '));
  const [error, setError] = useState(null);

  const save = useMutation({
    mutationFn: () => {
      const body = { title, category, content, page_paths: pagePaths.split(',').map(s => s.trim()).filter(Boolean) };
      return article
        ? api.put(`/kb/${article.id}`, body)
        : api.post('/kb', { ...body, slug });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kb-articles'] }); onClose(); },
    onError: (err) => setError(err.message),
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/kb/${article.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kb-articles'] }); onClose(true); },
  });

  return (
    <div className="card p-5 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase">Title</label>
          <input className="input text-sm w-full" value={title} onChange={e => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase">Category</label>
          <input className="input text-sm w-full" value={category} onChange={e => setCategory(e.target.value)} />
        </div>
      </div>
      {!article && (
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase">Slug (URL, lowercase-with-dashes)</label>
          <input className="input text-sm w-full font-mono" value={slug} onChange={e => setSlug(e.target.value)} />
        </div>
      )}
      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase">Linked Pages (comma-separated, e.g. /admin/backup)</label>
        <input className="input text-sm w-full font-mono" value={pagePaths} onChange={e => setPagePaths(e.target.value)} />
      </div>
      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase">Content (Markdown)</label>
        <textarea className="input text-sm w-full font-mono" rows={16} value={content} onChange={e => setContent(e.target.value)} />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button className="text-xs text-slate-400" onClick={() => onClose()}>Cancel</button>
        </div>
        {article && (
          <button className="text-xs text-red-600 hover:underline" onClick={() => { if (confirm('Delete this article?')) del.mutate(); }}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export default function HelpCenterPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const isAdmin = (ROLES[user?.role] ?? 0) >= ROLES.admin;

  const { data: myPermissions } = useQuery({
    queryKey: ['my-permissions'],
    queryFn: () => api.get('/users/me/permissions'),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  const canEdit = myPermissions?.unrestricted || myPermissions?.permissions?.includes('knowledge_base');

  const { data: articles = [] } = useQuery({ queryKey: ['kb-articles'], queryFn: () => api.get('/kb') });
  const { data: article } = useQuery({
    queryKey: ['kb-article', slug],
    queryFn: () => api.get(`/kb/${slug}`),
    enabled: !!slug && slug !== 'new',
  });

  useEffect(() => { setEditing(false); }, [slug]);

  const filtered = articles.filter(a =>
    !search || a.title.toLowerCase().includes(search.toLowerCase()) || a.category.toLowerCase().includes(search.toLowerCase())
  );
  const byCategory = filtered.reduce((acc, a) => { (acc[a.category] = acc[a.category] || []).push(a); return acc; }, {});

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-slate-900">Help Center</h1>
        {canEdit && !slug && (
          <button className="btn-secondary text-sm" onClick={() => navigate('/help/new')}>+ New Article</button>
        )}
      </div>
      <p className="text-slate-500 text-sm mb-6">Every how-to guide in ClassGuard lives here. Pages also link directly to the relevant article via the help button.</p>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1">
          <input
            type="text"
            className="input text-sm w-full mb-3"
            placeholder="Search guides…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="space-y-4">
            {Object.entries(byCategory).map(([cat, items]) => (
              <div key={cat}>
                <div className="text-xs font-semibold text-slate-400 uppercase mb-1">{cat}</div>
                <div className="space-y-0.5">
                  {items.map(a => (
                    <button
                      key={a.id}
                      onClick={() => navigate(`/help/${a.slug}`)}
                      className={`w-full text-left text-sm px-2 py-1.5 rounded ${slug === a.slug ? 'bg-primary-50 text-primary-700 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}
                    >
                      {a.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!filtered.length && <p className="text-sm text-slate-400">No guides found.</p>}
          </div>
        </div>

        <div className="lg:col-span-3">
          {slug === 'new' ? (
            <ArticleEditor onClose={(deleted) => navigate(deleted ? '/help' : '/help')} />
          ) : !slug ? (
            <div className="card p-12 text-center text-slate-400 text-sm">Select a guide from the list to read it.</div>
          ) : !article ? (
            <div className="card p-12 text-center text-slate-400 text-sm">Loading…</div>
          ) : editing ? (
            <ArticleEditor article={article} onClose={() => setEditing(false)} />
          ) : (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-xl font-bold text-slate-900">{article.title}</h2>
                <div className="flex items-center gap-3">
                  {article.wiki_url && (
                    <a
                      href={article.wiki_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary-600 hover:underline"
                      title="Open this guide on the public wiki"
                    >
                      View on wiki ↗
                    </a>
                  )}
                  {canEdit && (
                    <button className="text-xs text-primary-600 hover:underline" onClick={() => setEditing(true)}>Edit</button>
                  )}
                </div>
              </div>
              <div className="text-xs text-slate-400 mb-4">
                {article.category} · reviewed {new Date(article.updated_at).toLocaleDateString()}
                {article.content_version && <> · <span className="font-mono">v{article.content_version}</span></>}
              </div>
              <ReactMarkdown components={MD_COMPONENTS}>{article.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
