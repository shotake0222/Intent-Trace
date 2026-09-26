import { useRef } from "react";

export interface Photo {
  blob: Blob;
  name: string;
  url: string;
}

/** 写真を長辺1600pxのJPEGに縮小（現場の回線・オフライン保存容量対策） */
async function compress(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob((b) => res(b ?? file), "image/jpeg", 0.82));
  } catch {
    return file;
  }
}

export function PhotoPicker({ photos, onChange, max = 5 }: { photos: Photo[]; onChange: (p: Photo[]) => void; max?: number }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="mb-1 text-sm font-semibold text-slate-700">写真（{photos.length}/{max}）</div>
      <div className="flex flex-wrap gap-2">
        {photos.map((p, i) => (
          <div key={p.url} className="relative">
            <img src={p.url} className="h-20 w-20 rounded-xl object-cover" alt="" />
            <button
              type="button"
              onClick={() => {
                URL.revokeObjectURL(p.url);
                onChange(photos.filter((_, j) => j !== i));
              }}
              className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-slate-900 text-xs text-white"
            >
              ✕
            </button>
          </div>
        ))}
        {photos.length < max && (
          <button type="button" onClick={() => ref.current?.click()} className="grid h-20 w-20 place-items-center rounded-xl border-2 border-dashed border-slate-300 text-2xl text-slate-400">
            ＋
          </button>
        )}
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const blob = await compress(f);
          onChange([...photos, { blob, name: `photo-${Date.now()}.jpg`, url: URL.createObjectURL(blob) }]);
        }}
      />
    </div>
  );
}
