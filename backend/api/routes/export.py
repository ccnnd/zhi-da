# 导出路由——JSON 能力画像、Excel(技能+岗位)、PDF 成长路径报告
import json
import io
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from db.database import get_db
from db.models import DiagnosisResult as DiagORM
from core.auth import get_current_identity, verify_student_access, Identity

router = APIRouter(prefix="/api/export", tags=["export"])


# 导出能力画像为 JSON
@router.get("/profile/{student_id}")
async def export_profile_json(
    student_id: int,
    diagnosis_id: str = Query(None),
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    verify_student_access(student_id, identity)
    if diagnosis_id:
        result = await db.execute(select(DiagORM).where(DiagORM.id == diagnosis_id, DiagORM.student_id == student_id))
    else:
        result = await db.execute(
            select(DiagORM).where(DiagORM.student_id == student_id).order_by(DiagORM.created_at.desc()).limit(1))
    diag = result.scalar_one_or_none()
    if not diag:
        return {"error": "No diagnosis found"}
    data = {
        "student_id": diag.student_id,
        "version": diag.version,
        "match_score": diag.match_score,
        "dimension_scores": diag.dimension_scores,
        "dimension_changes": diag.dimension_changes,
        "gap_details": diag.gap_details,
        "top5_jobs": diag.top5_jobs,
        "growth_path": diag.growth_path,
        "career_advice": diag.career_advice,
        "ai_reasoning": diag.ai_reasoning,
        "explanations": diag.explanations,
        "ai_status": diag.ai_status,
        "created_at": diag.created_at.isoformat() if diag.created_at else None,
    }
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=profile_v{diag.version}_{student_id}.json"}
    )


# 导出为 Excel(含能力画像和 TOP5 岗位两个工作表)
@router.get("/profile/{student_id}/excel")
async def export_profile_excel(
    student_id: int,
    diagnosis_id: str = Query(None),
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    verify_student_access(student_id, identity)
    from openpyxl import Workbook
    if diagnosis_id:
        result = await db.execute(select(DiagORM).where(DiagORM.id == diagnosis_id, DiagORM.student_id == student_id))
    else:
        result = await db.execute(
            select(DiagORM).where(DiagORM.student_id == student_id).order_by(DiagORM.created_at.desc()).limit(1))
    diag = result.scalar_one_or_none()
    if not diag:
        return {"error": "No diagnosis found"}

    wb = Workbook()
    ws = wb.active
    ws.title = "能力画像"

    # 五维能力分数（学生最关心的雷达图数据）
    dim_labels = {
        "tech": "技术技能", "tech_skills": "技术技能",
        "project": "项目经验", "project_exp": "项目经验",
        "academic": "学业基础", "academic_foundation": "学业基础",
        "domain": "领域知识", "domain_knowledge": "领域知识",
        "soft": "软技能", "soft_evidence": "软技能证据", "soft_skill_evidence": "软技能证据", "soft_skills": "软技能",
    }
    ws.append(["维度", "分数(百分制)"])
    for k, v in (diag.dimension_scores or {}).items():
        score = v * 100 if isinstance(v, (int, float)) and v <= 1.0 else v
        ws.append([dim_labels.get(k, k), round(score, 1)])
    match_val = diag.match_score * 100 if isinstance(diag.match_score, (int, float)) and diag.match_score <= 1.0 else (diag.match_score or 0)
    ws.append(["综合匹配度", f"{match_val:.1f}%"])
    ws.append([])

    # 差距分析
    ws.append(["维度", "技能", "当前值", "要求值", "差距"])
    dimension_map = {"tech": "技术能力", "project": "项目经验", "soft": "软技能", "domain": "领域知识",
                     "tech_skills": "技术能力", "project_exp": "项目经验", "academic_foundation": "学业基础",
                     "domain_knowledge": "领域知识", "soft_skill_evidence": "软技能"}
    for gap in (diag.gap_details or []):
        dim_label = dimension_map.get(gap.get("dimension", ""), gap.get("dimension", ""))
        ws.append([dim_label, gap.get("skill", ""), gap.get("current", 0), gap.get("required", 0), gap.get("gap", 0)])

    ws2 = wb.create_sheet("TOP5岗位")
    ws2.append(["排名", "岗位名称", "公司", "匹配度"])
    for i, job in enumerate(diag.top5_jobs or [], 1):
        score = job.get("match_score", job.get("score", 0))
        ws2.append([i, job.get("title", ""), job.get("company", ""), f"{score * 100:.1f}%"])

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=profile_v{diag.version}_{student_id}.xlsx"}
    )


