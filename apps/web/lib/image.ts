/** Largest screenshot the API accepts (decoded bytes). Keep a margin under its 550 kB limit. */
const MAX_BYTES = 500 * 1024;

const bytesOf = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/**
 * Turns a picked screenshot into a JPEG data URL small enough to upload: at most 1600 px on the long side,
 * re-encoded at lower quality (and smaller size) until it fits. Also strips any photo metadata (location etc.).
 */
export async function toProofDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|heic|heif)$/i.test(file.type) && !/\.(png|jpe?g|webp|heic|heif)$/i.test(file.name)) throw new Error('Pick an image (a screenshot of the payment).');
  if (file.size > 25 * 1024 * 1024) throw new Error('That file is too large. Pick the screenshot of the payment.');
  // Read as a data: URL (the site's CSP allows data: images, not blob: URLs).
  const url = await new Promise<string>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => bad(new Error('Couldn’t read that file.'));
    r.readAsDataURL(file);
  });
  {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('Couldn’t open that image. Try a PNG or JPG screenshot.'));
      i.src = url;
    });
    let side = 1600;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      for (const q of [0.82, 0.7, 0.58]) {
        const d = c.toDataURL('image/jpeg', q);
        if (bytesOf(d) <= MAX_BYTES) return d;
      }
      side = Math.round(side * 0.75);
    }
    throw new Error('Couldn’t make that image small enough. Crop the screenshot and try again.');
  }
}
