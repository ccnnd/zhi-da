# 成长任务服务——统一管理 GrowthTask 的创建、查询、证据提交、审核和复评关联
import re
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from db.models import GrowthTask, DiagnosisResult
from core.utils.time import utc_now

logger = logging.getLogger(__name__)


# ---------- 轻量中英文混合分词器 ----------

# 常见中文动作词 / 实质词
_CN_ACTION_WORDS = set(
    "学习 完成 实现 掌握 练习 项目 代码 文档 测试 部署 设计 开发 搭建 构建 "
    "教程 章节 实验 报告 论文 竞赛 比赛 答辩 演示 需求 方案 优化 重构 "
    "分析 研究 调研 总结 整理 编写 阅读 了解 熟悉 学会 运用 实践".split()
)

# 常见英文技术词（大小写不敏感匹配）
_EN_TECH_WORDS = {
    "fastapi", "react", "sqlalchemy", "docker", "python", "java", "javascript",
    "typescript", "django", "flask", "kubernetes", "redis", "mysql", "postgresql",
    "mongodb", "git", "linux", "nginx", "webpack", "vite", "pytorch", "tensorflow",
    "langchain", "openai", "api", "rest", "restful", "sse", "sql", "nosql",
    "html", "css", "vue", "angular", "node", "express", "spring", "go",
}


def _tokenize_evidence(evidence: str) -> list[str]:
    """轻量中英文混合分词器。

    英文部分按空格/标点切分并小写化；
    中文部分按连续中文字符段切分，再按二字滑窗生成 token。
    """
    tokens: list[str] = []

    # 提取所有英文单词（连续字母数字）
    en_words = re.findall(r'[A-Za-z0-9]+', evidence)
    for w in en_words:
        tokens.append(w.lower())

    # 提取所有中文连续段
    cn_segments = re.findall(r'[\u4e00-\u9fff]+', evidence)
    for seg in cn_segments:
        # 对中文段做二字滑窗（bigram），覆盖常见动作词和名词
        if len(seg) >= 2:
            for i in range(len(seg) - 1):
                tokens.append(seg[i:i+2])
        # 也保留整段（<=4字的短段往往是完整词）
        if len(seg) <= 4:
            tokens.append(seg)

    return tokens


# ---------- 创建 ----------

async def create_from_growth_path(
    db: AsyncSession,
    student_id: int,
    diagnosis_id: str,
    growth_path: dict,
) -> list[GrowthTask]:
    """从诊断的 growth_path 结构批量创建 GrowthTask。

    防重复：同一 diagnosis_id 已有任务则跳过。
    """
    # 防重复
    existing = await db.execute(
        select(GrowthTask).where(GrowthTask.diagnosis_id == diagnosis_id)
    )
    if existing.scalars().first() is not None:
        return []

    saved = []
    phases = growth_path.get("phases", []) if isinstance(growth_path, dict) else []
    for phase_idx, phase in enumerate(phases):
        for task_idx, task in enumerate(phase.get("tasks", [])):
            gt = GrowthTask(
                diagnosis_id=diagnosis_id,
                student_id=student_id,
                phase_index=phase_idx,
                task_index=task_idx,
                task_name=task.get("name", ""),
                task_description=task.get("description", ""),
                linked_gap=task.get("linked_gap", ""),
                target_dimension=task.get("target_dimension", ""),
                expected_impact=task.get("expected_impact", {}),
                evidence_required=task.get("criteria", ""),
                resources=task.get("resources", []),
                criteria=task.get("criteria", ""),
                status="pending",
            )
            db.add(gt)
            saved.append(gt)
    if saved:
        await db.commit()
    return saved


# ---------- 查询 ----------

async def list_student_tasks(
    db: AsyncSession,
    student_id: int,
    diagnosis_id: str | None = None,
) -> list[dict]:
    """查询学生的成长任务列表，可按 diagnosis_id 过滤。"""
    stmt = select(GrowthTask).where(GrowthTask.student_id == student_id)
    if diagnosis_id:
        stmt = stmt.where(GrowthTask.diagnosis_id == diagnosis_id)
    stmt = stmt.order_by(GrowthTask.phase_index, GrowthTask.task_index)

    result = await db.execute(stmt)
    tasks = result.scalars().all()

    return [_task_to_dict(t) for t in tasks]


async def get_task_detail(
    db: AsyncSession,
    student_id: int,
    task_id: str,
) -> dict | None:
    """获取单个任务详情，校验 student_id 归属。"""
    task = await db.get(GrowthTask, task_id)
    if not task or task.student_id != student_id:
        return None
    return _task_to_dict(task)


