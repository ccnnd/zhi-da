# 规则引擎：正则提取结构化字段（姓名/学校/学历/专业/手机/邮箱/求职意向/项目）
# 借鉴 pyresparser 的逐字段提取器设计，每个字段一个独立函数
import re
import logging

logger = logging.getLogger("zhi-da.resume.rules")


# ═══════════════════════════════════════════
# 姓名
# ═══════════════════════════════════════════

_SKIP_NAME_WORDS = {
    "求职", "简历", "联系", "电话", "邮箱", "手机", "年龄", "性别", "民族",
    "技能", "项目", "教育", "工作", "经历", "经验", "实习", "证书", "个人",
    "优势", "自我", "评价", "背景", "意向", "学历", "专业", "语言", "奖项",
    "荣誉", "获奖", "版权", "声明", "保密", "PDF", "http", "www", "GitHub",
    "博客", "CSDN", "知乎", "简书", "掘金", "公众号", "微信", "QQ",
}


def extract_name(text: str) -> str:
    """从简历提取中文姓名（2-4字）。

    优先级：
    1. 头部独立成行的 2-4 字中文名（最常见）
    2. "姓名：XXX" 标签格式
    3. "XXX | 手机 | 邮箱" 管道分隔格式
    """
    # 策略1: 头部独立行（前12行）
    lines = [l.strip() for l in text.split("\n")[:12] if l.strip()]
    for line in lines:
        if len(line) > 28 or len(line) < 2:
            continue
        if any(kw in line for kw in _SKIP_NAME_WORDS):
            continue
        # 纯中文名 2-4 字
        m = re.match(r"^([一-鿿·]{2,4})\s*$", line)
        if m and not re.search(r"[的了是在不有和与或]", m.group(1)):
            return m.group(1)
        # 中文名 + 英文名/标签
        m = re.match(r"^([一-鿿·]{2,4})\s+[A-Za-z0-9(（|｜]", line)
        if m:
            return m.group(1)

    # 策略2: "姓名：XXX" 或 "姓名: XXX" 标签格式
    m = re.search(r"姓名[：:\s]+([一-鿿·]{2,4})\s*", text)
    if m:
        return m.group(1).strip()

    # 策略3: 管道分隔 "张三 | 手机 | 邮箱"
    m = re.search(r"^([一-鿿]{2,4})\s*[|｜]\s*(?:手机|电话|邮箱|\d)", text, re.MULTILINE)
    if m:
        return m.group(1)

    return ""


# ═══════════════════════════════════════════
# 手机 / 邮箱
# ═══════════════════════════════════════════

def extract_phone(text: str) -> str:
    """提取中国大陆手机号（1开头的11位数字）。"""
    m = re.search(r"1[3-9]\d[\d\- ]{8,12}", text)
    if not m:
        return ""
    raw = m.group(0)
    # 排除匿名化占位（连续 ≥5 个 x/X）
    if raw.lower().count("x") >= 5:
        return ""
    digits = re.sub(r"[^\d]", "", raw)
    return digits[:11] if len(digits) >= 11 else ""


