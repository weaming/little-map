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
  id?: string;
  name: string;
  address: string;
  lng: number;
  lat: number;
  provider: string;
  category?: string;
  boundary?: GeoGeometry;
  tel?: string;
  open_time?: string;
  rating?: string;
  cost?: string;
  business_area?: string;
  tags?: string[];
  photos?: string[];
  alias?: string;
}

export interface ServerCapabilities {
  default_basemap: BasemapId;
  search_providers: string[];
  has_amap_key: boolean;
  has_google_key: boolean;
  has_admin_key: boolean;
  has_beike?: boolean;
}

export interface BeikeCity {
  id: string;
  name: string;
  abbr: string;
}

export interface BeikeRegion {
  token: string;
  name: string;
}

export interface BeikeHouse {
  house_code: string;
  title: string;
  price: number;
  price_text: string;
  price_unit: string;
  lng: number;
  lat: number;
  layout: string;
  area: number;
  bedrooms: number;
  bathrooms: number;
  orientation: string;
  floor_level?: string;
  floor_total: number;
  district: string;
  bizcircle: string;
  resblock: string;
  subway_desc: string;
  subway_name: string;
  rent_type: 'whole' | 'shared' | 'other';
  tags: string[];
  highlights?: string;
  price_note?: string;
  listed_at?: string;
  available_at?: string;
  pic_url?: string;
  pic_thumb_url?: string;
}

export interface BeikeSearchParams {
  city: string;
  price_min?: number;
  price_max?: number;
  rooms?: number;
  rent_type?: 'any' | 'whole' | 'shared';
  district?: string;
  region?: string;
  metro_line?: string;
  area?: string;
  move_in?: string;
  floor?: string;
  brand?: string;
  features?: string[];
  sort?: string;
  pages?: number;
  start_page?: number;
  no_cache?: boolean;
}

export interface BeikeSearchResult {
  city_id: string;
  total: number;
  count: number;
  scanned: number;
  unique: number;
  requests: number;
  partial: boolean;
  next_page?: number;
  remaining_pages?: number;
  notes?: string[];
  houses: BeikeHouse[];
}

export type BeikeLiquidity = 'hot' | 'normal' | 'slow' | 'unknown';

export interface BeikeCluster {
  key: string;
  resblock: string;
  district: string;
  bizcircle: string;
  lng: number;
  lat: number;
  minPrice: number;
  maxPrice: number;
  medianListedDays: number | null;
  liquidity: BeikeLiquidity;
  houses: BeikeHouse[];
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

export type BasemapId = 'amap-vec' | 'amap-sat' | 'baidu-vec' | 'baidu-sat' | 'google-vec' | 'google-sat' | 'osm';

export type OverlayId = 'none' | 'amap-label' | 'amap-road' | 'baidu-road' | 'google-road';

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
