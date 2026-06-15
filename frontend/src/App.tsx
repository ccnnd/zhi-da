import { lazy, Suspense } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import { useAppStore } from './stores/appStore'
import { getAuthToken } from './services/api'
import ErrorBoundary from './components/shared/ErrorBoundary'

// 路由代码分割：三个门户页面懒加载
const ProfileInput = lazy(() => import('./pages/ProfileInput'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const EnterpriseDashboard = lazy(() => import('./pages/EnterpriseDashboard'))
const NotFound = lazy(() => import('./pages/NotFound'))

// 统一 Loading 占位组件
function PageLoading() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', width: '100%',
      background: 'var(--bg-primary)', color: 'var(--text-secondary)',
      fontSize: 14, fontFamily: 'var(--font-display)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 32, height: 32, border: '3px solid var(--border-light)',
          borderTopColor: 'var(--accent-primary)', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite', margin: '0 auto 12px',
        }} />
        加载中...
      </div>
    </div>
  )
}

function RequireStudent({ children }: { children: JSX.Element }) {
  const { currentStudentId, student, role } = useAppStore()
  const token = getAuthToken()
  const storedStudentId = currentStudentId || student?.id || localStorage.getItem('zhida_student_id') || localStorage.getItem('student_id')
  const storedRole = role || localStorage.getItem('zhida_role')
  return (token && storedStudentId && storedRole === 'student') ? children : <Navigate to="/" replace />
}

function RequireEnterprise({ children }: { children: JSX.Element }) {
  const { currentEnterpriseId, role } = useAppStore()
  const token = getAuthToken()
  const storedEnterpriseId = currentEnterpriseId || localStorage.getItem('zhida_enterprise_id')
  const storedRole = role || localStorage.getItem('zhida_role')
  return (token && storedEnterpriseId && storedRole === 'enterprise') ? children : <Navigate to="/" replace />
}

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { role } = useAppStore()
  const token = getAuthToken()
  const storedRole = role || localStorage.getItem('zhida_role')
  return (token && storedRole === 'admin') ? children : <Navigate to="/" replace />
}

export default function App() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ErrorBoundary>
        <Routes>
          {/* Three-Tier Portal Hub */}
          <Route path="/" element={<Home />} />

          {/* Student Portal */}
          <Route path="/student/input" element={<ProfileInput />} />
          <Route path="/student/dashboard" element={<RequireStudent><Dashboard /></RequireStudent>} />

          {/* School Admin Portal */}
          <Route path="/admin" element={<RequireAdmin><AdminDashboard /></RequireAdmin>} />

          {/* Enterprise Portal */}
          <Route path="/enterprise" element={<RequireEnterprise><EnterpriseDashboard /></RequireEnterprise>} />

          {/* 404 Fallback */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
    </Suspense>
  )
}
