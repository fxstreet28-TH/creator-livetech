import {
  LineChart,
  Sparkles,
  Briefcase,
  Bitcoin,
  HeartPulse,
  GraduationCap,
  type LucideIcon,
} from 'lucide-react';

const CATEGORIES: { label: string; icon: LucideIcon }[] = [
  { label: 'Traders & Analysis', icon: LineChart },
  { label: 'ดูดวง & Spiritual', icon: Sparkles },
  { label: 'Business & Coaching', icon: Briefcase },
  { label: 'Crypto & Web3', icon: Bitcoin },
  { label: 'Wellness', icon: HeartPulse },
  { label: 'Education', icon: GraduationCap },
];

export function PopularCategories() {
  return (
    <section>
      <h2 className="text-xl font-bold text-white">หมวดหมู่ยอดนิยม</h2>
      <div className="mt-4 flex flex-wrap gap-2">
        {CATEGORIES.map(({ label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            className="flex items-center gap-2 rounded-full border border-white/10 px-4 py-3 text-sm text-white/80 transition hover:border-purple-500/40 hover:bg-purple-500/20"
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
