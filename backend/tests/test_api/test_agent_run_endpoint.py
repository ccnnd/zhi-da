# Agent /run 端点集成测试——覆盖五种 intent
# 测试 POST /api/agent/student/{student_id}/run 统一入口
import pytest
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient
from main import app
from db.database import async_session, init_db
from db.models import Student, GrowthTask, DiagnosisResult
from core.harness.step import PipelineState
from tests.conftest import auth_headers


@pytest.fixture(scope="module", autouse=True)
def setup_db():
    asyncio.run(init_db())


def _run(coro):
    """Helper to run async coroutines in sync tests."""
    return asyncio.run(coro)


def _run_post(client: TestClient, student_id: int, intent: str, payload: dict = None, headers: dict = None):
    """Helper: POST /api/agent/student/{id}/run"""
    body = {"intent": intent, "payload": payload or {}}
    return client.post(f"/api/agent/student/{student_id}/run", json=body, headers=headers)


# ========== Helper: 创建完整学生 ==========

def _create_complete_student(name: str = "Run完整学生") -> int:
    async def _create():
        async with async_session() as db:
            student = Student(
                name=name, grade="大三", major="软件工程",
                target_job="后端开发", tech_skills={"Python": 80, "Java": 70},
                project_exp=[{"name": "项目A", "description": "实现了REST API"}],
                resume_text="这是一份包含个人技能和学习经历的简历。",
                academic_foundation={"gpa": "3.5", "rank": "前20%"},
                soft_skill_evidence={"teamwork": {"level": "中级", "evidence": ["小组项目"]}},
            )
            db.add(student)
            await db.commit()
            await db.refresh(student)
            return student.id
    return _run(_create())


def _create_incomplete_student(name: str = "Run残缺学生") -> int:
    async def _create():
        async with async_session() as db:
            student = Student(
                name=name, grade="大一",
                tech_skills={}, project_exp=[],
                resume_text="", target_job="",
            )
            db.add(student)
            await db.commit()
            await db.refresh(student)
            return student.id
    return _run(_create())


def _create_student_with_diagnosis_and_tasks(name: str = "Run有诊断学生"):
    """创建学生 + 诊断 + 成长任务，返回 (student_id, diag_id, task_id)"""
    async def _create():
        async with async_session() as db:
            student = Student(
                name=name, grade="大三", major="计算机",
                target_job="后端开发", tech_skills={"Python": 80},
                project_exp=[{"name": "项目A"}], resume_text="简历内容",
                academic_foundation={"gpa": "3.5"},
                soft_skill_evidence={"lead": {"level": "好"}},
            )
            db.add(student)
            await db.commit()
            await db.refresh(student)

            diag = DiagnosisResult(
                student_id=student.id, version=1,
                diagnosis_type="initial", match_score=0.72,
                growth_path={"phases": [
                    {"tasks": [
                        {"name": "学习FastAPI", "description": "完成教程",
                         "linked_gap": "tech_skills", "target_dimension": "tech_skills",
                         "expected_impact": {"tech_skills": 0.05},
                         "criteria": "完成并提交代码", "resources": []}
                    ]}
                ]},
            )
            db.add(diag)
            await db.commit()
            await db.refresh(diag)

            task = GrowthTask(
                diagnosis_id=diag.id,
                student_id=student.id,
                phase_index=0, task_index=0,
                task_name="学习FastAPI",
                task_description="完成FastAPI官方教程",
                linked_gap="tech_skills",
                target_dimension="tech_skills",
                expected_impact={"tech_skills": 0.05},
                criteria="完成教程并提交代码",
                status="pending",
            )
            db.add(task)
            await db.commit()
            await db.refresh(task)

            return student.id, diag.id, task.id

    return _run(_create())


# ========================================
# Intent: diagnose
# ========================================

