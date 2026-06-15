# 企业端服务——企业信息管理、在招岗位发布、JD AI 模型解析、已授权候选人检索
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from core.utils.time import utc_now
from db.models import Enterprise, JobPost, JobAbilityModel, StudentAuthorization, Student, DiagnosisResult, StudentAttachment
from config.settings import LLM_API_KEY

SYSTEM_PROMPT = """你是一个专业的岗位JD（职业描述）分析助手。请严格按照以下JSON格式解析岗位JD，不要输出任何Markdown块或解释文字：
{
  "tech_skills": { "<技术技能名>": <推荐分值 0-100> },
  "soft_skills": { "<软技能名>": <推荐分值 0-100> },
  "domain_knowledge": { "<领域名>": <推荐分值 0-100> },
  "project_exp": [
    {
      "name": "<要求项目经验名称>",
      "description": "<1-2句话描述该项目经验的要求特征>"
    }
  ],
  "weight_config": {
    "tech_skills": <技术技能权重，0-1之间浮点数>,
    "project_exp": <项目经验权重，0-1之间浮点数>,
    "academic_foundation": <学业基础权重，0-1之间浮点数>,
    "domain_knowledge": <领域知识权重，0-1之间浮点数>,
    "soft_skill_evidence": <软技能证据权重，0-1之间浮点数>
  }
}

## 规则
1. 提取JD中明确或隐含的技术技能、项目经验、学业背景、软实力、领域知识要求。
2. 技能评分推荐分值通常在 60 到 90 之间（视JD中描述的重要程度而定）。
3. weight_config 中五项权重的加和必须等于 1.0。如果未明确提及，可使用默认权重 {"tech_skills": 0.35, "project_exp": 0.25, "academic_foundation": 0.10, "domain_knowledge": 0.15, "soft_skill_evidence": 0.15}。
4. 只返回上述纯JSON格式，禁止包裹在 ```json 或 ``` 块中。
"""

DEFAULT_WEIGHT_CONFIG = {
    "tech_skills": 0.35,
    "project_exp": 0.25,
    "academic_foundation": 0.10,
    "domain_knowledge": 0.15,
    "soft_skill_evidence": 0.15,
}


def _normalize_weight_config(raw: dict | None) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    aliases = {
        "project": "project_exp",
        "academic": "academic_foundation",
        "domain": "domain_knowledge",
        "soft": "soft_skill_evidence",
        "soft_skills": "soft_skill_evidence",
    }
    weights = {}
    for key, default in DEFAULT_WEIGHT_CONFIG.items():
        raw_value = raw.get(key, default)
        for alias, target in aliases.items():
            if target == key and alias in raw:
                raw_value = raw[alias]
                break
        try:
            weights[key] = max(0.0, float(raw_value))
        except (TypeError, ValueError):
            weights[key] = default
    total = sum(weights.values())
    if total <= 0.01:
        return dict(DEFAULT_WEIGHT_CONFIG)
    return {key: round(value / total, 2) for key, value in weights.items()}


# 1. 获取企业资料
async def get_enterprise_profile(db: AsyncSession, ent_id: str):
    return await db.get(Enterprise, ent_id)


# 2. 更新企业资料
async def update_enterprise_profile(db: AsyncSession, ent_id: str, data: dict):
    ent = await db.get(Enterprise, ent_id)
    if not ent:
        # 自动初始化创建以防不存在
        ent = Enterprise(id=ent_id, name=data.get("name", "未命名企业"))
        db.add(ent)
        
    ent.name = data.get("name", ent.name)
    ent.industry = data.get("industry", ent.industry)
    ent.description = data.get("description", ent.description)
    ent.contact_name = data.get("contact_name", ent.contact_name)
    ent.contact_email = data.get("contact_email", ent.contact_email)
    ent.updated_at = utc_now()
    
    await db.commit()
    await db.refresh(ent)
    return ent


# 3. 获取在招岗位列表
async def list_enterprise_jobs(db: AsyncSession, ent_id: str):
    stmt = select(JobPost).where(JobPost.enterprise_id == ent_id).order_by(desc(JobPost.created_at))
    res = await db.execute(stmt)
    return res.scalars().all()


