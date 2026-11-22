import { useRef } from 'react';
import {
  CopyPlus,
  Download,
  Home,
  LocateFixed,
  MapPin,
  MousePointer2,
  Pentagon,
  Plus,
  Ruler,
  Share2,
  Spline,
  SquareDashedMousePointer,
  Upload,
} from 'lucide-react';
import { BASEMAPS, OVERLAYS } from '../map/geo';
import type { BasemapId, DrawTool, OverlayId } from '../types/map';

interface ToolbarProps {
  tool: DrawTool;
  basemap: BasemapId;
  overlay: OverlayId;
  canEdit: boolean;
  onToolChange: (tool: DrawTool) => void;
  onBasemapChange: (basemap: BasemapId) => void;
  onOverlayChange: (overlay: OverlayId) => void;
  onShare: () => void;
  onCloneMap: () => void;
  onCreateNew: () => void;
  onExport: () => void;
  onImportGeoJSON: (file: File) => void;
  onLocateMe: () => void;
  onGoHome: () => void;
}

export function Toolbar({
  tool,
  basemap,
  overlay,
  canEdit,
  onToolChange,
  onBasemapChange,
  onOverlayChange,
  onShare,
  onCloneMap,
  onCreateNew,
  onExport,
  onImportGeoJSON,
  onLocateMe,
  onGoHome,
}: ToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={`floating-toolbar ${canEdit ? 'editable' : 'readonly'}`}>
      <button className="btn" onClick={onGoHome} title="返回首页与地图列表">
        <Home size={15} />
      </button>

      <div className="tool-divider" />

      <button
        className={`btn ${tool === 'select' ? 'active' : ''}`}
        onClick={() => onToolChange('select')}
        title="选择 / 浏览"
      >
        <MousePointer2 size={15} />
        <span className="tool-label">选择</span>
      </button>

      {canEdit && (
        <>
          <button
            className={`btn ${tool === 'point' ? 'active' : ''}`}
            onClick={() => onToolChange('point')}
            title="点击地图添加点标注"
          >
            <MapPin size={15} />
            打点
          </button>
          <button
            className={`btn ${tool === 'line' ? 'active' : ''}`}
            onClick={() => onToolChange('line')}
            title="绘制折线"
          >
            <Spline size={15} />
            画线
          </button>
          <button
            className={`btn ${tool === 'polygon' ? 'active' : ''}`}
            onClick={() => onToolChange('polygon')}
            title="绘制多边形区域"
          >
            <Pentagon size={15} />
            画面
          </button>
        </>
      )}

      <div className="tool-divider" />

      <button
        className={`btn ${tool === 'measure-distance' ? 'active' : ''}`}
        onClick={() => onToolChange('measure-distance')}
        title="临时测距（不保存）"
      >
        <Ruler size={15} />
        测距
      </button>
      <button
        className={`btn ${tool === 'measure-area' ? 'active' : ''}`}
        onClick={() => onToolChange('measure-area')}
        title="临时测面（不保存）"
      >
        <SquareDashedMousePointer size={15} />
        测面
      </button>

      <button className="btn" onClick={onLocateMe} title="定位到当前位置（自动纠偏）">
        <LocateFixed size={15} />
        定位
      </button>

      <div className="tool-divider" />

      <select
        className="select-input"
        value={basemap}
        onChange={(e) => onBasemapChange(e.target.value as BasemapId)}
        title="切换底图（自动做 WGS-84 / GCJ-02 纠偏）"
      >
        {Object.values(BASEMAPS).map((bm) => (
          <option key={bm.id} value={bm.id}>
            {bm.label}
          </option>
        ))}
      </select>

      <select
        className="select-input"
        value={overlay}
        onChange={(e) => onOverlayChange(e.target.value as OverlayId)}
        title="叠加透明路网层（支持跨提供商与跨坐标系像素对齐）"
      >
        {Object.values(OVERLAYS).map((ov) => (
          <option key={ov.id} value={ov.id}>
            {ov.label}
          </option>
        ))}
      </select>

      <div className="tool-divider" />

      <button className="btn" onClick={onExport} title="导出 GeoJSON">
        <Download size={15} />
        导出
      </button>

      {canEdit && (
        <>
          <button className="btn" onClick={() => fileInputRef.current?.click()} title="导入 GeoJSON">
            <Upload size={15} />
            导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                onImportGeoJSON(file);
                e.target.value = '';
              }
            }}
          />
        </>
      )}

      <button className="btn primary" onClick={onShare} title="分享链接与 AI MCP 配置">
        <Share2 size={15} />
        <span className="tool-label">分享</span>
      </button>

      <button className="btn outline" onClick={onCloneMap} title="复制当前地图为我的可编辑副本">
        <CopyPlus size={15} />
        <span className="tool-label">复制</span>
      </button>

      <button className="btn outline hide-mobile-readonly" onClick={onCreateNew} title="新建空白地图">
        <Plus size={15} />
        <span className="tool-label">新建</span>
      </button>
    </div>
  );
}
