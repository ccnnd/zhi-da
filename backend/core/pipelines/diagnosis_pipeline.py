# 诊断 Pipeline 定义——包含 5 个 PipelineStep，按序执行初诊流程
from core.harness.step import PipelineStep, PipelineState
from core.harness.context import ContextBuilder
from core.harness.validator import SchemaValidator
from core.harness.llm import get_llm_client
import json


# ---- 维度名称映射（短名 -> 全名）----
DIM_KEY_MAP = {
    "tech": "tech_skills",
    "project": "project_exp",
    "academic": "academic_foundation",
    "domain": "domain_knowledge",
    "soft_evidence": "soft_skill_evidence",
}
DIM_KEY_MAP_REV = {v: k for k, v in DIM_KEY_MAP.items()}
FULL_DIM_KEYS = list(DIM_KEY_MAP.values())


# ---- 确定性分数计算函数 ----
def _compute_dimension_score(profile: dict, dim_full_key: str) -> tuple[float, float]:
    """根据能力画像计算单维度归一化分数 (0-1) 和置信度。
    返回 (score, confidence)。
    """
    dim_data = profile.get(dim_full_key, {})
    if not isinstance(dim_data, dict):
        return (0.0, 0.0)
    sub_items = dim_data.get("sub_items", [])
    if not sub_items:
        # 无子项 = 缺少证据
        return (0.0, 0.1)
    scores = []
    for item in sub_items:
        if isinstance(item, dict):
            s = item.get("score", 0)
            try:
                scores.append(max(0, min(100, float(s))))
            except (TypeError, ValueError):
                pass
    if not scores:
        return (0.0, 0.1)
    avg = sum(scores) / len(scores)
    normalized = round(avg / 100.0, 3)
    # 置信度：子项越多越高，最多 5 项达到 0.9
    confidence = min(0.9, 0.3 + len(scores) * 0.15)
    return (normalized, round(confidence, 2))


def _compute_match_score(dim_scores: dict, weights: dict) -> float:
    """用确定性加权公式计算综合匹配分。"""
    total = 0.0
    for key in FULL_DIM_KEYS:
        score = dim_scores.get(key, 0.0)
        weight = weights.get(key, 0.2)
        total += score * weight
    return round(max(0.0, min(1.0, total)), 3)


# ---- 解释结构构建 ----
def _build_explanations(state: PipelineState, dim_scores: dict, confidences: dict,
                        match_score: float, weights: dict) -> dict:
    """构建统一解释结构（explanations），保存匹配分公式、维度证据、推荐理由等。"""
    profile = state.get("profile", {})
    match_result = state.get("match_result", {})

    # 维度解释：每个维度的分数、证据和缺失项
    dimensions_expl = {}
    for full_key in FULL_DIM_KEYS:
        dim_data = profile.get(full_key, {})
        sub_items = dim_data.get("sub_items", []) if isinstance(dim_data, dict) else []
        evidence = [item.get("name", "") for item in sub_items if isinstance(item, dict) and item.get("score", 0) > 50]
        missing = [item.get("name", "") for item in sub_items if isinstance(item, dict) and item.get("score", 0) <= 50]
        if not sub_items:
            missing = ["缺少该维度的评估数据"]
        dimensions_expl[full_key] = {
            "score": dim_scores.get(full_key, 0.0),
            "evidence": evidence[:5],
            "missing": missing[:5],
            "confidence": confidences.get(full_key, 0.5),
        }

    # 匹配分公式
    match_score_expl = {
        "formula": " + ".join([f"{k}*{v}" for k, v in weights.items()]),
        "weights": weights,
        "dimension_scores": {k: dim_scores.get(k, 0.0) for k in FULL_DIM_KEYS},
        "final_score": match_score,
    }

    # 推荐岗位解释
    recommended_jobs = []
    for job in match_result.get("top5_jobs", []):
        if isinstance(job, dict):
            recommended_jobs.append({
                "job_id": job.get("job_id", ""),
                "title": job.get("title", ""),
                "match_score": job.get("match_score", job.get("score", 0)),
                "company": job.get("company", ""),
                "confidence": 0.7,
            })

    # 综合判断
    avg_conf = sum(confidences.values()) / max(len(confidences), 1)
    summary = {
        "basis": f"基于五维能力画像的加权匹配计算，综合匹配度为 {match_score:.1%}",
        "confidence": round(avg_conf, 2),
    }

    return {
        "summary": summary,
        "match_score": match_score_expl,
        "dimensions": dimensions_expl,
        "recommended_jobs": recommended_jobs,
    }


