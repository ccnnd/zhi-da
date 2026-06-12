# 职达（Zhi-Da）—— AI 人才成长智能体

> **TalentPath v2.0.1** | 桂林电子科技大学 · 第二十一届中国研究生电子设计竞赛"润建"专项赛 · 方向1
>
> 🌐 **在线演示**：http://1.14.162.114 | **API 文档**：http://1.14.162.114:8000/docs

---

## 项目简介

**职达**是一个 AI 驱动的人才成长智能体系统，面向高校学生、企业和学校三方，提供从能力诊断、岗位匹配、成长任务、证据审核到能力复评的**闭环式职业成长服务**。

项目的核心不是做一个普通简历站，而是围绕 **"学生档案 → AI 诊断 → 成长任务 → 复评 → 授权企业查看候选人"** 的闭环，展示智能体在职业成长辅导中的持续参与能力。

### 核心功能

- 🔍 **五维能力诊断**：AI 生成学生技术技能、项目经验、学业基础、领域知识、软技能证据五大维度画像
- 🎯 **智能岗位匹配**：确定性算法 + LLM 语义理解，推荐 TOP5 匹配岗位
- 📈 **量化成长闭环**：分阶段成长任务 → 证据提交 → AI 双审（规则+LLM） → 复评量化变化
- 🔗 **三端联通**：8-Gap 连通框架打通"学校↔企业↔学生"三端数据流，支持管理员推荐、批量授权、诊断版本自动同步、企业人才池匿名发现
- 🏢 **三端协同**：学生端（能力成长）+ 企业端（岗位管理+人才筛选）+ 学校端（审核管理+人才推荐枢纽）
- 🛡️ **安全可控**：AI 能力边界管理系统，三层约束（能力清单 + 意图边界 + Tool 白名单）

### 技术创新

- 状态驱动的 **Planner-Skill-Tool 三层智能体架构**
- **确定性计算 + LLM 语义理解** 的双引擎诊断 Pipeline
- 中英文混合分词 + **规则/LLM 双审** 证据审核机制
- **SSE 流式进度推送**，前端实时感知 AI 处理进度
- **Fallback 降级体系**，LLM 不可用时自动切换规则模式

---

## 快速开始

### Docker 一键部署（推荐）

```bash
# 克隆项目
git clone https://github.com/ccnnd/zhi-da
cd zhi-da

# 配置 LLM API Key（可选，不配置则 AI 功能降级为规则模式）
echo "LLM_API_KEY=sk-your-key" > .env
echo "LLM_BASE_URL=https://api.deepseek.com" >> .env
echo "LLM_MODEL=deepseek-chat" >> .env

# 启动服务
docker compose up -d --build

# 验证部署
curl http://localhost:8000/api/health
```

访问地址：

| 服务 | 地址 |
|------|------|
| 前端界面 | http://localhost |
| 后端 API | http://localhost:8000 |
| Swagger 文档 | http://localhost:8000/docs |

健康检查预期返回：

```json
{
  "status": "ok",
  "service": "TalentPath",
  "version": "2.0.0",
  "ai_status": "configured",
  "ai_available": true
}
```

### 本地开发启动

```bash
# 后端
cd backend
conda create -n zhida python=3.12 -y && conda activate zhida
pip install -r requirements.txt
# 配置 backend/.env 文件
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 前端
cd frontend
npm install
npm run dev        # http://localhost:5173
```

### 运行测试

```bash
# 后端测试（204 个用例，100% 通过率）
cd backend && python -m pytest tests/ -v

# 前端测试
cd frontend && npx vitest run

# Docker 环境运行测试
docker compose exec -T backend python -m pytest
```

---

## 环境变量

在根目录创建 `.env` 文件（Docker Compose 自动读取）：