# 导出成长路径规划为 PDF
@router.get("/path/{student_id}")
async def export_path_pdf(
    student_id: int,
    diagnosis_id: str = Query(None),
    db: AsyncSession = Depends(get_db),
    identity: Identity = Depends(get_current_identity),
):
    verify_student_access(student_id, identity)
    if diagnosis_id:
        result = await db.execute(select(DiagORM).where(DiagORM.id == diagnosis_id, DiagORM.student_id == student_id))
    else:
        result = await db.execute(
            select(DiagORM).where(DiagORM.student_id == student_id).order_by(DiagORM.created_at.desc()).limit(1))
    diag = result.scalar_one_or_none()
    if not diag:
        return {"error": "No diagnosis found"}

    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib import colors
    from xml.sax.saxutils import escape as xmlEscape

    # ---------- 注册中文字体（TTF 优先，逐级降级）----------
    _FONT = _register_cn_font()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=20 * mm)
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle('Title_CN', parent=styles['Title'], fontName=_FONT, fontSize=18, spaceAfter=12)
    heading_style = ParagraphStyle('Heading_CN', parent=styles['Heading2'], fontName=_FONT, fontSize=14, spaceBefore=12, spaceAfter=8)
    body_style = ParagraphStyle('Body_CN', parent=styles['Normal'], fontName=_FONT, fontSize=10, leading=16)
    small_style = ParagraphStyle('Small_CN', parent=styles['Normal'], fontName=_FONT, fontSize=9, leading=14, textColor=colors.grey)

    elements = []
    elements.append(Paragraph(xmlEscape("职达 · 成长路径规划报告"), title_style))
    created = diag.created_at.strftime("%Y-%m-%d %H:%M") if diag.created_at else "未知"
    elements.append(Paragraph(xmlEscape(f"诊断版本: V{diag.version} | 生成时间: {created}"), small_style))
    elements.append(Spacer(1, 8 * mm))

    # ---------- 能力概览 ----------
    dim_labels = {
        "tech": "技术技能", "tech_skills": "技术技能",
        "project": "项目经验", "project_exp": "项目经验",
        "academic": "学业基础", "academic_foundation": "学业基础",
        "domain": "领域知识", "domain_knowledge": "领域知识",
        "soft": "软技能", "soft_evidence": "软技能证据",
        "soft_skill_evidence": "软技能证据", "soft_skills": "软技能",
    }
    dim_scores = diag.dimension_scores or {}
    if dim_scores:
        elements.append(Paragraph(xmlEscape("能力概览"), heading_style))
        table_data = [[xmlEscape("维度"), xmlEscape("评分")]]
        for k, v in dim_scores.items():
            label = dim_labels.get(k, k)
            if isinstance(v, (int, float)):
                # dimension_scores 存储 0-1 小数，转换为百分制显示
                score_val = v * 100 if v <= 1.0 else v
                score_str = f"{score_val:.0f}"
            else:
                score_str = str(v)
            table_data.append([xmlEscape(label), xmlEscape(score_str)])
        match_pct = diag.match_score * 100 if isinstance(diag.match_score, (int, float)) and diag.match_score <= 1.0 else (diag.match_score or 0)
        table_data.append([xmlEscape("综合匹配度"), xmlEscape(f"{match_pct:.0f}%")])
        t = Table(table_data, colWidths=[120, 80])
        t.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (-1, -1), _FONT),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f0f0f2')),
            ('ALIGN', (1, 0), (1, -1), 'CENTER'),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e0e0e0')),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(t)
        elements.append(Spacer(1, 8 * mm))

    # ---------- 成长路径 ----------
    growth_path = diag.growth_path or {}
    phases = growth_path.get("phases", []) if isinstance(growth_path, dict) else []
    if phases:
        elements.append(Paragraph(xmlEscape("成长路径"), heading_style))
        for i, phase in enumerate(phases):
            goal = phase.get('goal', '能力提升')
            weeks = phase.get('weeks', 4)
            elements.append(Paragraph(
                xmlEscape(f"阶段 {i + 1}: {goal} ({weeks} 周)"), body_style))
            elements.append(Spacer(1, 2 * mm))
            for j, task in enumerate(phase.get("tasks", [])):
                name = xmlEscape(task.get('name', '学习任务'))
                desc = xmlEscape(task.get('description', ''))
                criteria = xmlEscape(task.get('criteria', '完成练习'))
                task_text = f"<b>{xmlEscape('任务')} {j + 1}: {name}</b><br/>"
                if desc:
                    task_text += f"{xmlEscape('描述')}: {desc}<br/>"
                resources = task.get("resources", [])
                if resources:
                    res_str = xmlEscape(', '.join(str(r) for r in resources))
                    task_text += f"{xmlEscape('资源')}: {res_str}<br/>"
                task_text += f"{xmlEscape('达标标准')}: {criteria}"
                elements.append(Paragraph(task_text, body_style))
                elements.append(Spacer(1, 3 * mm))
            elements.append(Spacer(1, 5 * mm))
    else:
        elements.append(Paragraph(xmlEscape("成长路径"), heading_style))
        elements.append(Paragraph(
            xmlEscape("当前诊断尚未生成成长路径数据，请完成诊断后重新导出。"), body_style))
        elements.append(Spacer(1, 5 * mm))

    # ---------- 职业发展建议 ----------
    if diag.career_advice:
        elements.append(Paragraph(xmlEscape("职业发展建议"), heading_style))
        elements.append(Paragraph(xmlEscape(diag.career_advice), body_style))

    doc.build(elements)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=growth_path_v{diag.version}_{student_id}.pdf"}
    )


