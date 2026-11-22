import maplibregl from 'maplibre-gl';
import {
  bd09ToGcj02,
  bd09ToMercator,
  gcj02ToBd09,
  gcj02ToWgs84,
  lngLatToWorldPx,
  mercatorToBd09,
  wgs84ToGcj02,
  worldPxToLngLat,
} from './geo';

export type WebGLTileProvider =
  | 'baidu-vec'
  | 'baidu-sat'
  | 'baidu-road'
  | 'amap-label'
  | 'amap-road'
  | 'amap-traffic'
  | 'google-road';

interface TileEntry {
  texture: WebGLTexture | null;
  loading: boolean;
  failed: boolean;
  lastUsed: number;
}

interface VisibleTileQuad {
  key: string;
  url: string;
  z: number;
  x: number;
  y: number;
  // 4 个顶点在 MapLibre 归一化 MercatorCoordinate 下的位置 [tlX, tlY, blX, blY, trX, trY, brX, brY]
  verts: Float32Array;
}

const MAX_GPU_TEXTURES = 160;
const MAX_TILES_PER_FRAME = 64;

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL createShader failed');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'unknown';
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function formatBaiduCoord(v: number): string {
  return v < 0 ? `M${-v}` : `${v}`;
}

function buildDirectTileUrl(provider: WebGLTileProvider, z: number, x: number, y: number): string {
  switch (provider) {
    case 'baidu-vec': {
      const sub = (((x + y) % 4) + 4) % 4;
      return `https://maponline${sub}.bdimg.com/tile/?qt=vtile&x=${formatBaiduCoord(x)}&y=${formatBaiduCoord(y)}&z=${z}&styles=pl&scaler=2&udt=20250101`;
    }
    case 'baidu-road': {
      const sub = (((x + y) % 4) + 4) % 4;
      return `https://maponline${sub}.bdimg.com/tile/?qt=vtile&x=${formatBaiduCoord(x)}&y=${formatBaiduCoord(y)}&z=${z}&styles=sl&scaler=2&udt=20250101`;
    }
    case 'baidu-sat': {
      const sub = (((x + y) % 4) + 4) % 4;
      return `https://maponline${sub}.bdimg.com/starpic/?qt=satepc&u=x=${formatBaiduCoord(x)};y=${formatBaiduCoord(y)};z=${z};v=009;type=sate&fm=46`;
    }
    case 'amap-label': {
      const sub = (((x + y) % 4) + 4) % 4 + 1;
      return `https://webst0${sub}.is.autonavi.com/appmaptile?style=8&ltype=4&x=${x}&y=${y}&z=${z}`;
    }
    case 'amap-road': {
      const sub = (((x + y) % 4) + 4) % 4 + 1;
      return `https://webst0${sub}.is.autonavi.com/appmaptile?style=8&x=${x}&y=${y}&z=${z}`;
    }
    case 'google-road': {
      const sub = (((x + y) % 4) + 4) % 4;
      return `https://mt${sub}.google.com/vt/lyrs=h&hl=zh-CN&scale=2&x=${x}&y=${y}&z=${z}`;
    }
    case 'amap-traffic':
      return `/api/tile-proxy?provider=amap-traffic&z=${z}&x=${x}&y=${y}`;
  }
}

function makeQuadVerts(
  tl: [number, number],
  bl: [number, number],
  tr: [number, number],
  br: [number, number],
): Float32Array {
  const mTL = maplibregl.MercatorCoordinate.fromLngLat(tl);
  const mBL = maplibregl.MercatorCoordinate.fromLngLat(bl);
  const mTR = maplibregl.MercatorCoordinate.fromLngLat(tr);
  const mBR = maplibregl.MercatorCoordinate.fromLngLat(br);
  // TRIANGLE_STRIP 顺序: TL(0,0), BL(0,1), TR(1,0), BR(1,1)
  return new Float32Array([
    mTL.x, mTL.y, 0, 0,
    mBL.x, mBL.y, 0, 1,
    mTR.x, mTR.y, 1, 0,
    mBR.x, mBR.y, 1, 1,
  ]);
}