# ---------- 证据提交与审核 ----------

async def submit_evidence(
    db: AsyncSession,
    task_id: str,
    student_id: int,
    evidence: str,
) -> dict:
    """提交任务完成证据并自动执行规则审核。

    返回审核结果 dict，包含 status、review、message。
    如果任务不存在或不属于该学生，返回 error。
    """
    task = await db.get(GrowthTask, task_id)
    if not task:
        return {"error": "not_found", "message": "Growth task not found"}
    if task.student_id != student_id:
        return {"error": "forbidden", "message": "Task does not belong to this student"}
    if task.status == "completed":
        return {"error": "already_completed", "message": "Task already completed"}

    evidence = evidence.strip()
    review_result = await review_evidence(task.id, task.task_name, evidence, task_criteria=task.criteria or "")

    if review_result["preliminary_approved"]:
        task.submitted_evidence = evidence
        task.status = "completed"
        task.reviewed_by_ai = review_result
        task.completed_at = utc_now()
    else:
        # 审核未通过：保存证据但保持 in_progress，允许重新提交
        task.submitted_evidence = evidence
        task.status = "in_progress"
        task.reviewed_by_ai = review_result

    await db.commit()
    await db.refresh(task)

    return {
        "id": task.id,
        "status": task.status,
        "review": review_result,
        "message": review_result["feedback"],
    }


def rule_review_evidence(task_id: str, task_name: str, task_criteria: str, evidence: str) -> dict:
    """纯规则审核——检查长度、重复率、关键词匹配、具体性。"""
    length = len(evidence)
    score = 0
    feedback_parts = []

    # 1. 长度检查（提高阈值）
    if length <= 10:
        feedback_parts.append("证据过于简略")
    elif length <= 30:
        score += 1
        feedback_parts.append("证据较简短")
    elif length <= 100:
        score += 2
    else:
        score += 3

    # 2. 重复率检查（使用轻量分词器）
    tokens = _tokenize_evidence(evidence)
    if len(tokens) > 3:
        unique_tokens = set(tokens)
        repetition_ratio = 1 - len(unique_tokens) / len(tokens)
        if repetition_ratio > 0.6:
            score -= 2
            feedback_parts.append("证据内容重复率过高")

    # 3. 任务关键词匹配（使用分词器支持中英文）
    task_tokens = _tokenize_evidence(task_name)
    criteria_tokens = _tokenize_evidence(task_criteria) if task_criteria else []
    all_task_keywords = set(task_tokens) | set(criteria_tokens)
    # 过滤掉过短的无意义 token
    all_task_keywords = {kw for kw in all_task_keywords if len(kw) >= 2}

    evidence_tokens = set(tokens)
    matched_keywords = [kw for kw in all_task_keywords if kw in evidence_tokens]
    if matched_keywords:
        score += 2
    else:
        feedback_parts.append("证据未提及与任务相关的关键词")

    # 4. 具体性检查（包含数字或具体描述）
    if re.search(r'\d+', evidence):
        score += 1
    if re.search(r'(完成|实现|掌握|学习|练习|项目|代码|文档|测试|部署)', evidence):
        score += 1

    approved = score >= 4
    if approved:
        feedback = "证据审核通过。可以触发复评来评估能力提升。"
    else:
        detail = "，".join(feedback_parts) if feedback_parts else "证据不够充分"
        feedback = f"{detail}。建议详细描述你的学习过程和具体成果（至少 100 字，包含与任务相关的具体内容）。"

    return {
        "task_id": task_id,
        "task_name": task_name,
        "evidence_length": length,
        "review_score": score,
        "has_evidence": length > 10,
        "preliminary_approved": approved,
        "feedback": feedback,
        "review_method": "rule",
    }


