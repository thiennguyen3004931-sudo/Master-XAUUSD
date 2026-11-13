#property copyright "XAUUSD AI MASTER"
#property version   "1.40"
#property description "Bảng quyết định XAUUSD AI MASTER · DPI-stable grid · chỉ đọc · DEMO/LIVE aware"

#include <Canvas\Canvas.mqh>

input string InpApiUrl = "http://127.0.0.1:3711/api/v1/phase7c-ui/mt5?symbol=XAUUSD";
input int InpRefreshSeconds = 3;
input ENUM_BASE_CORNER InpCorner = CORNER_LEFT_UPPER;
input int InpX = 12;
input int InpY = 28;

const string LEGACY_PREFIX = "XAU_AI_P7C_";
const string CANVAS_NAME = "XAU_AI_P7C_CANVAS_V7";
const int PANEL_MIN_WIDTH = 620;
const int PANEL_MAX_WIDTH = 760;
const int WAITING_HEIGHT = 590;
const int SETUP_HEIGHT = 590;
const int MANAGING_HEIGHT = 780;
const int BODY_FONT_SIZE = 13;
const int SECTION_FONT_SIZE = 15;
const int TITLE_FONT_SIZE = 20;
const int STATUS_COLUMN_COUNT = 4;
const int HEADER_HEIGHT = 104;
const int STATUS_HEIGHT = 86;
const int STATE_STRIP_HEIGHT = 58;
const int ENTRY_CHECK_HEIGHT = 112;
const int REASON_ROW_HEIGHT = 64;
const int REASON_ROW_GAP = 6;
// Required installer safety marker: READ ONLY | DEMO/LIVE | ORDER PERMISSION = NONE

CCanvas g_canvas;
bool g_canvas_ready = false;
int g_canvas_width = 0;
int g_canvas_height = 0;

uint A(const color value, const int alpha=255)
{
   return ColorToARGB(value, (uchar)MathMax(0, MathMin(255, alpha)));
}

string Field(const string payload, const string wanted)
{
   string lines[];
   ushort separator = (ushort)StringGetCharacter("\n", 0);
   int count = StringSplit(payload, separator, lines);
   for(int index = 0; index < count; index++)
   {
      int equals = StringFind(lines[index], "=");
      if(equals <= 0)
         continue;
      if(StringSubstr(lines[index], 0, equals) == wanted)
         return StringSubstr(lines[index], equals + 1);
   }
   return "n/a";
}

bool EmptyValue(const string value)
{
   return value == "" || value == "n/a" || value == "N/A" || value == "null" || value == "undefined" || value == "-";
}

string Clean(const string value, const string fallback="-")
{
   return EmptyValue(value) ? fallback : value;
}

bool BoolField(const string payload, const string key)
{
   string value = Field(payload, key);
   return value == "true" || value == "True" || value == "TRUE" || value == "1";
}

string LocalAccountMode()
{
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode == ACCOUNT_TRADE_MODE_REAL) return "LIVE";
   if(mode == ACCOUNT_TRADE_MODE_DEMO) return "DEMO";
   if(mode == ACCOUNT_TRADE_MODE_CONTEST) return "CONTEST";
   return "UNKNOWN";
}

bool RuntimeMatchesTerminal(const string payload)
{
   string runtime_mode = Clean(Field(payload, "accountMode"), "UNKNOWN");
   string terminal_mode = LocalAccountMode();
   if(runtime_mode != "DEMO" && runtime_mode != "LIVE") return false;
   return runtime_mode == terminal_mode;
}

int PanelWidth()
{
   int chart_width = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS, 0);
   int target = (int)MathRound(chart_width * 0.40);
   target = (int)MathMax(PANEL_MIN_WIDTH, MathMin(PANEL_MAX_WIDTH, target));
   if(chart_width > 100)
      target = (int)MathMin(target, chart_width - 24);
   return (int)MathMax(460, target);
}

void PurgeLegacyPanelObjects()
{
   for(int index = ObjectsTotal(0) - 1; index >= 0; index--)
   {
      string name = ObjectName(0, index);
      if(StringFind(name, LEGACY_PREFIX) == 0)
         ObjectDelete(0, name);
   }
}

void DestroyCanvas()
{
   if(g_canvas_ready)
   {
      g_canvas.Destroy();
      g_canvas_ready = false;
   }
   ObjectDelete(0, CANVAS_NAME);
   g_canvas_width = 0;
   g_canvas_height = 0;
}

