import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, "apps/web/src/ui/Phase7CAccountSwitchCard.tsx"),
  "utf8",
);

function requireText(needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

function forbidText(needle, label) {
  if (source.includes(needle)) throw new Error(`${label}: obsolete verbose text still present`);
}

requireText(
  'const [sameModeDetailsOpen, setSameModeDetailsOpen] = useState(false);',
  "collapsed-by-default state",
);
requireText('sameModeDetailsOpen &&', "details visibility gate");
requireText('Xem chi tiết', "expand action");
requireText('Ẩn chi tiết', "collapse action");
requireText('Lý do:', "compact blocker summary");
requireText('SẴN SÀNG', "compact ready status");
requireText('BỊ CHẶN', "compact blocked status");
requireText('Chuẩn bị đổi login MT5', "same-mode action preserved");
requireText('<CheckRows checks={readiness.checks} />', "full readiness detail renderer preserved");
requireText(
  'Account switch không cấp quyền AUTO và không gửi order.',
  "account-switch safety boundary preserved",
);
requireText(
  'Credential input: {SAME_MODE_ACCOUNT_CHANGE_POLICY.credentialInput}',
  "compact credential policy preserved",
);

forbidText(
  'Ví dụ LIVE A → LIVE B. Web không nhận thông tin đăng nhập. Khi readiness PASS, bạn bấm chuẩn bị rồi tự đăng nhập tài khoản mới trong MT5.',
  "same-mode long description",
);
forbidText(
  'Trước khi đổi login LIVE, hãy tắt quyền giao dịch LIVE ở thẻ Quyền thực thi phía trên. Card này không tự thay đổi quyền giao dịch.',
  "LIVE long warning",
);

console.log("PHASE7C_ACCOUNT_SWITCH_COMPACT_UI_SOURCE_TEST=PASS");
