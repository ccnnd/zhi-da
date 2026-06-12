# LLM 客户端——OpenAI 兼容接口（当前 DeepSeek）
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator
from config.settings import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL


@dataclass
class LLMResponse:
    content: str = ""
    finish_reason: str = "stop"
    usage: dict = field(default_factory=dict)


@dataclass
class LLMChunk:
    content: str = ""
    finish_reason: str = ""


class LLMClient(ABC):
    @abstractmethod
    async def complete(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None) -> LLMResponse:
        ...

    @abstractmethod
    async def stream(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None) -> AsyncIterator[LLMChunk]:
        ...


class OpenAIClient(LLMClient):
    def __init__(self):
        from openai import AsyncOpenAI
        self._client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL, timeout=180.0)

    async def complete(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None) -> LLMResponse:
        kwargs = {"model": LLM_MODEL, "messages": messages, "temperature": 0.3, "timeout": 180.0}
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        if tools:
            kwargs["tools"] = tools
        response = await self._client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        return LLMResponse(
            content=choice.message.content or "",
            finish_reason=choice.finish_reason or "stop",
            usage={"prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                   "completion_tokens": response.usage.completion_tokens if response.usage else 0},
        )

    async def stream(self, messages: list[dict], tools: list[dict] = None, max_tokens: int = None) -> AsyncIterator[LLMChunk]:
        kwargs = {"model": LLM_MODEL, "messages": messages, "temperature": 0.3, "stream": True}
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        if tools:
            kwargs["tools"] = tools
        stream = await self._client.chat.completions.create(**kwargs)
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield LLMChunk(content=delta.content, finish_reason=chunk.choices[0].finish_reason or "")
            elif chunk.choices and chunk.choices[0].finish_reason:
                yield LLMChunk(content="", finish_reason=chunk.choices[0].finish_reason)


def get_llm_client() -> LLMClient:
    if not LLM_API_KEY:
        raise RuntimeError(
            "LLM_API_KEY 未设置，请在 backend/.env 中配置 DeepSeek API Key\n"
            "LLM_BASE_URL=https://api.deepseek.com\n"
            "LLM_MODEL=deepseek-chat"
        )
    return OpenAIClient()
