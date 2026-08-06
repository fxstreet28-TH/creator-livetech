interface AvatarProps {
  name: string;
  src?: string | null;
  size?: number;
  /** Draw a gradient ring around the avatar. */
  ring?: boolean;
}

/**
 * Reusable circular avatar. Renders the image when a src is given, otherwise
 * falls back to the first initial on a purple→pink gradient.
 */
export function Avatar({ name, src, size = 32, ring = false }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-purple-500 to-pink-500 font-semibold text-white ${
        ring ? 'ring-2 ring-purple-400/60 ring-offset-2 ring-offset-[#0a0a15]' : ''
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {src ? (
        // Remote DiceBear SVGs — plain img avoids next/image remote config.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} width={size} height={size} className="h-full w-full object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}
