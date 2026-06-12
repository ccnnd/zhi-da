import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import {
  getAdminSummary,
  listAdminStudents,
  getAdminStudentDetail,
  getAdminStudentTraces,
  listAdminEnterprises,
  updateAdminEnterpriseStatus,
  createAdminEnterprise,
  listAdminJobs,
  approveAdminJob,
  rejectAdminJob,
  getAdminJobDetail,
  recommendStudentToEnterprise,
  clearAuth,
} from '../services/api'

const ReactECharts = React.lazy(() => import('echarts-for-react'))
import { BarChart3, GraduationCap, Building2, ShieldCheck, ChevronLeft, ChevronRight, Plus, Sparkles } from 'lucide-react'
import ThemeToggle from '../components/shared/ThemeToggle'
import TraceTimeline from '../components/shared/TraceTimeline'
import { toast } from '../utils/toast'

const PAGE_SIZE = 20

// Reusable pagination controls
function PaginationControls({ page, totalPages, total, onPageChange }: {
  page: number; totalPages: number; total: number; onPageChange: (p: number) => void
}) {
  if (totalPages <= 1) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 0 0', borderTop: '1px solid var(--border-light)', marginTop: 16,
    }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        共 {total} 条，第 {page}/{totalPages} 页
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-outline btn-sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <ChevronLeft size={14} /> 上一页
        </button>
        <button
          className="btn btn-outline btn-sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          下一页 <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}

