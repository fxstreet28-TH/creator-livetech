import Link from 'next/link';

export function ComingSoon({ title }: { title: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#0a0a15] px-6 text-center text-white">
      <div>
        <p className="text-sm tracking-[0.2em] text-purple-300">AURUM LIVE</p>
        <h1 className="mt-3 text-3xl font-bold">{title}</h1>
        <p className="mt-2 text-white/50">เร็ว ๆ นี้</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-2.5 text-sm font-semibold"
        >
          ← กลับแดชบอร์ด
        </Link>
      </div>
    </main>
  );
}
