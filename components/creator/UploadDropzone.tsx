'use client';

/**
 * Pick a video file, validate it, and probe its duration before anything is
 * sent anywhere.
 *
 * The probe is not cosmetic: `duration_seconds` decides whether the post is a
 * short or a long video, and that is what `check_creator_can_upload` measures
 * a free-tier creator against. A file whose metadata will not load is one we
 * cannot classify, so it is refused here rather than rejected by the backend
 * after the creator has waited through a 200 MB upload.
 */

import { useCallback, useRef, useState } from 'react';
import { FileVideo, Loader2, UploadCloud, X } from 'lucide-react';
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  ACCEPTED_VIDEO_TYPES,
  FILE_INPUT_ACCEPT,
  MAX_FILE_BYTES,
} from '@/lib/creator/constants';
import { formatDuration, formatFileSize } from '@/lib/creator/format';
import { probeVideoFile } from '@/lib/creator/uploader';

export interface SelectedVideo {
  file: File;
  durationSeconds: number;
  width: number;
  height: number;
}

interface UploadDropzoneProps {
  selected: SelectedVideo | null;
  onSelect: (video: SelectedVideo | null) => void;
  disabled?: boolean;
}

function isAcceptedVideo(file: File): boolean {
  if ((ACCEPTED_VIDEO_TYPES as readonly string[]).includes(file.type)) return true;
  // Windows Chrome hands us an empty type for some .mov files, and a few
  // Android pickers report 'application/octet-stream'. Fall back to the name.
  const name = file.name.toLowerCase();
  return ACCEPTED_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function UploadDropzone({ selected, onSelect, disabled = false }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!isAcceptedVideo(file)) {
        onSelect(null);
        setError('รองรับเฉพาะไฟล์วิดีโอ (MP4, MOV, WebM)');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        onSelect(null);
        setError('ไฟล์ใหญ่เกิน 2 GB — กรุณาบีบอัดก่อนอัปโหลด');
        return;
      }

      setProbing(true);
      try {
        const probed = await probeVideoFile(file);
        onSelect({ file, ...probed });
      } catch (err) {
        console.error('[UploadDropzone] duration probe failed', err);
        onSelect(null);
        setError('อ่านข้อมูลวิดีโอไม่สำเร็จ ไฟล์อาจเสียหาย กรุณาเลือกไฟล์อื่น');
      } finally {
        setProbing(false);
      }
    },
    [onSelect],
  );

  const openPicker = () => {
    if (disabled || probing) return;
    inputRef.current?.click();
  };

  const clear = () => {
    onSelect(null);
    setError(null);
    // Without this the same file cannot be re-picked: the input's value is
    // unchanged, so `change` never fires a second time.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="min-w-0">
      <div
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={[
          'relative flex min-h-[13rem] flex-col items-center justify-center rounded-2xl border border-dashed p-6 text-center transition',
          dragging
            ? 'border-cyan-300/70 bg-cyan-400/[0.07]'
            : 'border-white/15 bg-white/[0.03] backdrop-blur-xl',
          disabled ? 'opacity-60' : '',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          accept={FILE_INPUT_ACCEPT}
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        {probing ? (
          <div className="flex flex-col items-center gap-3 text-white/70">
            <Loader2 size={28} className="animate-spin text-cyan-300" aria-hidden />
            <p className="text-sm" role="status">
              กำลังอ่านข้อมูลวิดีโอ...
            </p>
          </div>
        ) : selected ? (
          <div className="flex w-full flex-col items-center gap-3">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-purple-500/30 to-cyan-500/25">
              <FileVideo size={26} className="text-cyan-200" aria-hidden />
            </div>
            <p className="w-full break-all px-2 text-sm font-semibold text-white">
              {selected.file.name}
            </p>
            <p className="text-xs text-white/55">
              {formatFileSize(selected.file.size)} · {formatDuration(selected.durationSeconds)}
              {selected.width > 0 && ` · ${selected.width}×${selected.height}`}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={openPicker}
                disabled={disabled}
                className="inline-flex min-h-11 items-center rounded-xl border border-white/12 bg-white/[0.04] px-4 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                เลือกไฟล์อื่น
              </button>
              <button
                type="button"
                onClick={clear}
                disabled={disabled}
                aria-label="ลบไฟล์ที่เลือก"
                className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-3 text-sm text-white/45 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <X size={16} aria-hidden />
                ลบ
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={openPicker}
            disabled={disabled}
            className="flex min-h-11 w-full flex-col items-center gap-3 rounded-xl px-2 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-purple-500/30 to-cyan-500/25">
              <UploadCloud size={26} className="text-cyan-200" aria-hidden />
            </div>
            <span className="text-base font-semibold text-white">
              ลากไฟล์วิดีโอมาวาง หรือแตะเพื่อเลือก
            </span>
            <span className="text-xs leading-relaxed text-white/45">
              MP4, MOV หรือ WebM · ไม่เกิน 2 GB
            </span>
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}
    </div>
  );
}
