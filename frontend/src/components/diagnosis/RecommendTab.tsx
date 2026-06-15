// 就业推荐 Tab——岗位推荐卡片，含圆形进度、推荐理由、匹配/缺失技能、可展开企业/岗位详情
import { useState, type FC } from 'react'
import type { RecommendedJob } from '../../types'
import { getStudentJobDetail } from '../../services/api'

interface Props {
  top5Jobs: RecommendedJob[]
}

const rankBadgeColors: Record<number, string> = {
  1: 'var(--accent-warning)',
  2: '#c0c0c0',
  3: '#cd7f32',
  4: 'var(--accent-primary)',
  5: 'var(--accent-primary)',
}

// 单个岗位卡片（可展开详情）
const JobCard: FC<{ job: RecommendedJob; rank: number }> = ({ job, rank }) => {
  const pct = ((job.match_score ?? (job as any).score ?? 0)) * 100
  const color = pct >= 70 ? 'var(--accent-success)' : pct >= 40 ? 'var(--accent-warning)' : 'var(--accent-primary)'
  const circumference = 2 * Math.PI * 28
  const offset = circumference - (pct / 100) * circumference

  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const toggleExpand = async () => {
    // 已有详情直接折叠/展开
    if (detail) {
      setExpanded(!expanded)
      return
    }
    if (!expanded) {
      setExpanded(true)
    }
    // 懒加载详情
    setDetailLoading(true)
    setDetailError('')
    try {
      const data = await getStudentJobDetail(job.job_id)
      setDetail(data)
      setExpanded(true)
    } catch (err: any) {
      setDetailError(err?.message || '加载详情失败')
      setExpanded(true)
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div
      style={{
        padding: 18, borderRadius: 12,
        border: `1px solid ${expanded ? 'var(--accent-primary)' : 'var(--border-light)'}`,
        background: 'var(--bg-card)', transition: 'all 0.3s ease', cursor: 'pointer',
      }}
      onClick={toggleExpand}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = `0 8px 24px rgba(var(--accent-primary-rgb), 0.12)` }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; e.currentTarget.style.borderColor = expanded ? 'var(--accent-primary)' : 'var(--border-light)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: rankBadgeColors[rank] || 'var(--text-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: '#fff', fontFamily: 'var(--font-mono)' }}>{rank}</div>
        <div style={{ position: 'relative', width: 64, height: 64 }}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border-light)" strokeWidth="4" />
            <circle cx="32" cy="32" r="28" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 32 32)" style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
          </svg>
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: 13, fontFamily: "var(--font-display)", fontWeight: 700, color }}>{pct.toFixed(0)}%</div>
        </div>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', marginBottom: 4 }}>{job.title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>{job.company || '知名企业'}</div>

      {job.reason && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8, padding: '6px 10px', borderLeft: '2px solid var(--accent-primary)', background: 'var(--bg-hover)', borderRadius: '0 4px 4px 0' }}>{job.reason}</div>
      )}

      {job.matched_skills && job.matched_skills.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>匹配技能</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {job.matched_skills.map(s => <span key={s} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(var(--accent-success-rgb), 0.15)', color: 'var(--accent-success)' }}>{s}</span>)}
          </div>
        </div>
      )}
      {job.missing_skills && job.missing_skills.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>待提升</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {job.missing_skills.map(s => <span key={s} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(var(--accent-warning-rgb), 0.15)', color: 'var(--accent-warning)' }}>{s}</span>)}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        匹配度 <span style={{ color, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{pct.toFixed(0)}%</span>，{pct >= 70 ? '高度匹配，建议重点关注' : pct >= 40 ? '中等匹配，可针对性提升短板' : '较低匹配，建议夯实基础'}
      </div>
      {job.confidence !== undefined && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>置信度 {(job.confidence * 100).toFixed(0)}%</div>
      )}

      {/* 展开提示 */}
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center', borderTop: '1px solid var(--border-light)', paddingTop: 8 }}>
        {expanded ? '收起详情 ▲' : '查看岗位与企业详情 ▼'}
      </div>

      {/* 展开详情区 */}
      {expanded && (
        <div style={{ marginTop: 10, padding: 12, background: 'var(--bg-hover)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }} onClick={e => e.stopPropagation()}>
          {detailLoading && <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>加载中...</div>}
          {detailError && <div style={{ color: 'var(--accent-danger)' }}>{detailError}</div>}
          {detail && (
            <>
              {/* 企业信息 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, letterSpacing: '0.5px' }}>🏢 企业</div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{detail.enterprise_name}{detail.enterprise_industry && <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 6 }}>· {detail.enterprise_industry}</span>}</div>
                {detail.enterprise_description && <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{detail.enterprise_description.slice(0, 120)}{(detail.enterprise_description.length > 120) ? '…' : ''}</div>}
              </div>
              {/* 岗位描述 */}
              {detail.description && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, letterSpacing: '0.5px' }}>📋 岗位职责</div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>{detail.description}</div>
                </div>
              )}
              {/* 岗位要求 */}
              {detail.requirements_text && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, letterSpacing: '0.5px' }}>🎯 岗位要求</div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>{detail.requirements_text}</div>
                </div>
              )}
              {/* 能力要求 */}
              {detail.ability_model && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, letterSpacing: '0.5px' }}>🎯 能力要求</div>
                  {detail.ability_model.tech_skills && Object.keys(detail.ability_model.tech_skills).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                      {Object.entries(detail.ability_model.tech_skills).map(([k, v]: any) => <span key={k} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(var(--accent-primary-rgb), 0.12)', color: 'var(--accent-primary)' }}>{k}{v ? ` ${v}` : ''}</span>)}
                    </div>
                  )}
                  {detail.ability_model.domain_knowledge && Object.keys(detail.ability_model.domain_knowledge).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Object.entries(detail.ability_model.domain_knowledge).map(([k]: any) => <span key={k} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(var(--accent-warning-rgb), 0.12)', color: 'var(--accent-warning)' }}>{k}</span>)}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const RecommendTab: FC<Props> = ({ top5Jobs }) => {
  if (!top5Jobs || top5Jobs.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)', fontSize: 14 }}>
        暂无岗位推荐数据
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
      {top5Jobs.map((job, i) => <JobCard key={job.job_id || i} job={job} rank={i + 1} />)}
    </div>
  )
}

export default RecommendTab
