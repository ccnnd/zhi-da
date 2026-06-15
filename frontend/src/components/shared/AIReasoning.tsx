// 可折叠推理面板——展示 AI 建议的推理依据和置信度条(琥珀→绿色渐变)
import { useState, type FC } from 'react'

// 推理条目（期望结构）
interface ReasoningItem {
  basis: string
  confidence: number
}

interface Props {
  // 后端 ai_reasoning 形状不固定（可能是 LLM 任意结构 / fallback 平铺字典），
  // 这里用 Record<string, any> 接收，在内部做防御性归一化，避免渲染崩溃。
  reasoning: Record<string, any>
}

/**
 * 把后端任意形状的 ai_reasoning 归一化为 [{key, basis, confidence}] 数组。
 * 规则：
 *  - 跳过 null/undefined 值；
 *  - 对象值：取 basis/confidence，缺失补默认；basis 缺失时回退显示 JSON 摘要；
 *  - 字符串/数字/布尔值：直接作为 basis 展示，置信度给中性 0.5。
 */
const normalizeReasoning = (reasoning: Record<string, any> | null | undefined): Array<{ key: string } & ReasoningItem> => {
  if (!reasoning || typeof reasoning !== 'object') return []
  // 检测 fallback 标记：_fallback 或仅包含元数据字段（note/fallback/_note 等）
  const metaKeys = new Set(['_fallback', '_note', 'fallback', 'note'])
  const realKeys = Object.keys(reasoning).filter(k => !metaKeys.has(k) && reasoning[k] !== null && reasoning[k] !== undefined)
  if (realKeys.length === 0) {
    // 仅有元数据字段，不渲染为推理条目
    return []
  }
  const result: Array<{ key: string } & ReasoningItem> = []
  for (const [key, raw] of Object.entries(reasoning)) {
    if (raw === null || raw === undefined) continue
    // 跳过元数据字段
    if (metaKeys.has(key)) continue
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const item = raw as Record<string, any>
      let basis = item.basis
      if (typeof basis !== 'string' || basis.length === 0) {
        // basis 缺失时，用其它字段拼一个可读摘要，避免空白
        const others = Object.entries(item)
          .filter(([k]) => k !== 'basis' && k !== 'confidence')
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        basis = others.length > 0 ? others.join('；') : '（无详细依据）'
      }
      let confidence = typeof item.confidence === 'number' ? item.confidence : NaN
      if (!isFinite(confidence)) confidence = 0.5
      result.push({ key, basis, confidence: Math.max(0, Math.min(1, confidence)) })
    } else {
      // 原始值（字符串/数字/布尔）
      result.push({
        key,
        basis: typeof raw === 'object' ? JSON.stringify(raw) : String(raw),
        confidence: 0.5,
      })
    }
  }
  return result
}

const AIReasoning: FC<Props> = ({ reasoning }) => {
  const [expanded, setExpanded] = useState(false)
  const items = normalizeReasoning(reasoning)

  return (
    <div style={{
      border: '1px solid var(--border-light)',
      borderRadius: 8,
      overflow: 'hidden',
      background: 'var(--bg-card)',
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: 'var(--bg-hover)',
          border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
          fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600,
          letterSpacing: '0.5px',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-1 5h2v6h-2zm1 8h0"/>
            <circle cx="12" cy="19" r="1" fill="var(--accent-primary)" stroke="none"/>
          </svg>
          AI 推理依据
        </span>
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.3s ease' }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div style={{
        maxHeight: expanded ? 600 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.35s ease',
      }}>
        <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
              暂无推理依据数据
            </div>
          ) : items.map((item, i) => (
            <div key={i}>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 4 }}>
                {item.key}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {item.basis}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  flex: 1, height: 4, borderRadius: 2, background: 'var(--border-light)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    width: `${item.confidence * 100}%`,
                    background: item.confidence >= 0.7
                      ? 'var(--accent-success)'
                      : item.confidence >= 0.4
                        ? 'var(--accent-warning)'
                        : 'var(--accent-danger)',
                    transition: 'width 0.6s ease',
                  }}/>
                </div>
                <span style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono)', minWidth: 36, textAlign: 'right',
                }}>
                  {(item.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default AIReasoning