bool EnsureCanvas(const int width, const int height)
{
   if(g_canvas_ready && g_canvas_width == width && g_canvas_height == height)
      return true;

   DestroyCanvas();
   if(!g_canvas.CreateBitmapLabel(0, 0, CANVAS_NAME, 0, 0, width, height, COLOR_FORMAT_ARGB_NORMALIZE))
      return false;

   ObjectSetInteger(0, CANVAS_NAME, OBJPROP_CORNER, InpCorner);
   ObjectSetInteger(0, CANVAS_NAME, OBJPROP_XDISTANCE, InpX);
   ObjectSetInteger(0, CANVAS_NAME, OBJPROP_YDISTANCE, InpY);
   ObjectSetInteger(0, CANVAS_NAME, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, CANVAS_NAME, OBJPROP_HIDDEN, true);
   ObjectSetInteger(0, CANVAS_NAME, OBJPROP_BACK, false);

   g_canvas_width = width;
   g_canvas_height = height;
   g_canvas_ready = true;
   return true;
}

void SetFont(const int px)
{
   g_canvas.FontSet("Segoe UI", px);
}

int TextHeightPx(const int px)
{
   SetFont(px);
   return (int)MathMax(1, g_canvas.TextHeight("Ag"));
}

int CenteredTextY(const int top, const int height, const int px)
{
   int text_height = TextHeightPx(px);
   return top + (int)MathMax(0, (height - text_height) / 2);
}

int ReasonLabelColumnWidth()
{
   SetFont(BODY_FONT_SIZE);
   int measured = g_canvas.TextWidth("ĐÓNG TOÀN BỘ") + 34;
   return (int)MathMax(150, MathMin(210, measured));
}

int EntryStrategyColumnWidth()
{
   SetFont(BODY_FONT_SIZE);
   int measured = g_canvas.TextWidth("SIDEWAY") + 30;
   return (int)MathMax(92, MathMin(130, measured));
}

string FitText(const string source, const int max_width, const int px)
{
   string text = source;
   SetFont(px);
   if(g_canvas.TextWidth(text) <= max_width)
      return text;

   const string suffix = "...";
   while(StringLen(text) > 1 && g_canvas.TextWidth(text + suffix) > max_width)
      text = StringSubstr(text, 0, StringLen(text) - 1);
   return text + suffix;
}

void WrapTextTwoLines(
   const string source,
   const int max_width,
   const int px,
   string &line1,
   string &line2
)
{
   string text = Clean(source, "-");
   line1 = text;
   line2 = "";
   SetFont(px);

   if(g_canvas.TextWidth(text) <= max_width)
      return;

   string words[];
   ushort separator = (ushort)StringGetCharacter(" ", 0);
   int count = StringSplit(text, separator, words);
   if(count <= 1)
   {
      line1 = FitText(text, max_width, px);
      return;
   }

   line1 = "";
   int split_index = 0;
   for(int index = 0; index < count; index++)
   {
      string candidate = line1 == "" ? words[index] : line1 + " " + words[index];
      if(line1 != "" && g_canvas.TextWidth(candidate) > max_width)
         break;

      line1 = candidate;
      split_index = index + 1;
      if(g_canvas.TextWidth(line1) > max_width)
      {
         line1 = FitText(line1, max_width, px);
         break;
      }
   }

   string remainder = "";
   for(int index = split_index; index < count; index++)
      remainder += (remainder == "" ? "" : " ") + words[index];

   if(remainder != "")
      line2 = FitText(remainder, max_width, px);
}

void Text(const int x, const int y, const string value, const color clr, const int px)
{
   SetFont(px);
   g_canvas.TextOut(x, y, value, A(clr), 0);
}

void TextRight(const int right_x, const int y, const string value, const color clr, const int px)
{
   SetFont(px);
   int width = g_canvas.TextWidth(value);
   g_canvas.TextOut(right_x - width, y, value, A(clr), 0);
}

void TextCenter(const int center_x, const int y, const string value, const color clr, const int px)
{
   SetFont(px);
   int width = g_canvas.TextWidth(value);
   g_canvas.TextOut(center_x - width / 2, y, value, A(clr), 0);
}

void Card(const int x, const int y, const int width, const int height, const color fill, const color border)
{
   g_canvas.FillRectangle(x, y, x + width, y + height, A(fill, 252));
   g_canvas.Rectangle(x, y, x + width, y + height, A(border, 235));
}

void VerticalDivider(const int x, const int y1, const int y2, const color tone)
{
   g_canvas.Line(x, y1, x, y2, A(tone, 210));
}

color ModeTone(const string mode, const string strategy)
{
   if(mode == "PAUSE" || strategy == "PAUSE") return clrOrange;
   if(mode == "AUTO") return clrLimeGreen;
   if(mode == "TREND") return clrDeepSkyBlue;
   if(mode == "SIDEWAY") return clrAqua;
   return clrGold;
}

