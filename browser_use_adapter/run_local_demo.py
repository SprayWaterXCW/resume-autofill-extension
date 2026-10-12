"""Run the real Browser Use agent against the project's fictional local page."""

import argparse
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from dotenv import load_dotenv
from browser_use import Agent, Browser, ChatOpenAI
from browser_use.browser.events import NavigateToUrlEvent, SwitchTabEvent

from .deepseek_json import ChatDeepSeekJsonObject
from .safe_tools import (
    DEMO_PROFILE, DemoActionAudit,
    assert_demo_url, assert_tool_allowlist, build_demo_tools,
)


ROOT = Path(__file__).resolve().parents[1]
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
PROFILE_CATALOG = """Available profile paths (the tool fetches values locally):
- educations.0.school: 第一段教育经历的毕业院校
- educations.0.major: 第一段教育经历的专业
- educations.1.school: 第二段教育经历的毕业院校
- educations.1.major: 第二段教育经历的专业"""
SNAPSHOT_JS = """() => ({
  count: document.querySelectorAll('.education-entry').length,
  fields: Object.fromEntries(
    [...document.querySelectorAll('#education-entries input[data-key]')].map(e => [e.id, e.value])
  ),
  submitDisabled: document.querySelector('.submit-disabled')?.disabled === true,
  nodeDemoRuns: window.__resumeDemoNodeRunCount ?? -1
})"""


async def snapshot_demo_page(page) -> dict:
    """Check the DOM independently while the Browser Use session is still alive."""
    return json.loads(await page.evaluate(SNAPSHOT_JS))


def demo_origin() -> str:
    port = int(os.getenv("RESUME_AGENT_DEMO_PORT", "4173"))
    if not 1024 <= port <= 65535:
        raise ValueError("RESUME_AGENT_DEMO_PORT must be between 1024 and 65535")
    return f"http://127.0.0.1:{port}"


def check_demo_server(origin: str) -> None:
    try:
        with urlopen(origin, timeout=2) as response:
            if response.status != 200:
                raise RuntimeError("Local demo server did not return HTTP 200")
    except OSError as exc:
        raise RuntimeError("Start npm run demo:web before this command") from exc


def build_llm():
    load_dotenv(ROOT / ".env.local")
    api_key = os.getenv("RESUME_AGENT_API_KEY") or os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("Set RESUME_AGENT_API_KEY in .env.local")
    base_url = os.getenv("RESUME_AGENT_BASE_URL", "https://api.deepseek.com")
    model_adapter = ChatDeepSeekJsonObject if urlsplit(base_url).hostname == "api.deepseek.com" else ChatOpenAI
    return model_adapter(
        model=os.getenv("RESUME_AGENT_MODEL", "deepseek-flash"),
        base_url=base_url,
        api_key=api_key,
        temperature=0,
        frequency_penalty=0,
        reasoning_effort=None,
        timeout=float(os.getenv("RESUME_AGENT_TIMEOUT_MS", "120000")) / 1000,
        max_retries=1,
    )


