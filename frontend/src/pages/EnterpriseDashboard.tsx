import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'

const ReactECharts = React.lazy(() => import('echarts-for-react'))
import { FileText, Users, Building2, Sparkles } from 'lucide-react'
import ThemeToggle from '../components/shared/ThemeToggle'
import { toast } from '../utils/toast'
import {
  getEnterpriseProfile,
  updateEnterpriseProfile,
  getEnterpriseJobs,
  createEnterpriseJob,
  getEnterpriseJobDetail,
  updateEnterpriseJob,
  parseJobAbilityModel,
  submitJobReview,
  getEnterpriseCandidates,
  getEnterpriseCandidateDetail,
  getAttachmentDownloadUrl,
  clearAuth,
} from '../services/api'

interface JobPost {
  id: string
  enterprise_id: string
  title: string
  category: string
  description: string
  requirements_text: string
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'disabled'
  review_reason?: string
  created_at: string
}

interface AbilityModel {
  tech_skills: Record<string, number>
  soft_skills: Record<string, number>
  domain_knowledge: Record<string, number>
  project_exp: Array<{ name: string; description: string }>
  weight_config: {
    tech_skills: number
    project_exp?: number
    academic_foundation?: number
    domain_knowledge: number
    soft_skill_evidence?: number
    soft_skills?: number
  }
}

