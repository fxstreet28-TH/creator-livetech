'use client';

/**
 * The wallet's history, in three tabs: everything, purchases, buybacks.
 *
 * "Everything" is a merge rather than a fourth query. Purchases and buybacks
 * come from their own tables, and the star ledger contributes only the events
 * those two do not already describe — spends, tips, expirations — because a
 * succeeded purchase writes a row in both places and listing both would
 * report one purchase twice. See DUPLICATED_LEDGER_TYPES in useWalletHistory.
 */

import { useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Clock, Sparkles } from 'lucide-react';
import {
  useWalletHistory,
  type BuybackEntry,
  type LedgerEntry,
  type PurchaseEntry,
} from '@/lib/hooks/useWalletHistory';
import { bankDisplayName } from '@/lib/constants/thaiBanks';
import { formatDateTime, formatStars, formatThbWithUnit, maskBankAccount } from '@/lib/wallet/format';

export type HistoryTab = 'all' | 'purchases' | 'buyback';

const TABS: Array<{ id: HistoryTab; label: string }> = [
  { id: 'all', label: 'ประวัติทั้งหมด' },
  { id: 'purchases', label: 'การซื้อ' },
  { id: 'buyback', label: 'Buyback' },
];

/**
 * Status pills.
 *
 * The buyback set is the one the database actually allows — pending,
 * approved, paid, rejected, cancelled. The Week 3 brief called the
 * in-progress state "processing", but buyback_requests' CHECK constraint
 * spells it "approved", so that is what can ever arrive here; a row is
 * labelled by what the database can hold, not by what the brief called it.
 * Unknown values fall through to a neutral pill rather than rendering blank.
 */
