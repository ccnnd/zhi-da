// AI 状态指示器——显示当前 AI 服务可用性和诊断状态
import { useState, type FC } from 'react'

interface Props {
  aiStatus?: string  // available / missing_key / provider_error / schema_error / fallback_rule_based
  compact?: boolean
}

const statusConfig: Record<string, { label: string; color: string; bgColor: string; desc: string }> = {
  available: { label: 'AI 诊断', color: 'var(--accent-success)', bgColor: 'rgba(var(--accent-success-rgb), 0.12)', desc: 'AI 服务正常，结果基于智能体分析' },
  missing_key: { label: 'AI 未配置', color: 'var(--accent-warning)', bgColor: 'rgba(var(--accent-warning-rgb), 0.12)', desc: '未配置大模型密钥，请联系学校管理员' },
  provider_error: { label: 'AI 服务异常', color: '#ef4444', bgColor: 'rgba(var(--accent-danger-rgb), 0.12)', desc: 'AI 服务暂时不可用，请稍后重试' },
  schema_error: { label: 'AI 输出异常', color: '#ef4444', bgColor: 'rgba(var(--accent-danger-rgb), 0.12)', desc: 'AI 输出格式异常，结果可能不准确' },
  fallback_rule_based: { label: '规则兜底', color: 'var(--accent-warning)', bgColor: 'rgba(var(--accent-warning-rgb), 0.12)', desc: '部分步骤使用规则兜底，结果仅供参考' },
}

const AIStatusBadge: FC<Props> = ({ aiStatus = 'available', compact = false }) => {
  const [showTooltip, setShowTooltip] = useState(false)
  const config = statusConfig[aiStatus] || statusConfig.available

  // 可用时不显示（减少视觉干扰）
  if (aiStatus === 'available' && compact) return null

  return (
    <div
      className="ai-status-badge"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: compact ? '2px 8px' : '4px 12px',
        borderRadius: 6, fontSize: compact ? 10 : 11,
        background: config.bgColor, color: config.color,
        cursor: 'pointer', position: 'relative',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: config.color,
        boxShadow: aiStatus === 'available' ? `0 0 6px ${config.color}` : 'none',
      }} />
      {config.label}

      {showTooltip && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 6,
          padding: '8px 12px', borderRadius: 6,
          background: 'var(--bg-card)', border: '1px solid var(--border-light)',
          color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.5,
          whiteSpace: 'nowrap', zIndex: 100,
          boxShadow: 'var(--shadow-sm)',
        }}>
          {config.desc}
        </div>
      )}
    </div>
  )
}

export default AIStatusBadge
