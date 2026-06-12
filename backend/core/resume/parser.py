# 简历解析编排器 —— 串联 提取→归一化→分段→规则→LLM→合并 全流程
# 借鉴 pyresparser 的 Pipeline 设计：每阶段独立，合并时规则优先
import logging
from core.resume.extractor import extract_text as _extract_file_text
from core.resume.normalizer import normalize
from core.resume.rules import extract_all as rules_extract
from core.resume.llm import extract as llm_extract

logger = logging.getLogger("zhi-da.resume.parser")


def _verify_against_source(result: dict, source_text: str) -> dict:
    """后置验证：关键字段必须在原文中出现，否则清空，防止 LLM 编造或混淆简历。"""
    if not source_text:
        return result

    def appears_in_source(value: str, min_len: int = 2) -> bool:
        if not value or len(value) < min_len:
            return True
        if value in source_text:
            return True
        if len(value) >= 2:
            if all(ch in source_text for ch in value if ch.strip()):
                return True
        return False

    name = result.get("name", "")
    if name and not appears_in_source(name, min_len=2):
        logger.warning("后置验证：姓名 '%s' 未在原文中出现，已清空", name)
        result["name"] = ""
        ps = result.get("profile_sections", {})
        if ps.get("basic_info", {}).get("name"):
            ps["basic_info"]["name"] = ""

    school = result.get("profile_sections", {}).get("education", {}).get("school") or ""
    if school and not appears_in_source(school, min_len=3):
        logger.warning("后置验证：学校 '%s' 未在原文中出现，已清空", school)
        ps = result.get("profile_sections", {})
        if ps.get("education", {}).get("school"):
            ps["education"]["school"] = ""
        if ps.get("basic_info", {}).get("school"):
            ps["basic_info"]["school"] = ""

    return result


# ─── 响应数据结构（兼容原 API 的 Pydantic model）───

DEFAULT_PROFILE = {
    "basic_info": {},
    "education": {},
    "job_intention": {"target_job": "", "expected_industry": "", "job_type": "", "available_date": ""},
    "internship_exp": [],
    "project_exp": [],
    "campus_exp": [],
    "awards": [],
    "skills": [],
    "publications": [],
    "self_evaluation": "",
}


def _build_response(rules: dict, llm: dict) -> dict:
    """将规则 + LLM 结果合并为标准响应 dict（每次调用创建全新 dict，杜绝数据泄漏）。"""

    # ── 规则提取的结构化字段（权威来源）──
    name = rules.get("name", "")
    grade = rules.get("grade", "")
    major = rules.get("major", "")
    school = rules.get("school", "")
    edu_level = rules.get("education_level", "")
    phone = rules.get("phone", "")
    email = rules.get("email", "")
    gpa = rules.get("gpa", "")
    target_job = rules.get("target_job", "")
    rule_projects = rules.get("projects", [])

    # ── LLM 语义字段 ──
    llm = llm or {}
    tech_skills = llm.get("tech_skills", {})
    soft_skills = llm.get("soft_skills", {})
    domain_knowledge = llm.get("domain_knowledge", {})
    summary = llm.get("summary", "")

    # LLM 项目兜底（规则优先）
    llm_projects = llm.get("project_exp", [])
    projects = rule_projects if rule_projects else llm_projects

    # LLM 求职意向兜底
    if not target_job:
        target_job = llm.get("target_job", "")

    # ── 组装响应 ──
    basic_info = {
        "name": name, "grade": grade, "school": school,
        "education_level": edu_level, "major": major,
        "phone": phone, "email": email,
    }
    education = {
        "school": school, "education_level": edu_level, "major": major,
        "rank_description": "", "english_level": "",
    }
    academic_foundation = {
        "gpa": gpa, "rank": "", "core_courses": [], "awards": [],
        "normalized_score": 0,
    }
    job_intention = {
        "target_job": target_job, "expected_industry": "",
        "job_type": "", "available_date": "",
    }

    profile_sections = {
        **DEFAULT_PROFILE,
        "basic_info": basic_info,
        "education": education,
        "job_intention": job_intention,
        "project_exp": projects,
        "internship_exp": llm.get("internship_exp", []),
        "campus_exp": llm.get("campus_exp", []),
        "awards": llm.get("awards", []),
        "skills": llm.get("skills", []),
    }

    return {
        "name": name,
        "grade": grade,
        "major": major,
        "target_job": target_job,
        "tech_skills": tech_skills,
        "soft_skills": soft_skills,
        "domain_knowledge": domain_knowledge,
        "project_exp": projects,
        "summary": summary,
        "academic_foundation": academic_foundation,
        "soft_skill_evidence": {
            "teamwork": {"level": "weak", "evidence": [], "normalized_score": 40},
            "communication": {"level": "weak", "evidence": [], "normalized_score": 40},
            "ownership": {"level": "weak", "evidence": [], "normalized_score": 40},
        },
        "profile_sections": profile_sections,
    }


async def parse_resume_text(text: str) -> dict:
    """解析纯文本简历，返回标准化 dict。

    流程：
    1. normalize  → 文本归一化
    2. rules      → 正则提取结构化字段（毫秒级）
    3. llm        → LLM 语义补充（技能/项目详情/总结）
    4. merge      → 合并输出（规则优先）
    """
    cleaned = normalize(text)
    if not cleaned:
        return _build_response({}, {})

    # 规则提取（同步，毫秒级）
    rules = rules_extract(cleaned)
    logger.info("规则提取: name=%s school=%s edu=%s major=%s job=%s projects=%d",
                rules.get("name"), rules.get("school"), rules.get("education_level"),
                rules.get("major"), rules.get("target_job"), len(rules.get("projects", [])))

    # LLM 语义提取（异步，秒级）
    llm = await llm_extract(cleaned)
    if llm:
        logger.info("LLM 补充: skills=%d projects=%d summary=%s",
                    len(llm.get("tech_skills", {})), len(llm.get("project_exp", [])),
                    llm.get("summary", "")[:40])

    result = _build_response(rules, llm)
    # 后置验证：关键字段必须在原文中出现
    result = _verify_against_source(result, cleaned)
    return result


async def parse_resume(file_content: bytes, filename: str) -> dict:
    """解析上传的简历文件（PDF/DOCX/TXT）。"""
    text = _extract_file_text(file_content, filename)
    if not text.strip():
        raise ValueError("未能从文件中提取到文字，可能为扫描版PDF，请粘贴文本内容")
    return await parse_resume_text(text)


async def extract_text_from_file(file_content: bytes, filename: str) -> str:
    """仅提取文本，不做解析（供 SSE 流式等高级场景使用）。"""
    return _extract_file_text(file_content, filename)