async def run_demo_agent(
    browser: Browser,
    page,
    origin: str,
    expected_target_id: str | None = None,
    on_progress=None,
) -> dict:
    assert_demo_url(await page.get_url(), origin)
    latest_state = await snapshot_demo_page(page)
    if (
        latest_state["count"] != 1
        or any(latest_state["fields"].values())
        or latest_state["nodeDemoRuns"] != 0
    ):
        raise RuntimeError("The isolated Browser Use demo must start with one empty card and no Node demo run")

    audit = DemoActionAudit()
    tools = build_demo_tools(origin=origin, audit=audit, expected_target_id=expected_target_id)
    llm = build_llm()

    async def capture_after_step(_agent):
        nonlocal latest_state
        if expected_target_id and browser.agent_focus_target_id != expected_target_id:
            raise RuntimeError("Agent focus left the selected tab")
        assert_demo_url(await page.get_url(), origin)
        latest_state = await snapshot_demo_page(page)
        if on_progress:
            on_progress({
                "cardCount": latest_state["count"],
                "agentAddedCards": audit.added_cards,
                "agentWrittenFields": len(audit.written_paths),
                "nodeDemoRuns": latest_state["nodeDemoRuns"],
            })

    agent = Agent(
        task=(
            "Fill both education entries on this fictional local form. The page calls "
            "学校 '毕业学校' while the profile calls it '毕业院校'; match by meaning. "
            "Observe the current fields and add the second education card if needed. "
            "Use fill_demo_field with the DOM id and a matching profile path. "
            "Never submit an application. Stop when both cards and all four fields are verified.\n"
            + PROFILE_CATALOG
        ),
        llm=llm,
        browser=browser,
        tools=tools,
        use_vision=False,
        directly_open_url=False,
        max_actions_per_step=1,
        max_failures=2,
        final_response_after_failure=False,
        use_judge=False,
        calculate_cost=True,
    )
    assert_tool_allowlist(agent.tools)
    history = await agent.run(max_steps=12, on_step_end=capture_after_step)
    assert_tool_allowlist(agent.tools)
    if expected_target_id and browser.agent_focus_target_id != expected_target_id:
        raise RuntimeError("Agent focus left the selected tab")
    assert_demo_url(await page.get_url(), origin)
    state = await snapshot_demo_page(page)
    correct = sum(
        state["fields"].get("education-" + path.removeprefix("educations.").replace(".", "-")) == value
        for path, value in DEMO_PROFILE.items()
    )
    passed = (
        state["count"] == 2
        and correct == len(DEMO_PROFILE)
        and state["submitDisabled"]
        and state["nodeDemoRuns"] == 0
        and audit.added_cards == 1
        and audit.written_paths == set(DEMO_PROFILE)
    )
    return {
        "scope": "fictional localhost page",
        "passed": passed,
        "agentReportedDone": history.is_done(),
        "steps": len(history.history),
        "correctFields": correct,
        "expectedFields": len(DEMO_PROFILE),
        "cardCount": state["count"],
        "agentAddedCards": audit.added_cards,
        "agentWrittenFields": len(audit.written_paths),
        "nodeDemoRuns": state["nodeDemoRuns"],
        "submitControlDisabled": state["submitDisabled"],
    }


async def run_attached_demo(cdp_url: str, target_id: str, origin: str, on_progress=None) -> dict:
    """Run only in the tab chosen by the toolbar; never navigate on its behalf."""
    check_demo_server(origin)
    browser = Browser(
        cdp_url=cdp_url,
        allowed_domains=[origin],
        enable_default_extensions=False,
        keep_alive=True,
    )
    try:
        await browser.start()
        matches = [tab for tab in await browser.get_tabs() if tab.target_id == target_id]
        if len(matches) != 1:
            raise RuntimeError("The selected tab is no longer available")
        assert_demo_url(matches[0].url, origin)
        switch = browser.event_bus.dispatch(SwitchTabEvent(target_id=target_id))
        await switch
        await switch.event_result(raise_if_any=True, raise_if_none=False)
        if browser.agent_focus_target_id != target_id:
            raise RuntimeError("Could not focus the selected tab")
        page = await browser.must_get_current_page()
        return await run_demo_agent(
            browser, page, origin, expected_target_id=target_id, on_progress=on_progress
        )
    finally:
        await browser.stop()


async def main(*, headed: bool = False) -> int:
    load_dotenv(ROOT / ".env.local")
    origin = demo_origin()
    demo_url = origin + "/?runner=browser-use"
    if not CHROME.is_file():
        raise RuntimeError("Google Chrome was not found at the expected local path")
    check_demo_server(origin)
    browser = Browser(
        headless=not headed,
        executable_path=CHROME,
        user_data_dir=ROOT / ".browser-use-runtime" / "chrome-profile",
        allowed_domains=[origin],
        enable_default_extensions=False,
        keep_alive=False,
    )
    try:
        await browser.start()
        # The CLI runner owns this single fixed navigation. The LLM has no navigate action.
        navigation = browser.event_bus.dispatch(NavigateToUrlEvent(url=demo_url))
        await navigation
        await navigation.event_result(raise_if_any=True, raise_if_none=False)
        page = await browser.must_get_current_page()
        result = await run_demo_agent(browser, page, origin)
        print(json.dumps(result))
        return 0 if result["passed"] else 1
    finally:
        await browser.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the Browser Use agent only on the fictional local page")
    parser.add_argument("--headed", action="store_true", help="show the isolated Chrome window while the Agent runs")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(headed=args.headed)))
