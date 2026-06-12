# LLM 语义提取：技能/项目详情/总结/实习/校园/奖项
# 借鉴 alibaba/SmartResume 的 LLM 结构化输出 + pyresparser 的字段 schema
import re
import json
import logging

logger = logging.getLogger("zhi-da.resume.llm")

# 精简提示词：只输出 JSON，不含规则已提取的字段（姓名/学校/学历等由规则负责）
_EXTRACT_PROMPT = """你是一个精确的简历解析器。你的任务是从下面提供的简历文本中提取结构化字段。

**核心原则：你只能使用本次提供的简历文本。请忘记之前看过的任何简历内容，不要使用任何外部知识或记忆。如果本次简历文本中某信息不存在，必须返回空值。**

## 输出格式（严格JSON，无markdown块，无解释）：
{
  "tech_skills": {"技能名": 0-100},
  "soft_skills": {"软技能名": 0-100},
  "domain_knowledge": {"领域名": 0-100},
  "project_exp": [{"name": "项目名", "role": "角色", "description": "简要描述", "duration": "起止时间"}],
  "internship_exp": [{"company_name": "", "position_name": "", "start_date": "", "end_date": "", "description": ""}],
  "campus_exp": [{"activity_name": "", "role": "", "start_date": "", "end_date": "", "description": ""}],
  "awards": [{"award_date": "", "award_name": "", "level": "国家级|省级|校级|院级"}],
  "skills": [{"name": "技能名", "level": "精通|熟练|良好|了解|入门"}],
  "summary": "一句话能力总结（20-80字）",
  "target_job": "求职意向/期望职位（2-20字，如简历中未明确写则从工作经历推断，确实没有就留空）"
}

## 提取规则：
1. **禁止编造（最重要）**：没有在本次简历文本中出现的字段，必须留空数组[]或空对象{}。绝不使用之前见过的简历中的信息
2. **仅本次文本**：只从下面提供的简历文本中提取信息，忽略任何记忆中的其他简历
3. **tech_skills**: 技术技能名 → 评分(0-100)。精通=90-100, 熟练=75-85, 掌握=60-70, 了解=40-55
4. **domain_knowledge**: 从技术栈推断领域，如 Spring→后端开发, React→前端开发, PyTorch→深度学习
5. **project_exp**: 提取所有明确命名的项目（项目一/二/三或带标题的项目），含项目名、角色、简要描述、起止时间
6. **internship_exp / campus_exp / awards / skills**: 只提取有明确证据的，否则 []
7. **summary**: 用一句话概括候选人的核心技术方向与能力层级
8. **target_job**: 优先从"求职意向"/"期望职位"行提取；没有则从最近一份工作职位推断
9. **自检**：提取完成后，确认每个非空字段的信息确实出现在本次简历文本中。如果信息在文本中找不到原文依据，设为空
"""


def _extract_json(text: str) -> dict:
    """从 LLM 返回中提取 JSON 对象（兼容 markdown 代码块包裹）。"""
    text = text.strip()
    # 去除零宽字符
    text = re.sub(r"[​‌‍‎‏﻿]", "", text)
    # 去除 markdown 代码块包裹
    m = re.search(r"```(?:json|js)?\s*\n?([\s\S]*?)\n?```", text)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 提取首个 JSON 对象
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    raise ValueError(f"无法提取JSON，前200字: {text[:200]}")


def _clean_llm_output(data: dict) -> dict:
    """清洗 LLM 输出为安全的结构。"""
    result: dict = {}

    # 技能类字典字段
    for field in ("tech_skills", "soft_skills", "domain_knowledge"):
        val = data.get(field, {})
        if isinstance(val, dict):
            result[field] = {}
            for k, v in val.items():
                try:
                    score = int(v)
                except (TypeError, ValueError):
                    continue
                result[field][str(k)] = max(0, min(100, score))
        else:
            result[field] = {}

    # 列表类字段
    for field in ("project_exp", "internship_exp", "campus_exp", "awards", "skills"):
        val = data.get(field, [])
        result[field] = val if isinstance(val, list) else []

    # 文本字段
    result["summary"] = str(data.get("summary", "")).strip()
    result["target_job"] = str(data.get("target_job", "")).strip()[:40]

    return result


async def extract(text: str) -> dict:
    """调用 LLM 提取语义字段。失败返回空结构。"""
    from config.settings import LLM_API_KEY
    from core.harness.llm import get_llm_client

    if not LLM_API_KEY or not LLM_API_KEY.strip():
        return {}

    llm = get_llm_client()
    truncated = text[:6000]
    messages = [
        {"role": "system", "content": _EXTRACT_PROMPT},
        {"role": "user", "content": truncated},
    ]
    try:
        response = await llm.complete(messages, max_tokens=2000)
        data = _extract_json(response.content)
        return _clean_llm_output(data)
    except Exception as e:
        logger.warning("LLM 提取语义字段失败: %s", e)
        return {}
