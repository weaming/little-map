import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { Save, Trash2, X } from 'lucide-react';
import { formatArea, formatDistance, lineLengthMeters, polygonAreaSqMeters } from '../map/geo';
import type { MapFeature } from '../types/map';

const SWATCH_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#334155'];

interface FeatureInspectorProps {
  feature: MapFeature;
  canEdit: boolean;
  onSave: (updated: MapFeature) => void;
  onDelete: (featureId: string) => void;
  onClose: () => void;
}

function renderSafeMarkdown(raw: string): string {
  if (!raw.trim()) return '<span style="color:#94a3b8">暂无备注</span>';
  const html = marked.parse(raw, { async: false }) as string;
  return html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}

export function FeatureInspector({ feature, canEdit, onSave, onDelete, onClose }: FeatureInspectorProps) {
  const [title, setTitle] = useState(feature.title);
  const [category, setCategory] = useState(feature.category);
  const [color, setColor] = useState(feature.color || '#2563eb');
  const [description, setDescription] = useState(feature.description);
  const [previewMode, setPreviewMode] = useState(!canEdit);

  useEffect(() => {
    setTitle(feature.title);
    setCategory(feature.category);
    setColor(feature.color || '#2563eb');
    setDescription(feature.description);
    setPreviewMode(!canEdit);
  }, [feature, canEdit]);

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
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <section className="inspector">
      <div className="sidebar-header">
        <strong style={{ fontSize: 14 }}>标注详情</strong>
        <button className="btn" onClick={onClose} title="关闭">
          <X size={16} />
        </button>
      </div>

      <div className="inspector-body">
        <div className="badge" style={{ width: 'fit-content' }}>
          {metricText}
        </div>

        <div>
          <label className="field-label">标题</label>
          <input
            className="text-input"
            value={title}
            readOnly={!canEdit}
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
            readOnly={!canEdit}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="例如：Day 1 / 美食 / 住宿"
          />
        </div>

        {canEdit && (
          <div>
            <label className="field-label">颜色</label>
            <div className="color-swatches">
              {SWATCH_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`swatch ${color === hex ? 'active' : ''}`}
                  style={{ background: hex }}
                  onClick={() => setColor(hex)}
                />
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label className="field-label" style={{ marginBottom: 0 }}>
              备注（支持 Markdown 与外链图片）
            </label>
            {canEdit && (
              <button
                type="button"
                className="btn"
                style={{ padding: '2px 6px', fontSize: 12 }}
                onClick={() => setPreviewMode((prev) => !prev)}
              >
                {previewMode ? '编辑' : '预览'}
              </button>
            )}
          </div>

          {previewMode ? (
            <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          ) : (
            <textarea
              className="textarea-input"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="支持 Markdown，可直接贴外链图片：![照片](https://...)"
            />
          )}
        </div>
      </div>

      {canEdit && (
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
      )}
    </section>
  );
}
