// 岗位匹配 Tab——ECharts 仪表盘 + 五维匹配度卡 + 匹配分公式解释 + TOP5 岗位进度条 + GapBar 差距分析
import React, { type FC } from 'react'
import type { GapDetail, Explanations } from '../../types'

const MatchGauge = React.lazy(() => import('../charts/MatchGauge'))
const GapBar = React.lazy(() => import('../charts/GapBar'))

interface Props {
  matchScore: number
  previousScore?: number
  dimensionScores: Record<string, number>
  top5Jobs: any[]
  gapDetails: GapDetail[]
  explanations?: Explanations
}

const dimLabels: Record<string, string> = {
  tech_skills: '技术技能',
  project_exp: '项目经验',
  academic_foundation: '学业基础',
  domain_knowledge: '领域认知',
  soft_skill_evidence: '软技能证据',
}
const dimColors: Record<string, string> = {
  tech_skills: 'var(--accent-primary)',
  project_exp: 'var(--accent-primary)',
  academic_foundation: 'var(--accent-success)',
  domain_knowledge: 'var(--accent-warning)',
  soft_skill_evidence: 'var(--accent-primary)',
}

// 短键映射到全键名
const shortToFullKey: Record<string, string> = {
  tech: 'tech_skills',
  project: 'project_exp',
  academic: 'academic_foundation',
  domain: 'domain_knowledge',
  soft_evidence: 'soft_skill_evidence',
  soft: 'soft_skill_evidence',
}

const MatchTab: FC<Props> = ({ matchScore, previousScore, dimensionScores, top5Jobs, gapDetails, explanations }) => {
  const safeDimScores = dimensionScores && typeof dimensionScores === 'object' ? dimensionScores : {}
  const safeGapDetails = Array.isArray(gapDetails) ? gapDetails : []
  const safeTop5Jobs = Array.isArray(top5Jobs) ? top5Jobs : []
  const gapBarData = safeGapDetails.map(g => ({ skill: g.skill, current: g.current, required: g.required }))
  const matchExpl = explanations?.match_score
  const dimExpl = explanations?.dimensions

  // 获取维度分数（兼容短键和全键名）
  const getDimScore = (fullKey: string): number => {
    if (safeDimScores[fullKey] !== undefined) return safeDimScores[fullKey]
    for (const [short, full] of Object.entries(shortToFullKey)) {
      if (full === fullKey && safeDimScores[short] !== undefined) return safeDimScores[short]
    }
    return 0
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center' }}>
      {/* 综合匹配度仪表盘 */}
      <div style={{ padding: '16px 0 8px', width: 220, height: 200 }}>
        <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
          <MatchGauge score={matchScore} previousScore={previousScore} />
        </React.Suspense>
      </div>

      {/* 匹配分公式解释面板 */}
      {matchExpl && (
        <div style={{
          width: '100%',
          padding: 14,
          borderRadius: 10,
          border: '1px solid var(--border-light)',
          background: 'var(--bg-card)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, letterSpacing: '1px', textTransform: 'uppercase' }}>
            匹配分计算说明
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', padding: '8px 12px', background: 'var(--bg-hover)', borderRadius: 6, marginBottom: 8, wordBreak: 'break-all' }}>
            综合分 = {(matchExpl.formula || '加权求和').replace(
              /tech_skills|project_exp|academic_foundation|domain_knowledge|soft_skill_evidence/g,
              m => dimLabels[m] || m
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(matchExpl.weights || {}).map(([key, weight]) => (
              <span key={key} style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                background: 'var(--bg-hover)', color: 'var(--text-secondary)',
              }}>
                {dimLabels[key] || key} 权重 {(weight as number * 100).toFixed(0)}%
              </span>
            ))}
          </div>
          {explanations?.summary && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
              {explanations.summary.basis}
              {typeof explanations.summary.confidence === 'number' && isFinite(explanations.summary.confidence) && (
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent-warning)' }}>
                  置信度 {(explanations.summary.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 五维匹配度卡片 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 16,
        width: '100%',
      }}>
        {Object.entries(dimLabels).map(([key, label]) => {
          const score = getDimScore(key)
          const color = dimColors[key] ?? 'var(--accent-primary)'
          const dimDetail = dimExpl?.[key]
          const conf = dimDetail?.confidence
          return (
            <div
              key={key}
              style={{
                padding: 14,
                borderRadius: 10,
                border: '1px solid var(--border-light)',
                background: 'var(--bg-card)',
                textAlign: 'center',
                position: 'relative',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 28, fontFamily: "var(--font-display)", fontWeight: 700, color, lineHeight: 1 }}>
                {(score * 100).toFixed(0)}%
              </div>
              {conf !== undefined && (
                <div style={{ fontSize: 10, color: conf > 0.6 ? 'var(--accent-success)' : 'var(--accent-warning)', marginTop: 4 }}>
                  {conf > 0.6 ? '可信' : conf > 0.3 ? '参考' : '证据不足'}
                </div>
              )}
              {/* 证据/缺失提示 */}
              {dimDetail && dimDetail.missing?.length > 0 && dimDetail.evidence?.length === 0 && (
                <div style={{ fontSize: 9, color: 'var(--accent-warning)', marginTop: 2 }}>
                  缺少评估数据
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* TOP5 岗位排行 */}
      {safeTop5Jobs.length > 0 && (
        <div style={{ width: '100%' }}>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, letterSpacing: '1px', textTransform: 'uppercase' }}>
            TOP5 匹配岗位
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {safeTop5Jobs.map((job, i) => {
              const jScore = typeof job.match_score === 'number' ? job.match_score : (typeof job.score === 'number' ? job.score : 0)
              const jPct = jScore * 100
              const barColor = jPct >= 70 ? 'var(--accent-success)' : jPct >= 40 ? 'var(--accent-warning)' : 'var(--accent-primary)'
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <span style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{job.title} {job.company && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>@{job.company}</span>}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      {job.matched_skills?.map((s: string) => (
                        <span key={s} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: 'rgba(var(--accent-success-rgb), 0.15)', color: 'var(--accent-success)' }}>{s}</span>
                      ))}
                      {job.missing_skills?.map((s: string) => (
                        <span key={s} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: 'rgba(var(--accent-warning-rgb), 0.15)', color: 'var(--accent-warning)' }}>{s}</span>
                      ))}
                    </div>
                    <div style={{ height: 8, borderRadius: 4, background: 'var(--border-light)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 4, width: `${jPct}%`, background: barColor, transition: 'width 0.8s ease' }} />
                    </div>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: barColor, fontFamily: "var(--font-display)", minWidth: 44, textAlign: 'right' }}>{jPct.toFixed(0)}%</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 差距分析柱状图 */}
      {gapBarData.length > 0 && (
        <div style={{ width: '100%' }}>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, letterSpacing: '1px', textTransform: 'uppercase' }}>差距分析</div>
          <div style={{ width: '100%', minHeight: gapBarData.length * 50 }}>
            <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
              <GapBar data={gapBarData} />
            </React.Suspense>
          </div>
        </div>
      )}
    </div>
  )
}

export default MatchTab
