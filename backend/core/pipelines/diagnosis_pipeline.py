# 诊断 Pipeline 定义——包含 5 个 PipelineStep，按序执行初诊流程
from core.harness.step import PipelineStep, PipelineState
from core.harness.context import ContextBuilder
from core.harness.validator import SchemaValidator
from core.harness.llm import get_llm_client
from sqlalchemy.ext.asyncio import AsyncSession
import json
import logging

logger = logging.getLogger(__name__)


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

# 维度中文标签（供 LLM 上下文与确定性匹配复用）
DIM_CN_LABELS = {
    "tech_skills": "技术技能",
    "project_exp": "项目经验",
    "academic_foundation": "学业基础",
    "domain_knowledge": "领域知识",
    "soft_skill_evidence": "软技能证据",
}


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


async def _load_matchable_jobs(db: AsyncSession | None) -> list[dict]:
    """加载所有可用于匹配的岗位（含企业名 + 能力模型）。

    返回结构：
        [{
            "job_id", "title", "category", "company", "enterprise_id",
            "tech_skills": {skill: weight}, "domain_knowledge": {...}, ...
        }, ...]

    使用延迟导入 ContextLoader 以避免与 core.agent 包的循环依赖。
    """
    if db is None:
        return []
    try:
        from core.agent.runtime import ContextLoader
        active_jobs = await ContextLoader.get_active_jobs(db)
    except Exception as exc:
        logger.warning("加载可用岗位失败: %s", exc)
        return []

    matchable = []
    for job in active_jobs:
        job_id = job.get("id", "")
        ability = await ContextLoader.get_job_ability_model(db, job_id) or {}
        matchable.append({
            "job_id": job_id,
            "title": job.get("title", ""),
            "category": job.get("category", ""),
            "company": job.get("enterprise_name", ""),
            "enterprise_id": job.get("enterprise_id", ""),
            "tech_skills": ability.get("tech_skills", {}) or {},
            "soft_skills": ability.get("soft_skills", {}) or {},
            "domain_knowledge": ability.get("domain_knowledge", {}) or {},
            "weight_config": ability.get("weight_config", {}) or {},
        })
    return matchable


