# 附件管理路由——学生上传成绩单/外语证明等，企业授权查看
import os
import shutil
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sql_delete

from db.database import get_db
from db.models import StudentAttachment, StudentAuthorization
from core.auth import get_current_identity, verify_student_access, Identity
from config.settings import UPLOAD_DIR, MAX_UPLOAD_SIZE_MB

router = APIRouter(tags=["attachments"])

# 附件允许的 MIME 类型
ATTACHMENT_ALLOWED_TYPES = {
    "application/pdf",
    "image/jpeg", "image/png", "image/jpg", "image/webp",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".docx",
}

ATTACHMENT_DIR = UPLOAD_DIR / "attachments"


def _ensure_dir(student_id: int) -> Path:
    """确保学生附件目录存在。"""
    d = ATTACHMENT_DIR / str(student_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---- 学生端 ----

@router.post("/api/students/{student_id}/attachments")
async def upload_attachment(
    student_id: int,
    file: UploadFile = File(...),
    category: str = Form("other"),
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    verify_student_access(student_id, identity)

    # 校验文件大小
    if file.size and file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"文件大小超过限制 ({MAX_UPLOAD_SIZE_MB}MB)")

    # 校验类型
    ext = Path(file.filename or "").suffix.lower()
    if ext not in {".pdf", ".jpg", ".jpeg", ".png", ".webp", ".docx"}:
        raise HTTPException(400, f"不支持的文件类型: {ext}")

    # 保存文件
    target_dir = _ensure_dir(student_id)
    safe_name = f"{category}_{file.filename}"
    file_path = target_dir / safe_name

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # 写入数据库
    import uuid
    att = StudentAttachment(
        id=str(uuid.uuid4()),
        student_id=student_id,
        category=category,
        file_name=file.filename or safe_name,
        file_type=file.content_type or ext,
        file_size=len(content),
        storage_path=str(file_path),
        visibility="authorized_enterprises_only",
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)

    return {
        "id": att.id,
        "category": att.category,
        "file_name": att.file_name,
        "file_type": att.file_type,
        "file_size": att.file_size,
        "uploaded_at": att.uploaded_at.isoformat() if att.uploaded_at else None,
        "visibility": att.visibility,
    }


@router.get("/api/students/{student_id}/attachments")
async def list_attachments(
    student_id: int,
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    verify_student_access(student_id, identity)
    result = await db.execute(
        select(StudentAttachment)
        .where(StudentAttachment.student_id == student_id)
        .order_by(StudentAttachment.uploaded_at.desc())
    )
    rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "category": r.category,
            "file_name": r.file_name,
            "file_type": r.file_type,
            "file_size": r.file_size,
            "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
            "visibility": r.visibility,
        }
        for r in rows
    ]


@router.delete("/api/students/{student_id}/attachments/{attachment_id}")
async def delete_attachment(
    student_id: int,
    attachment_id: str,
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    verify_student_access(student_id, identity)
    result = await db.execute(
        select(StudentAttachment).where(
            StudentAttachment.id == attachment_id,
            StudentAttachment.student_id == student_id,
        )
    )
    att = result.scalar_one_or_none()
    if not att:
        raise HTTPException(404, "附件不存在")

    # 删除物理文件
    if att.storage_path and os.path.exists(att.storage_path):
        os.remove(att.storage_path)

    await db.delete(att)
    await db.commit()
    return {"success": True}


# ---- 企业端（授权查看） ----

@router.get("/api/enterprise/candidates/{student_id}/attachments")
async def enterprise_view_attachments(
    student_id: str,
    enterprise_id: str = Query(...),
    auth_id: str = Query(None),
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    # 校验企业身份
    if identity.role != "enterprise" or identity.enterprise_id != enterprise_id:
        raise HTTPException(403, "无权访问")

    sid = int(student_id)

    # 校验授权状态
    auth_result = await db.execute(
        select(StudentAuthorization).where(
            StudentAuthorization.student_id == sid,
            StudentAuthorization.enterprise_id == enterprise_id,
            StudentAuthorization.status == "active",
        )
    )
    if not auth_result.scalar_one_or_none():
        raise HTTPException(403, "未获得该学生的授权")

    result = await db.execute(
        select(StudentAttachment)
        .where(StudentAttachment.student_id == sid)
        .order_by(StudentAttachment.uploaded_at.desc())
    )
    rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "category": r.category,
            "file_name": r.file_name,
            "file_type": r.file_type,
            "file_size": r.file_size,
            "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
        }
        for r in rows
    ]


@router.get("/api/enterprise/candidates/{student_id}/attachments/{attachment_id}/download")
async def enterprise_download_attachment(
    student_id: str,
    attachment_id: str,
    enterprise_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    # 校验企业身份
    if identity.role != "enterprise" or identity.enterprise_id != enterprise_id:
        raise HTTPException(403, "无权访问")

    sid = int(student_id)

    # 校验授权
    auth_result = await db.execute(
        select(StudentAuthorization).where(
            StudentAuthorization.student_id == sid,
            StudentAuthorization.enterprise_id == enterprise_id,
            StudentAuthorization.status == "active",
        )
    )
    if not auth_result.scalar_one_or_none():
        raise HTTPException(403, "未获得该学生的授权")

    att_result = await db.execute(
        select(StudentAttachment).where(
            StudentAttachment.id == attachment_id,
            StudentAttachment.student_id == sid,
        )
    )
    att = att_result.scalar_one_or_none()
    if not att or not att.storage_path or not os.path.exists(att.storage_path):
        raise HTTPException(404, "附件不存在")

    return FileResponse(
        att.storage_path,
        media_type=att.file_type or "application/octet-stream",
        filename=att.file_name,
    )
