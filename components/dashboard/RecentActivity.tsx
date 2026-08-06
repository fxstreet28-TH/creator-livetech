import { mockActivities, getCreator, formatRelativeThai, type MockActivity } from '@/lib/mockData';
import { Avatar } from './Avatar';

const VERB: Record<MockActivity['type'], string> = {
  live_started: 'เพิ่งเริ่มไลฟ์',
  content_posted: 'โพสต์คอนเทนต์ใหม่',
  new_subscriber: 'มีอัปเดตใหม่',
};

export function RecentActivity() {
  return (
    <section>
      <h2 className="text-xl font-bold text-white">กิจกรรมล่าสุด</h2>
      <div className="mt-4 space-y-3">
        {mockActivities.map((a) => {
          const creator = getCreator(a.creatorId);
          const name = creator?.displayName ?? 'Creator';
          return (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-2xl bg-[#14142b]/80 p-3 backdrop-blur-sm"
            >
              <Avatar name={name} src={creator?.avatarUrl ?? null} size={32} />
              <p className="min-w-0 flex-1 text-sm text-white/80">
                <span className="font-semibold text-white">{name}</span> {VERB[a.type]}:{' '}
                <span className="text-white/60">{a.title}</span>
              </p>
              <span className="shrink-0 text-xs text-white/40">
                {formatRelativeThai(a.timestamp)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