color RegimeTone(const string regime)
{
   if(regime == "REVERSAL") return clrOrange;
   if(regime == "TREND") return clrDeepSkyBlue;
   if(regime == "SIDEWAY") return clrAqua;
   return clrSilver;
}

string ModeVi(const string value)
{
   if(value == "AUTO") return "TỰ ĐỘNG";
   if(value == "PAUSE") return "TẠM DỪNG";
   if(value == "TREND") return "bot Trend";
   if(value == "SIDEWAY") return "bot Sideway";
   if(EmptyValue(value)) return "CHƯA CÓ";
   return value;
}

string RegimeVi(const string value)
{
   if(value == "TREND") return "XU HƯỚNG";
   if(value == "SIDEWAY") return "ĐI NGANG";
   if(value == "REVERSAL") return "ĐẢO CHIỀU";
   if(value == "UNCERTAIN") return "CHƯA RÕ";
   if(EmptyValue(value)) return "CHƯA CÓ";
   return value;
}

string StageVi(const string value)
{
   if(value == "READY") return "SẴN SÀNG";
   if(value == "WAITING") return "ĐANG CHỜ";
   if(value == "BLOCKED") return "BỊ CHẶN";
   if(value == "MANAGING") return "ĐANG QUẢN LÝ";
   if(value == "OBSERVED") return "ĐANG THEO DÕI";
   if(value == "SUBMITTED") return "ĐÃ GỬI";
   if(value == "ERROR") return "LỖI";
   if(EmptyValue(value)) return "CHƯA CÓ";
   return value;
}

string SideVi(const string value)
{
   if(value == "BUY" || value == "LONG") return "MUA";
   if(value == "SELL" || value == "SHORT") return "BÁN";
   if(EmptyValue(value)) return "CHƯA CÓ";
   return value;
}

string ReasonVi(const string value, const string fallback="Chưa có dữ liệu")
{
   if(EmptyValue(value)) return fallback;
   string out = value;
   StringReplace(out, "A confirmed CHOCH indicates a possible structural reversal.", "CHOCH xác nhận khả năng đảo chiều cấu trúc.");
   StringReplace(out, "Bollinger bandwidth is", "Độ rộng dải Bollinger là");
   StringReplace(out, "ENTRY_MODE_BLOCK: AUTO_REGIME_RECOMMENDS_PAUSE", "AUTO đang chờ trạng thái thị trường phù hợp.");
   StringReplace(out, "ENTRY_MODE_BLOCK: PAUSE_MODE_BLOCKS_NEW_ENTRY", "Chế độ TẠM DỪNG đang chặn lệnh mới.");
   StringReplace(out, "M15_NO_ENTRY_SIGNAL", "Khung M15 chưa có tín hiệu vào lệnh.");
   StringReplace(out, "WAIT_PULLBACK", "Đang chờ giá hồi về vùng phù hợp.");
   StringReplace(out, "PULLBACK_STILL_TOO_WIDE", "Vùng hồi vẫn quá rộng, chưa đủ điều kiện vào lệnh.");
   StringReplace(out, "PULLBACK_M5_ST_INVALIDATED", "Tín hiệu hồi giá khung M5 đã mất hiệu lực.");
   StringReplace(out, "CYCLE_ERROR: fetch failed", "Không lấy được dữ liệu trong chu kỳ kiểm tra.");
   StringReplace(out, "Regime", "Trạng thái thị trường");
   StringReplace(out, "recommended mode", "chế độ được khuyến nghị");
   StringReplace(out, "setup", "mẫu tín hiệu");
   StringReplace(out, "final gate", "điều kiện xác nhận cuối");
   return out;
}

void BeginPanel(const int width, const int height)
{
   g_canvas.Erase(A(C'3,10,18', 255));
   g_canvas.FillRectangle(0, 0, width - 1, height - 1, A(C'3,10,18', 255));
   g_canvas.Rectangle(0, 0, width - 1, height - 1, A(C'0,160,200'));
   g_canvas.FillRectangle(8, 6, width - 9, 8, A(C'0,210,255'));
}

