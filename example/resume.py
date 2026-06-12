# 简历解析路由——文本解析 + 文件上传解析，调用 LLM 提取结构化信息
#
# 注意：这些端点是公开的（用于新学生创建档案前解析简历），
# 但会触发 LLM 调用，因此添加了简单的 IP 级限流保护。
# 生产环境建议使用 Redis 实现更可靠的分布式限流。
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from db.database import get_db
from core.harness.llm import get_llm_client
from config.settings import MAX_UPLOAD_SIZE_MB, ALLOWED_UPLOAD_TYPES
import json
import re
import os
import logging
import time

router = APIRouter(prefix="/api/resume", tags=["resume"])
logger = logging.getLogger("zhi-da.resume")

# 简单内存级限流：每个 IP 每分钟最多 3 次解析请求
_resume_rate_limit: dict[str, list[float]] = {}
_RESUME_RATE_LIMIT_MAX = 3
_RESUME_RATE_LIMIT_WINDOW = 60  # seconds

RESUME_OUTPUT_SCHEMA = """{
  "name": "<姓名>",
  "grade": "<大一~大四/研一~研三，无法判断则空字符串>",
  "major": "<专业>",
  "target_job": "<推断的岗位方向>",
  "summary": "<一句话能力总结>",
  "tech_skills": { "<技能名>": <0-100> },
  "soft_skills": { "<软技能名>": <0-100> },
  "domain_knowledge": { "<领域名>": <0-100> },
  "project_exp": [{ "name": "", "role": "", "description": "", "duration": "" }],
  "academic_foundation": {
    "gpa": "<有则填，无则空字符串，禁止猜测>",
    "rank": "<有则填，无则空字符串，禁止猜测>",
    "core_courses": [{ "name": "", "score": 0 }],
    "awards": [],
    "normalized_score": <0-100>
  },
  "soft_skill_evidence": {
    "teamwork": { "level": "<strong|medium|weak>", "evidence": [], "normalized_score": <0-100> },
    "communication": { "level": "<strong|medium|weak>", "evidence": [], "normalized_score": <0-100> },
    "ownership": { "level": "<strong|medium|weak>", "evidence": [], "normalized_score": <0-100> }
  },
  "profile_sections": {
    "basic_info": { "name": "", "grade": "", "school": "", "education_level": "<本科|硕士|博士|大专|空>", "major": "", "phone": "", "email": "" },
    "education": { "school": "", "education_level": "", "major": "", "rank_description": "<禁止猜测>", "english_level": "" },
    "job_intention": { "target_job": "", "expected_industry": "", "job_type": "<全职|实习|空>", "available_date": "" },
    "internship_exp": [{ "company_name": "", "position_name": "", "start_date": "", "end_date": "", "description": "" }],
    "project_exp": [{ "project_name": "", "project_role": "", "start_date": "", "end_date": "", "description": "" }],
    "campus_exp": [{ "activity_name": "", "role": "", "start_date": "", "end_date": "", "description": "" }],
    "awards": [{ "award_date": "", "award_name": "", "level": "<国家级|省级|校级|院级|空>", "description": "" }],
    "skills": [{ "name": "", "level": "<精通|熟练|良好|了解|入门>", "description": "" }],
    "publications": [{ "pub_type": "<论文|专利>", "name": "", "pub_date": "", "description": "" }],
    "self_evaluation": ""
  }
}"""

