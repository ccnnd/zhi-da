# 端到端智能体成长闭环测试
# 验证：创建学生 -> 诊断(信息不足) -> 补充信息 -> 诊断(完成) -> 成长任务 -> 审核证据 -> 复评 -> 问答
import pytest
import asyncio
import tempfile
import os
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from db.models import Base, Student, GrowthTask, DiagnosisResult, AgentConversation, Enterprise, JobPost, JobAbilityModel
from db.database import get_db, async_session, init_db
from main import app
from core.harness.step import PipelineState
from tests.conftest import auth_headers


# 使用临时文件数据库进行测试（避免 file::memory:?cache=shared 的跨连接可见性问题）
_test_db_fd, _test_db_path = tempfile.mkstemp(suffix=".db", prefix="test_growth_loop_")
TEST_DB_URL = f"sqlite+aiosqlite:///{_test_db_path}"

test_engine = create_async_engine(TEST_DB_URL, echo=False)
TestSessionLocal = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


async def override_get_db():
    async with TestSessionLocal() as session:
        yield session


def _run(coro):
    """Helper to run async coroutines in sync tests."""
    return asyncio.run(coro)


@pytest.fixture(scope="module", autouse=True)
def setup_db():
    """创建测试数据库表并设置依赖覆盖，测试结束后清理。"""
    async def _create():
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def _drop():
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)

    _run(_create())
    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)
    _run(_drop())
    # 清理临时文件
    try:
        os.close(_test_db_fd)
        os.unlink(_test_db_path)
    except OSError:
        pass


def _run_post(client: TestClient, student_id: int, intent: str, payload: dict = None, headers: dict = None):
    """Helper: POST /api/agent/student/{id}/run"""
    body = {"intent": intent, "payload": payload or {}}
    return client.post(f"/api/agent/student/{student_id}/run", json=body, headers=headers)


# ========================================
# 端到端成长闭环测试
# ========================================

