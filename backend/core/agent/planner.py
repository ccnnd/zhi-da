# Planner——状态驱动的智能体决策器
# Planner 不再只是 intent 路由，而是根据学生状态 + 意图选择最合适的 Skill。
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from core.agent.runtime import ContextLoader
from core.agent.skills import SkillRegistry, get_skill_registry

logger = logging.getLogger(__name__)


# 允许的导航目标白名单
NAVIGATE_TARGET_WHITELIST = {
    "dashboard",
    "profile",
    "profile_input",
    "diagnosis",
    "match_tab",
    "growth_tasks",
    "growth_tab",
    "authorization_tab",
    "enterprise_list",
    "job_list",
    "settings",
}

# 证据最小/最大长度
EVIDENCE_MIN_LENGTH = 2
EVIDENCE_MAX_LENGTH = 2000


@dataclass
class StudentState:
    """学生当前状态摘要，供 Planner 做决策。"""
    profile_completeness: float = 0.0
    is_complete: bool = False
    missing_fields: list[str] = field(default_factory=list)
    has_diagnosis: bool = False
    pending_tasks: int = 0
    completed_tasks: int = 0
    has_authorization: bool = False


@dataclass
class Plan:
    """规划结果——包含 Skill 选择和决策理由。"""
    action: str  # error | ask_for_info | run_diagnosis | continue_growth | review_task | run_re_evaluation | ask | navigate
    reason: str = ""
    extra: dict = field(default_factory=dict)
    selected_skill: str = ""  # 对应 SkillRegistry 中的 Skill 名称
    required_tools: list[str] = field(default_factory=list)
    risk_level: str = "low"

    def __post_init__(self):
        if self.extra is None:
            self.extra = {}