SYSTEM_PROMPT = f"""请严格按以下JSON Schema解析简历，只返回纯JSON，不要任何解释或代码块标记。

{RESUME_OUTPUT_SCHEMA}

## 核心规则
1. 简历中**没有明确写出**的信息（GPA、排名、电话、邮箱等），必须返回空字符串""，**绝对禁止猜测或编造**
2. 软技能 level：有明确协作/答辩/主导证据才能给 strong，无证据给 weak
3. tech_skills 评分标准：精通(90-100)/熟练(75-85)/掌握(60-70)/了解(40-55)，须有区分度
4. domain_knowledge 从技术栈推断：Spring→后端开发、React→前端开发、PyTorch→深度学习
5. 所有字段必须存在，无数据时返回空字符串""或空数组[]或空对象{{}}
6. profile_sections 中各子对象必须存在，skills 至少提取1项，包含简历中所有技能
7. project_exp 顶层和 profile_sections.project_exp 内容一致
8. **学校名称（school）：** 仔细搜索简历开头、页眉、教育经历栏中的"XX大学""XX学院""XX University"，即使文字被PDF提取打乱也要尽力识别
9. **学历（education_level）：** 从年级（大一~大四→本科，研一~研三→硕士）、学位标注（Bachelor/Master/PhD/学士/硕士/博士）、或毕业年份推断，无法确定时留空
10. **专业（major）：** 搜索"XX专业""XX工程""XX科学""Major in""Department of"等关键词"""


class ResumeParseRequest(BaseModel):
    resume_text: str


class ResumeParseResponse(BaseModel):
    name: str = ""
    grade: str = ""
    major: str = ""
    target_job: str = ""
    tech_skills: dict = {}
    soft_skills: dict = {}
    domain_knowledge: dict = {}
    project_exp: list = []
    summary: str = ""
    academic_foundation: dict = {}
    soft_skill_evidence: dict = {}
    profile_sections: dict = {}


def _extract_json(text: str) -> dict:
    text = text.strip()
    # 移除零宽字符（DeepSeek 等模型有时会产出）
    text = re.sub(r'[​‌‍‎‏﻿]', '', text)

    # 提取 markdown 代码块（支持各种变体）
    code_match = re.search(r'```(?:json|js)?\s*\n?([\s\S]*?)\n?```', text)
    if code_match:
        text = code_match.group(1).strip()

    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning("JSON直接解析失败: %s", e)

    # 正则提取 { ... } 再试
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        extracted = match.group(0)
        # 修复尾逗号
        extracted = re.sub(r',\s*([}\]])', r'\1', extracted)
        try:
            return json.loads(extracted)
        except json.JSONDecodeError as e:
            logger.warning("正则提取JSON后仍解析失败: %s", e)

    raise ValueError(f"无法从LLM返回中提取JSON，原始返回前200字：{text[:200]}")


