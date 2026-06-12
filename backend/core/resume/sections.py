# 节分段：将简历文本按语义切分为命名节（借鉴 alibaba/SmartResume 的布局感知思路）
# 核心方法：检测节标题 → 确定边界 → 为每节分配类型标签
import re
from dataclasses import dataclass, field


@dataclass
class Section:
    """简历的一个语义节。"""
    type: str          # 节类型标签
    title: str         # 节标题原文
    content: str       # 节内容（扣除标题）
    start: int = 0     # 在原文中的起始位置


# ─── 节标题模式库 ───
# 格式: (类型标签, [匹配模式...])
SECTION_PATTERNS = [
    ("basic_info", [
        r"^(?:个人(?:信息|资料|简介)|基本(?:信息|资料))",
        r"^(?:姓名|性别|年龄|出生|民族|籍贯|政治面貌|联系方式?)",
    ]),
    ("job_intent", [
        r"^(?:求职|应聘|期望|意向|目标)(?:意向|职位|岗位|方向|工作|行业|城市|薪资|地点)",
        r"^(?:期望|意向)(?:城市|薪资|地点|工作)",
    ]),
    ("education", [
        r"^(?:教育|学历|学业)(?:背景|经历|情况|信息)?",
        r"^(?:EDUCATION|Education)",
        r"^🎓",
    ]),
    ("skills", [
        r"^(?:专业|技术|核心)?\s*技能",
        r"^(?:技术栈|技术能力|编程能力|开发能力)",
        r"^(?:SKILLS?|TECH\w*|Technical\s+Skills?)",
        r"^🛠",
    ]),
    ("project", [
        r"^(?:项目|核心项目|主要项目|相关项目)(?:经历|经验|展示|介绍|描述)?",
        r"^(?:PROJECT|Projects?)(?:\s+Experience)?",
        r"^📁",
    ]),
    ("work", [
        r"^(?:工作|职业|从业)(?:经历|经验|背景|履历)?",
        r"^(?:WORK|Work|Employment)(?:\s+(?:Experience|History))?",
        r"^(?:实习|Internship)(?:经历|经验)?",
        r"^💼",
    ]),
    ("internship", [
        r"^(?:实习)(?:经历|经验|背景|履历)?",
        r"^(?:INTERNSHIP|Internship)",
    ]),
    ("campus", [
        r"^(?:校园|社团|学生|课外|社会)(?:活动|经历|经验|实践|工作)?",
        r"^(?:CAMPUS|Extracurricular|Activities?)",
    ]),
    ("awards", [
        r"^(?:获奖|奖项|荣誉|奖励|证书)(?:情况|列表|信息)?",
        r"^(?:AWARDS?|Honors?|Certificates?)",
    ]),
    ("self_eval", [
        r"^(?:自我|个人)(?:评价|介绍|描述|总结|陈述|优势)",
        r"^(?:SELF.?EVAL|Self.?Assessment|Summary|Profile)",
    ]),
    ("language", [
        r"^(?:语言|外语|英语)(?:能力|水平|成绩)?",
        r"^(?:LANGUAGES?|English)",
    ]),
]

# 编译为 (type, compiled_regex) 对
_COMPILED_PATTERNS = [(typ, [re.compile(p, re.IGNORECASE) for p in pats])
                      for typ, pats in SECTION_PATTERNS]


def _guess_section_type(title: str) -> str:
    """根据节标题文本推测节类型。"""
    title_clean = title.strip().rstrip("：:。，,；;")
    for typ, patterns in _COMPILED_PATTERNS:
        for pat in patterns:
            if pat.search(title_clean):
                return typ
    return "other"


def segment(text: str) -> list[Section]:
    """将简历文本按节标题切分为有序节列表。

    算法：
    1. 按行扫描，检测节标题行（独立成行、短行、匹配关键词）
    2. 确定每个节的起止边界
    3. 未识别的前导内容归入 header（包含姓名/联系方式）
    4. 返回有序节列表
    """
    lines = text.split("\n")
    n = len(lines)

    # ─── 第一遍：标记候选节标题行 ───
    candidates: list[tuple[int, str, str]] = []  # (行号, 标题文本, 类型)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        # 节标题特征：≤25字、不含标点结尾（可选）、匹配模式
        if len(stripped) > 30:
            continue
        typ = _guess_section_type(stripped)
        if typ != "other":
            candidates.append((i, stripped, typ))

    if not candidates:
        # 无明确节标题 → 整篇作为单一节
        return [Section(type="full", title="", content=text, start=0)]

    # ─── 第二遍：确定节边界 ───
    sections: list[Section] = []
    # 第一个节标题之前的内容作为 header
    first_idx = candidates[0][0]
    if first_idx > 0:
        header_text = "\n".join(lines[:first_idx]).strip()
        if header_text:
            sections.append(Section(type="header", title="", content=header_text, start=0))

    for ci, (line_no, title, typ) in enumerate(candidates):
        start_line = line_no + 1  # 内容从标题下一行开始
        end_line = candidates[ci + 1][0] if ci + 1 < len(candidates) else n
        content_lines = lines[start_line:end_line]
        content = "\n".join(content_lines).strip()
        sections.append(Section(type=typ, title=title, content=content, start=line_no))

    return sections


def find_section(sections: list[Section], *types: str) -> Section | None:
    """查找第一个匹配类型的节。"""
    for s in sections:
        if s.type in types:
            return s
    return None


def get_section_text(text: str, sections: list[Section], *types: str) -> str:
    """获取某类型节的内容；未找到则返回空字符串。"""
    s = find_section(sections, *types)
    return s.content if s else ""


def get_full_text_for_type(text: str, sections: list[Section], *types: str) -> str:
    """获取某类型节的完整文本（含标题），用于上下文分析。"""
    s = find_section(sections, *types)
    if not s:
        return ""
    return f"{s.title}\n{s.content}"
