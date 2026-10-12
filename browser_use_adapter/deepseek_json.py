"""Browser Use model adapter for DeepSeek's supported JSON object mode.

Browser Use's ChatOpenAI requests strict json_schema output. DeepSeek's chat
endpoint currently accepts json_object instead, so we retain Browser Use's
Pydantic validation while switching only the wire format.
"""

import json
from dataclasses import dataclass
from typing import Any, TypeVar

from browser_use import ChatOpenAI
from browser_use.llm.exceptions import ModelOutputTruncatedError, ModelProviderError
from browser_use.llm.messages import BaseMessage
from browser_use.llm.openai.serializer import OpenAIMessageSerializer
from browser_use.llm.schema import SchemaOptimizer
from browser_use.llm.views import ChatInvokeCompletion
from openai import APIConnectionError, APIStatusError, RateLimitError
from pydantic import BaseModel, ValidationError


T = TypeVar("T", bound=BaseModel)


@dataclass
class ChatDeepSeekJsonObject(ChatOpenAI):
    async def ainvoke(
        self, messages: list[BaseMessage], output_format: type[T] | None = None, **kwargs: Any
    ) -> ChatInvokeCompletion[T] | ChatInvokeCompletion[str]:
        if output_format is None:
            return await super().ainvoke(messages, output_format, **kwargs)

        schema = SchemaOptimizer.create_optimized_json_schema(output_format)
        serialized = OpenAIMessageSerializer.serialize_messages(messages)
        serialized.insert(0, {
            "role": "system",
            "content": (
                "Return exactly one JSON object conforming to this schema. "
                "Do not emit tool-call markup, markdown, or extra text.\n"
                + json.dumps(schema, ensure_ascii=False)
            ),
        })
        model_params: dict[str, Any] = {"response_format": {"type": "json_object"}}
        if self.temperature is not None:
            model_params["temperature"] = self.temperature
        if self.frequency_penalty is not None:
            model_params["frequency_penalty"] = self.frequency_penalty
        if self.max_completion_tokens is not None:
            model_params["max_completion_tokens"] = self.max_completion_tokens

        try:
            response = await self.get_client().chat.completions.create(
                model=self.model, messages=serialized, **model_params
            )
            if not response.choices:
                raise ModelProviderError(message="DeepSeek returned no choices", status_code=502, model=self.name)
            choice = response.choices[0]
            if choice.finish_reason == "length":
                raise ModelOutputTruncatedError(message="DeepSeek JSON output was truncated", model=self.name)
            content = choice.message.content
            if not content:
                raise ModelProviderError(message="DeepSeek returned empty JSON content", status_code=502, model=self.name)
            try:
                parsed = output_format.model_validate_json(content)
            except ValidationError as exc:
                proposed = []
                try:
                    for action in json.loads(content).get("action", []):
                        if isinstance(action, dict):
                            proposed.extend(str(name)[:50] for name in action)
                except (TypeError, ValueError, AttributeError):
                    pass
                first = exc.errors(include_url=False)[0]
                location = ".".join(map(str, first["loc"]))
                summary = f"Invalid Browser Use action shape at {location}: {first['msg']}"
                if proposed:
                    summary += f"; model proposed {', '.join(proposed[:3])}"
                raise ModelProviderError(message=summary, model=self.name) from exc
            return ChatInvokeCompletion(
                completion=parsed, usage=self._get_usage(response), stop_reason=choice.finish_reason
            )
        except (ModelProviderError, ModelOutputTruncatedError):
            raise
        except (APIConnectionError, APIStatusError, RateLimitError) as exc:
            raise ModelProviderError(message=str(exc), model=self.name) from exc