class TestRunDiagnose:
    """测试 /run intent=diagnose"""

    def test_diagnose_student_not_found(self):
        """学生不存在 -> action=error"""
        with TestClient(app) as client:
            resp = _run_post(client, 9901, "diagnose", headers=auth_headers("student", student_id=9901))
            assert resp.status_code == 200
            data = resp.json()
            assert data["action"] == "error"
            assert "不存在" in data["message"]

    def test_diagnose_ask_for_info(self):
        """信息不完整 -> action=ask_for_info，包含追问"""
        sid = _create_incomplete_student("Run诊断残缺学生")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "diagnose", headers=auth_headers("student", student_id=sid))
            assert resp.status_code == 200
            data = resp.json()
            assert data["action"] == "ask_for_info"
            assert "missing_fields" in data["data"]
            assert "followup_questions" in data["data"]
            assert len(data["data"]["missing_fields"]) > 0
            assert data["data"]["completeness"] < 1.0

    def test_diagnose_complete_student_with_mock(self):
        """信息完整学生 -> action=diagnosis_completed（mock pipeline）"""
        sid = _create_complete_student("Run诊断完整学生")

        # Mock PipelineRunner.run() 返回一个模拟的 PipelineState
        mock_state = PipelineState(input={"id": sid})
        mock_state.output = {
            "profile": {"tech_skills": 0.7, "project_exp": 0.6, "academic_foundation": 0.65, "domain_knowledge": 0.5, "soft_skill_evidence": 0.55},
            "top5_jobs": [
                {"job_id": "post_1", "title": "后端开发", "match_score": 0.85, "company": "测试企业", "reason": "技术匹配", "matched_skills": ["Python"], "missing_skills": ["Docker"]},
            ],
            "gap_explanation": "需要提升Docker和容器化技能",
            "growth_path": {"phases": [{"tasks": [{"name": "学习Docker", "description": "Docker教程", "linked_gap": "tech_skills", "target_dimension": "tech_skills", "expected_impact": {"tech_skills": 0.05}, "criteria": "完成教程", "resources": []}]}]},
            "advice": "建议先学习Docker和容器化技术",
        }
        mock_state.errors = []
        mock_state.step_results = {}

        with patch("core.agent.student_runtime.PipelineRunner") as MockRunner, \
             patch("core.agent.student_runtime.LLM_API_KEY", "test-key"):
            mock_runner = MagicMock()
            mock_runner.run = AsyncMock(return_value=mock_state)
            mock_runner.run_stages = AsyncMock(return_value=mock_state)
            mock_runner.steps = [MagicMock() for _ in range(5)]
            MockRunner.return_value = mock_runner

            with TestClient(app) as client:
                resp = _run_post(client, sid, "diagnose", headers=auth_headers("student", student_id=sid))
                assert resp.status_code == 200
                data = resp.json()
                assert data["action"] == "diagnosis_completed"
                assert "id" in data["data"]
                assert data["data"]["student_id"] == sid
                assert len(data["next_actions"]) > 0

    def test_diagnose_missing_llm_key(self):
        """LLM API Key 未配置 -> action=error, ai_status=missing_key"""
        sid = _create_complete_student("Run诊断无Key学生")

        with patch("core.agent.student_runtime.LLM_API_KEY", ""):
            with TestClient(app) as client:
                resp = _run_post(client, sid, "diagnose", headers=auth_headers("student", student_id=sid))
                assert resp.status_code == 200
                data = resp.json()
                assert data["action"] == "error"
                assert data["ai_status"] == "missing_key"


# ========================================
# Intent: continue_growth
# ========================================

class TestRunContinueGrowth:
    """测试 /run intent=continue_growth"""

    def test_continue_growth_no_diagnosis(self):
        """无诊断 -> action=advice, diagnosis=null"""
        sid = _create_complete_student("Run成长无诊断")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "continue_growth", headers=auth_headers("student", student_id=sid))
            assert resp.status_code == 200
            data = resp.json()
            assert data["action"] == "advice"
            assert data["data"]["diagnosis"] is None
            assert data["data"]["tasks"] == []
            # 应该建议去诊断
            assert any(a["intent"] == "diagnose" for a in data["next_actions"])

    def test_continue_growth_with_tasks(self):
        """有诊断和任务 -> 返回任务列表"""
        sid, diag_id, task_id = _create_student_with_diagnosis_and_tasks("Run成长有任务")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "continue_growth", headers=auth_headers("student", student_id=sid))
            assert resp.status_code == 200
            data = resp.json()
            assert data["action"] == "advice"
            assert data["data"]["diagnosis_id"] == diag_id
            assert len(data["data"]["tasks"]) >= 1
            assert "completed_count" in data["data"]
            assert "total_count" in data["data"]
            assert data["data"]["total_count"] >= 1


