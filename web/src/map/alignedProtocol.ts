import maplibregl from 'maplibre-gl';
import { computeAlignedTileSpec, computeBaiduAlignedTileSpec } from './geo';

let isRegistered = false;

const MAX_ALIGNED_CACHE = 256;
const MAX_SOURCE_BLOB_CACHE = 256;

const alignedTileCache = new Map<string, ArrayBuffer>();
const sourceBlobCache = new Map<string, Blob>();
const inflightSourceFetch = new Map<string, Promise<Blob | null>>();

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

function getCachedSourceBlob(url: string): Blob | null {
  const hit = sourceBlobCache.get(url);
  if (!hit) return null;
  sourceBlobCache.delete(url);
  sourceBlobCache.set(url, hit);
  return hit;
}

function putCachedSourceBlob(url: string, blob: Blob) {
  if (sourceBlobCache.size >= MAX_SOURCE_BLOB_CACHE) {
    const oldestKey = sourceBlobCache.keys().next().value;
    if (oldestKey !== undefined) {
      sourceBlobCache.delete(oldestKey);
    }
  }
  sourceBlobCache.set(url, blob);
}

function formatBaiduCoord(v: number): string {
  return v < 0 ? `M${-v}` : `${v}`;
}

// 百度 maponline0~3.bdimg.com 原生支持 CORS(*)，浏览器 4 域名直连免后端代理中转。
function buildBaiduDirectTileUrl(provider: string, z: number, x: number, y: number): string {
  const sub = (((x + y) % 4) + 4) % 4;
  const bx = formatBaiduCoord(x);
  const by = formatBaiduCoord(y);
  if (provider === 'baidu-sat') {
    return `https://maponline${sub}.bdimg.com/starpic/?qt=satepc&u=x=${bx};y=${by};z=${z};v=009;type=sate&fm=46`;
  }
  const style = provider === 'baidu-road' ? 'sl' : 'pl';
  return `https://maponline${sub}.bdimg.com/tile/?qt=vtile&x=${bx}&y=${by}&z=${z}&styles=${style}&scaler=2&udt=20250101`;
}

// 除高德实时路况(无 CORS 头需走同源代理)外，高德/Google 路网均支持 ACA-Origin:*，4 域名直连免后端中转。
function buildOverlayTileUrl(provider: string, z: number, x: number, y: number): string {
  switch (provider) {
    case 'amap-label': {
      const sub = ((x + y) % 4) + 1;
      return `https://webst0${sub}.is.autonavi.com/appmaptile?style=8&ltype=4&x=${x}&y=${y}&z=${z}`;
    }
    case 'amap-road': {
      const sub = ((x + y) % 4) + 1;
      return `https://webst0${sub}.is.autonavi.com/appmaptile?style=8&x=${x}&y=${y}&z=${z}`;
    }
    case 'google-road': {
      const sub = (x + y) % 4;
      return `https://mt${sub}.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x=${x}&y=${y}&z=${z}`;
    }
    default:
      return `/api/tile-proxy?provider=${encodeURIComponent(provider)}&z=${z}&x=${x}&y=${y}`;
  }
}

// 带 in-flight 去重与内存 LRU 缓存的源瓦片拉取，避免相邻瓦片重复下载同一张源瓦片。
async function fetchSourceBitmap(
  url: string,
  signal?: AbortSignal,
  cacheable = true,
): Promise<ImageBitmap | null> {
  if (cacheable) {
    const cachedBlob = getCachedSourceBlob(url);
    if (cachedBlob) {
      return createImageBitmap(cachedBlob);
    }
  }

  let pending = cacheable ? inflightSourceFetch.get(url) : undefined;
  if (!pending) {
    pending = fetch(url, {
      signal: cacheable ? undefined : signal,
      mode: url.startsWith('http') ? 'cors' : 'same-origin',
      cache: cacheable ? 'force-cache' : 'default',
    })
      .then(async (resp) => {
        if (!resp.ok) return null;
        const blob = await resp.blob();
        if (cacheable && blob.size > 0) {
          putCachedSourceBlob(url, blob);
        }
        return blob;
      })
      .catch(() => null)
      .finally(() => {
        if (cacheable) {
          inflightSourceFetch.delete(url);
        }
      });

    if (cacheable) {
      inflightSourceFetch.set(url, pending);
    }
  }

  const blob = await pending;
  if (!blob || signal?.aborted) return null;
  return createImageBitmap(blob);
}

// 优先编码为 WebP（支持透明且 512×512 编码速度远快于 PNG），不支持时自动回退 PNG。
async function encodeCanvasFast(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (b) => {
        if (b && b.size > 0) {
          resolve(b);
        } else {
          canvas.toBlob(resolve, 'image/png');
        }
      },
      'image/webp',
      0.92,
    );
  });
  if (!blob) throw new Error('Failed to encode aligned tile');
  return blob.arrayBuffer();
}

// 注册自定义协议 aligned-tile://<provider>/<targetCRS>/<z>/<x>/<y>，用于跨 CRS 路网与百度瓦片像素级对齐。
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

    if (
      !provider ||
      (targetCrs !== 'wgs84' && targetCrs !== 'gcj02') ||
      Number.isNaN(z) ||
      Number.isNaN(x) ||
      Number.isNaN(y)
    ) {
      throw new Error(`Invalid aligned-tile URL: ${params.url}`);
    }

    // 百度地图使用 BD-09 + BD09MC 自定义平面墨卡托网格，4 域名直连 + 源瓦片去重 + WebP 快速重投影
    if (provider.startsWith('baidu-')) {
      const bdSpec = computeBaiduAlignedTileSpec(z, x, y, targetCrs);
      const ratio = provider === 'baidu-sat' ? 1 : 2;
      const tilePx = 256 * ratio;

      const canvas = document.createElement('canvas');
      canvas.width = tilePx;
      canvas.height = tilePx;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      await Promise.all(
        bdSpec.patches.map(async (patch) => {
          const url = buildBaiduDirectTileUrl(provider, bdSpec.bz, patch.bx, patch.by);
          const bmp = await fetchSourceBitmap(url, abortController.signal, true);
          if (bmp) {
            ctx.drawImage(
              bmp,
              patch.drawX * ratio,
              patch.drawY * ratio,
              patch.drawW * ratio + 0.5,
              patch.drawH * ratio + 0.5,
            );
            bmp.close();
          }
        }),
      );

      const buf = await encodeCanvasFast(canvas);
      putCachedAligned(cacheKey, buf);
      return { data: buf };
    }

    const spec = computeAlignedTileSpec(z, x, y, targetCrs, 'gcj02');

    // 无偏移（如海外区域）直接返回单张瓦片，跳过 Canvas 合成
    if (spec.isIdentity) {
      const url = buildOverlayTileUrl(provider, z, x, y);
      const resp = await fetch(url, {
        signal: abortController.signal,
        mode: url.startsWith('http') ? 'cors' : 'same-origin',
        cache: cacheMode,
      });
      if (!resp.ok) throw new Error(`Tile fetch failed: ${resp.status}`);
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
        const url = buildOverlayTileUrl(provider, z, tile.x, tile.y);
        const bmp = await fetchSourceBitmap(url, abortController.signal, !isTraffic);
        if (bmp) {
          ctx.drawImage(bmp, tile.drawX * ratio, tile.drawY * ratio, tilePx, tilePx);
          bmp.close();
        }
      }),
    );

    const buf = await encodeCanvasFast(canvas);
    putCachedAligned(cacheKey, buf);
    return { data: buf };
  });
}