def _validate_and_clean(data: dict) -> dict:
    result: dict = {}

    for field in ["name", "grade", "major", "target_job", "summary"]:
        val = data.get(field, "")
        result[field] = str(val).strip() if isinstance(val, str) else ""

    for field in ["tech_skills", "soft_skills", "domain_knowledge"]:
        val = data.get(field, {})
        if not isinstance(val, dict):
            val = {}
        cleaned = {}
        for k, v in val.items():
            if isinstance(v, (int, float)):
                cleaned[str(k)] = max(0, min(100, int(v)))
            elif isinstance(v, str) and v.isdigit():
                cleaned[str(k)] = max(0, min(100, int(v)))
        result[field] = cleaned

    projects = data.get("project_exp", [])
    if not isinstance(projects, list):
        projects = []
    cleaned_projects = []
    for p in projects:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name", "")).strip()
        if not name:
            continue
        cleaned_projects.append({
            "name": name,
            "role": str(p.get("role", "")).strip() or "开发工程师",
            "description": str(p.get("description", "")).strip() or name,
            "duration": str(p.get("duration", "")).strip(),
        })
    result["project_exp"] = cleaned_projects

    # academic_foundation
    academic = data.get("academic_foundation", {})
    if not isinstance(academic, dict):
        academic = {}
    courses = academic.get("core_courses", [])
    cleaned_courses = []
    if isinstance(courses, list):
        for c in courses:
            if isinstance(c, dict) and "name" in c:
                try:
                    score = float(c.get("score", 0))
                except (ValueError, TypeError):
                    score = 0.0
                cleaned_courses.append({
                    "name": str(c["name"]).strip(),
                    "score": score
                })
    awards = academic.get("awards", [])
    cleaned_awards = []
    if isinstance(awards, list):
        cleaned_awards = [str(a).strip() for a in awards if a]
    try:
        norm_score = int(academic.get("normalized_score", 0))
    except (ValueError, TypeError):
        norm_score = 0
    result["academic_foundation"] = {
        "gpa": str(academic.get("gpa", "")).strip(),
        "rank": str(academic.get("rank", "")).strip(),
        "core_courses": cleaned_courses,
        "awards": cleaned_awards,
        "normalized_score": max(0, min(100, norm_score))
    }

    # soft_skill_evidence
    soft_ev = data.get("soft_skill_evidence", {})
    if not isinstance(soft_ev, dict):
        soft_ev = {}
    cleaned_soft_ev = {}
    for skill in ["teamwork", "communication", "ownership"]:
        s_data = soft_ev.get(skill, {})
        if not isinstance(s_data, dict):
            s_data = {}
        level = str(s_data.get("level", "weak")).strip().lower()
        if level not in ["strong", "medium", "weak"]:
            level = "weak"
        evidence = s_data.get("evidence", [])
        cleaned_evidence = []
        if isinstance(evidence, list):
            cleaned_evidence = [str(e).strip() for e in evidence if e]
        try:
            norm_score = int(s_data.get("normalized_score", 40))
        except (ValueError, TypeError):
            norm_score = 40
        cleaned_soft_ev[skill] = {
            "level": level,
            "evidence": cleaned_evidence,
            "normalized_score": max(0, min(100, norm_score))
        }
    result["soft_skill_evidence"] = cleaned_soft_ev

    # profile_sections — 新模块化结构
    ps = data.get("profile_sections", {})
    if not isinstance(ps, dict):
        ps = {}

    # basic_info
    basic = ps.get("basic_info", {})
    if not isinstance(basic, dict):
        basic = {}
    cleaned_basic = {
        "name": str(basic.get("name", "")).strip(),
        "grade": str(basic.get("grade", "")).strip(),
        "school": str(basic.get("school", "")).strip(),
        "education_level": str(basic.get("education_level", "")).strip(),
        "major": str(basic.get("major", "")).strip(),
        "phone": str(basic.get("phone", "")).strip(),
        "email": str(basic.get("email", "")).strip(),
    }

    # education
    edu = ps.get("education", {})
    if not isinstance(edu, dict):
        edu = {}
    cleaned_edu = {
        "school": str(edu.get("school", "")).strip(),
        "education_level": str(edu.get("education_level", "")).strip(),
        "major": str(edu.get("major", "")).strip(),
        "rank_description": str(edu.get("rank_description", "")).strip(),
        "english_level": str(edu.get("english_level", "")).strip(),
    }

    # job_intention
    intent = ps.get("job_intention", {})
    if not isinstance(intent, dict):
        intent = {}
    cleaned_intent = {
        "target_job": str(intent.get("target_job", "")).strip(),
        "expected_industry": str(intent.get("expected_industry", "")).strip(),
        "job_type": str(intent.get("job_type", "")).strip(),
        "available_date": str(intent.get("available_date", "")).strip(),
    }

    # internship_exp
    internships = ps.get("internship_exp", [])
    if not isinstance(internships, list):
        internships = []
    cleaned_internships = []
    for item in internships:
        if not isinstance(item, dict):
            continue
        company = str(item.get("company_name", "")).strip()
        if not company:
            continue
        cleaned_internships.append({
            "company_name": company,
            "position_name": str(item.get("position_name", "")).strip(),
            "start_date": str(item.get("start_date", "")).strip(),
            "end_date": str(item.get("end_date", "")).strip(),
            "description": str(item.get("description", "")).strip(),
        })

    # project_exp (in profile_sections)
    ps_projects = ps.get("project_exp", [])
    if not isinstance(ps_projects, list):
        ps_projects = []
    cleaned_ps_projects = []
    for item in ps_projects:
        if not isinstance(item, dict):
            continue
        pname = str(item.get("project_name", "")).strip()
        if not pname:
            continue
        cleaned_ps_projects.append({
            "project_name": pname,
            "project_role": str(item.get("project_role", "")).strip(),
            "start_date": str(item.get("start_date", "")).strip(),
            "end_date": str(item.get("end_date", "")).strip(),
            "description": str(item.get("description", "")).strip(),
        })

    # campus_exp
    campus = ps.get("campus_exp", [])
    if not isinstance(campus, list):
        campus = []
    cleaned_campus = []
    for item in campus:
        if not isinstance(item, dict):
            continue
        aname = str(item.get("activity_name", "")).strip()
        if not aname:
            continue
        cleaned_campus.append({
            "activity_name": aname,
            "role": str(item.get("role", "")).strip(),
            "start_date": str(item.get("start_date", "")).strip(),
            "end_date": str(item.get("end_date", "")).strip(),
            "description": str(item.get("description", "")).strip(),
        })

    # awards
    awards_ps = ps.get("awards", [])
    if not isinstance(awards_ps, list):
        awards_ps = []
    cleaned_awards_ps = []
    for item in awards_ps:
        if not isinstance(item, dict):
            continue
        aname = str(item.get("award_name", "")).strip()
        if not aname:
            continue
        level = str(item.get("level", "")).strip()
        if level not in ["国家级", "省级", "校级", "院级", ""]:
            level = ""
        cleaned_awards_ps.append({
            "award_date": str(item.get("award_date", "")).strip(),
            "award_name": aname,
            "level": level,
            "description": str(item.get("description", "")).strip(),
        })

    # skills
    skills_ps = ps.get("skills", [])
    if not isinstance(skills_ps, list):
        skills_ps = []
    cleaned_skills = []
    valid_levels = {"精通", "熟练", "良好", "了解", "入门"}
    for item in skills_ps:
        if not isinstance(item, dict):
            continue
        sname = str(item.get("name", "")).strip()
        if not sname:
            continue
        slevel = str(item.get("level", "了解")).strip()
        if slevel not in valid_levels:
            slevel = "了解"
        cleaned_skills.append({
            "name": sname,
            "level": slevel,
            "description": str(item.get("description", "")).strip(),
        })

    # publications
    pubs = ps.get("publications", [])
    if not isinstance(pubs, list):
        pubs = []
    cleaned_pubs = []
    for item in pubs:
        if not isinstance(item, dict):
            continue
        pname = str(item.get("name", "")).strip()
        if not pname:
            continue
        ptype = str(item.get("pub_type", "")).strip()
        if ptype not in ["论文", "专利", ""]:
            ptype = ""
        cleaned_pubs.append({
            "pub_type": ptype,
            "name": pname,
            "pub_date": str(item.get("pub_date", "")).strip(),
            "description": str(item.get("description", "")).strip(),
        })

    # self_evaluation
    self_eval = str(ps.get("self_evaluation", "")).strip()

    result["profile_sections"] = {
        "basic_info": cleaned_basic,
        "education": cleaned_edu,
        "job_intention": cleaned_intent,
        "internship_exp": cleaned_internships,
        "project_exp": cleaned_ps_projects,
        "campus_exp": cleaned_campus,
        "awards": cleaned_awards_ps,
        "skills": cleaned_skills,
        "publications": cleaned_pubs,
        "self_evaluation": self_eval,
    }

    return result


