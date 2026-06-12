// 个人信息输入页——桌面双栏工作台布局：左侧目录 | 右侧主编辑区
import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { createStudent, updateStudent, listJobs, getHealthStatus, getStudentJobs, login, setAuthToken, parseResume, uploadResumeFile, getAuthToken } from '../services/api'
import ThemeToggle from '../components/shared/ThemeToggle'
import { toast } from '../utils/toast'

const ALLOWED_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']
const MAX_SIZE_MB = 10

const skillLevels = [
  { value: '精通', label: '精通' },
  { value: '熟练', label: '熟练' },
  { value: '良好', label: '良好' },
  { value: '了解', label: '了解' },
  { value: '入门', label: '入门' },
]
const gradeOptions = ['大一', '大二', '大三', '大四', '研一', '研二', '研三']
const eduLevels = ['专科', '本科', '硕士', '博士']
const jobTypes = ['实习', '校招', '全职']

// 目录项（9 组，无 emoji）
const NAV_ITEMS = [
  { key: 'basic', label: '基本信息', required: true },
  { key: 'education', label: '教育经历', required: true },
  { key: 'intention', label: '求职意向', required: true },
  { key: 'experience', label: '实习与实践', required: false },
  { key: 'project', label: '项目经历', required: false },
  { key: 'skills', label: '技能与证书', required: true },
  { key: 'achievements', label: '奖励与成果', required: false },
  { key: 'self_eval', label: '自我评价', required: false },
  { key: 'attachments', label: '附件材料', required: false },
]

// 默认表单状态
function defaultForm() {
  return {
    name: '', grade: '', education_level: '', school: '', major: '',
    phone: '', email: '',
    // 教育经历
    rank_description: '', english_level: '',
    // 求职意向
    target_job: '', expected_industry: '', job_type: '', available_date: '',
    // 经历数组
    internship_exp: [] as any[],
    project_exp: [] as any[],
    campus_exp: [] as any[],
    awards: [] as any[],
    skills: [] as any[],
    publications: [] as any[],
    // 自我评价
    self_evaluation: '',
    // 旧字段兼容
    tech_skills: {} as Record<string, number>,
    soft_skills: {} as Record<string, number>,
    domain_knowledge: {} as Record<string, number>,
    academic_foundation: {} as any,
    soft_skill_evidence: {} as any,
    resume_text: '',
    summary: '',
  }
}

function humanFileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

// 计算完整度
function calcCompleteness(form: ReturnType<typeof defaultForm>): { total: number; filled: number; pct: number; missing: string[] } {
  const required = [
    { field: 'name', label: '姓名' },
    { field: 'grade', label: '年级' },
    { field: 'education_level', label: '学历' },
    { field: 'school', label: '学校' },
    { field: 'major', label: '专业' },
    { field: 'target_job', label: '目标岗位' },
  ]
  const recommended = [
    { check: () => form.rank_description || form.english_level, label: '成绩/英语' },
    { check: () => form.internship_exp.length > 0, label: '实习经历' },
    { check: () => form.campus_exp.length > 0, label: '社会实践' },
    { check: () => form.awards.length > 0, label: '奖励荣誉' },
    { check: () => form.publications.length > 0, label: '论文/专利' },
    { check: () => form.self_evaluation.trim().length > 0, label: '自我评价' },
    { check: () => form.phone || form.email, label: '联系方式' },
  ]

  let filled = 0
  const missing: string[] = []
  // 必填
  for (const r of required) {
    if ((form as any)[r.field]?.trim()) { filled++ } else { missing.push(r.label + '（必填）') }
  }
  // 技能>=1
  if (form.skills.length >= 1) { filled++ } else { missing.push('至少1项技能（必填）') }
  // 项目或实习>=1
  if (form.project_exp.length >= 1 || form.internship_exp.length >= 1) { filled++ } else { missing.push('至少1段项目或实习（必填）') }
  // 推荐
  for (const r of recommended) {
    if (r.check()) { filled++ } else { missing.push(r.label) }
  }
  const total = required.length + 2 + recommended.length
  return { total, filled, pct: Math.round(filled / total * 100), missing }
}