# 能力画像步骤
class ProfileStep(PipelineStep):
    def __init__(self, name="profile", depends_on=None):
        super().__init__(name, depends_on)

    async def execute(self, state: PipelineState) -> PipelineState:
        llm = get_llm_client()
        student_info = state.input

        # 构建 profile_sections 上下文（新结构）
        ps = student_info.get("profile_sections") or {}
        ps_skills = ps.get("skills", [])
        ps_internships = ps.get("internship_exp", [])
        ps_projects = ps.get("project_exp", [])
        ps_campus = ps.get("campus_exp", [])
        ps_awards = ps.get("awards", [])
        ps_pubs = ps.get("publications", [])
        ps_self_eval = ps.get("self_evaluation", "")
        ps_education = ps.get("education", {})
        ps_intention = ps.get("job_intention", {})

        # 构建技能上下文（合并新旧格式）
        skills_context = ""
        if ps_skills:
            skills_context = "技能列表(profile_sections): " + json.dumps(
                [{"name": s.get("name", ""), "level": s.get("level", "")} for s in ps_skills],
                ensure_ascii=False
            )
        else:
            skills_context = f"技能(旧格式): {student_info.get('tech_skills', {})}"

        # 构建经历上下文
        exp_context_parts = []
        if ps_internships:
            exp_context_parts.append(f"实习经历: {json.dumps(ps_internships[:5], ensure_ascii=False)}")
        if ps_projects:
            exp_context_parts.append(f"项目经验(profile_sections): {json.dumps(ps_projects[:5], ensure_ascii=False)}")
        elif student_info.get("project_exp"):
            exp_context_parts.append(f"项目经验(旧格式): {json.dumps(student_info.get('project_exp', [])[:5], ensure_ascii=False)}")
        if ps_campus:
            exp_context_parts.append(f"社会实践: {json.dumps(ps_campus[:3], ensure_ascii=False)}")
        exp_context = " ".join(exp_context_parts)

        # 补充信息
        extra_context_parts = []
        if ps_awards:
            extra_context_parts.append(f"奖励荣誉: {json.dumps([a.get('award_name', '') for a in ps_awards[:5]], ensure_ascii=False)}")
        if ps_pubs:
            extra_context_parts.append(f"论文专利: {json.dumps([p.get('name', '') for p in ps_pubs[:3]], ensure_ascii=False)}")
        if ps_self_eval:
            extra_context_parts.append(f"自我评价(低权重参考): {ps_self_eval[:200]}")
        extra_context = " ".join(extra_context_parts)

        # 缺失字段提示
        completeness = student_info.get("profile_completeness", 0)
        missing_hint = ""
        if completeness < 0.6:
            missing_hint = f"\n注意: 该学生档案完整度仅 {completeness:.0%}，部分维度可能缺少证据，请将缺少证据的维度 sub_items 设为空数组。"

        messages = ContextBuilder.build_user_prompt(state,
                "请基于以下学生信息生成五维能力画像。输出严格JSON格式，含 tech_skills, project_exp, academic_foundation, domain_knowledge, soft_skill_evidence 五个维度，每项包含 weight 和 sub_items (含name, score(0-100), level)。"
                "\n重要规则：如果某维度没有证据支撑，请将该维度的 sub_items 设为空数组，不要编造数据。"
                "\n评分依据优先级：项目/实习经历 > 技能列表 > 学业基础 > 自我评价（低权重）。"
                f"{missing_hint}",
                f"学生简历: {student_info.get('resume_text', '')} {skills_context} "
                f"领域: {student_info.get('domain_knowledge', {})} "
                f"学业基础: {json.dumps(student_info.get('academic_foundation', {}), ensure_ascii=False)} "
                f"软技能证据: {json.dumps(student_info.get('soft_skill_evidence', {}), ensure_ascii=False)} "
                f"{exp_context} {extra_context}")
        response = await llm.complete(messages, max_tokens=2000)
        data, error = SchemaValidator.validate_json_output(response.content)
        if data and not error:
            data = SchemaValidator.validate_ability_scores(data)
            state.set("profile", data)
        else:
            # 降级：基于学生原始数据构建画像，无证据的维度标记为空
            # 技能：优先 profile_sections.skills，回退到 tech_skills
            tech_items = []
            if ps_skills:
                level_to_score = {"精通": 90, "熟练": 75, "良好": 65, "了解": 50, "入门": 35}
                for s in ps_skills:
                    score = level_to_score.get(s.get("level", "了解"), 50)
                    tech_items.append({"name": s.get("name", ""), "score": score, "level": s.get("level", "了解")})
            else:
                tech_items = [{"name": k, "score": v, "level": "了解"} for k, v in student_info.get("tech_skills", {}).items()]

            # 项目经验：优先 profile_sections，回退旧格式
            project_items = []
            if ps_projects:
                for p in ps_projects:
                    project_items.append({"name": p.get("project_name", p.get("name", "")), "score": 60, "level": "项目"})
            elif ps_internships:
                for p in ps_internships:
                    project_items.append({"name": p.get("company_name", ""), "score": 65, "level": "实习"})
            else:
                for p in (student_info.get("project_exp", []) or []):
                    project_items.append({"name": p.get("name", ""), "score": 60, "level": "项目"})

            # 学业基础
            academic = student_info.get("academic_foundation", {})
            academic_items = []
            if academic and isinstance(academic, dict):
                if academic.get("gpa"):
                    academic_items.append({"name": f"GPA: {academic['gpa']}", "score": min(100, float(academic.get("normalized_score", 60))), "level": "学业"})
                if academic.get("awards"):
                    for award in (academic.get("awards") or [])[:3]:
                        academic_items.append({"name": str(award), "score": 75, "level": "学业"})
            # 补充 profile_sections 中的 awards
            if ps_awards and not academic.get("awards"):
                for a in ps_awards[:3]:
                    academic_items.append({"name": a.get("award_name", ""), "score": 75, "level": "学业"})

            # 软技能证据
            soft_evidence = student_info.get("soft_skill_evidence", {})
            soft_items = []
            if soft_evidence and isinstance(soft_evidence, dict):
                for skill_name, detail in soft_evidence.items():
                    if isinstance(detail, dict):
                        score = detail.get("normalized_score", 0)
                        if score > 0:
                            soft_items.append({"name": skill_name, "score": score, "level": detail.get("level", "medium")})

            state.set("profile", {
                "tech_skills": {"weight": 0.3, "sub_items": tech_items},
                "project_exp": {"weight": 0.2, "sub_items": project_items},
                "academic_foundation": {"weight": 0.15, "sub_items": academic_items},
                "domain_knowledge": {"weight": 0.15, "sub_items": [{"name": k, "score": v, "level": "了解"} for k, v in student_info.get("domain_knowledge", {}).items()]},
                "soft_skill_evidence": {"weight": 0.2, "sub_items": soft_items},
            })
        return state