# ========================================
# Intent: review_task
# ========================================

class TestRunReviewTask:
    """测试 /run intent=review_task"""

    def test_review_task_missing_params(self):
        """缺少 task_id 或 evidence -> action=error"""
        sid = _create_complete_student("Run审核缺参数")
        with TestClient(app) as client:
            h = auth_headers("student", student_id=sid)
            # 缺少 task_id
            resp = _run_post(client, sid, "review_task", {"evidence": "我完成了"}, headers=h)
            data = resp.json()
            assert data["action"] == "error"

            # 缺少 evidence
            resp2 = _run_post(client, sid, "review_task", {"task_id": "fake_id"}, headers=h)
            data2 = resp2.json()
            assert data2["action"] == "error"

    def test_review_task_evidence_insufficient(self):
        """证据不充分 -> action=task_reviewed, status=in_progress"""
        sid, diag_id, task_id = _create_student_with_diagnosis_and_tasks("Run审核不足")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "review_task", {
                "task_id": task_id,
                "evidence": "做了",  # 太短
            }, headers=auth_headers("student", student_id=sid))
            assert resp.status_code == 200
            data = resp.json()
            assert data["action"] == "task_reviewed"
            assert data["data"]["status"] == "in_progress"
            assert data["data"]["review"]["preliminary_approved"] is False

    def test_review_task_evidence_sufficient(self, monkeypatch):
        monkeypatch.setattr("config.settings.LLM_API_KEY", "")
        """证据充分 -> action=task_reviewed, status=completed, next_actions包含re_evaluate"""
        sid, diag_id, task_id = _create_student_with_diagnosis_and_tasks("Run审核充分")
        evidence = "我完成了FastAPI官方教程的全部章节学习，包括路由、依赖注入、中间件和数据库集成等核心内容。还动手实现了一个完整的REST API项目。"
        with TestClient(app) as client:
            resp = _run_post(client, sid, "review_task", {
                "task_id": task_id,
                "evidence": evidence,
            }, headers=auth_headers("student", student_id=sid))
            assert resp.status_code == 200
            data = resp.json()
            assert data["action"] == "task_reviewed"
            assert data["data"]["status"] == "completed"
            assert data["data"]["review"]["preliminary_approved"] is True
            # next_actions 应包含 re_evaluate
            intents = [a["intent"] for a in data["next_actions"]]
            assert "re_evaluate" in intents

    def test_review_task_not_found(self):
        """task_id 不存在 -> action=error"""
        sid = _create_complete_student("Run审核不存在任务")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "review_task", {
                "task_id": "nonexistent_task_xyz",
                "evidence": "我完成了很多内容的学习和实践。",
            }, headers=auth_headers("student", student_id=sid))
            data = resp.json()
            assert data["action"] == "error"


# ========================================
# Intent: re_evaluate
# ========================================