export default function ProfileInput() {
  const navigate = useNavigate()
  const location = useLocation()
  const fromDashboard = location.state?.fromDashboard
  const [hasJumped, setHasJumped] = useState(false)
  const [aiStatus, setAiStatus] = useState<'configured' | 'missing_key' | 'checking'>('checking')
  const [activeSection, setActiveSection] = useState('basic')
  const [step, setStep] = useState<'form' | 'parsing' | 'submitting'>('form')
  const [resumeFile, setResumeFile] = useState<File | null>(null)
  const [resumeText, setResumeText] = useState('')
  const [parseError, setParseError] = useState('')
  const [error, setError] = useState('')
  const [systemJobs, setSystemJobs] = useState<any[]>([])
  const [entJobs, setEntJobs] = useState<any[]>([])
  const [form, setForm] = useState(defaultForm)
  const [showUploadModal, setShowUploadModal] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const newSkillRef = useRef<HTMLInputElement>(null)
  const newLevelRef = useRef<HTMLSelectElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  const { setStudent, setJobs, setDiagnosisResult, student: existingStudent, hydrateFromStorage } = useAppStore()

  const DRAFT_KEY = 'zhida_profile_draft'

  // 初始化
  useEffect(() => { hydrateFromStorage() }, [])
  useEffect(() => {
    getHealthStatus().then(r => setAiStatus(r.ai_status === 'configured' ? 'configured' : 'missing_key')).catch(() => setAiStatus('missing_key'))
  }, [])
  useEffect(() => {
    listJobs().then(setSystemJobs).catch(() => {})
    if (getAuthToken()) {
      getStudentJobs().then(setEntJobs).catch(() => {})
    }
  }, [])

  // 自动保存草稿到 localStorage（防抖 800ms）
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const draft = JSON.stringify(form)
        localStorage.setItem(DRAFT_KEY, draft)
      } catch { /* quota exceeded 等错误静默忽略 */ }
    }, 800)
    return () => clearTimeout(timer)
  }, [form])

  // 页面加载时恢复草稿（仅在没有已保存档案且非从 Dashboard 返回时）
  useEffect(() => {
    if (existingStudent?.id || fromDashboard) return
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const draft = JSON.parse(raw)
        if (draft && typeof draft === 'object' && (draft.name || draft.school || draft.skills?.length)) {
          setForm(prev => ({ ...prev, ...draft }))
          toast.info('已恢复上次未提交的档案草稿')
        }
      }
    } catch { /* 解析失败静默忽略 */ }
  }, [])

  // Scrollspy: 滚动时左侧目录自动高亮
  useEffect(() => {
    const container = editorRef.current
    if (!container) return
    const sections = container.querySelectorAll<HTMLElement>('section[id^="section-"]')
    if (sections.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        // 找到最上方可见的 section
        let topKey = ''
        let topY = Infinity
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const rect = entry.boundingClientRect
            if (rect.top < topY) {
              topY = rect.top
              topKey = (entry.target as HTMLElement).id.replace('section-', '')
            }
          }
        }
        if (topKey) setActiveSection(topKey)
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )
    sections.forEach(s => observer.observe(s))
    return () => observer.disconnect()
  }, [])

  // 从 Dashboard 返回编辑时预填
  useEffect(() => {
    if (existingStudent && fromDashboard && !hasJumped) {
      setForm(prev => ({
        ...prev,
        name: existingStudent.name || '',
        grade: existingStudent.grade || '',
        major: existingStudent.major || '',
        target_job: existingStudent.target_job || '',
        tech_skills: existingStudent.tech_skills || {},
        soft_skills: existingStudent.soft_skills || {},
        domain_knowledge: existingStudent.domain_knowledge || {},
        academic_foundation: existingStudent.academic_foundation || {},
        soft_skill_evidence: existingStudent.soft_skill_evidence || {},
        resume_text: existingStudent.resume_text || '',
        school: (existingStudent as any).school || existingStudent.major || '',
        education_level: (existingStudent as any).education_level || '',
        phone: (existingStudent as any).phone || '',
        email: (existingStudent as any).email || '',
        self_evaluation: (existingStudent as any).self_evaluation || '',
        ...(existingStudent as any).profile_sections ? mapProfileSections((existingStudent as any).profile_sections) : {},
      }))
      setHasJumped(true)
    }
  }, [existingStudent, fromDashboard, hasJumped])

  // 将 profile_sections 映射到 form 字段
  function mapProfileSections(ps: any) {
    if (!ps || typeof ps !== 'object') return {}
    const result: any = {}
    if (ps.education) {
      result.rank_description = ps.education.rank_description || ''
      result.english_level = ps.education.english_level || ''
    }
    if (ps.job_intention) {
      result.expected_industry = ps.job_intention.expected_industry || ''
      result.job_type = ps.job_intention.job_type || ''
      result.available_date = ps.job_intention.available_date || ''
    }
    if (ps.internship_exp?.length) result.internship_exp = ps.internship_exp
    if (ps.project_exp?.length) result.project_exp = ps.project_exp
    if (ps.campus_exp?.length) result.campus_exp = ps.campus_exp
    if (ps.awards?.length) result.awards = ps.awards
    if (ps.skills?.length) result.skills = ps.skills
    if (ps.publications?.length) result.publications = ps.publications
    if (ps.self_evaluation) result.self_evaluation = ps.self_evaluation
    return result
  }

  // AI 解析后将结果映射到表单
  // 重要：先重置所有可解析字段为默认值，防止上一份简历的旧数据残留。
  // 解析不出的字段保持空白，不再 fallback 到旧值。
  function applyParsedResult(result: any) {
    const fresh = defaultForm()
    setForm(prev => ({
      ...fresh,
      resume_text: resumeText || prev.resume_text,
      name: result.name || '',
      grade: result.grade || '',
      major: result.major || '',
      target_job: result.target_job || '',
      tech_skills: result.tech_skills || {},
      soft_skills: result.soft_skills || {},
      domain_knowledge: result.domain_knowledge || {},
      academic_foundation: result.academic_foundation || {},
      soft_skill_evidence: result.soft_skill_evidence || {},
      summary: result.summary || '',
      ...(result.profile_sections ? mapProfileSections(result.profile_sections) : {}),
      ...(result.profile_sections?.basic_info ? {
        school: result.profile_sections.basic_info.school || '',
        education_level: result.profile_sections.basic_info.education_level || '',
        phone: result.profile_sections.basic_info.phone || '',
        email: result.profile_sections.basic_info.email || '',
      } : {}),
      ...(result.tech_skills && Object.keys(result.tech_skills).length > 0 && !result.profile_sections?.skills?.length
        ? { skills: Object.entries(result.tech_skills).map(([name, score]) => ({ name, level: scoreToLevel(score as number), description: '' })) }
        : {}),
      ...(result.project_exp && result.project_exp.length > 0 && !result.profile_sections?.project_exp?.length
        ? { project_exp: result.project_exp.map((p: any) => ({ project_name: p.name || '', project_role: p.role || '', description: p.description || '', start_date: '', end_date: '' })) }
        : {}),
    }))
  }

  function scoreToLevel(score: number): string {
    if (score >= 85) return '精通'
    if (score >= 70) return '熟练'
    if (score >= 55) return '良好'
    if (score >= 40) return '了解'
    return '入门'
  }

  // 文件处理
  const handleFileDrop = (files: FileList) => {
    const file = files[0]
    if (!file) return
    if (!ALLOWED_TYPES.includes(file.type) && file.type !== '') return
    if (file.size > MAX_SIZE_MB * 1048576) return
    setResumeFile(file)
  }

  // AI 解析
  const handleParse = async () => {
    if (!resumeText.trim() && !resumeFile) { setParseError('请先上传简历文件或粘贴简历内容'); return }
    setParseError('')
    setStep('parsing')
    try {
      let result
      if (resumeFile) { result = await uploadResumeFile(resumeFile) } else { result = await parseResume(resumeText) }
      applyParsedResult(result)
      setStep('form')
      setShowUploadModal(false)
    } catch (e: any) {
      setParseError(e?.response?.data?.detail || e?.message || 'AI解析失败')
      setStep('form')
    }
  }

  const updateForm = (field: string, value: any) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  // 添加经历条目
  const addItem = (field: string, template: any) => {
    setForm(prev => ({ ...prev, [field]: [...(prev as any)[field], template] }))
  }
  const updateItem = (field: string, index: number, key: string, value: any) => {
    setForm(prev => {
      const arr = [...(prev as any)[field]]
      arr[index] = { ...arr[index], [key]: value }
      return { ...prev, [field]: arr }
    })
  }
  const removeItem = (field: string, index: number) => {
    setForm(prev => ({ ...prev, [field]: (prev as any)[field].filter((_: any, i: number) => i !== index) }))
  }

  // 构建 profile_sections 提交对象
  function buildProfileSections() {
    return {
      basic_info: { name: form.name, grade: form.grade, school: form.school, education_level: form.education_level, major: form.major, phone: form.phone, email: form.email },
      education: { school: form.school, education_level: form.education_level, major: form.major, rank_description: form.rank_description, english_level: form.english_level },
      job_intention: { target_job: form.target_job, expected_industry: form.expected_industry, job_type: form.job_type, available_date: form.available_date },
      internship_exp: form.internship_exp,
      project_exp: form.project_exp,
      campus_exp: form.campus_exp,
      awards: form.awards,
      skills: form.skills,
      publications: form.publications,
      self_evaluation: form.self_evaluation,
    }
  }

  // 提交
  const handleSubmit = async () => {
    // 必填校验
    const errs: string[] = []
    if (!form.name.trim()) errs.push('姓名')
    if (!form.grade) errs.push('年级')
    if (!form.education_level) errs.push('学历')
    if (!form.school.trim()) errs.push('学校')
    if (!form.major.trim()) errs.push('专业')
    if (!form.target_job) errs.push('目标岗位')
    if (form.skills.length < 1) errs.push('至少1项技能')
    if (form.project_exp.length < 1 && form.internship_exp.length < 1) errs.push('至少1段项目或实习经历')
    if (errs.length > 0) {
      setError(`请先完善以下必填项：${errs.join('、')}`)
      // 滚动到第一个缺失的 section
      let targetKey = 'basic'
      if (!form.name.trim() || !form.grade || !form.education_level || !form.school.trim() || !form.major.trim()) targetKey = 'basic'
      else if (!form.target_job) targetKey = 'intention'
      else if (form.skills.length < 1) targetKey = 'skills'
      else targetKey = 'project'
      scrollToSection(targetKey)
      return
    }
    setError('')
    setStep('submitting')
    try {
      const payload = {
        name: form.name, grade: form.grade, major: form.major, target_job: form.target_job,
        tech_skills: form.tech_skills, soft_skills: form.soft_skills,
        domain_knowledge: form.domain_knowledge,
        project_exp: form.project_exp.map(p => ({ name: p.project_name || '', role: p.project_role || '', description: p.description || '', duration: '' })),
        resume_text: form.resume_text,
        academic_foundation: form.academic_foundation,
        soft_skill_evidence: form.soft_skill_evidence,
        school: form.school, education_level: form.education_level,
        phone: form.phone, email: form.email,
        self_evaluation: form.self_evaluation,
        profile_sections: buildProfileSections(),
      }
      let student
      if (existingStudent?.id) {
        student = await updateStudent(existingStudent.id, payload)
      } else {
        student = await createStudent(payload)
      }
      setStudent(student)
      localStorage.setItem('student_id', String(student.id))
      localStorage.removeItem(DRAFT_KEY) // 提交成功清除草稿
      const loginResult = await login('student', String(student.id))
      setAuthToken(loginResult.access_token)
      listJobs().then(jobs => setJobs(jobs)).catch(() => {})
      setDiagnosisResult(null)
      navigate('/student/dashboard')
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.response?.data?.error || ''
      setError(detail || e?.message || '提交失败')
      setStep('form')
    }
  }

  const completeness = calcCompleteness(form)

  // ====== 渲染表单区域 ======
  const renderSectionByKey = (key: string) => {
    switch (key) {
      case 'basic': return renderBasicInfo()
      case 'education': return renderEducation()
      case 'intention': return renderIntention()
      case 'experience': return renderExperience()
      case 'project': return renderProject()
      case 'skills': return renderSkills()
      case 'achievements': return renderAchievements()
      case 'self_eval': return renderSelfEval()
      case 'attachments': return renderAttachments()
      default: return null
    }
  }

  // 侧栏点击：平滑滚动到对应 section
  const scrollToSection = (key: string) => {
    const el = document.getElementById(`section-${key}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function renderBasicInfo() {
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">基本信息 <span className="required-tag">必填</span></div>
        <p className="profile-section-desc">填写你的基础信息，用于档案建立和 AI 诊断。</p>
        <div className="profile-form-grid">
          <div className="form-group">
            <label>姓名 <span className="req">*</span></label>
            <input value={form.name} onChange={e => updateForm('name', e.target.value)} placeholder="你的姓名" />
          </div>
          <div className="form-group">
            <label>学历 <span className="req">*</span></label>
            <select value={form.education_level} onChange={e => updateForm('education_level', e.target.value)}>
              <option value="">选择学历</option>
              {eduLevels.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>学校 <span className="req">*</span></label>
            <input value={form.school} onChange={e => updateForm('school', e.target.value)} placeholder="所在学校" />
          </div>
          <div className="form-group">
            <label>专业 <span className="req">*</span></label>
            <input value={form.major} onChange={e => updateForm('major', e.target.value)} placeholder="所学专业" />
          </div>
          <div className="form-group">
            <label>年级 <span className="req">*</span></label>
            <select value={form.grade} onChange={e => updateForm('grade', e.target.value)}>
              <option value="">选择年级</option>
              {gradeOptions.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>手机</label>
            <input value={form.phone} onChange={e => updateForm('phone', e.target.value)} placeholder="选填" />
          </div>
          <div className="form-group full-width">
            <label>邮箱</label>
            <input value={form.email} onChange={e => updateForm('email', e.target.value)} placeholder="选填" />
          </div>
        </div>
      </div>
    )
  }

  function renderEducation() {
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">教育经历</div>
        <p className="profile-section-desc">补充成绩和英语水平，用于岗位匹配参考。</p>
        <div className="profile-form-grid">
          <div className="form-group">
            <label>专业排名 / 成绩说明</label>
            <input value={form.rank_description} onChange={e => updateForm('rank_description', e.target.value)} placeholder="如：专业前 20%，成绩整体良好" />
          </div>
          <div className="form-group">
            <label>英语水平</label>
            <input value={form.english_level} onChange={e => updateForm('english_level', e.target.value)} placeholder="如：CET-6 520、IELTS 7.0" />
          </div>
        </div>
        <p className="field-hint">不强制要求 GPA，可填写排名或成绩概述。</p>
      </div>
    )
  }

  function renderIntention() {
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">求职意向 <span className="required-tag">必填</span></div>
        <p className="profile-section-desc">告诉我们你的目标方向，用于精准岗位匹配。</p>
        <div className="profile-form-grid">
          <div className="form-group">
            <label>目标岗位 <span className="req">*</span></label>
            <select value={form.target_job} onChange={e => updateForm('target_job', e.target.value)}>
              <option value="">选择目标岗位</option>
              {systemJobs.length > 0 && (
                <optgroup label="系统职业方向">
                  {systemJobs.map(j => <option key={j.title} value={j.title}>{j.title}</option>)}
                </optgroup>
              )}
              {entJobs.length > 0 && (
                <optgroup label="企业在招岗位">
                  {entJobs.map(j => <option key={j.id} value={j.title}>{j.title} ({j.enterprise_name})</option>)}
                </optgroup>
              )}
            </select>
          </div>
          <div className="form-group">
            <label>期望行业</label>
            <input value={form.expected_industry} onChange={e => updateForm('expected_industry', e.target.value)} placeholder="如：互联网、金融、教育" />
          </div>
          <div className="form-group">
            <label>求职类型</label>
            <select value={form.job_type} onChange={e => updateForm('job_type', e.target.value)}>
              <option value="">选择类型</option>
              {jobTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>可到岗时间</label>
            <input value={form.available_date} onChange={e => updateForm('available_date', e.target.value)} placeholder="如：2026年7月" />
          </div>
        </div>
      </div>
    )
  }

  // 实习与实践（合并实习 + 校园实践）
  function renderExperience() {
    return (
      <>
        <div className="profile-section-card">
          <div className="profile-section-title">实习经历</div>
          <p className="profile-section-desc">记录你的实习经验，包含企业信息和主要工作成果。</p>
          {form.internship_exp.length === 0 && <p className="empty-hint">暂无实习经历，点击下方按钮添加</p>}
          {form.internship_exp.map((item: any, i: number) => (
            <div key={i} className="profile-entry-card">
              <div className="entry-card-header">
                <span>实习 #{i + 1}</span>
                <button className="remove-btn" onClick={() => removeItem('internship_exp', i)}>删除</button>
              </div>
              <div className="profile-form-grid">
                <div className="form-group"><label>企业名称</label><input value={item.company_name || ''} onChange={e => updateItem('internship_exp', i, 'company_name', e.target.value)} placeholder="公司名" /></div>
                <div className="form-group"><label>职位</label><input value={item.position_name || ''} onChange={e => updateItem('internship_exp', i, 'position_name', e.target.value)} placeholder="职位名" /></div>
                <div className="form-group"><label>开始时间</label><input value={item.start_date || ''} onChange={e => updateItem('internship_exp', i, 'start_date', e.target.value)} placeholder="2025-06" /></div>
                <div className="form-group"><label>结束时间</label><input value={item.end_date || ''} onChange={e => updateItem('internship_exp', i, 'end_date', e.target.value)} placeholder="2025-09" /></div>
                <div className="form-group"><label>证明人姓名</label><input value={item.certifier_name || ''} onChange={e => updateItem('internship_exp', i, 'certifier_name', e.target.value)} /></div>
                <div className="form-group"><label>证明人联系方式</label><input value={item.certifier_contact || ''} onChange={e => updateItem('internship_exp', i, 'certifier_contact', e.target.value)} /></div>
                <div className="form-group full-width"><label>工作描述</label><textarea value={item.description || ''} onChange={e => updateItem('internship_exp', i, 'description', e.target.value)} rows={3} placeholder="描述主要工作职责和成果" /></div>
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm add-more-btn" onClick={() => addItem('internship_exp', { start_date: '', end_date: '', company_name: '', position_name: '', certifier_name: '', certifier_title: '', certifier_contact: '', description: '' })}>+ 添加实习经历</button>
        </div>

        <div className="profile-section-card">
          <div className="profile-section-title">社会实践 / 校内活动</div>
          <p className="profile-section-desc">记录校园活动和社会实践经验。</p>
          {form.campus_exp.length === 0 && <p className="empty-hint">暂无社会实践记录</p>}
          {form.campus_exp.map((item: any, i: number) => (
            <div key={i} className="profile-entry-card">
              <div className="entry-card-header">
                <span>活动 #{i + 1}</span>
                <button className="remove-btn" onClick={() => removeItem('campus_exp', i)}>删除</button>
              </div>
              <div className="profile-form-grid">
                <div className="form-group"><label>活动/组织名称</label><input value={item.activity_name || ''} onChange={e => updateItem('campus_exp', i, 'activity_name', e.target.value)} /></div>
                <div className="form-group"><label>担任角色</label><input value={item.role || ''} onChange={e => updateItem('campus_exp', i, 'role', e.target.value)} /></div>
                <div className="form-group"><label>开始时间</label><input value={item.start_date || ''} onChange={e => updateItem('campus_exp', i, 'start_date', e.target.value)} /></div>
                <div className="form-group"><label>结束时间</label><input value={item.end_date || ''} onChange={e => updateItem('campus_exp', i, 'end_date', e.target.value)} /></div>
                <div className="form-group full-width"><label>活动描述</label><textarea value={item.description || ''} onChange={e => updateItem('campus_exp', i, 'description', e.target.value)} rows={2} /></div>
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm add-more-btn" onClick={() => addItem('campus_exp', { start_date: '', end_date: '', activity_name: '', role: '', description: '' })}>+ 添加社会实践</button>
        </div>
      </>
    )
  }

  function renderProject() {
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">项目经历 <span className="required-tag">至少1段</span></div>
        <p className="profile-section-desc">描述你参与的项目，包括背景、职责和成果。</p>
        {form.project_exp.length === 0 && <p className="empty-hint">暂无项目经验，点击下方按钮添加</p>}
        {form.project_exp.map((item: any, i: number) => (
          <div key={i} className="profile-entry-card">
            <div className="entry-card-header">
              <span>项目 #{i + 1}</span>
              <button className="remove-btn" onClick={() => removeItem('project_exp', i)}>删除</button>
            </div>
            <div className="profile-form-grid">
              <div className="form-group"><label>项目名称</label><input value={item.project_name || ''} onChange={e => updateItem('project_exp', i, 'project_name', e.target.value)} placeholder="项目名称" /></div>
              <div className="form-group"><label>项目职务</label><input value={item.project_role || ''} onChange={e => updateItem('project_exp', i, 'project_role', e.target.value)} placeholder="如：负责人、前端开发" /></div>
              <div className="form-group"><label>开始时间</label><input value={item.start_date || ''} onChange={e => updateItem('project_exp', i, 'start_date', e.target.value)} placeholder="2025-03" /></div>
              <div className="form-group"><label>结束时间</label><input value={item.end_date || ''} onChange={e => updateItem('project_exp', i, 'end_date', e.target.value)} placeholder="2025-06" /></div>
              <div className="form-group full-width"><label>项目描述</label><textarea value={item.description || ''} onChange={e => updateItem('project_exp', i, 'description', e.target.value)} rows={3} placeholder="描述项目内容、你的角色和成果" /></div>
            </div>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm add-more-btn" onClick={() => addItem('project_exp', { start_date: '', end_date: '', project_name: '', project_role: '', description: '' })}>+ 添加项目经验</button>
      </div>
    )
  }

  function renderSkills() {
    const addSkillItem = () => {
      const name = newSkillRef.current?.value.trim()
      const level = newLevelRef.current?.value || '了解'
      if (name) {
        updateForm('skills', [...form.skills, { name, level, description: '' }])
        if (newSkillRef.current) newSkillRef.current.value = ''
      }
    }
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">技能与证书 <span className="required-tag">至少1项</span></div>
        <p className="profile-section-desc">添加你掌握的技能，至少填写1项。</p>
        {form.skills.length === 0 && <p className="empty-hint">请至少添加1项技能</p>}
        <div className="skills-grid">
          {form.skills.map((s: any, i: number) => (
            <div key={i} className="skill-card-item">
              <div className="skill-card-top">
                <input value={s.name || ''} onChange={e => updateItem('skills', i, 'name', e.target.value)} className="skill-name-input" placeholder="技能名" />
                <select value={s.level || '了解'} onChange={e => updateItem('skills', i, 'level', e.target.value)} className="skill-level-select">
                  {skillLevels.map(l => <option key={l.value} value={l.value}>{l.value}</option>)}
                </select>
                <button className="remove-btn" onClick={() => removeItem('skills', i)}>✕</button>
              </div>
              <input value={s.description || ''} onChange={e => updateItem('skills', i, 'description', e.target.value)} className="skill-desc-input" placeholder="使用场景或说明（选填）" />
            </div>
          ))}
        </div>
        <div className="add-skill-inline">
          <input ref={newSkillRef} placeholder="技能名称" className="inline-input" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSkillItem() } }} />
          <select ref={newLevelRef} className="inline-select">
            {skillLevels.map(l => <option key={l.value} value={l.value}>{l.value}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={addSkillItem}>添加</button>
        </div>
      </div>
    )
  }

  // 奖励与成果（合并奖励 + 论文/专利）
  function renderAchievements() {
    return (
      <>
        <div className="profile-section-card">
          <div className="profile-section-title">奖励荣誉</div>
          <p className="profile-section-desc">记录你获得的奖项和荣誉。</p>
          {form.awards.length === 0 && <p className="empty-hint">暂无奖励荣誉</p>}
          {form.awards.map((item: any, i: number) => (
            <div key={i} className="profile-entry-card">
              <div className="entry-card-header">
                <span>奖项 #{i + 1}</span>
                <button className="remove-btn" onClick={() => removeItem('awards', i)}>删除</button>
              </div>
              <div className="profile-form-grid">
                <div className="form-group"><label>获奖时间</label><input value={item.award_date || ''} onChange={e => updateItem('awards', i, 'award_date', e.target.value)} placeholder="2025-06" /></div>
                <div className="form-group"><label>奖项名称</label><input value={item.award_name || ''} onChange={e => updateItem('awards', i, 'award_name', e.target.value)} placeholder="如：国家奖学金" /></div>
                <div className="form-group"><label>级别</label>
                  <select value={item.level || ''} onChange={e => updateItem('awards', i, 'level', e.target.value)}>
                    <option value="">选择级别</option>
                    <option value="国家级">国家级</option><option value="省级">省级</option><option value="校级">校级</option><option value="院级">院级</option>
                  </select>
                </div>
                <div className="form-group full-width"><label>描述</label><input value={item.description || ''} onChange={e => updateItem('awards', i, 'description', e.target.value)} placeholder="选填" /></div>
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm add-more-btn" onClick={() => addItem('awards', { award_date: '', award_name: '', level: '', description: '' })}>+ 添加奖励</button>
        </div>

        <div className="profile-section-card">
          <div className="profile-section-title">论文 / 专利</div>
          <p className="profile-section-desc">记录发表的论文或获得的专利。</p>
          {form.publications.length === 0 && <p className="empty-hint">暂无论文或专利</p>}
          {form.publications.map((item: any, i: number) => (
            <div key={i} className="profile-entry-card">
              <div className="entry-card-header">
                <span>{item.pub_type || '论文/专利'} #{i + 1}</span>
                <button className="remove-btn" onClick={() => removeItem('publications', i)}>删除</button>
              </div>
              <div className="profile-form-grid">
                <div className="form-group"><label>类型</label>
                  <select value={item.pub_type || ''} onChange={e => updateItem('publications', i, 'pub_type', e.target.value)}>
                    <option value="">选择</option><option value="论文">论文</option><option value="专利">专利</option>
                  </select>
                </div>
                <div className="form-group"><label>名称</label><input value={item.name || ''} onChange={e => updateItem('publications', i, 'name', e.target.value)} /></div>
                <div className="form-group"><label>发表/授权时间</label><input value={item.pub_date || ''} onChange={e => updateItem('publications', i, 'pub_date', e.target.value)} /></div>
                <div className="form-group full-width"><label>描述</label><input value={item.description || ''} onChange={e => updateItem('publications', i, 'description', e.target.value)} /></div>
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm add-more-btn" onClick={() => addItem('publications', { pub_type: '', name: '', pub_date: '', description: '' })}>+ 添加论文/专利</button>
        </div>
      </>
    )
  }

  function renderSelfEval() {
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">自我评价</div>
        <p className="profile-section-desc">简要描述你的特点、职业兴趣和发展方向。</p>
        <div className="form-group">
          <textarea value={form.self_evaluation} onChange={e => updateForm('self_evaluation', e.target.value)} rows={6} placeholder="简要描述你的特点、职业兴趣和发展方向（100-300字即可）" maxLength={1000} />
          <div className="char-counter">{form.self_evaluation.length} / 1000</div>
        </div>
        <p className="field-hint">自我评价作为低权重补充信息，不强制填写。</p>
      </div>
    )
  }

  function renderAttachments() {
    return (
      <div className="profile-section-card">
        <div className="profile-section-title">附件材料</div>
        <div className="attachment-upload-cards">
          <div className="att-upload-card">
            <div className="att-upload-info">
              <strong>成绩单</strong>
            </div>
          </div>
          <div className="att-upload-card">
            <div className="att-upload-info">
              <strong>外语成绩证明</strong>
              <p>CET、IELTS、TOEFL 等证书扫描件</p>
            </div>
          </div>
          <div className="att-upload-card">
            <div className="att-upload-info">
              <strong>其他证明材料</strong>
              <p>获奖证书、实习证明等</p>
            </div>
          </div>
        </div>
        {existingStudent?.id && (
          <div style={{ marginTop: 'var(--space-5)' }}>
            <AttachmentUploader studentId={existingStudent.id} />
          </div>
        )}
        {!existingStudent?.id && (
          <p className="field-hint" style={{ marginTop: 'var(--space-4)', color: 'var(--text-tertiary)' }}>
            提示：请先保存档案，然后返回此页上传附件。
          </p>
        )}
      </div>
    )
  }

  // 解析动画
  if (step === 'parsing') {
    return (
      <div className="profile-input-page">
        <style>{PROFILE_CSS}</style>
        <div className="parsing-overlay" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="parsing-card">
            <div className="parsing-ring" />
            <div className="parsing-title">AI 正在解析简历</div>
            <div className="parsing-sub">{resumeFile ? `正在识别 ${resumeFile.name}` : '正在分析文本内容...'}</div>
            <div className="parsing-dots"><div className="parsing-dot" /><div className="parsing-dot" /><div className="parsing-dot" /></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="profile-input-page">
      <style>{PROFILE_CSS}</style>

      {/* 顶部栏 */}
      <header className="profile-workspace-header">
        <div className="workspace-header-left">
          <button className="brand-link" onClick={() => navigate('/')}>
            <span className="brand-link-mark"><Sparkles size={14} /></span>
            职达
          </button>
          <span className="brand-divider" />
          <div className="workspace-header-info">
            <h2>完善个人档案</h2>
            <span className="workspace-header-sub">用于 AI 诊断、岗位匹配和企业授权展示</span>
          </div>
        </div>
        <div className="workspace-header-right">
          <div className="status-card">
            <div className="status-card-top">
              <span className="status-card-label">档案完整度</span>
              <span className="status-card-pct">{completeness.pct}%</span>
            </div>
            <div className="status-card-bar">
              <div className="status-card-bar-fill" style={{ width: `${completeness.pct}%` }} />
            </div>
            {completeness.missing.length > 0 && completeness.pct < 100 && (
              <div className="status-card-missing">
                还需：{completeness.missing.slice(0, 2).join('、')}{completeness.missing.length > 2 ? ` 等${completeness.missing.length}项` : ''}
              </div>
            )}
          </div>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={step === 'submitting'}>
            {step === 'submitting' ? '提交中...' : '保存并开始诊断'}
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* 双栏工作台 */}
      <div className="profile-workspace">
        {/* 左侧目录 */}
        <nav className="profile-sidebar">
          <div className="sidebar-title">档案目录</div>
          {NAV_ITEMS.map(item => (
            <button
              key={item.key}
              className={`sidebar-item${activeSection === item.key ? ' active' : ''}`}
              onClick={() => scrollToSection(item.key)}
            >
              <span className="sidebar-item-label">{item.label}</span>
              {item.required && <span className="sidebar-item-dot required" />}
              {!item.required && <span className="sidebar-item-dot" />}
            </button>
          ))}
          <div className="sidebar-divider" />
          <button className="sidebar-ai-btn" onClick={() => setShowUploadModal(true)}>
            AI 智能解析简历
          </button>
        </nav>

        {/* 主编辑区 */}
        <main className="profile-editor">
          {/* 所有章节一页展示 */}
          <div ref={editorRef}>
            {NAV_ITEMS.map(item => (
              <section key={item.key} id={`section-${item.key}`} style={{ scrollMarginTop: 80 }}>
                {renderSectionByKey(item.key)}
              </section>
            ))}
          </div>

          {error && <div className="error-alert" style={{ marginTop: 'var(--space-4)' }}>{error}</div>}

          {/* 底部操作栏 */}
          <div className="submit-bar">
            <button className="btn btn-ghost" onClick={() => setShowUploadModal(true)}>上传简历辅助填写</button>
            <button className="btn btn-primary btn-lg" onClick={handleSubmit} disabled={step === 'submitting'}>
              {step === 'submitting' ? '提交中...' : '保存档案并开始诊断'}
            </button>
          </div>
        </main>
      </div>

      {/* 上传简历 Modal */}
      {showUploadModal && (
        <div className="modal-overlay" onClick={() => setShowUploadModal(false)}>
          <div className="modal-panel" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>AI 解析简历</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowUploadModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {aiStatus === 'missing_key' && (
                <div className="ai-warning">
                  <span>⚠️</span>
                  <div><strong>AI 服务未就绪</strong>，请在后端配置大模型密钥</div>
                </div>
              )}
              <div
                className={`upload-zone${aiStatus === 'missing_key' ? ' disabled' : ''}`}
                onClick={() => { if (aiStatus !== 'missing_key') fileInputRef.current?.click() }}
                onDragOver={e => { if (aiStatus !== 'missing_key') e.preventDefault() }}
                onDrop={e => { e.preventDefault(); if (aiStatus !== 'missing_key' && e.dataTransfer.files.length) handleFileDrop(e.dataTransfer.files) }}
              >
                <div className="upload-icon">{resumeFile ? '📄' : '📤'}</div>
                <p className="upload-label">{resumeFile ? `${resumeFile.name}（${humanFileSize(resumeFile.size)}）` : '拖拽简历或点击选择'}</p>
                <p className="upload-hint">PDF / DOCX / TXT，最大 {MAX_SIZE_MB}MB</p>
                <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt" style={{ display: 'none' }} onChange={e => { if (e.target.files) handleFileDrop(e.target.files) }} />
              </div>
              <div className="form-group">
                <label>或粘贴简历文本</label>
                <textarea rows={6} placeholder="粘贴简历内容..." maxLength={10000} value={resumeText} onChange={e => setResumeText(e.target.value)} />
              </div>
              {parseError && <div className="error-alert">{parseError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowUploadModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleParse} disabled={aiStatus === 'missing_key'}>AI 解析并填充</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 附件上传组件（保存档案后可用）
function AttachmentUploader({ studentId }: { studentId: string | number }) {
  const [attachments, setAttachments] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('transcript')

  useEffect(() => {
    import('../services/api').then(api => {
      api.listAttachments(studentId).then(setAttachments).catch(() => {})
    })
  }, [studentId])

  const handleUpload = async (files: FileList) => {
    setUploading(true)
    try {
      const api = await import('../services/api')
      const att = await api.uploadAttachment(studentId, files[0], category)
      setAttachments(prev => [att, ...prev])
    } catch (e: any) {
      toast.error(e.message || '上传失败')
    }
    setUploading(false)
  }

  const handleDelete = async (id: string) => {
    try {
      const api = await import('../services/api')
      await api.deleteAttachment(studentId, id)
      setAttachments(prev => prev.filter(a => a.id !== id))
    } catch {}
  }

  return (
    <div>
      <div className="att-upload-bar">
        <select value={category} onChange={e => setCategory(e.target.value)} className="inline-select" style={{ width: 140 }}>
          <option value="transcript">成绩单</option>
          <option value="language_certificate">外语成绩证明</option>
          <option value="other">其他证明材料</option>
        </select>
        <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? '上传中...' : '选择文件上传'}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.length) handleUpload(e.target.files) }} />
      </div>
      {attachments.length > 0 && (
        <div className="att-list">
          {attachments.map(a => (
            <div key={a.id} className="att-item">
              <span className="att-name">{a.file_name}</span>
              <span className="att-cat">{a.category === 'transcript' ? '成绩单' : a.category === 'language_certificate' ? '外语证明' : '其他'}</span>
              <span className="att-size">{humanFileSize(a.file_size || 0)}</span>
              <button className="remove-btn" onClick={() => handleDelete(a.id)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============== CSS ==============
const PROFILE_CSS = `
  .profile-input-page {
    min-height: 100vh;
    background: var(--bg-page);
    transition: background-color 0.3s;
  }

  /* ── Workspace Header ── */
  .profile-workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 28px;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border-light);
    position: sticky;
    top: 0;
    z-index: 100;
    gap: var(--space-4);
  }
  .workspace-header-left {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .workspace-header-info h2 {
    font-size: 17px;
    font-weight: 700;
    color: var(--text-primary);
    font-family: var(--font-display);
    line-height: 1.3;
  }
  .workspace-header-sub {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .workspace-header-right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-shrink: 0;
  }

  /* Completeness status card */
  .status-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 16px;
    border-radius: var(--radius-md);
    background: var(--bg-page);
    border: 1px solid var(--border-light);
    min-width: 200px;
  }
  .status-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .status-card-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .status-card-pct {
    font-size: 16px;
    font-weight: 700;
    font-family: var(--font-display);
    color: var(--accent-primary);
    letter-spacing: -0.01em;
  }
  .status-card-bar {
    height: 4px;
    border-radius: 2px;
    background: var(--border-light);
    overflow: hidden;
  }
  .status-card-bar-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--accent-primary);
    transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .status-card-missing {
    font-size: 11px;
    color: var(--accent-warning);
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Two-column Workspace ── */
  .profile-workspace {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    max-width: min(1440px, calc(100vw - 48px));
    margin: 0 auto;
    min-height: calc(100vh - 64px);
  }
  @media (max-width: 1100px) {
    .profile-workspace { grid-template-columns: 200px minmax(0, 1fr); }
  }
  @media (max-width: 768px) {
    .profile-workspace { grid-template-columns: 1fr; }
    .profile-sidebar { display: none; }
  }

  /* ── Left Sidebar ── */
  .profile-sidebar {
    border-right: 1px solid var(--border-light);
    padding: var(--space-5) var(--space-3);
    background: var(--bg-card);
    position: sticky;
    top: 64px;
    height: calc(100vh - 64px);
    overflow-y: auto;
  }
  .sidebar-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-tertiary);
    margin-bottom: var(--space-3);
    padding: 0 var(--space-2);
  }
  .sidebar-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 9px 12px;
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    transition: all 0.15s;
    text-align: left;
    margin-bottom: 2px;
    font-family: var(--font-body);
  }
  .sidebar-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .sidebar-item.active {
    background: rgba(0,113,227,0.08);
    color: var(--accent-primary);
    font-weight: 600;
  }
  .sidebar-item-label { flex: 1; }
  .sidebar-item-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-light);
    flex-shrink: 0;
  }
  .sidebar-item-dot.required {
    background: var(--accent-danger);
  }
  .sidebar-divider {
    height: 1px;
    background: var(--border-light);
    margin: var(--space-4) 0;
  }
  .sidebar-ai-btn {
    display: block;
    width: 100%;
    padding: 12px 16px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent-success);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: all 0.2s;
    letter-spacing: 0.2px;
  }
  .sidebar-ai-btn:hover {
    filter: brightness(1.08);
    transform: translateY(-1px);
  }

  /* ── Main Editor ── */
  .profile-editor {
    padding: var(--space-6) var(--space-8);
    max-width: 960px;
    overflow-y: auto;
  }
  @media (max-width: 900px) {
    .profile-editor { padding: var(--space-4); }
  }

  /* ── Section Card ── */
  .profile-section-card {
    background: var(--bg-card);
    border: 1px solid var(--border-card);
    border-radius: var(--radius-xl);
    padding: var(--space-6) 28px;
    margin-bottom: var(--space-5);
    box-shadow: var(--shadow-xs);
    animation: profileCardIn 0.35s ease-out both;
    transition: box-shadow 0.25s ease;
  }
  .profile-section-card:hover {
    box-shadow: var(--shadow-sm);
  }
  @keyframes profileCardIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .profile-section-title {
    font-size: 16px;
    font-weight: 650;
    color: var(--text-primary);
    margin-bottom: var(--space-1);
    font-family: var(--font-display);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
  }
  .profile-section-desc {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    margin-bottom: var(--space-5);
    margin-top: var(--space-3);
    line-height: 1.5;
  }
  .required-tag {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-danger);
    background: rgba(255,59,48,0.08);
    padding: 2px 8px;
    border-radius: 10px;
    margin-left: var(--space-2);
  }
  .req { color: var(--accent-danger); }

  /* ── Form Grid ── */
  .profile-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px 24px;
  }
  .profile-form-grid .full-width { grid-column: 1 / -1; }
  @media (max-width: 700px) { .profile-form-grid { grid-template-columns: 1fr; } }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin-top: var(--space-3);
    line-height: 1.6;
  }
  .empty-hint {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    padding: var(--space-4) 0;
  }

  /* ── Entry Card (experience items) ── */
  .profile-entry-card {
    border: 1px solid var(--border-light);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-3);
    background: var(--bg-page);
    transition: border-color 0.2s;
  }
  .profile-entry-card:hover {
    border-color: var(--border-card);
  }
  .entry-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .remove-btn {
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .remove-btn:hover { color: var(--accent-danger); background: rgba(255,59,48,0.06); }
  .add-more-btn {
    margin-top: var(--space-3);
    width: 100%;
    justify-content: center;
    border: 1px dashed var(--border-light) !important;
    border-radius: var(--radius-md) !important;
    padding: var(--space-2) !important;
  }
  .add-more-btn:hover { border-color: var(--accent-primary) !important; }

  /* ── Skills Grid ── */
  .skills-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  @media (max-width: 700px) { .skills-grid { grid-template-columns: 1fr; } }
  .skill-card-item {
    border: 1px solid var(--border-light);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: var(--bg-page);
  }
  .skill-card-top {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-2);
  }
  .skill-name-input {
    flex: 1;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .skill-name-input:focus { outline: none; border-color: var(--accent-primary); }
  .skill-level-select, .inline-select {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    font-size: 12px;
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .skill-desc-input {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    font-size: 12px;
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .skill-desc-input:focus { outline: none; border-color: var(--accent-primary); }
  .inline-input {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-light);
    font-size: var(--text-sm);
    background: var(--bg-card);
    color: var(--text-primary);
  }
  .inline-input:focus { outline: none; border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(0,113,227,0.1); }
  .add-skill-inline {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  /* ── Attachment Cards ── */
  .attachment-upload-cards {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-3);
    overflow-x: auto;
    padding-bottom: var(--space-1);
  }
  @media (max-width: 700px) { .attachment-upload-cards { flex-direction: column; } }
  .att-upload-card {
    flex: 1;
    min-width: 180px;
    padding: var(--space-4);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-md);
    background: var(--bg-page);
    transition: border-color 0.2s;
  }
  .att-upload-card:hover {
    border-color: var(--accent-primary);
  }
  .att-upload-info strong {
    font-size: 13px;
    color: var(--text-primary);
    display: block;
    margin-bottom: 4px;
  }
  .att-upload-info p {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0;
    line-height: 1.5;
  }
  .att-note {
    margin-top: 6px !important;
    font-size: 11px !important;
    color: var(--text-tertiary);
    opacity: 0.8;
  }

  /* ── Attachment Upload Bar / List ── */
  .att-upload-bar {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    margin-bottom: var(--space-3);
  }
  .att-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .att-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    font-size: 12px;
    background: var(--bg-page);
  }
  .att-name { flex: 1; font-weight: 500; color: var(--text-primary); }
  .att-cat { color: var(--text-tertiary); font-size: 11px; }
  .att-size { color: var(--text-tertiary); }

  /* ── Submit Bar ── */
  .submit-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-5) var(--space-6);
    margin-top: var(--space-4);
    background: var(--bg-card);
    border: 1px solid var(--border-card);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-xs);
  }

  /* ── Error Alert ── */
  .error-alert {
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: rgba(255,59,48,0.06);
    border: 1px solid rgba(255,59,48,0.15);
    color: var(--accent-danger);
    font-size: var(--text-sm);
  }

  /* ── Upload Zone (modal) ── */
  .upload-zone {
    border: 2px dashed var(--border-light);
    border-radius: 16px;
    padding: var(--space-8) var(--space-4);
    text-align: center;
    cursor: pointer;
    background: var(--bg-card);
    margin-bottom: var(--space-4);
    transition: border-color 0.2s, background 0.2s;
  }
  .upload-zone:hover { border-color: var(--accent-primary); background: rgba(0,113,227,0.03); }
  .upload-zone.disabled { cursor: not-allowed; opacity: 0.6; }
  .upload-icon { font-size: 32px; margin-bottom: var(--space-2); color: var(--text-tertiary); }
  .upload-label { font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--space-1); }
  .upload-hint { font-size: var(--text-xs); color: var(--text-tertiary); }
  .ai-warning {
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: rgba(255,59,48,0.06);
    border: 1px solid rgba(255,59,48,0.15);
    color: var(--accent-danger);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
    display: flex;
    gap: var(--space-2);
  }
  .char-counter { text-align: right; color: var(--text-tertiary); font-size: var(--text-xs); margin-top: var(--space-1); }

  /* ── Parsing Overlay ── */
  .parsing-overlay { width: 100%; }
  .parsing-card { text-align: center; padding: var(--space-8); }
  .parsing-ring {
    width: 48px; height: 48px; border: 3px solid var(--border-light);
    border-top-color: var(--accent-primary); border-radius: 50%;
    animation: spin 1s linear infinite; margin: 0 auto var(--space-4);
  }
  .parsing-title { font-size: var(--text-lg); font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-2); }
  .parsing-sub { font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--space-3); }
  .parsing-dots { display: flex; justify-content: center; gap: 8px; }
  .parsing-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--accent-primary);
    animation: bounce 1.4s ease-in-out infinite;
  }
  .parsing-dot:nth-child(2) { animation-delay: 0.2s; }
  .parsing-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }

  /* ── Dark Mode Overrides ── */
  body.dark .status-card { background: rgba(28,28,30,0.6); border-color: rgba(255,255,255,0.06); }
  body.dark .status-card-bar { background: rgba(255,255,255,0.08); }
  body.dark .sidebar-item.active { background: rgba(10,132,255,0.12); }
  body.dark .inline-input:focus { box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
  body.dark .upload-zone:hover { background: rgba(10,132,255,0.06); }
  body.dark .skill-name-input:focus,
  body.dark .skill-desc-input:focus { border-color: var(--accent-primary); }
`