class TestAgenticGrowthLoop:
    """端到端智能体成长闭环测试。"""

    def test_full_growth_loop(self):
        """创建学生 -> 诊断(信息不足) -> 补充信息 -> 成长任务(无诊断) -> 问答 -> navigate"""
        with TestClient(app) as client:
            # 1. 创建学生（信息不完整）
            create_resp = client.post("/api/students", json={
                "name": "闭环测试学生",
                "grade": "大三",
                "major": "计算机科学",
            })
            assert create_resp.status_code == 200
            student_id = create_resp.json()["id"]

            # 2. 尝试诊断（信息不足，应返回 ask_for_info）
            h = auth_headers("student", student_id=student_id)
            diag_resp = _run_post(client, student_id, "diagnose", headers=h)
            assert diag_resp.status_code == 200
            result = diag_resp.json()
            assert result["action"] == "ask_for_info"
            assert "missing_fields" in result["data"]
            assert len(result["data"]["missing_fields"]) > 0

            # 3. 补充学生信息（使用 StudentUpdate 格式）
            update_resp = client.put(f"/api/students/{student_id}", json={
                "tech_skills": {"Python": 70, "FastAPI": 60, "Docker": 50},
                "project_exp": [
                    {"name": "电商平台", "role": "后端开发", "description": "使用 FastAPI 开发 REST API", "duration": "3个月"}
                ],
                "resume_text": "大三计算机专业学生，熟悉 Python 和 Web 开发，有一个电商项目经验。",
                "academic_foundation": {
                    "gpa": "3.5/4.0",
                    "rank": "前20%",
                    "core_courses": [{"name": "数据结构", "score": 90}, {"name": "操作系统", "score": 85}],
                    "awards": ["校级编程竞赛二等奖"],
                    "normalized_score": 82,
                },
                "soft_skill_evidence": {
                    "teamwork": {"level": "medium", "evidence": ["电商项目中负责后端与前端对接"], "normalized_score": 70},
                    "communication": {"level": "medium", "evidence": ["项目答辩获得好评"], "normalized_score": 65},
                },
                "target_job": "后端开发",
            }, headers=h)
            assert update_resp.status_code == 200

            # 4. 查看成长任务（无诊断，应返回引导）
            growth_resp = _run_post(client, student_id, "continue_growth", headers=h)
            assert growth_resp.status_code == 200
            growth_result = growth_resp.json()
            assert growth_result["action"] == "advice"
            assert growth_result["data"]["diagnosis"] is None
            assert growth_result["data"]["tasks"] == []
            # 应该建议去诊断
            assert any(a["intent"] == "diagnose" for a in growth_result["next_actions"])

            # 5. 问答（通用建议）
            ask_resp = _run_post(client, student_id, "ask", {"message": "我应该怎么提升技术能力？"}, headers=h)
            assert ask_resp.status_code == 200
            ask_result = ask_resp.json()
            assert ask_result["action"] == "advice"
            assert "used_tools" in ask_result["data"]
            assert "question_type" in ask_result["data"]
            assert "grounding" in ask_result["data"]

            # 6. 问答（不支持的功能）
            unsupported_resp = _run_post(client, student_id, "ask", {"message": "帮我模拟面试"}, headers=h)
            assert unsupported_resp.status_code == 200
            unsupported_result = unsupported_resp.json()
            assert unsupported_result["data"]["question_type"] == "unsupported_request"

            # 7. navigate 意图
            nav_resp = _run_post(client, student_id, "navigate", {"target": "authorization_tab"}, headers=h)
            assert nav_resp.status_code == 200
            nav_result = nav_resp.json()
            assert nav_result["action"] == "advice"
            assert nav_result["data"]["target"] == "authorization_tab"

    def test_diagnose_review_reevaluate_loop(self):
        """诊断(完成) -> 审核证据 -> 复评 完整闭环（mock pipeline）。"""
        # 创建完整学生
        async def _create():
            async with TestSessionLocal() as db:
                student = Student(
                    name="闭环审核学生", grade="大三", major="计算机",
                    target_job="后端开发", tech_skills={"Python": 80},
                    project_exp=[{"name": "项目A"}], resume_text="简历内容",
                    academic_foundation={"gpa": "3.5"},
                    soft_skill_evidence={"lead": {"level": "好"}},
                )
                db.add(student)
                await db.commit()
                await db.refresh(student)
                return student.id

        sid = _run(_create())

        # Mock PipelineRunner 用于诊断
        mock_state = PipelineState(input={"id": sid})
        mock_state.results = {
            "profile": {"tech_skills": 0.7, "project_exp": 0.6, "academic_foundation": 0.65, "domain_knowledge": 0.5, "soft_skill_evidence": 0.55},
            "match_result": {
                "match_score": 0.85,
                "dimension_scores": {"tech_skills": 0.7, "project_exp": 0.6, "academic_foundation": 0.65, "domain_knowledge": 0.5, "soft_skill_evidence": 0.55},
                "top5_jobs": [
                    {"job_id": "post_1", "title": "后端开发", "match_score": 0.85, "company": "测试企业", "reason": "技术匹配", "matched_skills": ["Python"], "missing_skills": ["Docker"]},
                ],
                "gap_details": [{"dimension": "tech_skills", "gap": "Docker", "severity": "medium"}],
            },
            "gap_explanation": "需要提升Docker和容器化技能",
            "growth_path": {"phases": [{"tasks": [{"name": "学习Docker", "description": "Docker教程", "linked_gap": "tech_skills", "target_dimension": "tech_skills", "expected_impact": {"tech_skills": 0.05}, "criteria": "完成教程", "resources": []}]}]},
            "career_advice": "建议先学习Docker和容器化技术",
        }
        mock_state.errors = []
        mock_state.step_results = {}

        with TestClient(app) as client:
            h = auth_headers("student", student_id=sid)
            # 1. 诊断（mock pipeline + mock LLM_API_KEY）
            with patch("core.agent.student_runtime.LLM_API_KEY", "test-key"), \
                 patch("core.agent.student_runtime.PipelineRunner") as MockRunner:
                mock_runner = MagicMock()
                mock_runner.run = AsyncMock(return_value=mock_state)
                mock_runner.run_stages = AsyncMock(return_value=mock_state)
                mock_runner.steps = [MagicMock() for _ in range(5)]
                MockRunner.return_value = mock_runner

                diag_resp = _run_post(client, sid, "diagnose", headers=h)
                assert diag_resp.status_code == 200
                diag_data = diag_resp.json()
                assert diag_data["action"] == "diagnosis_completed"
                diag_id = diag_data["data"]["id"]

            # 2. 查看成长任务（应有任务）
            growth_resp = _run_post(client, sid, "continue_growth", headers=h)
            assert growth_resp.status_code == 200
            growth_data = growth_resp.json()
            assert growth_data["action"] == "advice"
            assert growth_data["data"]["diagnosis_id"] == diag_id
            assert len(growth_data["data"]["tasks"]) >= 1
            task_id = growth_data["data"]["tasks"][0]["id"]

            # 3. 提交充分证据审核（需超过 100 字且包含任务关键词）
            evidence = "我完成了Docker官方教程的全部章节学习，包括镜像构建、容器编排、Docker Compose等核心内容。还动手实现了一个完整的多容器部署项目，使用Dockerfile构建了自定义镜像，并通过docker-compose.yml编排了3个服务容器。"
            review_resp = _run_post(client, sid, "review_task", {
                "task_id": task_id,
                "evidence": evidence,
            }, headers=h)
            assert review_resp.status_code == 200
            review_data = review_resp.json()
            assert review_data["action"] == "task_reviewed"
            assert review_data["data"]["status"] == "completed"
            assert review_data["data"]["review"]["preliminary_approved"] is True
            # next_actions 应包含 re_evaluate
            intents = [a["intent"] for a in review_data["next_actions"]]
            assert "re_evaluate" in intents

            # 4. 复评（mock pipeline + mock LLM_API_KEY）
            mock_state2 = PipelineState(input={"id": sid})
            mock_state2.results = {
                "profile": {"tech_skills": 0.75, "project_exp": 0.65, "academic_foundation": 0.65, "domain_knowledge": 0.55, "soft_skill_evidence": 0.55},
                "match_result": {
                    "match_score": 0.88,
                    "dimension_scores": {"tech_skills": 0.75, "project_exp": 0.65, "academic_foundation": 0.65, "domain_knowledge": 0.55, "soft_skill_evidence": 0.55},
                    "top5_jobs": [
                        {"job_id": "post_1", "title": "后端开发", "match_score": 0.88, "company": "测试企业", "reason": "提升后更匹配", "matched_skills": ["Python", "Docker"], "missing_skills": []},
                    ],
                    "gap_details": [],
                },
                "gap_explanation": "核心技能已基本满足",
                "growth_path": {"phases": []},
                "career_advice": "继续保持学习势头",
            }
            mock_state2.errors = []
            mock_state2.step_results = {}

            with patch("core.agent.student_runtime.LLM_API_KEY", "test-key"), \
                 patch("core.agent.student_runtime.PipelineRunner") as MockRunner2:
                mock_runner2 = MagicMock()
                mock_runner2.run = AsyncMock(return_value=mock_state2)
                mock_runner2.run_stages = AsyncMock(return_value=mock_state2)
                mock_runner2.steps = [MagicMock() for _ in range(5)]
                MockRunner2.return_value = mock_runner2

                reeval_resp = _run_post(client, sid, "re_evaluate", {"task_id": task_id}, headers=h)
                assert reeval_resp.status_code == 200
                reeval_data = reeval_resp.json()
                assert reeval_data["action"] == "re_evaluation_completed"
                assert "id" in reeval_data["data"]
                assert reeval_data["data"]["diagnosis_type"] == "task_re_evaluation"


