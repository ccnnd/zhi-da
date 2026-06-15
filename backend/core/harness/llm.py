# LLM 客户端——OpenAI 兼容接口（当前 DeepSeek）
# 优化：单例复用连接池、分级超时、瞬时错误指数退避重试、错误分类
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator
from config.settings import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

logger = logging.getLogger(__name__)


@dataclass
class LLMResponse:
    content: str = ""
    finish_reason: str = "stop"
    usage: dict = field(default_factory=dict)


@dataclass
class LLMChunk:
    content: str = ""
    finish_reason: str = ""


# ---- 错误分类 ----
class LLMError(Exception):
    """LLM 调用基础异常。"""


class LLMTransientError(LLMError):
    """瞬时错误（超时/限流/连接），可重试。"""


class LLMConfigError(LLMError):
    """配置/参数错误（鉴权/参数），不应重试。"""


class LLMClient(ABC):
    @abstractmethod
    async def complete(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None, temperature: float = 0.3, response_format: dict = None) -> LLMResponse:
        ...

    @abstractmethod
    async def stream(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None, temperature: float = 0.3) -> AsyncIterator[LLMChunk]:
        ...


def _classify_openai_error(exc: Exception) -> LLMError:
    """把 openai SDK 异常映射到 LLM 错误分类。"""
    name = type(exc).__name__
    # 瞬时错误：超时、限流、连接问题
    if any(k in name for k in ("Timeout", "RateLimit", "Connection", "APITimeout", "APIConnection")):
        return LLMTransientError(str(exc))
    # 配置错误：鉴权、参数
    if any(k in name for k in ("Authentication", "BadRequest", "PermissionDenied", "NotFound")):
        return LLMConfigError(str(exc))
    # 兜底视为瞬时（含未知错误，倾向于重试）
    return LLMTransientError(str(exc))


class OpenAIClient(LLMClient):
    def __init__(self):
        from openai import AsyncOpenAI
        # client 级兜底超时 90s（分级超时在每次调用时覆盖）
        self._client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL, timeout=90.0)
        # 简单熔断：连续失败计数
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0

    def _is_circuit_open(self) -> bool:
        import time
        return time.time() < self._circuit_open_until

    def _record_success(self):
        self._consecutive_failures = 0
        import time
        self._circuit_open_until = 0.0

    def _record_failure(self):
        import time
        self._consecutive_failures += 1
        # 连续 5 次失败 → 熔断 60 秒
        if self._consecutive_failures >= 5:
            self._circuit_open_until = time.time() + 60.0
            logger.warning("LLM 熔断触发：连续 %d 次失败，熔断 60 秒", self._consecutive_failures)

    async def complete(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None, temperature: float = 0.3, response_format: dict = None) -> LLMResponse:
        # 熔断检查
        if self._is_circuit_open():
            raise LLMTransientError("AI 服务暂时不可用（熔断中），请稍后重试")

        kwargs = {"model": LLM_MODEL, "messages": messages, "temperature": temperature}
        # 分级超时：短任务（max_tokens 小）用 45s，长任务用 90s
        kwargs["timeout"] = 45.0 if (max_tokens and max_tokens <= 500) else 90.0
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        if tools:
            kwargs["tools"] = tools
        if response_format:
            kwargs["response_format"] = response_format

        # 指数退避重试（仅对瞬时错误）
        max_retries = 2
        last_exc = None
        for attempt in range(max_retries + 1):
            try:
                response = await self._client.chat.completions.create(**kwargs)
                self._record_success()
                choice = response.choices[0]
                return LLMResponse(
                    content=choice.message.content or "",
                    finish_reason=choice.finish_reason or "stop",
                    usage={"prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                           "completion_tokens": response.usage.completion_tokens if response.usage else 0},
                )
            except Exception as exc:
                last_exc = exc
                classified = _classify_openai_error(exc)
                # 配置错误不重试，直接抛出
                if isinstance(classified, LLMConfigError):
                    self._record_failure()
                    raise classified from exc
                # 瞬时错误：重试
                if attempt < max_retries:
                    import asyncio
                    delay = 0.8 * (2 ** attempt)  # 0.8s, 1.6s
                    logger.info("LLM 调用失败(%s)，%.1fs 后重试 (attempt %d/%d)", classified.__class__.__name__, delay, attempt + 1, max_retries)
                    await asyncio.sleep(delay)
                else:
                    self._record_failure()
                    raise classified from exc
        # 理论不可达
        raise _classify_openai_error(last_exc) if last_exc else LLMError("unknown")

    async def stream(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None, temperature: float = 0.3) -> AsyncIterator[LLMChunk]:
        if self._is_circuit_open():
            raise LLMTransientError("AI 服务暂时不可用（熔断中），请稍后重试")

        kwargs = {"model": LLM_MODEL, "messages": messages, "temperature": temperature, "stream": True}
        kwargs["timeout"] = 45.0 if (max_tokens and max_tokens <= 500) else 90.0
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        if tools:
            kwargs["tools"] = tools
        try:
            stream = await self._client.chat.completions.create(**kwargs)
            self._record_success()
            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    yield LLMChunk(content=delta.content, finish_reason=chunk.choices[0].finish_reason or "")
                elif chunk.choices and chunk.choices[0].finish_reason:
                    yield LLMChunk(content="", finish_reason=chunk.choices[0].finish_reason)
        except Exception as exc:
            self._record_failure()
            raise _classify_openai_error(exc) from exc


# ---- 模块级单例 ----
_LLM_CLIENT: LLMClient | None = None


def get_llm_client() -> LLMClient:
    """获取 LLM 客户端单例（懒加载，复用连接池）。"""
    global _LLM_CLIENT
    if _LLM_CLIENT is None:
        if not LLM_API_KEY:
            raise RuntimeError(
                "LLM_API_KEY 未设置，请在 backend/.env 中配置 DeepSeek API Key\n"
                "LLM_BASE_URL=https://api.deepseek.com\n"
                "LLM_MODEL=deepseek-chat"
            )
        _LLM_CLIENT = OpenAIClient()
    return _LLM_CLIENT