const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending: { label: 'รอดำเนินการ', className: 'bg-amber-400/15 text-amber-200 border-amber-400/30' },
  succeeded: { label: 'สำเร็จ', className: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30' },
  paid: { label: 'โอนแล้ว', className: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30' },
  approved: { label: 'กำลังดำเนินการ', className: 'bg-sky-400/15 text-sky-200 border-sky-400/30' },
  failed: { label: 'ไม่สำเร็จ', className: 'bg-red-500/15 text-red-200 border-red-500/30' },
  rejected: { label: 'ถูกปฏิเสธ', className: 'bg-red-500/15 text-red-200 border-red-500/30' },
  canceled: { label: 'ยกเลิก', className: 'bg-white/8 text-white/50 border-white/12' },
  cancelled: { label: 'ยกเลิก', className: 'bg-white/8 text-white/50 border-white/12' },
};

function StatusBadge({ status }: { status: string }) {
  const entry = STATUS_LABELS[status] ?? {
    label: status,
    className: 'bg-white/8 text-white/50 border-white/12',
  };
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${entry.className}`}
    >
      {entry.label}
    </span>
  );
}

/** Thai labels for the star ledger's transaction_type values. */
const LEDGER_LABELS: Record<string, string> = {
  subscribe: 'สมัครสมาชิก',
  ppv_unlock: 'ปลดล็อกเนื้อหา',
  ppv_message: 'ปลดล็อกข้อความ',
  tip: 'ทิป',
  expiration: 'Stars หมดอายุ',
};

interface WalletHistoryProps {
  /** Initial tab, from ?tab= on the wallet page. */
  initialTab?: HistoryTab;
}

export function WalletHistory({ initialTab = 'all' }: WalletHistoryProps) {
  const [tab, setTab] = useState<HistoryTab>(initialTab);
  const history = useWalletHistory();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Arrow-key navigation across the tablist, per the ARIA tabs pattern.
   *
   * Without it a keyboard user can reach the first tab and then nothing:
   * roving tabindex takes the other two out of the tab order (which is the
   * point — Tab should move past the whole tablist to the panel, not step
   * through every tab), so the arrow keys have to be what moves between
   * them. Selection follows focus, which is the right choice here because
   * switching panels is instant and has no cost.
   */
  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const lastIndex = TABS.length - 1;
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight') nextIndex = index === lastIndex ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') nextIndex = index === 0 ? lastIndex : index - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = lastIndex;

    if (nextIndex === null) return;
    event.preventDefault();
    setTab(TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  /**
   * One list, newest first. Purchases and buybacks keep their own row
   * renderers; only the sort key is unified.
   */
  const combined = useMemo(() => {
    const rows: Array<{ key: string; at: string; node: React.ReactNode }> = [
      ...history.purchases.map((entry) => ({
        key: `p:${entry.id}`,
        at: entry.createdAt,
        node: <PurchaseRow entry={entry} />,
      })),
      ...history.buybacks.map((entry) => ({
        key: `b:${entry.id}`,
        at: entry.requestedAt,
        node: <BuybackRow entry={entry} />,
      })),
      ...history.ledger.map((entry) => ({
        key: `l:${entry.id}`,
        at: entry.createdAt,
        node: <LedgerRow entry={entry} />,
      })),
    ];
    return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [history.purchases, history.buybacks, history.ledger]);

  return (
    <section className="mt-8">
      <h2 className="sr-only">ประวัติกระเป๋าเงิน</h2>

      <div role="tablist" aria-label="ประวัติกระเป๋าเงิน" className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((item, index) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`wallet-tab-${item.id}`}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              aria-selected={active}
              aria-controls={`wallet-panel-${item.id}`}
              // Roving tabindex: one stop for the whole tablist.
              tabIndex={active ? 0 : -1}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              onClick={() => setTab(item.id)}
              className={`min-h-11 shrink-0 rounded-xl border px-4 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                active
                  ? 'border-purple-400/60 bg-purple-500/15 text-purple-100'
                  : 'border-white/8 bg-white/[0.03] text-white/55 hover:bg-white/[0.06] hover:text-white/80'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {history.error && (
        <p role="alert" className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          {history.error}
        </p>
      )}

      <div
        role="tabpanel"
        id={`wallet-panel-${tab}`}
        aria-labelledby={`wallet-tab-${tab}`}
        // Focusable so Tab out of the tablist lands on the panel it just
        // selected, rather than skipping past the content entirely.
        tabIndex={0}
        className="mt-4 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        {history.loading ? (
          <HistorySkeleton />
        ) : tab === 'all' ? (
          combined.length === 0 ? (
            <EmptyState message="ยังไม่มีประวัติการทำรายการ" />
          ) : (
            <ul className="flex flex-col gap-2">
              {combined.map((row) => (
                <li key={row.key}>{row.node}</li>
              ))}
            </ul>
          )
        ) : tab === 'purchases' ? (
          history.purchases.length === 0 ? (
            <EmptyState message="ยังไม่มีประวัติการซื้อ" />
          ) : (
            <ul className="flex flex-col gap-2">
              {history.purchases.map((entry) => (
                <li key={entry.id}>
                  <PurchaseRow entry={entry} />
                </li>
              ))}
            </ul>
          )
        ) : history.buybacks.length === 0 ? (
          <EmptyState message="ยังไม่มีประวัติ buyback" />
        ) : (
          <ul className="flex flex-col gap-2">
            {history.buybacks.map((entry) => (
              <li key={entry.id}>
                <BuybackRow entry={entry} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">{children}</div>
  );
}

function PurchaseRow({ entry }: { entry: PurchaseEntry }) {
  return (
    <Row>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-purple-500/15 text-purple-200">
            <Sparkles size={16} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">
              ซื้อ {formatStars(entry.stars)} Stars
            </p>
            <p className="mt-0.5 text-xs text-white/45">
              {formatThbWithUnit(entry.amountThb)} · PromptPay
            </p>
            <p className="mt-1 text-xs text-white/35">
              {formatDateTime(entry.paidAt ?? entry.createdAt)}
            </p>
          </div>
        </div>
        <StatusBadge status={entry.status} />
      </div>
    </Row>
  );
}

function BuybackRow({ entry }: { entry: BuybackEntry }) {
  return (
    <Row>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-500/15 text-sky-200">
            <ArrowUpRight size={16} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">
              ขาย {formatStars(entry.stars)} Stars
            </p>
            <p className="mt-0.5 text-xs text-white/45">
              รับ {formatThbWithUnit(entry.totalThb)}
            </p>
            <p className="mt-0.5 truncate text-xs text-white/45">
              {bankDisplayName(entry.bankName)} · {maskBankAccount(entry.bankAccountNumber)}
            </p>
            <p className="mt-1 text-xs text-white/35">
              ขอเมื่อ {formatDateTime(entry.requestedAt)}
            </p>
            {entry.status === 'paid' && entry.processedAt && (
              <p className="mt-0.5 text-xs text-emerald-300/80">
                โอนเมื่อ {formatDateTime(entry.processedAt)}
              </p>
            )}
            {entry.status === 'rejected' && entry.rejectionReason && (
              <p className="mt-1 text-xs text-red-300">เหตุผล: {entry.rejectionReason}</p>
            )}
          </div>
        </div>
        <StatusBadge status={entry.status} />
      </div>
    </Row>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const credit = entry.starsDelta > 0;
  return (
    <Row>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
              credit ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/8 text-white/50'
            }`}
          >
            {credit ? (
              <ArrowDownLeft size={16} aria-hidden />
            ) : (
              <Clock size={16} aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">
              {LEDGER_LABELS[entry.type] ?? entry.type}
            </p>
            <p className="mt-1 text-xs text-white/35">{formatDateTime(entry.createdAt)}</p>
          </div>
        </div>
        <span
          className={`shrink-0 text-sm font-semibold tabular-nums ${
            credit ? 'text-emerald-300' : 'text-white/60'
          }`}
        >
          {credit ? '+' : ''}
          {formatStars(entry.starsDelta)}
        </span>
      </div>
    </Row>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-white/40">
      {message}
    </p>
  );
}

function HistorySkeleton() {
  return (
    <ul className="flex animate-pulse flex-col gap-2" aria-busy="true" aria-label="กำลังโหลดประวัติ">
      {[0, 1, 2].map((n) => (
        <li key={n} className="h-[5.5rem] rounded-xl bg-white/[0.05]" />
      ))}
    </ul>
  );
}