class StudentPlanner:
    """状态驱动决策器。

    决策优先级（规则引擎，规则优先，LLM 辅助）：
    1. 信息不足时 -> profile_completeness_check
    2. 没有诊断时 -> diagnose_student
    3. 有未完成任务时 -> plan_growth_tasks
    4. 任务提交证据 -> review_task_evidence
    5. 多任务完成后 -> re_evaluate_student
    6. 想投递/展示 -> authorization_advice
    7. 自由提问 -> answer_student_question
    """

    @staticmethod
    async def _build_student_state(student_context: dict | None) -> StudentState:
        """从 student_context 构建 StudentState 摘要。"""
        if student_context is None:
            return StudentState()

        completeness = await ContextLoader.check_info_completeness(student_context)

        # 判断是否有诊断
        has_diagnosis = bool(student_context.get("latest_diagnosis"))

        # 判断任务状态
        growth_progress = student_context.get("growth_progress", {})
        tasks = growth_progress.get("tasks", [])
        pending = sum(1 for t in tasks if t.get("status") in ("pending", "in_progress"))
        completed = sum(1 for t in tasks if t.get("status") == "completed")

        # 判断授权
        authorizations = student_context.get("authorizations", [])
        has_auth = len(authorizations) > 0

        return StudentState(
            profile_completeness=completeness["completeness"],
            is_complete=completeness["is_complete"],
            missing_fields=completeness["missing_fields"],
            has_diagnosis=has_diagnosis,
            pending_tasks=pending,
            completed_tasks=completed,
            has_authorization=has_auth,
        )

    @staticmethod
    def _select_skill(
        intent: str,
        state: StudentState,
        skill_registry: SkillRegistry,
    ) -> str:
        """根据意图和学生状态选择最合适的 Skill。

        这是 Planner 的核心决策逻辑：状态驱动 + 规则优先。
        """
        # diagnose 意图
        if intent == "diagnose":
            if not state.is_complete:
                return "profile_completeness_check"
            return "diagnose_student"

        # review_task 意图
        if intent == "review_task":
            return "review_task_evidence"

        # re_evaluate 意图
        if intent == "re_evaluate":
            return "re_evaluate_student"

        # continue_growth 意图
        if intent == "continue_growth":
            if not state.has_diagnosis:
                return "diagnose_student"
            return "plan_growth_tasks"

        # ask 意图 —— 统一由 answer_student_question 处理，
        # 问题类型差异化（诊断/成长/岗位等）在 runtime 层由 classify_question 完成，
        # planner 层不做状态分支（避免误导维护者以为有差异化决策）。
        if intent == "ask":
            return "answer_student_question"

        # navigate 意图 —— 授权相关页面
        if intent == "navigate":
            return "authorization_advice"

        return ""

    @staticmethod
    async def plan(
        student_context: dict | None,
        intent: str,
        payload: dict,
        skill_registry: SkillRegistry | None = None,
    ) -> Plan:
        """基于意图 + 学生状态做出 Skill 级决策。

        Args:
            student_context: 学生上下文数据（None 表示学生不存在）。
            intent: 用户意图。
            payload: 请求载荷。
            skill_registry: Skill 注册表，默认使用全局单例。

        Returns:
            Plan: 包含 action、selected_skill、reason 等信息的决策结果。
        """
        if skill_registry is None:
            skill_registry = get_skill_registry()

        # 学生不存在
        if student_context is None:
            return Plan(
                action="error",
                reason="学生不存在",
                selected_skill="",
            )

        # 构建学生状态
        state = await StudentPlanner._build_student_state(student_context)

        # 选择 Skill
        selected_skill_name = StudentPlanner._select_skill(intent, state, skill_registry)
        skill = skill_registry.get(selected_skill_name) if selected_skill_name else None
        required_tools = skill.tools if skill else []
        risk_level = skill.risk_level if skill else "low"

        # ---- 按意图执行决策逻辑 ----

        # diagnose 意图
        if intent == "diagnose":
            if not state.is_complete:
                return Plan(
                    action="ask_for_info",
                    reason=f"学生信息完整度仅 {state.profile_completeness:.0%}，需要补充关键信息",
                    extra={
                        "missing_fields": state.missing_fields,
                        "completeness": state.profile_completeness,
                    },
                    selected_skill="profile_completeness_check",
                    required_tools=["get_student_profile"],
                    risk_level="low",
                )
            return Plan(
                action="run_diagnosis",
                reason="信息完整，执行诊断",
                selected_skill="diagnose_student",
                required_tools=required_tools,
                risk_level="medium",
            )

        # review_task 意图
        if intent == "review_task":
            task_id = payload.get("task_id", "")
            evidence = payload.get("evidence", "")
            if not task_id or not evidence:
                return Plan(
                    action="error",
                    reason="review_task 需要 task_id 和 evidence",
                    selected_skill="review_task_evidence",
                )
            evidence_stripped = evidence.strip()
            if len(evidence_stripped) < EVIDENCE_MIN_LENGTH:
                return Plan(
                    action="error",
                    reason=f"证据过于简短（至少 {EVIDENCE_MIN_LENGTH} 个字符）",
                    selected_skill="review_task_evidence",
                )
            if len(evidence_stripped) > EVIDENCE_MAX_LENGTH:
                return Plan(
                    action="error",
                    reason=f"证据超过最大长度限制（{EVIDENCE_MAX_LENGTH} 个字符）",
                    selected_skill="review_task_evidence",
                )
            return Plan(
                action="review_task",
                reason="审核任务证据",
                selected_skill="review_task_evidence",
                required_tools=required_tools,
                risk_level="medium",
            )

        # re_evaluate 意图
        if intent == "re_evaluate":
            task_id = payload.get("task_id", "")
            if not task_id:
                return Plan(
                    action="error",
                    reason="re_evaluate 需要 task_id",
                    selected_skill="re_evaluate_student",
                )
            return Plan(
                action="run_re_evaluation",
                reason="执行复评",
                selected_skill="re_evaluate_student",
                required_tools=required_tools,
                risk_level="medium",
            )

        # continue_growth 意图
        if intent == "continue_growth":
            return Plan(
                action="continue_growth",
                reason="查看当前成长计划",
                selected_skill="plan_growth_tasks",
                required_tools=required_tools,
                risk_level="medium",
            )

        # ask 意图
        if intent == "ask":
            message = payload.get("message", "")
            if not message:
                return Plan(
                    action="error",
                    reason="ask 需要 message",
                    selected_skill="answer_student_question",
                )
            if len(message) > 1000:
                payload["message"] = message[:1000]
            return Plan(
                action="ask",
                reason="上下文问答",
                selected_skill="answer_student_question",
                required_tools=required_tools,
                risk_level="low",
            )

        # navigate 意图
        if intent == "navigate":
            target = payload.get("target", "")
            if not target:
                return Plan(
                    action="error",
                    reason="navigate 需要 target 参数",
                    selected_skill="",
                )
            if target not in NAVIGATE_TARGET_WHITELIST:
                return Plan(
                    action="error",
                    reason=f"不支持的导航目标: {target}。允许的目标: {', '.join(sorted(NAVIGATE_TARGET_WHITELIST))}",
                    selected_skill="",
                )
            return Plan(
                action="navigate",
                reason="导航到指定页面",
                extra={"target": target},
                selected_skill="authorization_advice" if target == "authorization_tab" else "",
                required_tools=required_tools if target == "authorization_tab" else [],
                risk_level="low",
            )

        return Plan(
            action="error",
            reason=f"未知意图: {intent}",
            selected_skill="",
        )