def _deterministic_top5(
    dim_scores: dict,
    profile: dict,
    jobs: list[dict],
    fallback_reason: str = "基于五维能力画像的确定性匹配",
) -> list[dict]:
    """LLM 不可用或返回岗位不真实时，用确定性加权计算每个岗位匹配分，取 TOP5。

    匹配逻辑：
      - 取岗位能力模型的 weight_config 作为维度权重（缺省均衡权重）；
      - 用学生维度分数 × 岗位维度权重得到岗位综合分；
      - 技能命中：学生 tech_skills sub_items 名称与岗位 tech_skills 键名交集；
    """
    scored = []
    student_tech_names = set()
    tech_dim = profile.get("tech_skills", {}) if isinstance(profile, dict) else {}
    for item in (tech_dim.get("sub_items", []) if isinstance(tech_dim, dict) else []):
        if isinstance(item, dict) and item.get("name"):
            student_tech_names.add(str(item["name"]).lower())

    for job in jobs:
        weights = job.get("weight_config") or {}
        if not isinstance(weights, dict) or not weights:
            weights = {k: 0.2 for k in FULL_DIM_KEYS}
        # 归一化权重
        total_w = sum(float(weights.get(k, 0)) for k in FULL_DIM_KEYS) or 1.0
        norm_weights = {k: float(weights.get(k, 0)) / total_w for k in FULL_DIM_KEYS}

        score = 0.0
        for k in FULL_DIM_KEYS:
            score += dim_scores.get(k, 0.0) * norm_weights.get(k, 0.2)
        score = max(0.0, min(1.0, round(score, 3)))

        # 命中/缺失技能分析
        job_tech = job.get("tech_skills", {}) or {}
        if isinstance(job_tech, dict):
            required_tech = [str(t) for t in job_tech.keys()]
        else:
            required_tech = []
        matched = [t for t in required_tech if t.lower() in student_tech_names]
        missing = [t for t in required_tech if t.lower() not in student_tech_names]

        scored.append({
            "job_id": str(job.get("job_id", "")),
            "title": job.get("title", ""),
            "match_score": score,
            "company": job.get("company", ""),
            "reason": fallback_reason,
            "matched_skills": matched,
            "missing_skills": missing,
            "confidence": 0.7,
        })

    scored.sort(key=lambda j: j["match_score"], reverse=True)
    return scored[:5]


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
    def __init__(self, name="match", depends_on=None, db: AsyncSession | None = None):
        super().__init__(name, depends_on)
        self.db = db

    async def execute(self, state: PipelineState) -> PipelineState:
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

        # 5. 加载真实可用岗位（关键修复：把岗位数据喂给 LLM，避免空推荐）
        matchable_jobs = await _load_matchable_jobs(self.db)
        # 同时把岗位快照写入 state.extra（save_diagnosis 会落库到 job_snapshot）
        state.extra["job_snapshot"] = matchable_jobs

        # 确定性兜底：无论 LLM 是否可用，都先算出一份可信的 TOP5
        deterministic_top5 = _deterministic_top5(
            dim_scores, profile, matchable_jobs,
            fallback_reason="基于五维能力画像与岗位权重计算的确定性匹配",
        )

        # 6. 调用 LLM 生成岗位推荐、差距分析（把真实岗位列表注入上下文）
        top5 = deterministic_top5  # 默认使用确定性结果
        gap_details: list = []
        llm_ok = False
        job_id_set = {j["job_id"] for j in matchable_jobs}
        job_lookup = {j["job_id"]: j for j in matchable_jobs}

        if matchable_jobs:
            job_list_text = "\n".join([
                f"- job_id={j['job_id']} | {j['title']} @ {j['company']} | "
                f"类别={j.get('category', '')} | 要求技能: {list(j.get('tech_skills', {}).keys()) or '未配置'}"
                for j in matchable_jobs
            ])
            dim_text = ", ".join([f"{DIM_CN_LABELS[k]}={dim_scores.get(k, 0):.2f}" for k in FULL_DIM_KEYS])
            system_instructions = (
                f"学生目标方向是「{target_job}」。已计算出学生五维能力分数（0-1）：{dim_text}\n"
                f"综合匹配分={match_score:.3f}（确定性计算结果）\n\n"
                f"## 系统当前可用岗位（只能从这些岗位中推荐）:\n{job_list_text}\n\n"
                "请基于以上数据：\n"
                "1. **从上面列出的可用岗位中**推荐 5 个最匹配的岗位（必须使用上面真实的 job_id 和 title）\n"
                "2. 为每个岗位分析匹配技能和缺失技能\n"
                "3. 分析学生每个维度的能力差距\n\n"
                "请输出严格 JSON 格式：\n"
                "{\n"
                '  "top5_jobs": [\n'
                '    { "job_id": "必须使用上面列出的真实job_id", "title": "岗位名称", "match_score": 0-1浮点数, "company": "企业名称", "reason": "推荐理由", "matched_skills": ["匹配技能"], "missing_skills": ["缺失技能"] }\n'
                "  ],\n"
                '  "gap_details": [\n'
                '    { "dimension": "tech_skills | project_exp | academic_foundation | domain_knowledge | soft_skill_evidence", "skill": "技能或能力名称", "current": 0-100之间的数字, "required": 0-100之间的数字, "gap": 差距数值 }\n'
                "  ]\n"
                "}"
            )

            try:
                llm = get_llm_client()
                messages = ContextBuilder.build_user_prompt(state, system_instructions)
                response = await llm.complete(messages, max_tokens=2000)
                data, error = SchemaValidator.validate_json_output(response.content)

                if data and not error:
                    raw_top5 = data.get("top5_jobs", []) or []
                    # 确定性 per-job 分数锚点（job_id -> 确定性 match_score），用于校准 LLM 分数
                    det_score_map = {j["job_id"]: j["match_score"] for j in deterministic_top5}
                    # 校正：LLM 返回的岗位 job_id 必须在真实岗位列表中，且分数以确定性值为锚
                    validated_top5 = []
                    for job in raw_top5:
                        if not isinstance(job, dict):
                            continue
                        jid = str(job.get("job_id", ""))
                        real = job_lookup.get(jid)
                        if not real:
                            continue  # 丢弃编造的岗位
                        try:
                            llm_ms = float(job.get("match_score", 0))
                        except (TypeError, ValueError):
                            llm_ms = 0.0
                        # 以确定性分数为锚：LLM 分数只允许在 ±0.1 内微调，超界用确定性值
                        det_ms = det_score_map.get(jid, 0.0)
                        if abs(llm_ms - det_ms) > 0.1:
                            ms = det_ms
                        else:
                            ms = llm_ms
                        validated_top5.append({
                            "job_id": jid,
                            "title": real["title"],  # 以真实岗位名为准
                            "match_score": max(0.0, min(1.0, ms)),
                            "company": real["company"],
                            "reason": str(job.get("reason", "")),
                            "matched_skills": list(job.get("matched_skills", []) or []),
                            "missing_skills": list(job.get("missing_skills", []) or []),
                            "confidence": 0.8,
                        })
                    if validated_top5:
                        top5 = validated_top5
                    gap_details = data.get("gap_details", []) or []
                    llm_ok = True
                else:
                    logger.info("MatchStep LLM 输出解析失败，使用确定性匹配兜底")
            except Exception as exc:
                logger.warning("MatchStep LLM 调用失败，使用确定性匹配兜底: %s", exc)
        else:
            logger.info("无可用岗位，跳过 LLM 匹配，使用确定性空结果")

        # 7. 组装结果
        result = {
            "match_score": match_score,
            "dimension_scores": dim_scores_short,
            "top5_jobs": top5,
            "gap_details": gap_details,
        }
        state.set("match_result", result)

        # 8. 构建并保存解释结构
        explanations = _build_explanations(state, dim_scores, confidences, match_score, weights)
        state.set("explanations", explanations)

        # 9. 保存置信度
        state.set("confidence", {
            "profile": round(sum(confidences.values()) / max(len(confidences), 1), 2),
            "match": 0.85 if llm_ok else 0.6,
            "dimensions": confidences,
        })

        return state