class TestRunReEvaluate:
    """测试 /run intent=re_evaluate"""

    def test_re_evaluate_missing_task_id(self):
        """缺少 task_id -> action=error"""
        sid = _create_complete_student("Run复评缺ID")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "re_evaluate", {}, headers=auth_headers("student", student_id=sid))
            data = resp.json()
            assert data["action"] == "error"
            assert "task_id" in data["message"]

    def test_re_evaluate_missing_llm_key(self):
        """LLM API Key 未配置 -> action=error, ai_status=missing_key"""
        sid, diag_id, task_id = _create_student_with_diagnosis_and_tasks("Run复评无Key")
        with patch("core.agent.student_runtime.LLM_API_KEY", ""):
            with TestClient(app) as client:
                resp = _run_post(client, sid, "re_evaluate", {"task_id": task_id}, headers=auth_headers("student", student_id=sid))
                data = resp.json()
                assert data["action"] == "error"
                assert data["ai_status"] == "missing_key"

    def test_re_evaluate_with_mock(self):
        """正常复评 -> action=re_evaluation_completed（mock pipeline）"""
        sid, diag_id, task_id = _create_student_with_diagnosis_and_tasks("Run正常复评")

        # 先提交充分证据完成任务
        with TestClient(app) as client:
            client.post(f"/api/agent/student/{sid}/run", json={
                "intent": "review_task",
                "payload": {
                    "task_id": task_id,
                    "evidence": "我完成了FastAPI教程全部章节并实现了完整项目。",
                },
            }, headers=auth_headers("student", student_id=sid))

        mock_state = PipelineState(input={"id": sid})
        mock_state.output = {
            "profile": {"tech_skills": 0.75, "project_exp": 0.65, "academic_foundation": 0.65, "domain_knowledge": 0.55, "soft_skill_evidence": 0.55},
            "top5_jobs": [
                {"job_id": "post_1", "title": "后端开发", "match_score": 0.88, "company": "测试企业", "reason": "提升后更匹配", "matched_skills": ["Python", "FastAPI"], "missing_skills": ["Docker"]},
            ],
            "gap_explanation": "Docker 技能仍需提升",
            "growth_path": {"phases": [{"tasks": [{"name": "学习Docker", "description": "Docker教程", "linked_gap": "tech_skills", "target_dimension": "tech_skills", "expected_impact": {"tech_skills": 0.05}, "criteria": "完成教程", "resources": []}]}]},
            "advice": "继续提升容器化技能",
        }
        mock_state.errors = []
        mock_state.step_results = {}

        with patch("core.agent.student_runtime.PipelineRunner") as MockRunner, \
             patch("core.agent.student_runtime.LLM_API_KEY", "test-key"):
            mock_runner = MagicMock()
            mock_runner.run = AsyncMock(return_value=mock_state)
            mock_runner.run_stages = AsyncMock(return_value=mock_state)
            mock_runner.steps = [MagicMock() for _ in range(5)]
            MockRunner.return_value = mock_runner

            with TestClient(app) as client:
                resp = _run_post(client, sid, "re_evaluate", {"task_id": task_id}, headers=auth_headers("student", student_id=sid))
                assert resp.status_code == 200
                data = resp.json()
                assert data["action"] == "re_evaluation_completed"
                assert "id" in data["data"]
                assert data["data"]["diagnosis_type"] == "task_re_evaluation"

        # 验证 GrowthTask 的 re_evaluation_id 已写入
        async def _check():
            async with async_session() as db:
                task = await db.get(GrowthTask, task_id)
                assert task.re_evaluation_id is not None

        _run(_check())


# ========================================
# Intent: ask
# ========================================

