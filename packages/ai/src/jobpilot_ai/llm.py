"""OpenAI 兼容的 Chat Completions 客户端（requests，无额外依赖）。

上游技术错误翻成用户能照着做的话，原文只进日志；配置/上游问题分别抛
`AIValidationError` / `AIUpstreamError`，由调用方决定怎么呈现。

Attributes:
    _STATUS_HINTS: 状态码 → `(怎么了, 怎么办)`。
    _SNIPPET_HINTS: 状态码认不出来时，从上游原文里嗅一嗅更准的原因。
    HttpSender: 注入用的网络层签名，测试里替换成假的。
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Mapping, Sequence

import requests

from . import config as AI_CONFIG
from .errors import AIUpstreamError, AIValidationError

logger = logging.getLogger(__name__)

_STATUS_HINTS: dict[int, tuple[str, str]] = {
    400: ("对方没接受这次请求", "多半是模型名不对，回「AI 设置」重新拉一次模型列表再选。"),
    401: ("API Key 不对", "Key 可能复制漏了字符，或者已经被删掉。请重新复制一遍，注意别带上空格和换行。"),
    402: ("账户余额不足", "AI 服务那边没钱了，去充值后再试。"),
    403: ("这个 Key 没有调用权限", "账号可能还没实名认证，或者没开通这个模型。"),
    404: ("接口地址填错了", "检查「接口地址」这一栏，DeepSeek 要填 https://api.deepseek.com/v1。"),
    429: ("请求太频繁或超出额度", "等一两分钟再试。"),
}

_SNIPPET_HINTS: tuple[tuple[str, str], ...] = (
    ("insufficient balance", "账户余额不足，去 AI 服务那边充值后再试。"),
    ("invalid api key", "API Key 不对，请重新复制一次。"),
    ("authentication", "API Key 不对，请重新复制一次。"),
    ("model not exist", "模型名不对，「AI 设置」里重新拉一次模型列表再选。"),
    ("rate limit", "请求太频繁，等一两分钟再试。"),
)


def _upstream_reason(snippet: str) -> str:
    """从上游响应体里抠人话原因：OpenAI 风格 `error.message` > 裸 `message` > 纯文本截断。

    中转站（new-api / one-api 系）的报错最说真话——「无可用渠道」「令牌分组不含此模型」
    这类只有响应体里有，通用状态码文案给不出来。只透传**中文**原因：对着中文用户能
    自己判断怎么改；英文原文保持不露（界面红线：上游响应体原文不上屏）。
    """
    if not snippet:
        return ""
    text = snippet.strip()
    if not text or text.startswith("<"):
        return ""
    reason = ""
    try:
        data = json.loads(text)
    except ValueError:
        reason = text
    else:
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and err.get("message"):
                reason = str(err["message"])
            elif isinstance(err, str) and err:
                reason = err
            elif data.get("message"):
                reason = str(data["message"])
    if not reason or not any("\u4e00" <= ch <= "\u9fff" for ch in reason):
        return ""
    return reason[:120]


def _friendly_http_error(status: int, snippet: str) -> str:
    """上游回 4xx / 5xx 时给用户看的话；能拿到上游自己的原因就一并带上。"""
    low = (snippet or "").lower()
    for needle, text in _SNIPPET_HINTS:
        if needle in low:
            return text
    reason = _upstream_reason(snippet)
    hint = _STATUS_HINTS.get(status)
    if hint:
        out = f"{hint[0]}。{hint[1]}"
    elif 500 <= status < 600:
        out = f"AI 服务商那边出故障了（{status}），不是你的配置问题。过一会儿再试。"
    else:
        out = f"AI 接口没接受这次请求（返回 {status}）。换个模型，或过一会儿再试。"
    if reason:
        out += f"（上游说：{reason}）"
    return out


def _friendly_network_error(exc: BaseException) -> str:
    """连不上 / 超时 / TLS 失败——区分开，因为用户要做的事不一样。"""
    text = str(exc).lower()
    if "certificate" in text or "ssl" in text:
        return "和 AI 服务的加密连接没建立起来。换一条网络（比如手机热点）再试。"
    if "timed out" in text or "timeout" in text:
        return "连 AI 服务超时了。检查网络后重试；一直超时就换一个「接口地址」。"
    return "连不上 AI 服务。请先确认这台电脑能正常上网。"


HttpSender = Callable[..., Any]

_RATE_LIMIT_RETRIES = 4
_RATE_LIMIT_DELAYS = (3.0, 8.0, 15.0, 20.0)


@dataclass
class LLMConfig:
    """LLM 配置项。

    Attributes:
        api_key: API 密钥；空串 = 未配置。
        base_url: 上游兼容 OpenAI 的接口地址。
        model: 模型名。
        temperature: 采样温度，`normalize()` 拉齐到系统常量。
        max_tokens: 单次回答上限，同上。
        timeout: 请求超时（秒），同上。
    """

    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"
    model: str = ""
    temperature: float = AI_CONFIG.LLM_TEMPERATURE
    max_tokens: int = AI_CONFIG.LLM_MAX_TOKENS
    timeout: float = AI_CONFIG.LLM_TIMEOUT

    @property
    def configured(self) -> bool:
        """三项可配置字段是否都已填好。"""
        return bool(self.api_key and self.base_url and self.model)

    def normalize(self) -> "LLMConfig":
        """把采样参数拉回系统常量（历史配置里可能还留着旧值）。"""
        return LLMConfig(
            api_key=self.api_key,
            base_url=self.base_url,
            model=self.model,
            temperature=AI_CONFIG.LLM_TEMPERATURE,
            max_tokens=AI_CONFIG.LLM_MAX_TOKENS,
            timeout=AI_CONFIG.LLM_TIMEOUT,
        )

    def to_dict(self) -> dict[str, Any]:
        """归一化后转字典。"""
        return asdict(self.normalize())


@dataclass(frozen=True)
class ChatResult:
    """一次聊天的返回。

    Attributes:
        content: 模型回复正文。
        finish_reason: 上游的结束原因；可能为空。
    """

    content: str
    finish_reason: str | None = None


def _api_bases(base_url: str) -> list[str]:
    """接口地址候选：原样优先；结尾不是 v1/v2/… 时补一个 `/v1` 兜底（ccswitch 式）。

    很多中转站的 OpenAI 兼容入口挂在 `/v1` 下，只填根域名时第一个候选会撞到
    站点网页；按「原样 → 补 /v1」的顺序试，谁先返回标准格式用谁。
    """
    base = base_url.rstrip("/")
    bases = [base]
    if not re.search(r"/v\d+$", base):
        bases.append(base + "/v1")
    return bases


class LLMClient:
    """按配置调用 OpenAI 兼容接口的客户端。

    Args:
        config: LLM 配置（鸭子类型即可，读 `api_key/base_url/model/...`）。
        http: 网络层；默认 `requests`，测试可注入假实现。
    """

    def __init__(self, config: LLMConfig, *, http: HttpSender | None = None) -> None:
        """初始化。"""
        self.config = config
        self._http = http or requests
        # 试出真入口后记下来（同一实例的对话/拉模型共用），省得每次都两个候选挨个试。
        self._resolved_base: str | None = None
        # 撞过 429 之后，本实例的请求一律串行——上游「同时最多 1 个请求」这类限制
        # 只有串行才过得去；没撞过的实例保持并发。
        self._serial = False
        self._serial_lock = threading.Lock()

    def _post(self, url: str, headers: dict[str, str], body: dict[str, Any], timeout: float) -> Any:
        """发聊天请求；本实例撞过限流后所有请求串行，避免并发再撞 429。"""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if self._serial:
            with self._serial_lock:
                return self._http.post(url, headers=headers, data=data, timeout=timeout)
        return self._http.post(url, headers=headers, data=data, timeout=timeout)

    def chat(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float | None = None,
    ) -> str:
        """发起一轮对话，只回正文。"""
        return self.chat_with_metadata(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        ).content

    def chat_with_metadata(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float | None = None,
    ) -> ChatResult:
        """发起一轮对话，回正文与 `finish_reason`。

        接口地址按候选顺序试（原样 → 补 /v1）：撞到网页或 404 说明路径不对，
        换下一个候选；限流（429）按退避节奏重试同一地址，并在本实例内改串行。
        """
        cfg = self.config
        if not cfg.configured:
            raise AIValidationError("AI 还没配置好——API Key / 接口地址 / 模型，三样都要填。")

        bases = [self._resolved_base] if self._resolved_base else _api_bases(cfg.base_url)
        body = {
            "model": cfg.model,
            "messages": list(messages),
            "temperature": cfg.temperature if temperature is None else temperature,
            "max_tokens": cfg.max_tokens if max_tokens is None else max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {cfg.api_key}",
            "Content-Type": "application/json",
        }
        last_error: AIUpstreamError | None = None
        for i, base in enumerate(bases):
            url = base + "/chat/completions"
            attempt = 0
            while True:
                try:
                    resp = self._post(url, headers, body, timeout or cfg.timeout)
                except requests.RequestException as exc:
                    logger.warning("调用 AI 接口失败（%s）：%s", url, exc)
                    raise AIUpstreamError(_friendly_network_error(exc)) from exc

                status = int(getattr(resp, "status_code", 200) or 200)
                if status != 429 or attempt >= _RATE_LIMIT_RETRIES:
                    break
                self._serial = True
                delay = _RATE_LIMIT_DELAYS[min(attempt, len(_RATE_LIMIT_DELAYS) - 1)]
                logger.info("AI 接口限流（%s），%.0f 秒后重试（第 %d 次）", url, delay, attempt + 1)
                time.sleep(delay)
                attempt += 1

            if status >= 400:
                snippet = str(getattr(resp, "text", ""))[:300]
                logger.warning("AI 接口返回 %s：%s", status, snippet)
                error = AIUpstreamError(_friendly_http_error(status, snippet))
                if status == 404 and i + 1 < len(bases):
                    last_error = error
                    continue
                raise error
            try:
                payload = resp.json()
                choice = payload["choices"][0]
                content = choice["message"]["content"]
                finish_reason = choice.get("finish_reason")
            except (ValueError, KeyError, IndexError, TypeError) as exc:
                logger.warning("AI 响应解析失败：%s", exc)
                error = AIUpstreamError(
                    "AI 返回的内容看不懂——「接口地址」可能不是 OpenAI 兼容协议的，换个地址试试。"
                )
                if i + 1 < len(bases):
                    last_error = error
                    continue
                raise error from exc
            self._resolved_base = base
            return ChatResult(content=str(content or ""), finish_reason=finish_reason)
        raise last_error or AIUpstreamError("AI 接口调用失败，换个接口地址试试。")

    def test(self) -> dict[str, Any]:
        """发一条极短探活消息，回延迟与模型名。"""
        started = time.time()
        reply = self.chat(
            [{"role": "user", "content": "请只回复两个字：正常"}],
            max_tokens=16,
            timeout=30.0,
        )
        return {
            "ok": True,
            "latency_ms": int((time.time() - started) * 1000),
            "model": self.config.model,
            "message": reply.strip()[:80],
        }

    def list_models(self) -> list[str]:
        """打 `GET /models` 拉可用模型列表（OpenAI 兼容）。

        顺序按接口返回；重名去重，空 id 丢掉。接口地址按候选顺序试
        （原样 → 补 /v1）：撞到网页 / 404 就换下一个候选，两个都不行才报错。
        """
        cfg = self.config
        if not cfg.base_url:
            raise AIValidationError("先填「接口地址」再拉模型列表。")
        if not cfg.api_key:
            raise AIValidationError("先填「API Key」再拉模型列表。")

        bases = [self._resolved_base] if self._resolved_base else _api_bases(cfg.base_url)
        headers = {"Authorization": f"Bearer {cfg.api_key}"}
        last_error: AIUpstreamError | None = None
        for base in bases:
            url = base + "/models"
            try:
                resp = self._http.get(url, headers=headers, timeout=min(cfg.timeout, 30.0))
            except requests.RequestException as exc:
                logger.warning("拉取模型列表失败（%s）：%s", url, exc)
                last_error = AIUpstreamError(_friendly_network_error(exc))
                continue

            status = int(getattr(resp, "status_code", 200) or 200)
            if status >= 400:
                snippet = str(getattr(resp, "text", ""))[:300]
                logger.warning("模型列表接口返回 %s：%s", status, snippet)
                last_error = AIUpstreamError(_friendly_http_error(status, snippet))
                continue
            try:
                payload = resp.json()
            except ValueError as exc:
                logger.warning("模型列表不是 JSON：%s", exc)
                last_error = AIUpstreamError(
                    "这个接口地址没有返回标准格式的模型列表——「接口地址」可能填错了。"
                )
                continue

            raw = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(raw, list):
                last_error = AIUpstreamError(
                    "这个接口地址不像是 OpenAI 兼容的（模型列表格式对不上），换个地址试试。"
                )
                continue

            seen: set[str] = set()
            models: list[str] = []
            for item in raw:
                mid = item.get("id") if isinstance(item, dict) else item
                mid = str(mid or "").strip()
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                models.append(mid)
            if not models:
                last_error = AIUpstreamError(
                    "这个接口一个可用模型都没返回，检查 Key 和接口地址填对没有。"
                )
                continue
            self._resolved_base = base
            return models

        if last_error is not None and len(bases) > 1:
            # 两个候选都试过：补一句最常见的原因，别让人干瞪着报错猜。
            raise AIUpstreamError(
                f"{last_error}（很多中转站的接口入口挂在 /v1 下，原样和补 /v1 都试过了；"
                "也可以直接把「接口地址」写成 https://…/v1 再试）"
            )
        raise last_error or AIUpstreamError("拉取模型列表失败，检查「接口地址」填对没有。")


def extract_json(text: str) -> dict[str, Any] | None:
    """从 LLM 回复里抠出第一段 JSON 对象（容忍 ```json 围栏和闲话）。"""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidates.append(text[start : end + 1])
    for raw in candidates:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return None
