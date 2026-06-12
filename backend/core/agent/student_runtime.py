# StudentAgentRuntime——统一智能体运行时入口
# 负责接收意图、加载上下文、规划动作、执行并返回统一 AgentResult
import asyncio
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from db.models import DiagnosisResult as DiagORM, Student as StudentORM
from core.agent.runtime import ContextLoader, ExplanationBuilder
from core.agent.schemas import AgentResult, AgentAction, AIStatus, NextAction
from core.agent.planner import StudentPlanner, Plan
from core.services import diagnosis_service, growth_task_service, agent_memory_service, agent_trace_service
from core.harness.runner import PipelineRunner
from core.harness.step import PipelineState
from core.harness.fallback import FallbackHandler
from core.pipelines.diagnosis_pipeline import ProfileStep, MatchStep, GapStep, PathStep, AdviceStep
from config.settings import LLM_API_KEY, LLM_MODEL

logger = logging.getLogger(__name__)


def build_reasoning(
    basis: list[str],
    decision: str,
    confidence: float = 0.8,
    used_tools: list[str] | None = None,
    limits: list[str] | None = None,
    selected_skill: str = "",
    goal: str = "",
    next_check: str = "",
) -> dict:
    """构建统一的 reasoning 结构（Phase 8.3 可解释性标准）。

    所有 Agent 关键输出都必须包含此结构：
    - goal: 本次决策的目标
    - basis: 使用了哪些学生信息、任务信息或诊断信息
    - decision: 为什么给出这个动作或结论
    - confidence: 0.0-1.0 的置信度
    - used_tools: 实际调用的工具
    - limits: 当前判断的限制和不确定性
    - selected_skill: Planner 选择的 Skill 名称
    - next_check: 下次应验证的条件
    """
    result = {
        "basis": basis,
        "decision": decision,
        "confidence": round(max(0.0, min(1.0, confidence)), 2),
        "used_tools": used_tools or [],
        "limits": limits or [],
    }
    if selected_skill:
        result["selected_skill"] = selected_skill
    if goal:
        result["goal"] = goal
    if next_check:
        result["next_check"] = next_check
    return result