void DrawHeader(const string payload, const int width, const string mode, const string strategy, const string regime, const string confidence)
{
   const int x = 10;
   const int y = 14;
   const int w = width - 20;
   Card(x, y, w, HEADER_HEIGHT, C'7,20,30', C'0,72,102');

   string runtime_mode = Clean(Field(payload, "accountMode"), "CHECK");
   string local_mode = LocalAccountMode();
   color account_tone = RuntimeMatchesTerminal(payload) ? clrLimeGreen : clrTomato;
   int half = (w - 48) / 2;

   Text(x + 18, y + 12, "XAUUSD AI MASTER", clrDeepSkyBlue, TITLE_FONT_SIZE);
   TextRight(x + w - 18, y + 14, FitText(runtime_mode + " · CHỈ ĐỌC", half, BODY_FONT_SIZE), account_tone, BODY_FONT_SIZE);
   Text(x + 18, y + 42, FitText("Chế độ: " + ModeVi(mode), half, BODY_FONT_SIZE), ModeTone(mode, strategy), BODY_FONT_SIZE);
   TextRight(x + w - 18, y + 42, FitText("Đang áp dụng: " + ModeVi(strategy), half, BODY_FONT_SIZE), ModeTone(mode, strategy), BODY_FONT_SIZE);
   Text(x + 18, y + 72, FitText("Thị trường: " + RegimeVi(regime), half, BODY_FONT_SIZE), RegimeTone(regime), BODY_FONT_SIZE);
   TextRight(x + w - 18, y + 72, FitText("MT5 " + local_mode + " · Tin cậy " + Clean(confidence) + "%", half, BODY_FONT_SIZE), account_tone, BODY_FONT_SIZE);
}

void DrawStatusItem(const int x, const int y, const int cell_width, const int cell_height, const string label, const bool on)
{
   color tone = on ? clrLimeGreen : clrTomato;
   int text_height = TextHeightPx(BODY_FONT_SIZE);
   int gap = 4;
   int block_height = text_height * 2 + gap;
   int start_y = y + (int)MathMax(0, (cell_height - block_height) / 2);
   int label_y = start_y;
   int value_y = start_y + text_height + gap;
   g_canvas.FillCircle(x + 6, label_y + text_height / 2, 4, A(tone));
   Text(x + 20, label_y, FitText(label, cell_width - 28, BODY_FONT_SIZE), clrSilver, BODY_FONT_SIZE);
   Text(x + 20, value_y, on ? "ON" : "OFF", tone, BODY_FONT_SIZE);
}

void DrawSystemStatus(const string payload, const int width)
{
   const int x = 10;
   const int y = 126;
   const int w = width - 20;
   Card(x, y, w, STATUS_HEIGHT, C'7,21,30', C'0,72,102');
   Text(x + 18, CenteredTextY(y + 6, 28, SECTION_FONT_SIZE), "TRẠNG THÁI HỆ THỐNG", clrAqua, SECTION_FONT_SIZE);

   int content_x = x + 18;
   int content_w = w - 36;
   int col = content_w / STATUS_COLUMN_COUNT;
   int cell_top = y + 36;
   int cell_height = STATUS_HEIGHT - 44;
   for(int divider = 1; divider < STATUS_COLUMN_COUNT; divider++)
      VerticalDivider(content_x + col * divider, cell_top + 2, y + STATUS_HEIGHT - 8, C'80,105,120');

   DrawStatusItem(content_x, cell_top, col, cell_height, "MT5", BoolField(payload, "mt5Connected") && RuntimeMatchesTerminal(payload));
   DrawStatusItem(content_x + col, cell_top, col, cell_height, "An toàn", BoolField(payload, "accountGuardValid"));
   DrawStatusItem(content_x + col * 2, cell_top, col, cell_height, "bot Trend", BoolField(payload, "trendOn"));
   DrawStatusItem(content_x + col * 3, cell_top, col, cell_height, "bot Sideway", BoolField(payload, "sidewayOn"));
}

