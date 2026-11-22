import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { Activity, ArrowLeftRight, Eye, Pencil, Save, Spline, Trash2, X } from 'lucide-react';
import { formatArea, formatDistance, lineLengthMeters, polygonAreaSqMeters } from '../map/geo';
import type { MapFeature } from '../types/map';

const SWATCH_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#334155'];

interface FeatureInspectorProps {
  feature: MapFeature;
  canEdit: boolean;
  hasAmapKey: boolean;
  isEditingNodes: boolean;
  trafficActive: boolean;
  trafficLoading: boolean;
  onSave: (updated: MapFeature) => void;
  onDelete: (featureId: string) => void;
  onToggleEditNodes: (featureId: string) => void;
  onToggleTraffic: (feature: MapFeature) => void;
  onClose: () => void;
}

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 768;
}

function renderSafeMarkdown(raw: string): string {
  if (!raw.trim()) return '';
  const html = marked.parse(raw, { async: false, breaks: true }) as string;
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\s+href=/gi, '<a target="_blank" rel="noopener noreferrer" href=');
}

export function FeatureInspector({
  feature,
  canEdit,
  hasAmapKey,
  isEditingNodes,
  trafficActive,
  trafficLoading,
  onSave,
  onDelete,
  onToggleEditNodes,
  onToggleTraffic,
  onClose,
}: FeatureInspectorProps) {
  const [title, setTitle] = useState(feature.title);
  const [category, setCategory] = useState(feature.category);
  const [color, setColor] = useState(feature.color || '#2563eb');
  const [description, setDescription] = useState(feature.description);
  const [editing, setEditing] = useState(() => canEdit && !isMobileViewport());
  const [previewMode, setPreviewMode] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTitle(feature.title);
    setCategory(feature.category);
    setColor(feature.color || '#2563eb');
    setDescription(feature.description);
  }, [feature]);

  useEffect(() => {
    setEditing(canEdit && !isMobileViewport());
    setPreviewMode(true);
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
  const isDirty =
    title !== feature.title ||
    category !== feature.category ||
    color !== (feature.color || '#2563eb') ||
    description !== feature.description;
  const geomTypeLabel =
    feature.geometry.type === 'Point' ? '标记点' : feature.geometry.type === 'LineString' ? '路线' : '区域';

  function handleSubmit() {
    if (!canEdit) return;
    onSave({
      ...feature,
      title: title.trim() || '未命名标注',
      category: category.trim(),
      color,
      description,
    });
    setPreviewMode(true);
    if (isMobileViewport()) {
      setEditing(false);
    }
  }

  function enterNoteEditMode() {
    setPreviewMode(false);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <div className="badge" style={{ width: 'fit-content' }}>
              {metricText}
            </div>
            {feature.geometry.type === 'LineString' && hasAmapKey && (
              <button
                type="button"
                className={`btn outline ${trafficActive ? 'active' : ''}`}
                style={{ fontSize: 12, padding: '3px 8px' }}
                disabled={trafficLoading}
                onClick={() => onToggleTraffic(feature)}
              >
                <Activity size={13} />
                {trafficLoading ? '拉取中...' : trafficActive ? '隐藏路况' : '查看实时路况'}
              </button>
            )}
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
      <div className="inspector-header">
        <div className="inspector-header-title">
          <span className="color-dot" style={{ background: color }} />
          <strong>{geomTypeLabel}详情</strong>
          {isDirty && <span className="inspector-dirty-dot">未保存</span>}
        </div>
        <button
          className="btn icon-btn"
          onClick={() => (isMobileViewport() ? setEditing(false) : onClose())}
          title={isMobileViewport() ? '返回预览' : '关闭'}
        >
          <X size={16} />
        </button>
      </div>

      <div className="inspector-body">
        <div className="inspector-meta-card">
          <div className="inspector-metric-text">{metricText}</div>
          {feature.geometry.type === 'LineString' && (
            <div className="inspector-line-actions">
              <button
                type="button"
                className={`btn outline compact-btn ${isEditingNodes ? 'active' : ''}`}
                onClick={() => onToggleEditNodes(feature.id)}
              >
                <Spline size={13} />
                {isEditingNodes ? '退出换路' : '局部换路'}
              </button>
              {hasAmapKey && (
                <button
                  type="button"
                  className={`btn outline compact-btn ${trafficActive ? 'active' : ''}`}
                  disabled={trafficLoading}
                  onClick={() => onToggleTraffic(feature)}
                >
                  <Activity size={13} />
                  {trafficLoading ? '拉取中...' : trafficActive ? '隐藏路况' : '实时路况'}
                </button>
              )}
              <button
                type="button"
                className="btn outline compact-btn"
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
        </div>

        <div className="inspector-field">
          <label className="field-label">标题</label>
          <input
            className="text-input inspector-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="输入标注名称"
          />
        </div>

        <div className="inspector-field">
          <label className="field-label">分组标签</label>
          <input
            className="text-input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="例如：Day 1 / 美食 / 住宿"
          />
        </div>

        <div className="inspector-field">
          <label className="field-label">颜色</label>
          <div className="color-swatches">
            {SWATCH_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`swatch ${color === hex ? 'active' : ''}`}
                style={{ background: hex, color: hex }}
                aria-label={`选择颜色 ${hex}`}
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

        <div className="note-section">
          <div className="note-header">
            <label className="field-label" style={{ marginBottom: 0 }}>
              备注
            </label>
            <div className="note-mode-tabs" role="tablist" aria-label="备注模式">
              <button
                type="button"
                role="tab"
                aria-selected={previewMode}
                className={`note-tab ${previewMode ? 'active' : ''}`}
                onClick={() => setPreviewMode(true)}
              >
                <Eye size={12} />
                预览
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!previewMode}
                className={`note-tab ${!previewMode ? 'active' : ''}`}
                onClick={enterNoteEditMode}
              >
                <Pencil size={12} />
                编辑
              </button>
            </div>
          </div>

          {previewMode ? (
            renderedHtml ? (
              <div
                className="markdown-preview editable"
                onDoubleClick={enterNoteEditMode}
                title="双击进入编辑"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            ) : (
              <button
                type="button"
                className="note-empty-placeholder"
                onClick={enterNoteEditMode}
              >
                点击添加备注（支持 Markdown 与外链图片）
              </button>
            )
          ) : (
            <div className="note-editor-wrap">
              <textarea
                ref={textareaRef}
                className="textarea-input note-textarea"
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="支持 Markdown，可直接贴外链图片：![照片](https://...)"
              />
              <div className="note-editor-hint">支持 Markdown 与外链图片 · Ctrl/⌘+Enter 保存</div>
            </div>
          )}
        </div>
      </div>

      <div className="inspector-footer">
        <button className="btn danger" onClick={() => onDelete(feature.id)}>
          <Trash2 size={14} />
          删除
        </button>
        <button className={`btn ${isDirty ? 'primary' : 'outline'}`} onClick={handleSubmit}>
          <Save size={14} />
          {isDirty ? '保存修改' : '已保存'}
        </button>
      </div>
    </section>
  );
}
