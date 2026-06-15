# SchemaValidator — JSON 提取与校验、能力评分钳位、匹配度钳位
import json
import re


class SchemaValidator:
    # 从 LLM 原始输出中提取首个完整 JSON 对象（括号配平，避免贪婪正则吞掉后续文本）
    @staticmethod
    def extract_json(text: str) -> str:
        start = text.find('{')
        if start == -1:
            return text
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escape:
                    escape = False
                elif ch == '\\':
                    escape = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        return text[start:i + 1]
        # 未配平，回退到原始文本
        return text

    # 将五维能力分值钳位到 0-100
    @staticmethod
    def validate_ability_scores(data: dict) -> dict:
        cleaned = {}
        for dim in ["tech_skills", "project_exp", "academic_foundation", "domain_knowledge", "soft_skill_evidence"]:
            if dim in data:
                val = data[dim]
                if isinstance(val, dict):
                    if "weight" in val and "sub_items" in val:
                        try:
                            w = float(val.get("weight", 0.2))
                        except (ValueError, TypeError):
                            w = 0.2
                        cleaned_dim = {
                            "weight": max(0.0, min(1.0, w)),
                            "sub_items": []
                        }
                        sub_items = val.get("sub_items", [])
                        if isinstance(sub_items, list):
                            for item in sub_items:
                                if isinstance(item, dict) and "name" in item:
                                    try:
                                        score_val = float(item.get("score", 50))
                                    except (ValueError, TypeError):
                                        score_val = 50.0
                                    cleaned_dim["sub_items"].append({
                                        "name": str(item["name"]),
                                        "score": max(0.0, min(100.0, score_val)),
                                        "level": str(item.get("level", "了解"))
                                    })
                        cleaned[dim] = cleaned_dim
                    else:
                        cleaned_dim = {}
                        for skill, score in val.items():
                            try:
                                score_val = float(score)
                                cleaned_dim[skill] = max(0.0, min(100.0, score_val))
                            except (ValueError, TypeError):
                                cleaned_dim[skill] = 50.0
                        cleaned[dim] = cleaned_dim
                else:
                    cleaned[dim] = val
        return cleaned

    # 将匹配度钳位到 0-1
    @staticmethod
    def validate_match_score(score: float) -> float:
        return max(0.0, min(1.0, float(score)))

    # 解析 LLM 输出为 JSON，失败时尝试正则提取
    @staticmethod
    def validate_json_output(text: str, schema: dict = None) -> tuple[dict | None, str | None]:
        try:
            data = json.loads(text)
            return data, None
        except json.JSONDecodeError:
            try:
                extracted = SchemaValidator.extract_json(text)
                data = json.loads(extracted)
                return data, None
            except json.JSONDecodeError as e:
                return None, str(e)
