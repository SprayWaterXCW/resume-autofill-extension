"""Safety checks for the actual Browser Use tool registry and local actions."""

import asyncio
import json
import unittest
from types import SimpleNamespace

from browser_use.llm.messages import SystemMessage
from browser_use.llm.exceptions import ModelProviderError
from pydantic import BaseModel

from .deepseek_json import ChatDeepSeekJsonObject
from .safe_tools import (
    ALLOWED_ACTIONS,
    DEMO_ORIGIN,
    DEMO_PROFILE,
    DEMO_URL,
    DemoActionAudit,
    assert_demo_url,
    assert_tool_allowlist,
    build_demo_tools,
    validate_add_button,
)


class FakePage:
    def __init__(self, url: str, value: str = ""):
        self.url = url
        self.value = value
        self.fill_calls = 0

    async def get_url(self):
        return self.url

    async def evaluate(self, _script, *_args):
        if "?.value" in _script:
            return self.value
        return json.dumps({
            "tag": "INPUT", "type": "text", "disabled": False,
            "readOnly": False, "value": self.value, "section": True,
        })

    async def get_elements_by_css_selector(self, _selector):
        return [self]

    async def fill(self, value):
        self.fill_calls += 1
        self.value = value


class FakeSession:
    cdp_client = None

    def __init__(self, page: FakePage, target_id: str = "selected-target"):
        self.page = page
        self.agent_focus_target_id = target_id

    async def must_get_current_page(self):
        return self.page


class SafeToolsTests(unittest.TestCase):
    def test_upstream_registry_has_no_generic_write_or_navigation_action(self):
        tools = build_demo_tools()
        assert_tool_allowlist(tools)
        self.assertEqual(set(tools.registry.registry.actions), ALLOWED_ACTIONS)
        for forbidden in ("click", "input", "navigate", "evaluate", "send_keys", "upload_file"):
            self.assertNotIn(forbidden, tools.registry.registry.actions)

    def test_only_exact_local_demo_url_is_accepted(self):
        assert_demo_url(DEMO_URL)
        for url in (
            DEMO_ORIGIN + "/",
            "https://127.0.0.1:4173/", "http://127.0.0.1:4174/",
            "http://localhost:4173/", "http://127.0.0.1:4173/other",
            "https://jobs.example/",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                assert_demo_url(url)

    def test_add_control_must_have_safe_semantics(self):
        safe = {"type": "button", "formAction": None, "disabled": False, "text": "添加教育经历"}
        validate_add_button(safe)
        for change in (
            {"type": "submit"}, {"formAction": "/apply"},
            {"disabled": True}, {"text": "添加并提交申请"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_add_button({**safe, **change})

    def test_fill_refuses_wrong_page_existing_value_and_path_mismatch(self):
        async def call(page, field_id="education-0-school", source_path="educations.0.school"):
            return await build_demo_tools().registry.execute_action(
                "fill_demo_field", {"field_id": field_id, "source_path": source_path},
                browser_session=FakeSession(page),
            )

        foreign = FakePage("https://jobs.example/")
        with self.assertRaisesRegex(RuntimeError, "restricted to the local demo"):
            asyncio.run(call(foreign))
        self.assertEqual(foreign.fill_calls, 0)

        occupied = FakePage(DEMO_URL, value="原有学校")
        result = asyncio.run(call(occupied))
        self.assertIn("Refusing to overwrite", result.error)
        self.assertEqual(occupied.fill_calls, 0)

        mismatched = FakePage(DEMO_URL)
        result = asyncio.run(call(mismatched, source_path="educations.1.school"))
        self.assertIn("do not match", result.error)
        self.assertEqual(mismatched.fill_calls, 0)

        already_correct = FakePage(DEMO_URL, value=DEMO_PROFILE["educations.0.school"])
        result = asyncio.run(call(already_correct))
        self.assertIn("already matches", result.extracted_content)
        self.assertEqual(already_correct.fill_calls, 0)

    def test_audit_records_only_verified_agent_writes(self):
        async def run():
            audit = DemoActionAudit()
            page = FakePage(DEMO_URL)
            result = await build_demo_tools(audit=audit).registry.execute_action(
                "fill_demo_field",
                {"field_id": "education-0-school", "source_path": "educations.0.school"},
                browser_session=FakeSession(page),
            )
            self.assertIsNone(result.error)
            self.assertEqual(page.value, DEMO_PROFILE["educations.0.school"])
            self.assertEqual(audit.written_paths, {"educations.0.school"})

            # Idempotent confirmation does not create another write.
            await build_demo_tools(audit=audit).registry.execute_action(
                "fill_demo_field",
                {"field_id": "education-0-school", "source_path": "educations.0.school"},
                browser_session=FakeSession(page),
            )
            self.assertEqual(page.fill_calls, 1)

        asyncio.run(run())

    def test_selected_target_must_stay_focused_before_writing(self):
        async def run():
            page = FakePage(DEMO_URL)
            tools = build_demo_tools(expected_target_id="selected-target")
            with self.assertRaisesRegex(RuntimeError, "selected tab"):
                await tools.registry.execute_action(
                    "fill_demo_field",
                    {"field_id": "education-0-school", "source_path": "educations.0.school"},
                    browser_session=FakeSession(page, target_id="other-target"),
                )
            self.assertEqual(page.fill_calls, 0)

        asyncio.run(run())


class DeepSeekAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_json_object_and_validates_schema(self):
        class Expected(BaseModel):
            action: str

        calls = []

        async def create(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"action":"done"}'), finish_reason="stop")],
                usage=None,
            )

        class FakeChat(ChatDeepSeekJsonObject):
            def get_client(self):
                return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

        model = FakeChat(model="deepseek-flash", api_key="fictional")
        result = await model.ainvoke([SystemMessage(content="Choose an action")], Expected)
        self.assertEqual(result.completion.action, "done")
        self.assertEqual(calls[0]["response_format"], {"type": "json_object"})
        self.assertIn("JSON object", calls[0]["messages"][0]["content"])
        self.assertIn("action", calls[0]["messages"][0]["content"])

    async def test_rejects_json_with_wrong_action_shape(self):
        class Expected(BaseModel):
            action: str

        async def create(**_kwargs):
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"unexpected":1}'), finish_reason="stop")],
                usage=None,
            )

        class FakeChat(ChatDeepSeekJsonObject):
            def get_client(self):
                return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

        with self.assertRaises(ModelProviderError):
            await FakeChat(model="deepseek-flash", api_key="fictional").ainvoke([], Expected)


if __name__ == "__main__":
    unittest.main()
