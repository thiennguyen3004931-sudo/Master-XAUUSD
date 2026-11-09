(() => {
  "use strict";

  // Single presentation-only Vietnamese localization layer.
  // Machine/API values are never mutated; only rendered text/attributes are changed.
  const exact = new Map([
    ["AUTO", "Tự động"],
    ["PAUSE", "Tạm dừng"],
    ["TREND", "Xu hướng"],
    ["SIDEWAY", "Sideway"],
    ["REVERSAL", "Đảo chiều"],
    ["UNCERTAIN", "Chưa rõ"],
    ["BUY", "Mua"],
    ["SELL", "Bán"],
    ["READY", "Sẵn sàng"],
    ["RUNNING", "Đang chạy"],
    ["STARTING", "Đang khởi động"],
    ["WAIT", "Đang chờ"],
    ["WAITING", "Đang chờ"],
    ["BLOCKED", "Bị chặn"],
    ["ALLOWED", "Được phép"],
    ["FLAT", "Chưa có lệnh"],
    ["MANAGING", "Đang quản lý"],
    ["UNMANAGED", "Chưa được quản lý"],
    ["OBSERVED", "Đang theo dõi"],
    ["SUBMITTED", "Đã gửi"],
    ["ERROR", "Lỗi"],
    ["PASS", "Đạt"],
    ["FAIL", "Không đạt"],
    ["YES", "Có"],
    ["Yes", "Có"],
    ["NO", "Không"],
    ["No", "Không"],
    ["NONE", "Không có"],
    ["ON", "Bật"],
    ["OFF", "Tắt"],
    ["CONNECTED", "Đã kết nối"],
    ["DISCONNECTED", "Mất kết nối"],
    ["ACTIVE", "Hoạt động"],
    ["Active", "Hoạt động"],
    ["INACTIVE", "Không hoạt động"],
    ["UNKNOWN", "Không xác định"],
    ["N/A", "Chưa có"],
    ["n/a", "Chưa có"],
    ["NEW_POSITIONS_ONLY", "Chỉ áp dụng cho vị thế mới"],

    ["Bot Trend", "bot Trend"],
    ["BOT TREND", "bot Trend"],
    ["Trend Bot", "bot Trend"],
    ["Bot Sideway", "bot Sideway"],
    ["BOT SIDEWAY", "bot Sideway"],
    ["Sideway Bot", "bot Sideway"],

    ["Quote & Broker Spec", "Báo giá & thông số broker"],
    ["Runtime & Bridge", "Runtime & cầu nối"],
    ["Safety", "An toàn"],
    ["BOT GATE / FILTER", "Điều kiện bot / bộ lọc"],
    ["Bot gate / filter", "Điều kiện bot / bộ lọc"],

    ["Trend fixed lot", "Trend khối lượng cố định"],
    ["Sideway risk %", "Sideway rủi ro %"],
    ["Sideway max lot", "Sideway khối lượng tối đa"],
    ["Auto Lot Mode", "Chế độ Auto Lot"],
    ["Applies to", "Áp dụng"],

    ["Market Data", "Dữ liệu thị trường"],
    ["Decision Engine", "Bộ máy quyết định"],
    ["Risk Manager", "Quản lý rủi ro"],
    ["Trend Executor", "Trend Executor"],
    ["Sideway Executor", "Sideway Executor"],
    ["Trend gate", "Trend gate"],
    ["Sideway gate", "Sideway gate"],
    ["Reversal filter", "Bộ lọc đảo chiều"],

    ["Lifecycle running", "Lifecycle đang chạy"],
    ["Lifecycle ready", "Lifecycle sẵn sàng"],
    ["Current mode", "Chế độ hiện tại"],
    ["Effective strategy", "Chiến lược đang áp dụng"],
    ["Applied strategy", "Chiến lược đang áp dụng"],
    ["UI state", "Trạng thái UI"],
    ["MT5 bridge", "Cầu nối MT5"],
    ["Trading enabled", "Cho phép giao dịch"],
    ["Open XAUUSD positions", "Số vị thế XAUUSD đang mở"],
    ["Market regime notifier", "Bộ thông báo trạng thái thị trường"],
    ["Telegram PID", "PID Telegram"],

    ["Demo only", "Chỉ DEMO"],
    ["Read only panel", "Panel chỉ đọc"],
    ["READ ONLY panel", "Panel chỉ đọc"],
    ["Order permission", "Quyền đặt lệnh"],
    ["Applies to new positions only", "Chỉ áp dụng cho vị thế mới"],
    ["Recovery escalation", "Tăng khối lượng phục hồi"],
    ["Execution mutation", "Can thiệp vị thế đang có"],
    ["Phase7B fixed volume unchanged", "Khối lượng cố định Phase7B không đổi"],
    ["Lot binding active", "Ràng buộc lot đang hoạt động"],

    ["Bid", "Giá Bid"],
    ["Ask", "Giá Ask"],
    ["Spread", "Spread"],
    ["Broker symbol", "Mã symbol broker"],
    ["Min volume", "Khối lượng tối thiểu"],
    ["Volume step", "Bước khối lượng"],
    ["Max volume", "Khối lượng tối đa"],

    ["Control Center", "Trung tâm điều khiển"],
    ["Decision Monitor", "Giám sát quyết định"],
    ["Dashboard", "Bảng điều khiển"],
    ["Overview", "Tổng quan"],
    ["Performance", "Hiệu suất"],
    ["Backtest", "Kiểm thử quá khứ"],
    ["Forward test", "Kiểm thử tiếp diễn"],
    ["Account mode", "Chế độ tài khoản"],
    ["Active mode", "Chế độ hiện tại"],
    ["Recommended mode", "Chế độ được khuyến nghị"],
    ["Market regime", "Trạng thái thị trường"],
    ["Regime", "Trạng thái thị trường"],
    ["Strategy", "Chiến lược"],
    ["Confidence", "Độ tin cậy"],
    ["Status", "Trạng thái"],
    ["Stage", "Giai đoạn"],
    ["Source", "Nguồn"],
    ["Position", "Vị thế"],
    ["Open positions", "Vị thế đang mở"],
    ["Current position", "Vị thế hiện tại"],
    ["Entry reason", "Lý do vào lệnh"],
    ["Hold reason", "Lý do giữ lệnh"],
    ["Exit reason", "Lý do đóng lệnh"],
    ["Decision reason", "Lý do quyết định"],
    ["Limit reason", "Lý do giới hạn"],
    ["Entry", "Điểm vào lệnh"],
    ["Current price", "Giá hiện tại"],
    ["Stop Loss", "Cắt lỗ"],
    ["Stop loss", "Cắt lỗ"],
    ["Take Profit", "Chốt lời"],
    ["Take profit", "Chốt lời"],
    ["Profit", "Lợi nhuận"],
    ["Floating PnL", "Lãi/lỗ đang chạy"],
    ["Balance", "Số dư"],
    ["Equity", "Vốn hiện tại"],
    ["Risk", "Rủi ro"],
    ["Risk percent", "Tỷ lệ rủi ro"],
    ["Max lot", "Khối lượng tối đa"],
    ["Fixed lot", "Khối lượng cố định"],
    ["Lot settings", "Cài đặt khối lượng"],
    ["Terminal trade allowed", "MT5 cho phép giao dịch"],
    ["Read only", "Chỉ đọc"],
    ["Read-only", "Chỉ đọc"],
    ["Manual", "Thủ công"],
    ["Refresh", "Làm mới"],
    ["Loading", "Đang tải"],
    ["No data", "Chưa có dữ liệu"],
    ["No position", "Chưa có vị thế"],
    ["No signal", "Chưa có tín hiệu"],
    ["Waiting for signal", "Đang chờ tín hiệu"],
    ["Entry blocked", "Chặn vào lệnh"],
    ["System status", "Trạng thái hệ thống"],
    ["Bot status", "Trạng thái bot"],
    ["Account", "Tài khoản"],
    ["Server", "Máy chủ"],
    ["Currency", "Tiền tệ"],
    ["Ticket", "Mã lệnh"],
    ["Volume", "Khối lượng"],
    ["Side", "Hướng lệnh"],
    ["Setup", "Mẫu tín hiệu"],
    ["Approved", "Được phê duyệt"],

    ["ENTRY_MODE_BLOCK: AUTO_REGIME_RECOMMENDS_PAUSE", "Chế độ AUTO: thị trường khuyến nghị Tạm dừng, không vào lệnh mới"],
    ["ENTRY_MODE_BLOCK: PAUSE_MODE_BLOCKS_NEW_ENTRY", "Chế độ Tạm dừng đang chặn lệnh mới"],
    ["AUTO_REGIME_RECOMMENDS_PAUSE", "Thị trường hiện tại khuyến nghị Tạm dừng"],
    ["PAUSE_MODE_BLOCKS_NEW_ENTRY", "Chế độ Tạm dừng chặn lệnh mới"],
    ["ENTRY_MODE_BLOCK", "Chế độ hiện tại không cho phép vào lệnh"],
    ["M15_NO_ENTRY_SIGNAL", "Khung M15 chưa có tín hiệu vào lệnh"],
    ["WAIT_PULLBACK", "Chờ giá hồi"],
    ["PULLBACK_STILL_TOO_WIDE", "Vùng hồi vẫn quá rộng"],
    ["PULLBACK_M5_ST_INVALIDATED", "Tín hiệu hồi giá khung M5 đã mất hiệu lực"],
    ["CYCLE_ERROR: fetch failed", "Lỗi chu kỳ: không lấy được dữ liệu"],
    ["CYCLE_ERROR", "Lỗi chu kỳ"],
    ["FVG_HOLD_CONFIRMED", "Xác nhận tiếp tục giữ lệnh theo FVG"],
    ["STRUCTURAL_SL_TIGHTEN", "Siết SL theo cấu trúc"],
    ["MANAGEMENT_REGIME_FRESHNESS_SKIP", "Tạm bỏ qua quản lý: dữ liệu trạng thái thị trường chưa đủ mới"],
    ["MANAGEMENT_QUOTE_FRESHNESS_SKIP", "Tạm bỏ qua quản lý: giá chưa đủ mới"],
    ["MANAGEMENT_REGIME_CHECK_ERROR", "Lỗi kiểm tra trạng thái thị trường"],
    ["ENGULFING", "Nến nhấn chìm"],
    ["TWO_CANDLE_BODY_DOMINANCE", "Mẫu hai nến thân chiếm ưu thế"],
  ]);

  const legacyArtifacts = [
    ["HƯỚNG LỆNHway", "Sideway"],
    ["Hướng lệnhway", "Sideway"],
    ["RỦI RO percent", "Tỷ lệ rủi ro"],
    ["RỦI RO PERCENT", "Tỷ lệ rủi ro"],
    ["KHỐI LƯỢNG step", "Bước khối lượng"],
    ["CHỈ ĐỌC panel", "Panel chỉ đọc"],
    ["TRẠNG THÁI THỊ TRƯỜNG notifier", "Bộ thông báo trạng thái thị trường"],
    ["New_vị thế_only", "Chỉ áp dụng cho vị thế mới"],
    ["NEW_VỊ THẾS_ONLY", "Chỉ áp dụng cho vị thế mới"],
  ];

  const reasonRules = [
    [
      /Sideway is suspected by structure\/ADX but no qualified Supply\/Demand corridor confirms it;\s*both trend and range execution should wait\.?/gi,
      "Cấu trúc/ADX cho thấy thị trường có khả năng đi ngang, nhưng chưa có hành lang Supply/Demand đạt chuẩn để xác nhận; bot Trend và bot Sideway tiếp tục chờ.",
    ],
    [
      /Sideway is suspected by structure\/ADX/gi,
      "Cấu trúc/ADX cho thấy thị trường có khả năng đi ngang",
    ],
    [
      /but no qualified Supply\/Demand corridor confirms it/gi,
      "nhưng chưa có hành lang Supply/Demand đạt chuẩn để xác nhận",
    ],
    [
      /both trend and range execution should wait/gi,
      "bot Trend và bot Sideway nên tiếp tục chờ",
    ],
    [
      /Bollinger bandwidth(?:\s+is|\s*:)?\s*([0-9]+(?:\.[0-9]+)?)\.?/gi,
      (_match, value) => `Độ rộng dải Bollinger: ${value}.`,
    ],
    [
      /Market state(?:\s+is)?\s+unclear;?\s*(?:the\s+)?recommended mode is PAUSE\.?/gi,
      "Trạng thái thị trường chưa rõ; khuyến nghị Tạm dừng.",
    ],
    [
      /A confirmed CHOCH indicates a possible structural reversal\.?/gi,
      "Đã xác nhận CHOCH, thị trường có khả năng đảo chiều.",
    ],
    [
      /No qualified Supply\/Demand corridor(?:\s+confirms it)?\.?/gi,
      "Chưa có hành lang Supply/Demand đạt chuẩn để xác nhận.",
    ],
  ];

  const phrases = [
    ["XAUUSD AI MASTER · BOT MODE", "XAUUSD AI MASTER · Chế độ bot"],
    ["BOT MODE", "Chế độ bot"],
    ["Final lot", "Khối lượng cuối cùng"],
    ["New positions only", "Chỉ áp dụng cho vị thế mới"],
    ["Break even", "Hòa vốn"],
    ["Partial", "Chốt một phần"],
    ["Alive", "Đang chạy"],
  ];

  const orderedPhrases = [...exact.entries(), ...phrases]
    .filter(([from]) => from.length > 1)
    .sort((a, b) => b[0].length - a[0].length);

  function isWordChar(char) {
    return Boolean(char) && /[\p{L}\p{N}_]/u.test(char);
  }

  function replaceWholePhrase(value, from, to) {
    let cursor = 0;
    let output = "";
    let changed = false;

    while (cursor < value.length) {
      const index = value.indexOf(from, cursor);
      if (index < 0) break;

      const before = index > 0 ? value[index - 1] : "";
      const end = index + from.length;
      const after = end < value.length ? value[end] : "";
      const startsWithWord = isWordChar(from[0]);
      const endsWithWord = isWordChar(from[from.length - 1]);
      const leftBlocked = startsWithWord && isWordChar(before);
      const rightBlocked = endsWithWord && isWordChar(after);

      if (leftBlocked || rightBlocked) {
        output += value.slice(cursor, end);
        cursor = end;
        continue;
      }

      output += value.slice(cursor, index) + to;
      cursor = end;
      changed = true;
    }

    return changed ? output + value.slice(cursor) : value;
  }

  function replaceLegacyArtifacts(value) {
    let out = value;
    for (const [bad, good] of legacyArtifacts) out = out.split(bad).join(good);
    return out;
  }

  function translate(value) {
    if (!value || typeof value !== "string") return value;

    let out = replaceLegacyArtifacts(value);
    const trimmed = out.trim();
    if (exact.has(trimmed)) out = out.replace(trimmed, exact.get(trimmed));

    for (const [pattern, replacement] of reasonRules) out = out.replace(pattern, replacement);
    for (const [from, to] of orderedPhrases) out = replaceWholePhrase(out, from, to);

    return out
      .replace(/\bbot\s+trend\b/gi, "bot Trend")
      .replace(/\bbot\s+sideway\b/gi, "bot Sideway")
      .replace(/\bMT5\s+cho phép giao dịch\b/gi, "MT5 cho phép giao dịch");
  }

  // Test hook for the repository regression test and scoped React localization runtime.
  globalThis.__PHASE7C_VI_TEST__ = Object.freeze({ translate });
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;

  function runtimeManaged() {
    return document.body?.getAttribute("data-no-vi-localize") === "runtime-managed";
  }

  function shouldSkip(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    return Boolean(parent.closest("script,style,code,pre,textarea,[data-no-vi-localize]"));
  }

  function translateElement(element) {
    if (!(element instanceof Element)) return;
    if (element.matches("script,style,code,pre,textarea,[data-no-vi-localize]")) return;
    for (const attribute of ["title", "placeholder", "aria-label", "alt"]) {
      if (!element.hasAttribute(attribute)) continue;
      const before = element.getAttribute(attribute) || "";
      const after = translate(before);
      if (after !== before) element.setAttribute(attribute, after);
    }
  }

  function translateTextNode(node) {
    if (shouldSkip(node)) return;
    const before = node.nodeValue || "";
    const after = translate(before);
    if (after !== before) node.nodeValue = after;
  }

  function scan(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) translateTextNode(node);
    if (root instanceof Element) translateElement(root);
    if (root.querySelectorAll) root.querySelectorAll("*").forEach(translateElement);
  }

  function run() {
    document.documentElement.lang = "vi";
    scan(document.body || document.documentElement);
  }

  let queued = false;
  const observer = new MutationObserver((mutations) => {
    if (runtimeManaged()) return;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (runtimeManaged()) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          translateTextNode(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE) scan(node);
        }
      }
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      run();
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, { once: true });
  } else {
    run();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
})();
