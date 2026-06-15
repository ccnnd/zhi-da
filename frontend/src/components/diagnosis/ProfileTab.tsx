// 能力画像 Tab——ECharts 雷达图 + 五维分值卡片 + 技能标签云 + 学业与软技能详细分析
import React, { type FC } from 'react'
import type { AbilityProfile, Student } from '../../types'

const RadarChart = React.lazy(() => import('../charts/RadarChart'))

interface Props {
  profile: AbilityProfile
  changes?: Record<string, number>
  student: Student
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

const ProfileTab: FC<Props> = ({ profile, changes, student }) => {
  const dims = ['tech_skills', 'project_exp', 'academic_foundation', 'domain_knowledge', 'soft_skill_evidence'] as const

  const radarData = dims.map(dim => ({
    name: dimLabels[dim],
    value: Math.round((profile[dim]?.weight ?? 0) * 100),
  }))

  const allSkills = dims.flatMap(dim =>
    (profile[dim]?.sub_items ?? []).map(skill => ({ ...skill, dim }))
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{
          flex: '1 1 360px',
          minWidth: 320,
          background: 'var(--bg-card)',
          borderRadius: 12,
          border: '1px solid var(--border-light)',
          padding: 20,
        }}>
          {/* 雷达图区域 */}
          <div style={{ width: '100%', height: 360 }}>
            <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
              <RadarChart data={radarData} />
            </React.Suspense>
          </div>
        </div>

        {/* 五维分值卡片网格 */}
        <div style={{
          flex: 1,
          minWidth: 280,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 16,
        }}>
          {dims.map(dim => {
            const dimData = profile[dim]
            const score = dimData?.weight ?? 0
            const change = changes?.[dim]

            return (
              <div
                key={dim}
                style={{
                  padding: 16,
                  borderRadius: 10,
                  border: '1px solid var(--border-light)',
                  background: 'var(--bg-card)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', letterSpacing: '1px', textTransform: 'uppercase' }}>
                  {dimLabels[dim]}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{
                    fontSize: 36,
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    color: dimColors[dim],
                    lineHeight: 1,
                  }}>
                    {(score * 100).toFixed(0)}%
                  </span>
                  {change !== undefined && change !== 0 && (
                    <span style={{
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      color: change > 0 ? 'var(--accent-success)' : 'var(--accent-danger)',
                    }}>
                      {change > 0 ? '+' : ''}{(change * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 技能标签云 */}
      {allSkills.length > 0 && (
        <div style={{
          padding: 16,
          borderRadius: 10,
          border: '1px solid var(--border-light)',
          background: 'var(--bg-card)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12, letterSpacing: '1px', textTransform: 'uppercase' }}>
            技能标签云
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {allSkills.map((skill, i) => {
              const opacity = 0.3 + (skill.score / 100) * 0.7
              const dimColorMap: Record<string, string> = {
                tech_skills: 'var(--accent-primary-rgb)',
                project_exp: 'var(--accent-primary-rgb)',
                academic_foundation: 'var(--accent-success-rgb)',
                domain_knowledge: 'var(--accent-warning-rgb)',
                soft_skill_evidence: 'var(--accent-primary-rgb)',
              }
              const rgb = dimColorMap[skill.dim] || 'var(--accent-primary-rgb)'
              return (
                <span
                  key={i}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    background: `rgba(${rgb},${opacity * 0.25})`,
                    border: `1px solid rgba(${rgb},${opacity * 0.4})`,
                  }}
                >
                  {skill.name}
                  <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    {skill.score}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* 学业基础与软技能证据详细展示板块 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 20,
        marginTop: 8,
      }}>
        {/* 学业基础板块 */}
        <div style={{
          padding: 20,
          borderRadius: 12,
          border: '1px solid var(--border-light)',
          background: 'var(--bg-card)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-light)', paddingBottom: 10 }}>
            <span style={{ fontSize: 18 }}>🎓</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px' }}>学业基础</span>
            {student?.academic_foundation?.normalized_score !== undefined && (
              <span style={{
                marginLeft: 'auto',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--accent-success)',
                background: 'rgba(var(--accent-success-rgb), 0.1)',
                padding: '2px 8px',
                borderRadius: 10
              }}>
                学业综合: {student.academic_foundation.normalized_score}分
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ background: 'var(--bg-hover)', padding: '10px 14px', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>绩点 GPA</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>
                {student?.academic_foundation?.gpa || '暂无数据'}
              </div>
            </div>
            <div style={{ background: 'var(--bg-hover)', padding: '10px 14px', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>排名</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>
                {student?.academic_foundation?.rank || '暂无数据'}
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 8 }}>核心课程成绩</div>
            {student?.academic_foundation?.core_courses && student.academic_foundation.core_courses.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {student.academic_foundation.core_courses.map((course, i) => (
                  <span key={i} style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    background: 'var(--bg-hover)',
                    border: '1px solid var(--border-light)',
                    color: 'var(--text-primary)',
                  }}>
                    {course.name}
                    <strong style={{ marginLeft: 6, color: 'var(--accent-success)' }}>{course.score}分</strong>
                  </span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>无明确核心课程数据</div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 8 }}>获奖与竞赛证书</div>
            {student?.academic_foundation?.awards && student.academic_foundation.awards.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                {student.academic_foundation.awards.map((award, i) => (
                  <li key={i}>{award}</li>
                ))}
              </ul>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>无明确奖项/证书数据</div>
            )}
          </div>
        </div>

        {/* 软技能证据板块 */}
        <div style={{
          padding: 20,
          borderRadius: 12,
          border: '1px solid var(--border-light)',
          background: 'var(--bg-card)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-light)', paddingBottom: 10 }}>
            <span style={{ fontSize: 18 }}>🤝</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px' }}>软技能证据支撑</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {['teamwork', 'communication', 'ownership'].map((key) => {
              const label = key === 'teamwork' ? '团队协作' : key === 'communication' ? '沟通表达' : '主动性'
              const data = student?.soft_skill_evidence?.[key]
              const level = data?.level || 'weak'
              const levelLabel = level === 'strong' ? '强' : level === 'medium' ? '中等' : '弱'
              const score = data?.normalized_score || 40
              const levelColor = level === 'strong' ? 'var(--accent-success)' : level === 'medium' ? 'var(--accent-warning)' : 'var(--accent-danger)'
              const levelBg = level === 'strong' ? 'rgba(var(--accent-success-rgb), 0.1)' : level === 'medium' ? 'rgba(var(--accent-warning-rgb), 0.1)' : 'rgba(var(--accent-danger-rgb), 0.1)'

              return (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: levelColor,
                      background: levelBg,
                      padding: '1px 6px',
                      borderRadius: 4,
                    }}>
                      {levelLabel} ({score}分)
                    </span>
                  </div>
                  {data?.evidence && data.evidence.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {data.evidence.map((ev, i) => (
                        <div key={i} style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--bg-hover)',
                          borderLeft: '2.5px solid var(--accent-primary)',
                          fontSize: 11.5,
                          lineHeight: 1.4,
                          color: 'var(--text-secondary)',
                        }}>
                          “{ev}”
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontStyle: 'italic', paddingLeft: 4 }}>
                      ⚠ 缺少简历中的实际事实或项目证据支撑
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ProfileTab