# 4. 创建在招岗位
async def create_enterprise_job(db: AsyncSession, ent_id: str, data: dict):
    # 状态默认为 draft 草稿，需 AI 解析能力模型后才可提交审核
    job = JobPost(
        enterprise_id=ent_id,
        title=data.get("title", "未命名岗位"),
        category=data.get("category", ""),
        description=data.get("description", ""),
        requirements_text=data.get("requirements_text", ""),
        status=data.get("status", "draft")
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


# 5. 更新在招岗位
async def update_enterprise_job(db: AsyncSession, ent_id: str, job_id: str, data: dict):
    job = await db.get(JobPost, job_id)
    if not job or job.enterprise_id != ent_id:
        return None
        
    job.title = data.get("title", job.title)
    job.category = data.get("category", job.category)
    job.description = data.get("description", job.description)
    job.requirements_text = data.get("requirements_text", job.requirements_text)
    if "status" in data:
        # 企业端不允许直接设为 approved，必须走审核流程
        new_status = data["status"]
        if new_status in ("draft", "pending_review"):
            job.status = new_status
        # 已发布岗位可主动下线（approved → disabled），下线后可重新上线（disabled → approved）
        # 这两种流转不经过审核，因为是企业自身的招聘状态管理
        elif new_status == "disabled" and job.status == "approved":
            job.status = "disabled"
        elif new_status == "approved" and job.status == "disabled":
            job.status = "approved"
        # 被驳回的岗位重新编辑后回到草稿态，清除旧的驳回原因
        if new_status == "draft" and job.review_reason:
            job.review_reason = ""
    job.updated_at = utc_now()
    
    await db.commit()
    await db.refresh(job)
    return job


# 6. AI 提取岗位能力模型 (JobAbilityAgent)
async def parse_job_ability_model(db: AsyncSession, job_id: str):
    job = await db.get(JobPost, job_id)
    if not job:
        return None

    # 调用大模型解析
    if not LLM_API_KEY or not LLM_API_KEY.strip():
        # Fallback 模拟数据
        parsed = {
            "tech_skills": {"Python": 80, "FastAPI": 75},
            "soft_skills": {"团队协作": 75, "沟通表达": 70},
            "domain_knowledge": {"后端开发": 80},
            "project_exp": [{"name": "Web服务开发", "description": "使用Web框架开发过完整接口"}],
            "weight_config": dict(DEFAULT_WEIGHT_CONFIG)
        }
    else:
        from core.harness.llm import get_llm_client
        from api.routes.resume import _extract_json
        llm = get_llm_client()
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"职位名称: {job.title}\n分类: {job.category}\n岗位描述及要求: {job.requirements_text}"}
        ]
        response = await llm.complete(messages, max_tokens=1500)
        try:
            data = _extract_json(response.content)
            
            # 基础结构校验与清洗
            parsed = {
                "tech_skills": {},
                "soft_skills": {},
                "domain_knowledge": {},
                "project_exp": [],
                "weight_config": dict(DEFAULT_WEIGHT_CONFIG)
            }
            for f in ["tech_skills", "soft_skills", "domain_knowledge"]:
                val = data.get(f, {})
                if isinstance(val, dict):
                    parsed[f] = {str(k): max(0, min(100, int(v))) for k, v in val.items() if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit())}
            
            wc = data.get("weight_config", {})
            parsed["weight_config"] = _normalize_weight_config(wc)
                    
            proj = data.get("project_exp", [])
            if isinstance(proj, list):
                for p in proj:
                    if isinstance(p, dict) and "name" in p:
                        parsed["project_exp"].append({
                            "name": str(p["name"]),
                            "description": str(p.get("description", ""))
                        })
        except Exception as e:
            # 异常时使用兜底数据
            import logging
            logging.getLogger("enterprise.service").warning("JD解析异常，使用兜底: %s", e)
            parsed = {
                "tech_skills": {job.title: 70},
                "soft_skills": {"沟通表达": 60},
                "domain_knowledge": {job.category or "通用领域": 70},
                "project_exp": [],
                "weight_config": dict(DEFAULT_WEIGHT_CONFIG)
            }

    # 保存或更新到表
    stmt = select(JobAbilityModel).where(JobAbilityModel.job_post_id == job_id)
    res = await db.execute(stmt)
    model = res.scalar_one_or_none()

    if model:
        model.tech_skills = parsed["tech_skills"]
        model.soft_skills = parsed["soft_skills"]
        model.domain_knowledge = parsed["domain_knowledge"]
        model.project_exp = parsed["project_exp"]
        model.weight_config = parsed["weight_config"]
        model.updated_at = utc_now()
    else:
        model = JobAbilityModel(
            job_post_id=job_id,
            tech_skills=parsed["tech_skills"],
            soft_skills=parsed["soft_skills"],
            domain_knowledge=parsed["domain_knowledge"],
            project_exp=parsed["project_exp"],
            weight_config=parsed["weight_config"]
        )
        db.add(model)

    await db.commit()
    await db.refresh(model)
    return model


