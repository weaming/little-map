import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  MapPin,
  Pentagon,
  Phone,
  Plus,
  Star,
  Tag,
  X,
} from 'lucide-react';
import { formatDistance, haversineMeters, wgs84ToGcj02 } from '../map/geo';
import type { PlaceResult } from '../types/map';

interface PlaceDetailCardProps {
  place: PlaceResult;
  index: number;
  canEdit: boolean;
  userLocation: [number, number] | null;
  onAddMarker: (place: PlaceResult, asPolygon?: boolean) => void;
  onClose: () => void;
}

export function PlaceDetailCard({
  place,
  index,
  canEdit,
  userLocation,
  onAddMarker,
  onClose,
}: PlaceDetailCardProps) {
  const [copiedField, setCopiedField] = useState<'addr' | 'coord' | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const photos = place.photos ?? [];

  // 切换不同 POI 时关闭图片预览灯箱
  useEffect(() => {
    setLightboxIndex(null);
  }, [place]);

  // 灯箱打开时支持键盘左右键切换与 ESC 关闭
  useEffect(() => {
    if (lightboxIndex === null || photos.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setLightboxIndex(null);
      } else if (e.key === 'ArrowLeft' && photos.length > 1) {
        e.preventDefault();
        setLightboxIndex((cur) => (cur === null ? null : (cur - 1 + photos.length) % photos.length));
      } else if (e.key === 'ArrowRight' && photos.length > 1) {
        e.preventDefault();
        setLightboxIndex((cur) => (cur === null ? null : (cur + 1) % photos.length));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [lightboxIndex, photos.length]);

  const [gLng, gLat] = wgs84ToGcj02(place.lng, place.lat);
  const amapUrl =
    place.provider === 'amap' && place.id
      ? `https://ditu.amap.com/place/${encodeURIComponent(place.id)}`
      : `https://uri.amap.com/marker?position=${gLng.toFixed(6)},${gLat.toFixed(6)}&name=${encodeURIComponent(place.name)}`;
  const coordText = `${place.lng.toFixed(6)}, ${place.lat.toFixed(6)}`;
  const distanceText = userLocation
    ? formatDistance(haversineMeters(userLocation[0], userLocation[1], place.lng, place.lat))
    : null;
  const categoryText = place.category
    ? place.category
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' · ')
    : '';

  async function copyText(text: string, field: 'addr' | 'coord') {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1500);
    } catch {
      // 忽略剪贴板权限异常
    }
  }

  return (
    <aside className="inspector compact">
      <div className="inspector-header">
        <div className="inspector-header-title" style={{ minWidth: 0 }}>
          <span className="search-item-index active">{index + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {place.name}
            </div>
            {place.alias && place.alias !== place.name && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>别名：{place.alias}</div>
            )}
          </div>
        </div>
        <button className="btn icon-btn" onClick={onClose} title="关闭详情">
          <X size={16} />
        </button>
      </div>

      <div className="inspector-body" style={{ gap: 11 }}>
        {photos.length > 0 && (
          <div className="place-photos">
            {photos.map((url, i) => (
              <button
                key={`${url}-${i}`}
                type="button"
                className="place-photo-link"
                onClick={() => setLightboxIndex(i)}
                title="点击放大查看"
              >
                <img src={url} alt={`${place.name} ${i + 1}`} loading="lazy" />
              </button>
            ))}
          </div>
        )}

        {(place.rating || place.cost || place.business_area || distanceText) && (
          <div className="place-badges">
            {place.rating && (
              <span className="badge place-badge-rating">
                <Star size={11} />
                {place.rating}
              </span>
            )}
            {place.cost && <span className="badge">人均 ¥{place.cost}</span>}
            {place.business_area && <span className="badge">{place.business_area}</span>}
            {distanceText && <span className="badge">距你 {distanceText}</span>}
          </div>
        )}

        <div className="inspector-meta-card" style={{ gap: 7 }}>
          {categoryText && (
            <div className="place-detail-row">
              <Tag size={13} className="place-detail-icon" />
              <span>{categoryText}</span>
            </div>
          )}

          {place.address && (
            <div className="place-detail-row">
              <MapPin size={13} className="place-detail-icon" />
              <span style={{ flex: 1 }}>{place.address}</span>
              <button
                type="button"
                className="btn icon-btn"
                style={{ padding: 2 }}
                onClick={() => void copyText(place.address, 'addr')}
                title="复制地址"
              >
                {copiedField === 'addr' ? <span style={{ fontSize: 11 }}>已复制</span> : <Copy size={12} />}
              </button>
            </div>
          )}

          {place.open_time && (
            <div className="place-detail-row">
              <Clock size={13} className="place-detail-icon" />
              <span>{place.open_time}</span>
            </div>
          )}

          {place.tel && (
            <div className="place-detail-row">
              <Phone size={13} className="place-detail-icon" />
              <a href={`tel:${place.tel.split(';')[0]}`} className="place-tel-link">
                {place.tel}
              </a>
            </div>
          )}

          <div className="place-detail-row">
            <span className="place-detail-coord">WGS-84: {coordText}</span>
            <span className="badge" style={{ fontSize: 10 }}>
              {place.provider.toUpperCase()}
            </span>
            <button
              type="button"
              className="btn icon-btn"
              style={{ padding: 2 }}
              onClick={() => void copyText(coordText, 'coord')}
              title="复制坐标"
            >
              {copiedField === 'coord' ? <span style={{ fontSize: 11 }}>已复制</span> : <Copy size={12} />}
            </button>
          </div>
        </div>

        {place.tags && place.tags.length > 0 && (
          <div className="place-badges">
            {place.tags.map((t) => (
              <span key={t} className="badge">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="inspector-footer">
        <a
          href={amapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn outline compact-btn"
          style={{ textDecoration: 'none' }}
        >
          <ExternalLink size={13} />
          高德查看
        </a>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6 }}>
            {place.boundary && (
              <button
                type="button"
                className="btn outline compact-btn"
                onClick={() => onAddMarker(place, true)}
              >
                <Pentagon size={13} />
                标范围
              </button>
            )}
            <button
              type="button"
              className="btn primary compact-btn"
              onClick={() => onAddMarker(place, false)}
            >
              <Plus size={13} />
              添加到地图
            </button>
          </div>
        )}
      </div>

      {lightboxIndex !== null &&
        photos[lightboxIndex] &&
        createPortal(
          <div
            className="photo-lightbox-backdrop"
            onClick={() => setLightboxIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-label={`${place.name} 照片预览`}
          >
            <button
              type="button"
              className="photo-lightbox-close"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(null);
              }}
              title="关闭 (ESC)"
            >
              <X size={20} />
            </button>

            {photos.length > 1 && (
              <button
                type="button"
                className="photo-lightbox-nav prev"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((lightboxIndex - 1 + photos.length) % photos.length);
                }}
                title="上一张 (←)"
              >
                <ChevronLeft size={26} />
              </button>
            )}

            <div className="photo-lightbox-stage" onClick={(e) => e.stopPropagation()}>
              <img src={photos[lightboxIndex]} alt={`${place.name} ${lightboxIndex + 1}`} />
              <div className="photo-lightbox-caption">
                <span>{place.name}</span>
                <span>
                  {lightboxIndex + 1} / {photos.length}
                </span>
              </div>
            </div>

            {photos.length > 1 && (
              <button
                type="button"
                className="photo-lightbox-nav next"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((lightboxIndex + 1) % photos.length);
                }}
                title="下一张 (→)"
              >
                <ChevronRight size={26} />
              </button>
            )}
          </div>,
          document.body,
        )}
    </aside>
  );
}
