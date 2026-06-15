// 成长追踪 Tab——ECharts 成长趋势图 + 版本对比选择器 + 诊断历史时间线
import React, { useState, type FC } from 'react'
import type { DiagnosisResult } from '../../types'

const GrowthTrend = React.lazy(() => import('../charts/GrowthTrend'))

interface Props {
  history: DiagnosisResult[]
  /** 跳转到诊断解释 Tab（用于版本对比卡片的"查看详情"） */
  onNavigateToDiagnosis?: () => void
}

const dimLabels: Record<string, string> = {
  tech_skills: '技术技能',
  tech: '技术技能',
  project_exp: '项目经验',
  project: '项目经验',
  academic_foundation: '学业基础',
  academic: '学业基础',
  domain_knowledge: '领域认知',
  domain: '领域认知',
  soft_skill_evidence: '软技能证据',
  soft_evidence: '软技能证据',
  soft_skills: '软技能',
  soft: '软技能',
}

const GrowthTab: FC<Props> = ({ history, onNavigateToDiagnosis }) => {
  const [compareA, setCompareA] = useState<number | null>(null)
  const [compareB, setCompareB] = useState<number | null>(null)

  if (!history || history.length === 0) {
    return (
      <div className="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <h3>暂无成长追踪数据</h3>
        <p>完成首次诊断后，这里将展示你的成长趋势</p>
      </div>
    )
  }

  const sorted = [...history].sort((a, b) => b.version - a.version)
  const verA = sorted.find(d => d.version === compareA)
  const verB = sorted.find(d => d.version === compareB)

  const dims = verA && verB
    ? Object.entries(verA.dimension_scores || {}).map(([key, valA]) => ({
        key, valA, valB: (verB.dimension_scores || {})[key] ?? 0,
        change: valA - ((verB.dimension_scores || {})[key] ?? 0),
      }))
    : []

  const trendData = [...history]
    .sort((a, b) => a.version - b.version)
    .map(d => ({ date: `V${d.version}`, scores: d.dimension_scores || {} }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* 成长趋势折线图 */}
      <div style={{ padding: 16, borderRadius: 10, border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12, letterSpacing: '1px', textTransform: 'uppercase' }}>
          成长趋势
        </div>
        <div style={{ width: '100%', height: 280 }}>
          <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
            <GrowthTrend history={trendData} />
          </React.Suspense>
        </div>
      </div>

      {/* 版本对比面板——需要至少 2 个版本才有意义 */}
      {sorted.length >= 2 ? (
      <div style={{ padding: 16, borderRadius: 10, border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, letterSpacing: '1px', textTransform: 'uppercase' }}>
          版本对比
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16 }}>
          <select
            value={compareA ?? ''}
            onChange={e => setCompareA(e.target.value ? Number(e.target.value) : null)}
            style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-body)', appearance: 'auto' }}
          >
            <option value="">选择版本 A</option>
            {sorted.map(d => (
              <option key={d.version} value={d.version}>V{d.version} - {(d.match_score * 100).toFixed(0)}% - {d.trigger_event || '初始诊断'}</option>
            ))}
          </select>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 14, fontWeight: 700 }}>对比</span>
          <select
            value={compareB ?? ''}
            onChange={e => setCompareB(e.target.value ? Number(e.target.value) : null)}
            style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-body)', appearance: 'auto' }}
          >
            <option value="">选择版本 B</option>
            {sorted.map(d => (
              <option key={d.version} value={d.version}>V{d.version} - {(d.match_score * 100).toFixed(0)}% - {d.trigger_event || '初始诊断'}</option>
            ))}
          </select>
        </div>

        {verA && verB && verA.version === verB.version && (
          <div style={{ textAlign: 'center', padding: 16, color: 'var(--accent-warning)', fontSize: 13, background: 'rgba(var(--accent-warning-rgb), 0.08)', borderRadius: 8, border: '1px solid rgba(var(--accent-warning-rgb), 0.2)' }}>
            请选择不同的版本进行对比
          </div>
        )}
        {verA && verB && verA.version !== verB.version && dims.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 90px 90px 70px', gap: 12, fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
              <span>维度</span><span style={{ textAlign: 'center' }}>A (V{verA.version})</span><span style={{ textAlign: 'center' }}>B (V{verB.version})</span><span style={{ textAlign: 'center' }}>变化</span>
            </div>
            {dims.map(dim => (
              <div key={dim.key} style={{ display: 'grid', gridTemplateColumns: '1.4fr 90px 90px 70px', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)', fontSize: 13, alignItems: 'center' }}>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{dimLabels[dim.key] || dim.key}</span>
                <span style={{ textAlign: 'center', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{(dim.valA * 100).toFixed(0)}%</span>
                <span style={{ textAlign: 'center', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{(dim.valB * 100).toFixed(0)}%</span>
                <span style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 600, color: dim.change > 0 ? 'var(--accent-success)' : dim.change < 0 ? 'var(--accent-danger)' : 'var(--text-tertiary)' }}>
                  {dim.change > 0 ? '+' : ''}{(dim.change * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}
        {(!verA || !verB) && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-tertiary)', fontSize: 12 }}>请选择两个版本进行对比</div>
        )}
      </div>
      ) : (
        <div className="surface-card" style={{ padding: 'var(--space-5)', textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            完成 1 次复评后，这里将展示版本对比，量化你的能力提升轨迹。
          </div>
        </div>
      )}

      {/* 诊断历史列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', letterSpacing: '1px', textTransform: 'uppercase' }}>诊断历史 ({history.length})</div>
        {sorted.map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: i === 0 ? 'var(--accent-primary)' : 'var(--border-light)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>V{item.version}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginLeft: 8 }}>{item.created_at?.slice(0, 10) || ''}</span>
              {item.trigger_event && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{item.trigger_event}</div>}
            </div>
            <div style={{ fontSize: 20, fontFamily: "var(--font-display)", fontWeight: 700, color: item.match_score >= 0.7 ? 'var(--accent-success)' : item.match_score >= 0.4 ? 'var(--accent-warning)' : 'var(--accent-danger)' }}>
              {(item.match_score * 100).toFixed(0)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default GrowthTab