# 7. 提交岗位审核（必须先完成 AI 能力模型解析）
async def submit_job_review(db: AsyncSession, ent_id: str, job_id: str):
    job = await db.get(JobPost, job_id)
    if not job or job.enterprise_id != ent_id:
        return None

    # 校验：只有已解析能力模型的岗位才能提交审核
    stmt = select(JobAbilityModel).where(JobAbilityModel.job_post_id == job_id)
    res = await db.execute(stmt)
    model = res.scalar_one_or_none()
    if not model:
        raise ValueError("请先使用 AI 解析岗位能力模型后再提交审核")

    job.status = "pending_review"
    job.updated_at = utc_now()
    await db.commit()
    return job


# 8. 获取企业岗位的已授权候选人（含 Gap 3：各岗位潜在匹配匿名计数 + Gap 7：自动同步最新诊断版本）
async def list_authorized_candidates(db: AsyncSession, ent_id: str):
    # Gap 7: 使用每学生最新诊断版本，而非授权时的固定版本
    # 子查询：每学生最新诊断版本
    latest_ver_subq = (
        select(
            DiagnosisResult.student_id,
            func.max(DiagnosisResult.version).label('max_version')
        )
        .group_by(DiagnosisResult.student_id)
        .subquery()
    )

    # 查询所有授权状态为 active 且属于该企业的候选人记录
    # JOIN 改为先连接 latest_ver_subq（由 student_id 关联），再通过 (student_id, version) 获取最新诊断
    stmt = (
        select(
            StudentAuthorization.id.label("auth_id"),
            StudentAuthorization.created_at.label("auth_date"),
            StudentAuthorization.status.label("auth_status"),
            StudentAuthorization.diagnosis_id.label("auth_diagnosis_id"),
            Student.id.label("student_id"),
            Student.name.label("student_name"),
            Student.grade.label("student_grade"),
            Student.major.label("student_major"),
            JobPost.title.label("job_title"),
            JobPost.id.label("job_post_id"),
            DiagnosisResult.id.label("diagnosis_id"),
            DiagnosisResult.match_score.label("match_score"),
            DiagnosisResult.dimension_scores.label("dimension_scores"),
            DiagnosisResult.version.label("diagnosis_version"),
        )
        .join(Student, StudentAuthorization.student_id == Student.id)
        .join(JobPost, StudentAuthorization.job_post_id == JobPost.id)
        .join(latest_ver_subq, StudentAuthorization.student_id == latest_ver_subq.c.student_id)
        .join(DiagnosisResult,
              (DiagnosisResult.student_id == latest_ver_subq.c.student_id)
              & (DiagnosisResult.version == latest_ver_subq.c.max_version))
        .where(StudentAuthorization.enterprise_id == ent_id, StudentAuthorization.status == "active")
        .order_by(desc(DiagnosisResult.match_score))
    )
    result = await db.execute(stmt)
    candidates = []
    authorized_per_job: dict[str, int] = {}
    for row in result.all():
        # Gap 7: 标注授权版本是否为最新
        is_latest = (row.diagnosis_id == row.auth_diagnosis_id)
        candidates.append({
            "auth_id": row.auth_id,
            "auth_date": row.auth_date.isoformat() if row.auth_date else None,
            "student_id": row.student_id,
            "student_name": row.student_name,
            "student_grade": row.student_grade,
            "student_major": row.student_major,
            "job_title": row.job_title,
            "job_post_id": row.job_post_id,
            "diagnosis_id": row.diagnosis_id,
            "auth_diagnosis_id": row.auth_diagnosis_id,
            "is_latest_version": is_latest,
            "match_score": row.match_score,
            "dimension_scores": row.dimension_scores,
            "diagnosis_version": row.diagnosis_version,
        })
        authorized_per_job[row.job_post_id] = authorized_per_job.get(row.job_post_id, 0) + 1

    # --- Gap 3: 计算各岗位的潜在匹配（已诊断但未授权）匿名计数 ---
    # 1. 获取该企业所有 approved 岗位
    jobs_stmt = select(JobPost.id, JobPost.title).where(
        JobPost.enterprise_id == ent_id,
        JobPost.status == "approved"
    )
    jobs_res = await db.execute(jobs_stmt)
    jobs = [(row.id, row.title) for row in jobs_res.all()]

    # 2. 取所有学生的"最新诊断"记录（每学生取最大 version），提取 top5_jobs
    diag_stmt = select(
        DiagnosisResult.student_id,
        DiagnosisResult.version,
        DiagnosisResult.top5_jobs
    ).order_by(DiagnosisResult.student_id, desc(DiagnosisResult.version))
    diag_res = await db.execute(diag_stmt)
    latest_diags: dict[int, list] = {}  # student_id -> top5_jobs
    for dr in diag_res.all():
        if dr.student_id not in latest_diags:
            latest_diags[dr.student_id] = dr.top5_jobs or []

    # 3. 按岗位统计：top5_jobs 中包含该岗位的学生数 = diagnosed_count
    diagnosed_per_job: dict[str, int] = {}
    for job_id, _ in jobs:
        count = 0
        for _, top5 in latest_diags.items():
            if any(str(j.get("job_id", "")) == job_id for j in top5):
                count += 1
        diagnosed_per_job[job_id] = count

    # 4. 组装 job_match_stats
    job_match_stats = []
    for job_id, job_title in jobs:
        authorized = authorized_per_job.get(job_id, 0)
        diagnosed = diagnosed_per_job.get(job_id, 0)
        job_match_stats.append({
            "job_post_id": job_id,
            "job_title": job_title,
            "authorized_count": authorized,
            "potential_match_count": max(0, diagnosed - authorized),
        })

    return {
        "candidates": candidates,
        "job_match_stats": job_match_stats,
    }