def _get_weights_for_target(target_job: str) -> dict:
    """根据目标岗位方向确定权重配置。

    优化：合并相同权重的分支（后端/前端/移动端）、补齐常见方向
    （算法含 NLP/CV/推荐/大模型、测试/QA、运维/DevOps、安全、嵌入式）、
    修复"数据"误匹配"database"的问题（改用独立词匹配）。
    """
    target = (target_job or "").lower()
    # 算法/AI 方向（含 NLP/CV/推荐/大模型）
    if any(k in target for k in ["算法", "机器学习", "深度学习", "ai", "nlp", "cv", "推荐", "大模型", "llm", "数据挖掘"]):
        return {"tech_skills": 0.20, "project_exp": 0.15, "academic_foundation": 0.35, "domain_knowledge": 0.15, "soft_skill_evidence": 0.15}
    # 开发方向（后端/前端/移动端/游戏，权重相同）
    if any(k in target for k in ["后端", "前端", "移动", "android", "ios", "游戏", "客户端", "服务端",
                                  "java", "python", "go", "c++", "react", "vue", "web", "node"]):
        return {"tech_skills": 0.35, "project_exp": 0.30, "academic_foundation": 0.10, "domain_knowledge": 0.10, "soft_skill_evidence": 0.15}
    # 产品方向
    if any(k in target for k in ["产品", "pm", "product", "运营"]):
        return {"tech_skills": 0.10, "project_exp": 0.15, "academic_foundation": 0.10, "domain_knowledge": 0.30, "soft_skill_evidence": 0.35}
    # 数据方向（用独立词匹配避免 "database" 误匹配）
    if any(k in target for k in ["数据分析", "数据工程", "数据科学", "bi", "etl", "数仓", "统计"]):
        return {"tech_skills": 0.20, "project_exp": 0.25, "academic_foundation": 0.30, "domain_knowledge": 0.10, "soft_skill_evidence": 0.15}
    # 测试/QA
    if any(k in target for k in ["测试", "qa", "quality", "自动化测试"]):
        return {"tech_skills": 0.30, "project_exp": 0.25, "academic_foundation": 0.10, "domain_knowledge": 0.15, "soft_skill_evidence": 0.20}
    # 运维/DevOps/SRE
    if any(k in target for k in ["运维", "devops", "sre", "基础设施", "云原生"]):
        return {"tech_skills": 0.35, "project_exp": 0.25, "academic_foundation": 0.10, "domain_knowledge": 0.15, "soft_skill_evidence": 0.15}
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
                "请基于差距分析结果，生成个性化成长路径。必须包含恰好3个阶段（不多不少），由浅入深递进：\n"
                "- 阶段1（夯实基础，2-3周）：针对最薄弱的技能进行专项练习\n"
                "- 阶段2（能力进阶，3-4周）：通过项目实践深化核心能力\n"
                "- 阶段3（综合提升，2-3周）：模拟真实场景，全面提升竞争力\n\n"
                "每个任务需要明确标注：\n"
                "1. linked_gap: 该任务弥补的具体差距\n"
                "2. target_dimension: 目标提升的维度（使用全称：tech_skills/project_exp/academic_foundation/domain_knowledge/soft_skill_evidence）\n"
                "3. expected_impact: 预期对各维度的提升幅度（0-1之间小数）\n\n"
                "输出严格JSON: {phases: [{goal, weeks: 数字, tasks: [{name, description, resources: [链接], criteria, linked_gap, target_dimension, expected_impact: {维度名: 提升值}}]}]}。",
                f"差距: {json.dumps(gaps, ensure_ascii=False)}")
        response = await llm.complete(messages, max_tokens=2000)
        data, error = SchemaValidator.validate_json_output(response.content)
        if data and not error:
            # 确保至少有 2 个阶段
            phases = data.get("phases", [])
            if len(phases) < 2:
                data["phases"] = self._expand_to_multi_phase(phases)
            state.set("growth_path", data)
        else:
            state.set("growth_path", {"phases": [
                {"goal": "夯实基础", "weeks": 3, "tasks": [
                    {"name": "核心技能专项训练", "description": "针对最薄弱的技能进行专项练习，打牢基础", "resources": [], "criteria": "技能评分达到65+", "linked_gap": "基础能力不足", "target_dimension": "tech_skills", "expected_impact": {"tech_skills": 0.05}}
                ]},
                {"goal": "项目实践", "weeks": 4, "tasks": [
                    {"name": "实战项目开发", "description": "通过完整项目实践，将理论知识转化为实际能力", "resources": [], "criteria": "完成至少1个完整项目", "linked_gap": "缺乏项目经验", "target_dimension": "project_exp", "expected_impact": {"project_exp": 0.08}}
                ]},
                {"goal": "综合提升", "weeks": 3, "tasks": [
                    {"name": "模拟面试与复盘", "description": "通过模拟面试查漏补缺，全面提升竞争力", "resources": [], "criteria": "模拟面试通过率80%+", "linked_gap": "综合竞争力", "target_dimension": "soft_skill_evidence", "expected_impact": {"soft_skill_evidence": 0.05}}
                ]},
            ]})
        return state

    @staticmethod
    def _expand_to_multi_phase(existing_phases: list) -> list:
        """当 LLM 只返回 1 个阶段时，自动补充后续阶段。"""
        if not existing_phases:
            return [
                {"goal": "夯实基础", "weeks": 3, "tasks": [
                    {"name": "核心技能专项训练", "description": "针对薄弱技能进行专项练习", "resources": [], "criteria": "技能评分达到65+", "linked_gap": "基础能力", "target_dimension": "tech_skills", "expected_impact": {"tech_skills": 0.05}}
                ]},
                {"goal": "能力进阶", "weeks": 4, "tasks": [
                    {"name": "项目实战", "description": "通过项目实践深化能力", "resources": [], "criteria": "完成1个完整项目", "linked_gap": "项目经验", "target_dimension": "project_exp", "expected_impact": {"project_exp": 0.08}}
                ]},
                {"goal": "综合提升", "weeks": 3, "tasks": [
                    {"name": "综合演练与复盘", "description": "模拟真实场景，全面提升竞争力", "resources": [], "criteria": "综合评分提升10%", "linked_gap": "综合能力", "target_dimension": "soft_skill_evidence", "expected_impact": {"soft_skill_evidence": 0.05}}
                ]},
            ]
        phase1 = existing_phases[0]
        return [
            phase1,
            {"goal": "能力进阶", "weeks": 4, "tasks": [
                {"name": "项目实战深化", "description": "在基础之上通过项目实践深化核心能力", "resources": [], "criteria": "完成至少1个完整项目", "linked_gap": "项目经验不足", "target_dimension": "project_exp", "expected_impact": {"project_exp": 0.08}}
            ]},
            {"goal": "综合提升", "weeks": 3, "tasks": [
                {"name": "模拟面试与复盘", "description": "通过模拟面试和复盘全面提升竞争力", "resources": [], "criteria": "模拟面试通过率80%+", "linked_gap": "综合竞争力", "target_dimension": "soft_skill_evidence", "expected_impact": {"soft_skill_evidence": 0.05}}
            ]},
        ]


