import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { ArrowLeftRight, Pencil, Save, Spline, Trash2, X } from 'lucide-react';
import { formatArea, formatDistance, lineLengthMeters, polygonAreaSqMeters } from '../map/geo';
import type { MapFeature } from '../types/map';

const SWATCH_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#334155'];

interface FeatureInspectorProps {
  feature: MapFeature;
  canEdit: boolean;
  isEditingNodes: boolean;
  onSave: (updated: MapFeature) => void;
  onDelete: (featureId: string) => void;
  onToggleEditNodes: (featureId: string) => void;
  onClose: () => void;
}

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 768;
}

function renderSafeMarkdown(raw: string): string {
  if (!raw.trim()) return '';
  const html = marked.parse(raw, { async: false }) as string;
  return html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}

export function FeatureInspector({
  feature,
  canEdit,
  isEditingNodes,
  onSave,
  onDelete,
  onToggleEditNodes,
  onClose,
}: FeatureInspectorProps) {
  const [title, setTitle] = useState(feature.title);
  const [category, setCategory] = useState(feature.category);
  const [color, setColor] = useState(feature.color || '#2563eb');
  const [description, setDescription] = useState(feature.description);
  const [editing, setEditing] = useState(() => canEdit && !isMobileViewport());
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    setTitle(feature.title);
    setCategory(feature.category);
    setColor(feature.color || '#2563eb');
    setDescription(feature.description);
  }, [feature]);

  useEffect(() => {
    setEditing(canEdit && !isMobileViewport());
    setPreviewMode(false);
  }, [feature.id, canEdit]);

  const metricText = useMemo(() => {
    if (feature.geometry.type === 'Point') {
      const [lng, lat] = feature.geometry.coordinates as number[];
      return `WGS-84: ${lng.toFixed(6)}, ${lat.toFixed(6)}`;
    }
    if (feature.geometry.type === 'LineString') {
      const coords = feature.geometry.coordinates as number[][];
      return `折线（${coords.length} 点）· 总长度 ${formatDistance(lineLengthMeters(coords))}`;
    }
    const ring = (feature.geometry.coordinates as number[][][])[0] ?? [];
    return `多边形 · 面积 ${formatArea(polygonAreaSqMeters(ring))} · 周长 ${formatDistance(lineLengthMeters(ring))}`;
  }, [feature.geometry]);

  const renderedHtml = useMemo(() => renderSafeMarkdown(description), [description]);

  function handleSubmit() {
    if (!canEdit) return;
    onSave({
      ...feature,
      title: title.trim() || '未命名标注',
      category: category.trim(),
      color,
      description,
    });
    if (isMobileViewport()) {
      setEditing(false);
    }
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // 轻量预览卡（只读模式 & 移动端默认态）
  if (!editing) {
    return (
      <section className="inspector compact">
        <div className="sidebar-header" style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <span className="color-dot" style={{ background: color }} />
            <strong
              style={{
                fontSize: 15,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {feature.title || '未命名标注'}
            </strong>
            {feature.category && <span className="badge">{feature.category}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {canEdit && (
              <button className="btn outline" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setEditing(true)}>
                <Pencil size={13} />
                编辑
              </button>
            )}
            <button className="btn" style={{ padding: 4 }} onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="inspector-body" style={{ padding: '10px 14px 12px', gap: 8 }}>
          <div className="badge" style={{ width: 'fit-content' }}>
            {metricText}
          </div>
          {renderedHtml && (
            <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          )}
        </div>
      </section>
    );
  }

  // 完整编辑面板
  return (
    <section className="inspector">
      <div className="sidebar-header">
        <strong style={{ fontSize: 14 }}>编辑标注</strong>
        <button
          className="btn"
          onClick={() => (isMobileViewport() ? setEditing(false) : onClose())}
          title={isMobileViewport() ? '返回预览' : '关闭'}
        >
          <X size={16} />
        </button>
      </div>

      <div className="inspector-body">
        <div className="badge" style={{ width: 'fit-content' }}>
          {metricText}
        </div>

        {feature.geometry.type === 'LineString' && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn outline ${isEditingNodes ? 'active' : ''}`}
              style={{ fontSize: 12, padding: '4px 8px' }}
              onClick={() => onToggleEditNodes(feature.id)}
            >
              <Spline size={13} />
              {isEditingNodes ? '退出局部换路' : '局部换路'}
            </button>
            <button
              type="button"
              className="btn outline"
              style={{ fontSize: 12, padding: '4px 8px' }}
              onClick={() => {
                const reversed = [...(feature.geometry.coordinates as number[][])].reverse();
                onSave({
                  ...feature,
                  title: title.trim() || '未命名标注',
                  category: category.trim(),
                  color,
                  description,
                  geometry: { type: 'LineString', coordinates: reversed },
                });
              }}
            >
              <ArrowLeftRight size={13} />
              反转方向
            </button>
          </div>
        )}

        <div>
          <label className="field-label">标题</label>
          <input
            className="text-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="输入标注名称"
          />
        </div>

        <div>
          <label className="field-label">分组标签</label>
          <input
            className="text-input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="例如：Day 1 / 美食 / 住宿"
          />
        </div>

        <div>
          <label className="field-label">颜色</label>
          <div className="color-swatches">
            {SWATCH_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`swatch ${color === hex ? 'active' : ''}`}
                style={{ background: hex }}
                onClick={() => {
                  setColor(hex);
                  onSave({
                    ...feature,
                    title: title.trim() || '未命名标注',
                    category: category.trim(),
                    color: hex,
                    description,
                  });
                }}
              />
            ))}
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label className="field-label" style={{ marginBottom: 0 }}>
              备注（支持 Markdown 与外链图片）
            </label>
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 6px', fontSize: 12 }}
              onClick={() => setPreviewMode((prev) => !prev)}
            >
              {previewMode ? '编辑' : '预览'}
            </button>
          </div>

          {previewMode ? (
            <div
              className="markdown-preview"
              dangerouslySetInnerHTML={{
                __html: renderedHtml || '<span style="color:#94a3b8">暂无备注</span>',
              }}
            />
          ) : (
            <textarea
              className="textarea-input"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="支持 Markdown，可直接贴外链图片：![照片](https://...)"
            />
          )}
        </div>
      </div>

      <div className="sidebar-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
        <button className="btn danger" onClick={() => onDelete(feature.id)}>
          <Trash2 size={14} />
          删除
        </button>
        <button className="btn primary" onClick={handleSubmit}>
          <Save size={14} />
          保存修改
        </button>
      </div>
    </section>
  );
}
