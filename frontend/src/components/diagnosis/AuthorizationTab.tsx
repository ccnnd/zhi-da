import { useState, useEffect, useMemo } from 'react'
import { toast } from '../../utils/toast'
import {
  getStudentJobs,
  getStudentAuthorizations,
  createStudentAuthorization,
  deleteStudentAuthorization,
  batchCreateStudentAuthorization,
  getStudentJobDetail
} from '../../services/api'

interface AuthorizationTabProps {
  student: any
  diagnosisResult: any
}

export default function AuthorizationTab({ student, diagnosisResult }: AuthorizationTabProps) {
  const [jobs, setJobs] = useState<any[]>([])
  const [auths, setAuths] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [showOtherJobs, setShowOtherJobs] = useState(false)
  const [batchAuthorizing, setBatchAuthorizing] = useState(false)

  // 岗位详情展开
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [jobDetail, setJobDetail] = useState<any>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const toggleJobDetail = async (jobId: string) => {
    if (expandedJobId === jobId && jobDetail) {
      setExpandedJobId(null)
      return
    }
    setExpandedJobId(jobId)
    if (jobDetail && jobDetail.id === jobId) return
    setDetailLoading(true)
    setDetailError('')
    try {
      const data = await getStudentJobDetail(jobId)
      setJobDetail(data)
    } catch (err: any) {
      setDetailError(err?.message || '加载详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const loadData = async () => {
    setLoading(true)
    try {
      const jobsData = await getStudentJobs()
      setJobs(jobsData)

      if (student?.id) {
        const authsData = await getStudentAuthorizations(student.id)
        setAuths(authsData)
      }
    } catch (err) {
      console.error('Failed to load authorization data', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [student?.id])

  // 按诊断结果对岗位进行三级优先级分组
  const { targetJob, recommendedJobs, otherJobs } = useMemo(() => {
    if (!jobs.length || !diagnosisResult) {
      return { targetJob: null, recommendedJobs: [], otherJobs: jobs }
    }

    const top5Ids = new Set(
      (diagnosisResult.top5_jobs || []).map((j: any) => j.id || j.job_id)
    )
    const top5Titles = new Set(
      (diagnosisResult.top5_jobs || []).map((j: any) => j.title)
    )
    const targetTitle = diagnosisResult.top5_jobs?.[0]?.title || student?.target_job || ''

    let foundTarget: any = null
    const recommended: any[] = []
    const others: any[] = []

    for (const job of jobs) {
      // 第一优先：当前诊断目标岗位（top5_jobs[0] 或匹配 target_job）
      if (!foundTarget && (job.title === targetTitle || job.id === (diagnosisResult.top5_jobs?.[0]?.id || diagnosisResult.top5_jobs?.[0]?.job_id))) {
        foundTarget = job
        continue
      }
      // 第二优先：诊断推荐岗位（top5_jobs 中其余）
      if (top5Ids.has(job.id) || top5Ids.has(job.job_id) || top5Titles.has(job.title)) {
        recommended.push(job)
        continue
      }
      // 第三优先：其他可授权岗位
      others.push(job)
    }

    return { targetJob: foundTarget, recommendedJobs: recommended, otherJobs: others }
  }, [jobs, diagnosisResult, student])

  const handleAuthorize = async (job: any) => {
    if (!student?.id || !diagnosisResult?.id) return
    const confirmed = window.confirm(
      `确认将 V${diagnosisResult.version} 版本诊断画像授权给「${job.enterprise_name}」的「${job.title}」岗位？\n\n` +
      `授权内容包括：五维能力评分、技能标签、匹配度分析、成长建议。\n` +
      `企业将在该岗位下看到你的最新诊断画像数据。\n` +
      `后续复评后，企业端将自动同步查看最新版本画像。`
    )
    if (!confirmed) return
    setActionId(job.id)
    try {
      await createStudentAuthorization({
        student_id: student.id,
        job_post_id: job.id,
        diagnosis_id: diagnosisResult.id
      })
      await loadData()
    } catch (err: any) {
      toast.error(`授权失败: ${err.message || err}`)
    } finally {
      setActionId(null)
    }
  }

  const handleRevoke = async (auth: any) => {
    // 撤销不可逆（企业可能已查看），需二次确认
    const ok = window.confirm(`撤销后「${auth.job_title || '该岗位'}」的企业将无法再查看你的能力画像，确认撤销授权？`)
    if (!ok) return
    setActionId(auth.id)
    try {
      await deleteStudentAuthorization(auth.id)
      await loadData()
      toast.success('已撤销授权')
    } catch (err: any) {
      toast.error(`撤销授权失败: ${err.message || err}`)
    } finally {
      setActionId(null)
    }
  }

  // 一键批量授权：授权当前诊断目标岗位 + 所有推荐岗位（Gap 6）
  const handleBatchAuthorize = async () => {
    if (!student?.id || !diagnosisResult?.id) return

    // 收集待授权的岗位：目标岗位 + 推荐岗位（去重）
    const jobsToAuth: any[] = []
    const seenIds = new Set<string>()
    if (targetJob && !seenIds.has(targetJob.id)) {
      jobsToAuth.push(targetJob)
      seenIds.add(targetJob.id)
    }
    for (const job of recommendedJobs) {
      if (!seenIds.has(job.id)) {
        jobsToAuth.push(job)
        seenIds.add(job.id)
      }
    }
    // 过滤已授权的岗位
    const activeJobTitles = new Set(auths.filter(a => a.status === 'active').map(a => a.job_title))
    const pendingJobs = jobsToAuth.filter(j => !activeJobTitles.has(j.title))

    if (pendingJobs.length === 0) {
      toast.error('所有推荐岗位均已授权，无需重复操作')
      return
    }

    const confirmed = window.confirm(
      `确认将 V${diagnosisResult.version} 版本诊断画像一键授权给以下 ${pendingJobs.length} 个岗位？\n\n` +
      pendingJobs.map((j, i) => `  ${i + 1}. ${j.enterprise_name} — ${j.title}`).join('\n') +
      `\n\n授权内容包括：五维能力评分、技能标签、匹配度分析、成长建议。\n` +
      `后续复评后，企业端将自动同步查看最新版本画像。`
    )
    if (!confirmed) return

    setBatchAuthorizing(true)
    try {
      const result = await batchCreateStudentAuthorization({
        student_id: student.id,
        job_post_ids: pendingJobs.map(j => j.id),
        diagnosis_id: diagnosisResult.id
      })
      const successCount = result.created + result.updated
      if (result.failed > 0) {
        toast.error(`批量授权完成：${successCount} 个成功，${result.failed} 个失败`)
      } else {
        toast.success(`✓ 一键授权成功！已将画像授权给 ${successCount} 个岗位`)
      }
      await loadData()
    } catch (err: any) {
      toast.error(`批量授权失败: ${err.message || err}`)
    } finally {
      setBatchAuthorizing(false)
    }
  }

  // 单个岗位卡片渲染
  const renderJobCard = (job: any, tier: 'target' | 'recommended' | 'other') => {
    const currentAuth = auths.find(a => a.job_title === job.title && a.enterprise_name === job.enterprise_name)
    const isAuthActive = currentAuth?.status === 'active'
    const isExpanded = expandedJobId === job.id

    const borderStyle = tier === 'target'
      ? '2px solid var(--accent-primary)'
      : isAuthActive
        ? '1px solid var(--accent-primary)'
        : '1px solid var(--border-light)'

    const bgStyle = tier === 'target'
      ? 'rgba(var(--accent-primary-rgb), 0.04)'
      : isAuthActive
        ? 'rgba(var(--accent-primary-rgb), 0.02)'
        : 'transparent'

    return (
      <div key={job.id} style={{
        border: isExpanded ? '1px solid var(--accent-primary)' : borderStyle,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: bgStyle,
        position: 'relative',
        transition: 'border-color 0.2s ease',
      }}>
        {tier === 'target' && (
          <div style={{
            position: 'absolute',
            top: -10,
            left: 16,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 10px',
            borderRadius: 8,
            background: 'var(--accent-primary)',
            color: '#fff',
            letterSpacing: 0.5,
          }}>
            当前诊断目标岗位
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{job.title}</div>
            <div style={{ fontSize: 12, color: 'var(--accent-primary)', fontWeight: 600, marginTop: 4 }}>
              {job.enterprise_name} | {job.category}
            </div>
          </div>

          {isAuthActive ? (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: 'rgba(var(--accent-primary-rgb), 0.15)', color: 'var(--accent-primary)', fontWeight: 600 }}>
              已授权 V{currentAuth?.diagnosis_version || diagnosisResult?.version}
            </span>
          ) : (
            <button
              onClick={() => handleAuthorize(job)}
              disabled={actionId === job.id}
              className="btn btn-primary"
              style={{ padding: '6px 12px', fontSize: 12, background: 'var(--accent-primary)' }}
            >
              {actionId === job.id ? '授权中...' : '授权画像'}
            </button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {job.description || '暂无描述信息'}
        </div>

        {/* 查看详情 */}
        <div
          onClick={(e) => { e.stopPropagation(); toggleJobDetail(job.id) }}
          style={{
            fontSize: 11, color: 'var(--accent-primary)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center',
            borderTop: '1px solid var(--border-light)', paddingTop: 8, marginTop: 2,
          }}
        >
          {isExpanded ? '收起详情 ▲' : '查看岗位详情 ▼'}
        </div>

        {/* 展开详情区 */}
        {isExpanded && (
          <div style={{ marginTop: 4, padding: 14, background: 'var(--bg-hover)', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }} onClick={e => e.stopPropagation()}>
            {detailLoading && <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: 16 }}>加载中...</div>}
            {detailError && <div style={{ color: 'var(--accent-danger)', padding: 8 }}>{detailError}</div>}
            {jobDetail && jobDetail.id === job.id && (
              <>
                {/* 岗位关键词 */}
                {jobDetail.ability_model?.tech_skills && Object.keys(jobDetail.ability_model.tech_skills).length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, letterSpacing: '0.5px', fontWeight: 600 }}>岗位关键词</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Object.entries(jobDetail.ability_model.tech_skills).map(([k, v]: any) => (
                        <span key={k} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, background: 'var(--bg-card)', border: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>{k}{v ? ` ${v}` : ''}</span>
                      ))}
                      {jobDetail.ability_model.domain_knowledge && Object.entries(jobDetail.ability_model.domain_knowledge).map(([k]: any) => (
                        <span key={k} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, background: 'var(--bg-card)', border: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>{k}</span>
                      ))}
                    </div>
                  </div>
                )}
                {/* 岗位职责 */}
                {jobDetail.description && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, letterSpacing: '0.5px', fontWeight: 600 }}>岗位职责</div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>{jobDetail.description}</div>
                  </div>
                )}
                {/* 岗位要求 */}
                {jobDetail.requirements_text && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, letterSpacing: '0.5px', fontWeight: 600 }}>岗位要求</div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>{jobDetail.requirements_text}</div>
                  </div>
                )}
                {/* 企业信息 */}
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, letterSpacing: '0.5px', fontWeight: 600 }}>企业</div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{jobDetail.enterprise_name}{jobDetail.enterprise_industry && <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 6 }}>· {jobDetail.enterprise_industry}</span>}</div>
                  {jobDetail.enterprise_description && <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{jobDetail.enterprise_description.slice(0, 150)}{jobDetail.enterprise_description.length > 150 ? '…' : ''}</div>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  if (!diagnosisResult) {
    return (
      <div className="glass-panel" style={{
        padding: 40,
        borderRadius: 16,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        textAlign: 'center',
        color: 'var(--text-secondary)'
      }}>
        <span style={{ fontSize: 40, marginBottom: 16, display: 'block' }}>⚠️</span>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>请先完成 AI 职业诊断</h3>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 8 }}>
          进行简历上传并完成职业能力测评后，才可以向入驻企业进行双选精准授权。
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* 诊断版本概览 */}
      <div className="glass-panel" style={{
        padding: '20px 24px',
        borderRadius: 12,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 16
      }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>当前诊断版本</span>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>
            V{diagnosisResult.version}（目标：{diagnosisResult.top5_jobs?.[0]?.title || student.target_job}）
          </div>
        </div>
        <div>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>核心匹配得分</span>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent-primary)', marginTop: 2 }}>
            {Math.round(diagnosisResult.match_score * 100)}分
          </div>
        </div>
        <div>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>已授权岗位数</span>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent-primary)', marginTop: 2 }}>
            {auths.filter(a => a.status === 'active').length}个
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 28 }}>
        {/* 左栏：按优先级分组展示岗位 */}
        <div className="glass-panel" style={{
          padding: 24,
          borderRadius: 16,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>可投递/授权的企业招聘岗位</h3>

          {/* Gap 6: 一键批量授权按钮 */}
          {diagnosisResult && jobs.length > 0 && (() => {
            const activeTitles = new Set(auths.filter(a => a.status === 'active').map(a => a.job_title))
            const batchCandidates = [targetJob, ...recommendedJobs].filter(Boolean).filter(j => !activeTitles.has(j.title))
            if (batchCandidates.length <= 1) return null
            return (
              <button
                onClick={handleBatchAuthorize}
                disabled={batchAuthorizing}
                className="btn btn-primary"
                style={{
                  width: '100%',
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  background: 'linear-gradient(135deg, var(--accent-primary), #5a6fff)',
                  border: 'none',
                  borderRadius: 10,
                  color: '#fff',
                  cursor: batchAuthorizing ? 'wait' : 'pointer',
                  opacity: batchAuthorizing ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                {batchAuthorizing ? '⏳' : '⚡'} {batchAuthorizing ? '批量授权中...' : `一键授权全部推荐岗位（${batchCandidates.length}个）`}
              </button>
            )
          })()}

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>获取岗位中...</div>
          ) : jobs.length === 0 ? (
            <div style={{ padding: 30, border: '1px dashed var(--border-light)', borderRadius: 10, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              学校双选网络暂无审核通过的企业在招岗位。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '520px', overflowY: 'auto' }}>
              {/* 第一优先：当前诊断目标岗位 */}
              {targetJob && renderJobCard(targetJob, 'target')}

              {/* 第二优先：诊断推荐岗位 */}
              {recommendedJobs.length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: targetJob ? 4 : 0 }}>
                    诊断推荐岗位（{recommendedJobs.length}）
                  </div>
                  {recommendedJobs.map(job => renderJobCard(job, 'recommended'))}
                </>
              )}

              {/* 第三优先：其他可授权岗位（折叠） */}
              {otherJobs.length > 0 && (
                <>
                  <button
                    onClick={() => setShowOtherJobs(!showOtherJobs)}
                    style={{
                      background: 'none',
                      border: '1px dashed var(--border-light)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    {showOtherJobs ? '收起' : '展开'}其他可授权岗位（{otherJobs.length}）
                    <span style={{ transform: showOtherJobs ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▾</span>
                  </button>
                  {showOtherJobs && otherJobs.map(job => renderJobCard(job, 'other'))}
                </>
              )}
            </div>
          )}
        </div>

        {/* 右栏：已授权记录 */}
        <div className="glass-panel" style={{
          padding: 24,
          borderRadius: 16,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>已授权简历与诊断记录</h3>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>获取记录中...</div>
          ) : auths.length === 0 ? (
            <div style={{ padding: 30, border: '1px dashed var(--border-light)', borderRadius: 10, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              您尚未对任何岗位进行数据授权。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '520px', overflowY: 'auto' }}>
              {auths.map((auth) => (
                <div key={auth.id} style={{
                  border: '1px solid var(--border-light)',
                  borderRadius: 10,
                  padding: 14,
                  fontSize: 12
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{auth.job_title}</span>
                    <span style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: 6,
                      background: auth.status === 'active' ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'rgba(128,128,128,0.12)',
                      color: auth.status === 'active' ? 'var(--accent-primary)' : 'var(--text-secondary)'
                    }}>
                      {auth.status === 'active' ? '已授权' : '已撤销'}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>意向企业：{auth.enterprise_name}</div>
                  <div style={{ color: 'var(--text-tertiary)', marginTop: 2 }}>
                    绑定诊断版本：V{auth.diagnosis_version}（匹配分: {Math.round(auth.match_score * 100)}%）
                  </div>

                  {auth.status === 'active' && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                      <button
                        onClick={() => handleRevoke(auth)}
                        disabled={actionId === auth.id}
                        className="btn btn-ghost"
                        style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--accent-danger)', color: 'var(--accent-danger)' }}
                      >
                        {actionId === auth.id ? '撤销中...' : '撤销授权'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