# 岗位匹配步骤（确定性计算 + LLM 解释）
class MatchStep(PipelineStep):
    def __init__(self, name="match", depends_on=None):
        super().__init__(name, depends_on)

    async def execute(self, state: PipelineState) -> PipelineState:
        llm = get_llm_client()
        target_job = state.input.get("target_job", "")
        profile = state.get("profile", {})

        # 1. 确定性计算：从能力画像提取各维度分数
        dim_scores = {}
        confidences = {}
        for full_key in FULL_DIM_KEYS:
            score, conf = _compute_dimension_score(profile, full_key)
            dim_scores[full_key] = score
            confidences[full_key] = conf

        # 2. 确定权重配置（基于目标岗位方向）
        weights = _get_weights_for_target(target_job)

        # 3. 确定性计算综合匹配分
        match_score = _compute_match_score(dim_scores, weights)

        # 4. 构建短键的 dimension_scores（兼容前端）
        dim_scores_short = {}
        for full_key, score in dim_scores.items():
            short_key = DIM_KEY_MAP_REV.get(full_key, full_key)
            dim_scores_short[short_key] = score

        # 5. 调用 LLM 生成岗位推荐、差距分析和解释文本
        system_instructions = (
            f"学生目标岗位是「{target_job}」。已计算出学生五维能力分数（0-1）：\n"
            f"  tech_skills={dim_scores.get('tech_skills', 0):.2f}, "
            f"project_exp={dim_scores.get('project_exp', 0):.2f}, "
            f"academic_foundation={dim_scores.get('academic_foundation', 0):.2f}, "
            f"domain_knowledge={dim_scores.get('domain_knowledge', 0):.2f}, "
            f"soft_skill_evidence={dim_scores.get('soft_skill_evidence', 0):.2f}\n"
            f"综合匹配分={match_score:.3f}（确定性计算结果）\n\n"
            "请基于以上数据：\n"
            "1. 推荐5个匹配的岗位（含匹配理由和缺失技能）\n"
            "2. 分析每个维度的能力差距\n"
            "3. 给出每个推荐岗位的推荐理由\n\n"
            "请输出严格 JSON 格式：\n"
            "{\n"
            '  "top5_jobs": [\n'
            '    { "job_id": "岗位ID", "title": "岗位名称", "match_score": 0-1浮点数, "company": "企业名称", "reason": "推荐理由", "matched_skills": ["匹配技能"], "missing_skills": ["缺失技能"] }\n'
            "  ],\n"
            '  "gap_details": [\n'
            '    { "dimension": "tech_skills | project_exp | academic_foundation | domain_knowledge | soft_skill_evidence", "skill": "技能或能力名称", "current": 0-100之间的数字, "required": 0-100之间的数字, "gap": 差距数值 }\n'
            "  ]\n"
            "}"
        )

        messages = ContextBuilder.build_user_prompt(state, system_instructions)
        response = await llm.complete(messages, max_tokens=2000)
        data, error = SchemaValidator.validate_json_output(response.content)

        if data and not error:
            top5 = data.get("top5_jobs", [])
            gap_details = data.get("gap_details", [])
        else:
            top5 = []
            gap_details = []

        # 6. 组装结果
        result = {
            "match_score": match_score,
            "dimension_scores": dim_scores_short,
            "top5_jobs": top5,
            "gap_details": gap_details,
        }
        state.set("match_result", result)

        # 7. 构建并保存解释结构
        explanations = _build_explanations(state, dim_scores, confidences, match_score, weights)
        state.set("explanations", explanations)

        # 8. 保存置信度
        state.set("confidence", {
            "profile": round(sum(confidences.values()) / max(len(confidences), 1), 2),
            "match": 0.85 if (data and not error) else 0.5,
            "dimensions": confidences,
        })

        return state


