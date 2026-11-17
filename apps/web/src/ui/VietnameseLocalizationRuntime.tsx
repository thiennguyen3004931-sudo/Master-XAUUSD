import { useEffect, type ReactNode } from "react";

type Phase7CViHook = {
  translate?: (value: string) => string;
};

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

declare global {
  var __PHASE7C_VI_TEST__: Phase7CViHook | undefined;
}

const SKIP_SELECTOR = "script,style,code,pre,textarea,[data-no-vi-localize-self]";
const PRICE_BID_TOKEN = "\uE000PHASE7C_PRICE_BID\uE001";
const PRICE_ASK_TOKEN = "\uE000PHASE7C_PRICE_ASK\uE001";
const lastTextValue = new WeakMap<Node, string>();

function normalizePriceLabels(value: string) {
  return value
    .replace(/(?:Giá\s+){2,}Bid\b/gi, "Giá Bid")
    .replace(/(?:Giá\s+){2,}Ask\b/gi, "Giá Ask");
}

function translatePresentation(value: string) {
  const translate = globalThis.__PHASE7C_VI_TEST__?.translate;
  if (!value || typeof translate !== "function") return value;

  // The legacy dictionary maps Bid -> "Giá Bid" and Ask -> "Giá Ask".
  // Protect labels that are already translated so repeated MutationObserver
  // passes cannot grow them into "Giá Giá Giá ... Bid/Ask".
  const normalized = normalizePriceLabels(value);
  const protectedValue = normalized
    .replace(/Giá\s+Bid\b/gi, PRICE_BID_TOKEN)
    .replace(/Giá\s+Ask\b/gi, PRICE_ASK_TOKEN);

  const translated = translate(protectedValue)
    .split(PRICE_BID_TOKEN).join("Giá Bid")
    .split(PRICE_ASK_TOKEN).join("Giá Ask");

  return normalizePriceLabels(translated);
}

function translateTextNode(node: Node) {
  if (node.nodeType !== Node.TEXT_NODE) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR)) return;

  const before = node.nodeValue || "";
  if (!before || lastTextValue.get(node) === before) return;

  const after = translatePresentation(before);
  lastTextValue.set(node, after);
  if (after !== before) node.nodeValue = after;
}

function translateAttributes(element: Element) {
  if (element.matches(SKIP_SELECTOR)) return;

  for (const attribute of ["title", "placeholder", "aria-label", "alt"]) {
    if (!element.hasAttribute(attribute)) continue;
    const before = element.getAttribute(attribute) || "";
    const after = translatePresentation(before);
    if (after !== before) element.setAttribute(attribute, after);
  }
}

function translateSubtree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root);
    return;
  }
  if (!(root instanceof Element)) return;

  translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) translateTextNode(walker.currentNode);
}

export function VietnameseLocalizationRuntime({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;

    // Disable the legacy full-body translator. This component replaces it with
    // a scoped, idle-time queue so frequent React updates do not block rendering.
    document.body.setAttribute("data-no-vi-localize", "runtime-managed");

    const pending = new Set<Node>();
    const idleWindow = window as IdleWindow;
    let scheduledHandle: number | null = null;
    let usingIdleCallback = false;

    const schedule = () => {
      if (scheduledHandle !== null) return;

      const flush = () => {
        scheduledHandle = null;
        usingIdleCallback = false;
        const batch = Array.from(pending);
        pending.clear();

        const started = performance.now();
        for (let index = 0; index < batch.length; index += 1) {
          translateSubtree(batch[index]);
          if (performance.now() - started > 6 && index < batch.length - 1) {
            for (let rest = index + 1; rest < batch.length; rest += 1) pending.add(batch[rest]);
            schedule();
            break;
          }
        }
      };

      if (typeof idleWindow.requestIdleCallback === "function") {
        usingIdleCallback = true;
        scheduledHandle = idleWindow.requestIdleCallback(flush, { timeout: 120 });
      } else {
        scheduledHandle = window.setTimeout(flush, 0);
      }
    };

    pending.add(root);
    schedule();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          pending.add(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) pending.add(node);
      }
      schedule();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      pending.clear();
      if (scheduledHandle !== null) {
        if (usingIdleCallback && typeof idleWindow.cancelIdleCallback === "function") {
          idleWindow.cancelIdleCallback(scheduledHandle);
        } else {
          window.clearTimeout(scheduledHandle);
        }
      }
    };
  }, []);

  return children;
}