class TestRunAsk:
    """测试 /run intent=ask"""

    def test_ask_missing_message(self):
        """缺少 message -> action=error"""
        sid = _create_complete_student("Run问答缺消息")
        with TestClient(app) as client:
            resp = _run_post(client, sid, "ask", {}, headers=auth_headers("student", student_id=sid))
            data = resp.json()
            assert data["action"] == "error"
            assert "message" in data["message"]

    def test_ask_missing_llm_key(self):
        """LLM API Key 未配置 -> action=advice, ai_status=missing_key"""
        sid = _create_complete_student("Run问答无Key")
        with patch("core.agent.student_runtime.LLM_API_KEY", ""):
            with TestClient(app) as client:
                resp = _run_post(client, sid, "ask", {"message": "我下一步应该学什么？"}, headers=auth_headers("student", student_id=sid))
                data = resp.json()
                assert data["action"] == "advice"
                assert data["ai_status"] == "missing_key"
                assert "context" in data["data"]

    def test_ask_with_mock_llm(self):
        """AI 可用 -> action=advice（mock LLM）"""
        sid = _create_complete_student("Run问答有LLM")

        # Mock LLM client
        mock_response = MagicMock()
        mock_response.content = "根据你当前的能力画像，建议你先提升Docker和容器化技术，这将有助于你更好地胜任后端开发岗位。"

        mock_llm = MagicMock()
        mock_llm.complete = AsyncMock(return_value=mock_response)

        with patch("core.harness.llm.get_llm_client", return_value=mock_llm), \
             patch("core.agent.student_runtime.LLM_API_KEY", "test-key"):
            with TestClient(app) as client:
                resp = _run_post(client, sid, "ask", {"message": "我下一步应该学什么？"}, headers=auth_headers("student", student_id=sid))
                assert resp.status_code == 200
                data = resp.json()
                assert data["action"] == "advice"
                assert "Docker" in data["message"] or len(data["message"]) > 0
                assert data["ai_status"] == "available"

    def test_ask_llm_failure(self):
        """LLM 调用失败 -> action=advice, ai_status=provider_error"""
        sid = _create_complete_student("Run问答LLM失败")

        mock_llm = MagicMock()
        mock_llm.complete = AsyncMock(side_effect=Exception("LLM timeout"))

        with patch("core.harness.llm.get_llm_client", return_value=mock_llm), \
             patch("core.agent.student_runtime.LLM_API_KEY", "test-key"):
            with TestClient(app) as client:
                resp = _run_post(client, sid, "ask", {"message": "我该怎么提升？"}, headers=auth_headers("student", student_id=sid))
                assert resp.status_code == 200
                data = resp.json()
                assert data["action"] == "advice"
                assert data["ai_status"] == "provider_error"

    def test_ask_capability_boundary_in_prompt(self):
        """验证 ask 的不支持功能返回包含能力边界说明"""
        sid = _create_complete_student("Run能力边界测试")

        # 不支持的功能（如"模拟面试"）应直接返回预定义响应，不调用 LLM
        with TestClient(app) as client:
            resp = _run_post(client, sid, "ask", {"message": "你能帮我做模拟面试吗？"}, headers=auth_headers("student", student_id=sid))
            assert resp.status_code == 200
            data = resp.json()
            # 验证返回的是 advice action
            assert data["action"] == "advice"
            # 验证返回消息中包含能力边界提示
            assert "暂不支持" in data["message"] or "当前系统" in data["message"]
            # 验证 question_type 标记为 unsupported
            assert data["data"]["question_type"] == "unsupported_request"

    def test_ask_context_includes_student_state(self):
        """验证 ask 的 prompt 包含学生上下文信息"""
        sid = _create_complete_student("Run上下文测试")

        captured_messages = []
        mock_response = MagicMock()
        mock_response.content = "根据你的情况..."
        mock_llm = MagicMock()
        async def capture_complete(messages, **kwargs):
            captured_messages.extend(messages)
            return mock_response
        mock_llm.complete = capture_complete

        with patch("core.harness.llm.get_llm_client", return_value=mock_llm), \
             patch("core.agent.student_runtime.LLM_API_KEY", "test-key"):
            with TestClient(app) as client:
                _run_post(client, sid, "ask", {"message": "我下一步应该做什么？"}, headers=auth_headers("student", student_id=sid))

        # ask handler makes 2 LLM calls: tool suggestion + final answer
        # Find the final answer's system message (last system message)
        system_msgs = [m for m in captured_messages if m["role"] == "system"]
        assert len(system_msgs) >= 2, "Expected at least 2 system messages (tool suggestion + final answer)"
        final_system_msg = system_msgs[-1]["content"]
        assert "Run上下文测试" in final_system_msg
        assert "后端开发" in final_system_msg  # target_job


# ========================================
# Schema 安全测试（验证 Task 2 修复）
# ========================================

class TestSchemaDefaults:
    """验证 Schema 可变默认值修复后多次实例化不共享状态"""

    def test_agent_result_isolation(self):
        """多个 AgentResult 实例不共享 data 和 next_actions"""
        from core.agent.schemas import AgentResult, AgentAction

        r1 = AgentResult(action=AgentAction.ADVICE)
        r2 = AgentResult(action=AgentAction.ADVICE)

        r1.data["key"] = "value1"
        r1.next_actions.append({"label": "a", "intent": "b"})

        assert "key" not in r2.data
        assert len(r2.next_actions) == 0

    def test_agent_request_isolation(self):
        """多个 AgentRequest 实例不共享 payload"""
        from core.agent.schemas import AgentRequest, AgentIntent

        r1 = AgentRequest(intent=AgentIntent.DIAGNOSE)
        r2 = AgentRequest(intent=AgentIntent.DIAGNOSE)

        r1.payload["foo"] = "bar"
        assert "foo" not in r2.payload

    def test_next_action_isolation(self):
        """NextAction payload 不共享"""
        from core.agent.schemas import NextAction

        a1 = NextAction(label="x", intent="y")
        a2 = NextAction(label="x", intent="y")

        a1.payload["k"] = "v"
        assert "k" not in a2.payload
