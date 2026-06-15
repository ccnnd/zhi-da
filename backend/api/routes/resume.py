# 简历解析路由——文本解析 + 文件上传解析，调用 LLM 提取结构化信息
#
# 注意：这些端点是公开的（用于新学生创建档案前解析简历），
# 但会触发 LLM 调用，因此添加了简单的 IP 级限流保护。
# 生产环境建议使用 Redis 实现更可靠的分布式限流。
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Request
from fastapi.responses import StreamingResponse
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
import asyncio
import hashlib
from collections import OrderedDict

router = APIRouter(prefix="/api/resume", tags=["resume"])
logger = logging.getLogger("zhi-da.resume")

# 简单内存级限流：每个 IP 每分钟最多 3 次解析请求
_resume_rate_limit: dict[str, list[float]] = {}
_RESUME_RATE_LIMIT_MAX = 3
_RESUME_RATE_LIMIT_WINDOW = 60  # seconds

RESUME_OUTPUT_SCHEMA = """{
  "profile_sections": {
    "basic_info": { "name": "", "grade": "", "school": "", "education_level": "<本科|硕士|博士|专科|空>", "major": "", "phone": "", "email": "" },
    "education": { "school": "", "education_level": "", "major": "", "rank_description": "<禁止猜测>", "english_level": "" },
    "job_intention": { "target_job": "", "expected_industry": "", "job_type": "<全职|实习|空>", "available_date": "" },
    "internship_exp": [{ "company_name": "", "position_name": "", "start_date": "", "end_date": "", "description": "" }],
    "project_exp": [{ "project_name": "", "project_role": "", "start_date": "", "end_date": "", "description": "" }],
    "campus_exp": [{ "activity_name": "", "role": "", "start_date": "", "end_date": "", "description": "" }],
    "awards": [{ "award_date": "", "award_name": "", "level": "<国家级|省级|校级|院级|空>", "description": "" }],
    "skills": [{ "name": "", "level": "<精通|熟练|良好|了解|入门>", "description": "" }],
    "publications": [{ "pub_type": "<论文|专利>", "name": "", "pub_date": "", "description": "" }],
    "self_evaluation": "",
    "tech_skills": { "<技能名>": <0-100> },
    "domain_knowledge": { "<领域名>": <0-100> },
    "soft_skill_evidence": {
      "teamwork": { "level": "<strong|medium|weak>", "evidence": [], "normalized_score": <0-100> },
      "communication": { "level": "<strong|medium|weak>", "evidence": [], "normalized_score": <0-100> },
      "ownership": { "level": "<strong|medium|weak>", "evidence": [], "normalized_score": <0-100> }
    },
    "academic_foundation": {
      "gpa": "<有则填，无则空字符串，禁止猜测>",
      "rank": "<有则填，无则空字符串，禁止猜测>",
      "core_courses": [{ "name": "", "score": 0 }],
      "awards": [],
      "normalized_score": <0-100>
    },
    "summary": "<一句话能力总结>"
  }
}"""

SYSTEM_PROMPT = f"""你是一个精确的简历解析器。从提供的简历文本中提取结构化信息，严格按以下JSON Schema 输出，只返回纯JSON，不要任何解释或代码块标记。

{RESUME_OUTPUT_SCHEMA}

## 核心规则（必须遵守）
1. **禁止编造：** 简历中没有明确写出的信息（GPA、排名、电话、邮箱等），必须返回空字符串""，绝对禁止猜测。
2. **仅本次文本：** 只从本次提供的文本提取，忽略任何外部知识或记忆。
3. 软技能 level：有明确协作/答辩/主导证据给 strong，无证据给 weak。
4. tech_skills 评分：精通(90-100)/熟练(75-85)/掌握(60-70)/了解(40-55)，须有区分度；domain_knowledge 从技术栈推断（Spring→后端开发、React→前端开发、PyTorch→深度学习）。
5. skills 至少提取1项，包含简历中所有技能；project_exp 与 profile_sections.project_exp 保持一致。
6. 所有字段必须存在，无数据时返回空字符串""/空数组[]/空对象{{}}。
7. **学校名称（school）：** 仔细搜索简历开头、页眉、教育经历栏中的"XX大学""XX学院""XX University"。
8. **学历（education_level）：** 从年级（大一~大四→本科，研一~研三→硕士）、学位（Bachelor/Master/PhD/学士/硕士/博士）或毕业年份推断，无法确定留空。
9. **自检：** 提取完成后确认每个非空字段的信息确实出现在本次简历文本中，找不到原文依据的设为空。"""


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


