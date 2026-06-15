import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Briefcase, GraduationCap, LogIn, Shield, Sparkles } from 'lucide-react'
import ThemeToggle from '../components/shared/ThemeToggle'
import { login, getStudent, listEnterprisesForLogin, setAuthToken } from '../services/api'
import { useAppStore } from '../stores/appStore'

type LoginRole = 'student' | 'enterprise' | 'admin'

interface EnterpriseOption {
  id: string
  name: string
  status?: string
  industry?: string
}

const ROLE_TABS: { key: LoginRole; label: string; icon: JSX.Element }[] = [
  { key: 'student', label: '学生端', icon: <GraduationCap size={15} /> },
  { key: 'enterprise', label: '企业端', icon: <Briefcase size={15} /> },
  { key: 'admin', label: '学校端', icon: <Shield size={15} /> },
]

export default function Home() {
  const navigate = useNavigate()
  const {
    hydrateFromStorage,
    setRole,
    setStudent,
    setCurrentStudentId,
    setCurrentEnterpriseId,
    currentStudentId,
    currentEnterpriseId,
  } = useAppStore()

  const [role, setSelectedRole] = useState<LoginRole>('student')
  const [identifier, setIdentifier] = useState('')
  const [enterprises, setEnterprises] = useState<EnterpriseOption[]>([])
  const [loadingEnterprises, setLoadingEnterprises] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    hydrateFromStorage()
  }, [hydrateFromStorage])

  useEffect(() => {
    if (role === 'student') {
      setIdentifier(String(currentStudentId || localStorage.getItem('student_id') || ''))
    } else if (role === 'enterprise') {
      setIdentifier(currentEnterpriseId || '')
    } else {
      setIdentifier('')
    }
    setMessage('')
  }, [role, currentStudentId, currentEnterpriseId])

  useEffect(() => {
    const loadEnterprises = async () => {
      setLoadingEnterprises(true)
      try {
        const data = await listEnterprisesForLogin()
        setEnterprises(data || [])
        if (role === 'enterprise' && !identifier) {
          const activeFirst = (data || []).find((e: EnterpriseOption) => e.status === 'active')
          if (activeFirst?.id) {
            setIdentifier(activeFirst.id)
          }
        }
      } catch {
        setMessage('企业列表加载失败，请确认后端服务已启动。')
      } finally {
        setLoadingEnterprises(false)
      }
    }
    loadEnterprises()
  }, [])

  const selectedEnterprise = useMemo(
    () => enterprises.find(item => item.id === identifier),
    [enterprises, identifier],
  )

  const handleRoleChange = (nextRole: LoginRole) => {
    setSelectedRole(nextRole)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setMessage('')
    setSubmitting(true)

    try {
      if (role === 'student') {
        if (!identifier.trim()) {
          setRole('student')
          navigate('/student/input')
          return
        }
        const loginResult = await login('student', identifier.trim(), password)
        setAuthToken(loginResult.access_token)
        const student = await getStudent(loginResult.student_id || identifier.trim())
        setStudent(student)
        setCurrentStudentId(student.id)
        setRole('student')
        navigate('/student/dashboard')
        return
      }

      if (role === 'enterprise') {
        if (!identifier.trim()) {
          setMessage('请选择企业后再进入。')
          return
        }
        if (selectedEnterprise && selectedEnterprise.status !== 'active') {
          const reason = selectedEnterprise.status === 'pending'
            ? '该企业尚未通过审核，请等待学校管理员审核。'
            : selectedEnterprise.status === 'disabled'
              ? '该企业已被禁用，请联系学校管理员。'
              : '该企业状态异常，无法进入。'
          setMessage(reason)
          return
        }
        const loginResult = await login('enterprise', identifier.trim(), password)
        setAuthToken(loginResult.access_token)
        setCurrentEnterpriseId(identifier.trim())
        setRole('enterprise')
        navigate('/enterprise')
        return
      }

      const loginResult = await login('admin', identifier.trim() || 'admin', password)
      setAuthToken(loginResult.access_token)
      localStorage.setItem('zhida_admin_account', identifier.trim() || 'admin')
      setRole('admin')
      navigate('/admin')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || ''
      if (err?.response?.status === 404 && role === 'student') {
        setMessage('未找到该学生，可以直接创建档案。')
      } else if (detail) {
        setMessage(detail)
      } else {
        setMessage('登录信息处理失败，请稍后重试。')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleCreateStudent = () => {
    // 清除旧的学生数据，避免 "新用户" 流程中恢复旧档案
    localStorage.removeItem('student_data')
    localStorage.removeItem('student_id')
    localStorage.removeItem('zhida_student_id')
    // 同时清除 appStore 中的旧状态
    setStudent(null)
    setRole('student')
    navigate('/student/input')
  }

  const roleLabel = role === 'student' ? '学生 ID 凭证' : role === 'enterprise' ? '选择企业' : '学校管理员账号'

  return (
    <div className="login-page">
      {/* Top Navigation */}
      <nav className="login-topbar">
        <div className="login-brand">
          <div className="login-brand-mark">
            <Sparkles size={16} color="var(--bg-page)" />
          </div>
          <div>
            <div className="login-brand-name">职达</div>
          </div>
        </div>
        <ThemeToggle />
      </nav>

      {/* Main Content */}
      <div className="login-layout">
        {/* Left: Product Introduction */}
        <div className="login-intro">
          <div className="login-kicker">
            <Sparkles size={10} style={{ marginRight: 4 }} />
            AI 驱动的五维人才评测与匹配系统
          </div>

          <h1 style={{
            color: 'var(--text-primary)',
            fontSize: 40, fontWeight: 700, lineHeight: 1.2,
            letterSpacing: '-0.02em',
          }}>
            精准锚定方向<br />规划成长坦途
          </h1>

          <p>
            连接学生、高校与企业。基于简历行为特征，自动构建五维能力画像，
            匹配企业真实在招岗位，并针对核心能力差距规划每日学习路径。
          </p>

          {/* Metric Badges */}
          <div className="login-metrics">
            <div>
              <strong style={{ color: 'var(--accent-primary)' }}>5D</strong>
              <span>多维能力画像</span>
            </div>
            <div>
              <strong style={{ color: 'var(--accent-success)' }}>AI</strong>
              <span>智能岗位匹配</span>
            </div>
            <div>
              <strong style={{ color: 'var(--accent-primary)' }}>360°</strong>
              <span>成长路径规划</span>
            </div>
          </div>
        </div>

        {/* Right: Login Panel */}
        <div>
          <div className="glass-panel login-panel">
            <h2 style={{
              fontSize: 20, fontWeight: 800, textAlign: 'center',
              margin: '0 0 6px', color: 'var(--text-primary)',
            }}>
              进入职达工作台
            </h2>
            <p style={{
              fontSize: 12.5, color: 'var(--text-tertiary)',
              textAlign: 'center', margin: '0 0 24px',
            }}>
              登录您的账户以查看个性化诊断与招聘详情
            </p>

            {/* Role Tabs */}
            <div className="login-role-tabs">
              {ROLE_TABS.map(tab => {
                const isActive = role === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => handleRoleChange(tab.key)}
                    className={isActive ? 'active' : ''}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                )
              })}
            </div>

            <form onSubmit={handleSubmit} className="login-form">
              <div>
                <label className="form-label" style={{ display: 'block', marginBottom: 8, paddingLeft: 2 }}>
                  {roleLabel}
                </label>

                {role === 'enterprise' ? (
                  <select
                    value={identifier}
                    onChange={event => setIdentifier(event.target.value)}
                    disabled={loadingEnterprises}
                    className="form-select"
                  >
                    <option value="">{loadingEnterprises ? '加载企业中...' : '请选择您的企业'}</option>
                    {enterprises.map(item => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={item.status !== 'active'}
                      >
                        {item.name}{item.status !== 'active' ? `（${item.status === 'pending' ? '待审核' : item.status === 'disabled' ? '已禁用' : item.status}）` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={identifier}
                    onChange={event => setIdentifier(event.target.value)}
                    placeholder={
                      role === 'student' ? '请输入您的学生 ID，例如 1001'
                        : '请输入学校管理员账号'
                    }
                    className="form-input"
                  />
                )}
              </div>

              <div>
                <label className="form-label" style={{ display: 'block', marginBottom: 8, paddingLeft: 2 }}>
                  密码
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder="当前阶段无需填写密码"
                  className="form-input"
                />
              </div>

              {message && (
                <div className="login-message" style={{ borderColor: 'rgba(var(--accent-danger-rgb), 0.15)' }}>
                  {message}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="btn btn-primary login-submit"
              >
                <LogIn size={15} />
                {submitting ? '进入中...' : `进入${ROLE_TABS.find(t => t.key === role)?.label || '工作台'}`}
              </button>
            </form>

            {role === 'student' && (
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={handleCreateStudent}
                  className="btn btn-success"
                  style={{ borderRadius: 'var(--radius-md)' }}
                >
                  新用户创建档案
                </button>
                <div style={{
                  fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8,
                }}>
                  首次使用？创建成长档案后会自动进入学生端
                </div>
              </div>
            )}

            <div style={{
              marginTop: 20, paddingTop: 14,
              borderTop: '1px solid var(--border-subtle)',
              textAlign: 'center', fontSize: 11, color: 'var(--text-tertiary)',
            }}>
              三端协同 · 智能人才诊断服务系统
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
