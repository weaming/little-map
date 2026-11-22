import axios from 'axios';
import type {
  AdminMapSummary,
  BasemapId,
  GeoGeometry,
  MapFeature,
  MapMeta,
  MapSnapshot,
  PlaceResult,
  RouteMode,
  RouteProvider,
  RouteResult,
  RouteSegmentMode,
  ServerCapabilities,
  TrafficSegment,
} from '../types/map';

const http = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

export interface CreateMapResponse {
  map: MapMeta;
  edit_token: string;
}

export interface FeaturePayload {
  id?: string;
  title: string;
  description?: string;
  category?: string;
  color?: string;
  icon?: string;
  geometry: GeoGeometry;
  visible?: boolean;
  sort_order?: number;
}

export async function fetchCapabilities(): Promise<ServerCapabilities> {
  const { data } = await http.get<ServerCapabilities>('/config');
  return data;
}

export async function createMap(params?: {
  title?: string;
  description?: string;
  center_lng?: number;
  center_lat?: number;
  zoom?: number;
  basemap?: BasemapId;
}): Promise<CreateMapResponse> {
  const { data } = await http.post<CreateMapResponse>('/maps', params ?? {});
  return data;
}

export async function cloneMap(mapId: string, title?: string): Promise<CreateMapResponse> {
  const { data } = await http.post<CreateMapResponse>(
    `/maps/${encodeURIComponent(mapId)}/clone`,
    title ? { title } : {},
  );
  return data;
}

export async function fetchMap(
  mapId: string,
  editToken: string,
  etag?: string,
): Promise<{ snapshot: MapSnapshot | null; etag?: string; notModified: boolean }> {
  const headers: Record<string, string> = {};
  if (editToken) headers['X-Edit-Token'] = editToken;
  if (etag) headers['If-None-Match'] = etag;

  const resp = await http.get<MapSnapshot>(`/maps/${encodeURIComponent(mapId)}`, {
    headers,
    validateStatus: (status) => status === 200 || status === 304,
  });

  if (resp.status === 304) {
    return { snapshot: null, etag, notModified: true };
  }
  return {
    snapshot: resp.data,
    etag: resp.headers['etag'],
    notModified: false,
  };
}

export async function updateMapMeta(
  mapId: string,
  editToken: string,
  baseRevision: number,
  patch: Partial<Pick<MapMeta, 'title' | 'description' | 'center_lng' | 'center_lat' | 'zoom' | 'basemap'>>,
): Promise<MapMeta> {
  const { data } = await http.patch<{ map: MapMeta }>(
    `/maps/${encodeURIComponent(mapId)}`,
    { base_revision: baseRevision, ...patch },
    { headers: { 'X-Edit-Token': editToken } },
  );
  return data.map;
}

export async function upsertFeatures(
  mapId: string,
  editToken: string,
  baseRevision: number,
  features: FeaturePayload[],
): Promise<{ revision: number; features: MapFeature[] }> {
  const { data } = await http.post<{ revision: number; features: MapFeature[] }>(
    `/maps/${encodeURIComponent(mapId)}/features/batch`,
    { base_revision: baseRevision, features },
    { headers: { 'X-Edit-Token': editToken } },
  );
  return data;
}

export async function deleteFeatures(
  mapId: string,
  editToken: string,
  baseRevision: number,
  featureIds: string[],
): Promise<{ revision: number; deleted: number }> {
  const { data } = await http.delete<{ revision: number; deleted: number }>(
    `/maps/${encodeURIComponent(mapId)}/features`,
    {
      headers: { 'X-Edit-Token': editToken },
      data: { base_revision: baseRevision, feature_ids: featureIds },
    },
  );
  return data;
}

export async function searchPlaces(
  query: string,
  provider = 'auto',
  limit = 8,
): Promise<{ provider: string; results: PlaceResult[] }> {
  const { data } = await http.get<{ provider: string; results: PlaceResult[] }>('/search', {
    params: { q: query, provider, limit },
  });
  return data;
}

export async function reverseGeocode(lng: number, lat: number): Promise<PlaceResult | null> {
  const { data } = await http.get<{ result: PlaceResult | null }>('/regeo', {
    params: { lng, lat },
    timeout: 3000,
  });
  return data.result ?? null;
}

export async function planRoute(
  mode: RouteMode,
  waypoints: [number, number][],
  provider: RouteProvider = 'auto',
  segmentModes?: RouteSegmentMode[],
  avoidPoints?: [number, number][],
  avoidSegments?: [number, number][][],
): Promise<RouteResult> {
  const { data } = await http.post<RouteResult>('/route', {
    mode,
    waypoints,
    provider,
    ...(segmentModes && segmentModes.length > 0 ? { segment_modes: segmentModes } : {}),
    ...(avoidPoints && avoidPoints.length > 0 ? { avoid_points: avoidPoints } : {}),
    ...(avoidSegments && avoidSegments.length > 0 ? { avoid_segments: avoidSegments } : {}),
  });
  return data;
}

export interface BypassAnchor {
  name: string;
  lng: number;
  lat: number;
}

export interface BypassOption {
  id: string;
  label: string;
  summary: string;
  kind: 'official' | 'both' | 'delay_entry' | 'early_exit';
  before?: BypassAnchor;
  after?: BypassAnchor;
  segment_modes: RouteSegmentMode[];
  distance_meters: number;
  duration_seconds: number;
  delta_seconds: number;
  delta_meters: number;
}

export interface BypassResult {
  recommended_id: string;
  summary: string;
  merged_jam_pts: number;
  options: BypassOption[];
}

export interface BypassRequest {
  route_coords: [number, number][];
  traffic_segments?: TrafficSegment[];
  clicked_segment_idx?: number;
  avoid_segment: [number, number][];
  start_point?: [number, number];
  end_point?: [number, number];
  orig_mode?: RouteSegmentMode;
  orig_duration_seconds?: number;
  orig_distance_meters?: number;
  provider?: RouteProvider;
}

export async function findHighwayBypassAnchors(req: BypassRequest): Promise<BypassResult> {
  const { data } = await http.post<BypassResult>('/route/bypass', req, { timeout: 25000 });
  return data;
}

export async function fetchAdminMaps(adminKey: string): Promise<AdminMapSummary[]> {
  const { data } = await http.get<{ maps: AdminMapSummary[] }>('/admin/maps', {
    headers: { 'X-Admin-Key': adminKey },
  });
  return data.maps;
}

export async function deleteAdminMap(adminKey: string, mapId: string): Promise<void> {
  await http.delete(`/admin/maps/${encodeURIComponent(mapId)}`, {
    headers: { 'X-Admin-Key': adminKey },
  });
}

export function getExportUrl(mapId: string): string {
  return `/api/maps/${encodeURIComponent(mapId)}/export.geojson`;
}

export function extractErrorMessage(err: unknown): { message: string; isConflict: boolean } {
  if (axios.isAxiosError(err)) {
    const isConflict = err.response?.status === 409;
    const serverMsg = (err.response?.data as { error?: string } | undefined)?.error;
    return {
      message: serverMsg || err.message || '请求失败',
      isConflict,
    };
  }
  return {
    message: err instanceof Error ? err.message : '未知错误',
    isConflict: false,
  };
}
