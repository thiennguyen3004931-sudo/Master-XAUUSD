import assert from "node:assert/strict";

await import(new URL("../apps/web/public/phase7c-vi-user.js", import.meta.url));
const translate = globalThis.__PHASE7C_VI_TEST__?.translate;
assert.equal(typeof translate, "function", "translation test hook is available");

const cases = [
  ["Sideway risk %", "Sideway rủi ro %"],
  ["Sideway max lot", "Sideway khối lượng tối đa"],
  ["Sideway gate", "Sideway gate"],
  ["Sideway Executor", "Sideway Executor"],
  ["Risk Manager", "Quản lý rủi ro"],
  ["Quote & Broker Spec", "Báo giá & thông số broker"],
  ["Runtime & Bridge", "Runtime & cầu nối"],
  ["Safety", "An toàn"],
  ["READ ONLY panel", "Panel chỉ đọc"],
  ["NEW_POSITIONS_ONLY", "Chỉ áp dụng cho vị thế mới"],
  ["HƯỚNG LỆNHway gate", "Sideway gate"],
  ["KHỐI LƯỢNG step", "Bước khối lượng"],
];
for (const [input, expected] of cases) assert.equal(translate(input), expected, input);

const reason = "Sideway is suspected by structure/ADX but no qualified Supply/Demand corridor confirms it; both trend and range execution should wait.";
const translatedReason = translate(reason);
assert.equal(
  translatedReason,
  "Cấu trúc/ADX cho thấy thị trường có khả năng đi ngang, nhưng chưa có hành lang Supply/Demand đạt chuẩn để xác nhận; bot Trend và bot Sideway tiếp tục chờ.",
);
assert.equal(translate("Bollinger bandwidth: 0.0066."), "Độ rộng dải Bollinger: 0.0066.");
assert.equal(
  translate("Market state is unclear; recommended mode is PAUSE."),
  "Trạng thái thị trường chưa rõ; khuyến nghị Tạm dừng.",
);

for (const sample of [
  translate("Sideway risk %"),
  translate("Sideway Executor"),
  translatedReason,
]) {
  assert.ok(!sample.includes("HƯỚNG LỆNHway"));
  assert.ok(!sample.includes("RỦI RO"));
}

console.log("PHASE7C_WEB_VI_LOCALIZATION_TEST=PASS");