void DrawStateStrip(const string payload, const int width, const string title, const color tone)
{
   const int x = 10;
   const int y = 220;
   const int w = width - 20;
   Card(x, y, w, STATE_STRIP_HEIGHT, C'9,24,34', tone);
   int top_y = CenteredTextY(y + 4, 27, SECTION_FONT_SIZE);
   int bottom_y = CenteredTextY(y + 31, STATE_STRIP_HEIGHT - 35, BODY_FONT_SIZE);
   Text(x + 18, top_y, FitText(title, w * 2 / 3, SECTION_FONT_SIZE), tone, SECTION_FONT_SIZE);
   TextRight(x + w - 18, top_y, FitText(StageVi(Field(payload, "stage")), w / 4, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   Text(x + 18, bottom_y, FitText("Khuyến nghị: " + ModeVi(Field(payload, "recommendedMode")), w - 36, BODY_FONT_SIZE), clrSilver, BODY_FONT_SIZE);
}

void DrawReasonRowCard(
   const int x,
   const int y,
   const int width,
   const string label,
   const string reason,
   const color tone,
   const string fallback
)
{
   Card(x, y, width, REASON_ROW_HEIGHT, C'8,24,34', C'0,72,102');
   int label_width = ReasonLabelColumnWidth();
   VerticalDivider(x + label_width, y + 10, y + REASON_ROW_HEIGHT - 10, C'90,110,122');

   int label_y = CenteredTextY(y, REASON_ROW_HEIGHT, BODY_FONT_SIZE);
   Text(x + 14, label_y, FitText(label, label_width - 28, BODY_FONT_SIZE), tone, BODY_FONT_SIZE);

   int content_x = x + label_width + 18;
   int content_width = width - label_width - 34;
   string line1, line2;
   WrapTextTwoLines(ReasonVi(reason, fallback), content_width, BODY_FONT_SIZE, line1, line2);

   int text_height = TextHeightPx(BODY_FONT_SIZE);
   int line_gap = 4;
   int line_count = line2 == "" ? 1 : 2;
   int block_height = line_count == 1 ? text_height : text_height * 2 + line_gap;
   int text_y = y + (int)MathMax(0, (REASON_ROW_HEIGHT - block_height) / 2);
   Text(content_x, text_y, line1, clrWhite, BODY_FONT_SIZE);
   if(line2 != "")
      Text(content_x, text_y + text_height + line_gap, line2, clrWhite, BODY_FONT_SIZE);
}

int ReasonSummaryHeight(const string state)
{
   int rows = state == "MANAGING" ? 5 : 2;
   return 38 + rows * REASON_ROW_HEIGHT + (rows - 1) * REASON_ROW_GAP + 10;
}

void DrawReasonSummary(const string payload, const int width, const int y, const string state)
{
   const int x = 10;
   const int w = width - 20;
   int h = ReasonSummaryHeight(state);
   Card(x, y, w, h, C'7,21,30', C'0,72,102');
   Text(x + 18, CenteredTextY(y + 4, 28, SECTION_FONT_SIZE), "LÝ DO QUYẾT ĐỊNH", clrAqua, SECTION_FONT_SIZE);

   int row_x = x + 10;
   int row_w = w - 20;
   int row_y = y + 38;

   if(state == "WAITING")
   {
      DrawReasonRowCard(row_x, row_y, row_w, "AUTO/REGIME", Field(payload, "autoReason1"), clrOrange, "AUTO chưa có dữ liệu chọn strategy.");
      DrawReasonRowCard(row_x, row_y + REASON_ROW_HEIGHT + REASON_ROW_GAP, row_w, "KẾT LUẬN", Field(payload, "waitReason1"), clrGold, "Bot đang chờ setup hợp lệ.");
   }
   else if(state == "SETUP_READY")
   {
      DrawReasonRowCard(row_x, row_y, row_w, "VÀO LỆNH", Field(payload, "entryReason1"), clrLimeGreen, "Setup đã được duyệt.");
      DrawReasonRowCard(row_x, row_y + REASON_ROW_HEIGHT + REASON_ROW_GAP, row_w, "AUTO/REGIME", Field(payload, "autoReason1"), clrOrange, "Không có dữ liệu AUTO/Regime.");
   }
   else
   {
      DrawReasonRowCard(row_x, row_y, row_w, "VÀO LỆNH", Field(payload, "entryReason1"), clrLimeGreen, "Không có dữ liệu lý do vào lệnh.");
      DrawReasonRowCard(row_x, row_y + (REASON_ROW_HEIGHT + REASON_ROW_GAP), row_w, "GIỮ LỆNH", Field(payload, "holdReason1"), clrDeepSkyBlue, "Không có dữ liệu lý do giữ lệnh.");
      DrawReasonRowCard(row_x, row_y + (REASON_ROW_HEIGHT + REASON_ROW_GAP) * 2, row_w, "DỜI SL", Field(payload, "stopMoveReason1"), clrLimeGreen, "Chưa phát sinh dời SL.");
      DrawReasonRowCard(row_x, row_y + (REASON_ROW_HEIGHT + REASON_ROW_GAP) * 3, row_w, "CHỐT 1/3", Field(payload, "partialReason1"), clrAqua, "Chưa phát sinh partial.");
      DrawReasonRowCard(row_x, row_y + (REASON_ROW_HEIGHT + REASON_ROW_GAP) * 4, row_w, "ĐÓNG TOÀN BỘ", Field(payload, "exitReason1"), clrGold, "Chưa phát sinh điều kiện đóng toàn bộ.");
   }
}

void DrawTradePlan(const string payload, const int width, const bool managing)
{
   const int x = 10;
   const int y = 220;
   const int w = width - 20;
   const int h = 88;
   Card(x, y, w, h, C'6,18,27', C'0,72,102');

   int gap = 10;
   int box_w = (w - 36 - gap * 2) / 3;
   int bx1 = x + 12;
   int bx2 = bx1 + box_w + gap;
   int bx3 = bx2 + box_w + gap;
   string position_state = managing ? Clean(Field(payload, "positionState"), "UNMANAGED") : "SETUP";
   bool position_unmanaged = managing && position_state == "UNMANAGED";
   string entry = managing ? Field(payload, "positionEntry") : Field(payload, "setupEntry");
   string stop = managing ? Field(payload, "positionStopLoss") : Field(payload, "setupStopLoss");
   string tp2 = managing ? (position_unmanaged ? "n/a" : Field(payload, "positionTp2")) : Field(payload, "setupTp2");
   string tp1 = managing ? (position_unmanaged ? "n/a" : Field(payload, "positionTp1")) : Field(payload, "setupTp1");
   string strategy = managing ? (position_unmanaged ? "UNMANAGED" : Field(payload, "positionStrategy")) : Field(payload, "setupStrategy");
   string tp = position_unmanaged ? "n/a" : (EmptyValue(tp2) ? tp1 : tp2);
   string tp_label = position_unmanaged ? "TP KHÔNG QUẢN LÝ" : (strategy == "TREND" && EmptyValue(tp2) ? "MỐC +10" : "TP");

   Card(bx1, y + 12, box_w, 64, C'7,25,38', C'0,110,155');
   Card(bx2, y + 12, box_w, 64, C'30,14,22', C'140,45,60');
   Card(bx3, y + 12, box_w, 64, position_unmanaged ? C'35,18,18' : C'12,28,20', position_unmanaged ? clrTomato : C'45,140,70');
   Text(bx1 + 12, CenteredTextY(y + 14, 22, BODY_FONT_SIZE), "ENTRY", clrDeepSkyBlue, BODY_FONT_SIZE);
   Text(bx2 + 12, CenteredTextY(y + 14, 22, BODY_FONT_SIZE), "STOPLOSS", clrTomato, BODY_FONT_SIZE);
   Text(bx3 + 12, CenteredTextY(y + 14, 22, BODY_FONT_SIZE), tp_label, position_unmanaged ? clrTomato : clrLimeGreen, BODY_FONT_SIZE);
   Text(bx1 + 12, CenteredTextY(y + 38, 32, BODY_FONT_SIZE), FitText(Clean(entry), box_w - 24, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   Text(bx2 + 12, CenteredTextY(y + 38, 32, BODY_FONT_SIZE), FitText(Clean(stop), box_w - 24, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   Text(bx3 + 12, CenteredTextY(y + 38, 32, BODY_FONT_SIZE), FitText(Clean(tp), box_w - 24, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
}

color EntryCheckTone(const string status)
{
   if(status == "PASS") return clrLimeGreen;
   if(status == "FAIL" || status == "BLOCKED") return clrTomato;
   if(status == "WAIT") return clrGold;
   return clrSilver;
}

string EntryCheckStatusVi(const string status)
{
   if(status == "PASS") return "PASS";
   if(status == "FAIL") return "FAIL";
   if(status == "BLOCKED") return "BLOCK";
   if(status == "WAIT") return "WAIT";
   return "-";
}

string CompactEntryCheckLabel(const string value)
{
   string out = Clean(value, "Điều kiện entry");
   StringReplace(out, "Mode / Regime", "Mode/Regime");
   StringReplace(out, "Mode/ Regime", "Mode/Regime");
   StringReplace(out, "Mode /Regime", "Mode/Regime");
   return out;
}

string CompactEntryCheckActual(const string value)
{
   string out = Clean(value, "-");
   StringReplace(out, "PAUSE → PAUSE", "PAUSE");
   StringReplace(out, "AUTO → AUTO", "AUTO");
   StringReplace(out, "TREND → TREND", "TREND");
   StringReplace(out, "SIDEWAY → SIDEWAY", "SIDEWAY");
   return out;
}

string CompactEntryCheckText(const string status, const string label, const string actual)
{
   string compact = EntryCheckStatusVi(status) + " · " + CompactEntryCheckLabel(label);
   string compact_actual = CompactEntryCheckActual(actual);
   if(!EmptyValue(compact_actual))
      compact += ": " + compact_actual;
   return compact;
}

void FirstEntryBlocker(
   const string payload,
   const string prefix,
   string &label,
   string &status,
   string &actual
)
{
   label = "Chưa có dữ liệu";
   status = "WAIT";
   actual = "-";

   bool fallback_set = false;

   for(int index = 1; index <= 10; index++)
   {
      string suffix = IntegerToString(index);
      string candidate_status = Field(payload, prefix + "Check" + suffix + "Status");
      if(EmptyValue(candidate_status))
         continue;

      string candidate_label = Clean(Field(payload, prefix + "Check" + suffix + "Label"), "Điều kiện entry");
      string candidate_actual = Clean(Field(payload, prefix + "Check" + suffix + "Actual"), "-");

      if(!fallback_set)
      {
         label = candidate_label;
         status = candidate_status;
         actual = candidate_actual;
         fallback_set = true;
      }

      if(candidate_status != "PASS")
      {
         label = candidate_label;
         status = candidate_status;
         actual = candidate_actual;
         return;
      }
   }
}

void DrawEntryCheckRow(
   const int x,
   const int y,
   const int width,
   const string strategy_label,
   const string status,
   const string label,
   const string actual,
   const color strategy_tone
)
{
   const int row_height = 30;
   int label_width = EntryStrategyColumnWidth();
   Card(x, y, width, row_height, C'8,24,34', C'0,58,82');
   VerticalDivider(x + label_width, y + 6, y + row_height - 6, C'75,100,115');
   int text_y = CenteredTextY(y, row_height, BODY_FONT_SIZE);
   Text(x + 10, text_y, FitText(strategy_label, label_width - 18, BODY_FONT_SIZE), strategy_tone, BODY_FONT_SIZE);
   Text(x + label_width + 14, text_y, FitText(CompactEntryCheckText(status, label, actual), width - label_width - 24, BODY_FONT_SIZE), EntryCheckTone(status), BODY_FONT_SIZE);
}

void DrawEntryCheckSummary(const string payload, const int width, const int y)
{
   const int x = 10;
   const int w = width - 20;

   Card(x, y, w, ENTRY_CHECK_HEIGHT, C'7,21,30', C'0,72,102');
   Text(x + 18, CenteredTextY(y + 4, 28, SECTION_FONT_SIZE), "ĐIỀU KIỆN CHẶN ENTRY", clrAqua, SECTION_FONT_SIZE);

   string trend_label, trend_status, trend_actual;
   string sideway_label, sideway_status, sideway_actual;
   FirstEntryBlocker(payload, "trend", trend_label, trend_status, trend_actual);
   FirstEntryBlocker(payload, "sideway", sideway_label, sideway_status, sideway_actual);

   DrawEntryCheckRow(x + 10, y + 38, w - 20, "TREND", trend_status, trend_label, trend_actual, clrDeepSkyBlue);
   DrawEntryCheckRow(x + 10, y + 74, w - 20, "SIDEWAY", sideway_status, sideway_label, sideway_actual, clrAqua);
}

void DrawWaiting(const string payload, const int width)
{
   DrawStateStrip(payload, width, "BOT ĐANG CHỜ TÍN HIỆU", clrOrange);
   DrawEntryCheckSummary(payload, width, 286);
   DrawReasonSummary(payload, width, 406, "WAITING");
}

void DrawSetup(const string payload, const int width)
{
   DrawTradePlan(payload, width, false);
   DrawReasonSummary(payload, width, 316, "SETUP_READY");

   const int x = 10;
   const int w = width - 20;
   Card(x, 506, w, 72, C'7,21,30', C'0,72,102');
   Text(x + 18, CenteredTextY(512, 24, BODY_FONT_SIZE), FitText("Chiến lược: " + ModeVi(Field(payload, "setupStrategy")), w / 2 - 30, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   TextRight(x + w - 18, CenteredTextY(512, 24, BODY_FONT_SIZE), FitText("Hướng: " + SideVi(Field(payload, "setupSide")), w / 2 - 30, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   Text(x + 18, CenteredTextY(542, 24, BODY_FONT_SIZE), FitText("Lot: " + Clean(Field(payload, "setupFinalLot")), w / 2 - 30, BODY_FONT_SIZE), clrSilver, BODY_FONT_SIZE);
   TextRight(x + w - 18, CenteredTextY(542, 24, BODY_FONT_SIZE), FitText("Risk: " + Clean(Field(payload, "setupRiskPercent")) + "%", w / 2 - 30, BODY_FONT_SIZE), clrSilver, BODY_FONT_SIZE);
}

void DrawManaging(const string payload, const int width)
{
   DrawTradePlan(payload, width, true);

   const int x = 10;
   const int w = width - 20;
   string position_state = Clean(Field(payload, "positionState"), "UNMANAGED");
   string position_count = Clean(Field(payload, "positionCount"), "?");
   bool position_unmanaged = position_state == "UNMANAGED";
   color position_tone = position_unmanaged ? clrTomato : clrLimeGreen;
   string position_title = position_unmanaged
      ? "CẢNH BÁO: " + position_count + " VỊ THẾ CHƯA ĐƯỢC QUẢN LÝ"
      : "ĐANG GIỮ LỆNH";
   Card(x, 316, w, 64, position_unmanaged ? C'35,18,18' : C'8,26,20', position_tone);
   int top_y = CenteredTextY(322, 24, SECTION_FONT_SIZE);
   int bottom_y = CenteredTextY(348, 24, BODY_FONT_SIZE);
   Text(x + 18, top_y, FitText(position_title, w / 2 - 30, SECTION_FONT_SIZE), position_tone, SECTION_FONT_SIZE);
   string pnl_label = position_unmanaged ? "P/L tham chiếu: " : "Lãi/lỗ: ";
   TextRight(x + w - 18, top_y, FitText(pnl_label + Clean(Field(payload, "floatingPnlUsd")) + " USD", w / 2 - 30, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   Text(x + 18, bottom_y, FitText("Hướng: " + SideVi(Field(payload, "positionSide")) + " · Lot: " + Clean(Field(payload, "positionVolume")), w / 2 - 30, BODY_FONT_SIZE), clrSilver, BODY_FONT_SIZE);
   TextRight(x + w - 18, bottom_y, FitText(Clean(Field(payload, "floatingPnlPercent")) + "%", w / 3, BODY_FONT_SIZE), clrSilver, BODY_FONT_SIZE);

   DrawReasonSummary(payload, width, 388, "MANAGING");
}

void RenderPanel(const string payload)
{
   string ui_state = Clean(Field(payload, "uiState"), "WAITING");
   int height = ui_state == "MANAGING" ? MANAGING_HEIGHT : (ui_state == "SETUP_READY" ? SETUP_HEIGHT : WAITING_HEIGHT);
   int width = PanelWidth();
   if(!EnsureCanvas(width, height))
      return;

   BeginPanel(width, height);
   DrawHeader(payload, width,
      Field(payload, "activeMode"),
      Field(payload, "effectiveStrategy"),
      Field(payload, "regime"),
      Field(payload, "confidence"));
   DrawSystemStatus(payload, width);

   if(ui_state == "MANAGING")
      DrawManaging(payload, width);
   else if(ui_state == "SETUP_READY")
      DrawSetup(payload, width);
   else
      DrawWaiting(payload, width);

   g_canvas.Update(true);
}

void RenderError(const string title, const string message)
{
   int width = PanelWidth();
   if(!EnsureCanvas(width, 250))
      return;
   BeginPanel(width, 250);
   Card(10, 14, width - 20, 222, C'12,18,26', C'180,60,60');
   Text(28, 30, "XAUUSD AI MASTER", clrDeepSkyBlue, TITLE_FONT_SIZE);
   TextRight(width - 28, 32, LocalAccountMode() + " · CHỈ ĐỌC", clrSilver, BODY_FONT_SIZE);
   Text(28, 74, title, clrTomato, SECTION_FONT_SIZE);
   Text(28, 108, FitText(message, width - 56, BODY_FONT_SIZE), clrWhite, BODY_FONT_SIZE);
   Text(28, 148, "Cho phép WebRequest tới http://127.0.0.1:3711", clrSilver, BODY_FONT_SIZE);
   Text(28, 178, "Kiểm tra API điều khiển và cầu nối MT5.", clrSilver, BODY_FONT_SIZE);
   TextCenter(width / 2, 210, "ORDER PERMISSION = NONE", clrSilver, BODY_FONT_SIZE);
   g_canvas.Update(true);
}

void RefreshPanel()
{
   char request[];
   char response[];
   string response_headers;
   string headers = "Accept: text/plain\r\nCache-Control: no-store\r\n";
   ResetLastError();
   int status = WebRequest("GET", InpApiUrl, headers, 5000, request, response, response_headers);
   if(status == -1)
   {
      RenderError("KHÔNG GỌI ĐƯỢC API", "Lỗi WebRequest " + IntegerToString(GetLastError()));
      return;
   }
   if(status != 200)
   {
      RenderError("API CHƯA SẴN SÀNG", "Mã phản hồi " + IntegerToString(status));
      return;
   }

   string payload = CharArrayToString(response, 0, -1, CP_UTF8);
   if(Field(payload, "version") != "2")
   {
      RenderError("DỮ LIỆU GIAO DIỆN KHÔNG HỢP LỆ", "Phiên bản dữ liệu giao diện không phải 2");
      return;
   }
   if(!RuntimeMatchesTerminal(payload))
   {
      RenderError(
         "RUNTIME KHÔNG KHỚP TERMINAL",
         "Runtime " + Clean(Field(payload, "accountMode"), "CHECK") + " nhưng chart MT5 là " + LocalAccountMode() + ". Hãy dùng panel trên terminal account đang được chọn.");
      return;
   }
   RenderPanel(payload);
}

int OnInit()
{
   DestroyCanvas();
   PurgeLegacyPanelObjects();
   ChartRedraw();
   EventSetTimer((int)MathMax(1, InpRefreshSeconds));
   RefreshPanel();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   DestroyCanvas();
   PurgeLegacyPanelObjects();
   ChartRedraw();
}

void OnTimer()
{
   RefreshPanel();
}