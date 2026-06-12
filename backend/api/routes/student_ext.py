# 学生端扩展路由——获取在招企业岗位列表、授权画像给企业岗位、撤销授权
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from pydantic import BaseModel
from core.utils.time import utc_now
from db.database import get_db
from db.models import JobPost, Enterprise, StudentAuthorization, DiagnosisResult, Student, JobAbilityModel
from core.auth import require_student, verify_student_access, Identity

router = APIRouter(prefix="/api/student", tags=["student_ext"])


class AuthorizationCreate(BaseModel):
    student_id: int
    job_post_id: str
    diagnosis_id: str


class BatchAuthorizationCreate(BaseModel):
    student_id: int
    job_post_ids: list[str]
    diagnosis_id: str


# 1. 获取可投递/授权的企业审核通过的岗位列表
# 学生端可见岗位条件：enterprise.status == 'active' AND job.status == 'approved'
@router.get("/jobs")
async def get_student_jobs(
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(require_student),
):
    # 联表查询：只返回 active 企业的 approved 岗位
    stmt = (
        select(
            JobPost.id,
            JobPost.title,
            JobPost.category,
            JobPost.description,
            JobPost.requirements_text,
            JobPost.status,
            Enterprise.name.label("enterprise_name"),
            Enterprise.id.label("enterprise_id")
        )
        .join(Enterprise, JobPost.enterprise_id == Enterprise.id)
        .where(
            JobPost.status == "approved",
            Enterprise.status == "active"  # 关键：企业必须是 active 状态
        )
        .order_by(JobPost.created_at.desc())
    )
    result = await db.execute(stmt)
    jobs = []
    for row in result.all():
        jobs.append({
            "id": row.id,
            "title": row.title,
            "category": row.category,
            "description": row.description,
            "requirements_text": row.requirements_text,
            "status": row.status,
            "enterprise_name": row.enterprise_name,
            "enterprise_id": row.enterprise_id,
        })
    return jobs


# 2. 获取学生的授权记录列表
@router.get("/authorizations")
async def get_student_authorizations(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(require_student),
):
    verify_student_access(student_id, identity)
    stmt = (
        select(
            StudentAuthorization.id,
            StudentAuthorization.status,
            StudentAuthorization.created_at,
            StudentAuthorization.diagnosis_id,
            JobPost.title.label("job_title"),
            Enterprise.name.label("enterprise_name"),
            DiagnosisResult.version.label("diagnosis_version"),
            DiagnosisResult.match_score.label("match_score")
        )
        .join(JobPost, StudentAuthorization.job_post_id == JobPost.id)
        .join(Enterprise, StudentAuthorization.enterprise_id == Enterprise.id)
        .join(DiagnosisResult, StudentAuthorization.diagnosis_id == DiagnosisResult.id)
        .where(StudentAuthorization.student_id == student_id)
        .order_by(StudentAuthorization.created_at.desc())
    )
    result = await db.execute(stmt)
    auths = []
    for row in result.all():
        auths.append({
            "id": row.id,
            "status": row.status,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "diagnosis_id": row.diagnosis_id,
            "job_title": row.job_title,
            "enterprise_name": row.enterprise_name,
            "diagnosis_version": row.diagnosis_version,
            "match_score": row.match_score,
        })
    return auths


# 3. 授权画像给指定企业岗位
# 授权条件：enterprise.status == 'active' AND job.status == 'approved' AND diagnosis.student_id == current
@router.post("/authorizations")
async def create_authorization(
    req: AuthorizationCreate,
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(require_student),
):
    verify_student_access(req.student_id, identity)
    # 校验学生、岗位和诊断记录是否存在
    student = await db.get(Student, req.student_id)
    if not student:
        raise HTTPException(404, "Student not found")
        
    job_post = await db.get(JobPost, req.job_post_id)
    if not job_post:
        raise HTTPException(404, "Job post not found")
        
    diag = await db.get(DiagnosisResult, req.diagnosis_id)
    if not diag:
        raise HTTPException(404, "Diagnosis result not found")

    # 关键校验：诊断结果必须属于该学生
    if diag.student_id != req.student_id:
        raise HTTPException(400, "Diagnosis result does not belong to this student")

    # 岗位状态检查：必须是审核通过的
    if job_post.status != "approved":
        raise HTTPException(400, "Cannot authorize to a job post that is not approved")

    # 企业状态门禁：岗位所属企业必须是 active 状态
    enterprise = await db.get(Enterprise, job_post.enterprise_id)
    if not enterprise:
        raise HTTPException(404, "Enterprise not found")
    if enterprise.status != "active":
        raise HTTPException(
            400,
            f"Cannot authorize: enterprise '{enterprise.name}' is not active (status: {enterprise.status}). "
            "Only jobs from active enterprises can be authorized."
        )

    # 检查是否已有该岗位的授权记录
    stmt = select(StudentAuthorization).where(
        StudentAuthorization.student_id == req.student_id,
        StudentAuthorization.job_post_id == req.job_post_id
    )
    res = await db.execute(stmt)
    existing = res.scalar_one_or_none()

    if existing:
        # 更新已有记录
        existing.status = "active"
        existing.diagnosis_id = req.diagnosis_id
        existing.created_at = utc_now()
        existing.revoked_at = None
        auth = existing
    else:
        # 新建授权记录
        auth = StudentAuthorization(
            student_id=req.student_id,
            enterprise_id=job_post.enterprise_id,
            job_post_id=req.job_post_id,
            diagnosis_id=req.diagnosis_id,
            status="active"
        )
        db.add(auth)
        
    await db.commit()
    await db.refresh(auth)
    
    return {
        "id": auth.id,
        "status": auth.status,
        "student_id": auth.student_id,
        "enterprise_id": auth.enterprise_id,
        "job_post_id": auth.job_post_id,
        "diagnosis_id": auth.diagnosis_id
    }


