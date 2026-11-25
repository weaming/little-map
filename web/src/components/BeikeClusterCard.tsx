import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Home, Plus, Train, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { BeikeCluster, BeikeHouse } from '../types/map';

interface BeikeClusterCardProps {
  cluster: BeikeCluster;
  canEdit: boolean;
  copyWithPhotos: boolean;
  onCopyWithPhotosChange: (next: boolean) => void;
  onCopyCSV: (houses: BeikeHouse[]) => void;
  onSaveHouse: (house: BeikeHouse) => void;
  onClose: () => void;
}

export function BeikeClusterCard({
  cluster,
  canEdit,
  copyWithPhotos,
  onCopyWithPhotosChange,
  onCopyCSV,
  onSaveHouse,
  onClose,
}: BeikeClusterCardProps) {
  const photos = cluster.houses
    .filter((h) => Boolean(h.pic_url || h.pic_thumb_url))
    .map((h) => ({
      url: h.pic_url || h.pic_thumb_url!,
      caption: `${h.title} · ¥${h.price_text}${h.price_unit || '/月'}`,
      houseCode: h.house_code,
    }));

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    setLightboxIdx(null);
  }, [cluster.key]);

  useEffect(() => {
    if (lightboxIdx === null || photos.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setLightboxIdx(null);
      } else if (e.key === 'ArrowLeft' && photos.length > 1) {
        e.preventDefault();
        setLightboxIdx((cur) => (cur === null ? null : (cur - 1 + photos.length) % photos.length));
      } else if (e.key === 'ArrowRight' && photos.length > 1) {
        e.preventDefault();
        setLightboxIdx((cur) => (cur === null ? null : (cur + 1) % photos.length));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [lightboxIdx, photos.length]);

  const priceRange =
    cluster.minPrice > 0
      ? cluster.maxPrice > cluster.minPrice
        ? `¥${Math.round(cluster.minPrice)} - ¥${Math.round(cluster.maxPrice)}`
        : `¥${Math.round(cluster.minPrice)}`
      : '';

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="inspector-header-title" style={{ minWidth: 0 }}>
          <Home size={15} style={{ color: '#059669', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cluster.resblock}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {[cluster.district, cluster.bizcircle].filter(Boolean).join(' · ')}
              {priceRange ? ` · ${priceRange}` : ''} · {cluster.houses.length} 套
              {cluster.medianListedDays !== null ? ` · 中位挂牌 ${cluster.medianListedDays} 天` : ''}
            </div>
          </div>
        </div>
        <button className="btn icon-btn" onClick={onClose} title="关闭">
          <X size={16} />
        </button>
      </div>

      <div className="beike-summary-bar" style={{ background: 'var(--bg-subtle)' }}>
        <label className="beike-viewport-toggle" title="复制 CSV 时在最后一列附带图片 URL">
          <input
            type="checkbox"
            checked={copyWithPhotos}
            onChange={(e) => onCopyWithPhotosChange(e.target.checked)}
          />
          复制含图片URL
        </label>
        <button
          type="button"
          className="btn outline compact-btn"
          onClick={() => onCopyCSV(cluster.houses)}
          title="复制本小区全部房源 CSV"
        >
          <Copy size={12} />
          复制全部 CSV ({cluster.houses.length})
        </button>
      </div>

      <div className="inspector-body" style={{ gap: 10 }}>
        {cluster.houses.map((h) => {
          const thumb = h.pic_thumb_url || h.pic_url;
          const photoIdx = photos.findIndex((p) => p.houseCode === h.house_code);
          const rentLabel = h.rent_type === 'whole' ? '整租' : h.rent_type === 'shared' ? '合租' : '';
          const floorText =
            h.floor_level && h.floor_total > 0
              ? `${h.floor_level}/${h.floor_total}层`
              : h.floor_level || (h.floor_total > 0 ? `共${h.floor_total}层` : '');
          const metaParts = [
            rentLabel,
            h.layout,
            h.area > 0 ? `${h.area}㎡` : '',
            h.orientation,
            floorText,
          ].filter(Boolean);

          return (
            <div key={h.house_code} className="beike-house-card">
              <div style={{ display: 'flex', gap: 10 }}>
                {thumb && (
                  <button
                    type="button"
                    className="beike-house-thumb"
                    onClick={() => {
                      if (photoIdx >= 0) setLightboxIdx(photoIdx);
                    }}
                    title="点击查看大图"
                  >
                    <img src={thumb} alt={h.title} referrerPolicy="no-referrer" loading="lazy" />
                  </button>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="beike-house-title">{h.title}</div>
                  <div className="beike-house-price">
                    ¥{h.price_text}
                    <span>{h.price_unit || '元/月'}</span>
                  </div>
                  {metaParts.length > 0 && <div className="beike-house-meta">{metaParts.join(' · ')}</div>}
                </div>
              </div>

              {h.price_note && (
                <div style={{ fontSize: 11.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 7px' }}>
                  {h.price_note}
                </div>
              )}

              {h.highlights && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {h.highlights.replace(/;/g, ' · ')}
                </div>
              )}

              {(h.listed_at || h.available_at) && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {[h.listed_at ? `上架 ${h.listed_at}` : '', h.available_at ? `可入住 ${h.available_at}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}

              {(h.subway_desc || h.subway_name) && (
                <div className="beike-house-sub">
                  <Train size={12} style={{ flexShrink: 0 }} />
                  <span>{h.subway_desc || h.subway_name}</span>
                </div>
              )}

              {h.tags.length > 0 && (
                <div className="place-badges">
                  {h.tags.slice(0, 6).map((t) => (
                    <span key={t} className="badge" style={{ fontSize: 10.5 }}>
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="beike-house-actions">
                <button
                  type="button"
                  className="btn outline compact-btn"
                  onClick={() => onCopyCSV([h])}
                  title="复制该房源 CSV"
                >
                  <Copy size={12} />
                  复制 CSV
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className="btn outline compact-btn"
                    onClick={() => onSaveHouse(h)}
                    title="将此房源保存为当前地图标注"
                  >
                    <Plus size={12} />
                    收藏到地图
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {lightboxIdx !== null &&
        photos[lightboxIdx] &&
        createPortal(
          <div
            className="photo-lightbox-backdrop"
            onClick={() => setLightboxIdx(null)}
            role="dialog"
            aria-modal="true"
            aria-label={`${cluster.resblock} 房源图片预览`}
          >
            <button
              type="button"
              className="photo-lightbox-close"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIdx(null);
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
                  setLightboxIdx((lightboxIdx - 1 + photos.length) % photos.length);
                }}
                title="上一张 (←)"
              >
                <ChevronLeft size={26} />
              </button>
            )}

            <div className="photo-lightbox-stage" onClick={(e) => e.stopPropagation()}>
              <img
                src={photos[lightboxIdx].url}
                alt={photos[lightboxIdx].caption}
                referrerPolicy="no-referrer"
              />
              <div className="photo-lightbox-caption">
                <span>{photos[lightboxIdx].caption}</span>
                <span>
                  {lightboxIdx + 1} / {photos.length}
                </span>
              </div>
            </div>

            {photos.length > 1 && (
              <button
                type="button"
                className="photo-lightbox-nav next"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIdx((lightboxIdx + 1) % photos.length);
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