export default function AdminDashboard() {
  const { theme } = useAppStore()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<'stats' | 'students' | 'enterprises' | 'jobs'>('stats')

  const isDark = theme === 'dark'

  // Stats states
  const [summary, setSummary] = useState<any>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  // Students states
  const [students, setStudents] = useState<any[]>([])
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [studentsPage, setStudentsPage] = useState(1)
  const [studentsTotal, setStudentsTotal] = useState(0)
  const [studentsTotalPages, setStudentsTotalPages] = useState(0)
  const [diagnosisStatus, setDiagnosisStatus] = useState('')
  const [selectedStudent, setSelectedStudent] = useState<any | null>(null)
  const [studentDetailLoading, setStudentDetailLoading] = useState(false)
  const [showStudentModal, setShowStudentModal] = useState(false)
  const [studentTraces, setStudentTraces] = useState<any[]>([])
  const [tracesLoading, setTracesLoading] = useState(false)
  // Gap 4: Recommend states
  const [approvedJobsForRecommend, setApprovedJobsForRecommend] = useState<any[]>([])
  const [selectedRecommendJobId, setSelectedRecommendJobId] = useState('')
  const [recommending, setRecommending] = useState(false)
  const [recommendResult, setRecommendResult] = useState<{ success: boolean; message: string } | null>(null)

  // Enterprises states
  const [enterprises, setEnterprises] = useState<any[]>([])
  const [enterprisesLoading, setEnterprisesLoading] = useState(false)
  const [enterprisesPage, setEnterprisesPage] = useState(1)
  const [enterprisesTotal, setEnterprisesTotal] = useState(0)
  const [enterprisesTotalPages, setEnterprisesTotalPages] = useState(0)
  const [updatingEntId, setUpdatingEntId] = useState<string | null>(null)

  // Create enterprise modal states
  const [showCreateEntModal, setShowCreateEntModal] = useState(false)
  const [createEntLoading, setCreateEntLoading] = useState(false)
  const [createEntForm, setCreateEntForm] = useState({
    name: '', industry: '', contact_name: '', contact_email: '', status: 'active'
  })

  // Jobs audit states
  const [jobs, setJobs] = useState<any[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobsPage, setJobsPage] = useState(1)
  const [jobsTotal, setJobsTotal] = useState(0)
  const [jobsTotalPages, setJobsTotalPages] = useState(0)
  const [selectedJob, setSelectedJob] = useState<any | null>(null)
  const [selectedJobModel, setSelectedJobModel] = useState<any | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditFilter, setAuditFilter] = useState<string>('pending_review')

  // Reject modal states
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectJobId, setRejectJobId] = useState('')

  // Load summary stats
  const loadSummary = async () => {
    setStatsLoading(true)
    try {
      const data = await getAdminSummary()
      setSummary(data)
    } catch (err) {
      console.error('Failed to load summary', err)
    } finally {
      setStatsLoading(false)
    }
  }

  // Select job and load detail/ability model (defined early so loadJobs can reference it)
  const handleSelectJob = async (job: any) => {
    setSelectedJob(job)
    try {
      const fetchDetail = await getAdminJobDetail(job.id)
      setSelectedJobModel(fetchDetail.ability_model)
    } catch (err) {
      console.error('Failed to load job model', err)
      setSelectedJobModel(null)
    }
  }

  // Load students list (paginated, with optional diagnosis filter)
  const loadStudents = async (page = studentsPage, diagStatus = diagnosisStatus) => {
    setStudentsLoading(true)
    try {
      const data = await listAdminStudents(page, PAGE_SIZE, diagStatus || undefined)
      setStudents(data.items)
      setStudentsTotal(data.total)
      setStudentsTotalPages(data.total_pages)
      setStudentsPage(data.page)
    } catch (err) {
      console.error('Failed to load students', err)
    } finally {
      setStudentsLoading(false)
    }
  }

  // Load enterprises list (paginated)
  const loadEnterprises = async (page = enterprisesPage) => {
    setEnterprisesLoading(true)
    try {
      const data = await listAdminEnterprises(page, PAGE_SIZE)
      setEnterprises(data.items)
      setEnterprisesTotal(data.total)
      setEnterprisesTotalPages(data.total_pages)
      setEnterprisesPage(data.page)
    } catch (err) {
      console.error('Failed to load enterprises', err)
    } finally {
      setEnterprisesLoading(false)
    }
  }

  // Load jobs audit list (paginated)
  const loadJobs = async (filter?: string, page = jobsPage) => {
    setJobsLoading(true)
    try {
      const data = await listAdminJobs(filter || auditFilter, page, PAGE_SIZE)
      setJobs(data.items)
      setJobsTotal(data.total)
      setJobsTotalPages(data.total_pages)
      setJobsPage(data.page)
      if (data.items.length > 0) {
        handleSelectJob(data.items[0])
      } else {
        setSelectedJob(null)
        setSelectedJobModel(null)
      }
    } catch (err) {
      console.error('Failed to load jobs', err)
    } finally {
      setJobsLoading(false)
    }
  }

  // Effect to load data based on active tab and page changes
  useEffect(() => {
    if (activeTab === 'stats') {
      loadSummary()
    } else if (activeTab === 'students') {
      loadStudents()
    } else if (activeTab === 'enterprises') {
      loadEnterprises()
    } else if (activeTab === 'jobs') {
      loadJobs(auditFilter)
    }
  }, [activeTab, auditFilter, studentsPage, enterprisesPage, jobsPage, diagnosisStatus])

  // Student detail viewing
  const handleViewStudent = async (studentId: string) => {
    setStudentDetailLoading(true)
    setRecommendResult(null)
    setSelectedRecommendJobId('')
    try {
      const detail = await getAdminStudentDetail(studentId)
      setSelectedStudent(detail)
      setShowStudentModal(true)
      // 加载 Agent Trace（不阻塞主流程）
      setTracesLoading(true)
      setStudentTraces([])
      try {
        const traceData = await getAdminStudentTraces(studentId)
        setStudentTraces(traceData.traces || [])
      } catch {
        // trace 加载失败不影响档案展示
      }
      setTracesLoading(false)
      // 预加载已审核通过的岗位列表（供推荐使用）
      try {
        const jobsData = await listAdminJobs('approved', 1, 200)
        setApprovedJobsForRecommend(jobsData.items || [])
      } catch {
        setApprovedJobsForRecommend([])
      }
    } catch (err) {
      toast.error('获取学生详细档案失败')
    } finally {
      setStudentDetailLoading(false)
    }
  }

  // Toggle Enterprise Status
  const handleToggleEnterpriseStatus = async (entId: string, currentStatus: string) => {
    setUpdatingEntId(entId)
    const nextStatus = currentStatus === 'active' ? 'disabled' : 'active'
    try {
      await updateAdminEnterpriseStatus(entId, nextStatus)
      setEnterprises(prev => prev.map(e => e.id === entId ? { ...e, status: nextStatus } : e))
    } catch (err) {
      toast.error('修改企业状态失败')
    } finally {
      setUpdatingEntId(null)
    }
  }

  // Create Enterprise
  const handleCreateEnterprise = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createEntForm.name.trim()) {
      toast.warning('企业名称不能为空')
      return
    }
    setCreateEntLoading(true)
    try {
      await createAdminEnterprise(createEntForm)
      setShowCreateEntModal(false)
      setCreateEntForm({ name: '', industry: '', contact_name: '', contact_email: '', status: 'active' })
      toast.success('企业已添加')
      loadEnterprises(1)
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || '新增企业失败'
      toast.error(detail)
    } finally {
      setCreateEntLoading(false)
    }
  }

  // Approve Job
  const handleApproveJob = async (jobId: string) => {
    setAuditLoading(true)
    try {
      await approveAdminJob(jobId)
      toast.success('岗位审核通过！学生端现可选择此岗位进行诊断匹配。')
      setSelectedJob((prev: any) => prev ? { ...prev, status: 'approved', review_reason: '' } : prev)
      loadJobs()
    } catch (err) {
      toast.error('岗位审批操作失败')
    } finally {
      setAuditLoading(false)
    }
  }

  // Open reject dialog
  const handleStartRejectJob = (jobId: string) => {
    setRejectJobId(jobId)
    setRejectReason('')
    setShowRejectModal(true)
  }

  // Confirm Reject
  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!rejectReason.trim()) return
    setAuditLoading(true)
    setShowRejectModal(false)
    try {
      await rejectAdminJob(rejectJobId, rejectReason)
      toast.success('岗位已驳回，企业端将看到驳回原因并修改后重新提交。')
      setSelectedJob((prev: any) => prev ? { ...prev, status: 'rejected', review_reason: rejectReason } : prev)
      loadJobs()
    } catch (err) {
      toast.error('岗位驳回操作失败')
    } finally {
      setAuditLoading(false)
    }
  }

  // ECharts line options for Student Diagnostic Score history
  const getStudentGrowthOption = () => {
    if (!selectedStudent || selectedStudent.diagnoses.length === 0) return {}

    const diags = [...selectedStudent.diagnoses].reverse() // show crono order

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => `版本: ${params[0].name}<br/>匹配度分数: <b>${params[0].value}%</b>`,
        backgroundColor: isDark ? 'rgba(22, 24, 29, 0.95)' : 'rgba(248, 247, 244, 0.95)',
        borderColor: isDark ? '#2c2f3a' : '#e8e5df',
        textStyle: { color: isDark ? '#f5f6f9' : '#1d1d1f' }
      },
      xAxis: {
        type: 'category',
        data: diags.map(d => `V${d.version}`),
        boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e8e5df' } },
        axisLabel: { color: isDark ? '#a0a5b5' : '#6e6e73' }
      },
      yAxis: {
        type: 'value',
        max: 100,
        min: 0,
        splitLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e8e5df' } },
        axisLabel: { color: isDark ? '#a0a5b5' : '#6e6e73' }
      },
      series: [
        {
          name: '匹配分数',
          type: 'line',
          data: diags.map(d => Math.round(d.match_score * 100)),
          smooth: true,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { color: '#0071e3', width: 3 },
          itemStyle: { color: '#0071e3' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(0, 113, 227, 0.4)' },
                { offset: 1, color: 'rgba(0, 113, 227, 0.01)' }
              ]
            }
          }
        }
      ]
    }
  }

  // Gap 2: Student ability radar chart (single student, no job comparison)
  const getStudentRadarOption = () => {
    if (!selectedStudent?.latest_diagnosis_detail) return {}
    const dimScores = selectedStudent.latest_diagnosis_detail.dimension_scores || {}
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
        splitArea: {
          areaStyle: {
            color: isDark
              ? ['rgba(255, 255, 255, 0.01)', 'rgba(255, 255, 255, 0.02)']
              : ['rgba(0, 0, 0, 0.02)', 'rgba(0, 0, 0, 0.005)']
          }
        },
        splitLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } },
        axisLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } },
        axisName: { color: isDark ? '#a0a5b5' : '#6e6e73', fontSize: 11 }
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
          areaStyle: { color: 'rgba(0,113,227, 0.3)' },
          lineStyle: { color: '#0071e3' },
          itemStyle: { color: '#0071e3' }
        }]
      }]
    }
  }

  // Gap 2: Gap analysis bar chart
  const getStudentGapOption = () => {
    if (!selectedStudent?.latest_diagnosis_detail) return {}
    const gaps = selectedStudent.latest_diagnosis_detail.gap_details || []
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
          return `能力项: <b>${item.name}</b><br/>差距值: <b style="color:${item.value >= 0 ? '#34c759' : '#ff3b30'}">${sign}${item.value}</b>`
        }
      },
      grid: { left: '3%', right: '8%', bottom: '3%', top: '5%', containLabel: true },
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
          // 优先用具体技能名，其次名称映射，最后维度映射为中文
          const skillName = g.skill_name || g.name || g.skill || ''
          if (skillName) return skillName
          const dim = g.dimension || ''
          return dimLabelMap[dim] || dim
        }),
        axisLine: { lineStyle: { color: isDark ? '#2c2f3a' : '#e5e5ea' } },
        axisLabel: { color: isDark ? '#a0a5b5' : '#6e6e73', fontSize: 11 }
      },
      series: [{
        name: '能力差距',
        type: 'bar',
        data: sortedGaps.map((g: any) => {
          const val = g.gap ?? (g.student_score !== undefined && g.required_score !== undefined ? g.student_score - g.required_score : 0)
          return {
            value: val,
            itemStyle: {
              color: val >= 0 ? '#34c759' : '#ff3b30',
              borderRadius: [0, 4, 4, 0]
            }
          }
        }),
        label: {
          show: true,
          position: 'inside',
          formatter: (params: any) => (params.value > 0 ? `+${params.value}` : params.value)
        }
      }]
    }
  }

  return (
    <>
    <style>{`
      .bento-nav-tab:hover {
        background: var(--bg-hover);
      }
      .job-list-item:hover {
        background: var(--bg-hover);
      }
      .job-list-item.active {
        background: var(--bg-hover);
        border-left: 3px solid var(--accent-warning);
      }
      .job-list-item.active .job-list-title {
        color: var(--accent-warning);
      }
      .job-list-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .audit-filter-btn:hover {
        background: var(--bg-hover);
      }
      .audit-filter-btn.active {
        background: var(--bg-hover);
        color: var(--accent-warning);
        font-weight: 700;
      }
      .skill-row:hover {
        background: var(--bg-page);
      }
      .auth-row:hover {
        border-color: var(--accent-warning);
      }
      .modal-close-btn:hover {
        color: var(--text-primary);
      }
      .btn-view-student:hover {
        background: var(--accent-warning);
        color: var(--bg-page);
      }
      .btn-toggle-ent:hover {
        opacity: 0.85;
      }
      .metric-card-clickable {
        cursor: pointer;
        transition: transform 0.18s, box-shadow 0.18s;
        position: relative;
      }
      .metric-card-clickable:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 16px rgba(0,0,0,0.06);
      }
      .metric-card-clickable:active {
        transform: translateY(0);
      }
      .metric-card-clickable::after {
        content: '→';
        position: absolute;
        right: 14px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 14px;
        color: var(--text-tertiary);
        opacity: 0;
        transition: opacity 0.2s;
      }
      .metric-card-clickable:hover::after {
        opacity: 1;
      }
    `}</style>

    <div className="bento-dashboard">
      {/* Top Bar */}
      <div className="bento-topbar">
        <div className="bento-topbar-brand">
          <button className="brand-link" onClick={() => navigate('/')}>
            <span className="brand-link-mark"><Sparkles size={14} /></span>
            职达
          </button>
          <span className="brand-divider" />
          学校管理控制台
        </div>
        <div className="bento-topbar-actions">
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>学校管理员账号</span>
          <ThemeToggle />
          <button className="btn btn-ghost btn-sm" onClick={() => { clearAuth(); navigate('/') }}>
            退出
          </button>
        </div>
      </div>

      {/* Horizontal Pill Tab Bar */}
      <nav className="bento-nav-tabs">
        {[
          { id: 'stats', label: '数据概览', icon: <BarChart3 size={16} /> },
          { id: 'students', label: '学生管理', icon: <GraduationCap size={16} /> },
          { id: 'enterprises', label: '企业管理', icon: <Building2 size={16} /> },
          { id: 'jobs', label: '岗位审核', icon: <ShieldCheck size={16} /> },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id as any)}
            className={`bento-nav-tab ${activeTab === item.id ? 'active' : ''}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Content Area */}
      <div className="bento-content">
        {/* Tab content 1: Stats summary */}
        {activeTab === 'stats' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            {statsLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)' }}>获取统计中...</div>
            ) : (
              <>
                {/* Row 1: 基础运营指标 */}
                <div className="bento-auto-4">
                  <div className="metric-card metric-card-clickable" onClick={() => setActiveTab('students')}>
                    <span className="metric-label">诊断学生总数</span>
                    <span className="metric-value" style={{ color: 'var(--accent-primary)' }}>
                      {summary?.total_students || 0}人
                    </span>
                  </div>
                  <div className="metric-card metric-card-clickable" onClick={() => setActiveTab('enterprises')}>
                    <span className="metric-label">入驻企业数</span>
                    <span className="metric-value" style={{ color: 'var(--accent-primary)' }}>
                      {summary?.total_enterprises || 0}家
                    </span>
                  </div>
                  <div className="metric-card metric-card-clickable" onClick={() => { setAuditFilter('approved'); setActiveTab('jobs') }}>
                    <span className="metric-label">在招岗位总数</span>
                    <span className="metric-value" style={{ color: 'var(--accent-warning)' }}>
                      {summary?.total_jobs || 0}个
                    </span>
                  </div>
                  <div className="metric-card metric-card-clickable" onClick={() => { setAuditFilter('pending_review'); setActiveTab('jobs') }}>
                    <span className="metric-label">待审核岗位数</span>
                    <span className="metric-value" style={{ color: 'var(--accent-danger)' }}>
                      {summary?.pending_jobs || 0}个
                    </span>
                  </div>
                </div>

                {/* Row 2: Gap 5 增强统计——诊断覆盖、匹配度、成长任务 */}
                <div className="bento-auto-4">
                  <div className="metric-card metric-card-clickable" onClick={() => { setDiagnosisStatus('diagnosed'); setActiveTab('students') }}>
                    <span className="metric-label">已评测学生</span>
                    <span className="metric-value" style={{ color: 'var(--accent-success)' }}>
                      {summary?.diagnosed_students || 0}人
                    </span>
                  </div>
                  <div className="metric-card metric-card-clickable" onClick={() => { setDiagnosisStatus('undiagnosed'); setActiveTab('students') }}>
                    <span className="metric-label">未评测学生</span>
                    <span className="metric-value" style={{ color: 'var(--accent-danger)' }}>
                      {summary?.undiagnosed_students || 0}人
                    </span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-label">平均匹配分</span>
                    <span className="metric-value" style={{ color: 'var(--accent-primary)' }}>
                      {summary?.avg_match_score ? `${Math.round(summary.avg_match_score * 100)}%` : 'N/A'}
                    </span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-label">成长任务完成</span>
                    <span className="metric-value" style={{ color: 'var(--accent-warning)' }}>
                      {summary?.completed_growth_tasks || 0}/{summary?.total_growth_tasks || 0}
                    </span>
                  </div>
                </div>
              </>
            )}

            <div className="surface-card">
              <h3 className="section-label">双选协同系统运行说明</h3>
              <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)', margin: 0 }}>
                本平台作为一个<strong>三端协同网络</strong>，教务管理员在此模块对发布职位进行把关。企业发布职位后，将由 <strong>AI 能力解析引擎</strong>智能自动解析提炼该职位所需的核心能力与经历（前端能力、后端能力、知识、软实力等指标），学校管理员可在"企业岗位审核"列表查看该提取是否合理，点击通过后，学生即可针对性评估该企业岗位的匹配度并授权。
              </p>
            </div>
          </div>
        )}

        {/* Tab content 2: Students list */}
        {activeTab === 'students' && (
          <div className="surface-card">
            {/* Gap 1: 诊断状态筛选下拉 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                共 {studentsTotal} 名学生
              </span>
              <select
                value={diagnosisStatus}
                onChange={e => { setDiagnosisStatus(e.target.value); setStudentsPage(1) }}
                style={{
                  padding: '6px 12px', borderRadius: 6,
                  border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                  color: 'var(--text-primary)', fontSize: 13, outline: 'none', cursor: 'pointer',
                }}
              >
                <option value="">全部学生</option>
                <option value="diagnosed">已评测</option>
                <option value="undiagnosed">未评测</option>
              </select>
            </div>
            {studentsLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)' }}>数据加载中...</div>
            ) : students.length === 0 ? (
              <div className="empty-state">
                {diagnosisStatus === 'diagnosed' ? '暂无已评测学生。' :
                 diagnosisStatus === 'undiagnosed' ? '所有学生均已完成评测。' :
                 '暂无学生完成简历上传或 AI 诊断。'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>学生姓名</th>
                      <th>年级专业</th>
                      <th>目标求职岗位</th>
                      <th style={{ textAlign: 'center' }}>诊断版本数</th>
                      <th style={{ textAlign: 'center' }}>最新匹配分</th>
                      <th style={{ textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((student) => {
                      const score = student.latest_score ? Math.round(student.latest_score * 100) : null
                      return (
                        <tr key={student.id}>
                          <td style={{ fontWeight: 600 }}>{student.name}</td>
                          <td>{student.grade} · {student.major}</td>
                          <td>{student.target_job || '未设定'}</td>
                          <td style={{ textAlign: 'center' }}>{student.diagnosis_count}次</td>
                          <td style={{ textAlign: 'center' }}>
                            {score !== null ? (
                              <span className={
                                score >= 80 ? 'tag tag-blue' :
                                score >= 60 ? 'tag tag-amber' :
                                'status-badge status-badge-danger'
                              }>{score}%</span>
                            ) : (
                              <span className="tag tag-gray">未诊断</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn btn-outline btn-sm btn-view-student"
                              onClick={() => handleViewStudent(student.id)}
                              disabled={studentDetailLoading}
                              style={{ borderColor: 'var(--accent-warning)', color: 'var(--accent-warning)' }}
                            >
                              查看档案
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <PaginationControls
                  page={studentsPage}
                  totalPages={studentsTotalPages}
                  total={studentsTotal}
                  onPageChange={(p) => setStudentsPage(p)}
                />
              </div>
            )}
          </div>
        )}

        {/* Tab content 3: Enterprises Cooperating */}
        {activeTab === 'enterprises' && (
          <div className="surface-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                共 {enterprisesTotal} 家企业
              </span>
              <button
                className="btn btn-primary"
                onClick={() => setShowCreateEntModal(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', fontSize: 13,
                  background: 'var(--accent-primary)',
                }}
              >
                <Plus size={14} /> 新增企业
              </button>
            </div>
            {enterprisesLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)' }}>企业加载中...</div>
            ) : enterprises.length === 0 ? (
              <div className="empty-state">暂无入驻企业。</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>企业名称</th>
                      <th>所属行业</th>
                      <th>对接联系人</th>
                      <th>联系邮箱</th>
                      <th style={{ textAlign: 'center' }}>状态</th>
                      <th style={{ textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enterprises.map((ent) => {
                      const isActive = ent.status === 'active'
                      const isPending = ent.status === 'pending'
                      return (
                        <tr key={ent.id}>
                          <td style={{ fontWeight: 600 }}>{ent.name}</td>
                          <td>{ent.industry || '未填写'}</td>
                          <td>{ent.contact_name || '未填写'}</td>
                          <td>{ent.contact_email || '未填写'}</td>
                          <td style={{ textAlign: 'center' }}>
                            <span className={isActive ? 'badge badge-success' : isPending ? 'badge badge-warning' : 'badge badge-danger'}>
                              {isActive ? '合作中' : isPending ? '待审核' : '已禁用'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className={`btn btn-sm btn-toggle-ent ${isActive ? 'btn-danger' : 'btn-outline'}`}
                              onClick={() => handleToggleEnterpriseStatus(ent.id, ent.status)}
                              disabled={updatingEntId === ent.id}
                              style={isActive ? {} : { borderColor: 'var(--accent-success)', color: 'var(--accent-success)' }}
                            >
                              {updatingEntId === ent.id ? '处理中...' : isActive ? '禁用企业' : '启用企业'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <PaginationControls
                  page={enterprisesPage}
                  totalPages={enterprisesTotalPages}
                  total={enterprisesTotal}
                  onPageChange={(p) => setEnterprisesPage(p)}
                />
              </div>
            )}
          </div>
        )}

        {/* Tab content 4: Jobs Audit review flow */}
        {activeTab === 'jobs' && (
          <div style={{ display: 'flex', gap: 28, height: '620px', alignItems: 'stretch' }}>
            {/* Left Column: Job posts list with filter status */}
            <div className="surface-card" style={{
              width: 320,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: 0
            }}>
              <div style={{ padding: 12, borderBottom: '1px solid var(--border-light)', display: 'flex', gap: 6 }}>
                {(['pending_review', 'approved'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => { setAuditFilter(f); setJobsPage(1) }}
                    className={`audit-filter-btn ${auditFilter === f ? 'active' : ''}`}
                    style={{
                      flex: 1,
                      padding: '6px 4px',
                      fontSize: 11,
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                      background: auditFilter === f ? 'var(--bg-hover)' : 'transparent',
                      color: auditFilter === f ? 'var(--accent-warning)' : 'var(--text-secondary)',
                      fontWeight: auditFilter === f ? 700 : 500,
                    }}
                  >
                    {f === 'pending_review' && '待审核'}
                    {f === 'approved' && '已通过'}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                {jobsLoading ? (
                  <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-tertiary)' }}>加载中...</div>
                ) : jobs.length === 0 ? (
                  <div className="empty-state" style={{ fontSize: 13 }}>
                    当前状态无岗位记录。
                  </div>
                ) : (
                  jobs.map((job) => {
                    const isActive = selectedJob?.id === job.id
                    return (
                      <div
                        key={job.id}
                        onClick={() => handleSelectJob(job)}
                        className={`job-list-item ${isActive ? 'active' : ''}`}
                        style={{
                          padding: '16px 20px',
                          borderBottom: '1px solid var(--border-light)',
                          cursor: 'pointer',
                          borderLeft: isActive ? '3px solid var(--accent-warning)' : 'none',
                          transition: 'all 0.2s',
                        }}
                      >
                        <div className="job-list-title" style={{ fontWeight: 600, fontSize: 14, color: isActive ? 'var(--accent-warning)' : 'var(--text-primary)' }}>{job.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>发布企业：{job.enterprise_name}</div>
                      </div>
                    )
                  })
                )}
              </div>
              {/* Jobs pagination */}
              {jobsTotalPages > 1 && (
                <div style={{
                  padding: '8px 12px', borderTop: '1px solid var(--border-light)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11,
                }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>{jobsPage}/{jobsTotalPages}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-outline btn-sm" disabled={jobsPage <= 1} onClick={() => setJobsPage(p => p - 1)} style={{ padding: '2px 8px', display: 'flex' }}>
                      <ChevronLeft size={12} />
                    </button>
                    <button className="btn btn-outline btn-sm" disabled={jobsPage >= jobsTotalPages} onClick={() => setJobsPage(p => p + 1)} style={{ padding: '2px 8px', display: 'flex' }}>
                      <ChevronRight size={12} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Right Column: Audit Panel details */}
            <div className="surface-card" style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: 0
            }}>
              {selectedJob ? (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                  {/* Job Header */}
                  <div style={{ padding: '24px 28px', borderBottom: '1px solid var(--border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{selectedJob.title}</h2>
                      <span className={
                        selectedJob.status === 'approved' ? 'badge badge-success' :
                        selectedJob.status === 'pending_review' ? 'badge badge-warning' :
                        selectedJob.status === 'rejected' ? 'badge badge-danger' :
                        'badge badge-neutral'
                      }>
                        {selectedJob.status === 'approved' && '已通过审核'}
                        {selectedJob.status === 'pending_review' && '等待学校审核'}
                        {selectedJob.status === 'rejected' && '已驳回'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      发布企业：<strong>{selectedJob.enterprise_name}</strong> | 岗位品类：{selectedJob.category}
                    </div>
                  </div>

                  {/* Details Scroll */}
                  <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {selectedJob.status === 'rejected' && selectedJob.review_reason && (
                      <div style={{
                        padding: '12px 16px',
                        borderRadius: 8,
                        background: 'rgba(255,59,48,0.06)',
                        border: '1px solid rgba(255,59,48,0.15)',
                        color: 'var(--accent-danger)',
                        fontSize: 13
                      }}>
                        <strong>驳回原委描述：</strong>{selectedJob.review_reason}
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 28 }}>
                      {/* Left: Description */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                          <span className="section-label">招聘要求描述</span>
                          <pre style={{
                            padding: 14,
                            borderRadius: 8,
                            background: 'var(--bg-hover)',
                            border: '1px solid var(--border-light)',
                            fontSize: 12,
                            lineHeight: 1.5,
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-primary)',
                            marginTop: 6,
                            maxHeight: 280,
                            overflowY: 'auto',
                          }}>{selectedJob.requirements_text}</pre>
                        </div>
                      </div>

                      {/* Right: AI parsed model check */}
                      <div>
                        <span className="section-label">AI 解析建模合理性核查</span>
                        {!selectedJobModel ? (
                          <div className="solid-card" style={{ padding: 20, textAlign: 'center', border: '1px dashed var(--border-light)', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 12 }}>
                            该岗位暂无提取的能力模型。企业端保存招聘要求后，需由企业端触发 AI 解析建模。
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
                            <div>
                              <div className="section-label" style={{ marginBottom: 6 }}>技术技能要求</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {Object.entries(selectedJobModel.tech_skills || {}).map(([skill, val]: any) => (
                                  <div key={skill} className="skill-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, background: 'var(--bg-hover)', padding: '4px 8px', borderRadius: 4 }}>
                                    <span>{skill}</span>
                                    <span style={{ fontWeight: 600 }}>{val}分</span>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div>
                              <div className="section-label" style={{ marginBottom: 6 }}>领域知识要求</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {Object.entries(selectedJobModel.domain_knowledge || {}).map(([dom, val]: any) => (
                                  <div key={dom} className="skill-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, background: 'var(--bg-hover)', padding: '4px 8px', borderRadius: 4 }}>
                                    <span>{dom}</span>
                                    <span style={{ fontWeight: 600 }}>{val}分</span>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className="solid-card" style={{ fontSize: 11, padding: 10 }}>
                              <div>技术权重: <strong>{Math.round((selectedJobModel.weight_config?.tech_skills || 0) * 100)}%</strong></div>
                              <div style={{ marginTop: 2 }}>知识权重: <strong>{Math.round((selectedJobModel.weight_config?.domain_knowledge || 0) * 100)}%</strong></div>
                              <div style={{ marginTop: 2 }}>软技能权重: <strong>{Math.round((selectedJobModel.weight_config?.soft_skills || 0) * 100)}%</strong></div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Audit Footer actions — 待审核和已通过均可操作 */}
                  {(selectedJob.status === 'pending_review' || selectedJob.status === 'approved') && (
                    <div style={{ padding: '16px 28px', borderTop: '1px solid var(--border-light)', background: 'var(--bg-hover)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                      <button
                        onClick={() => handleStartRejectJob(selectedJob.id)}
                        disabled={auditLoading}
                        className="btn btn-outline"
                        style={{ borderColor: 'var(--accent-danger)', color: 'var(--accent-danger)' }}
                      >
                        驳回岗位申请
                      </button>
                      {selectedJob.status === 'pending_review' && (
                        <button
                          onClick={() => handleApproveJob(selectedJob.id)}
                          disabled={auditLoading}
                          className="btn btn-primary"
                          style={{ background: 'var(--accent-warning)' }}
                        >
                          {auditLoading ? '处理中...' : '审核通过发布'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty-state" style={{ flex: 1 }}>
                  <span style={{ fontSize: 40, display: 'block', marginBottom: 12 }}>
                    <ShieldCheck size={40} />
                  </span>
                  <span>请在左侧选择需要审核或查看的岗位。</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Student detail view modal */}
      {showStudentModal && selectedStudent && (
        <div className="modal-overlay">
          <div className="modal-panel animate-slide-up" style={{
            width: '90%',
            maxWidth: '850px',
            height: '80vh',
            overflow: 'hidden'
          }}>
            <div className="modal-header">
              <div>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>学生综合成长档案：{selectedStudent.student.name}</h3>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {selectedStudent.student.grade} · {selectedStudent.student.major} | 目标求职岗位：{selectedStudent.student.target_job || '未设定'}
                </span>
              </div>
              <button
                onClick={() => setShowStudentModal(false)}
                className="btn btn-ghost btn-sm"
              >
                &times;
              </button>
            </div>

            <div className="modal-body" style={{ overflowY: 'auto' }}>
              {/* Gap 2: Qualitative diagnosis visualization */}
              {selectedStudent.latest_diagnosis_detail ? (
                <>
                  {/* Row 1: Radar chart + Gap bar chart */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <span className="section-label">五维能力雷达图</span>
                      <div style={{ height: '280px', background: 'var(--bg-hover)', borderRadius: 12, padding: 10 }}>
                        <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
                          <ReactECharts option={getStudentRadarOption()} style={{ height: '100%', width: '100%' }} />
                        </React.Suspense>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <span className="section-label">能力差距分析</span>
                      <div style={{ height: '280px', background: 'var(--bg-hover)', borderRadius: 12, padding: 10 }}>
                        <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
                          <ReactECharts option={getStudentGapOption()} style={{ height: '100%', width: '100%' }} />
                        </React.Suspense>
                      </div>
                    </div>
                  </div>

                  {/* Row 2: AI career advice + TOP5 matching jobs */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <span className="section-label">AI 成长建议</span>
                      <div className="solid-card" style={{ padding: 16, fontSize: 13, lineHeight: 1.7, maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                        {selectedStudent.latest_diagnosis_detail.career_advice || '暂无建议'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <span className="section-label">TOP5 匹配岗位</span>
                      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {(selectedStudent.latest_diagnosis_detail.top5_jobs || []).length === 0 ? (
                          <div className="solid-card" style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)', border: '1px dashed var(--border-light)' }}>暂无匹配岗位数据</div>
                        ) : (
                          (selectedStudent.latest_diagnosis_detail.top5_jobs || []).map((job: any, idx: number) => (
                            <div key={idx} style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 10, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {job.job_title || job.title || job.name || `岗位${idx + 1}`}
                                </div>
                                {job.company && <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 }}>{job.company}</div>}
                              </div>
                              {job.match_score !== undefined && (
                                <span style={{ color: 'var(--accent-primary)', fontWeight: 700, fontSize: 13, marginLeft: 12, whiteSpace: 'nowrap' }}>
                                  {typeof job.match_score === 'number' && job.match_score <= 1 ? Math.round(job.match_score * 100) : Math.round(job.match_score)}%
                                </span>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="solid-card" style={{ padding: 30, border: '1px dashed var(--border-light)', textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>
                  该学生尚未完成 AI 诊断评测，暂无定性能力画像。完成首次诊断后，此处将展示五维雷达图、能力差距分析、AI 成长建议与 TOP5 匹配岗位。
                </div>
              )}

              {/* Existing: Diagnosis trend + Authorization records */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 28, marginBottom: 24 }}>
                {/* Left: diagnoses trend */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <span className="section-label">AI 诊断匹配分数变化趋势</span>
                  {selectedStudent.diagnoses.length === 0 ? (
                    <div className="solid-card" style={{ padding: 40, border: '1px dashed var(--border-light)', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
                      学生暂无诊断记录
                    </div>
                  ) : (
                    <div style={{ height: '220px', background: 'var(--bg-hover)', borderRadius: 12, padding: 10 }}>
                      <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>加载图表中...</div>}>
                        <ReactECharts option={getStudentGrowthOption()} style={{ height: '100%', width: '100%' }} />
                      </React.Suspense>
                    </div>
                  )}
                </div>

                {/* Right: authorizations */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <span className="section-label">学生主动授权记录 ({selectedStudent.authorizations.length})</span>
                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '240px' }}>
                    {selectedStudent.authorizations.length === 0 ? (
                      <div className="solid-card" style={{ padding: 40, border: '1px dashed var(--border-light)', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        该学生尚未向任何企业授权画像数据。
                      </div>
                    ) : (
                      selectedStudent.authorizations.map((auth: any) => (
                        <div key={auth.id} className="auth-row" style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, transition: 'border-color 0.2s' }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{auth.job_title}</div>
                            <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>意向企业：{auth.enterprise_name}</div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span className={auth.status === 'active' ? 'badge badge-success' : 'badge badge-neutral'}>
                              {auth.status === 'active' ? '授权中' : '已撤销'}
                            </span>
                            <div style={{ color: 'var(--text-tertiary)', fontSize: 10, marginTop: 4 }}>
                              {auth.created_at ? new Date(auth.created_at).toLocaleDateString() : ''}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Gap 4: Admin recommend to enterprise */}
                  <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 12, marginTop: 4 }}>
                    <span className="section-label" style={{ marginBottom: 8, display: 'block' }}>推荐给企业岗位</span>
                    {recommendResult ? (
                      <div style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        fontSize: 12,
                        background: recommendResult.success ? 'rgba(52, 199, 89, 0.1)' : 'rgba(255, 59, 48, 0.1)',
                        color: recommendResult.success ? '#34c759' : '#ff3b30',
                        border: `1px solid ${recommendResult.success ? 'rgba(52, 199, 89, 0.3)' : 'rgba(255, 59, 48, 0.3)'}`,
                      }}>
                        {recommendResult.message}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select
                          value={selectedRecommendJobId}
                          onChange={(e) => setSelectedRecommendJobId(e.target.value)}
                          style={{
                            flex: 1, minWidth: 140, padding: '6px 10px',
                            borderRadius: 6, border: '1px solid var(--border-light)',
                            background: 'var(--bg-hover)', color: 'var(--text-primary)',
                            fontSize: 12,
                          }}
                        >
                          <option value="">-- 选择岗位 --</option>
                          {approvedJobsForRecommend.map((job: any) => (
                            <option key={job.id} value={job.id}>
                              [{job.enterprise_name}] {job.title}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!selectedRecommendJobId || recommending}
                          onClick={async () => {
                            if (!selectedRecommendJobId || !selectedStudent) return
                            setRecommending(true)
                            setRecommendResult(null)
                            try {
                              const result = await recommendStudentToEnterprise(selectedStudent.student.id, selectedRecommendJobId)
                              const enterpriseName = result.enterprise_name || '企业'
                              const jobTitle = result.job_title || '岗位'
                              setRecommendResult({
                                success: true,
                                message: `✓ 已成功推荐给「${enterpriseName}」的「${jobTitle}」${result.action === 'reactivated' ? '（重新激活已撤销的授权）' : ''}`,
                              })
                              // Refresh student detail to show updated authorization
                              const detail = await getAdminStudentDetail(selectedStudent.student.id)
                              setSelectedStudent(detail)
                            } catch (err: any) {
                              const msg = err?.response?.data?.detail || err?.message || '推荐失败'
                              setRecommendResult({ success: false, message: `✗ ${msg}` })
                            } finally {
                              setRecommending(false)
                              setSelectedRecommendJobId('')
                            }
                          }}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {recommending ? '推荐中...' : '推荐'}
                        </button>
                        {recommendResult === null && approvedJobsForRecommend.length === 0 && (
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>暂无已审核岗位可推荐</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Gap 8: Attachments + Growth tasks summary */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
                {/* Attachments */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span className="section-label">附件材料 ({selectedStudent.attachments?.length || 0})</span>
                  <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(selectedStudent.attachments || []).length === 0 ? (
                      <div className="solid-card" style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)', border: '1px dashed var(--border-light)' }}>
                        暂无附件材料
                      </div>
                    ) : (
                      (selectedStudent.attachments || []).map((att: any) => (
                        <div key={att.id} style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 10, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.file_name}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 }}>
                              {att.category === 'transcript' ? '成绩单' : att.category === 'language_certificate' ? '语言证明' : '其他'} · {(att.file_size / 1024).toFixed(0)} KB
                            </div>
                          </div>
                          <div style={{ color: 'var(--text-tertiary)', fontSize: 10, textAlign: 'right', marginLeft: 12 }}>
                            {att.uploaded_at ? new Date(att.uploaded_at).toLocaleDateString() : ''}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Growth tasks summary */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span className="section-label">成长任务进度</span>
                  {selectedStudent.growth_tasks_summary ? (
                    <div className="solid-card" style={{ padding: 20 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent-primary)' }}>{selectedStudent.growth_tasks_summary.total || 0}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>总任务数</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent-success)' }}>{selectedStudent.growth_tasks_summary.completed || 0}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>已完成</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent-warning)' }}>{selectedStudent.growth_tasks_summary.in_progress || 0}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>进行中</div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-tertiary)' }}>{selectedStudent.growth_tasks_summary.pending || 0}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>待开始</div>
                        </div>
                      </div>
                      {/* Mini progress bar */}
                      <div style={{ marginTop: 14, height: 6, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden' }}>
                        {selectedStudent.growth_tasks_summary.total > 0 && (
                          <div style={{ height: '100%', width: `${(selectedStudent.growth_tasks_summary.completed / selectedStudent.growth_tasks_summary.total) * 100}%`, background: 'var(--accent-success)', borderRadius: 3, transition: 'width 0.5s' }} />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="solid-card" style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)', border: '1px dashed var(--border-light)' }}>
                      暂无成长任务数据
                    </div>
                  )}
                </div>
              </div>

              {/* AI 决策追踪 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <span className="section-label">AI 决策追踪</span>
                {tracesLoading ? (
                  <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>加载中...</div>
                ) : (
                  <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                    <TraceTimeline traces={studentTraces} />
                  </div>
                )}
              </div>
            </div>

            <div style={{ padding: '16px 30px', borderTop: '1px solid var(--border-light)', background: 'var(--bg-hover)', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setShowStudentModal(false)} style={{ background: 'var(--accent-warning)' }}>
                关闭档案
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Reason input dialog */}
      {showRejectModal && (
        <div className="modal-overlay">
          <div className="modal-panel" style={{
            width: '90%',
            maxWidth: '450px',
            padding: 24,
            gap: 16
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>填写驳回审核原因</h3>
            <form onSubmit={handleConfirmReject} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <textarea
                  required
                  rows={4}
                  placeholder="请详细描述驳回原因，例如：招聘要求描述不完整，或提取的技术指标要求与行业常规不符，请重新编辑后再提交。"
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowRejectModal(false)}>取消</button>
                <button type="submit" className="btn btn-danger">确认驳回</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Enterprise modal */}
      {showCreateEntModal && (
        <div className="modal-overlay">
          <div className="modal-panel animate-slide-up" style={{
            width: '90%',
            maxWidth: '480px',
            padding: 24,
            gap: 16
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>新增合作企业</h3>
              <button
                onClick={() => setShowCreateEntModal(false)}
                className="modal-close-btn"
                style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                &times;
              </button>
            </div>
            <form onSubmit={handleCreateEnterprise} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  企业名称 <span style={{ color: 'var(--accent-danger)' }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如：示例科技有限公司"
                  value={createEntForm.name}
                  onChange={e => setCreateEntForm(prev => ({ ...prev, name: e.target.value }))}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div className="form-group">
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  所属行业
                </label>
                <input
                  type="text"
                  placeholder="例如：互联网、金融、制造业"
                  value={createEntForm.industry}
                  onChange={e => setCreateEntForm(prev => ({ ...prev, industry: e.target.value }))}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    联系人
                  </label>
                  <input
                    type="text"
                    placeholder="例如：张老师"
                    value={createEntForm.contact_name}
                    onChange={e => setCreateEntForm(prev => ({ ...prev, contact_name: e.target.value }))}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                      color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div className="form-group">
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    联系邮箱
                  </label>
                  <input
                    type="email"
                    placeholder="hr@example.com"
                    value={createEntForm.contact_email}
                    onChange={e => setCreateEntForm(prev => ({ ...prev, contact_email: e.target.value }))}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                      color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
              <div className="form-group">
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  初始状态
                </label>
                <select
                  value={createEntForm.status}
                  onChange={e => setCreateEntForm(prev => ({ ...prev, status: e.target.value }))}
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                    color: 'var(--text-primary)', fontSize: 13, outline: 'none', cursor: 'pointer',
                  }}
                >
                  <option value="active">直接启用（企业可立即登录）</option>
                  <option value="pending">待审核（需手动启用）</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreateEntModal(false)}>取消</button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createEntLoading}
                  style={{ background: 'var(--accent-primary)' }}
                >
                  {createEntLoading ? '添加中...' : '确认添加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
    </>
  )
}
