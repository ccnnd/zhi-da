import axios from 'axios'
import type { AgentIntent, AgentResult } from '../types'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
})

// ============ 认证拦截器 ============

/** 获取本地存储的 token */
export function getAuthToken(): string | null {
  return localStorage.getItem('zhida_token')
}

/** 保存 token */
export function setAuthToken(token: string) {
  localStorage.setItem('zhida_token', token)
}

/** 清除 token 和所有身份缓存 */
export function clearAuth() {
  localStorage.removeItem('zhida_token')
  localStorage.removeItem('zhida_role')
  localStorage.removeItem('zhida_student_id')
  localStorage.removeItem('zhida_enterprise_id')
  localStorage.removeItem('zhida_admin_account')
  localStorage.removeItem('student_id')
  localStorage.removeItem('student_data')
}

// 请求拦截器：自动携带 Authorization header
api.interceptors.request.use(config => {
  const token = getAuthToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器：401 时自动跳转登录页
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      clearAuth()
      if (window.location.pathname !== '/') {
        window.location.href = '/'
      }
    }
    return Promise.reject(error)
  },
)

// ============ 认证 API ============

export interface LoginResult {
  access_token: string
  token_type: string
  expires_at: string
  role: string
  student_id: number
  enterprise_id: string
  admin_account: string
}

export async function login(role: string, identifier: string, password?: string): Promise<LoginResult> {
  const res = await api.post('/auth/login', { role, identifier, password: password || '' })
  return res.data
}

export async function logout() {
  try { await api.post('/auth/logout') } catch {}
  clearAuth()
}

/** 公开接口：获取企业列表（用于登录页下拉选择） */
export async function listEnterprisesForLogin() {
  const res = await api.get('/auth/enterprises')
  return res.data
}

export async function createStudent(data: {
  name: string; grade?: string; major?: string; target_job?: string;
  tech_skills?: Record<string, number>; project_exp?: any[];
  soft_skills?: Record<string, number>; domain_knowledge?: Record<string, number>;
  resume_text?: string;
  academic_foundation?: any;
  soft_skill_evidence?: any;
  school?: string; education_level?: string;
  phone?: string; email?: string;
  self_evaluation?: string;
  profile_sections?: any;
}) {
  const res = await api.post('/students', data)
  return res.data
}

export async function getStudent(id: string | number) {
  const res = await api.get(`/students/${id}`)
  return res.data
}

export async function updateStudent(id: string | number, data: {
  name?: string; grade?: string; major?: string; target_job?: string;
  tech_skills?: Record<string, number>; project_exp?: any[];
  soft_skills?: Record<string, number>; domain_knowledge?: Record<string, number>;
  resume_text?: string;
  academic_foundation?: any;
  soft_skill_evidence?: any;
  school?: string; education_level?: string;
  phone?: string; email?: string;
  self_evaluation?: string;
  profile_sections?: any;
}) {
  const res = await api.put(`/students/${id}`, data)
  return res.data
}

export async function updateSkills(studentId: string | number | number, data: {
  tech_skills?: Record<string, number>
  soft_skills?: Record<string, number>
  domain_knowledge?: Record<string, number>
  project_exp?: any[]
  academic_foundation?: any
  soft_skill_evidence?: any
}) {
  const res = await api.put(`/students/${studentId}/skills`, data)
  return res.data
}

export async function listJobs() {
  const res = await api.get('/jobs')
  return res.data
}

export async function getDiagnosisHistory(studentId: string | number) {
  const res = await api.get(`/diagnosis/history/${studentId}`)
  return res.data
}

export async function getHealthStatus() {
  const res = await api.get('/health')
  return res.data
}

