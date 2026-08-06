import { mockLiveSessions, getCreator } from '@/lib/mockData';
import { LiveCard } from './LiveCard';

export function LiveNowCarousel() {
  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">🔴 กำลังไลฟ์ตอนนี้</h2>
        <a href="/live" className="text-sm text-purple-300 transition hover:text-purple-200">
          ดูทั้งหมด →
        </a>
      </div>
      <div className="mt-4 flex snap-x gap-4 overflow-x-auto pb-2">
        {mockLiveSessions.map((s) => {
          const creator = getCreator(s.creatorId);
          return (
            <LiveCard
              key={s.id}
              session={s}
              creatorName={creator?.displayName ?? 'Creator'}
              creatorAvatar={creator?.avatarUrl ?? null}
            />
          );
        })}
      </div>
    </section>
  );
}