async def parse_resume_with_llm(text: str) -> ResumeParseResponse:
    from config.settings import LLM_API_KEY
    if not LLM_API_KEY or not LLM_API_KEY.strip():
        raise HTTPException(503, "AI服务未就绪，请在后端配置 LLM_API_KEY 环境变量")
    llm = get_llm_client()
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"请解析以下简历：\n\n{text[:8000]}"},
    ]
    logger.info("开始LLM简历解析，文本长度=%d", len(text))
    response = await llm.complete(messages)
    logger.info("LLM原始返回(前200字): %s", response.content[:200])

    data = _extract_json(response.content)
    logger.info("JSON提取成功，字段: %s", list(data.keys()))

    cleaned = _validate_and_clean(data)
    logger.info("校验完成: name=%s skills=%d projects=%d job=%s",
                cleaned["name"], len(cleaned["tech_skills"]),
                len(cleaned["project_exp"]), cleaned["target_job"])

    return ResumeParseResponse(
        name=cleaned["name"],
        grade=cleaned["grade"],
        major=cleaned["major"],
        target_job=cleaned["target_job"],
        tech_skills=cleaned["tech_skills"],
        soft_skills=cleaned["soft_skills"],
        domain_knowledge=cleaned["domain_knowledge"],
        project_exp=cleaned["project_exp"],
        summary=cleaned["summary"],
        academic_foundation=cleaned["academic_foundation"],
        soft_skill_evidence=cleaned["soft_skill_evidence"],
        profile_sections=cleaned.get("profile_sections", {}),
    )