# ============ 性能优化：正则预提取 ============

# 手机号 / 邮箱 / 学校 / 学历 关键词
_PHONE_RE = re.compile(r'1[3-9]\d{9}')
_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
_SCHOOL_RE = re.compile(r'([\u4e00-\u9fa5]{2,12}(?:大学|学院|研究院)|[A-Za-z][A-Za-z\s]{2,30}University)')
_GRADE_KEYWORDS = {
    "大一": "大一", "大二": "大二", "大三": "大三", "大四": "大四",
    "研一": "研一", "研二": "研二", "研三": "研三",
    "博一": "博一", "博二": "博二", "博三": "博三",
}
_EDU_KEYWORDS = {
    "博士": "博士", "硕士": "硕士", "本科": "本科", "专科": "专科",
    "PhD": "博士", "phd": "博士", "Master": "硕士", "master": "硕士",
    "Bachelor": "本科", "bachelor": "本科",
}


def _regex_pre_extract(text: str) -> dict:
    """用正则秒出确定性字段，作为 LLM 的"已知线索"，减少推理量和编造概率。"""
    if not text:
        return {}
    hints: dict = {}
    m = _PHONE_RE.search(text)
    if m:
        hints["phone"] = m.group(0)
    m = _EMAIL_RE.search(text)
    if m:
        hints["email"] = m.group(0)
    # 学校：取第一个匹配（通常简历开头即校名）
    m = _SCHOOL_RE.search(text[:1500])
    if m:
        hints["school"] = m.group(1).strip()
    # 年级
    for kw, val in _GRADE_KEYWORDS.items():
        if kw in text:
            hints["grade"] = val
            break
    # 学历
    for kw, val in _EDU_KEYWORDS.items():
        if kw in text:
            hints["education_level"] = val
            break
    # 姓名：简历前 5 个非空行中，首个 2-4 字纯中文行（启发式）
    # 排除年级关键词（大一~大四/研一~研三/博一~博三）和教育程度词，避免误判
    _exclude_name = set(list(_GRADE_KEYWORDS.keys()) + list(_EDU_KEYWORDS.keys()))
    head_lines = [ln.strip() for ln in text.splitlines() if ln.strip()][:5]
    for ln in head_lines:
        if 2 <= len(ln) <= 4 and re.fullmatch(r'[\u4e00-\u9fa5·]{2,4}', ln) and ln not in _exclude_name:
            hints["name"] = ln
            break
    return hints


def _build_hints_block(hints: dict) -> str:
    """把正则预提取结果拼成提示文本，注入 LLM prompt。"""
    if not hints:
        return ""
    lines = ["以下是已用规则提取的确定字段，请校验后填入对应位置（如与简历原文冲突，以原文为准）："]
    for k, v in hints.items():
        lines.append(f"- {k}: {v}")
    return "\n".join(lines)


# ============ 性能优化：结果缓存（LRU，TTL 30 分钟）============

