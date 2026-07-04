import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../lib/api';

function ClassCard({ cls }) {
  return (
    <Link
      to={`/classes/${cls.id}`}
      className="card p-5 hover:shadow-md transition-shadow group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 flex items-center justify-center text-xl flex-shrink-0">
          🏫
        </div>
        {cls.active_lesson && (
          <span className="badge-green text-xs font-semibold px-2 py-1 rounded-full bg-green-100 text-green-800">
            Lesson active
          </span>
        )}
      </div>
      <h3 className="font-semibold text-slate-900 group-hover:text-primary-600 transition-colors">
        {cls.name}
      </h3>
      <p className="text-sm text-slate-500 mt-0.5">
        {cls.student_count ?? 0} student{cls.student_count !== 1 ? 's' : ''}
      </p>
      {cls.google_course_id && (
        <p className="text-xs text-slate-400 mt-1">Google Classroom synced</p>
      )}
    </Link>
  );
}

export default function Classes() {
  const { data: classes = [], isLoading, error } = useQuery({
    queryKey: ['classes'],
    queryFn:  () => api.get('/classes'),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">My Classes</h1>
          <p className="text-slate-500 text-sm mt-0.5">Start class sessions and monitor student activity</p>
        </div>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card p-5 animate-pulse">
              <div className="w-10 h-10 rounded-xl bg-slate-100 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-2/3 mb-2" />
              <div className="h-3 bg-slate-100 rounded w-1/3" />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="card p-6 text-center text-red-600">
          Failed to load classes: {error.message}
        </div>
      )}

      {!isLoading && !error && classes.length === 0 && (
        <div className="card p-10 text-center text-slate-500">
          <div className="text-4xl mb-3">🏫</div>
          <p className="font-medium">No classes assigned yet</p>
          <p className="text-sm mt-1">Ask your administrator to assign classes to your account.</p>
        </div>
      )}

      {!isLoading && classes.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {classes.map(cls => <ClassCard key={cls.id} cls={cls} />)}
        </div>
      )}
    </div>
  );
}