// ---- 简历解析（LLM 耗时较长，单独放宽超时到 5 分钟） ----
export async function parseResume(text: string) {
  const res = await api.post('/resume/parse', { resume_text: text }, { timeout: 300000 })
  return res.data
}
export async function uploadResumeFile(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await api.post('/resume/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 })
  return res.data
}

// ==========================================
// 1. 学生端扩展 API (Student Extension APIs)
// ==========================================
export async function getStudentJobs() {
  const res = await api.get('/student/jobs')
  return res.data
}

export async function getStudentAuthorizations(studentId: string | number) {
  const res = await api.get('/student/authorizations', { params: { student_id: studentId } })
  return res.data
}

export async function createStudentAuthorization(data: { student_id: string; job_post_id: string; diagnosis_id: string }) {
  const res = await api.post('/student/authorizations', data)
  return res.data
}

export async function deleteStudentAuthorization(authId: string) {
  const res = await api.delete(`/student/authorizations/${authId}`)
  return res.data
}

export async function batchCreateStudentAuthorization(data: { student_id: number; job_post_ids: string[]; diagnosis_id: string }) {
  const res = await api.post('/student/authorizations/batch', data)
  return res.data
}

// ==========================================
// 2. 企业端 API (Enterprise APIs)
// ==========================================
export async function getEnterpriseProfile(enterpriseId: string) {
  const res = await api.get('/enterprise/profile', { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function updateEnterpriseProfile(enterpriseId: string, data: {
  name: string; industry?: string; description?: string; contact_name?: string; contact_email?: string;
}) {
  const res = await api.put('/enterprise/profile', data, { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function getEnterpriseJobs(enterpriseId: string) {
  const res = await api.get('/enterprise/jobs', { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function createEnterpriseJob(enterpriseId: string, data: {
  title: string; category?: string; description?: string; requirements_text?: string; status?: string;
}) {
  const res = await api.post('/enterprise/jobs', data, { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function getEnterpriseJobDetail(jobId: string, enterpriseId: string) {
  const res = await api.get(`/enterprise/jobs/${jobId}`, { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function updateEnterpriseJob(jobId: string, enterpriseId: string, data: {
  title: string; category?: string; description?: string; requirements_text?: string; status?: string;
}) {
  const res = await api.put(`/enterprise/jobs/${jobId}`, data, { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function parseJobAbilityModel(jobId: string, enterpriseId: string) {
  const res = await api.post(`/enterprise/jobs/${jobId}/parse-ability`, {}, { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function submitJobReview(jobId: string, enterpriseId: string) {
  const res = await api.post(`/enterprise/jobs/${jobId}/submit-review`, {}, { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function getEnterpriseCandidates(enterpriseId: string) {
  const res = await api.get('/enterprise/candidates', { params: { enterprise_id: enterpriseId } })
  return res.data
}

export async function getEnterpriseCandidateDetail(studentId: string | number, authId: string, enterpriseId: string) {
  const res = await api.get(`/enterprise/candidates/${studentId}`, { params: { auth_id: authId, enterprise_id: enterpriseId } })
  return res.data
}

// ==========================================
// 3. 学校端/管理员 API (School Admin APIs)
// ==========================================
export async function getAdminSummary() {
  const res = await api.get('/admin/summary')
  return res.data
}

export async function listAdminStudents(page = 1, pageSize = 20, diagnosisStatus?: string) {
  const params: Record<string, any> = { page, page_size: pageSize }
  if (diagnosisStatus) params.diagnosis_status = diagnosisStatus
  const res = await api.get('/admin/students', { params })
  return res.data
}

export async function getAdminStudentDetail(studentId: string | number) {
  const res = await api.get(`/admin/students/${studentId}`)
  return res.data
}

export async function getAdminStudentTraces(studentId: string | number, limit = 20) {
  const res = await api.get(`/admin/students/${studentId}/traces`, { params: { limit } })
  return res.data
}

export async function listAdminEnterprises(page = 1, pageSize = 20) {
  const res = await api.get('/admin/enterprises', { params: { page, page_size: pageSize } })
  return res.data
}

export async function getAdminEnterpriseDetail(enterpriseId: string) {
  const res = await api.get(`/admin/enterprises/${enterpriseId}`)
  return res.data
}

export async function updateAdminEnterpriseStatus(enterpriseId: string, status: string) {
  const res = await api.put(`/admin/enterprises/${enterpriseId}/status`, { status })
  return res.data
}

export async function createAdminEnterprise(data: {
  name: string
  industry?: string
  description?: string
  contact_name?: string
  contact_email?: string
  status?: string
}) {
  const res = await api.post('/admin/enterprises', data)
  return res.data
}

export async function listAdminJobs(status?: string, page = 1, pageSize = 20) {
  const params: Record<string, any> = { page, page_size: pageSize }
  if (status) params.status = status
  const res = await api.get('/admin/jobs', { params })
  return res.data
}

export async function getAdminJobDetail(jobId: string) {
  const res = await api.get(`/admin/jobs/${jobId}`)
  return res.data
}

export async function approveAdminJob(jobId: string) {
  const res = await api.post(`/admin/jobs/${jobId}/approve`)
  return res.data
}

export async function rejectAdminJob(jobId: string, reason: string) {
  const res = await api.post(`/admin/jobs/${jobId}/reject`, { reason })
  return res.data
}

export async function recommendStudentToEnterprise(studentId: string | number, jobPostId: string) {
  const res = await api.post(`/admin/students/${studentId}/recommend`, { job_post_id: jobPostId })
  return res.data
}

// ==========================================
// 4. Growth Tasks API（成长任务接口 - 阶段四新增）
// ==========================================
export async function getGrowthTasks(studentId: string | number, diagnosisId?: string) {
  const res = await api.get(`/growth-tasks/${studentId}`, { params: diagnosisId ? { diagnosis_id: diagnosisId } : {} })
  return res.data
}

export async function submitTaskEvidence(taskId: string, studentId: string | number, evidence: string) {
  const res = await api.post(`/growth-tasks/${taskId}/submit`, { student_id: studentId, evidence })
  return res.data
}

export async function getGrowthTaskDetail(studentId: string | number, taskId: string) {
  const res = await api.get(`/growth-tasks/${studentId}/${taskId}`)
  return res.data
}

export async function linkTaskReEvaluation(taskId: string, reEvaluationId: string) {
  const res = await api.post(`/growth-tasks/${taskId}/link-re-evaluation`, { re_evaluation_id: reEvaluationId })
  return res.data
}

// ==========================================
// 5. 统一 Agent API（智能体统一入口 - 阶段二新增）
// ==========================================

// ==========================================
// 6. 附件管理 API（成绩单/证明材料）
// ==========================================
export async function uploadAttachment(studentId: string | number, file: File, category: string = 'other') {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('category', category)
  const token = getAuthToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`/api/students/${studentId}/attachments`, {
    method: 'POST', headers, body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `上传失败 (${res.status})`)
  }
  return res.json()
}

export async function listAttachments(studentId: string | number) {
  const res = await api.get(`/students/${studentId}/attachments`)
  return res.data
}

export async function deleteAttachment(studentId: string | number, attachmentId: string) {
  const res = await api.delete(`/students/${studentId}/attachments/${attachmentId}`)
  return res.data
}

export async function getEnterpriseCandidateAttachments(studentId: string | number, enterpriseId: string, authId?: string) {
  const params: Record<string, string> = { enterprise_id: enterpriseId }
  if (authId) params.auth_id = authId
  const res = await api.get(`/enterprise/candidates/${studentId}/attachments`, { params })
  return res.data
}

export function getAttachmentDownloadUrl(studentId: string | number, attachmentId: string, enterpriseId: string) {
  return `/api/enterprise/candidates/${studentId}/attachments/${attachmentId}/download?enterprise_id=${enterpriseId}`
}

// ==========================================
// 7. 统一 Agent API（智能体统一入口）
// ==========================================
export async function getConversationMessages(studentId: string | number, limit = 20) {
  const res = await api.get(`/conversations/${studentId}/messages`, { params: { limit } })
  return res.data
}

export async function runStudentAgent(
  studentId: string | number,
  intent: AgentIntent,
  payload: Record<string, any> = {},
): Promise<AgentResult> {
  const res = await api.post(`/agent/student/${studentId}/run`, { intent, payload })
  return res.data
}

/**
 * 流式 Agent API——用于 diagnose 和 re_evaluate 等长耗时意图。
 * 通过 SSE 实时返回进度，最终返回 AgentResult。
 */
export async function runStudentAgentStream(
  studentId: string | number,
  intent: AgentIntent,
  payload: Record<string, any> = {},
  onProgress?: (stage: string, progress: number, message: string) => void,
): Promise<AgentResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const response = await fetch(`/api/agent/student/${studentId}/run-stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ intent, payload }),
  })
  if (!response.ok) {
    if (response.status === 401) {
      clearAuth()
      window.location.href = '/'
      throw new Error('会话已过期，请重新登录')
    }
    let detail = `${response.status} ${response.statusText}`
    try {
      const errData = await response.json()
      if (errData.detail) detail = errData.detail
    } catch {}
    throw new Error(detail)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('服务器未返回数据流')
  const decoder = new TextDecoder()
  let buffer = ''
  let agentResult: AgentResult | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6))
          if (event.stage === 'result' && event.result) {
            agentResult = event.result as AgentResult
          } else if (event.stage === 'error') {
            throw new Error(event.message || 'Agent 流式执行失败')
          } else if (onProgress) {
            onProgress(event.stage, event.progress ?? 0, event.message ?? '')
          }
        } catch (e: any) {
          if (e.message && !e.message.startsWith('Unexpected')) throw e
        }
      }
    }
  }
  if (!agentResult) throw new Error('Agent 流式调用未返回结果')
  return agentResult
}
