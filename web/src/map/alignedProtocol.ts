import maplibregl from 'maplibre-gl';
import { computeAlignedTileSpec } from './geo';

let isRegistered = false;

const MAX_ALIGNED_CACHE = 256;
const alignedTileCache = new Map<string, ArrayBuffer>();

function getCachedAligned(key: string): ArrayBuffer | null {
  const hit = alignedTileCache.get(key);
  if (!hit) return null;
  // 刷新 LRU 顺序，并返回拷贝防止 MapLibre Worker transfer 导致原 Buffer detach
  alignedTileCache.delete(key);
  alignedTileCache.set(key, hit);
  return hit.slice(0);
}

function putCachedAligned(key: string, data: ArrayBuffer) {
  if (alignedTileCache.size >= MAX_ALIGNED_CACHE) {
    const oldestKey = alignedTileCache.keys().next().value;
    if (oldestKey !== undefined) {
      alignedTileCache.delete(oldestKey);
    }
  }
  alignedTileCache.set(key, data.slice(0));
}

async function fetchImageBitmap(
  url: string,
  signal?: AbortSignal,
  cacheMode: RequestCache = 'force-cache',
): Promise<ImageBitmap | null> {
  const resp = await fetch(url, { signal, cache: cacheMode });
  if (!resp.ok) return null;
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

// 注册自定义协议 aligned-tile://<provider>/<targetCRS>/<z>/<x>/<y>，用于跨 CRS 路网瓦片像素级对齐。
export function ensureAlignedTileProtocol() {
  if (isRegistered) return;
  isRegistered = true;

  maplibregl.addProtocol('aligned-tile', async (params, abortController) => {
    const rawPath = params.url.replace(/^aligned-tile:\/\//, '');
    const [provider, targetCrs, zStr, xStr, yStr] = rawPath.split('/');
    const isTraffic = provider === 'amap-traffic';
    const cacheKey = isTraffic ? `${rawPath}@${Math.floor(Date.now() / 120000)}` : rawPath;
    const cacheMode: RequestCache = isTraffic ? 'default' : 'force-cache';

    const cached = getCachedAligned(cacheKey);
    if (cached) {
      return { data: cached };
    }

    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);

    if (!provider || (targetCrs !== 'wgs84' && targetCrs !== 'gcj02') || Number.isNaN(z) || Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error(`Invalid aligned-tile URL: ${params.url}`);
    }

    const spec = computeAlignedTileSpec(z, x, y, targetCrs, 'gcj02');

    // 无偏移（如海外区域）直接返回单张瓦片，跳过 Canvas 合成
    if (spec.isIdentity) {
      const url = `/api/tile-proxy?provider=${encodeURIComponent(provider)}&z=${z}&x=${x}&y=${y}`;
      const resp = await fetch(url, { signal: abortController.signal, cache: cacheMode });
      if (!resp.ok) throw new Error(`Tile proxy failed: ${resp.status}`);
      const buf = await resp.arrayBuffer();
      putCachedAligned(cacheKey, buf);
      return { data: buf };
    }

    const ratio = provider === 'google-road' ? 2 : 1;
    const tilePx = 256 * ratio;

    const canvas = document.createElement('canvas');
    canvas.width = tilePx;
    canvas.height = tilePx;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    await Promise.all(
      spec.sources.map(async (tile) => {
        const url = `/api/tile-proxy?provider=${encodeURIComponent(provider)}&z=${z}&x=${tile.x}&y=${tile.y}`;
        try {
          const bmp = await fetchImageBitmap(url, abortController.signal, cacheMode);
          if (bmp) {
            ctx.drawImage(bmp, tile.drawX * ratio, tile.drawY * ratio, tilePx, tilePx);
            bmp.close();
          }
        } catch {
          // 单块边缘瓦片缺失时保持透明，不阻塞整块渲染
        }
      }),
    );

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to encode aligned tile');
    const buf = await blob.arrayBuffer();
    putCachedAligned(cacheKey, buf);
    return { data: buf };
  });
}