def _get_weights_for_target(target_job: str) -> dict:
    """根据目标岗位方向确定权重配置"""
    target = (target_job or "").lower()
    if any(k in target for k in ["算法", "机器学习", "深度学习", "ai"]):
        return {"tech_skills": 0.20, "project_exp": 0.15, "academic_foundation": 0.35, "domain_knowledge": 0.15, "soft_skill_evidence": 0.15}
    elif any(k in target for k in ["后端", "java", "python", "go"]):
        return {"tech_skills": 0.35, "project_exp": 0.30, "academic_foundation": 0.10, "domain_knowledge": 0.10, "soft_skill_evidence": 0.15}
    elif any(k in target for k in ["前端", "react", "vue", "web"]):
        return {"tech_skills": 0.35, "project_exp": 0.30, "academic_foundation": 0.10, "domain_knowledge": 0.10, "soft_skill_evidence": 0.15}
    elif any(k in target for k in ["产品", "pm", "product"]):
        return {"tech_skills": 0.10, "project_exp": 0.15, "academic_foundation": 0.10, "domain_knowledge": 0.30, "soft_skill_evidence": 0.35}
    elif any(k in target for k in ["数据", "分析", "data"]):
        return {"tech_skills": 0.20, "project_exp": 0.25, "academic_foundation": 0.30, "domain_knowledge": 0.10, "soft_skill_evidence": 0.15}
    else:
        # 默认均衡权重
        return {"tech_skills": 0.25, "project_exp": 0.25, "academic_foundation": 0.15, "domain_knowledge": 0.15, "soft_skill_evidence": 0.20}


