import { mockCreators } from '@/lib/mockData';
import { CreatorCard } from './CreatorCard';

export function RecommendedCreators() {
  return (
    <section>
      <h2 className="text-xl font-bold text-white">แนะนำสำหรับคุณ</h2>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {mockCreators.map((c) => (
          <CreatorCard key={c.id} creator={c} />
        ))}
      </div>
    </section>
  );
}
