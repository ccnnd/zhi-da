# 简历解析模块 —— 借鉴 alibaba/SmartResume + pyresparser 的架构设计
# 分层：文本提取 → 归一化 → 节分段 → 规则提取 + LLM 语义补充 → 合并输出
from core.resume.parser import parse_resume, parse_resume_text, extract_text_from_file