class _ResumeCache:
    """进程内 LRU 缓存，避免同一份简历反复点解析时重复调 LLM。"""
    def __init__(self, max_size: int = 50, ttl: int = 1800):
        self._store: OrderedDict[str, tuple[float, dict]] = OrderedDict()
        self.max_size = max_size
        self.ttl = ttl

    @staticmethod
    def _key(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def get(self, text: str) -> dict | None:
        k = self._key(text)
        item = self._store.get(k)
        if not item:
            return None
        ts, data = item
        if time.time() - ts > self.ttl:
            self._store.pop(k, None)
            return None
        self._store.move_to_end(k)
        return data

    def set(self, text: str, data: dict) -> None:
        k = self._key(text)
        self._store[k] = (time.time(), data)
        self._store.move_to_end(k)
        while len(self._store) > self.max_size:
            self._store.popitem(last=False)


_resume_cache = _ResumeCache()


# ============ 扁平字段派生（从 profile_sections 反推旧结构，保持向后兼容）============

_LEVEL_TO_SCORE = {"精通": 95, "熟练": 80, "良好": 65, "了解": 50, "入门": 35}


def _derive_flat_from_sections(cleaned_ps: dict) -> dict:
    """从清洗后的 profile_sections 派生扁平字段（name/grade/major/target_job/
    tech_skills/soft_skills/domain_knowledge/project_exp/academic_foundation/
    soft_skill_evidence/summary），供 ResumeParseResponse 顶层字段使用。"""
    basic = cleaned_ps.get("basic_info", {}) or {}
    intent = cleaned_ps.get("job_intention", {}) or {}
    edu = cleaned_ps.get("education", {}) or {}
    skills = cleaned_ps.get("skills", []) or []

    # tech_skills / domain_knowledge
    tech_skills: dict = {}
    for s in skills:
        if not isinstance(s, dict):
            continue
        sname = str(s.get("name", "")).strip()
        if not sname:
            continue
        level = s.get("level", "了解")
        tech_skills[sname] = _LEVEL_TO_SCORE.get(level, 50)

    # project_exp（顶层）
    ps_projects = cleaned_ps.get("project_exp", []) or []
    project_exp = [{
        "name": p.get("project_name", ""),
        "role": p.get("project_role", "") or "开发工程师",
        "description": p.get("description", "") or p.get("project_name", ""),
        "duration": f"{p.get('start_date', '')}~{p.get('end_date', '')}".strip("~"),
    } for p in ps_projects if isinstance(p, dict) and p.get("project_name")]

    academic = cleaned_ps.get("academic_foundation", {}) or {}
    soft_skills_evidence = cleaned_ps.get("soft_skill_evidence", {}) or {}

    # soft_skills（旧结构：{name: score}）
    soft_skills = {
        k: v.get("normalized_score", 40) if isinstance(v, dict) else 40
        for k, v in soft_skills_evidence.items()
    }

    return {
        "name": basic.get("name", ""),
        "grade": basic.get("grade", ""),
        "major": basic.get("major", "") or edu.get("major", ""),
        "target_job": intent.get("target_job", ""),
        "tech_skills": tech_skills,
        "soft_skills": soft_skills,
        "domain_knowledge": cleaned_ps.get("domain_knowledge", {}) or {},
        "project_exp": project_exp,
        "summary": cleaned_ps.get("summary", ""),
        "academic_foundation": academic,
        "soft_skill_evidence": soft_skills_evidence,
    }


def _repair_json(text: str) -> str:
    """尝试修复 LLM 常见的 JSON 语法错误。"""
    s = text
    # 1. 修复尾逗号: ,} 或 ,]
    s = re.sub(r',(\s*[}\]])', r'\1', s)
    # 2. 修复对象值后缺少逗号: }" -> }," (如 {"a":{...} "b":...})
    s = re.sub(r'}(\s+)"', r'},\1"', s)
    # 3. 修复对象后缺少逗号: }{ -> },{ (数组中相邻对象)
    s = re.sub(r'}(\s+){', r'},\1{', s)
    # 4. 修复字符串值后缺少逗号: "value" "key" -> "value", "key"
    s = re.sub(r'("(?:[^"\\]|\\.)*")(\s+)"', r'\1,\2"', s)
    # 5. 修复数字/布尔后缺少逗号（后跟换行和新属性）
    s = re.sub(r'(\d)\s+\n(\s*")', r'\1,\n\2', s)
    # 6. 修复数组后缺少逗号: ]" -> ]," 或 ]{ -> ],{
    s = re.sub(r'](\s+)"', r'],\1"', s)
    s = re.sub(r'](\s+){', r'],\1{', s)
    return s


def _extract_json(text: str) -> dict:
    text = text.strip()
    # 移除零宽字符（DeepSeek 等模型有时会产出）
    text = re.sub(r'[\u200b\u200c\u200d\u200e\u200f\ufeff]', '', text)

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
    extracted = match.group(0) if match else text

    # 先尝试原始提取
    try:
        return json.loads(extracted)
    except json.JSONDecodeError:
        pass

    # 修复常见 JSON 语法错误后重试
    repaired = _repair_json(extracted)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError as e:
        logger.warning("修复JSON后仍解析失败: %s", e)
        # 调试：将问题 JSON 写入临时文件以便排查
        try:
            with open("/tmp/llm_bad_json.txt", "w", encoding="utf-8") as _f:
                _f.write(extracted)
            logger.warning("已将问题JSON写入 /tmp/llm_bad_json.txt (%d 字符)", len(extracted))
        except Exception:
            pass

    raise ValueError(f"无法从LLM返回中提取JSON，原始返回前200字：{text[:200]}")



def _validate_and_clean(data: dict) -> dict:
    """校验并清洗 LLM 输出。

    新版 schema 下，LLM 只输出 profile_sections（含 tech_skills/domain_knowledge/
    soft_skill_evidence/academic_foundation/summary 等嵌套字段）。
    本函数先清洗 profile_sections，再从其派生扁平字段（保持向后兼容）。
    同时兼容旧版直接输出扁平字段的情况。
    """
    # 兼容：若 LLM 仍输出顶层 profile_sections 包裹，则取它；否则把 data 视作 sections
    ps = data.get("profile_sections", data) if isinstance(data, dict) else {}
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

    # tech_skills / domain_knowledge（嵌套在 sections 内）
    def _clean_score_dict(raw):
        raw = raw if isinstance(raw, dict) else {}
        cleaned = {}
        for k, v in raw.items():
            if isinstance(v, (int, float)):
                cleaned[str(k)] = max(0, min(100, int(v)))
            elif isinstance(v, str) and v.isdigit():
                cleaned[str(k)] = max(0, min(100, int(v)))
        return cleaned

    cleaned_tech_skills = _clean_score_dict(ps.get("tech_skills", {}))
    cleaned_domain_knowledge = _clean_score_dict(ps.get("domain_knowledge", {}))

    # academic_foundation（嵌套在 sections 内）
    academic = ps.get("academic_foundation", {})
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
                cleaned_courses.append({"name": str(c["name"]).strip(), "score": score})
    academic_awards = academic.get("awards", [])
    cleaned_academic_awards = [str(a).strip() for a in academic_awards if a] if isinstance(academic_awards, list) else []
    try:
        norm_score = int(academic.get("normalized_score", 0))
    except (ValueError, TypeError):
        norm_score = 0
    cleaned_academic = {
        "gpa": str(academic.get("gpa", "")).strip(),
        "rank": str(academic.get("rank", "")).strip(),
        "core_courses": cleaned_courses,
        "awards": cleaned_academic_awards,
        "normalized_score": max(0, min(100, norm_score)),
    }

    # soft_skill_evidence（嵌套在 sections 内）
    soft_ev = ps.get("soft_skill_evidence", {})
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
        cleaned_evidence = [str(e).strip() for e in evidence if e] if isinstance(evidence, list) else []
        try:
            s_norm = int(s_data.get("normalized_score", 40))
        except (ValueError, TypeError):
            s_norm = 40
        cleaned_soft_ev[skill] = {
            "level": level,
            "evidence": cleaned_evidence,
            "normalized_score": max(0, min(100, s_norm)),
        }

    summary = str(ps.get("summary", "")).strip()

    cleaned_ps = {
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
        "tech_skills": cleaned_tech_skills,
        "domain_knowledge": cleaned_domain_knowledge,
        "academic_foundation": cleaned_academic,
        "soft_skill_evidence": cleaned_soft_ev,
        "summary": summary,
    }

    # 从 profile_sections 派生扁平字段（向后兼容）
    result = _derive_flat_from_sections(cleaned_ps)
    result["profile_sections"] = cleaned_ps
    return result


async def parse_resume_with_llm(
    text: str,
    on_progress=None,
) -> ResumeParseResponse:
    """解析简历文本为结构化数据。

    性能优化：
    - 结果缓存（同一份文本 30 分钟内命中直接返回）
    - 正则预提取确定性字段，作为 LLM 线索，减少推理量
    - LLM 参数：temperature=0.1（解析任务低温度）+ max_tokens=1500（限制冗长输出）
    - 文本截断 [:6000]（原 8000）
    - 支持 on_progress 回调用于 SSE 流式进度反馈
    """
    from config.settings import LLM_API_KEY
    if not LLM_API_KEY or not LLM_API_KEY.strip():
        raise HTTPException(503, "AI服务未就绪，请在后端配置 LLM_API_KEY 环境变量")

    # 1. 缓存命中直接返回
    cached = _resume_cache.get(text)
    if cached is not None:
        logger.info("简历解析命中缓存，跳过 LLM 调用")
        if on_progress:
            await on_progress("cache_hit", 1.0, "命中缓存，秒级返回")
        return ResumeParseResponse(**cached)

    if on_progress:
        await on_progress("analyzing", 0.2, "正在预提取关键字段...")

    # 2. 正则预提取（秒级确定性字段，作为 LLM 线索）
    hints = _regex_pre_extract(text)
    hints_block = _build_hints_block(hints)

    if on_progress:
        await on_progress("analyzing", 0.4, "AI 正在解析简历结构...")

    # 3. 调用 LLM（低温度 + max_tokens 限制）
    llm = get_llm_client()
    user_content = f"请解析以下简历：\n\n{text[:6000]}"
    if hints_block:
        user_content = f"{hints_block}\n\n{user_content}"
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
    logger.info("开始LLM简历解析，文本长度=%d, 线索=%s", len(text), list(hints.keys()))
    response = await llm.complete(messages, max_tokens=2500, temperature=0.1, response_format={"type": "json_object"})
    logger.info("LLM原始返回(前200字): %s", response.content[:200])

    if on_progress:
        await on_progress("analyzing", 0.8, "正在校验提取结果...")

    # 提取 JSON，失败时用 LLM 重试修复
    raw_content = response.content.strip() if response.content else ""
    data = None
    if raw_content:
        try:
            data = _extract_json(raw_content)
        except ValueError as exc:
            logger.warning("首次JSON提取失败，尝试LLM修复: %s", exc)
    else:
        logger.warning("LLM返回空内容，尝试重试...")

    # 若首次提取失败，用 LLM 重试
    if data is None:
        if on_progress:
            await on_progress("analyzing", 0.85, "AI 正在重新整理数据...")
        try:
            if raw_content:
                # JSON 语法错误：让 LLM 修复
                fix_messages = [
                    {"role": "system", "content": "你是JSON修复助手。用户将给你一段格式有误的JSON文本。请修复所有语法错误（缺少逗号、多余逗号、未闭合括号等），返回合法的JSON。只返回纯JSON，不要任何解释或代码块标记。"},
                    {"role": "user", "content": f"请修复以下JSON的语法错误并返回：\n{raw_content[:4000]}"},
                ]
            else:
                # 完全空响应：重新调用 LLM 解析简历
                fix_messages = messages  # 重新发送原始请求
            fix_response = await llm.complete(fix_messages, max_tokens=2500, temperature=0.0, response_format={"type": "json_object"})
            data = _extract_json(fix_response.content)
            logger.info("LLM重试修复JSON成功")
        except (ValueError, Exception) as exc2:
            logger.warning("LLM修复JSON仍失败: %s", exc2)
            # 调试：dump 原始和修复后的 JSON
            try:
                with open("/tmp/llm_raw_response.txt", "w", encoding="utf-8") as _f:
                    _f.write(raw_content)
                logger.warning("已将LLM原始响应写入 /tmp/llm_raw_response.txt (%d 字符)", len(raw_content))
            except Exception:
                pass
            raise HTTPException(422, "AI 返回的简历数据格式异常，请稍后重试或手动填写档案")
    logger.info("JSON提取成功，字段: %s", list(data.keys()))

    cleaned = _validate_and_clean(data)
    logger.info("校验完成: name=%s skills=%d projects=%d job=%s",
                cleaned["name"], len(cleaned["tech_skills"]),
                len(cleaned["project_exp"]), cleaned["target_job"])

    # 4. 后置验证：关键字段必须在原文中出现，否则清空（防止 LLM 编造/混淆简历）
    cleaned = _verify_against_source(cleaned, text)

    result_dict = {
        "name": cleaned["name"],
        "grade": cleaned["grade"],
        "major": cleaned["major"],
        "target_job": cleaned["target_job"],
        "tech_skills": cleaned["tech_skills"],
        "soft_skills": cleaned["soft_skills"],
        "domain_knowledge": cleaned["domain_knowledge"],
        "project_exp": cleaned["project_exp"],
        "summary": cleaned["summary"],
        "academic_foundation": cleaned["academic_foundation"],
        "soft_skill_evidence": cleaned["soft_skill_evidence"],
        "profile_sections": cleaned.get("profile_sections", {}),
    }

    # 5. 写入缓存
    _resume_cache.set(text, result_dict)

    if on_progress:
        await on_progress("done", 1.0, "解析完成")

    return ResumeParseResponse(**result_dict)


def _verify_against_source(cleaned: dict, source_text: str) -> dict:
    """后置验证：关键字段必须在原文中出现，否则清空，防止 LLM 编造或混淆简历。"""
    if not source_text:
        return cleaned

    def appears_in_source(value: str, min_len: int = 2) -> bool:
        """检查值是否在原文中出现（允许部分匹配，如原文'张三'，提取'张三'）"""
        if not value or len(value) < min_len:
            return True  # 空值或太短的不需要验证
        # 直接匹配
        if value in source_text:
            return True
        # 逐字匹配（中文姓名可能被空格/换行分隔）
        if len(value) >= 2:
            chars_in_source = all(ch in source_text for ch in value if ch.strip())
            if chars_in_source:
                return True
        return False

    # 验证姓名
    name = cleaned.get("name", "")
    if name and not appears_in_source(name, min_len=2):
        logger.warning("后置验证：姓名 '%s' 未在原文中出现，已清空", name)
        cleaned["name"] = ""
        if cleaned.get("profile_sections", {}).get("basic_info", {}).get("name"):
            cleaned["profile_sections"]["basic_info"]["name"] = ""

    # 验证学校
    school = cleaned.get("profile_sections", {}).get("education", {}).get("school") or ""
    if school and not appears_in_source(school, min_len=3):
        logger.warning("后置验证：学校 '%s' 未在原文中出现，已清空", school)
        cleaned["profile_sections"]["education"]["school"] = ""
        if cleaned.get("profile_sections", {}).get("basic_info", {}).get("school"):
            cleaned["profile_sections"]["basic_info"]["school"] = ""

    return cleaned


def _extract_pdf_text(content: bytes) -> str:
    """同步 PDF 文本提取（pdfminer 优先，PyPDF2 兜底）。

    性能优化：简化 LAParams——关闭 all_texts（页眉页脚对简历不关键但显著拖慢），
    保留 detect_vertical 以兼容中文竖排。该函数是同步阻塞调用，**调用方必须放到线程池**。
    """
    try:
        from pdfminer.high_level import extract_text
        from pdfminer.layout import LAParams
        import io
        # 简化布局参数：all_texts=False 大幅提速，detect_vertical 保留中文友好
        laparams = LAParams(
            line_overlap=0.5,
            char_margin=2.0,
            line_margin=0.5,
            word_margin=0.1,
            boxes_flow=0.5,
            detect_vertical=True,
            all_texts=False,
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
    """从上传文件提取文本。

    性能优化：PDF/DOCX 的同步提取调用（pdfminer/python-docx 都是阻塞库）
    通过 run_in_executor 放到线程池执行，避免阻塞 FastAPI 事件循环。
    """
    content = await file.read()
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    loop = asyncio.get_event_loop()

    if ext == ".pdf":
        text = await loop.run_in_executor(None, _extract_pdf_text, content)
        logger.info("PDF提取: %d 字符", len(text))
        if not text.strip():
            logger.warning("PDF文本为空，可能为扫描版PDF")
        return text
    elif ext == ".docx":
        return await loop.run_in_executor(None, _extract_docx_text, content)
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

    # 先一次性读取全部内容（避免 .size 属性与 .read() 交互导致 I/O closed file）
    try:
        content = await file.read()
    except Exception as exc:
        logger.warning("上传文件读取失败: %s", exc)
        raise HTTPException(400, "文件读取失败，请重新上传")
    finally:
        await file.close()

    # 用读取到的字节做大小检查
    if len(content) > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"文件过大（>{MAX_UPLOAD_SIZE_MB}MB）")

    # 从已读取的字节提取文本（走线程池避免阻塞事件循环）
    loop = asyncio.get_event_loop()
    if ext == ".pdf":
        text = await loop.run_in_executor(None, _extract_pdf_text, content)
    elif ext == ".docx":
        text = await loop.run_in_executor(None, _extract_docx_text, content)
    else:
        text = content.decode("utf-8", errors="ignore")

    if not text.strip():
        raise HTTPException(400, "未能从文件中提取到文字，可能为扫描版PDF，请粘贴文本内容")

    return await parse_resume_with_llm(text)


# ============ SSE 流式解析端点（性能优化：实时进度反馈）============

async def _extract_text_from_bytes(content: bytes, ext: str) -> str:
    """从原始字节提取文本（用于流式上传端点，文件已读为 bytes）。"""
    loop = asyncio.get_event_loop()
    if ext == ".pdf":
        return await loop.run_in_executor(None, _extract_pdf_text, content)
    elif ext == ".docx":
        return await loop.run_in_executor(None, _extract_docx_text, content)
    else:
        return content.decode("utf-8", errors="ignore")


@router.post("/parse-stream")
async def parse_resume_stream(
    req: ResumeParseRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """SSE 流式文本简历解析。事件格式：
    {"stage":"analyzing","progress":0.2,"message":"..."}
    {"stage":"result","result":{...ResumeParseResponse...}}
    {"stage":"error","message":"..."}
    """
    _check_resume_rate_limit(request)

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def on_progress(stage, progress, message):
            await queue.put(("progress", stage, progress, message))

        async def run_parse():
            try:
                result = await parse_resume_with_llm(req.resume_text, on_progress=on_progress)
                await queue.put(("done", result))
            except HTTPException as exc:
                await queue.put(("error", exc.detail))
            except Exception as exc:
                await queue.put(("error", str(exc)))

        task = asyncio.create_task(run_parse())
        while True:
            msg = await queue.get()
            if msg[0] == "done":
                yield f"data: {json.dumps({'stage':'result','result':msg[1].model_dump()}, ensure_ascii=False, default=str)}\n\n"
                break
            if msg[0] == "error":
                yield f"data: {json.dumps({'stage':'error','message':msg[1]}, ensure_ascii=False)}\n\n"
                break
            _, stage, progress, message = msg
            yield f"data: {json.dumps({'stage':stage,'progress':round(progress,2),'message':message}, ensure_ascii=False)}\n\n"
        await task

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/upload-stream")
async def upload_resume_stream(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """SSE 流式文件简历解析。比 parse-stream 多一个 extracting 提取阶段。"""
    _check_resume_rate_limit(request)
    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_UPLOAD_TYPES:
        raise HTTPException(400, f"不支持的文件类型：{ext}，请上传 PDF/DOCX/TXT")
    if file.size and file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"文件过大（>{MAX_UPLOAD_SIZE_MB}MB）")

    # 在 SSE 生成器启动前读取文件，避免文件已关闭导致 I/O 错误
    try:
        file_content = await file.read()
    except Exception as exc:
        logger.warning("上传文件读取失败: %s", exc)
        raise HTTPException(400, "文件读取失败，请重新上传")
    finally:
        await file.close()

    async def event_generator():
        # 1. 提取文本阶段
        yield f"data: {json.dumps({'stage':'extracting','progress':0.1,'message':'正在提取文件文本...'}, ensure_ascii=False)}\n\n"
        text = await _extract_text_from_bytes(file_content, ext)
        if not text.strip():
            yield f"data: {json.dumps({'stage':'error','message':'未能从文件中提取到文字，可能为扫描版PDF，请粘贴文本内容'}, ensure_ascii=False)}\n\n"
            return

        # 2. 解析阶段
        queue: asyncio.Queue = asyncio.Queue()

        async def on_progress(stage, progress, message):
            await queue.put(("progress", stage, progress, message))

        async def run_parse():
            try:
                result = await parse_resume_with_llm(text, on_progress=on_progress)
                await queue.put(("done", result))
            except HTTPException as exc:
                await queue.put(("error", exc.detail))
            except Exception as exc:
                await queue.put(("error", str(exc)))

        task = asyncio.create_task(run_parse())
        while True:
            msg = await queue.get()
            if msg[0] == "done":
                yield f"data: {json.dumps({'stage':'result','result':msg[1].model_dump()}, ensure_ascii=False, default=str)}\n\n"
                break
            if msg[0] == "error":
                yield f"data: {json.dumps({'stage':'error','message':msg[1]}, ensure_ascii=False)}\n\n"
                break
            _, stage, progress, message = msg
            yield f"data: {json.dumps({'stage':stage,'progress':round(progress,2),'message':message}, ensure_ascii=False)}\n\n"
        await task

    return StreamingResponse(event_generator(), media_type="text/event-stream")