# 4. 撤销授权
@router.delete("/authorizations/{auth_id}")
async def revoke_authorization(
    auth_id: str,
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(require_student),
):
    auth = await db.get(StudentAuthorization, auth_id)
    if not auth:
        raise HTTPException(404, "Authorization record not found")

    # 校验该授权记录归属当前学生
    verify_student_access(auth.student_id, identity)

    auth.status = "revoked"
    auth.revoked_at = utc_now()
    await db.commit()
    
    return {"status": "success", "message": "Authorization revoked successfully"}


# 5. 批量授权：一次授权多个岗位（Gap 6）
@router.post("/authorizations/batch")
async def batch_create_authorizations(
    req: BatchAuthorizationCreate,
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(require_student),
):
    verify_student_access(req.student_id, identity)

    # 校验学生存在
    student = await db.get(Student, req.student_id)
    if not student:
        raise HTTPException(404, "Student not found")

    # 校验诊断记录存在且归属该学生
    diag = await db.get(DiagnosisResult, req.diagnosis_id)
    if not diag:
        raise HTTPException(404, "Diagnosis result not found")
    if diag.student_id != req.student_id:
        raise HTTPException(400, "Diagnosis result does not belong to this student")

    created = 0
    updated = 0
    failed = 0
    details: list[dict] = []

    for job_post_id in req.job_post_ids:
        try:
            # 校验岗位
            job_post = await db.get(JobPost, job_post_id)
            if not job_post:
                failed += 1
                details.append({"job_post_id": job_post_id, "status": "failed", "reason": "Job post not found"})
                continue

            if job_post.status != "approved":
                failed += 1
                details.append({"job_post_id": job_post_id, "status": "failed", "reason": "Job post is not approved"})
                continue

            # 校验企业
            enterprise = await db.get(Enterprise, job_post.enterprise_id)
            if not enterprise:
                failed += 1
                details.append({"job_post_id": job_post_id, "status": "failed", "reason": "Enterprise not found"})
                continue
            if enterprise.status != "active":
                failed += 1
                details.append({"job_post_id": job_post_id, "status": "failed", "reason": f"Enterprise '{enterprise.name}' is not active"})
                continue

            # 检查是否已有授权记录
            stmt = select(StudentAuthorization).where(
                StudentAuthorization.student_id == req.student_id,
                StudentAuthorization.job_post_id == job_post_id
            )
            res = await db.execute(stmt)
            existing = res.scalar_one_or_none()

            if existing:
                existing.status = "active"
                existing.diagnosis_id = req.diagnosis_id
                existing.created_at = utc_now()
                existing.revoked_at = None
                auth = existing
                updated += 1
                details.append({"job_post_id": job_post_id, "status": "updated", "auth_id": auth.id})
            else:
                auth = StudentAuthorization(
                    student_id=req.student_id,
                    enterprise_id=job_post.enterprise_id,
                    job_post_id=job_post_id,
                    diagnosis_id=req.diagnosis_id,
                    status="active"
                )
                db.add(auth)
                await db.flush()
                created += 1
                details.append({"job_post_id": job_post_id, "status": "created", "auth_id": auth.id})

        except Exception as e:
            failed += 1
            details.append({"job_post_id": job_post_id, "status": "failed", "reason": str(e)})

    await db.commit()

    return {
        "created": created,
        "updated": updated,
        "failed": failed,
        "total": len(req.job_post_ids),
        "details": details,
    }
