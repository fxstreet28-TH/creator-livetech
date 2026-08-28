import { StarField } from '@/components/auth/StarField';
import { PrismStar } from '@/components/star/PrismStar';

interface HeroWelcomeProps {
  displayName: string;
  followingCount: number;
  subscriptionCount: number;
}

export function HeroWelcome({ displayName, followingCount, subscriptionCount }: HeroWelcomeProps) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-[radial-gradient(circle_at_20%_20%,#7c3aed44,transparent_50%),linear-gradient(135deg,#1a1230,#0d0b1e)] p-8">
      <StarField count={12} />
      <div className="relative z-10 flex flex-col gap-6 md:flex-row md:items-center">
        <div className="grow">
          <h1 className="text-3xl font-bold text-white">สวัสดี, {displayName} 👋</h1>
          <p className="mt-2 text-white/60">ค้นพบ Creator และห้อง Live ใหม่ ๆ ที่คุณจะรัก</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Stat label="กำลังติดตาม" value={`${followingCount} Creators`} />
            <Stat label="สมาชิกของ" value={`${subscriptionCount} ห้อง`} />
          </div>
        </div>
        <div className="hidden w-[200px] shrink-0 justify-center md:flex">
          <PrismStar size={96} aria-label="Star" />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm">
      <span className="text-white/50">{label}:</span>
      <span className="font-semibold text-white">{value}</span>
    </span>
  );
}