# ========================================
# 问题分类器测试
# ========================================

class TestQuestionClassifier:
    """测试问题分类器。"""

    def test_profile_question(self):
        from core.agent.question_classifier import classify_question, QuestionType
        r = classify_question("我的技术技能怎么样？")
        assert r.question_type == QuestionType.PROFILE

    def test_diagnosis_question(self):
        from core.agent.question_classifier import classify_question, QuestionType
        # "匹配度" 包含 "匹配" 会命中 JOB_MATCH，需使用纯诊断关键词
        r = classify_question("我的诊断结果怎么样？")
        assert r.question_type == QuestionType.DIAGNOSIS

    def test_growth_task_question(self):
        from core.agent.question_classifier import classify_question, QuestionType
        r = classify_question("我下一步做哪个任务？")
        assert r.question_type == QuestionType.GROWTH_TASK

    def test_job_match_question(self):
        from core.agent.question_classifier import classify_question, QuestionType
        r = classify_question("有哪些适合我的岗位？")
        assert r.question_type == QuestionType.JOB_MATCH

    def test_authorization_question(self):
        from core.agent.question_classifier import classify_question, QuestionType
        # 需要包含完整的授权关键词如 "授权" 或 "企业看到"
        r = classify_question("我授权了哪些企业？")
        assert r.question_type == QuestionType.AUTHORIZATION

    def test_unsupported_request(self):
        from core.agent.question_classifier import classify_question, QuestionType
        r = classify_question("帮我模拟面试")
        assert r.question_type == QuestionType.UNSUPPORTED

    def test_general_advice(self):
        from core.agent.question_classifier import classify_question, QuestionType
        r = classify_question("你好")
        assert r.question_type == QuestionType.GENERAL_ADVICE


