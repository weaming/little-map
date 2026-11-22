import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

interface ShareModalProps {
  mapId: string;
  editToken: string;
  onClose: () => void;
}

export function ShareModal({ mapId, editToken, onClose }: ShareModalProps) {
  const [copiedKey, setCopiedKey] = useState<string>('');
  const origin = window.location.origin;
  const viewUrl = `${origin}/?m=${encodeURIComponent(mapId)}`;
  const editUrl = editToken ? `${origin}/?m=${encodeURIComponent(mapId)}&t=${encodeURIComponent(editToken)}` : '';
  const mcpUrl = `${origin}/mcp`;

  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        'little-map': {
          url: mcpUrl,
        },
      },
      context: {
        map_id: mapId,
        ...(editToken ? { edit_token: editToken } : {}),
      },
    },
    null,
    2,
  );

  async function handleCopy(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(''), 1800);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>分享与 AI MCP 接入</span>
          <button className="btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div>
            <label className="field-label">只读分享链接（任何人可查看）</label>
            <div className="copy-row">
              <input className="text-input" value={viewUrl} readOnly />
              <button className="btn outline" onClick={() => handleCopy('view', viewUrl)}>
                {copiedKey === 'view' ? <Check size={14} /> : <Copy size={14} />}
                {copiedKey === 'view' ? '已复制' : '复制'}
              </button>
            </div>
          </div>

          {editUrl && (
            <div>
              <label className="field-label">协作编辑链接（持有者可增删改标注）</label>
              <div className="copy-row">
                <input className="text-input" value={editUrl} readOnly />
                <button className="btn primary" onClick={() => handleCopy('edit', editUrl)}>
                  {copiedKey === 'edit' ? <Check size={14} /> : <Copy size={14} />}
                  {copiedKey === 'edit' ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          )}

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label className="field-label" style={{ marginBottom: 0 }}>
                AI MCP Streamable HTTP 接入（{mcpUrl}）
              </label>
              <button className="btn" onClick={() => handleCopy('mcp', mcpSnippet)}>
                {copiedKey === 'mcp' ? <Check size={14} /> : <Copy size={14} />}
                {copiedKey === 'mcp' ? '已复制' : '复制配置'}
              </button>
            </div>
            <pre className="code-block">{mcpSnippet}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