# 差距分析步骤
class GapStep(PipelineStep):
    def __init__(self, name="gap", depends_on=None):
        super().__init__(name, depends_on)

    async def execute(self, state: PipelineState) -> PipelineState:
        match_result = state.get("match_result", {})
        gap_details = match_result.get("gap_details", [])
        state.set("gap_analysis", {"gaps": gap_details, "total_gaps": len(gap_details)})
        return state


# 成长路径规划步骤
class PathStep(PipelineStep):
    def __init__(self, name="path", depends_on=None):
        super().__init__(name, depends_on)

    async def execute(self, state: PipelineState) -> PipelineState:
        llm = get_llm_client()
        gaps = state.get("gap_analysis", {}).get("gaps", [])
        # 将差距分析与维度全名一起传给 LLM
        messages = ContextBuilder.build_user_prompt(state,
                "请基于差距分析结果，生成个性化成长路径。每个任务需要明确标注：\n"
                "1. linked_gap: 该任务弥补的具体差距\n"
                "2. target_dimension: 目标提升的维度（使用全称：tech_skills/project_exp/academic_foundation/domain_knowledge/soft_skill_evidence）\n"
                "3. expected_impact: 预期对各维度的提升幅度（0-1之间小数）\n\n"
                "输出严格JSON: {phases: [{goal, weeks: 数字, tasks: [{name, description, resources: [链接], criteria, linked_gap, target_dimension, expected_impact: {维度名: 提升值}}]}]}，包含2-3个阶段。",
                f"差距: {json.dumps(gaps, ensure_ascii=False)}")
        response = await llm.complete(messages, max_tokens=2000)
        data, error = SchemaValidator.validate_json_output(response.content)
        if data and not error:
            state.set("growth_path", data)
        else:
            state.set("growth_path", {"phases": [{"goal": "基础能力提升", "weeks": 4, "tasks": [{"name": "夯实基础", "description": "针对薄弱技能进行专项练习", "resources": [], "criteria": "技能评分达到70+", "linked_gap": "综合能力提升", "target_dimension": "tech_skills", "expected_impact": {"tech_skills": 0.05}}]}]})
        return state


# 职业建议生成步骤
class AdviceStep(PipelineStep):
    def __init__(self, name="advice", depends_on=None):
        super().__init__(name, depends_on)

    async def execute(self, state: PipelineState) -> PipelineState:
        llm = get_llm_client()
        confidence = state.get("confidence", {})
        profile_confidence = confidence.get("profile", 0.5)
        messages = ContextBuilder.build_user_prompt(state,
                f"请基于学生的能力画像和岗位匹配结果，生成职业发展建议和就业指导。\n"
                f"当前画像置信度为 {profile_confidence}，如果置信度较低，请在建议中提醒学生补充更多信息。\n"
                "输出严格JSON: {career_advice: 文本, recommended_directions: [方向], ai_reasoning: {每个建议的推理依据和置信度}}")
        response = await llm.complete(messages, max_tokens=1500)
        data, error = SchemaValidator.validate_json_output(response.content)
        if data and not error:
            state.set("career_advice", data.get("career_advice", ""))
            state.set("ai_reasoning", data.get("ai_reasoning", {}))
        else:
            state.set("career_advice", "建议持续关注行业趋势，针对目标岗位持续提升核心技能。")
            state.set("ai_reasoning", {"note": "基于能力画像的通用建议", "fallback": True})
        return state