def extract_email(text: str) -> str:
    """提取邮箱地址。"""
    m = re.search(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", text)
    if not m:
        return ""
    raw = m.group(0)
    if raw.lower().count("x") >= 3:
        return ""
    return raw


# ═══════════════════════════════════════════
# 学校
# ═══════════════════════════════════════════

def extract_school(text: str) -> str:
    """在教育相关区域提取学校名称。"""
    # 先定位教育区块
    edu_block = _find_block(text, [
        r"教育(?:背景|经历|情况|信息)?",
        r"EDUCATION",
        r"学历(?:背景|信息)?",
    ])
    search_text = edu_block if edu_block else text

    # 清除日期前缀干扰（如 "6月中国石油大学"）
    search_text = re.sub(r"\d{1,2}\s*月", " ", search_text)
    search_text = re.sub(r"\d{4}\s*年", " ", search_text)

    # 排除非学校的"大学"上下文
    search_text = re.sub(r"大学[^\n]{0,10}(?:英语|毕业|期间|学历|四年|同学|生活|聚会|生|城)", " ", search_text)

    patterns = [
        r"(?P<sch>[一-鿿]{2,12}大学\s*[（(][^）)]{1,12}[）)])",  # XX大学（XX校区）
        r"(?P<sch>[一-鿿]{2,12}大学)",                              # XX大学
        r"(?P<sch>[一-鿿]{3,12}学院)",                              # XX学院
        r"(?P<sch>[A-Z][a-zA-Z.\s]{3,30}\s+University)",                    # English University
        r"(?P<sch>University\s+of\s+[A-Z][a-zA-Z\s]{2,20})",                # University of English
    ]
    for pat in patterns:
        m = re.search(pat, search_text)
        if m:
            school = m.group("sch").strip()
            if _is_valid_school(school):
                return school

    # 全文中兜底
    search_text2 = re.sub(r"\d{1,2}\s*月", " ", text)
    for pat in patterns:
        m = re.search(pat, search_text2)
        if m:
            school = m.group("sch").strip()
            if _is_valid_school(school):
                return school
    return ""


# ═══════════════════════════════════════════
# 学历
# ═══════════════════════════════════════════

_EDU_LEVEL_MAP = [
    (r"博士|博士研究生|Ph\.?D\.?|博[一二三四五]", "博士"),
    (r"硕士|硕士研究生|Master(?!.*(?:论文|项目))|MBA|EMBA|研[一二三]|研究生", "硕士"),
    (r"本科|学士|Bachelor|B\.?S\.?|B\.?A\.?|大[一二三四五]|全日制本科|四年制本科", "本科"),
    (r"大专|专科|高职|高专", "大专"),
    (r"高中|中专|中技|职高", "高中"),
]


def extract_education_level(text: str) -> str:
    """提取最高学历（优先在教育区块搜索）。"""
    edu_block = _find_block(text, [
        r"教育(?:背景|经历|情况|信息)?",
        r"学历(?:背景|信息)?",
    ])
    search = edu_block if edu_block else text
    for pattern, level in _EDU_LEVEL_MAP:
        if re.search(pattern, search, re.IGNORECASE):
            return level
    for pattern, level in _EDU_LEVEL_MAP:
        if re.search(pattern, text, re.IGNORECASE):
            return level
    return ""


# ═══════════════════════════════════════════
# 专业
# ═══════════════════════════════════════════

def extract_major(text: str) -> str:
    """提取专业名称。"""
    school = extract_school(text)
    edu_block = _find_block(text, [
        r"教育(?:背景|经历|情况|信息)?",
        r"学历(?:背景|信息)?",
    ])
    search_texts = [edu_block] if edu_block else []
    search_texts.append(text)

    # 策略1: 在学校名附近查找专业
    if school:
        for src in search_texts:
            idx = src.find(school)
            if idx >= 0:
                context = src[idx:idx + 150]
                m = re.search(
                    r"(?:大学|学院|University)\s*(?:[（(][^）)]*[）)])?\s*(?:\d+\s*(?:院校|双一流|985|211))?\s*"
                    r"([一-鿿A-Za-z+·]{3,28})\s*(?:[（(]|本科|硕士|博士|大专|学士)",
                    context
                )
                if m:
                    return m.group(1).strip()

    # 策略2: 日期范围 + 学校 + 专业格式
    for src in search_texts:
        m = re.search(
            r"\d{4}\s*[年.]\s*\d{1,2}\s*[月]?\s*[-–—至到]\s*\d{4}\s*[年.]\s*\d{1,2}\s*[月]?\s*"
            r".{0,60}?"
            r"([一-鿿A-Za-z+·]{3,28})\s*[（(]\s*(?:本科|硕士|博士|学士|大专)",
            src
        )
        if m:
            return m.group(1).strip()

    # 策略3: 专业关键字（教育区块优先，避免全文中其他节误匹配）
    keyword_patterns = [
        r"专业[：:\s]*([一-鿿A-Za-z+·]{3,25}?)(?:专业|$|\n|，|,|、)",
        r"主修[：:\s]*([一-鿿A-Za-z+·]{3,25})",
        r"[|｜]([一-鿿A-Za-z+·]{3,25})[|｜](?:本科|硕士|博士|大专)",
    ]
    # 先只在教育区块搜索
    if edu_block:
        for p in keyword_patterns:
            m = re.search(p, edu_block)
            if m:
                return m.group(1).strip()
    # 教育区块无结果时再全局搜索
    for p in keyword_patterns:
        m = re.search(p, text)
        if m:
            return m.group(1).strip()
    return ""


# ═══════════════════════════════════════════
# 年级 / GPA
# ═══════════════════════════════════════════

def extract_grade(text: str) -> str:
    """提取年级。"""
    for p in [r"(20\d{2})\s*级", r"(大[一二三四五])", r"(研[一二三])", r"(博[一二三四五])"]:
        m = re.search(p, text)
        if m:
            return m.group(1)
    return ""


def extract_gpa(text: str) -> str:
    """提取 GPA 信息。"""
    for p in [
        r"GPA[：:\s]*(\d+\.?\d*)\s*[/／]\s*(\d+\.?\d*)",
        r"绩点[：:\s]*(\d+\.?\d*)\s*[/／]\s*(\d+\.?\d*)",
        r"GPA[：:\s]*(\d+\.?\d*)",
        r"绩点[：:\s]*(\d+\.?\d*)",
    ]:
        m = re.search(p, text, re.IGNORECASE)
        if m:
            return m.group(0).strip()
    return ""


# ═══════════════════════════════════════════
# 求职意向
# ═══════════════════════════════════════════

_JOB_INTENT_PATTERNS = [
    r"求职意向[：:>\s]*([^\n]{2,50})",
    r"(?:期望|意向|目标|应聘|申请)(?:职位|岗位|方向|工作)[：:\s]*([^\n]{2,50})",
]
# 截断词——防止溢出到下一节
_JOB_CUTOFF = re.compile(
    r"(?:项目[一二三四五六七八九十\d][：:\s])"
    r"|(?:项目(?:背景|经历|经验|描述))"
    r"|(?:个人[（(]?优势|技能|证书|语言|奖励|荣誉|教育|工作)"
    r"|(?:电[ 话]|邮箱|手机|年龄|出生|联系|QQ|微信|GitHub|博客)"
    r"|(?:工程师|程序员|设计师|分析师|经理|专员|主管|助理|实习生)\s*[|｜(（]"
    r"|[|｜](?:[A-Z\d]|[一-鿿]{2})"
    r"|\d{4}\s*[年.]\s*\d{1,2}"
)


def extract_job_intent(text: str) -> str:
    """提取求职意向/期望职位。"""
    for pat in _JOB_INTENT_PATTERNS:
        m = re.search(pat, text)
        if m:
            raw = m.group(1).strip().rstrip("。，,；;")
            cut = _JOB_CUTOFF.search(raw)
            if cut:
                raw = raw[:cut.start()]
            raw = raw.strip().rstrip("。，,；;/|\\- ")
            if 1 < len(raw) <= 50:
                return raw
    return ""


# ═══════════════════════════════════════════
# 项目经历（规则部分）
# ═══════════════════════════════════════════

_PROJ_MARKER = re.compile(r"(?:项目|Project)\s*[一二三四五六七八九十\d]{1,2}\s*[：:.\s]")


def extract_projects(text: str) -> list[dict]:
    """从文本中提取项目经历列表。"""
    projects: list[dict] = []

    # 找到编号项目标记
    markers = list(_PROJ_MARKER.finditer(text))
    if len(markers) >= 2:
        for i, m in enumerate(markers):
            start = m.end()
            end = markers[i + 1].start() if i + 1 < len(markers) else len(text)
            raw = text[start:end].strip()
            name = raw.split("\n")[0] if "\n" in raw else raw[:80]
            name = re.split(r"(?:项目背景|项目描述|技术栈[：:]|技术方案|项目成果)", name)[0]
            name = name.strip().rstrip("。，,；;").strip()
            name = re.sub(r"\s*[（(]项目[）)]\s*$", "", name)
            projects.append(_parse_project_detail(name, raw))
        return projects

    # 策略2: 名称 | 日期 格式
    for m in re.finditer(
        r"([^\n|｜]{5,50}?)\s*[|｜]\s*(\d{4}\.\d{1,2}\s*[-–—至到]\s*\d{4}\.\d{1,2})",
        text
    ):
        name = m.group(1).strip()
        duration = m.group(2).strip()
        context = text[m.end():m.end() + 600]
        projects.append(_parse_project_detail(name, context, duration))

    return projects


def _parse_project_detail(name: str, desc: str, duration: str = "") -> dict:
    """从项目描述块中提取背景/技术栈/成果。"""
    item = {"name": name, "description": "", "role": "", "duration": duration}

    rm = re.search(r"(?:角色|担任|负责)[：:\s]*([^\n]{2,30})", desc)
    if rm:
        item["role"] = rm.group(1).strip().rstrip("。，,；;")

    parts = []
    for label, key in [("项目背景", "背景"), ("项目描述", "背景"), ("技术栈", "技术栈"),
                        ("技术方案", "方案"), ("项目成果", "成果")]:
        m = re.search(rf"{label}[：:\s]*([^\n]{{10,300}})", desc)
        if m:
            parts.append(f"{key}：{m.group(1).strip()}")

    item["description"] = "；".join(parts) if parts else desc[:400].strip()
    return item


# ═══════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════

def _is_valid_school(school: str) -> bool:
    """排除匿名化占位和通用词汇。"""
    if school in ("工业大学", "科技大学", "理工大学", "师范学院", "医学院", "综合大学"):
        return False
    # 排除纯匿名化占位：x, X, *, ? 等
    stripped = re.sub(r"[xX*\?？\s]", "", school)
    if len(stripped) < 4:  # 去掉占位符后至少要 4 个有效汉字（如"××大学"不足4字）
        return False
    return True


def _find_block(text: str, headers: list[str]) -> str:
    """在文本中定位某个标题后的内容块。取最后一个匹配（避免前导误匹配）。"""
    best_start = -1
    for h in headers:
        for m in re.finditer(h, text, re.IGNORECASE):
            best_start = max(best_start, m.start())
    if best_start >= 0:
        return text[best_start:]
    return ""


def extract_all(text: str) -> dict:
    """运行所有规则提取器，返回结构化 dict。"""
    return {
        "name": extract_name(text),
        "phone": extract_phone(text),
        "email": extract_email(text),
        "school": extract_school(text),
        "education_level": extract_education_level(text),
        "major": extract_major(text),
        "grade": extract_grade(text),
        "gpa": extract_gpa(text),
        "target_job": extract_job_intent(text),
        "projects": extract_projects(text),
    }
