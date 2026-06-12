# 学校端管理后台路由——数据统计、学生列表、企业管理、岗位审核审核与驳回
import math
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from pydantic import BaseModel
from typing import Optional, Literal
from core.utils.time import utc_now
from db.database import get_db
from db.models import Student, Enterprise, JobPost, JobAbilityModel, StudentAuthorization, DiagnosisResult, GrowthTask, StudentAttachment
from core.auth import require_admin, Identity

router = APIRouter(prefix="/api/admin", tags=["admin"])

# 默认分页常量
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 200


class EnterpriseStatusUpdate(BaseModel):
    status: Literal["active", "disabled", "pending"]  # 仅允许三种合法状态


class EnterpriseCreate(BaseModel):
    name: str
    industry: Optional[str] = ""
    description: Optional[str] = ""
    contact_name: Optional[str] = ""
    contact_email: Optional[str] = ""
    status: Optional[Literal["active", "pending"]] = "active"


class JobAuditRequest(BaseModel):
    reason: str  # 驳回原因必填，不允许为空


# 1. 增强运营统计数据（Gap 5：新增诊断覆盖率、平均分、企业活跃度和成长任务指标）
@router.get("/summary")
async def get_summary(
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    student_count = await db.scalar(select(func.count(Student.id)))
    enterprise_count = await db.scalar(select(func.count(Enterprise.id)))
    job_count = await db.scalar(select(func.count(JobPost.id)))
    pending_job_count = await db.scalar(select(func.count(JobPost.id)).where(JobPost.status == "pending_review"))
    active_auth_count = await db.scalar(select(func.count(StudentAuthorization.id)).where(StudentAuthorization.status == "active"))

    # Gap 5 新增：诊断覆盖率统计
    diagnosed_students = await db.scalar(
        select(func.count(func.distinct(DiagnosisResult.student_id)))
    ) or 0
    undiagnosed_students = (student_count or 0) - diagnosed_students

    # Gap 5 新增：全局平均匹配分
    avg_match_score_result = await db.scalar(
        select(func.avg(DiagnosisResult.match_score))
    )
    avg_match_score = round(float(avg_match_score_result), 4) if avg_match_score_result else 0.0

    # Gap 5 新增：活跃企业数
    active_enterprises = await db.scalar(
        select(func.count(Enterprise.id)).where(Enterprise.status == "active")
    ) or 0

    # Gap 5 新增：成长任务完成情况
    total_growth_tasks = await db.scalar(
        select(func.count(GrowthTask.id))
    ) or 0
    completed_growth_tasks = await db.scalar(
        select(func.count(GrowthTask.id)).where(GrowthTask.status == "completed")
    ) or 0

    return {
        "total_students": student_count or 0,
        "diagnosed_students": diagnosed_students,
        "undiagnosed_students": undiagnosed_students,
        "avg_match_score": avg_match_score,
        "total_enterprises": enterprise_count or 0,
        "active_enterprises": active_enterprises,
        "total_jobs": job_count or 0,
        "pending_jobs": pending_job_count or 0,
        "active_authorizations": active_auth_count or 0,
        "total_growth_tasks": total_growth_tasks,
        "completed_growth_tasks": completed_growth_tasks,
    }


# 2. 获取学生列表（聚合查询 + 分页 + 诊断状态筛选，消除 N+1）
@router.get("/students")
async def list_students(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE, description="每页数量"),
    diagnosis_status: Optional[Literal["diagnosed", "undiagnosed"]] = Query(None, description="筛选诊断状态：diagnosed=已评测, undiagnosed=未评测"),
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    # CTE: 聚合每个学生的诊断次数和最新版本号
    diag_agg = (
        select(
            DiagnosisResult.student_id,
            func.count(DiagnosisResult.id).label("diag_count"),
            func.max(DiagnosisResult.version).label("max_version"),
        )
        .group_by(DiagnosisResult.student_id)
        .cte("diag_agg")
    )

    # 主查询: 左连接聚合结果 + 左连接最新诊断记录获取 match_score（先不加排序，以便 WHERE 筛选后再排序）
    stmt = (
        select(
            Student,
            diag_agg.c.diag_count,
            DiagnosisResult.match_score.label("latest_score"),
        )
        .outerjoin(diag_agg, Student.id == diag_agg.c.student_id)
        .outerjoin(
            DiagnosisResult,
            (DiagnosisResult.student_id == Student.id)
            & (DiagnosisResult.version == diag_agg.c.max_version),
        )
    )

    # Gap 1：根据诊断状态筛选并计算对应的分页总数
    # 注意：total 必须与主查询使用相同的数据源（Student JOIN diag_agg），
    # 避免 diagnosis_results 中的孤立记录导致计数与实际列表不一致
    if diagnosis_status == "diagnosed":
        stmt = stmt.where(diag_agg.c.diag_count > 0)
        count_sub = (
            select(func.count(Student.id))
            .select_from(Student)
            .join(diag_agg, Student.id == diag_agg.c.student_id)
            .where(diag_agg.c.diag_count > 0)
        )
        total = await db.scalar(count_sub) or 0
    elif diagnosis_status == "undiagnosed":
        stmt = stmt.where(diag_agg.c.diag_count.is_(None))
        count_sub = (
            select(func.count(Student.id))
            .select_from(Student)
            .outerjoin(diag_agg, Student.id == diag_agg.c.student_id)
            .where(diag_agg.c.diag_count.is_(None))
        )
        total = await db.scalar(count_sub) or 0
    else:
        total = await db.scalar(select(func.count(Student.id))) or 0

    # 排序 + 分页
    stmt = stmt.order_by(Student.created_at.desc())
    offset = (page - 1) * page_size
    res = await db.execute(stmt.offset(offset).limit(page_size))
    rows = res.all()

    # 格式化输出
    items = []
    for row in rows:
        student = row[0]
        diag_count = row[1] or 0
        latest_score = row[2]
        items.append(
            {
                "id": student.id,
                "name": student.name,
                "grade": student.grade,
                "major": student.major,
                "target_job": student.target_job,
                "created_at": student.created_at.isoformat() if student.created_at else None,
                "diagnosis_count": diag_count,
                "latest_score": latest_score,
            }
        )

    total_pages = math.ceil(total / page_size) if total > 0 else 0

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


# 3. 获取特定学生诊断及授权详情（Gap 2+8：新增最新诊断定性内容、附件列表、成长任务汇总）
@router.get("/students/{student_id}")
async def get_student_detail(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(404, "Student not found")

    diag_stmt = select(DiagnosisResult).where(DiagnosisResult.student_id == student_id).order_by(desc(DiagnosisResult.version))
    diag_res = await db.execute(diag_stmt)
    diags = diag_res.scalars().all()

    auth_stmt = (
        select(StudentAuthorization, JobPost.title, Enterprise.name)
        .join(JobPost, StudentAuthorization.job_post_id == JobPost.id)
        .join(Enterprise, StudentAuthorization.enterprise_id == Enterprise.id)
        .where(StudentAuthorization.student_id == student_id)
    )
    auth_res = await db.execute(auth_stmt)
    auths = [{
        "id": row[0].id,
        "job_title": row[1],
        "enterprise_name": row[2],
        "status": row[0].status,
        "created_at": row[0].created_at.isoformat() if row[0].created_at else None
    } for row in auth_res.all()]

    # Gap 2：提取最新诊断的定性内容
    latest_diag = diags[0] if diags else None
    latest_diagnosis_detail = None
    if latest_diag:
        latest_diagnosis_detail = {
            "id": latest_diag.id,
            "version": latest_diag.version,
            "diagnosis_type": latest_diag.diagnosis_type,
            "match_score": latest_diag.match_score,
            "ability_profile": latest_diag.ability_profile,
            "dimension_scores": latest_diag.dimension_scores,
            "gap_details": latest_diag.gap_details,
            "growth_path": latest_diag.growth_path,
            "career_advice": latest_diag.career_advice,
            "ai_reasoning": latest_diag.ai_reasoning,
            "top5_jobs": latest_diag.top5_jobs,
            "created_at": latest_diag.created_at.isoformat() if latest_diag.created_at else None,
        }

    # Gap 8：附件列表
    att_stmt = select(StudentAttachment).where(StudentAttachment.student_id == student_id).order_by(desc(StudentAttachment.uploaded_at))
    att_res = await db.execute(att_stmt)
    attachments = [{
        "id": a.id,
        "category": a.category,
        "file_name": a.file_name,
        "file_type": a.file_type,
        "file_size": a.file_size,
        "uploaded_at": a.uploaded_at.isoformat() if a.uploaded_at else None,
    } for a in att_res.scalars().all()]

    # Gap 8：成长任务完成情况汇总
    total_tasks = await db.scalar(
        select(func.count(GrowthTask.id)).where(GrowthTask.student_id == student_id)
    ) or 0
    completed_tasks = await db.scalar(
        select(func.count(GrowthTask.id)).where(
            GrowthTask.student_id == student_id,
            GrowthTask.status == "completed",
        )
    ) or 0
    in_progress_tasks = await db.scalar(
        select(func.count(GrowthTask.id)).where(
            GrowthTask.student_id == student_id,
            GrowthTask.status == "in_progress",
        )
    ) or 0
    growth_tasks_summary = {
        "total": total_tasks,
        "completed": completed_tasks,
        "in_progress": in_progress_tasks,
        "pending": total_tasks - completed_tasks - in_progress_tasks,
    }

    # 将 ORM 对象序列化为纯 dict，避免 JSON 编码异常
    student_dict = {
        "id": student.id,
        "name": student.name,
        "grade": student.grade or "",
        "major": student.major or "",
        "target_job": student.target_job or "",
        "school": student.school or "",
        "education_level": student.education_level or "",
        "phone": student.phone or "",
        "email": student.email or "",
        "tech_skills": student.tech_skills or {},
        "project_exp": student.project_exp or [],
        "soft_skills": student.soft_skills or {},
        "domain_knowledge": student.domain_knowledge or {},
        "academic_foundation": student.academic_foundation or {},
        "soft_skill_evidence": student.soft_skill_evidence or {},
        "resume_text": student.resume_text or "",
        "profile_sections": student.profile_sections or {},
        "profile_completeness": student.profile_completeness or 0,
        "self_evaluation": student.self_evaluation or "",
        "created_at": student.created_at.isoformat() if student.created_at else None,
    }

    diagnoses_list = [{
        "id": d.id,
        "version": d.version,
        "diagnosis_type": d.diagnosis_type or "",
        "match_score": d.match_score or 0.0,
        "dimension_scores": d.dimension_scores or {},
        "gap_details": d.gap_details or [],
        "top5_jobs": d.top5_jobs or [],
        "career_advice": d.career_advice or "",
        "ai_reasoning": d.ai_reasoning or {},
        "created_at": d.created_at.isoformat() if d.created_at else None,
    } for d in diags]

    return {
        "student": student_dict,
        "diagnoses": diagnoses_list,
        "authorizations": auths,
        "latest_diagnosis_detail": latest_diagnosis_detail,
        "attachments": attachments,
        "growth_tasks_summary": growth_tasks_summary,
    }


# 4. 获取合作企业列表（分页）
@router.get("/enterprises")
async def list_enterprises(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE, description="每页数量"),
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    total = await db.scalar(select(func.count(Enterprise.id))) or 0
    total_pages = math.ceil(total / page_size) if total > 0 else 0

    offset = (page - 1) * page_size
    stmt = select(Enterprise).order_by(Enterprise.created_at.desc()).offset(offset).limit(page_size)
    res = await db.execute(stmt)
    rows = res.scalars().all()

    items = []
    for ent in rows:
        items.append({
            "id": ent.id,
            "name": ent.name,
            "industry": ent.industry,
            "description": ent.description,
            "contact_name": ent.contact_name,
            "contact_email": ent.contact_email,
            "status": ent.status,
            "created_at": ent.created_at.isoformat() if ent.created_at else None,
            "updated_at": ent.updated_at.isoformat() if ent.updated_at else None,
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


# 5. 获取企业详情
@router.get("/enterprises/{enterprise_id}")
async def get_enterprise(
    enterprise_id: str,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    ent = await db.get(Enterprise, enterprise_id)
    if not ent:
        raise HTTPException(404, "Enterprise not found")
    return ent


# 5.1 新增企业（管理员创建）
@router.post("/enterprises")
async def create_enterprise(
    req: EnterpriseCreate,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    # 校验企业名称必填
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "企业名称不能为空")

    # 校验企业名称不重复
    existing = await db.scalar(select(Enterprise).where(Enterprise.name == name))
    if existing:
        raise HTTPException(409, f"企业「{name}」已存在，请勿重复添加")

    # 校验状态值
    status = req.status or "active"
    if status not in ("active", "pending"):
        raise HTTPException(400, "状态只能是 active 或 pending")

    ent = Enterprise(
        name=name,
        industry=(req.industry or "").strip(),
        description=(req.description or "").strip(),
        contact_name=(req.contact_name or "").strip(),
        contact_email=(req.contact_email or "").strip(),
        status=status,
    )
    db.add(ent)
    await db.commit()
    await db.refresh(ent)

    return {
        "id": ent.id,
        "name": ent.name,
        "industry": ent.industry,
        "description": ent.description,
        "contact_name": ent.contact_name,
        "contact_email": ent.contact_email,
        "status": ent.status,
        "created_at": ent.created_at.isoformat() if ent.created_at else None,
    }


# 6. 修改企业合作状态
@router.put("/enterprises/{enterprise_id}/status")
async def update_enterprise_status(
    enterprise_id: str,
    req: EnterpriseStatusUpdate,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    ent = await db.get(Enterprise, enterprise_id)
    if not ent:
        raise HTTPException(404, "Enterprise not found")
    ent.status = req.status
    await db.commit()
    return ent


# 7. 获取所有企业发布的岗位列表（支持筛选 + 分页）
@router.get("/jobs")
async def list_jobs(
    status: Optional[str] = None,
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE, description="每页数量"),
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    # 构建过滤条件：未指定 status 时，默认排除已驳回的岗位（管理员不可见）
    conditions = []
    if status:
        conditions.append(JobPost.status == status)
    else:
        conditions.append(JobPost.status != "rejected")

    # 总数
    count_stmt = (
        select(func.count(JobPost.id))
        .join(Enterprise, JobPost.enterprise_id == Enterprise.id)
    )
    for cond in conditions:
        count_stmt = count_stmt.where(cond)
    total = await db.scalar(count_stmt) or 0
    total_pages = math.ceil(total / page_size) if total > 0 else 0

    # 分页数据
    stmt = (
        select(JobPost, Enterprise.name.label("enterprise_name"))
        .join(Enterprise, JobPost.enterprise_id == Enterprise.id)
    )
    for cond in conditions:
        stmt = stmt.where(cond)
    stmt = stmt.order_by(desc(JobPost.created_at))

    offset = (page - 1) * page_size
    res = await db.execute(stmt.offset(offset).limit(page_size))

    jobs = []
    for row in res.all():
        jobs.append({
            "id": row[0].id,
            "enterprise_id": row[0].enterprise_id,
            "enterprise_name": row.enterprise_name,
            "title": row[0].title,
            "category": row[0].category,
            "description": row[0].description,
            "requirements_text": row[0].requirements_text,
            "status": row[0].status,
            "review_reason": row[0].review_reason,
            "created_at": row[0].created_at.isoformat() if row[0].created_at else None,
        })

    return {
        "items": jobs,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


# 8. 获取岗位详情及其能力特征指标
@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    job = await db.get(JobPost, job_id)
    if not job:
        raise HTTPException(404, "Job post not found")
        
    ent = await db.get(Enterprise, job.enterprise_id)
    ability_stmt = select(JobAbilityModel).where(JobAbilityModel.job_post_id == job_id)
    ability_res = await db.execute(ability_stmt)
    model = ability_res.scalar_one_or_none()
    
    return {
        "job": job,
        "enterprise": ent,
        "ability_model": model
    }


# 9. 审核通过企业岗位
@router.post("/jobs/{job_id}/approve")
async def approve_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    job = await db.get(JobPost, job_id)
    if not job:
        raise HTTPException(404, "Job post not found")
    job.status = "approved"
    job.review_reason = ""
    await db.commit()
    return job


# 10. 驳回企业岗位（必须提供非空的驳回原因）
@router.post("/jobs/{job_id}/reject")
async def reject_job(
    job_id: str,
    req: JobAuditRequest,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    job = await db.get(JobPost, job_id)
    if not job:
        raise HTTPException(404, "Job post not found")
    # 校验：仅允许从待审核或已通过状态驳回
    if job.status not in ("pending_review", "approved"):
        raise HTTPException(400, f"当前状态「{job.status}」不允许驳回，仅待审核或已通过可驳回。")
    # 校验驳回原因不能为空
    reason = req.reason.strip()
    if not reason:
        raise HTTPException(400, "驳回原因不能为空，请填写具体的驳回理由。")
    job.status = "rejected"
    job.review_reason = reason
    await db.commit()
    return job


# 11. 获取学生 Agent 决策追踪（管理员专用）
@router.get("/students/{student_id}/traces")
async def get_student_traces(
    student_id: int,
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    """管理员查看指定学生的 Agent 决策追踪记录。"""
    from core.services import agent_trace_service
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(404, "Student not found")
    traces = await agent_trace_service.get_traces_by_student(db, student_id, limit=limit)
    return {"traces": traces, "total": len(traces)}


# 12. 管理员推荐学生到企业岗位（Gap 4：管理员发起授权，打破学生必须主动授权的瓶颈）
class RecommendRequest(BaseModel):
    job_post_id: str


@router.post("/students/{student_id}/recommend")
async def recommend_student_to_enterprise(
    student_id: int,
    req: RecommendRequest,
    db: AsyncSession = Depends(get_db),
    _identity: Identity = Depends(require_admin),
):
    """管理员将已评测学生推荐给企业岗位。逻辑与学生端授权一致，但由管理员发起。"""
    # 1. 验证学生存在且有诊断记录
    student = await db.get(Student, student_id)
    if not student:
        raise HTTPException(404, "Student not found")

    # 取最新诊断记录
    latest_diag = await db.scalar(
        select(DiagnosisResult)
        .where(DiagnosisResult.student_id == student_id)
        .order_by(desc(DiagnosisResult.version))
        .limit(1)
    )
    if not latest_diag:
        raise HTTPException(400, "该学生暂无 AI 诊断记录，请先完成诊断评测后再推荐")

    # 2. 验证岗位存在且已审核通过
    job_post = await db.get(JobPost, req.job_post_id)
    if not job_post:
        raise HTTPException(404, "Job post not found")
    if job_post.status != "approved":
        raise HTTPException(400, f"岗位「{job_post.title}」当前状态为「{job_post.status}」，仅审核通过的岗位可被推荐")

    # 3. 验证企业存在且 active
    enterprise = await db.get(Enterprise, job_post.enterprise_id)
    if not enterprise:
        raise HTTPException(404, "Enterprise not found")
    if enterprise.status != "active":
        raise HTTPException(
            400,
            f"企业「{enterprise.name}」当前状态为「{enterprise.status}」，仅活跃企业可接收推荐",
        )

    # 4. 检查是否已有授权记录（复用/创建逻辑与学生端一致）
    stmt = select(StudentAuthorization).where(
        StudentAuthorization.student_id == student_id,
        StudentAuthorization.job_post_id == req.job_post_id,
    )
    res = await db.execute(stmt)
    existing = res.scalar_one_or_none()

    if existing:
        existing.status = "active"
        existing.diagnosis_id = latest_diag.id
        existing.created_at = utc_now()
        existing.revoked_at = None
        auth = existing
        action = "reactivated"
    else:
        auth = StudentAuthorization(
            student_id=student_id,
            enterprise_id=job_post.enterprise_id,
            job_post_id=req.job_post_id,
            diagnosis_id=latest_diag.id,
            status="active",
        )
        db.add(auth)
        action = "created"

    await db.commit()
    await db.refresh(auth)

    return {
        "id": auth.id,
        "status": auth.status,
        "student_id": auth.student_id,
        "enterprise_id": auth.enterprise_id,
        "job_post_id": auth.job_post_id,
        "diagnosis_id": auth.diagnosis_id,
        "action": action,
        "enterprise_name": enterprise.name,
        "job_title": job_post.title,
    }