```env
# 大模型配置（核心，影响 AI 诊断/审核/复评等全部智能体功能）
LLM_API_KEY=sk-your_api_key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# 安全配置（生产环境务必修改）
JWT_SECRET=your_random_secret_string_32_chars_min
JWT_EXPIRE_MINUTES=1440

# 管理员账号
ADMIN_ACCOUNT=admin

# 跨域配置
CORS_ORIGINS=http://localhost:5173,http://localhost

# 数据库（可选，默认 SQLite）
DATABASE_URL=sqlite+aiosqlite:///./data/talent_path.db
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_API_KEY` | (空) | 大模型密钥，为空时 AI 功能自动降级为规则模式 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名称 |
| `JWT_SECRET` | 开发默认值 | **生产环境必须修改** |
| `JWT_EXPIRE_MINUTES` | `1440` (24小时) | 会话有效期 |
| `ADMIN_ACCOUNT` | `admin` | 学校管理员账号名 |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许跨域的前端地址（逗号分隔） |
| `DATABASE_URL` | SQLite 默认路径 | 数据库连接字符串（支持 PostgreSQL） |

---

## 演示数据

系统首次启动时自动初始化种子数据，**幂等**（重启不会重复创建）：

- **8 家企业**：6 家正常（字节跳动/华为/腾讯/美团/小米/阿里）、1 家待审核、1 家已禁用
- **10 个岗位**：9 个审批通过、1 个待审核
- **8 个岗位能力模型**：含技术技能、软技能、领域知识、项目经验和权重配置

重置数据：

```bash
docker compose down
docker volume rm agent_talent_path_data
docker compose up -d --build
```

---

## 演示账号

### 企业端

| 企业 ID | 名称 | 状态 | 用途 |
|---------|------|------|------|
| `1` | 字节跳动 | 正常 | 演示完整企业流程 |
| `2` | 阿里巴巴 | 正常 | 演示岗位审核 |
| `3` | 待审核公司 | 待审核 | 演示待审核拦截 |
| `4` | 已禁用公司 | 禁用 | 演示门禁拦截 |
| `5` | 华为技术 | 正常 | 含完整岗位能力模型 |
| `6` | 腾讯科技 | 正常 | 含两个岗位 |
| `7` | 美团 | 正常 | 含推荐算法岗位 |
| `8` | 小米科技 | 正常 | 含移动开发岗位 |

### 学校端

| 账号 | 说明 |
|------|------|
| `admin` | 管理员（可通过 `ADMIN_ACCOUNT` 环境变量修改） |

### 学生端

学生通过前端"新用户"入口创建，无需预置账号。建议演示流程：

1. 首页选择"学生端" → 点击"新用户"
2. 填写教育背景、技能、项目经历等信息
3. 保存后自动进入诊断流程（SSE 流式进度）
4. 查看能力画像 → 岗位匹配 → 成长任务 → 提交证据 → AI 审核 → 复评 → 授权企业

---

## 主流程

```text
新学生进入
  → 创建档案 / 上传简历 / 补充核心字段
  → Agent 判断信息是否完整（不完整则追问缺失字段）
  → 生成五维能力诊断（SSE 流式进度反馈）
  → 匹配已审核岗位（TOP5 排行 + 差距分析）
  → 生成分阶段成长任务（绑定差距 + 预期影响）
  → 学生提交证据
  → Agent 证据审核（规则 + LLM 双审）
  → 触发复评（能力变化量化对比 + 版本对比）
  → 学生授权企业查看画像和材料
  → 企业按具体岗位查看已授权候选人
```

---

## 三端功能

### 学生端（核心）

- 新用户注册 & 已有学生登录（Dashboard 顶栏显示学生 ID）
- 模块化档案维护（教育背景、技能、项目经历、学业基础、软技能证据）
- 简历上传与 AI 解析（支持 PDF/DOCX/TXT，LLM 自动提取结构化数据）
- 成绩单上传（仅作为企业查看材料）
- **AI 诊断与解释性结果**（五维雷达图、匹配分仪表盘、置信度、TOP5 岗位排行，图表全面中文化）
- **成长任务与闭环**（分阶段路径 → 证据提交 → AI 审核 → 复评 → 版本对比）
- 授权企业查看个人画像和材料（支持一键批量授权全部推荐岗位，三级优先级分组）
- AI 助手对话（悬浮按钮，上下文感知）
- 导出诊断报告（PDF/Excel，单次最多 200 条记录）

### 企业端