class StudentAgentRuntime:
    """统一智能体入口。

    用法:
        runtime = StudentAgentRuntime()
        result = await runtime.run(db, student_id, intent, payload)
    """

    # ---------- 共享内部方法（消除 run / run_stream 重复逻辑）----------

    async def _load_student_dict(self, db: AsyncSession, student_id: int) -> dict | None:
        """加载学生 ORM 并转为 dict。返回 None 表示学生不存在。"""
        result = await db.execute(select(StudentORM).where(StudentORM.id == student_id))
        student_orm = result.scalar_one_or_none()
        if not student_orm:
            return None
        d = {
            "id": student_orm.id, "name": student_orm.name, "grade": student_orm.grade,
            "major": student_orm.major, "target_job": student_orm.target_job,
            "tech_skills": student_orm.tech_skills or {},
            "project_exp": student_orm.project_exp or [],
            "soft_skills": student_orm.soft_skills or {},
            "domain_knowledge": student_orm.domain_knowledge or {},
            "resume_text": student_orm.resume_text or "",
            "academic_foundation": student_orm.academic_foundation or {},
            "soft_skill_evidence": student_orm.soft_skill_evidence or {},
            # 新字段
            "school": student_orm.school or "",
            "education_level": student_orm.education_level or "",
            "phone": student_orm.phone or "",
            "email": student_orm.email or "",
            "self_evaluation": student_orm.self_evaluation or "",
            "profile_completeness": student_orm.profile_completeness or 0.0,
            "profile_sections": student_orm.profile_sections or {},
        }
        return d

    async def _get_prev_diagnosis(self, db: AsyncSession, student_id: int):
        """获取学生最新一条诊断 ORM 对象（可能为 None）。"""
        prev_result = await db.execute(
            select(DiagORM).where(DiagORM.student_id == student_id).order_by(desc(DiagORM.version)).limit(1)
        )
        return prev_result.scalar_one_or_none()

    def _build_pipeline_runner(self) -> PipelineRunner:
        """创建标准 5 步 pipeline runner，使用 FallbackHandler 进行异常降级。"""
        return PipelineRunner(
            steps=[ProfileStep(), MatchStep(), GapStep(), PathStep(), AdviceStep()],
            fallback_handler=FallbackHandler().handle,
        )

    async def _execute_pipeline(
        self,
        db: AsyncSession,
        student_id: int,
        student_dict: dict,
        prev_diag,
        diagnosis_type: str,
        trigger_event: str = "",
        task_id: str = "",
        on_progress=None,
    ) -> tuple:
        """执行诊断 pipeline 并保存结果（共享核心逻辑）。

        Args:
            db: 数据库会话。
            student_id: 学生 ID。
            student_dict: 学生数据 dict。
            prev_diag: 上一次诊断 ORM（可为 None）。
            diagnosis_type: 诊断类型（initial / manual_rerun / task_re_evaluation）。
            trigger_event: 触发事件描述。
            task_id: 关联的成长任务 ID（仅 re_evaluate 使用）。
            on_progress: 可选进度回调 async (step_name, progress, message)。

        Returns:
            (diag_response, pipeline_state) 元组。
        """
        state = PipelineState(input=student_dict, extra={
            "previous_dimension_scores": prev_diag.dimension_scores if prev_diag else {},
        })

        runner = self._build_pipeline_runner()
        state_out = await runner.run(state, on_progress=on_progress)

        # 保存诊断
        diag_response = await diagnosis_service.save_diagnosis(
            db, student_id, state_out, diagnosis_type, trigger_event
        )

        # 复评关联
        if diagnosis_type == "task_re_evaluation" and task_id:
            await growth_task_service.link_re_evaluation(db, task_id, diag_response.id)

        return diag_response, state_out

    def _build_diagnosis_agent_result(
        self,
        plan_action: str,
        diag_response,
        request_id: str = "",
        task_id: str = "",
        selected_skill: str = "",
    ) -> AgentResult:
        """根据 pipeline 结果构建统一的 AgentResult。"""
        ai_status = AIStatus(diag_response.ai_status) if diag_response.ai_status in {s.value for s in AIStatus} else AIStatus.AVAILABLE

        if plan_action == "run_diagnosis":
            return AgentResult(
                action=AgentAction.DIAGNOSIS_COMPLETED,
                message=f"诊断完成，匹配度 {diag_response.match_score:.0%}。",
                data=diag_response.model_dump(),
                next_actions=[
                    NextAction(label="查看成长任务", intent="continue_growth", payload={}),
                    NextAction(label="查看岗位匹配", intent="navigate", payload={"target": "match_tab"}),
                    NextAction(label="去授权企业查看", intent="navigate", payload={"target": "authorization_tab"}),
                ],
                ai_status=ai_status,
                reasoning=build_reasoning(
                    basis=["学生信息完整，执行诊断", f"使用 {LLM_MODEL} 模型"],
                    decision="完成五维能力画像和岗位匹配诊断",
                    confidence=0.8,
                    limits=["岗位匹配基于系统内可用岗位", "评分基于当前简历和技能数据"],
                    selected_skill=selected_skill,
                    goal="完成能力画像和岗位匹配诊断",
                    next_check="诊断完成后可查看成长任务",
                ),
                request_id=request_id,
            )
        else:
            return AgentResult(
                action=AgentAction.RE_EVALUATION_COMPLETED,
                message=f"复评完成！新版本匹配度 {diag_response.match_score:.0%}。",
                data=diag_response.model_dump(),
                next_actions=[
                    NextAction(label="查看能力变化", intent="navigate", payload={"target": "growth_tab"}),
                    NextAction(label="继续成长任务", intent="continue_growth", payload={}),
                ],
                ai_status=ai_status,
                reasoning=build_reasoning(
                    basis=[f"任务 {task_id} 完成后触发复评", f"使用 {LLM_MODEL} 模型"],
                    decision="完成复评，更新能力画像",
                    confidence=0.8,
                    limits=["复评基于当前简历数据，未自动更新技能"],
                    selected_skill=selected_skill,
                    goal="基于成长证据更新能力画像",
                    next_check="复评完成后可查看新匹配结果",
                ),
                request_id=request_id,
            )

    def _check_llm_key(self) -> bool:
        """检查 LLM API Key 是否已配置。"""
        return bool(LLM_API_KEY and LLM_API_KEY.strip())

    async def _write_trace_safe(
        self,
        db: AsyncSession,
        result: AgentResult,
        student_id: int,
        intent: str,
        selected_skill: str = "",
        input_summary: str = "",
        duration_ms: int = 0,
        fallback_used: bool = False,
    ) -> None:
        """安全写入 Agent Trace，失败不影响主流程。"""
        try:
            reasoning = result.reasoning or {}
            await agent_trace_service.write_trace(
                db,
                request_id=result.request_id,
                student_id=student_id,
                intent=intent,
                selected_skill=selected_skill or reasoning.get("selected_skill", ""),
                used_tools=reasoning.get("used_tools", []),
                rejected_tools=reasoning.get("rejected_tools", []),
                input_summary=input_summary,
                output_action=result.action.value if hasattr(result.action, 'value') else str(result.action),
                confidence=reasoning.get("confidence", 0.0),
                limits=reasoning.get("limits", []),
                duration_ms=duration_ms,
                fallback_used=fallback_used,
            )
        except Exception as exc:
            logger.warning("Agent Trace 写入失败（不影响主流程）: %s", exc)

    @staticmethod
    def _extract_pipeline_meta(state_out: PipelineState) -> dict:
        """从 PipelineState 提取 Harness 运行元数据（RunLogger + Fallback）。"""
        meta = {}
        summary = state_out.metadata.get("run_log_summary")
        if summary:
            meta["total_steps"] = summary.get("total_steps", 0)
            meta["total_duration_ms"] = round(summary.get("total_duration_ms", 0), 2)
            meta["error_count"] = summary.get("error_count", 0)
        fb_count = state_out.metadata.get("fallback_count", 0)
        if fb_count:
            meta["fallback_count"] = fb_count
            meta["fallback_steps"] = state_out.metadata.get("fallback_steps", [])
            meta["fallback_errors"] = state_out.metadata.get("fallback_errors", {})
        pipeline_dur = state_out.metadata.get("pipeline_duration")
        if pipeline_dur:
            meta["pipeline_duration_ms"] = round(pipeline_dur * 1000, 2)
        return meta

    # ---------- 主入口 ----------

    async def run(
        self,
        db: AsyncSession,
        student_id: int,
        intent: str,
        payload: dict,
        request_id: str = "",
    ) -> AgentResult:
        """主入口：加载上下文 -> 规划 -> 执行 -> 返回统一结果 + 写入 Trace。"""
        logger.info("[Agent] run request_id=%s student_id=%s intent=%s", request_id, student_id, intent)
        timer = agent_trace_service.TraceTimer()
        timer.start()

        result = await self._run_core(db, student_id, intent, payload, request_id)

        # 写入 Agent Trace（不影响主流程）
        input_summary = payload.get("message", "") or payload.get("task_id", "") or intent
        pipeline_meta = result.reasoning.get("pipeline_meta", {}) if result.reasoning else {}
        fallback_used = (
            result.ai_status == AIStatus.FALLBACK_RULE_BASED
            or pipeline_meta.get("fallback_count", 0) > 0
        )
        await self._write_trace_safe(
            db, result, student_id, intent,
            selected_skill=result.reasoning.get("selected_skill", ""),
            input_summary=input_summary,
            duration_ms=timer.elapsed_ms(),
            fallback_used=fallback_used,
        )
        return result

    async def _run_core(
        self,
        db: AsyncSession,
        student_id: int,
        intent: str,
        payload: dict,
        request_id: str = "",
    ) -> AgentResult:
        """核心执行逻辑（不含 Trace 写入）。"""
        # 1. 加载上下文
        student_context = await ContextLoader.load_student(db, student_id)

        # 2. 规划（状态驱动，输出 selected_skill）
        plan = await StudentPlanner.plan(student_context, intent, payload)
        skill = plan.selected_skill

        # 3. 按规划执行
        if plan.action == "error":
            return AgentResult(
                action=AgentAction.ERROR,
                message=plan.reason,
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=[plan.reason],
                    decision="无法执行",
                    confidence=1.0,
                    selected_skill=skill,
                ),
                request_id=request_id,
            )

        if plan.action == "ask_for_info":
            return await self._handle_ask_for_info(db, student_id, plan, request_id, skill)

        if plan.action == "run_diagnosis":
            return await self._handle_run_diagnosis(db, student_id, request_id, skill)

        if plan.action == "continue_growth":
            return await self._handle_continue_growth(db, student_id, request_id, skill)

        if plan.action == "review_task":
            return await self._handle_review_task(db, student_id, payload, request_id, skill)

        if plan.action == "run_re_evaluation":
            return await self._handle_re_evaluate(db, student_id, payload, request_id, skill)

        if plan.action == "ask":
            return await self._handle_ask(db, student_id, payload, request_id, skill)

        if plan.action == "navigate":
            return AgentResult(
                action=AgentAction.ADVICE,
                message=f"请前往对应页面操作。",
                data={"target": plan.extra.get("target", "")},
                next_actions=[],
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=[f"意图为导航至 {plan.extra.get('target', '未知页面')}"],
                    decision="引导用户前往对应页面",
                    confidence=1.0,
                    selected_skill=skill,
                    goal="引导学生到正确的操作页面",
                    next_check="",
                ),
                request_id=request_id,
            )

        return AgentResult(
            action=AgentAction.ERROR,
            message=f"未处理的动作: {plan.action}",
            ai_status=AIStatus.AVAILABLE,
            reasoning=build_reasoning(
                basis=[f"未处理的动作类型: {plan.action}"],
                decision="无法执行",
                confidence=1.0,
                selected_skill=skill,
            ),
            request_id=request_id,
        )

    async def run_stream(self, db: AsyncSession, student_id: int, intent: str, payload: dict, request_id: str = ""):
        """流式入口：用于 diagnose、re_evaluate 和 ask 等长耗时意图。

        生成 SSE 事件 dict（由路由层包装为 StreamingResponse）：
        - {"stage": "start", "progress": 0, "message": "..."}
        - {"stage": "<step>", "progress": 0.2, "message": "..."}
        - {"stage": "result", "result": {...AgentResult...}}
        - {"stage": "error", "message": "...", "ai_status": "..."}

        ask 意图的进度阶段：
        - thinking (20%): 问题分析
        - reasoning (60%): 数据检索
        - composing (90%): 组织回答
        """
        logger.info("[Agent] run_stream request_id=%s student_id=%s intent=%s", request_id, student_id, intent)

        # 1. 加载上下文
        student_context = await ContextLoader.load_student(db, student_id)

        # 2. 规划
        plan = await StudentPlanner.plan(student_context, intent, payload)

        # 3. 非流式意图直接走 run()（ask 意图走专属流式路径）
        if plan.action not in ("run_diagnosis", "run_re_evaluation", "ask"):
            result = await self.run(db, student_id, intent, payload, request_id=request_id)
            yield {"stage": "result", "request_id": request_id, "result": result.model_dump()}
            return

        # 3.5 ask 意图——流式问答路径（带进度事件）
        if plan.action == "ask":
            ask_queue = asyncio.Queue()

            async def ask_progress(stage, progress, message):
                await ask_queue.put(("progress", stage, progress, message))

            async def run_ask():
                try:
                    result = await self._handle_ask(
                        db, student_id, payload, request_id, plan.selected_skill,
                        on_progress=ask_progress,
                    )
                    await ask_queue.put(("done", result))
                except Exception as exc:
                    await ask_queue.put(("error", str(exc)))

            ask_task = asyncio.create_task(run_ask())

            agent_result = None
            while True:
                msg = await ask_queue.get()
                if msg[0] == "done":
                    agent_result = msg[1]
                    break
                if msg[0] == "error":
                    yield {
                        "stage": "error", "request_id": request_id,
                        "message": f"问答处理失败: {msg[1]}", "ai_status": "provider_error",
                    }
                    return
                _, stage, progress, message = msg
                yield {"stage": stage, "request_id": request_id, "progress": round(progress, 2), "message": message}

            # Trace 写入（流式 ask 路径）
            await self._write_trace_safe(
                db, agent_result, student_id, intent,
                selected_skill=agent_result.reasoning.get("selected_skill", "") if agent_result.reasoning else "",
                input_summary=payload.get("message", "") or intent,
            )

            yield {"stage": "result", "request_id": request_id, "result": agent_result.model_dump()}
            return

        # 4. 前置检查
        if plan.action == "error":
            yield {"stage": "error", "request_id": request_id, "message": plan.reason}
            return

        if not self._check_llm_key():
            yield {"stage": "error", "request_id": request_id, "message": "AI 服务未配置", "ai_status": "missing_key"}
            return

        # 5. 加载学生数据
        student_dict = await self._load_student_dict(db, student_id)
        if not student_dict:
            yield {"stage": "error", "request_id": request_id, "message": "学生不存在"}
            return

        # 6. 获取上次诊断
        prev_diag = await self._get_prev_diagnosis(db, student_id)

        yield {"stage": "start", "request_id": request_id, "progress": 0, "message": "开始诊断..."}

        # 7. 使用队列收集进度事件
        queue = asyncio.Queue()

        async def on_progress(step_name, progress, message):
            await queue.put(("progress", step_name, progress, message))

        async def run_pipeline():
            try:
                diag_response, state_out = await self._execute_pipeline(
                    db, student_id, student_dict, prev_diag,
                    diagnosis_type="initial" if not prev_diag else "manual_rerun" if plan.action == "run_diagnosis" else "task_re_evaluation",
                    trigger_event="" if plan.action == "run_diagnosis" else f"task_completed:{payload.get('task_id', '')}",
                    task_id=payload.get("task_id", "") if plan.action != "run_diagnosis" else "",
                    on_progress=on_progress,
                )
                await queue.put(("done", diag_response))
            except Exception as exc:
                await queue.put(("error", str(exc)))

        task = asyncio.create_task(run_pipeline())

        # 8. 从队列产出进度事件
        diag_response = None
        while True:
            msg = await queue.get()
            if msg[0] == "done":
                diag_response = msg[1]
                break
            if msg[0] == "error":
                yield {"stage": "error", "request_id": request_id, "message": f"Pipeline 执行失败: {msg[1]}", "ai_status": "provider_error"}
                return
            _, step_name, progress, message = msg
            yield {"stage": step_name, "request_id": request_id, "progress": round(progress, 2), "message": message}

        # 9. 构建最终结果
        try:
            agent_result = self._build_diagnosis_agent_result(
                plan.action, diag_response, request_id=request_id,
                task_id=payload.get("task_id", "") if plan.action != "run_diagnosis" else "",
                selected_skill=plan.selected_skill,
            )

            # 流式路径记忆写入
            try:
                intent_for_memory = "diagnose" if plan.action == "run_diagnosis" else "re_evaluate"
                task_id_mem = payload.get("task_id", "") if plan.action != "run_diagnosis" else ""
                changes = diag_response.dimension_changes or {}
                if intent_for_memory == "diagnose":
                    gaps = diag_response.gap_details[:2] if diag_response.gap_details else []
                    gap_names = [g.get("dimension", g.get("gap", "")) if isinstance(g, dict) else "" for g in gaps]
                    summary = f"诊断完成 v{diag_response.version}，匹配度{diag_response.match_score:.0%}"
                    if gap_names:
                        summary += f"，主要短板: {', '.join(filter(None, gap_names))}"
                else:
                    change_summary = ", ".join(f"{k}: {v:+.1f}" for k, v in list(changes.items())[:3]) if changes else "无显著变化"
                    summary = f"复评完成 v{diag_response.version}，匹配度{diag_response.match_score:.0%}，能力变化: {change_summary}"
                await agent_memory_service.maybe_write_memory(
                    db, student_id, intent_for_memory,
                    summary=summary,
                    metadata={"version": diag_response.version, "match_score": diag_response.match_score, "task_id": task_id_mem},
                )
            except Exception as mem_exc:
                logger.warning("流式路径记忆写入失败: %s", mem_exc)

            # Trace 写入（流式路径）
            await self._write_trace_safe(
                db, agent_result, student_id, intent,
                selected_skill=agent_result.reasoning.get("selected_skill", ""),
                input_summary=payload.get("task_id", "") or intent,
            )

            yield {"stage": "result", "request_id": request_id, "result": agent_result.model_dump()}

        except Exception as exc:
            logger.error("保存诊断结果失败: %s", exc)
            yield {"stage": "error", "request_id": request_id, "message": f"保存结果失败: {exc}", "ai_status": "provider_error"}

    # ---------- 各动作处理器 ----------

    async def _handle_ask_for_info(self, db: AsyncSession, student_id: int, plan: Plan, request_id: str = "", selected_skill: str = "") -> AgentResult:
        """信息不足，返回追问。"""
        missing_fields = plan.extra.get("missing_fields", [])
        questions = ExplanationBuilder.build_followup_questions(missing_fields)

        return AgentResult(
            action=AgentAction.ASK_FOR_INFO,
            message="请补充以下信息后再进行诊断，以获得更准确的能力画像。",
            data={
                "missing_fields": missing_fields,
                "completeness": plan.extra.get("completeness", 0),
                "followup_questions": questions,
            },
            next_actions=[
                NextAction(label="完善档案", intent="navigate", payload={"target": "profile_input"}),
                NextAction(label="暂不诊断", intent="navigate", payload={"target": "dashboard"}),
            ],
            ai_status=AIStatus.AVAILABLE,
            reasoning=build_reasoning(
                basis=[f"学生信息完整度仅 {plan.extra.get('completeness', 0):.0%}"],
                decision="信息不足，需要补充后再诊断",
                confidence=0.9,
                limits=["未执行诊断，无法给出能力评估"],
                selected_skill=selected_skill,
                goal="帮助学生补全档案信息",
                next_check="档案完整度达到阈值后可触发诊断",
            ),
            request_id=request_id,
        )

    async def _handle_run_diagnosis(self, db: AsyncSession, student_id: int, request_id: str = "", selected_skill: str = "") -> AgentResult:
        """执行诊断 pipeline 并保存结果（委托给共享 _execute_pipeline）。"""
        if not self._check_llm_key():
            return AgentResult(
                action=AgentAction.ERROR,
                message="AI 服务未配置，无法执行诊断。请联系学校管理员配置 LLM_API_KEY。",
                ai_status=AIStatus.MISSING_KEY,
                reasoning=build_reasoning(
                    basis=["LLM_API_KEY 未配置"],
                    decision="无法执行诊断",
                    confidence=1.0,
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )

        student_dict = await self._load_student_dict(db, student_id)
        if not student_dict:
            return AgentResult(
                action=AgentAction.ERROR,
                message="学生不存在",
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=["学生记录不存在"],
                    decision="无法执行诊断",
                    confidence=1.0,
                    selected_skill=selected_skill,
                ),
            )

        prev_diag = await self._get_prev_diagnosis(db, student_id)
        diagnosis_type = "initial" if not prev_diag else "manual_rerun"

        diag_response, state_out = await self._execute_pipeline(
            db, student_id, student_dict, prev_diag,
            diagnosis_type=diagnosis_type,
        )

        # 提取 pipeline 元数据用于 reasoning/trace
        pipeline_meta = self._extract_pipeline_meta(state_out)

        # 记忆写入：诊断摘要
        try:
            gaps = diag_response.gap_details[:2] if diag_response.gap_details else []
            gap_names = [g.get("dimension", g.get("gap", "")) if isinstance(g, dict) else "" for g in gaps]
            summary = f"诊断完成 v{diag_response.version}，匹配度{diag_response.match_score:.0%}"
            if gap_names:
                summary += f"，主要短板: {', '.join(filter(None, gap_names))}"
            await agent_memory_service.maybe_write_memory(
                db, student_id, "diagnose",
                summary=summary,
                metadata={"version": diag_response.version, "match_score": diag_response.match_score},
            )
        except Exception as mem_exc:
            logger.warning("诊断记忆写入失败: %s", mem_exc)

        result = self._build_diagnosis_agent_result("run_diagnosis", diag_response, request_id=request_id, selected_skill=selected_skill)
        # 注入 pipeline 元数据到 reasoning
        if result.reasoning:
            result.reasoning["pipeline_meta"] = pipeline_meta
        return result

    async def _handle_continue_growth(self, db: AsyncSession, student_id: int, request_id: str = "", selected_skill: str = "") -> AgentResult:
        """查看当前成长任务状态。"""
        # 获取最新诊断
        latest = await diagnosis_service.get_latest_diagnosis(db, student_id)
        if not latest:
            return AgentResult(
                action=AgentAction.ADVICE,
                message="还没有诊断记录，请先完成初诊。",
                data={"tasks": [], "diagnosis": None},
                next_actions=[
                    NextAction(label="开始诊断", intent="diagnose", payload={}),
                ],
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=["无诊断记录"],
                    decision="引导先完成初诊",
                    confidence=1.0,
                    limits=["无诊断数据，无法展示成长进度"],
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )

        # 获取任务列表
        tasks = await growth_task_service.list_student_tasks(db, student_id, latest.id)

        # 如果没有任务但有 growth_path，尝试补建
        if not tasks and latest.growth_path and latest.growth_path.get("phases"):
            try:
                await growth_task_service.create_from_growth_path(
                    db, student_id, latest.id, latest.growth_path
                )
                tasks = await growth_task_service.list_student_tasks(db, student_id, latest.id)
            except Exception as exc:
                logger.warning("补建 GrowthTask 失败: %s", exc)

        completed = sum(1 for t in tasks if t["status"] == "completed")
        total = len(tasks)

        # 记忆写入：成长进度摘要
        try:
            first_pending = next((t for t in tasks if t["status"] == "pending"), None)
            priority_task = first_pending.get("task_name", "") if first_pending else ""
            summary = f"成长进度: {completed}/{total} 任务已完成"
            if priority_task:
                summary += f"，当前最优先: {priority_task}"
            await agent_memory_service.maybe_write_memory(
                db, student_id, "continue_growth",
                summary=summary,
                metadata={"completed": completed, "total": total, "diagnosis_version": latest.version},
            )
        except Exception as mem_exc:
            logger.warning("成长进度记忆写入失败: %s", mem_exc)

        return AgentResult(
            action=AgentAction.ADVICE,
            message=f"当前成长进度：{completed}/{total} 个任务已完成。",
            data={
                "tasks": tasks,
                "diagnosis_id": latest.id,
                "diagnosis_version": latest.version,
                "match_score": latest.match_score,
                "completed_count": completed,
                "total_count": total,
            },
            next_actions=[
                NextAction(label="继续成长任务", intent="continue_growth", payload={}),
                NextAction(label="重新诊断", intent="diagnose", payload={}),
            ],
            ai_status=AIStatus.AVAILABLE,
            reasoning=build_reasoning(
                basis=[f"最新诊断版本 v{latest.version}", f"完成 {completed}/{total} 个任务"],
                decision="展示当前成长进度",
                confidence=0.9,
                selected_skill=selected_skill,
                goal="推进成长任务闭环",
                next_check="任务完成后可提交证据或触发复评",
            ),
            request_id=request_id,
        )

    async def _handle_review_task(self, db: AsyncSession, student_id: int, payload: dict, request_id: str = "", selected_skill: str = "") -> AgentResult:
        """审核任务证据。"""
        task_id = payload.get("task_id", "")
        evidence = payload.get("evidence", "")

        result = await growth_task_service.submit_evidence(db, task_id, student_id, evidence)

        if "error" in result:
            return AgentResult(
                action=AgentAction.ERROR,
                message=result.get("message", "审核失败"),
                data=result,
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=[result.get("message", "审核失败")],
                    decision="审核失败",
                    confidence=1.0,
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )

        review = result.get("review", {})
        approved = review.get("preliminary_approved", False)

        next_actions = []
        if approved:
            next_actions.append(
                NextAction(
                    label="触发复评",
                    intent="re_evaluate",
                    payload={"task_id": task_id},
                )
            )
            message = "证据审核通过！建议触发复评以评估能力提升。"
            reasoning = build_reasoning(
                basis=[f"任务 {task_id} 证据审核通过"],
                decision="建议触发复评评估能力提升",
                confidence=0.7,
                limits=["证据审核基于规则+AI判断，可能存在误判"],
                selected_skill=selected_skill,
                goal="审核任务证据质量",
                next_check="多个任务完成后可触发复评",
            )
        else:
            message = review.get("feedback", "证据审核未通过，请补充更多细节。")
            next_actions = [
                NextAction(label="修改证据", intent="review_task", payload={"task_id": task_id}),
                NextAction(label="查看任务要求", intent="continue_growth", payload={}),
            ]
            reasoning = build_reasoning(
                basis=[f"任务 {task_id} 证据审核未通过"],
                decision="建议补充更详细的证据",
                confidence=0.7,
                selected_skill=selected_skill,
                goal="审核任务证据质量",
                next_check="多个任务完成后可触发复评",
            )

        # 记忆写入：任务审核摘要
        try:
            review_feedback = review.get("feedback", "")
            summary = f"任务 {task_id} 审核{'通过' if approved else '未通过'}"
            if review_feedback:
                summary += f": {review_feedback[:100]}"
            await agent_memory_service.maybe_write_memory(
                db, student_id, "review_task",
                summary=summary,
                metadata={"task_id": task_id, "approved": approved, "status": result.get("status")},
            )
        except Exception as mem_exc:
            logger.warning("审核记忆写入失败: %s", mem_exc)

        return AgentResult(
            action=AgentAction.TASK_REVIEWED,
            message=message,
            data={
                "task_id": task_id,
                "status": result.get("status"),
                "review": review,
            },
            next_actions=next_actions,
            ai_status=AIStatus.AVAILABLE,
            reasoning=reasoning,
            request_id=request_id,
        )

    async def _handle_re_evaluate(self, db: AsyncSession, student_id: int, payload: dict, request_id: str = "", selected_skill: str = "") -> AgentResult:
        """执行复评 pipeline（委托给共享 _execute_pipeline）。"""
        if not self._check_llm_key():
            return AgentResult(
                action=AgentAction.ERROR,
                message="AI 服务未配置，无法执行复评。",
                ai_status=AIStatus.MISSING_KEY,
                reasoning=build_reasoning(
                    basis=["LLM_API_KEY 未配置"],
                    decision="无法执行复评",
                    confidence=1.0,
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )

        task_id = payload.get("task_id", "")

        # 校验任务归属（6.2 安全增强）
        if task_id:
            task_detail = await growth_task_service.get_task_detail(db, student_id, task_id)
            if task_detail is None:
                return AgentResult(
                    action=AgentAction.ERROR,
                    message=f"任务 {task_id} 不存在或不属于当前学生",
                    ai_status=AIStatus.AVAILABLE,
                    reasoning=build_reasoning(
                        basis=[f"任务归属校验失败: task_id={task_id}"],
                        decision="拒绝复评请求",
                        confidence=1.0,
                        selected_skill=selected_skill,
                    ),
                    request_id=request_id,
                )

        student_dict = await self._load_student_dict(db, student_id)
        if not student_dict:
            return AgentResult(
                action=AgentAction.ERROR,
                message="学生不存在",
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=["学生记录不存在"],
                    decision="无法执行复评",
                    confidence=1.0,
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )

        prev_diag = await self._get_prev_diagnosis(db, student_id)

        diag_response, state_out = await self._execute_pipeline(
            db, student_id, student_dict, prev_diag,
            diagnosis_type="task_re_evaluation",
            trigger_event=f"task_completed:{task_id}",
            task_id=task_id,
        )

        # 提取 pipeline 元数据
        pipeline_meta = self._extract_pipeline_meta(state_out)

        # 记忆写入：复评摘要
        try:
            changes = diag_response.dimension_changes or {}
            change_summary = ", ".join(f"{k}: {v:+.1f}" for k, v in list(changes.items())[:3]) if changes else "无显著变化"
            summary = f"复评完成 v{diag_response.version}，匹配度{diag_response.match_score:.0%}，能力变化: {change_summary}"
            await agent_memory_service.maybe_write_memory(
                db, student_id, "re_evaluate",
                summary=summary,
                metadata={"version": diag_response.version, "task_id": task_id, "match_score": diag_response.match_score},
            )
        except Exception as mem_exc:
            logger.warning("复评记忆写入失败: %s", mem_exc)

        result = self._build_diagnosis_agent_result(
            "run_re_evaluation", diag_response, request_id=request_id, task_id=task_id,
            selected_skill=selected_skill,
        )
        if result.reasoning:
            result.reasoning["pipeline_meta"] = pipeline_meta
        return result

    async def _handle_ask(self, db: AsyncSession, student_id: int, payload: dict, request_id: str = "", selected_skill: str = "", on_progress=None) -> AgentResult:
        """上下文问答——根据问题分类选择工具获取上下文。"""
        message = payload.get("message", "")

        # 加载最近对话记忆
        recent_messages = await agent_memory_service.get_recent_messages(db, student_id)

        # 1. 分类问题
        from core.agent.question_classifier import classify_question, QuestionType, QUESTION_TOOL_MAP
        classification = classify_question(message)

        # 流式进度：分析完成
        if on_progress:
            await on_progress("thinking", 0.2, "正在分析问题...")

        # 2. 不支持的功能：直接返回能力边界说明
        if classification.question_type == QuestionType.UNSUPPORTED:
            from core.agent.capabilities import build_capability_prompt
            # 统一记忆写入
            await agent_memory_service.maybe_write_memory(
                db, student_id, "ask", user_message=message,
                assistant_response="当前系统暂不支持该功能",
                metadata={"question_type": "unsupported_request"},
            )
            return AgentResult(
                action=AgentAction.ADVICE,
                message="当前系统暂不支持该功能。你可以问我关于能力画像、岗位匹配、成长任务、授权管理等方面的问题，我会基于你的数据给出具体建议。",
                data={
                    "question_type": classification.question_type.value,
                    "used_tools": [],
                    "grounding": {},
                },
                next_actions=[
                    NextAction(label="查看能力画像", intent="diagnose", payload={}),
                ],
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=[f"问题分类为 {classification.question_type.value}", classification.reason],
                    decision="基于 0 个工具的查询结果回答",
                    confidence=classification.confidence,
                    limits=["回答基于系统内数据，不含外部招聘信息"],
                    selected_skill=selected_skill,
                    goal="解答学生职业成长问题",
                    next_check="可继续追问或切换到具体操作",
                ),
                request_id=request_id,
            )

        # 3. 通过工具层获取上下文（只调用分类所需的工具）
        from core.agent.tools import register_all_tools
        registry = register_all_tools(db, student_id)

        used_tools = []
        tool_results = {}

        for tool_name in classification.required_tools:
            result = await registry.call(tool_name, db=db, student_id=student_id)
            used_tools.append(tool_name)
            if result.success:
                tool_results[tool_name] = result.data
            else:
                tool_results[tool_name] = None

        # 4.5 LLM 建议补充工具（受控模式）
        suggested_tools = []
        rejected_tools = []
        if LLM_API_KEY and LLM_API_KEY.strip():
            try:
                from core.harness.llm import get_llm_client
                llm_suggest = get_llm_client()
                available_tools = registry.list_tools()
                tool_descriptions = "\n".join([
                    f"- {t['name']}: {t['description']}" for t in available_tools
                ])
                already_called = ", ".join(used_tools) if used_tools else "无"

                suggest_messages = [
                    {"role": "system", "content": "你是工具选择助手。根据用户问题判断是否需要额外工具。只输出工具名称列表，用逗号分隔。如果不需要额外工具，输出 NONE。"},
                    {"role": "user", "content": f"用户问题：{message}\n\n已调用的工具：{already_called}\n\n可用工具：\n{tool_descriptions}\n\n是否需要额外工具？"},
                ]
                suggest_response = await llm_suggest.complete(suggest_messages, max_tokens=200)
                suggest_text = suggest_response.content.strip()

                if suggest_text != "NONE" and suggest_text:
                    raw_suggestions = [s.strip() for s in suggest_text.split(",")]
                    # 后端审批：检查全局 allowlist 和 intent 级白名单
                    approved = registry.validate_tool_suggestions(raw_suggestions, intent="ask")
                    rejected_tools = registry.get_rejected_tools(raw_suggestions, intent="ask")
                    # 排除已调用的工具
                    new_tools = [t for t in approved if t not in used_tools]

                    for tool_name in new_tools:
                        result = await registry.call(tool_name, db=db, student_id=student_id)
                        used_tools.append(tool_name)
                        if result.success:
                            tool_results[tool_name] = result.data
                        else:
                            tool_results[tool_name] = None
                            logger.info("LLM 建议的工具 %s 调用失败: %s", tool_name, result.error)

                    suggested_tools = new_tools
                    if rejected_tools:
                        logger.info("LLM 建议被拒绝的工具: %s", [r["name"] for r in rejected_tools])
            except Exception as exc:
                logger.info("LLM 工具建议失败，使用规则分类结果: %s", exc)

        # 流式进度：数据检索完成
        if on_progress:
            await on_progress("reasoning", 0.6, "正在检索相关数据...")

        # 4. 构建上下文
        student = tool_results.get("get_student_profile")
        latest_diag = tool_results.get("get_latest_diagnosis")
        growth_data = tool_results.get("get_growth_tasks") or {}
        auth_data = tool_results.get("get_authorizations") or []
        history_data = tool_results.get("get_diagnosis_history") or []
        jobs_data = tool_results.get("get_visible_jobs") or []

        context = {
            "student_name": student.get("name", "") if student else "",
            "target_job": student.get("target_job", "") if student else "",
            "latest_diagnosis": latest_diag,
            "completed_tasks": growth_data.get("completed_count", 0) if isinstance(growth_data, dict) else 0,
            "total_tasks": growth_data.get("total_count", 0) if isinstance(growth_data, dict) else 0,
            "authorized_jobs": len(auth_data) if isinstance(auth_data, list) else 0,
        }

        # 5. 构建 grounding
        grounding = {}
        if latest_diag:
            try:
                grounding["diagnosis_version"] = latest_diag.version if hasattr(latest_diag, 'version') else latest_diag.get('version')
            except Exception:
                pass
        if isinstance(growth_data, dict):
            grounding["task_count"] = growth_data.get("total_count", 0)
            grounding["completed_tasks"] = growth_data.get("completed_count", 0)
        if isinstance(auth_data, list):
            grounding["authorization_count"] = len(auth_data)
        if isinstance(jobs_data, list):
            grounding["visible_job_count"] = len(jobs_data)

        if not LLM_API_KEY or not LLM_API_KEY.strip():
            return AgentResult(
                action=AgentAction.ADVICE,
                message="AI 服务未配置，无法回答问题。",
                data={
                    "context": context,
                    "used_tools": used_tools,
                    "question_type": classification.question_type.value,
                    "grounding": grounding,
                },
                ai_status=AIStatus.MISSING_KEY,
                reasoning=build_reasoning(
                    basis=[f"问题分类为 {classification.question_type.value}", classification.reason] + ([f"LLM 建议补充工具: {', '.join(suggested_tools)}"] if suggested_tools else []),
                    decision=f"基于 {len(used_tools)} 个工具的查询结果回答",
                    confidence=classification.confidence,
                    used_tools=used_tools,
                    limits=["回答基于系统内数据，不含外部招聘信息"],
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )

        from core.harness.llm import get_llm_client
        from core.agent.capabilities import build_capability_prompt
        llm = get_llm_client()

        # 构建诊断摘要
        diag_summary = "暂无诊断"
        if latest_diag:
            try:
                version = latest_diag.version if hasattr(latest_diag, 'version') else latest_diag.get('version', '?')
                score = latest_diag.match_score if hasattr(latest_diag, 'match_score') else latest_diag.get('match_score', 0)
                diag_summary = f"版本{version}，匹配度{score:.0%}"
            except Exception:
                diag_summary = "有诊断记录"

        # 构建岗位摘要
        job_summary = ""
        if isinstance(jobs_data, list) and jobs_data:
            job_titles = [j.get("title", "") for j in jobs_data[:5] if isinstance(j, dict)]
            if job_titles:
                job_summary = f"\n可投递岗位：{', '.join(job_titles)}等{len(jobs_data)}个"

        # 构建任务摘要
        task_summary = ""
        if isinstance(growth_data, dict) and growth_data.get("growth_tasks"):
            pending = [t for t in growth_data["growth_tasks"] if t.get("status") == "pending"]
            if pending:
                task_summary = f"\n待完成任务：{pending[0].get('task_name', '无')}等{len(pending)}个"

        context_text = f"""学生姓名：{context['student_name']}
目标岗位：{context['target_job']}
最新诊断：{diag_summary}
已完成任务：{context['completed_tasks']}/{context['total_tasks']}
已授权企业：{context['authorized_jobs']}个{job_summary}{task_summary}"""

        capability_prompt = build_capability_prompt()

        messages = [
            {"role": "system", "content": f"你是「职达」职业成长智能体助手。\n\n{capability_prompt}\n\n## 该学生的当前状态：\n{context_text}"},
        ]
        # 插入最近对话历史
        for msg in recent_messages:
            messages.append({"role": msg["role"], "content": msg["content"]})
        # 当前用户消息
        messages.append({"role": "user", "content": message})

        # 6. 生成 next_actions
        next_actions = []
        qt = classification.question_type
        if qt == QuestionType.PROFILE:
            next_actions.append(NextAction(label="开始诊断", intent="diagnose", payload={}))
        elif qt == QuestionType.DIAGNOSIS:
            next_actions.append(NextAction(label="查看成长任务", intent="continue_growth", payload={}))
        elif qt == QuestionType.GROWTH_TASK:
            next_actions.append(NextAction(label="查看能力画像", intent="diagnose", payload={}))
        elif qt == QuestionType.JOB_MATCH:
            next_actions.append(NextAction(label="去授权企业查看", intent="navigate", payload={"target": "authorization_tab"}))
        elif qt == QuestionType.AUTHORIZATION:
            next_actions.append(NextAction(label="前往授权管理", intent="navigate", payload={"target": "authorization_tab"}))
        elif qt == QuestionType.GENERAL_ADVICE:
            next_actions.append(NextAction(label="查看成长任务", intent="continue_growth", payload={}))

        try:
            # 流式进度：准备生成回答
            if on_progress:
                await on_progress("composing", 0.9, "正在组织回答...")
            response = await llm.complete(messages, max_tokens=1000)
            # 统一记忆写入（ask 意图写入完整对话）
            await agent_memory_service.maybe_write_memory(
                db, student_id, "ask",
                user_message=message,
                assistant_response=response.content,
                metadata={"used_tools": used_tools, "question_type": classification.question_type.value},
            )
            return AgentResult(
                action=AgentAction.ADVICE,
                message=response.content,
                data={
                    "context": context,
                    "used_tools": used_tools,
                    "question_type": classification.question_type.value,
                    "grounding": grounding,
                },
                next_actions=next_actions,
                ai_status=AIStatus.AVAILABLE,
                reasoning=build_reasoning(
                    basis=[f"问题分类为 {classification.question_type.value}", classification.reason] + ([f"LLM 建议补充工具: {', '.join(suggested_tools)}"] if suggested_tools else []),
                    decision=f"基于 {len(used_tools)} 个工具的查询结果回答",
                    confidence=classification.confidence,
                    used_tools=used_tools,
                    limits=["回答基于系统内数据，不含外部招聘信息"],
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )
        except Exception as exc:
            logger.warning("LLM 问答失败: %s", exc)
            # 统一记忆写入（即使 LLM 失败也保存用户消息）
            await agent_memory_service.maybe_write_memory(
                db, student_id, "ask", user_message=message,
                metadata={"error": str(exc)},
            )
            return AgentResult(
                action=AgentAction.ADVICE,
                message="抱歉，AI 暂时无法回答，请稍后再试。",
                data={
                    "context": context,
                    "used_tools": used_tools,
                    "question_type": classification.question_type.value,
                    "grounding": grounding,
                    "error": str(exc),
                },
                next_actions=next_actions,
                ai_status=AIStatus.PROVIDER_ERROR,
                reasoning=build_reasoning(
                    basis=[f"问题分类为 {classification.question_type.value}", classification.reason, f"LLM 调用失败: {exc}"] + ([f"LLM 建议补充工具: {', '.join(suggested_tools)}"] if suggested_tools else []),
                    decision="无法生成回答",
                    confidence=classification.confidence,
                    used_tools=used_tools,
                    limits=["回答基于系统内数据，不含外部招聘信息"],
                    selected_skill=selected_skill,
                ),
                request_id=request_id,
            )
