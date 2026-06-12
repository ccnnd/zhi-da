# 文本提取：PDF / DOCX / TXT → 纯文本
# 借鉴 pdfminer.six + PyPDF2 双引擎策略（alibaba/SmartResume 同款方案）
import io
import logging

logger = logging.getLogger("zhi-da.resume.extractor")


def extract_pdf_text(content: bytes) -> str:
    """从 PDF 提取文本。pdfminer 优先（布局感知），PyPDF2 兜底。"""
    # 引擎1: pdfminer.six — 支持 LAParams 布局分析，中文兼容性好
    try:
        from pdfminer.high_level import extract_text
        from pdfminer.layout import LAParams

        laparams = LAParams(
            line_overlap=0.5,
            char_margin=2.0,
            line_margin=0.5,
            word_margin=0.1,
            boxes_flow=0.5,
            detect_vertical=True,
            all_texts=True,
        )
        text = extract_text(io.BytesIO(content), laparams=laparams)
        if text.strip():
            logger.info("pdfminer 提取 %d 字符", len(text))
            return text
    except ImportError:
        logger.debug("pdfminer 未安装，回退 PyPDF2")
    except Exception as e:
        logger.warning("pdfminer 提取失败: %s，回退 PyPDF2", e)

    # 引擎2: PyPDF2 — 轻量兜底
    try:
        from PyPDF2 import PdfReader

        reader = PdfReader(io.BytesIO(content))
        texts = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                texts.append(t)
        text = "\n".join(texts)
        logger.info("PyPDF2 提取 %d 字符", len(text))
        return text
    except ImportError:
        logger.warning("PyPDF2 未安装")
    except Exception as e:
        logger.error("PyPDF2 提取失败: %s", e)

    return ""


def extract_docx_text(content: bytes) -> str:
    """从 DOCX 提取文本。"""
    try:
        from docx import Document

        doc = Document(io.BytesIO(content))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        text = "\n".join(paragraphs)
        logger.info("DOCX 提取 %d 字符", len(text))
        return text
    except ImportError:
        logger.warning("python-docx 未安装")
    except Exception as e:
        logger.error("DOCX 提取失败: %s", e)
    return ""


def extract_text(file_content: bytes, filename: str) -> str:
    """根据文件类型提取文本。"""
    import os
    ext = os.path.splitext(filename)[1].lower()

    if ext == ".pdf":
        text = extract_pdf_text(file_content)
    elif ext == ".docx":
        text = extract_docx_text(file_content)
    else:
        # TXT 或其他文本格式
        text = file_content.decode("utf-8", errors="ignore")

    if not text.strip():
        return ""
    return text