- 登录门禁（待审核/已禁用企业自动拦截）
- 岗位列表和状态管理（已发布/待审核/已下线）
- 创建岗位、AI 解析岗位能力模型、提交审核
- 查看审核驳回原因
- 基于岗位查看已授权候选人（候选人视图岗位卡片显示匹配统计 badge："已授权 X / 潜在匹配 Y"）
- 候选人详情（画像、匹配分、优势差距、证明材料，自动展示学生最新诊断版本，复评后同步更新）

### 学校端

- 运营概览面板（学生总数/已评测数/未评测数/平均匹配分/企业数/活跃企业数/已审核岗位/待审核岗位/活跃授权数，可点击跳转）
- 企业管理（审核/启用/禁用企业）
- 岗位审核（通过/驳回，需填写驳回原因）
- 学生管理（按诊断状态筛选"全部/已评测/未评测"，查看学生诊断详情：能力雷达图、差距柱状图、AI 成长建议、TOP5 匹配岗位、附件材料、成长任务完成汇总）
- 管理员推荐学生到企业（管理员发起授权，打通学生与企业双向连接）
- Agent 决策追踪

---

## 项目结构

```
zhi-da/
├── backend/                         # Python 后端
│   ├── main.py                      # FastAPI 应用入口
│   ├── config/settings.py           # 全局配置
│   ├── requirements.txt             # Python 依赖
│   ├── Dockerfile                   # 后端容器镜像
│   ├── db/
│   │   ├── models.py                # 15+ ORM 数据模型
│   │   └── database.py              # 数据库连接 + 种子数据
│   ├── api/routes/                  # 15 个路由模块
│   │   ├── agent.py                 # 统一智能体接口（含 SSE）
│   │   ├── student.py               # 学生管理
│   │   ├── enterprise.py            # 企业端（岗位/候选人）
│   │   ├── admin.py                 # 学校管理后台
│   │   ├── auth.py                  # 认证（JWT）
│   │   ├── diagnosis.py             # 诊断查询
│   │   ├── growth_tasks.py          # 成长任务
│   │   ├── export.py                # 报告导出
│   │   ├── conversation.py          # 对话历史
│   │   └── agent_trace.py           # Agent 追踪
│   ├── core/
│   │   ├── agent/                   # 智能体核心层
│   │   │   ├── student_runtime.py   # 统一运行时入口
│   │   │   ├── planner.py           # 状态驱动决策器
│   │   │   ├── skills.py            # Skill 注册表（8 个 Skill）
│   │   │   ├── tools.py             # Tool 注册表（7 个 Tool）
│   │   │   ├── schemas.py           # 统一请求/响应 Schema
│   │   │   ├── question_classifier.py # 问题分类器（7 种类型）
│   │   │   └── capabilities.py      # 能力边界管理
│   │   ├── harness/                 # 基础设施层
│   │   │   ├── runner.py            # Pipeline 执行引擎
│   │   │   ├── step.py              # Pipeline 状态容器 + Step 基类
│   │   │   ├── llm.py               # OpenAI-compatible LLM 客户端
│   │   │   ├── fallback.py          # 异常降级处理器
│   │   │   ├── validator.py         # JSON Schema 校验器
│   │   │   ├── logger.py            # 运行日志记录器
│   │   │   └── context.py           # Prompt 上下文构建器
│   │   ├── pipelines/               # 诊断 Pipeline
│   │   │   ├── diagnosis_pipeline.py # 5 步诊断流程
│   │   │   └── re_evaluate_pipeline.py # 复评动态流程
│   │   ├── services/                # 业务服务层
│   │   │   ├── diagnosis_service.py  # 诊断服务（版本递增/快照）
│   │   │   ├── growth_task_service.py # 成长任务 + 双审
│   │   │   ├── agent_memory_service.py # 对话记忆服务
│   │   │   ├── agent_trace_service.py  # 决策追踪服务
│   │   │   ├── student_service.py     # 学生服务
│   │   │   ├── enterprise_service.py  # 企业服务
│   │   │   └── job_service.py         # 岗位服务
│   │   ├── models/                  # Pydantic 数据模型
│   │   └── utils/time.py            # UTC 时间工具
│   └── tests/                       # 测试套件
│       ├── conftest.py              # 测试配置
│       └── test_api/                # 12 个测试文件（204 个用例）
├── frontend/                        # React + TypeScript 前端
│   ├── package.json                 # 前端依赖（React 18/TS 5.6）
│   ├── Dockerfile                   # 前端容器镜像（Nginx）
│   └── src/
│       ├── App.tsx                  # React 应用入口
│       ├── pages/                   # 页面组件
│       │   ├── Home.tsx             # 首页（三端入口）
│       │   ├── Dashboard.tsx        # 学生看板
│       │   ├── ProfileInput.tsx     # 学生档案编辑
│       │   ├── EnterpriseDashboard.tsx # 企业后台
│       │   ├── AdminDashboard.tsx   # 学校管理后台
│       │   └── NotFound.tsx         # 404 页面
│       ├── components/              # 共享组件
│       │   ├── charts/              # 图表（雷达图/仪表盘/趋势图/柱状图）
│       │   ├── diagnosis/           # 诊断 Tab 组件
│       │   ├── export/              # 导出工具栏
│       │   └── shared/              # 通用组件（AI面板/对话/任务卡片/时间线）
│       ├── services/api.ts          # API 客户端（axios + JWT 拦截）
│       ├── stores/appStore.ts       # 全局状态（Zustand）
│       └── types/index.ts           # TypeScript 类型定义
├── docs/
│   ├── demo-walkthrough.md          # 比赛演示流程
│   └── user-manual.md               # 用户使用手册
├── docker-compose.yml               # Docker 编排配置
├── DEPLOYMENT.md                    # 部署文档
├── CONFIG.md                        # 配置说明
├── API.md                           # 接口文档（50+ 端点）
├── RELEASE.md                       # 发布说明
├── 技术论文_职达AI人才成长智能体.md    # 技术论文
└── README.md                        # 本文档
```

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [CLOUD_DEPLOY.md](CLOUD_DEPLOY.md) | ☁️ **云服务器部署指南**（从零到全网可访问，30分钟搞定） |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署文档（Docker/手动/生产环境/Nginx/常见问题） |
| [CONFIG.md](CONFIG.md) | 配置说明（环境变量/LLM/数据库/安全/文件上传/CORS） |
| [API.md](API.md) | 接口文档（50+ REST API + SSE 流式端点完整说明） |
| [docs/demo-walkthrough.md](docs/demo-walkthrough.md) | 比赛演示流程（三端按序演示 + 验收标准） |
| [docs/user-manual.md](docs/user-manual.md) | 用户使用手册（三端完整操作指南） |
| [技术论文_职达AI人才成长智能体.md](技术论文_职达AI人才成长智能体.md) | 技术论文（创新点/架构/实现/输出/测试/商业化） |