def _extract_pdf_text(content: bytes) -> str:
    try:
        from pdfminer.high_level import extract_text
        from pdfminer.layout import LAParams
        import io
        # LAParams 改善中文 PDF 的布局分析：增大行间距/字间距容忍度，更好地保留阅读顺序
        laparams = LAParams(
            line_overlap=0.5,
            char_margin=2.0,
            line_margin=0.5,
            word_margin=0.1,
            boxes_flow=0.5,
            detect_vertical=True,
            all_texts=True,  # 提取所有文字（含页眉页脚），避免遗漏学校等信息
        )
        return extract_text(io.BytesIO(content), laparams=laparams)
    except ImportError:
        pass
    try:
        from PyPDF2 import PdfReader
        import io
        reader = PdfReader(io.BytesIO(content))
        texts = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                texts.append(text)
        return "\n".join(texts)
    except Exception:
        return ""


def _extract_docx_text(content: bytes) -> str:
    try:
        from docx import Document
        import io
        doc = Document(io.BytesIO(content))
        return "\n".join([para.text for para in doc.paragraphs if para.text.strip()])
    except Exception:
        return ""


async def extract_text_from_file(file: UploadFile) -> str:
    content = await file.read()
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()

    if ext == ".pdf":
        text = _extract_pdf_text(content)
        logger.info("PDF提取: %d 字符", len(text))
        if not text.strip():
            logger.warning("PDF文本为空，可能为扫描版PDF")
        return text
    elif ext == ".docx":
        return _extract_docx_text(content)
    else:
        return content.decode("utf-8", errors="ignore")


def _check_resume_rate_limit(request: Request):
    """简单的 IP 级限流检查：每分钟最多 3 次解析请求。"""
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    # 清理过期记录
    if client_ip in _resume_rate_limit:
        _resume_rate_limit[client_ip] = [
            t for t in _resume_rate_limit[client_ip] if now - t < _RESUME_RATE_LIMIT_WINDOW
        ]
    else:
        _resume_rate_limit[client_ip] = []
    # 检查是否超限
    if len(_resume_rate_limit[client_ip]) >= _RESUME_RATE_LIMIT_MAX:
        raise HTTPException(
            429,
            f"解析请求过于频繁，请 {_RESUME_RATE_LIMIT_WINDOW} 秒后再试",
            headers={"Retry-After": str(_RESUME_RATE_LIMIT_WINDOW)},
        )
    _resume_rate_limit[client_ip].append(now)


@router.post("/parse", response_model=ResumeParseResponse)
async def parse_resume(
    req: ResumeParseRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    _check_resume_rate_limit(request)
    return await parse_resume_with_llm(req.resume_text)


@router.post("/upload", response_model=ResumeParseResponse)
async def upload_resume(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    _check_resume_rate_limit(request)
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_UPLOAD_TYPES:
        raise HTTPException(400, f"不支持的文件类型：{ext}，请上传 PDF/DOCX/TXT")
    if file.size and file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"文件过大（>{MAX_UPLOAD_SIZE_MB}MB）")

    text = await extract_text_from_file(file)
    if not text.strip():
        raise HTTPException(400, "未能从文件中提取到文字，可能为扫描版PDF，请粘贴文本内容")

    return await parse_resume_with_llm(text)