async def llm_review_evidence(task_name: str, task_criteria: str, evidence: str) -> dict | None:
    """LLM 语义审核——判断证据与任务的相关性和具体性。"""
    from config.settings import LLM_API_KEY
    from core.harness.llm import get_llm_client

    if not LLM_API_KEY or not LLM_API_KEY.strip():
        return None

    llm = get_llm_client()

    prompt = f"""请审核以下成长任务证据的质量。

任务名称：{task_name}
达标标准：{task_criteria or '无明确标准'}
学生提交的证据：{evidence}

请从以下维度评估：
1. relevance（相关性）：证据是否与任务主题相关（0-1）
2. specificity（具体性）：证据是否包含具体的学习过程或成果（0-1）
3. evidence_quality（证据质量）：证据是否可信、有说服力（0-1）

输出严格 JSON 格式：
{{
  "approved": true/false,
  "score": 0-1之间的浮点数,
  "relevance": 0-1之间的浮点数,
  "specificity": 0-1之间的浮点数,
  "evidence_quality": 0-1之间的浮点数,
  "reason": "审核理由",
  "suggestions": ["改进建议"]
}}

审核标准：
- 重复文字凑数不应通过
- 与任务无关的内容不应通过
- 包含具体学习过程和成果的应通过
- 简短但切题的可以给中等分数"""

    messages = [
        {"role": "system", "content": "你是职达系统的任务证据审核助手。请严格审核，只通过真正有质量的证据。"},
        {"role": "user", "content": prompt},
    ]

    try:
        response = await llm.complete(messages, max_tokens=500)
        from core.harness.validator import SchemaValidator
        data, error = SchemaValidator.validate_json_output(response.content)
        if data and not error:
            return {
                "approved": bool(data.get("approved", False)),
                "score": float(data.get("score", 0)),
                "relevance": float(data.get("relevance", 0)),
                "specificity": float(data.get("specificity", 0)),
                "evidence_quality": float(data.get("evidence_quality", 0)),
                "reason": str(data.get("reason", "")),
                "suggestions": list(data.get("suggestions", [])),
                "review_method": "llm",
            }
    except Exception as exc:
        logging.getLogger(__name__).warning("LLM 证据审核失败: %s", exc)

    return None


async def review_evidence(task_id: str, task_name: str, evidence: str, task_criteria: str = "") -> dict:
    """审核任务证据：规则审核 + LLM 语义审核（可选）。

    流程：
    1. 规则审核（必执行）
    2. 规则不通过直接返回
    3. 规则通过后尝试 LLM 语义审核
    4. LLM 失败时 fallback 到规则结果
    """
    # 1. 规则审核
    rule_result = rule_review_evidence(task_id, task_name, task_criteria, evidence)

    # 2. 规则审核不通过
    if not rule_result["preliminary_approved"]:
        return rule_result

    # 3. 规则通过，尝试 LLM 审核
    try:
        llm_result = await llm_review_evidence(task_name, task_criteria, evidence)
        if llm_result is not None:
            llm_approved = llm_result["approved"]
            # Keep relevant and specific text evidence passing for ordinary
            # growth tasks, while preserving the LLM's artifact suggestions.
            if (
                not llm_approved
                and llm_result.get("score", 0) >= 0.5
                and llm_result.get("relevance", 0) >= 0.6
                and llm_result.get("specificity", 0) >= 0.5
            ):
                llm_approved = True
            rule_result.update({
                "llm_review": llm_result,
                "preliminary_approved": llm_approved,
                "review_method": "llm",
            })
            if not llm_approved:
                rule_result["feedback"] = f"AI审核：{llm_result['reason']}"
    except Exception as exc:
        logger.warning("LLM 证据审核失败，使用规则审核结果: %s", exc)

    return rule_result


# ---------- 复评关联 ----------

async def link_re_evaluation(
    db: AsyncSession,
    task_id: str,
    diagnosis_id: str,
) -> dict:
    """将复评诊断 ID 写回成长任务。

    返回结果 dict，包含 id、re_evaluation_id、message。
    """
    task = await db.get(GrowthTask, task_id)
    if not task:
        return {"error": "not_found", "message": "Growth task not found"}

    # 验证 diagnosis_id 对应的诊断存在
    diag = await db.get(DiagnosisResult, diagnosis_id)
    if not diag:
        return {"error": "diagnosis_not_found", "message": "Diagnosis result not found"}

    task.re_evaluation_id = diagnosis_id
    await db.commit()

    return {
        "id": task.id,
        "re_evaluation_id": task.re_evaluation_id,
        "message": "Re-evaluation linked successfully.",
    }


# ---------- 内部工具 ----------

def _task_to_dict(t: GrowthTask) -> dict:
    """将 GrowthTask ORM 对象转为 dict。"""
    return {
        "id": t.id,
        "diagnosis_id": t.diagnosis_id,
        "phase_index": t.phase_index,
        "task_index": t.task_index,
        "task_name": t.task_name,
        "task_description": t.task_description,
        "linked_gap": t.linked_gap,
        "target_dimension": t.target_dimension,
        "expected_impact": t.expected_impact or {},
        "evidence_required": t.evidence_required,
        "resources": t.resources or [],
        "criteria": t.criteria,
        "status": t.status,
        "submitted_evidence": t.submitted_evidence,
        "reviewed_by_ai": t.reviewed_by_ai or {},
        "re_evaluation_id": t.re_evaluation_id,
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }
