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
}

export type BasemapId = 'amap-vec' | 'amap-sat' | 'google-vec' | 'google-sat' | 'osm';

export type OverlayId = 'none' | 'amap-label' | 'amap-road' | 'google-road';

export type DrawTool = 'select' | 'point' | 'line' | 'polygon' | 'measure-distance' | 'measure-area';