function computeVisibleBaiduQuads(
  map: maplibregl.Map,
  provider: WebGLTileProvider,
  targetCrs: 'wgs84' | 'gcj02',
): VisibleTileQuad[] {
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const bz = Math.max(3, Math.min(19, Math.round(zoom + 1)));
  const tileSpan = 256 * Math.pow(2, 18 - bz);

  const west = Math.max(-179.9, bounds.getWest());
  const east = Math.min(179.9, bounds.getEast());
  const south = Math.max(-74, bounds.getSouth());
  const north = Math.min(74, bounds.getNorth());
  if (west >= east || south >= north) return [];

  const toBdMc = (lng: number, lat: number): [number, number] => {
    const [gLng, gLat] = targetCrs === 'wgs84' ? wgs84ToGcj02(lng, lat) : [lng, lat];
    const [bLng, bLat] = gcj02ToBd09(gLng, gLat);
    return bd09ToMercator(bLng, bLat);
  };

  const corners = [
    toBdMc(west, south),
    toBdMc(east, south),
    toBdMc(west, north),
    toBdMc(east, north),
  ];
  let mcMinX = Infinity;
  let mcMaxX = -Infinity;
  let mcMinY = Infinity;
  let mcMaxY = -Infinity;
  for (const [mx, my] of corners) {
    if (mx < mcMinX) mcMinX = mx;
    if (mx > mcMaxX) mcMaxX = mx;
    if (my < mcMinY) mcMinY = my;
    if (my > mcMaxY) mcMaxY = my;
  }

  const bxMin = Math.floor(mcMinX / tileSpan);
  const bxMax = Math.floor(mcMaxX / tileSpan);
  const byMin = Math.floor(mcMinY / tileSpan);
  const byMax = Math.floor(mcMaxY / tileSpan);

  if ((bxMax - bxMin + 1) * (byMax - byMin + 1) > MAX_TILES_PER_FRAME) {
    return [];
  }

  const bdMcToDisplay = (mx: number, my: number): [number, number] => {
    const [bLng, bLat] = mercatorToBd09(mx, my);
    const [gLng, gLat] = bd09ToGcj02(bLng, bLat);
    return targetCrs === 'wgs84' ? gcj02ToWgs84(gLng, gLat) : [gLng, gLat];
  };

  const quads: VisibleTileQuad[] = [];
  for (let by = byMin; by <= byMax; by++) {
    for (let bx = bxMin; bx <= bxMax; bx++) {
      const left = bx * tileSpan;
      const right = (bx + 1) * tileSpan;
      const bottom = by * tileSpan;
      const top = (by + 1) * tileSpan;

      const tl = bdMcToDisplay(left, top);
      const bl = bdMcToDisplay(left, bottom);
      const tr = bdMcToDisplay(right, top);
      const br = bdMcToDisplay(right, bottom);

      quads.push({
        key: `${bz}/${bx}/${by}`,
        url: buildDirectTileUrl(provider, bz, bx, by),
        z: bz,
        x: bx,
        y: by,
        verts: makeQuadVerts(tl, bl, tr, br),
      });
    }
  }
  return quads;
}

function computeVisibleGcjQuads(
  map: maplibregl.Map,
  provider: WebGLTileProvider,
  maxzoom: number,
  targetCrs: 'wgs84' | 'gcj02',
): VisibleTileQuad[] {
  const bounds = map.getBounds();
  const z = Math.max(1, Math.min(maxzoom, Math.round(map.getZoom())));
  const maxTile = Math.pow(2, z);

  const west = Math.max(-179.9, bounds.getWest());
  const east = Math.min(179.9, bounds.getEast());
  const south = Math.max(-85, bounds.getSouth());
  const north = Math.min(85, bounds.getNorth());
  if (west >= east || south >= north) return [];

  const toGcj = (lng: number, lat: number): [number, number] =>
    targetCrs === 'wgs84' ? wgs84ToGcj02(lng, lat) : [lng, lat];

  const [gWest, gNorth] = toGcj(west, north);
  const [gEast, gSouth] = toGcj(east, south);
  const [pxMin, pyMin] = lngLatToWorldPx(gWest, gNorth, z);
  const [pxMax, pyMax] = lngLatToWorldPx(gEast, gSouth, z);

  const txMin = Math.max(0, Math.floor(pxMin / 256));
  const txMax = Math.min(maxTile - 1, Math.floor(pxMax / 256));
  const tyMin = Math.max(0, Math.floor(pyMin / 256));
  const tyMax = Math.min(maxTile - 1, Math.floor(pyMax / 256));

  if ((txMax - txMin + 1) * (tyMax - tyMin + 1) > MAX_TILES_PER_FRAME) {
    return [];
  }

  const gcjToDisplay = (lng: number, lat: number): [number, number] =>
    targetCrs === 'wgs84' ? gcj02ToWgs84(lng, lat) : [lng, lat];

  const timeBucket = provider === 'amap-traffic' ? `@${Math.floor(Date.now() / 120000)}` : '';
  const quads: VisibleTileQuad[] = [];

  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const [gL, gT] = worldPxToLngLat(tx * 256, ty * 256, z);
      const [gR, gB] = worldPxToLngLat((tx + 1) * 256, (ty + 1) * 256, z);

      const tl = gcjToDisplay(gL, gT);
      const bl = gcjToDisplay(gL, gB);
      const tr = gcjToDisplay(gR, gT);
      const br = gcjToDisplay(gR, gB);

      quads.push({
        key: `${z}/${tx}/${ty}${timeBucket}`,
        url: buildDirectTileUrl(provider, z, tx, ty),
        z,
        x: tx,
        y: ty,
        verts: makeQuadVerts(tl, bl, tr, br),
      });
    }
  }
  return quads;
}