# ========================================
# 工具注册表测试
# ========================================

class TestToolRegistry:
    """测试工具注册表。"""

    def test_all_tools_registered(self):
        from core.agent.tools import register_all_tools

        mock_db = AsyncMock(spec=AsyncSession)
        registry = register_all_tools(mock_db, 9002)

        tools = registry.list_tools()
        tool_names = [t["name"] for t in tools]
        assert "get_student_profile" in tool_names
        assert "get_latest_diagnosis" in tool_names
        assert "get_growth_tasks" in tool_names
        assert "get_authorizations" in tool_names
        assert "get_visible_jobs" in tool_names
        assert "get_job_detail" in tool_names
        assert "get_diagnosis_history" in tool_names

    def test_all_tools_read_only(self):
        from core.agent.tools import register_all_tools

        mock_db = AsyncMock(spec=AsyncSession)
        registry = register_all_tools(mock_db, 9002)

        for tool in registry.list_tools():
            assert tool["read_only"] is True

    def test_openai_format(self):
        from core.agent.tools import register_all_tools

        mock_db = AsyncMock(spec=AsyncSession)
        registry = register_all_tools(mock_db, 9002)

        openai_tools = registry.list_openai_tools()
        assert len(openai_tools) == 7
        assert all(t["type"] == "function" for t in openai_tools)


# ========================================
# 对话记忆服务测试
# ========================================

class TestAgentMemoryService:
    """测试对话记忆服务。"""

    def test_append_and_get_messages(self):
        from core.services.agent_memory_service import append_message, get_recent_messages

        async def _test():
            async with TestSessionLocal() as db:
                # 追加消息
                await append_message(db, 9006, "user", "你好", intent="ask")
                await append_message(db, 9006, "assistant", "你好！有什么可以帮你的？", intent="ask", metadata={"used_tools": ["get_student_profile"]})
                await append_message(db, 9006, "user", "我的匹配度怎么样？", intent="ask")

                # 获取最近消息
                messages = await get_recent_messages(db, 9006)
                assert len(messages) == 3
                assert messages[0]["role"] == "user"
                assert messages[1]["role"] == "assistant"
                assert messages[2]["role"] == "user"
                # 验证按时间正序
                assert "你好" in messages[0]["content"]
                assert "匹配度" in messages[2]["content"]

        _run(_test())
