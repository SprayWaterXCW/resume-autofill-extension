"""Browser Use actions scoped to the project's fictional localhost demo."""

import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from browser_use import ActionResult, BrowserSession, Tools


DEMO_ORIGIN = "http://127.0.0.1:4173"
DEMO_URL = DEMO_ORIGIN + "/?runner=browser-use"
DEMO_PROFILE = {
    "educations.0.school": "星河示例大学",
    "educations.0.major": "信息科学",
    "educations.1.school": "松林示例学院",
    "educations.1.major": "应用数学",
}
READ_ONLY_ACTIONS = frozenset({"done", "wait", "find_elements", "dropdown_options"})
CUSTOM_ACTIONS = frozenset({"add_demo_education", "fill_demo_field"})
ALLOWED_ACTIONS = READ_ONLY_ACTIONS | CUSTOM_ACTIONS
FORBIDDEN_WORDS = re.compile(r"提交|投递|递交|报名|申请职位|submit|apply|send|publish", re.I)


@dataclass
class DemoActionAudit:
    added_cards: int = 0
    written_paths: set[str] = field(default_factory=set)


def assert_demo_url(url: str, origin: str = DEMO_ORIGIN) -> None:
    actual = urlsplit(url)
    expected = urlsplit(origin)
    if (actual.scheme, actual.hostname, actual.port, actual.path, actual.query) != (
        expected.scheme, expected.hostname, expected.port, "/", "runner=browser-use"
    ):
        raise ValueError("Action is restricted to the local demo page")


def validate_add_button(details: dict) -> None:
    if (
        details.get("type") != "button"
        or details.get("formAction")
        or details.get("disabled")
        or FORBIDDEN_WORDS.search(details.get("text") or "")
    ):
        raise ValueError("Add control has unsafe or ambiguous semantics")


def assert_tool_allowlist(tools: Tools) -> None:
    actual = set(tools.registry.registry.actions)
    if actual != ALLOWED_ACTIONS:
        raise RuntimeError(f"Unexpected Browser Use tool registry: {sorted(actual)}")


def build_demo_tools(
    origin: str = DEMO_ORIGIN,
    audit: DemoActionAudit | None = None,
    expected_target_id: str | None = None,
) -> Tools:
    """Remove every upstream default action except four read-only ones."""
    audit = audit or DemoActionAudit()
    tools = Tools()
    for name in list(tools.registry.registry.actions):
        if name not in READ_ONLY_ACTIONS:
            tools.exclude_action(name)

    @tools.action(description="Add exactly one education card on the fictional local demo page.")
    async def add_demo_education(browser_session: BrowserSession) -> ActionResult:
        if expected_target_id and browser_session.agent_focus_target_id != expected_target_id:
            raise ValueError("Agent focus left the selected tab")
        page = await browser_session.must_get_current_page()
        assert_demo_url(await page.get_url(), origin)
        details = json.loads(await page.evaluate("() => { const b = document.getElementById('add-education'); return b ? {type: b.type, formAction: b.getAttribute('formaction'), disabled: b.disabled, text: b.textContent.trim(), count: document.querySelectorAll('.education-entry').length} : null; }"))
        if not details:
            return ActionResult(error="Add control was not found")
        validate_add_button(details)
        before = details["count"]
        if before == 2:
            return ActionResult(extracted_content="Both education cards already exist")
        if before != 1:
            return ActionResult(error="Unexpected education card count on the local demo")
        buttons = await page.get_elements_by_css_selector("#add-education")
        if len(buttons) != 1:
            return ActionResult(error="Add control is ambiguous")
        await buttons[0].click()
        after = int(await page.evaluate("() => document.querySelectorAll('.education-entry').length"))
        if after != before + 1:
            return ActionResult(error="Card count did not increase after the action")
        audit.added_cards += 1
        return ActionResult(extracted_content="One education card was added and verified")

    @tools.action(description="Fill one observed education field from the fictional local profile; provide its DOM id and profile path, never a raw value.")
    async def fill_demo_field(field_id: str, source_path: str, browser_session: BrowserSession) -> ActionResult:
        if expected_target_id and browser_session.agent_focus_target_id != expected_target_id:
            raise ValueError("Agent focus left the selected tab")
        page = await browser_session.must_get_current_page()
        assert_demo_url(await page.get_url(), origin)
        expected_id = "education-" + source_path.removeprefix("educations.").replace(".", "-")
        if source_path not in DEMO_PROFILE or field_id != expected_id:
            return ActionResult(error="Field id and profile path do not match")
        state = json.loads(await page.evaluate("(id) => { const e = document.getElementById(id); return e ? {tag: e.tagName, type: e.type, disabled: e.disabled, readOnly: e.readOnly, value: e.value, section: !!e.closest('#education-entries')} : null; }", field_id))
        if not state or state["tag"] != "INPUT" or state["type"] != "text" or state["disabled"] or state["readOnly"] or not state["section"]:
            return ActionResult(error="Field is unavailable or not writable")
        value = DEMO_PROFILE[source_path]
        if state["value"] and state["value"] != value:
            return ActionResult(error="Refusing to overwrite an existing value")
        if state["value"] == value:
            return ActionResult(extracted_content="Field already matches the profile value")
        fields = await page.get_elements_by_css_selector(f"#{field_id}")
        if len(fields) != 1:
            return ActionResult(error="Field target is ambiguous")
        await fields[0].fill(value)
        readback = await page.evaluate("(id) => document.getElementById(id)?.value || ''", field_id)
        if readback != value:
            return ActionResult(error="The page did not retain the field value")
        audit.written_paths.add(source_path)
        return ActionResult(extracted_content="Field value was written and verified")

    assert_tool_allowlist(tools)
    return tools