# 9. 获取单个候选人授权详情（Gap 7：自动同步最新诊断版本）
async def get_candidate_detail(db: AsyncSession, ent_id: str, student_id: int, auth_id: str):
    # 验证该授权是否有效且属于该企业
    auth = await db.get(StudentAuthorization, auth_id)
    if not auth or auth.enterprise_id != ent_id or auth.student_id != student_id or auth.status != "active":
        return None

    student = await db.get(Student, student_id)
    job_post = await db.get(JobPost, auth.job_post_id)

    if not student or not job_post:
        return None

    # Gap 7: 获取该学生最新诊断记录（而非授权时的固定版本）
    diag_stmt = (
        select(DiagnosisResult)
        .where(DiagnosisResult.student_id == student_id)
        .order_by(desc(DiagnosisResult.version))
        .limit(1)
    )
    diag_res = await db.execute(diag_stmt)
    diag = diag_res.scalar_one_or_none()

    if not diag:
        return None

    # 检查授权版本是否为最新
    is_latest_version = (diag.id == auth.diagnosis_id)

    attachment_result = await db.execute(
        select(StudentAttachment)
        .where(StudentAttachment.student_id == student_id)
        .order_by(desc(StudentAttachment.uploaded_at))
    )
    attachments = [
        {
            "id": att.id,
            "category": att.category,
            "file_name": att.file_name,
            "file_type": att.file_type,
            "file_size": att.file_size,
            "uploaded_at": att.uploaded_at.isoformat() if att.uploaded_at else None,
            "visibility": att.visibility,
        }
        for att in attachment_result.scalars().all()
    ]

    return {
        "student": {
            "id": student.id,
            "name": student.name,
            "grade": student.grade,
            "major": student.major,
            "school": student.school,
            "education_level": student.education_level,
            "phone": student.phone,
            "email": student.email,
            "target_job": student.target_job,
            "project_exp": student.project_exp or [],
            "profile_sections": student.profile_sections or {},
            "profile_completeness": student.profile_completeness or 0,
            "academic_foundation": student.academic_foundation or {},
            "soft_skill_evidence": student.soft_skill_evidence or {},
        },
        "job": {
            "id": job_post.id,
            "title": job_post.title,
            "description": job_post.description
        },
        "diagnosis": {
            "id": diag.id,
            "version": diag.version,
            "match_score": diag.match_score,
            "dimension_scores": diag.dimension_scores or {},
            "gap_details": diag.gap_details or [],
            "career_advice": diag.career_advice or "",
            "ai_reasoning": diag.ai_reasoning or {}
        },
        "authorization_time": auth.created_at.isoformat() if auth.created_at else None,
        # Gap 7: 标注授权时的诊断版本与最新版本的关系
        "auth_diagnosis_version": auth.diagnosis_id,
        "is_latest_version": is_latest_version,
        "attachments": attachments,
    }
