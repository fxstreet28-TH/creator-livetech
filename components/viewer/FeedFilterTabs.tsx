'use client';

/**
 * ทั้งหมด / กำลังติดตาม / 🔴 ไลฟ์ switcher for /discover.
 *
 * A radio group rather than three buttons: they are mutually exclusive views
 * of one list, which is what a radio group means to a screen reader, and it
 * gets arrow-key navigation for free from the roles.
 */

export type FeedTab = 'all' | 'following' | 'live';

export const FEED_TABS: { value: FeedTab; label: string }[] = [
  { value: 'all', label: 'ทั้งหมด' },
  { value: 'following', label: 'กำลังติดตาม' },
  { value: 'live', label: '🔴 ไลฟ์' },
];

/** Narrow an arbitrary ?tab= value. Anything unrecognised falls back to 'all'. */
export function parseFeedTab(value: string | null | undefined): FeedTab {
  return FEED_TABS.some((tab) => tab.value === value) ? (value as FeedTab) : 'all';
}

interface FeedFilterTabsProps {
  value: FeedTab;
  onChange: (tab: FeedTab) => void;
}

export function FeedFilterTabs({ value, onChange }: FeedFilterTabsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="ตัวกรองเนื้อหา"
      className="flex gap-1 overflow-x-auto rounded-2xl border border-white/10 bg-white/5 p-1 backdrop-blur-xl"
    >
      {FEED_TABS.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(tab.value)}
            className={`min-h-11 flex-1 whitespace-nowrap rounded-xl px-4 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
              active
                ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg shadow-purple-500/25'
                : 'text-white/60 hover:bg-white/5 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