// 创建零裁剪、零拼接、零 Canvas 重编码的 WebGL 原图纹理贴图 Custom Layer。
export function createAlignedWebGLLayer(
  id: string,
  provider: WebGLTileProvider,
  targetCrs: 'wgs84' | 'gcj02',
  maxzoom = 18,
): maplibregl.CustomLayerInterface {
  const isBaidu = provider.startsWith('baidu-');
  const isTraffic = provider === 'amap-traffic';
  const tiles = new Map<string, TileEntry>();
  const controllers = new Set<AbortController>();

  let mapRef: maplibregl.Map | null = null;
  let glRef: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let quadBuffer: WebGLBuffer | null = null;
  let aPosLoc = -1;
  let aUvLoc = -1;
  let uMatrixLoc: WebGLUniformLocation | null = null;
  let uTexLoc: WebGLUniformLocation | null = null;
  let frameTick = 0;
  let removed = false;

  function evictOldTextures(gl: WebGLRenderingContext) {
    if (tiles.size <= MAX_GPU_TEXTURES) return;
    const entries = [...tiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = tiles.size - MAX_GPU_TEXTURES;
    for (let i = 0; i < removeCount; i++) {
      const [key, entry] = entries[i];
      if (entry.texture) {
        gl.deleteTexture(entry.texture);
      }
      tiles.delete(key);
    }
  }

  function requestTile(quad: VisibleTileQuad) {
    const entry: TileEntry = { texture: null, loading: true, failed: false, lastUsed: frameTick };
    tiles.set(quad.key, entry);

    const ctrl = new AbortController();
    controllers.add(ctrl);

    fetch(quad.url, {
      signal: ctrl.signal,
      mode: quad.url.startsWith('http') ? 'cors' : 'same-origin',
      cache: isTraffic ? 'default' : 'force-cache',
    })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .then((bmp) => {
        if (removed || !glRef || !mapRef) {
          bmp.close();
          return;
        }
        const gl = glRef;
        const tex = gl.createTexture();
        if (!tex) {
          bmp.close();
          entry.loading = false;
          entry.failed = true;
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        bmp.close();

        entry.texture = tex;
        entry.loading = false;
        entry.lastUsed = frameTick;
        evictOldTextures(gl);
        mapRef.triggerRepaint();
      })
      .catch(() => {
        entry.loading = false;
        entry.failed = true;
      })
      .finally(() => {
        controllers.delete(ctrl);
      });
  }

  return {
    id,
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, gl) {
      removed = false;
      mapRef = map;
      glRef = gl;

      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error('WebGL createProgram failed');
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program link error: ${gl.getProgramInfoLog(program) || 'unknown'}`);
      }

      aPosLoc = gl.getAttribLocation(program, 'a_pos');
      aUvLoc = gl.getAttribLocation(program, 'a_uv');
      uMatrixLoc = gl.getUniformLocation(program, 'u_matrix');
      uTexLoc = gl.getUniformLocation(program, 'u_tex');
      quadBuffer = gl.createBuffer();
    },

    render(gl, options) {
      if (!mapRef || !program || !quadBuffer) return;
      frameTick++;

      const matrix = options.defaultProjectionData?.mainMatrix;
      if (!matrix) return;

      const quads = isBaidu
        ? computeVisibleBaiduQuads(mapRef, provider, targetCrs)
        : computeVisibleGcjQuads(mapRef, provider, maxzoom, targetCrs);
      if (quads.length === 0) return;

      gl.useProgram(program);
      gl.uniformMatrix4fv(uMatrixLoc, false, matrix);
      gl.uniform1i(uTexLoc, 0);

      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(aPosLoc);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aUvLoc);
      gl.vertexAttribPointer(aUvLoc, 2, gl.FLOAT, false, 16, 8);
      gl.activeTexture(gl.TEXTURE0);

      for (const quad of quads) {
        const entry = tiles.get(quad.key);
        if (!entry) {
          requestTile(quad);
          continue;
        }
        entry.lastUsed = frameTick;
        if (!entry.texture) continue;

        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.bufferData(gl.ARRAY_BUFFER, quad.verts, gl.STREAM_DRAW);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },

    onRemove(_map, gl) {
      removed = true;
      for (const ctrl of controllers) {
        ctrl.abort();
      }
      controllers.clear();
      for (const entry of tiles.values()) {
        if (entry.texture) {
          gl.deleteTexture(entry.texture);
        }
      }
      tiles.clear();
      if (quadBuffer) {
        gl.deleteBuffer(quadBuffer);
        quadBuffer = null;
      }
      if (program) {
        gl.deleteProgram(program);
        program = null;
      }
      mapRef = null;
      glRef = null;
    },
  };
}