# ---- 确定性推理依据生成（LLM 未返回 ai_reasoning 时使用）----
def _build_deterministic_reasoning(state: PipelineState) -> dict:
    """根据诊断数据（维度分数、匹配结果、置信度）生成确定性的 ai_reasoning。

    返回结构：{维度/岗位名: {basis: str, confidence: float}}
    前端 AIReasoning 组件可正确渲染。
    """
    reasoning = {}
    profile = state.get("profile", {})
    match_result = state.get("match_result", {})
    dim_scores = match_result.get("dimension_scores", {})
    top5 = match_result.get("top5_jobs", [])
    confidence = state.get("confidence", {})
    dim_confidences = confidence.get("dimensions", {})

    # 1. 各维度能力分析
    dim_labels = {
        "tech": "技术技能", "tech_skills": "技术技能",
        "project": "项目经验", "project_exp": "项目经验",
        "academic": "学业基础", "academic_foundation": "学业基础",
        "domain": "领域知识", "domain_knowledge": "领域知识",
        "soft_evidence": "软技能", "soft_skill_evidence": "软技能",
    }
    for key, score in dim_scores.items():
        label = dim_labels.get(key, key)
        conf = dim_confidences.get(key, dim_confidences.get(
            {"tech": "tech_skills", "project": "project_exp",
             "academic": "academic_foundation", "domain": "domain_knowledge",
             "soft_evidence": "soft_skill_evidence"}.get(key, key), 0.5))

        if score >= 0.7:
            basis = f"{label}得分 {score:.0%}，表现良好，是当前竞争力的核心优势"
        elif score >= 0.4:
            basis = f"{label}得分 {score:.0%}，有一定基础但仍有提升空间"
        else:
            basis = f"{label}得分 {score:.0%}，是当前短板，建议重点加强"
        reasoning[label] = {"basis": basis, "confidence": round(conf, 2)}

    # 2. 岗位匹配分析
    if top5:
        best = top5[0]
        job_title = best.get("title", "目标岗位")
        ms = best.get("match_score", 0)
        matched = best.get("matched_skills", [])
        missing = best.get("missing_skills", [])
        job_basis = f"最匹配岗位为「{job_title}」(匹配度 {ms:.0%})"
        if matched:
            job_basis += f"，已具备 {', '.join(matched[:3])} 等技能"
        if missing:
            job_basis += f"，建议补充 {', '.join(missing[:3])}"
        reasoning["岗位匹配"] = {"basis": job_basis, "confidence": 0.75}

    # 3. 综合评估
    overall_match = match_result.get("match_score", 0)
    profile_conf = confidence.get("profile", 0.5)
    if profile_conf < 0.6:
        reasoning["综合评估"] = {
            "basis": f"综合匹配度 {overall_match:.0%}，但画像置信度仅 {profile_conf:.0%}，建议补充更详细的简历信息以获得更精准的分析",
            "confidence": profile_conf,
        }
    else:
        reasoning["综合评估"] = {
            "basis": f"综合匹配度 {overall_match:.0%}，画像置信度 {profile_conf:.0%}，分析结果较为可靠",
            "confidence": profile_conf,
        }

    return reasoning


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
        response = await llm.complete(messages, max_tokens=1500,
                                      response_format={"type": "json_object"})
        data, error = SchemaValidator.validate_json_output(response.content)
        if data and not error:
            state.set("career_advice", data.get("career_advice", ""))
            ai_reasoning = data.get("ai_reasoning") or {}
            # 如果 LLM 未返回有效的 ai_reasoning，使用确定性推理兜底
            if not ai_reasoning or not isinstance(ai_reasoning, dict):
                logger.info("AdviceStep: LLM 未返回 ai_reasoning，使用确定性推理兜底")
                ai_reasoning = _build_deterministic_reasoning(state)
            else:
                # 过滤掉元数据键，检查是否有真正的推理条目
                meta_keys = {"_fallback", "_note", "fallback", "note"}
                real_keys = [k for k in ai_reasoning if k not in meta_keys and ai_reasoning[k] is not None]
                if not real_keys:
                    logger.info("AdviceStep: LLM 返回的 ai_reasoning 仅有元数据，使用确定性推理兜底")
                    ai_reasoning = _build_deterministic_reasoning(state)
            state.set("ai_reasoning", ai_reasoning)
        else:
            logger.warning("AdviceStep: LLM 输出解析失败 (error=%s)，使用确定性推理兜底", error)
            state.set("career_advice", "建议持续关注行业趋势，针对目标岗位持续提升核心技能。")
            state.set("ai_reasoning", _build_deterministic_reasoning(state))
        return state
