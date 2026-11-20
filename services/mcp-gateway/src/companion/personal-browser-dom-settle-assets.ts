/** Isolated-world, read-only DOM stabilization included in the Chrome service worker. */
export const PERSONAL_DOM_SETTLE_SOURCE = String.raw`
async function settlePersonalDom(tabId, signal) {
  throwIfAborted(signal, "dom-settle", false);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabIdFrom(tabId) },
    func: observePersonalDomQuiet,
    args: [70, 300, 3000],
  }).catch(() => []);
  throwIfAborted(signal, "dom-settle", false);
  return result?.result?.stable === true;
}

async function revalidatePersonalClickAfterAttach(chromeTabId, target, input, point, pixel, attached, signal) {
  if (!(attached || takeFreshPersonalDebugger(target))) return point;
  // Chrome's debugger infobar can move the viewport after initial hit-testing.
  await settlePersonalViewport(target, signal);
  throwIfAborted(signal, "click", false);
  const [check] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: pixel ? probePersonalPixelTarget : probeGuardedElement,
    args: pixel
      ? [input.x, input.y, input.guard.url]
      : [input.ref, input.guard, false, input.x ?? null, input.y ?? null],
  }).catch(() => []);
  const current = check?.result;
  if (!current || current.error || current.stale || current.outside || current.empty ||
      (pixel && point.width !== undefined &&
       (current.width !== point.width || current.height !== point.height ||
        (point.hitId !== undefined && current.hitId !== point.hitId)))) {
    throw coded("BROWSER_CONFIRMATION_INVALID",
      "The target or viewport changed after Chrome debugger attachment. No click was dispatched.");
  }
  return current;
}

function observePersonalDomQuiet(probeMs, quietMs, maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastMutation = start;
    let changed = false;
    let finished = false;
    let observer, interval, timeout;
    const done = (stable) => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      clearTimeout(timeout);
      observer?.disconnect();
      resolve({ stable, changed });
    };
    try {
      observer = new MutationObserver(() => {
        changed = true;
        lastMutation = Date.now();
      });
      observer.observe(document.documentElement || document, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
      interval = setInterval(() => {
        const now = Date.now();
        if (!changed && now - start >= probeMs) done(true);
        else if (changed && now - lastMutation >= quietMs) done(true);
      }, 35);
      timeout = setTimeout(() => done(false), maxMs);
    } catch {
      done(false);
    }
  });
}
`;