export default function EnterpriseDashboard() {
  const { theme, currentEnterpriseId } = useAppStore()
  const navigate = useNavigate()
  const enterpriseId = currentEnterpriseId || '1'
  const [activeTab, setActiveTab] = useState<'jobs' | 'candidates_for_job'>('jobs')
  const [accessDenied, setAccessDenied] = useState(false)

  // 检测 403 角色错配：当前 token 不是 enterprise 角色时，清除企业会话并跳回首页
  const handleApiError = (err: any) => {
    const status = err?.response?.status
    const detail: string = err?.response?.data?.detail || ''
    if (status === 403 && (detail.includes('需要企业身份') || detail.includes('需要') )) {
      setAccessDenied(true)
      localStorage.removeItem('zhida_enterprise_id')
      toast.error(detail || '当前账号无企业权限，请重新登录')
      setTimeout(() => navigate('/'), 800)
    }
  }

  // Theme states
  const isDark = theme === 'dark'

  // Profile states
  const [profile, setProfile] = useState<any>(null)
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const [profileForm, setProfileForm] = useState({
    name: '',
    industry: '',
    description: '',
    contact_name: '',
    contact_email: ''
  })
  const [profileLoading, setProfileLoading] = useState(false)

  // Jobs states
  const [jobs, setJobs] = useState<JobPost[]>([])
  const [selectedJob, setSelectedJob] = useState<JobPost | null>(null)
  const [selectedJobModel, setSelectedJobModel] = useState<AbilityModel | null>(null)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  // Job edit form states
  const [isEditingJob, setIsEditingJob] = useState(false)
  const [isCreatingJob, setIsCreatingJob] = useState(false)
  const [jobForm, setJobForm] = useState({
    title: '',
    category: '',
    description: '',
    requirements_text: ''
  })

  // Action loading states
  const [parsingJobId, setParsingJobId] = useState<string | null>(null)
  const [submittingJobId, setSubmittingJobId] = useState<string | null>(null)

  // Candidates states
  const [candidates, setCandidates] = useState<any[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<any | null>(null)
  const [candDetailLoading, setCandDetailLoading] = useState(false)
  const [showCandModal, setShowCandModal] = useState(false)
  const [candidatesJobId, setCandidatesJobId] = useState<string>('')
  const [candidatesJobTitle, setCandidatesJobTitle] = useState<string>('')
  const [jobMatchStats, setJobMatchStats] = useState<any[]>([])  // Gap 3: per-job potential match counts

  // Load profile
  const loadProfile = async () => {
    setProfileLoading(true)
    try {
      const data = await getEnterpriseProfile(enterpriseId)
      setProfile(data)
      setProfileForm({
        name: data.name || '',
        industry: data.industry || '',
        description: data.description || '',
        contact_name: data.contact_name || '',
        contact_email: data.contact_email || ''
      })
    } catch (err) {
      console.error('Failed to load profile', err)
    } finally {
      setProfileLoading(false)
    }
  }

  // Load jobs list
  const loadJobs = async (selectId?: string, silent?: boolean) => {
    if (accessDenied) return
    if (!silent) setJobsLoading(true)
    try {
      const data = await getEnterpriseJobs(enterpriseId)
      setJobs(data)
      if (data.length > 0) {
        const toSelect = selectId ? data.find((j: any) => j.id === selectId) : data[0]
        if (toSelect) {
          handleSelectJob(toSelect)
        }
      } else {
        setSelectedJob(null)
        setSelectedJobModel(null)
      }
    } catch (err) {
      console.error('Failed to load jobs', err)
      handleApiError(err)
    } finally {
      setJobsLoading(false)
    }
  }

  // Load candidate list (Gap 3: now returns { candidates, job_match_stats })
  const loadCandidates = async (jobId?: string, silent?: boolean) => {
    if (accessDenied) return
    if (!silent) setCandidatesLoading(true)
    try {
      const data = await getEnterpriseCandidates(enterpriseId)
      // Handle new format: { candidates, job_match_stats } or legacy flat array
      const candidateList = Array.isArray(data) ? data : (data.candidates || [])
      const stats = Array.isArray(data) ? [] : (data.job_match_stats || [])
      setJobMatchStats(stats)
      // 如果指定了 jobId，过滤为该岗位的候选人
      setCandidates(jobId ? candidateList.filter((c: any) => c.job_post_id === jobId) : candidateList)
    } catch (err) {
      console.error('Failed to load candidates', err)
      handleApiError(err)
    } finally {
      setCandidatesLoading(false)
    }
  }

  // 从岗位列表进入某岗位的候选人视图
  const handleViewJobCandidates = (jobId: string, jobTitle: string) => {
    setCandidatesJobId(jobId)
    setCandidatesJobTitle(jobTitle)
    setActiveTab('candidates_for_job')
    loadCandidates(jobId)
  }

  // Effect to load data on tab change or tenant identity swap
  useEffect(() => {
    if (activeTab === 'jobs') {
      loadJobs()
      // Gap 3: also load match stats to show potential-match badges on jobs
      loadCandidates()
    } else if (activeTab === 'candidates_for_job') {
      loadCandidates(candidatesJobId)
    }
  }, [activeTab, enterpriseId])

  // 定时轮询：每 10 秒静默刷新候选人数据，实时同步学生端授权变更
  useEffect(() => {
    if (accessDenied) return  // 权限被拒绝时不轮询
    const interval = setInterval(() => {
      if (activeTab === 'jobs') {
        loadJobs(undefined, true)
        loadCandidates(undefined, true)
      } else if (activeTab === 'candidates_for_job') {
        loadCandidates(candidatesJobId, true)
      }
    }, 10000)
    return () => clearInterval(interval)
  }, [activeTab, enterpriseId, candidatesJobId, accessDenied])

  // Select job item and fetch ability model
  const handleSelectJob = async (job: JobPost) => {
    setSelectedJob(job)
    setIsEditingJob(false)
    setIsCreatingJob(false)
    setDetailLoading(true)
    try {
      const res = await getEnterpriseJobDetail(job.id, enterpriseId)
      setSelectedJobModel(res.ability_model)
    } catch (err) {
      console.error('Failed to load job details', err)
      setSelectedJobModel(null)
    } finally {
      setDetailLoading(false)
    }
  }

  // Profile save
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setProfileLoading(true)
    try {
      const updated = await updateEnterpriseProfile(enterpriseId, profileForm)
      setProfile(updated)
      setIsEditingProfile(false)
    } catch (err) {
      toast.error('更新企业资料失败')
    } finally {
      setProfileLoading(false)
    }
  }

  // Job creation trigger
  const handleStartCreateJob = () => {
    setIsCreatingJob(true)
    setIsEditingJob(false)
    setSelectedJob(null)
    setSelectedJobModel(null)
    setJobForm({
      title: '',
      category: '后端开发',
      description: '',
      requirements_text: ''
    })
  }

  // Job edit trigger
  const handleStartEditJob = () => {
    if (!selectedJob) return
    setIsEditingJob(true)
    setIsCreatingJob(false)
    setJobForm({
      title: selectedJob.title || '',
      category: selectedJob.category || '',
      description: selectedJob.description || '',
      requirements_text: selectedJob.requirements_text || ''
    })
  }

  // Job save
  const handleSaveJob = async (e: React.FormEvent) => {
    e.preventDefault()
    setJobsLoading(true)
    try {
      if (isCreatingJob) {
        const newJob = await createEnterpriseJob(enterpriseId, {
          ...jobForm,
          status: 'draft' // default to draft, require AI parsing before submission
        })
        setIsCreatingJob(false)
        await loadJobs(newJob.id)
      } else if (isEditingJob && selectedJob) {
        const updated = await updateEnterpriseJob(selectedJob.id, enterpriseId, {
          ...jobForm,
          status: selectedJob.status === 'rejected' ? 'draft' : selectedJob.status
        })
        setIsEditingJob(false)
        await loadJobs(updated.id)
      }
    } catch (err: any) {
      handleApiError(err)
      if (!accessDenied) toast.error('保存岗位失败')
    } finally {
      setJobsLoading(false)
    }
  }

  // 岗位上线/下线（已审核通过岗位的招聘状态管理，不经过审核）
  const handleToggleJobOnline = async () => {
    if (!selectedJob) return
    const goingOffline = selectedJob.status === 'approved'
    const ok = window.confirm(goingOffline
      ? `下线「${selectedJob.title}」后，学生将无法再看到该岗位，已授权候选人不受影响。确认下线？`
      : `重新上线「${selectedJob.title}」，学生将再次看到该岗位。确认上线？`)
    if (!ok) return
    setJobsLoading(true)
    try {
      const updated = await updateEnterpriseJob(selectedJob.id, enterpriseId, {
        status: goingOffline ? 'disabled' : 'approved',
      })
      await loadJobs(updated.id)
      toast.success(goingOffline ? '岗位已下线' : '岗位已重新上线')
    } catch (err: any) {
      toast.error(goingOffline ? '下线失败' : '上线失败')
    } finally {
      setJobsLoading(false)
    }
  }

  // AI JD Modeling
  const handleParseAbilityModel = async (jobId: string) => {
    setParsingJobId(jobId)
    try {
      const model = await parseJobAbilityModel(jobId, enterpriseId)
      setSelectedJobModel(model)
      toast.success('AI 岗位能力模型解析成功！已更新雷达矩阵指标。')
    } catch (err: any) {
      toast.error(`AI 解析失败: ${err.message || err}`)
    } finally {
      setParsingJobId(null)
    }
  }

  // Submit job for review
  const handleSubmitReview = async (jobId: string) => {
    setSubmittingJobId(jobId)
    try {
      const updated = await submitJobReview(jobId, enterpriseId)
      setSelectedJob(updated)
      // refresh jobs list to show status updates
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'pending_review' } : j))
      toast.success('岗位已成功提交学校管理员审核！')
    } catch (err: any) {
      toast.error(`提交审核失败: ${err.message || err}`)
    } finally {
      setSubmittingJobId(null)
    }
  }

  // View candidate details and render double radar charts
  const handleViewCandidate = async (candidate: any) => {
    setCandDetailLoading(true)
    try {
      const detail = await getEnterpriseCandidateDetail(candidate.student_id, candidate.auth_id, enterpriseId)
      setSelectedCandidate(detail)
      setShowCandModal(true)
    } catch (err) {
      toast.error('获取候选人详细画像失败')
    } finally {
      setCandDetailLoading(false)
    }
  }

  // Generate ECharts option for student-vs-job double line radar chart
  const getDoubleRadarOption = () => {
    if (!selectedCandidate) return {}

    const jobAbility = selectedCandidate.diagnosis.ai_reasoning?.job_ability_model || selectedCandidate.diagnosis.ai_reasoning?.ability_model || {}
    const studentSkills = selectedCandidate.student
    const diag = selectedCandidate.diagnosis

    // Merge skills from job model to form indicators
    const reqTech = jobAbility.tech_skills || {}
    const reqSoft = jobAbility.soft_skills || {}
    const reqDomain = jobAbility.domain_knowledge || {}

    // Fallback if no specific model targets, use standard 5 dimensions
    const indicatorList = [
      ...Object.keys(reqTech).map(k => ({ name: k, max: 100, category: 'tech', val: reqTech[k] })),
      ...Object.keys(reqSoft).map(k => ({ name: k, max: 100, category: 'soft', val: reqSoft[k] })),
      ...Object.keys(reqDomain).map(k => ({ name: k, max: 100, category: 'domain', val: reqDomain[k] })),
    ]

    if (indicatorList.length === 0) {
      const dimScores = diag.dimension_scores || {}
      const getVal = (val: any) => {
        if (typeof val !== 'number') return 0
        return val <= 1 ? Math.round(val * 100) : Math.round(val)
      }
      return {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item' },
        legend: { data: ['学生画像'], bottom: 0, textStyle: { color: isDark ? '#a0a5b5' : '#6e6e73' } },
        radar: {
          indicator: [
            { name: '技术技能', max: 100 },
            { name: '项目经验', max: 100 },
            { name: '学业基础', max: 100 },
            { name: '领域认知', max: 100 },
            { name: '软技能证据', max: 100 }
          ],
          splitArea: { show: false }
        },
        series: [{
          type: 'radar',
          data: [{
            value: [
              getVal(dimScores.tech_skills ?? dimScores.tech),
              getVal(dimScores.project_exp ?? dimScores.project),
              getVal(dimScores.academic_foundation ?? dimScores.academic),
              getVal(dimScores.domain_knowledge ?? dimScores.domain),
              getVal(dimScores.soft_skill_evidence ?? dimScores.soft_evidence)
            ],
            name: '学生画像',
            areaStyle: { color: 'rgba(var(--accent-primary-rgb), 0.3)' },
            lineStyle: { color: 'var(--accent-primary)' }
          }]
        }]
      }
    }

    // Limit to top 6-8 indicators to avoid messy chart
    const indicators = indicatorList.slice(0, 8)

    // Map student's score for each indicator
    const studentValues = indicators.map(ind => {
      let score = 0
      const name = ind.name.toLowerCase()
      if (ind.category === 'tech') {
        const studentTech = diag.ai_reasoning?.student_profile?.tech_skills || studentSkills.tech_skills || {}
        const matchKey = Object.keys(studentTech).find(k => k.toLowerCase() === name)
        score = matchKey ? studentTech[matchKey] : 0
      } else if (ind.category === 'soft') {
        const studentSoft = diag.ai_reasoning?.student_profile?.soft_skills || studentSkills.soft_skills || {}
        const matchKey = Object.keys(studentSoft).find(k => k.toLowerCase() === name)
        score = matchKey ? studentSoft[matchKey] : 0
      } else {
        const studentDomain = diag.ai_reasoning?.student_profile?.domain_knowledge || studentSkills.domain_knowledge || {}
        const matchKey = Object.keys(studentDomain).find(k => k.toLowerCase() === name)
        score = matchKey ? studentDomain[matchKey] : 0
      }
      return score || 0
    })

    const jobValues = indicators.map(ind => ind.val)

    return {
      color: ['var(--accent-primary)', 'var(--accent-primary)'],
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: isDark ? 'rgba(22, 24, 29, 0.95)' : 'rgba(248, 247, 244, 0.95)',
        borderColor: isDark ? '#2c2f3a' : '#e5e5ea',
        textStyle: { color: isDark ? '#f5f6f9' : '#1d1d1f', fontSize: 13 },
      },
      legend: {
        data: ['学生掌握能力', '岗位特征要求'],
        bottom: 0,
        textStyle: { color: isDark ? '#a0a5b5' : '#6e6e73', fontSize: 12 }
      },
      radar: {
        center: ['50%', '45%'],
        radius: '60%',
        indicator: indicators.map(i => ({ name: i.name, max: 100 })),
        axisName: {
          color: isDark ? '#a0a5b5' : '#6e6e73',
          fontSize: 11,
          borderRadius: 3,
          padding: [2, 4],
        },
        splitArea: {
          areaStyle: {
            color: isDark
              ? ['rgba(255, 255, 255, 0.01)', 'rgba(255, 255, 255, 0.02)']
              : ['rgba(0, 0, 0, 0.02)', 'rgba(0, 0, 0, 0.005)']
          }
        },
        splitLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } },
        axisLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } }
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              value: studentValues,
              name: '学生掌握能力',
              symbol: 'circle',
              symbolSize: 5,
              areaStyle: { color: 'rgba(var(--accent-primary-rgb), 0.25)' },
              lineStyle: { width: 2 }
            },
            {
              value: jobValues,
              name: '岗位特征要求',
              symbol: 'none',
              lineStyle: { type: 'dashed', width: 1.5 },
              areaStyle: { color: 'rgba(var(--accent-primary-rgb), 0.08)' }
            }
          ]
        }
      ]
    }
  }

  // Generate ECharts option for Gap analysis bar chart
  const getGapBarOption = () => {
    if (!selectedCandidate) return {}

    const gaps = selectedCandidate.diagnosis.gap_details || []
    if (gaps.length === 0) return {}

    // 维度中英文映射
    const dimLabelMap: Record<string, string> = {
      tech_skills: '技术技能',
      project_exp: '项目经验',
      academic_foundation: '学业基础',
      domain_knowledge: '领域认知',
      soft_skill_evidence: '软技能',
      tech: '技术能力',
      project: '项目经验',
      academic: '学业基础',
      domain: '领域知识',
      soft: '软技能',
    }

    // Sort gaps to show largest gaps first
    const sortedGaps = [...gaps].slice(0, 6).reverse()

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: isDark ? 'rgba(22, 24, 29, 0.95)' : 'rgba(248, 247, 244, 0.95)',
        borderColor: isDark ? '#2c2f3a' : '#e5e5ea',
        textStyle: { color: isDark ? '#f5f6f9' : '#1d1d1f' },
        formatter: (params: any) => {
          const item = Array.isArray(params) ? params[0] : params
          if (!item) return ''
          const sign = item.value > 0 ? '+' : ''
          return `能力项: <b>${item.name}</b><br/>差距值: <b style="color:${item.value >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)'}">${sign}${item.value}</b>`
        }
      },
      grid: {
        left: '3%',
        right: '8%',
        bottom: '3%',
        top: '5%',
        containLabel: true
      },
      xAxis: {
        type: 'value',
        max: 100,
        min: -100,
        name: '差距值',
        nameTextStyle: { color: isDark ? '#a0a5b5' : '#6e6e73', fontSize: 11 },
        splitLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } },
        axisLabel: { color: isDark ? '#a0a5b5' : '#6e6e73' }
      },
      yAxis: {
        type: 'category',
        data: sortedGaps.map((g: any) => {
          const skillName = g.skill_name || g.name || g.skill || ''
          if (skillName) return skillName
          const dim = g.dimension || ''
          return dimLabelMap[dim] || dim
        }),
        axisLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } },
        axisLabel: { color: isDark ? '#a0a5b5' : '#6e6e73', fontSize: 11 }
      },
      series: [
        {
          name: '能力差距',
          type: 'bar',
          data: sortedGaps.map((g: any) => {
            const val = g.gap ?? (g.student_score !== undefined && g.required_score !== undefined ? g.student_score - g.required_score : 0)
            return {
              value: val,
              itemStyle: {
                color: val >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)',
                borderRadius: [0, 4, 4, 0]
              }
            }
          }),
          label: {
            show: true,
            position: 'inside',
            formatter: (params: any) => (params.value > 0 ? `+${params.value}` : params.value)
          }
        }
      ]
    }
  }

  return (
    <>
      <style>{`
        .ed-job-item {
          padding: var(--space-md) var(--space-lg);
          border-bottom: 1px solid var(--border-light);
          cursor: pointer;
          transition: background 0.2s, border-color 0.2s;
          border-left: 3px solid transparent;
        }
        .ed-job-item:hover {
          background: var(--bg-hover);
        }
        .ed-job-item.active {
          background: var(--bg-hover);
          border-left-color: var(--accent-primary);
        }
        .ed-job-item.active .ed-job-title {
          color: var(--accent-primary);
        }
        .ed-job-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ed-close-btn {
          background: transparent;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: var(--text-secondary);
          transition: color 0.15s;
        }
        .ed-close-btn:hover {
          color: var(--text-primary);
        }
        .ed-progress-track {
          height: 4px;
          width: 100%;
          background: var(--bg-hover);
          border-radius: var(--radius-sm);
        }
        .ed-progress-fill-teal {
          height: 100%;
          background: var(--accent-teal);
          border-radius: var(--radius-sm);
          transition: width 0.3s ease;
        }
        .ed-progress-fill-blue {
          height: 100%;
          background: var(--accent-primary);
          border-radius: var(--radius-sm);
          transition: width 0.3s ease;
        }
        .ed-rejected-banner {
          background: rgba(var(--accent-danger-rgb), 0.08);
          border: 1px solid rgba(var(--accent-danger-rgb), 0.2);
          padding: var(--space-sm) var(--space-md);
          border-radius: var(--radius-sm);
          color: var(--accent-danger);
          font-size: 13px;
        }
        .ed-jd-pre {
          padding: var(--space-md);
          border-radius: var(--radius-sm);
          background: var(--bg-hover);
          border: 1px solid var(--border-light);
          font-size: 12px;
          line-height: 1.5;
          white-space: pre-wrap;
          font-family: var(--font-mono);
          color: var(--text-primary);
          max-height: 280px;
          overflow-y: auto;
        }
        .ed-evidence-quote {
          padding: var(--space-xs) var(--space-sm);
          border-radius: var(--radius-xs);
          background: var(--bg-card);
          font-size: 11px;
          line-height: 1.3;
          color: var(--text-secondary);
          border-left: 2px solid var(--accent-primary);
        }
        .ed-risk-card {
          padding: var(--space-lg);
          border-radius: var(--radius-md);
        }
        .ed-risk-card-danger {
          border: 1px solid rgba(var(--accent-danger-rgb), 0.3);
          background: rgba(var(--accent-danger-rgb), 0.04);
        }
        .ed-risk-card-safe {
          border: 1px solid rgba(var(--accent-success-rgb), 0.3);
          background: rgba(var(--accent-success-rgb), 0.04);
        }
        .ed-soft-level {
          font-size: 9.5px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 3px;
        }
        .ed-contact-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--space-lg);
          background: var(--bg-hover);
          padding: var(--space-md);
          border-radius: var(--radius-sm);
        }
        .ed-weight-grid {
          background: var(--bg-hover);
          padding: var(--space-sm);
          border-radius: var(--radius-sm);
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: var(--space-sm);
          font-size: 11px;
        }
        .ed-soft-jd-grid {
          display: grid;
          grid-template-columns: 1fr 1.2fr;
          gap: var(--space-sm);
          background: var(--bg-hover);
          padding: var(--space-sm);
          border-radius: var(--radius-sm);
          font-size: 11px;
        }
        .ed-actions-footer {
          padding: var(--space-md) var(--space-xl);
          border-top: 1px solid var(--border-light);
          background: var(--bg-hover);
          display: flex;
          justify-content: flex-end;
          gap: var(--space-sm);
        }
        .ed-course-tag {
          padding: 2px 8px;
          border-radius: var(--radius-xs);
          font-size: 11px;
          background: var(--bg-card);
          border: 1px solid var(--border-light);
          color: var(--text-primary);
        }
        .ed-project-card {
          border: 1px solid var(--border-light);
          padding: var(--space-sm);
          border-radius: var(--radius-sm);
          font-size: 12px;
        }
        .ed-ai-card {
          border: 1px solid var(--accent-primary);
          background: rgba(var(--accent-primary-rgb), 0.05);
          padding: var(--space-lg);
          border-radius: var(--radius-md);
        }
        .ed-bg-section {
          background: var(--bg-hover);
          padding: var(--space-lg);
          border-radius: var(--radius-md);
        }
      `}</style>

      <div className="bento-dashboard">
        {/* Topbar */}
        <div className="bento-topbar">
          <div className="bento-topbar-brand">
            <button className="brand-link" onClick={() => navigate('/')}>
              <span className="brand-link-mark"><Sparkles size={14} /></span>
              职达
            </button>
            <span className="brand-divider" />
            <Building2 size={20} />
            <span>企业工作台</span>
            <span className="tag tag-blue" style={{ marginLeft: 'var(--space-sm)' }}>
              {profile?.name || (profileLoading ? '加载中...' : '企业')}
            </span>
          </div>
          <div className="bento-topbar-actions">
            <ThemeToggle />
            <button className="btn btn-ghost btn-sm" onClick={() => { clearAuth(); navigate('/') }}>
              退出
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="bento-nav-tabs">
          {[
            { id: 'jobs', label: '岗位管理', icon: <FileText size={14} /> },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`bento-nav-tab ${activeTab === tab.id ? 'active' : ''}`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
          {activeTab === 'candidates_for_job' && (
            <button className="bento-nav-tab active" style={{ cursor: 'default' }}>
              <Users size={14} />
              <span>候选人 · {candidatesJobTitle}</span>
            </button>
          )}
        </div>

        {/* Content Area */}
        <div className="bento-content">

          {/* ===== Tab: Jobs ===== */}
          {activeTab === 'jobs' && (
            <div style={{ display: 'flex', gap: 'var(--space-xl)', minHeight: '600px', maxHeight: 'calc(100vh - 150px)', alignItems: 'stretch' }}>
              {/* Left Column: Job List */}
              <div className="surface-card" style={{
                width: 380,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                padding: 0,
              }}>
                <div style={{ padding: 'var(--space-md)', borderBottom: '1px solid var(--border-light)', fontWeight: 700, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>岗位列表 ({jobs.length})</span>
                  {!isEditingJob && !isCreatingJob && (
                    <button className="btn btn-primary btn-sm" onClick={handleStartCreateJob}>
                      + 发布新岗位
                    </button>
                  )}
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                  {jobsLoading ? (
                    <div className="empty-state">加载中...</div>
                  ) : jobs.length === 0 ? (
                    <div className="empty-state">
                      暂无发布岗位，请点击右上角发布。
                    </div>
                  ) : (
                    jobs.map((job) => {
                      const isActive = selectedJob?.id === job.id
                      return (
                        <div
                          key={job.id}
                          onClick={() => handleSelectJob(job)}
                          className={`ed-job-item ${isActive ? 'active' : ''}`}
                        >
                          <div className="ed-job-title" style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{job.title}</div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-sm)' }}>
                            <span className="tag tag-gray">{job.category}</span>
                            <span className={`badge ${
                              job.status === 'approved' ? 'badge-success' :
                              job.status === 'pending_review' ? 'badge-warning' :
                              job.status === 'rejected' ? 'badge-danger' :
                              job.status === 'disabled' ? 'badge-gray' :
                              'badge-gray'
                            }`}>
                              {job.status === 'approved' && '已发布'}
                              {job.status === 'pending_review' && '审核中'}
                              {job.status === 'rejected' && '已驳回'}
                              {job.status === 'draft' && '草稿'}
                              {job.status === 'disabled' && '已下线'}
                            </span>
                          </div>
                          {/* Gap 3: potential match badge for approved jobs */}
                          {job.status === 'approved' && (() => {
                            const stat = jobMatchStats.find((s: any) => s.job_post_id === job.id)
                            const authorized = stat?.authorized_count ?? 0
                            const potential = stat?.potential_match_count ?? 0
                            if (authorized === 0 && potential === 0) return null
                            return (
                              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>👤 {authorized}</span>
                                {potential > 0 && (
                                  <span style={{ color: 'var(--accent-warning)' }}>🔍 +{potential} 潜在</span>
                                )}
                              </div>
                            )
                          })()}
                        </div>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Detail Panel or Create/Edit Form */}
              <div className="surface-card" style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                padding: 0,
              }}>
                {isCreatingJob || isEditingJob ? (
                  /* Form */
                  <form onSubmit={handleSaveJob} style={{ padding: 'var(--space-xl)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', overflowY: 'auto', flex: 1 }}>
                    <div className="section-label">
                      {isCreatingJob ? '发布新岗位招聘' : '编辑岗位信息'}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-md)' }}>
                      <div className="form-group">
                        <label>岗位名称 *</label>
                        <input
                          type="text"
                          required
                          placeholder="例如：Go后端开发工程师"
                          value={jobForm.title}
                          onChange={e => setJobForm({ ...jobForm, title: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>岗位类别 *</label>
                        <select
                          value={jobForm.category}
                          onChange={e => setJobForm({ ...jobForm, category: e.target.value })}
                        >
                          <option value="后端开发">后端开发</option>
                          <option value="前端开发">前端开发</option>
                          <option value="人工智能">人工智能</option>
                          <option value="移动端开发">移动端开发</option>
                          <option value="测试与运维">测试与运维</option>
                          <option value="产品与运营">产品与运营</option>
                        </select>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>岗位职责介绍</label>
                      <textarea
                        rows={3}
                        placeholder="主要职责描述..."
                        value={jobForm.description}
                        onChange={e => setJobForm({ ...jobForm, description: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>技能要求与经历要求 *</label>
                      <textarea
                        rows={5}
                        required
                        placeholder={"请详细填写岗位招聘要求，以便 AI 提取合理的雷达图模型。例如：\n1. 熟练掌握 React, TypeScript, TailwindCSS\n2. 熟悉 RESTful API 设计与交互数据交互\n3. 有完整独立前端项目开发经验优先"}
                        value={jobForm.requirements_text}
                        onChange={e => setJobForm({ ...jobForm, requirements_text: e.target.value })}
                        style={{ fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
                      <button type="submit" className="btn btn-primary">保存并进入下一步</button>
                      <button type="button" className="btn btn-ghost" onClick={() => {
                        setIsCreatingJob(false)
                        setIsEditingJob(false)
                        if (jobs.length > 0) handleSelectJob(jobs[0])
                      }}>取消</button>
                    </div>
                  </form>
                ) : selectedJob ? (
                  /* Details Panel */
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                    {/* Job Header */}
                    <div style={{ padding: 'var(--space-xl)', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                          <h2 className="section-title" style={{ margin: 0 }}>{selectedJob.title}</h2>
                          <span className={`badge ${
                            selectedJob.status === 'approved' ? 'badge-success' :
                            selectedJob.status === 'pending_review' ? 'badge-warning' :
                            selectedJob.status === 'rejected' ? 'badge-danger' :
                            'badge-gray'
                          }`}>
                            {selectedJob.status === 'approved' && '学校已审核通过 · 招聘中'}
                            {selectedJob.status === 'pending_review' && '教务审核中'}
                            {selectedJob.status === 'rejected' && '已驳回'}
                            {selectedJob.status === 'draft' && '草稿阶段 (尚未提交审核)'}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 'var(--space-xs)' }}>
                          <span className="tag tag-gray">岗位品类：{selectedJob.category}</span>
                        </div>
                      </div>
                      {(selectedJob.status === 'draft' || selectedJob.status === 'rejected') && (
                        <button className="btn btn-ghost btn-sm" onClick={handleStartEditJob}>
                          编辑岗位
                        </button>
                      )}
                      {selectedJob.status === 'approved' && (() => {
                        const stat = jobMatchStats.find((s: any) => s.job_post_id === selectedJob.id)
                        const authCount = stat?.authorized_count ?? 0
                        const potCount = stat?.potential_match_count ?? 0
                        return (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => handleViewJobCandidates(selectedJob.id, selectedJob.title)}>
                              查看授权候选人
                              {(authCount > 0 || potCount > 0) && (
                                <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.85 }}>
                                  (已授权 {authCount}{potCount > 0 ? ` · 潜在 +${potCount}` : ''})
                                </span>
                              )}
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={handleToggleJobOnline} title="下线后学生将不再看到该岗位">
                              暂停招聘
                            </button>
                          </>
                        )
                      })()}
                      {selectedJob.status === 'disabled' && (
                        <button className="btn btn-primary btn-sm" onClick={handleToggleJobOnline}>
                          重新上线
                        </button>
                      )}
                    </div>

                    {/* Detail contents */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-xl)', display: 'flex', flexDirection: 'column', gap: 'var(--space-xl)' }}>
                      {selectedJob.status === 'rejected' && selectedJob.review_reason && (
                        <div className="ed-rejected-banner" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                          <div><strong>驳回原因：</strong>{selectedJob.review_reason}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            请根据以上原因修改岗位信息后，重新提交学校审核。点击上方「编辑岗位」按钮即可开始修改。
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--space-xl)' }}>
                        {/* Left Part: Description & JD */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                          <div>
                            <div className="section-label">岗位简介</div>
                            <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{selectedJob.description || '暂无简介'}</p>
                          </div>
                          <div>
                            <div className="section-label">招聘描述与技能要求</div>
                            <pre className="ed-jd-pre">{selectedJob.requirements_text}</pre>
                          </div>
                        </div>

                        {/* Right Part: Ability Model */}
                        <div>
                          <div className="section-label">AI 解析能力指标模型</div>
                          {detailLoading ? (
                            <div className="empty-state">获取指标模型中...</div>
                          ) : !selectedJobModel ? (
                            <div className="solid-card" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-sm)' }}>
                              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>您尚未提取该岗位的能力指标特征</span>
                              <button
                                onClick={() => handleParseAbilityModel(selectedJob.id)}
                                disabled={parsingJobId === selectedJob.id}
                                className="btn btn-primary btn-sm"
                              >
                                {parsingJobId === selectedJob.id ? '大模型提取中...' : '智能体提取能力指标'}
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                              {/* Tech Skills progress */}
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 'var(--space-xs)' }}>技术技能要求</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                                  {Object.entries(selectedJobModel.tech_skills).map(([skill, val]) => (
                                    <div key={skill} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                                        <span>{skill}</span>
                                        <span style={{ fontWeight: 600 }}>{val}分</span>
                                      </div>
                                      <div className="ed-progress-track">
                                        <div className="ed-progress-fill-teal" style={{ width: `${val}%` }} />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* Domain Knowledge progress */}
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 'var(--space-xs)' }}>领域知识要求</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                                  {Object.entries(selectedJobModel.domain_knowledge).map(([dom, val]) => (
                                    <div key={dom} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                                        <span>{dom}</span>
                                        <span style={{ fontWeight: 600 }}>{val}分</span>
                                      </div>
                                      <div className="ed-progress-track">
                                        <div className="ed-progress-fill-blue" style={{ width: `${val}%` }} />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* Soft skills & project exp */}
                              <div className="ed-soft-jd-grid">
                                <div>
                                  <strong style={{ color: 'var(--text-secondary)' }}>核心软技能：</strong>
                                  <div style={{ marginTop: 'var(--space-xs)' }}>
                                    {Object.keys(selectedJobModel.soft_skills).join(' / ') || '未提取'}
                                  </div>
                                </div>
                                <div>
                                  <strong style={{ color: 'var(--text-secondary)' }}>核心项目经历要求：</strong>
                                  <div style={{ marginTop: 'var(--space-xs)', maxHeight: 60, overflowY: 'auto' }}>
                                    {selectedJobModel.project_exp.map((p, idx) => (
                                      <div key={idx} style={{ color: 'var(--text-primary)', marginBottom: 2 }}>
                                        {p.name}
                                      </div>
                                    )) || '无'}
                                  </div>
                                </div>
                              </div>

                              {/* Weight Configuration */}
                              <div className="ed-weight-grid">
                                <div>技术: <strong>{Math.round((selectedJobModel.weight_config?.tech_skills || 0) * 100)}%</strong></div>
                                <div>项目: <strong>{Math.round((selectedJobModel.weight_config?.project_exp || 0) * 100)}%</strong></div>
                                <div>学业: <strong>{Math.round((selectedJobModel.weight_config?.academic_foundation || 0) * 100)}%</strong></div>
                                <div>领域: <strong>{Math.round((selectedJobModel.weight_config?.domain_knowledge || 0) * 100)}%</strong></div>
                                <div>软证据: <strong>{Math.round(((selectedJobModel.weight_config?.soft_skill_evidence ?? selectedJobModel.weight_config?.soft_skills) || 0) * 100)}%</strong></div>
                              </div>

                              {/* Re-parse button */}
                              <button
                                onClick={() => handleParseAbilityModel(selectedJob.id)}
                                disabled={parsingJobId === selectedJob.id}
                                className="btn btn-ghost btn-sm"
                                style={{ width: '100%', borderStyle: 'dashed' }}
                              >
                                {parsingJobId === selectedJob.id ? '大模型重新提取中...' : '重新进行 AI 解析建模'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions Footer */}
                    {selectedJobModel && (selectedJob.status === 'draft' || selectedJob.status === 'rejected') && (
                      <div className="ed-actions-footer">
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>
                          对指标模型满意后，即可提交学校审核：
                        </span>
                        <button
                          onClick={() => handleSubmitReview(selectedJob.id)}
                          disabled={submittingJobId === selectedJob.id}
                          className="btn btn-primary"
                        >
                          {submittingJobId === selectedJob.id ? '提交中...' : '提交学校教务审核'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="empty-state" style={{ flex: 1 }}>
                    <span style={{ fontSize: 40 }}>📄</span>
                    <span>请在左侧选择一个在招岗位或创建新岗位。</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===== Tab: Candidates ===== */}
          {activeTab === 'candidates_for_job' && (() => {
            const stat = jobMatchStats.find((s: any) => s.job_post_id === candidatesJobId)
            const authCount = stat?.authorized_count ?? candidates.length
            const potCount = stat?.potential_match_count ?? 0
            return (
            <div className="surface-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('jobs')}>← 返回岗位</button>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                  岗位「{candidatesJobTitle}」的授权候选人
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  (已授权 {authCount}{potCount > 0 ? ` · 潜在匹配 +${potCount}` : ''})
                </span>
              </div>
              {candidatesLoading ? (
                <div className="empty-state">加载中...</div>
              ) : candidates.length === 0 ? (
                <div className="empty-state" style={{ padding: 'var(--space-xxl)' }}>
                  <span style={{ fontSize: 40 }}>👥</span>
                  <span style={{ fontSize: 14 }}>暂无学生授权其 AI 画像到您的在招岗位。</span>
                  {potCount > 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--accent-warning)', maxWidth: 460, marginTop: 8 }}>
                      💡 提示：有 {potCount} 名学生的 AI 画像与「{candidatesJobTitle}」岗位特征匹配，但尚未授权。您可以通过学校管理员推荐或等待学生主动授权。
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 460 }}>
                      学生在学生端完成 AI 画像诊断后，如果选择了您的岗位作为诊断目标，可以主动选择"授权"将画像公开给您查看。
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>候选人姓名</th>
                        <th>年级专业</th>
                        <th>申请岗位</th>
                        <th style={{ textAlign: 'center' }}>岗位匹配度</th>
                        <th>授权时间</th>
                        <th style={{ textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((cand) => {
                        const pct = Math.round(cand.match_score * 100)
                        const hasReEvaluated = cand.is_latest_version === false
                        return (
                          <tr key={cand.auth_id} style={hasReEvaluated ? { background: 'rgba(255,159,28,0.04)' } : undefined}>
                            <td style={{ fontWeight: 600 }}>
                              {cand.student_name}
                              {hasReEvaluated && (
                                <span style={{
                                  marginLeft: 8,
                                  fontSize: 10,
                                  padding: '1px 6px',
                                  borderRadius: 6,
                                  background: 'rgba(255,159,28,0.18)',
                                  color: 'var(--accent-warning)',
                                  fontWeight: 600,
                                }} title="该学生已复评，以下为最新诊断数据">
                                  已复评
                                </span>
                              )}
                            </td>
                            <td>{cand.student_grade} · {cand.student_major}</td>
                            <td>{cand.job_title}</td>
                            <td style={{ textAlign: 'center' }}>
                              <span className={`badge ${
                                pct >= 80 ? 'badge-success' :
                                pct >= 60 ? 'badge-warning' :
                                'badge-danger'
                              }`} style={{ fontWeight: 700, fontSize: 14 }}>
                                {pct}%
                              </span>
                              {hasReEvaluated && (
                                <div style={{ fontSize: 10, color: 'var(--accent-warning)', marginTop: 2 }}>
                                  V{cand.diagnosis_version}
                                </div>
                              )}
                            </td>
                            <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                              {cand.auth_date ? new Date(cand.auth_date).toLocaleDateString() : '-'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleViewCandidate(cand)}
                                disabled={candDetailLoading}
                              >
                                查看对比报告
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )})()}
        </div>

        {/* ===== Candidate Comparison Modal ===== */}
        {showCandModal && selectedCandidate && (() => {
          const student = selectedCandidate.student
          const ps = student?.profile_sections || {}
          const edu = ps.education || {}
          const psSkills = ps.skills || []
          const psProjects = ps.project_exp || []
          const psInternships = ps.internship_exp || []
          const psAwards = ps.awards || []
          const psPubs = ps.publications || []
          const psSelfEval = ps.self_evaluation || ''
          const attachments = selectedCandidate.attachments || []

          return (
            <div className="modal-overlay">
              <div className="modal-panel">
                {/* Modal Header */}
                <div className="modal-header">
                  <div>
                    <h3 className="section-title" style={{ margin: 0 }}>
                      候选人匹配对比报告：{selectedCandidate.student.name}
                    </h3>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 'var(--space-xs)' }}>
                      针对岗位：<strong>{selectedCandidate.job.title}</strong> | 匹配评分：
                      <span className="tag tag-blue">
                        {Math.round(selectedCandidate.diagnosis.match_score * 100)}%
                      </span>
                      {selectedCandidate.authorization_time && (
                        <span style={{ marginLeft: 'var(--space-sm)' }}>
                          授权时间：{new Date(selectedCandidate.authorization_time).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="ed-close-btn"
                    onClick={() => setShowCandModal(false)}
                  >
                    &times;
                  </button>
                </div>

                {/* Gap 7: Re-evaluation notice — 学生已复评，展示最新诊断数据 */}
                {selectedCandidate.is_latest_version === false && (
                  <div style={{
                    margin: '0 24px',
                    padding: '10px 16px',
                    borderRadius: 8,
                    background: 'rgba(255,159,28,0.1)',
                    border: '1px solid rgba(255,159,28,0.3)',
                    fontSize: 13,
                    color: 'var(--accent-warning)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    <span style={{ fontSize: 16 }}>🔄</span>
                    <span>
                      <strong>该学生已于授权后复评</strong>，以下展示的是最新诊断数据（V{selectedCandidate.diagnosis.version}）。
                      匹配评分和五维能力可能已发生变化。
                    </span>
                  </div>
                )}

                {/* Modal Scroll Content */}
                <div className="modal-body">
                  {/* Top Details grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--space-xl)' }}>
                    {/* Profile detail */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                      <div className="ed-bg-section">
                        <div className="section-label">教育背景</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)', fontSize: 13 }}>
                          <div>学校: <strong>{edu.school || student.school || selectedCandidate.student.grade}</strong></div>
                          <div>学历: <strong>{edu.education_level || '-'}</strong></div>
                          <div>专业: <strong>{selectedCandidate.student.major}</strong></div>
                          <div>成绩排名: <strong>{edu.rank_description || '未提及'}</strong></div>
                          <div>英语水平: <strong>{edu.english_level || '未提及'}</strong></div>
                          <div>意向岗位: <strong>{selectedCandidate.student.target_job}</strong></div>
                        </div>
                      </div>

                      {/* 实习经历 */}
                      {psInternships.length > 0 && (
                        <div>
                          <div className="section-label">实习经历</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                            {psInternships.map((item: any, idx: number) => (
                              <div key={idx} className="ed-project-card">
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{item.company_name} · {item.position_name}</div>
                                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{item.start_date} ~ {item.end_date}</div>
                                <div style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-xs)', fontSize: 12 }}>{item.description}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 项目经验 */}
                      <div>
                        <div className="section-label">项目经验</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                          {(psProjects.length > 0 ? psProjects : (selectedCandidate.student.project_exp || [])).length === 0 ? (
                            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>暂无项目经验</span>
                          ) : (
                            (psProjects.length > 0 ? psProjects : selectedCandidate.student.project_exp).map((p: any, idx: number) => (
                              <div key={idx} className="ed-project-card">
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.project_name || p.name}</div>
                                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{p.project_role || p.role || ''}</div>
                                <div style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-xs)', fontSize: 12 }}>{p.description}</div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>

                    {/* AI Rationale & Skills */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                      <div className="ed-ai-card">
                        <div className="section-label" style={{ color: 'var(--accent-primary)' }}>AI 岗位画像匹配依据</div>
                        <p style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                          {selectedCandidate.diagnosis.ai_reasoning?.reasoning ||
                           selectedCandidate.diagnosis.ai_reasoning?.match_analysis ||
                           selectedCandidate.diagnosis.career_advice ||
                           'AI 推荐语加载中...'}
                        </p>
                      </div>

                      {/* 技能列表 */}
                      {psSkills.length > 0 && (
                        <div className="ed-bg-section">
                          <div className="section-label">技能</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' }}>
                            {psSkills.map((s: any, i: number) => (
                              <span key={i} className="tag tag-blue" style={{ fontSize: 11 }}>
                                {s.name} · {s.level}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 奖励荣誉 */}
                      {psAwards.length > 0 && (
                        <div className="ed-bg-section">
                          <div className="section-label">奖励荣誉</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', fontSize: 12 }}>
                            {psAwards.map((a: any, i: number) => (
                              <div key={i} style={{ color: 'var(--text-secondary)' }}>
                                <strong>{a.award_name}</strong>
                                {a.level && <span className="tag tag-gray" style={{ marginLeft: 4, fontSize: 10 }}>{a.level}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 论文/专利 */}
                      {psPubs.length > 0 && (
                        <div className="ed-bg-section">
                          <div className="section-label">论文 / 专利</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', fontSize: 12 }}>
                            {psPubs.map((p: any, i: number) => (
                              <div key={i} style={{ color: 'var(--text-secondary)' }}>
                                <span className="tag tag-gray" style={{ fontSize: 10, marginRight: 4 }}>{p.pub_type}</span>
                                {p.name}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 自我评价 */}
                      {psSelfEval && (
                        <div className="ed-bg-section" style={{ opacity: 0.7 }}>
                          <div className="section-label">自我评价 (仅供参考)</div>
                          <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{psSelfEval.slice(0, 200)}</p>
                        </div>
                      )}

                      <div className="ed-bg-section">
                        <div className="section-label">证明材料</div>
                        {attachments.length === 0 ? (
                          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>学生暂未上传成绩单或其他证明材料</span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                            {attachments.map((att: any) => (
                              <a
                                key={att.id}
                                href={getAttachmentDownloadUrl(student.id, att.id, enterpriseId)}
                                target="_blank"
                                rel="noreferrer"
                                className="tag tag-gray"
                                style={{ textDecoration: 'none', width: 'fit-content', fontSize: 11 }}
                              >
                                {att.category === 'transcript' ? '成绩单' : att.category === 'language_certificate' ? '外语成绩证明' : '证明材料'}：{att.file_name}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 能力对比可视化 */}
                  <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 30, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)', marginTop: 'var(--space-lg)' }}>
                      <div className="surface-card" style={{ padding: 'var(--space-md)' }}>
                        <div className="section-label" style={{ marginBottom: 'var(--space-sm)' }}>能力雷达对比</div>
                        <div style={{ height: 260 }}>
                          <ReactECharts option={getDoubleRadarOption()} style={{ height: '100%', width: '100%' }} />
                        </div>
                      </div>
                      {(() => {
                        const gapOption = getGapBarOption()
                        return Object.keys(gapOption).length > 0 ? (
                          <div className="surface-card" style={{ padding: 'var(--space-md)' }}>
                            <div className="section-label" style={{ marginBottom: 'var(--space-sm)' }}>能力差距分析</div>
                            <div style={{ height: 260 }}>
                              <ReactECharts option={gapOption} style={{ height: '100%', width: '100%' }} />
                            </div>
                          </div>
                        ) : (
                          <div className="surface-card" style={{ padding: 'var(--space-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                            暂无差距分析数据
                          </div>
                        )
                      })()}
                    </div>
                  </React.Suspense>
                </div>
              </div>
            </div>
          )
        })()}

      </div>
    </>
  )
}