# ---------- 字体注册辅助函数 ----------
_CN_FONT_NAME = None


def _register_cn_font() -> str:
    """注册中文字体并返回字体名称。优先 TTF，降级到 CID，最终 Helvetica。"""
    global _CN_FONT_NAME
    if _CN_FONT_NAME:
        return _CN_FONT_NAME

    from reportlab.pdfbase import pdfmetrics
    from pathlib import Path

    # 候选 TTF 路径列表（项目内嵌 → 系统路径）
    _base = Path(__file__).resolve().parent.parent.parent  # backend/
    candidates = [
        _base / "fonts" / "NotoSansSC-Regular.ttf",
        _base / "fonts" / "NotoSansCJKsc-Regular.ttf",
        _base / "data" / "fonts" / "NotoSansSC-Regular.ttf",
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
    ]

    for path in candidates:
        if path.exists():
            try:
                from reportlab.pdfbase.ttfonts import TTFont
                name = 'ZhidaCN'
                pdfmetrics.registerFont(TTFont(name, str(path)))
                _CN_FONT_NAME = name
                return name
            except Exception:
                continue

    # 降级：CID 字体
    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        name = 'STSong-Light'
        pdfmetrics.registerFont(UnicodeCIDFont(name))
        _CN_FONT_NAME = name
        return name
    except Exception:
        pass

    _CN_FONT_NAME = 'Helvetica'
    return 'Helvetica'
