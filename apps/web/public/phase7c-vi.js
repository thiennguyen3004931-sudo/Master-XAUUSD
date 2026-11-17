(() => {
  "use strict";

  // Presentation-only localization. Machine/API values remain unchanged.
  const protectedTerms = [
    ["Bot Trend", "__P7C_BOT_TREND__"],
    ["Trend Bot", "__P7C_BOT_TREND__"],
    ["BOT TREND", "__P7C_BOT_TREND__"],
    ["Bot Sideway", "__P7C_BOT_SIDEWAY__"],
    ["Sideway Bot", "__P7C_BOT_SIDEWAY__"],
    ["BOT SIDEWAY", "__P7C_BOT_SIDEWAY__"],
  ];

  const exact = new Map([
    ["AUTO", "TỰ ĐỘNG"],
    ["PAUSE", "TẠM DỪNG"],
    ["TREND", "XU HƯỚNG"],
    ["SIDEWAY", "ĐI NGANG"],
    ["REVERSAL", "ĐẢO CHIỀU"],
    ["UNCERTAIN", "CHƯA RÕ"],
    ["BUY", "MUA"],
    ["SELL", "BÁN"],
    ["READY", "SẴN SÀNG"],
    ["RUNNING", "ĐANG CHẠY"],
    ["STARTING", "ĐANG KHỞI ĐỘNG"],
    ["WAIT", "ĐANG CHỜ"],
    ["WAITING", "ĐANG CHỜ"],
    ["BLOCKED", "BỊ CHẶN"],
    ["ALLOWED", "ĐƯỢC PHÉP"],
    ["FLAT", "CHƯA CÓ LỆNH"],
    ["MANAGING", "ĐANG QUẢN LÝ"],
    ["UNMANAGED", "CHƯA ĐƯỢC QUẢN LÝ"],
    ["OBSERVED", "ĐANG THEO DÕI"],
    ["SUBMITTED", "ĐÃ GỬI"],
    ["ERROR", "LỖI"],
    ["PASS", "ĐẠT"],
    ["FAIL", "KHÔNG ĐẠT"],
    ["YES", "CÓ"],
    ["NO", "KHÔNG"],
    ["NONE", "KHÔNG CÓ"],
    ["ON", "BẬT"],
    ["OFF", "TẮT"],
    ["LIVE", "TÀI KHOẢN THẬT"],
    ["DEMO", "TÀI KHOẢN THỬ NGHIỆM"],
    ["CONNECTED", "ĐÃ KẾT NỐI"],
    ["DISCONNECTED", "MẤT KẾT NỐI"],
    ["ACTIVE", "ĐANG HOẠT ĐỘNG"],
    ["INACTIVE", "KHÔNG HOẠT ĐỘNG"],
    ["UNKNOWN", "KHÔNG XÁC ĐỊNH"],
    ["N/A", "CHƯA CÓ"],
    ["n/a", "chưa có"],
  ]);

  const phrases = [
    ["XAUUSD AI MASTER · BOT MODE", "XAUUSD AI MASTER · CHẾ ĐỘ BOT"],
    ["BOT MODE", "CHẾ ĐỘ BOT"],
    ["Control Center", "TRUNG TÂM ĐIỀU KHIỂN"],
    ["CONTROL CENTER", "TRUNG TÂM ĐIỀU KHIỂN"],
    ["Decision Monitor", "GIÁM SÁT QUYẾT ĐỊNH"],
    ["DECISION MONITOR", "GIÁM SÁT QUYẾT ĐỊNH"],
    ["Dashboard", "BẢNG ĐIỀU KHIỂN"],
    ["DASHBOARD", "BẢNG ĐIỀU KHIỂN"],
    ["Overview", "TỔNG QUAN"],
    ["OVERVIEW", "TỔNG QUAN"],
    ["Performance", "HIỆU SUẤT"],
    ["PERFORMANCE", "HIỆU SUẤT"],
    ["Backtest", "KIỂM THỬ QUÁ KHỨ"],
    ["BACKTEST", "KIỂM THỬ QUÁ KHỨ"],
    ["Forward test", "KIỂM THỬ TIẾP DIỄN"],
    ["FORWARD TEST", "KIỂM THỬ TIẾP DIỄN"],
    ["Account mode", "CHẾ ĐỘ TÀI KHOẢN"],
    ["ACCOUNT MODE", "CHẾ ĐỘ TÀI KHOẢN"],
    ["Active mode", "CHẾ ĐỘ HIỆN TẠI"],
    ["ACTIVE MODE", "CHẾ ĐỘ HIỆN TẠI"],
    ["Effective strategy", "CHIẾN LƯỢC ĐANG ÁP DỤNG"],
    ["EFFECTIVE STRATEGY", "CHIẾN LƯỢC ĐANG ÁP DỤNG"],
    ["Recommended mode", "CHẾ ĐỘ ĐƯỢC KHUYẾN NGHỊ"],
    ["RECOMMENDED MODE", "CHẾ ĐỘ ĐƯỢC KHUYẾN NGHỊ"],
    ["Market regime", "TRẠNG THÁI THỊ TRƯỜNG"],
    ["MARKET REGIME", "TRẠNG THÁI THỊ TRƯỜNG"],
    ["Regime", "TRẠNG THÁI THỊ TRƯỜNG"],
    ["REGIME", "TRẠNG THÁI THỊ TRƯỜNG"],
    ["Strategy", "CHIẾN LƯỢC"],
    ["STRATEGY", "CHIẾN LƯỢC"],
    ["Confidence", "ĐỘ TIN CẬY"],
    ["CONFIDENCE", "ĐỘ TIN CẬY"],
    ["Status", "TRẠNG THÁI"],
    ["STATUS", "TRẠNG THÁI"],
    ["Stage", "GIAI ĐOẠN"],
    ["STAGE", "GIAI ĐOẠN"],
    ["Source", "NGUỒN"],
    ["SOURCE", "NGUỒN"],
    ["Position", "VỊ THẾ"],
    ["POSITION", "VỊ THẾ"],
    ["Open positions", "VỊ THẾ ĐANG MỞ"],
    ["OPEN POSITIONS", "VỊ THẾ ĐANG MỞ"],
    ["Current position", "VỊ THẾ HIỆN TẠI"],
    ["CURRENT POSITION", "VỊ THẾ HIỆN TẠI"],
    ["Entry reason", "LÝ DO VÀO LỆNH"],
    ["ENTRY REASON", "LÝ DO VÀO LỆNH"],
    ["Hold reason", "LÝ DO GIỮ LỆNH"],
    ["HOLD REASON", "LÝ DO GIỮ LỆNH"],
    ["Exit reason", "LÝ DO ĐÓNG LỆNH"],
    ["EXIT REASON", "LÝ DO ĐÓNG LỆNH"],
    ["Decision reason", "LÝ DO QUYẾT ĐỊNH"],
    ["DECISION REASON", "LÝ DO QUYẾT ĐỊNH"],
    ["Limit reason", "LÝ DO GIỚI HẠN"],
    ["LIMIT REASON", "LÝ DO GIỚI HẠN"],
    ["Entry", "ĐIỂM VÀO LỆNH"],
    ["ENTRY", "ĐIỂM VÀO LỆNH"],
    ["Current price", "GIÁ HIỆN TẠI"],
    ["CURRENT PRICE", "GIÁ HIỆN TẠI"],
    ["Stop Loss", "CẮT LỖ"],
    ["STOP LOSS", "CẮT LỖ"],
    ["Stop loss", "CẮT LỖ"],
    ["Take Profit", "CHỐT LỜI"],
    ["TAKE PROFIT", "CHỐT LỜI"],
    ["Take profit", "CHỐT LỜI"],
    ["Profit", "LỢI NHUẬN"],
    ["PROFIT", "LỢI NHUẬN"],
    ["Floating PnL", "LÃI/LỖ ĐANG CHẠY"],
    ["FLOATING PNL", "LÃI/LỖ ĐANG CHẠY"],
    ["Balance", "SỐ DƯ"],
    ["BALANCE", "SỐ DƯ"],
    ["Equity", "VỐN HIỆN TẠI"],
    ["EQUITY", "VỐN HIỆN TẠI"],
    ["Risk", "RỦI RO"],
    ["RISK", "RỦI RO"],
    ["Risk percent", "TỶ LỆ RỦI RO"],
    ["RISK PERCENT", "TỶ LỆ RỦI RO"],
    ["Max lot", "KHỐI LƯỢNG TỐI ĐA"],
    ["MAX LOT", "KHỐI LƯỢNG TỐI ĐA"],
    ["Fixed lot", "KHỐI LƯỢNG CỐ ĐỊNH"],
    ["FIXED LOT", "KHỐI LƯỢNG CỐ ĐỊNH"],
    ["Lot settings", "CÀI ĐẶT KHỐI LƯỢNG"],
    ["LOT SETTINGS", "CÀI ĐẶT KHỐI LƯỢNG"],
    ["Trading enabled", "CHO PHÉP GIAO DỊCH"],
    ["TRADING ENABLED", "CHO PHÉP GIAO DỊCH"],
    ["Terminal trade allowed", "MT5 CHO PHÉP GIAO DỊCH"],
    ["TERMINAL TRADE ALLOWED", "MT5 CHO PHÉP GIAO DỊCH"],
    ["Order permission", "QUYỀN ĐẶT LỆNH"],
    ["ORDER PERMISSION", "QUYỀN ĐẶT LỆNH"],
    ["Read only", "CHỈ ĐỌC"],
    ["READ ONLY", "CHỈ ĐỌC"],
    ["Read-only", "CHỈ ĐỌC"],
    ["READ-ONLY", "CHỈ ĐỌC"],
    ["Manual", "THỦ CÔNG"],
    ["MANUAL", "THỦ CÔNG"],
    ["Refresh", "LÀM MỚI"],
    ["REFRESH", "LÀM MỚI"],
    ["Loading", "ĐANG TẢI"],
    ["LOADING", "ĐANG TẢI"],
    ["No data", "CHƯA CÓ DỮ LIỆU"],
    ["NO DATA", "CHƯA CÓ DỮ LIỆU"],
    ["No position", "CHƯA CÓ VỊ THẾ"],
    ["NO POSITION", "CHƯA CÓ VỊ THẾ"],
    ["No signal", "CHƯA CÓ TÍN HIỆU"],
    ["NO SIGNAL", "CHƯA CÓ TÍN HIỆU"],
    ["Waiting for signal", "ĐANG CHỜ TÍN HIỆU"],
    ["WAITING FOR SIGNAL", "ĐANG CHỜ TÍN HIỆU"],
    ["Entry blocked", "CHẶN VÀO LỆNH"],
    ["ENTRY BLOCKED", "CHẶN VÀO LỆNH"],
    ["System status", "TRẠNG THÁI HỆ THỐNG"],
    ["SYSTEM STATUS", "TRẠNG THÁI HỆ THỐNG"],
    ["Bot status", "TRẠNG THÁI BOT"],
    ["BOT STATUS", "TRẠNG THÁI BOT"],
    ["Account", "TÀI KHOẢN"],
    ["ACCOUNT", "TÀI KHOẢN"],
    ["Server", "MÁY CHỦ"],
    ["SERVER", "MÁY CHỦ"],
    ["Currency", "TIỀN TỆ"],
    ["CURRENCY", "TIỀN TỆ"],
    ["Ticket", "MÃ LỆNH"],
    ["TICKET", "MÃ LỆNH"],
    ["Volume", "KHỐI LƯỢNG"],
    ["VOLUME", "KHỐI LƯỢNG"],
    ["Side", "HƯỚNG LỆNH"],
    ["SIDE", "HƯỚNG LỆNH"],
    ["Setup", "MẪU TÍN HIỆU"],
    ["SETUP", "MẪU TÍN HIỆU"],
    ["Approved", "ĐƯỢC PHÊ DUYỆT"],
    ["APPROVED", "ĐƯỢC PHÊ DUYỆT"],

    // Canonical reason/event codes.
    ["ENTRY_MODE_BLOCK: AUTO_REGIME_RECOMMENDS_PAUSE", "CHẾ ĐỘ TỰ ĐỘNG: THỊ TRƯỜNG YÊU CẦU TẠM DỪNG, KHÔNG VÀO LỆNH MỚI"],
    ["ENTRY_MODE_BLOCK: PAUSE_MODE_BLOCKS_NEW_ENTRY", "CHẾ ĐỘ TẠM DỪNG ĐANG CHẶN LỆNH MỚI"],
    ["AUTO_REGIME_RECOMMENDS_PAUSE", "THỊ TRƯỜNG HIỆN TẠI YÊU CẦU TẠM DỪNG"],
    ["PAUSE_MODE_BLOCKS_NEW_ENTRY", "CHẾ ĐỘ TẠM DỪNG CHẶN LỆNH MỚI"],
    ["ENTRY_MODE_BLOCK", "CHẾ ĐỘ HIỆN TẠI KHÔNG CHO PHÉP VÀO LỆNH"],
    ["M15_NO_ENTRY_SIGNAL", "KHUNG M15 CHƯA CÓ TÍN HIỆU VÀO LỆNH"],
    ["WAIT_PULLBACK", "CHỜ GIÁ HỒI"],
    ["PULLBACK_STILL_TOO_WIDE", "VÙNG HỒI VẪN QUÁ RỘNG"],
    ["PULLBACK_M5_ST_INVALIDATED", "TÍN HIỆU HỒI GIÁ KHUNG M5 ĐÃ MẤT HIỆU LỰC"],
    ["CYCLE_ERROR: fetch failed", "LỖI CHU KỲ: KHÔNG LẤY ĐƯỢC DỮ LIỆU"],
    ["CYCLE_ERROR", "LỖI CHU KỲ"],
    ["FVG_HOLD_CONFIRMED", "XÁC NHẬN TIẾP TỤC GIỮ LỆNH THEO FVG"],
    ["STRUCTURAL_SL_TIGHTEN", "SIẾT CẮT LỖ THEO CẤU TRÚC"],
    ["MANAGEMENT_REGIME_FRESHNESS_SKIP", "TẠM BỎ QUA QUẢN LÝ: DỮ LIỆU TRẠNG THÁI THỊ TRƯỜNG CHƯA ĐỦ MỚI"],
    ["MANAGEMENT_QUOTE_FRESHNESS_SKIP", "TẠM BỎ QUA QUẢN LÝ: GIÁ CHƯA ĐỦ MỚI"],
    ["MANAGEMENT_REGIME_CHECK_ERROR", "LỖI KIỂM TRA TRẠNG THÁI THỊ TRƯỜNG"],
    ["ENGULFING", "NẾN NHẤN CHÌM"],
    ["TWO_CANDLE_BODY_DOMINANCE", "MẪU HAI NẾN THÂN CHIẾM ƯU THẾ"],

    // Common regime explanations observed from the classifier.
    ["A confirmed CHOCH indicates a possible structural reversal.", "Đã xác nhận thay đổi cấu trúc, thị trường có khả năng đảo chiều."],
    ["A confirmed CHOCH indicates a possible structural reversal", "Đã xác nhận thay đổi cấu trúc, thị trường có khả năng đảo chiều"],
    ["Bollinger bandwidth is", "Độ rộng dải Bollinger là"],
    ["Sideway is suspected", "Thị trường có dấu hiệu đi ngang"],
    ["No qualified supply/demand", "Chưa có vùng cung/cầu đạt chuẩn"],
    ["No qualified Supply/Demand", "Chưa có vùng cung/cầu đạt chuẩn"],
  ];

  function protect(text) {
    let out = text;
    for (const [term, token] of protectedTerms) {
      out = out.split(term).join(token);
    }
    return out;
  }

  function restore(text) {
    return text
      .split("__P7C_BOT_TREND__").join("Bot Trend")
      .split("__P7C_BOT_SIDEWAY__").join("Bot Sideway");
  }

  function translateText(input) {
    if (!input || !/[A-Za-z]/.test(input)) return input;
    const trimmed = input.trim();
    if (exact.has(trimmed)) {
      const translated = exact.get(trimmed);
      return input.replace(trimmed, translated);
    }

    let out = protect(input);
    for (const [from, to] of phrases) {
      if (out.includes(from)) out = out.split(from).join(to);
    }

    // Standalone machine values that can appear inside combined status strings.
    const tokenMap = [
      ["AUTO", "TỰ ĐỘNG"],
      ["PAUSE", "TẠM DỪNG"],
      ["REVERSAL", "ĐẢO CHIỀU"],
      ["UNCERTAIN", "CHƯA RÕ"],
      ["READY", "SẴN SÀNG"],
      ["RUNNING", "ĐANG CHẠY"],
      ["WAITING", "ĐANG CHỜ"],
      ["BLOCKED", "BỊ CHẶN"],
      ["BUY", "MUA"],
      ["SELL", "BÁN"],
      ["FLAT", "CHƯA CÓ LỆNH"],
      ["MANAGING", "ĐANG QUẢN LÝ"],
      ["NONE", "KHÔNG CÓ"],
    ];
    for (const [from, to] of tokenMap) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }

    return restore(out);
  }

  function shouldSkip(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    return Boolean(parent.closest("script,style,code,pre,textarea,[data-no-vi-localize]"));
  }

  function localizeTextNode(node) {
    if (shouldSkip(node)) return;
    const before = node.nodeValue;
    const after = translateText(before);
    if (before !== after) node.nodeValue = after;
  }

  function localizeElement(element) {
    if (!(element instanceof Element)) return;
    if (element.matches("script,style,code,pre,textarea,[data-no-vi-localize]")) return;

    for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
      if (element.hasAttribute(attr)) {
        const before = element.getAttribute(attr) || "";
        const after = translateText(before);
        if (before !== after) element.setAttribute(attr, after);
      }
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) localizeTextNode(node);
  }

  function run() {
    document.documentElement.lang = "vi";
    if (!document.title || document.title === "web") {
      document.title = "XAUUSD AI MASTER · Bảng điều khiển";
    } else {
      document.title = translateText(document.title);
    }
    localizeElement(document.body);
  }

  let queued = false;
  const observer = new MutationObserver((mutations) => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          localizeTextNode(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) localizeTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE) localizeElement(node);
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
