/**
 * PNG export: rasterises the SVG export on a canvas. Uses a `data:` image URL (allowed by the
 * webview CSP) and returns base64 PNG data for the host to write.
 */

const MAX_SIDE = 8192;
const MAX_PIXELS = 48_000_000;

export function svgToPngBase64(svg: string, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const scale = Math.max(0.1, Math.min(2, MAX_SIDE / Math.max(width, height, 1), Math.sqrt(MAX_PIXELS / Math.max(width * height, 1))));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas is not available.'));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/png');
      const comma = url.indexOf(',');
      if (comma < 0) return reject(new Error('PNG encoding failed.'));
      resolve(url.slice(comma + 1));
    };
    img.onerror = () => reject(new Error('Could not rasterise the diagram.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