---

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **后端框架** | FastAPI | 0.115 |
| **ASGI 服务器** | Uvicorn | 0.34 |
| **AI 编排** | LangChain + OpenAI SDK | 0.3 / 1.57 |
| **ORM** | SQLAlchemy (async) | 2.0 |
| **数据库** | SQLite (开发) / PostgreSQL (生产) | - |
| **认证** | PyJWT (HS256) | 2.9 |
| **报告生成** | openpyxl + reportlab | 3.1 / 4.2 |
| **前端框架** | React + TypeScript | 18 / 5.6 |
| **UI 组件库** | Ant Design | 5.22 |
| **图表** | ECharts (via echarts-for-react) | 5.5 |
| **状态管理** | Zustand | 5.0 |
| **构建工具** | Vite | 6.0 |
| **测试** | pytest + pytest-asyncio + Vitest | 8.3 / 4.1 |
| **部署** | Docker + Docker Compose | 20.10+ |

---

## Git 注意事项

以下内容不会上传（已在 `.gitignore` 中排除）：

- `.env`（密钥配置）
- `*.db`, `*.sqlite3`（数据库文件）
- `uploads/`（用户上传文件）
- `node_modules/` / `dist/`（前端依赖和构建产物）
- `artifacts/` / `local-process-docs/`（过程文档）
- `__pycache__/` / `.pytest_cache/`（Python 缓存）
- `*.pdf`（PDF 文件）

---

## 许可证

本项目为桂林电子科技大学第二十一届中国研究生电子设计竞赛校内选拔赛"润建"专项赛参赛作品。

---

🤖 Built with FastAPI + React + AI | 204 tests passing ✅
