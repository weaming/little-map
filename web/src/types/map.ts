export type GeometryType = 'Point' | 'LineString' | 'Polygon';

export interface GeoGeometry {
  type: GeometryType;
  coordinates: number[] | number[][] | number[][][];
}

export interface MapMeta {
  id: string;
  title: string;
  description: string;
  center_lng: number;
  center_lat: number;
  zoom: number;
  basemap: BasemapId;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface MapFeature {
  id: string;
  map_id: string;
  title: string;
  description: string;
  category: string;
  color: string;
  icon: string;
  geometry: GeoGeometry;
  visible: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export interface MapSnapshot {
  map: MapMeta;
  features: MapFeature[];
  can_edit: boolean;
}

export interface PlaceResult {
  name: string;
  address: string;
  lng: number;
  lat: number;
  provider: string;
  category?: string;
  boundary?: GeoGeometry;
}

export interface ServerCapabilities {
  default_basemap: BasemapId;
  search_providers: string[];
  has_amap_key: boolean;
  has_google_key: boolean;
  has_admin_key: boolean;
}

export interface AdminMapSummary {
  id: string;
  edit_token: string;
  title: string;
  description: string;
  feature_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type BasemapId = 'amap-vec' | 'amap-sat' | 'google-vec' | 'google-sat' | 'osm';

export type OverlayId = 'none' | 'amap-label' | 'amap-road' | 'google-road';

export type RouteMode = 'driving' | 'bicycling' | 'walking';
export type RouteSegmentMode = 'auto' | 'highway' | 'national' | 'avoid-jam' | 'direct';
export type RouteProvider = 'auto' | 'amap' | 'osrm';

export interface RouteLeg {
  index: number;
  strategy: RouteSegmentMode;
  from: number[];
  to: number[];
  via?: number[][];
  distance_meters: number;
  duration_seconds: number;
  amap_nav_url: string;
}

export interface TrafficSegment {
  status: string;
  color: string;
  coordinates: number[][];
}

export interface RouteResult {
  mode: RouteMode;
  provider: string;
  distance_meters: number;
  duration_seconds: number;
  geometry: GeoGeometry;
  legs?: RouteLeg[];
  traffic_segments?: TrafficSegment[];
}

export type DrawTool = 'select' | 'point' | 'line' | 'polygon' | 'measure-distance' | 'measure-area' | 'route';
