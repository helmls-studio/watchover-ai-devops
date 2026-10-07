"""Drive the WatchOver view in headless Chromium and report what a person would see.

Reads one JSON job on stdin and prints one JSON result on stdout. It makes no
assertions itself: tests/browser.test.mjs decides pass or fail from the report.

Modes:
  observe  load each page (optionally at a fixed clock time) and report sections,
           badges and their computed styles, footer, errors, storage and requests;
           save a full-page screenshot per page when screenshot_dir is given
  refresh  load a page, then write new_state to the workspace and report whether
           the new text appears without a reload, and how long it took
  break    load a page, then write broken text to state.json and report the error
"""
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

OBSERVE_JS = """async () => {
  const text = (el) => (el ? el.innerText.trim() : null);
  const sections = [...document.querySelectorAll('section.question')].map((s) => ({ id: s.id, text: text(s) }));
  const badges = [...document.querySelectorAll('.badge[data-kind]')].map((b) => {
    const cs = getComputedStyle(b);
    return { kind: b.dataset.kind, problem: !!b.closest('.fact-problem'), text: text(b), background: cs.backgroundColor, color: cs.color, border: cs.borderStyle };
  });
  const footer = document.querySelector('footer');
  const facts = [...document.querySelectorAll('.facts > li')].map((f) => {
    const badge = f.querySelector('.badge');
    const flag = f.querySelector('.problem-indicator');
    return { label: text(f.querySelector('.fact-head strong')), value: text(f.querySelector('.fact-val')),
      kind: badge?.dataset.kind, problem: f.classList.contains('fact-problem'), indicator: text(flag),
      background: badge ? getComputedStyle(badge).backgroundColor : null,
      indicatorFont: flag ? parseFloat(getComputedStyle(flag).fontSize) : null,
      badgeFont: badge ? parseFloat(getComputedStyle(badge).fontSize) : null,
      text: text(f) };
  });
  const box = footer ? footer.getBoundingClientRect() : null;
  let idb = -1;
  try { idb = (await indexedDB.databases()).length; } catch (e) { idb = -1; }
  return {
    state: document.querySelector('main') ? document.querySelector('main').dataset.state : null,
    sections,
    badges,
    facts,
    footerText: text(footer),
    footerVisible: !!box && box.top >= 0 && box.bottom <= window.innerHeight,
    stateAge: text(document.querySelector('#state-age')),
    decisionCard: text(document.querySelector('#decision-card')),
    noRecentUpdate: !!document.querySelector('#no-recent-update'),
    errorText: text(document.querySelector('[role=alert]')),
    storage: { local: localStorage.length, session: sessionStorage.length, idb, cookie: document.cookie },
    progressBars: document.querySelectorAll('progress, [role=progressbar]').length,
  };
}"""


def open_page(browser, url, fixed_time):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    requests = []
    page.on("request", lambda r: requests.append(r.url))
    if fixed_time:
        page.clock.set_fixed_time(fixed_time)
    page.goto(url)
    page.wait_for_selector("main[data-state]", timeout=10000)
    return page, requests


def observe(browser, job):
    results = []
    for item in job["pages"]:
        page, requests = open_page(browser, item["url"], item.get("fixed_time"))
        report = page.evaluate(OBSERVE_JS)
        report["name"] = item["name"]
        report["requests"] = requests
        if job.get("screenshot_dir"):
            path = pathlib.Path(job["screenshot_dir"]) / f"{item['name']}.png"
            # Grow the viewport to the whole page so the sticky footer is drawn once, at
            # the end, instead of where the original viewport ended.
            height = page.evaluate("() => document.documentElement.scrollHeight")
            page.set_viewport_size({"width": 1280, "height": height})
            page.screenshot(path=str(path))
            report["screenshot"] = str(path)
        results.append(report)
        page.close()
    return {"pages": results}


def wait_for(page, predicate_js, bound_ms):
    start = time.monotonic()
    while (time.monotonic() - start) * 1000 < bound_ms:
        if page.evaluate(predicate_js):
            return True, round((time.monotonic() - start) * 1000)
        time.sleep(0.1)
    return False, bound_ms


def refresh(browser, job):
    page, requests = open_page(browser, job["url"], job.get("fixed_time"))
    page.evaluate("() => { window.__watchoverMarker = 'kept'; }")
    pathlib.Path(job["workspace"], "state.json").write_text(job["new_state"], encoding="utf-8")
    appeared, elapsed = wait_for(page, f"() => document.body.innerText.includes({json.dumps(job['token'])})", job["bound_ms"])
    return {
        "appeared": appeared,
        "elapsed_ms": elapsed,
        "marker": page.evaluate("() => window.__watchoverMarker || null"),
        "requests": requests,
    }


def break_state(browser, job):
    page, _ = open_page(browser, job["url"], job.get("fixed_time"))
    before = page.evaluate("() => document.querySelector('main').dataset.state")
    pathlib.Path(job["workspace"], "state.json").write_text(job["broken_text"], encoding="utf-8")
    shown, elapsed = wait_for(page, "() => !!document.querySelector('[role=alert]')", job["bound_ms"])
    return {
        "before": before,
        "shown": shown,
        "elapsed_ms": elapsed,
        "errorText": page.evaluate("() => { const a = document.querySelector('[role=alert]'); return a ? a.innerText : null; }"),
        "sectionsLeft": page.evaluate("() => document.querySelectorAll('section.question').length"),
    }


def main():
    job = json.loads(sys.stdin.read())
    modes = {"observe": observe, "refresh": refresh, "break": break_state}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            result = modes[job["mode"]](browser, job)
        finally:
            browser.close()
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # report, never hang silently
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)
