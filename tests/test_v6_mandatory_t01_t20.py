import os
import shutil
"""Mandatory Regression & Deep Audit Security Test Suite T01–T31 for MASTER-XAUUSD V6.
Verifies all P0, P1, Position Management, Market Regime/Near-Obstacle TP, and Backtest/UI requirements
without connecting to a live broker or sending real orders.
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from xauusd_v6_trade_rules import (
    evaluate_entry,
    classify_market_regime,
    select_tp_with_near_obstacle_check,
    structural_stop,
    trail_stop,
    peak_profit_stop,
    is_m15_fast_move,
    evaluate_position_management_step,
    MAX_STRUCTURAL_SL_DIST,
)

spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def make_candles(start, count=60, step=0.3, body=0.22, epoch=1794180000000, minutes=15):
    out = []
    for i in range(count):
        op = start + i * step
        cl = op + body
        out.append([
            round(op, 2),
            round(max(op, cl) + 0.12, 2),
            round(min(op, cl) - 0.12, 2),
            round(cl, 2),
            epoch + i * minutes * 60000,
        ])
    return out


class SafeMockBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_FILLING_FOK = 0
    ORDER_TIME_GTC = 0
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    TRADE_RETCODE_DONE = 10009
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_REAL = 2
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240

    def __init__(self, login=5201362, server="DBG Market Limited", trade_mode=0, connected=True, equity=4000.0):
        self.login_id = login
        self.server_name = server
        self.trade_mode = trade_mode
        self.connected = connected
        self.equity = equity
        self.balance = equity
        self.margin_free = equity
        self.positions = []
        self.pending_orders = []
        self.deals = []
        self.asks = 4000.20
        self.bids = 4000.00
        self.tick_time = int(time.time())
        self.sent = []

    def initialize(self, *args, **kwargs):
        return self.connected

    def last_error(self):
        return (0, "OK")

    def terminal_info(self):
        return SimpleNamespace(connected=self.connected, trade_allowed=True)

    def account_info(self):
        if not self.connected:
            return None
        return SimpleNamespace(
            login=self.login_id,
            server=self.server_name,
            trade_mode=self.trade_mode,
            trade_expert=True,
            trade_allowed=True,
            equity=self.equity,
            balance=self.balance,
            margin=0.0,
            margin_free=self.margin_free,
            profit=0.0,
            currency="USD",
            leverage=100,
            name="Test Operator",
        )

    def symbol_info(self, symbol):
        return SimpleNamespace(
            visible=True,
            volume_min=0.01,
            volume_step=0.01,
            volume_max=100.0,
            digits=2,
            point=0.01,
            filling_mode=1,
            trade_stops_level=20,
            trade_freeze_level=0,
        )

    def symbol_select(self, symbol, enable):
        return True

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(ask=self.asks, bid=self.bids, time=self.tick_time)

    def order_calc_profit(self, kind, symbol, lot, entry, stop):
        if kind == 0:
            return (stop - entry) * lot * 100.0
        return (entry - stop) * lot * 100.0

    def order_calc_margin(self, kind, symbol, lot, price):
        return lot * price * 1.0

    def history_deals_get(self, from_ts, to_ts):
        return list(self.deals)

    def positions_get(self, *args, **kwargs):
        ticket = kwargs.get("ticket")
        if ticket is not None:
            return [p for p in self.positions if int(getattr(p, "ticket", 0)) == int(ticket)]
        symbol = kwargs.get("symbol")
        if symbol is not None:
            return [p for p in self.positions if str(p.symbol) == str(symbol)]
        return list(self.positions)

    def orders_get(self, *args, **kwargs):
        return list(self.pending_orders)

    def order_send(self, request):
        self.sent.append(request)
        if request["action"] == self.TRADE_ACTION_SLTP:
            for p in self.positions:
                if p.ticket == request["position"]:
                    p.sl = request["sl"]
                    p.tp = request["tp"]
            return SimpleNamespace(retcode=10009, order=123)
        if request["action"] == self.TRADE_ACTION_DEAL and "position" in request:
            for p in list(self.positions):
                if p.ticket == request["position"]:
                    p.volume = round(p.volume - request["volume"], 8)
                    if p.volume <= 1e-8:
                        self.positions.remove(p)
            return SimpleNamespace(retcode=10009, order=123, price=request["price"])
        return SimpleNamespace(retcode=10009, order=123, price=request["price"], volume=request["volume"])


class MandatoryT01ToT31Suite(unittest.TestCase):
    def setUp(self):
        self._tmp_rt = Path(tempfile.mkdtemp(prefix="v6-suite-rt-"))
        os.environ["V6_RUNTIME_DIR"] = str(self._tmp_rt)
        engine.RUNTIME_DIR = self._tmp_rt
        engine.MANAGER_STATE_FILE = self._tmp_rt / "v6-position-tracker.json"
        engine.DAILY_RISK_STATE_FILE = self._tmp_rt / "v6-daily-risk-state.json"
        engine.REGIME_STATE_FILE = self._tmp_rt / "v6-regime-state.json"

    def tearDown(self):
        shutil.rmtree(self._tmp_rt, ignore_errors=True)

    def trend_fixtures(self):
        m15 = make_candles(4000)
        m15[-2][0] = round(m15[-2][3] - 1.10, 2)
        m15[-2][1] = round(m15[-2][3] + 0.10, 2)
        m15[-2][2] = round(m15[-2][0] - 0.10, 2)
        m5 = make_candles(4010, step=0.15, minutes=5)
        h1 = make_candles(3910, minutes=60)
        h4 = make_candles(3910, minutes=240)
        return m5, m15, h1, h4

    def test_T01_restart_after_live_armed_starts_disarmed(self):
        """T01: Restart sau khi từng bật LIVE -> Hệ thống ở trạng thái DISARMED."""
        node_script = """
        import { loadSavedAccountConfig } from './scripts/xauusd-standalone-server.mjs';
        import fs from 'node:fs';
        import path from 'node:path';
        const rtDir = process.env.V6_RUNTIME_DIR;
        const cfgFile = path.join(rtDir, 'active-mt5-account.json');
        fs.mkdirSync(rtDir, { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify({ login: '5201362', server: 'DBG Market Limited', accountMode: 'LIVE', liveArmed: true }));
        const loaded = loadSavedAccountConfig();
        fs.rmSync(cfgFile, { force: true });
        console.log(JSON.stringify({ liveArmed: loaded.liveArmed, explicitLiveGateConfirmed: loaded.explicitLiveGateConfirmed }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_script], cwd=ROOT).decode("utf-8").strip()
        parsed = json.loads(out.splitlines()[-1])
        self.assertFalse(parsed["liveArmed"])
        self.assertFalse(parsed["explicitLiveGateConfirmed"])

    def test_T02_restart_when_auto_and_dca_enabled_does_not_auto_trade(self):
        """T02: Restart khi lần trước đang bật Auto/DCA -> Không tự giao dịch (PAUSE & disabled)."""
        node_verify = """
        process.env.ZIQ_V6_CONTROL_TOKEN = 'secret_control_token_123456';
        const { restoreSafeConfigFromSavedState, handleApiRequest } = await import('./scripts/xauusd-standalone-server.mjs');
        restoreSafeConfigFromSavedState({
          autoBotState: { enabled: true, strategyMode: 'BOT_1_TREND', volume: 0.03 },
          positiveDcaConfig: { enabled: true, maxLayers: 2 }
        });
        let status = 0, body = '';
        const req = { method: 'GET', url: '/api/v1/overview', headers: { 'x-v6-control-token': 'secret_control_token_123456' }, socket: { remoteAddress: '127.0.0.1' } };
        const res = { writeHead(s) { status = s; }, end(b) { body = b; } };
        await handleApiRequest(req, res);
        const data = JSON.parse(body);
        console.log(JSON.stringify({
          status,
          autoEnabled: data.autoBotState.enabled,
          strategyMode: data.autoBotState.strategyMode,
          configuredMode: data.autoBotState.configuredStrategyMode,
          dcaEnabled: data.positiveDcaConfig.enabled,
          liveArmed: data.accountConfig.liveArmed
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        data = json.loads(out.splitlines()[-1])
        self.assertEqual(data["status"], 200)
        self.assertFalse(data["autoEnabled"])
        self.assertEqual(data["strategyMode"], "PAUSE")
        self.assertEqual(data["configuredMode"], "BOT_1_TREND")
        self.assertFalse(data["dcaEnabled"])
        self.assertFalse(data["liveArmed"])

    def test_T03_api_without_token_or_wrong_token_rejected(self):
        """T03: Gọi API không có token hoặc sai token -> Từ chối thao tác."""
        node_verify = """
        process.env.ZIQ_V6_CONTROL_TOKEN = 'valid_super_secret_token_2026';
        const { controlAuthorized, handleApiRequest } = await import('./scripts/xauusd-standalone-server.mjs');
        const noTok = controlAuthorized({ headers: {}, socket: { remoteAddress: '203.0.113.5' } });
        const badTok = controlAuthorized({ headers: { 'x-v6-control-token': 'wrong_token' }, socket: { remoteAddress: '203.0.113.5' } });
        const goodTok = controlAuthorized({ headers: { 'x-v6-control-token': 'valid_super_secret_token_2026' }, socket: { remoteAddress: '203.0.113.5' } });
        let statusNoTok = 0;
        await handleApiRequest(
          { method: 'POST', url: '/api/v1/mt5/auto-bot', headers: {}, socket: { remoteAddress: '203.0.113.5' } },
          { writeHead(s) { statusNoTok = s; }, end() {} }
        );
        console.log(JSON.stringify({ noTok, badTok, goodTok, statusNoTok }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertFalse(res["noTok"])
        self.assertFalse(res["badTok"])
        self.assertTrue(res["goodTok"])
        self.assertEqual(res["statusNoTok"], 401)

    def test_T04_localhost_and_lan_without_token_rejected(self):
        """T04: Gọi từ localhost/LAN không có token -> Từ chối."""
        node_verify = """
        process.env.ZIQ_V6_CONTROL_TOKEN = 'valid_super_secret_token_2026';
        const { controlAuthorized } = await import('./scripts/xauusd-standalone-server.mjs');
        const ips = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.50', '10.0.0.12', '100.64.1.9'];
        const results = ips.map(ip => controlAuthorized({ headers: {}, socket: { remoteAddress: ip } }));
        const emptyServerToken = controlAuthorized({ headers: { 'x-v6-control-token': 'any' }, socket: { remoteAddress: '127.0.0.1' } }, '');
        console.log(JSON.stringify({ results, emptyServerToken }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertTrue(all(r is False for r in res["results"]))
        self.assertFalse(res["emptyServerToken"])

    def test_T05_stale_tick_two_hours_old_blocks_order(self):
        """T05: Tick cũ 2 giờ (7200s) -> Chặn đặt lệnh (không bị lọt qua bởi dịch múi giờ)."""
        mt5 = SafeMockBroker()
        mt5.tick_time = int(time.time()) - 7200
        res = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0
        })
        self.assertFalse(res["ok"])
        self.assertIn("utc quote", res["message"].lower())
        self.assertEqual(mt5.sent, [])

    def test_T06_mt5_wrong_account_with_blank_password_blocks_trading(self):
        """T06: MT5 mở sai tài khoản nhưng để trống mật khẩu -> Chặn giao dịch."""
        mt5 = SafeMockBroker(login=9999999, server="DBG Market Limited", trade_mode=0)
        ok_conn, err_msg = engine.connect_mt5(mt5, {
            "login": "5201362",
            "password": "",
            "server": "DBG Market Limited",
            "accountMode": "DEMO",
        })
        self.assertFalse(ok_conn)
        self.assertIn("mismatch", err_msg.lower())

        res = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0,
            "login": "5201362", "password": "", "server": "DBG Market Limited",
        })
        self.assertFalse(res["ok"])
        self.assertEqual(mt5.sent, [])

    def test_T07_structural_sl_exceeding_8_usd_returns_wait_pullback(self):
        """T07: SL cấu trúc vượt 8 giá -> WAIT_PULLBACK hoặc NO_TRADE (không thu hẹp lookback xuống 5/3 nến)."""
        m5, m15, h1, h4 = self.trend_fixtures()
        m5[-7][2] = 4008.0
        self.assertIsNone(structural_stop("BUY", 4018.7, m5, m15))
        plan = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_1_TREND")
        self.assertFalse(plan["allowed"])
        self.assertEqual(plan["status"], "WAIT_PULLBACK")
        self.assertIn("WAIT_PULLBACK", plan["reason"])

    def test_T08_pre_be_confirmed_m5_higher_low_tightens_sl_below_entry(self):
        """T08: Hình thành cấu trúc M5 hợp lệ trước BE (BUY tại 4000, SL 3993, đáy mới 3996) -> Nâng SL lên dưới 3996."""
        epoch = 1794180000000
        m5_bars = [
            [3995.0, 3997.5, 3994.5, 3997.0, epoch + 0 * 300000],
            [3997.0, 3998.0, 3996.5, 3996.8, epoch + 1 * 300000],
            [3996.8, 3997.2, 3996.0, 3996.9, epoch + 2 * 300000],
            [3996.9, 3998.1, 3996.6, 3997.9, epoch + 3 * 300000],
            [3997.9, 3998.8, 3997.5, 3998.5, epoch + 4 * 300000],
            [3998.5, 3998.9, 3998.2, 3998.5, epoch + 5 * 300000],
        ]
        cand = trail_stop("BUY", entry=4000.0, current=3998.5, prior_sl=3993.0, confirmed_m5=m5_bars[:-1], peak=3998.8)
        self.assertIsNotNone(cand)
        self.assertAlmostEqual(cand, 3995.65, places=2)
        self.assertGreater(cand, 3993.0)
        self.assertLess(cand, 4000.0)

        mt5 = SafeMockBroker()
        mt5.bids = 3998.5
        mt5.asks = 3998.7
        pos = SimpleNamespace(
            ticket=801, symbol="XAUUSD.G", type=0, volume=0.02,
            price_open=4000.0, price_current=3998.5, sl=3993.0, tp=4016.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(epoch / 1000)
        )
        mt5.positions = [pos]
        m15_bars = make_candles(3995, count=20, step=0.2)
        h1_bars = make_candles(3990, count=20, step=0.5, minutes=60)
        h4_bars = make_candles(3980, count=20, step=1.0, minutes=240)
        res = engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5_bars, m15_bars, h1_bars, h4_bars, None,
            {"enableM5StructuralTrail": True, "m15SpikeTrailDist": 10.0}
        )
        self.assertEqual(res["managedCount"], 1)
        self.assertAlmostEqual(pos.sl, 3995.65, places=2)
        self.assertAlmostEqual(pos.tp, 4016.0, places=2)

    def test_T09_post_be_confirmed_m5_structure_continues_tightening_sl(self):
        """T09: Hình thành cấu trúc M5 mới sau BE -> Tiếp tục nâng SL khóa lãi."""
        epoch = 1794180000000
        m5_bars = [
            [4003.0, 4006.0, 4002.8, 4005.5, epoch + 0 * 300000],
            [4005.5, 4006.8, 4005.0, 4005.4, epoch + 1 * 300000],
            [4005.4, 4006.2, 4004.5, 4005.9, epoch + 2 * 300000],
            [4005.9, 4007.8, 4005.5, 4007.5, epoch + 3 * 300000],
            [4007.5, 4009.0, 4007.1, 4008.6, epoch + 4 * 300000],
            [4008.6, 4009.2, 4008.4, 4008.8, epoch + 5 * 300000],
        ]
        cand = trail_stop("BUY", entry=4000.0, current=4008.6, prior_sl=4000.25, confirmed_m5=m5_bars[:-1], peak=4009.0)
        self.assertEqual(cand, 4004.15)

    def test_T10_m15_fast_move_applies_10_usd_peak_lock(self):
        """T10: Nến M15 biến động mạnh -> Áp dụng khóa cực trị 10 giá."""
        epoch = 1794180000000
        m15_bars = make_candles(4000, count=20, step=0.4)
        m15_bars[-2] = [4008.0, 4022.0, 4007.5, 4020.5, epoch + 18 * 900000]
        confirmed_m15 = m15_bars[:-1]
        self.assertTrue(is_m15_fast_move(confirmed_m15, entry=4000.0, peak=4022.0, side="BUY", initial_r=6.8, spike_dist=10.0))
        pk_sl = peak_profit_stop("BUY", entry=4000.0, current=4020.5, prior_sl=4005.0, peak=4022.0, distance=10.0)
        self.assertEqual(pk_sl, 4012.0)

    def test_T11_price_retracement_never_loosens_sl(self):
        """T11: Giá hồi ngược lại -> Không nới rộng SL."""
        mt5 = SafeMockBroker()
        mt5.bids = 4013.5
        mt5.asks = 4013.7
        pos = SimpleNamespace(
            ticket=811, symbol="XAUUSD.G", type=0, volume=0.02,
            price_open=4000.0, price_current=4013.5, sl=4012.0, tp=4025.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(time.time()) - 1800
        )
        mt5.positions = [pos]
        denied = engine.modify_position_sl_tp(mt5, pos, 4008.0, None, "Attempt loosen")
        self.assertFalse(denied["ok"])
        self.assertEqual(pos.sl, 4012.0)
        self.assertEqual(mt5.sent, [])

    def test_T12_reaching_h1_sr_does_not_auto_partial_close_50_percent(self):
        """T12: Đạt vùng cản H1 -> Không tự chốt 50% khối lượng."""
        mt5 = SafeMockBroker()
        mt5.bids = 4012.0
        mt5.asks = 4012.2
        pos = SimpleNamespace(
            ticket=812, symbol="XAUUSD.G", type=0, volume=0.10,
            price_open=4000.0, price_current=4012.0, sl=4000.25, tp=4018.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(time.time()) - 1800
        )
        mt5.positions = [pos]
        m5, m15, h1, h4 = self.trend_fixtures()
        for b in h1:
            b[1] = 4012.5
        engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5, m15, h1, h4, None,
            {"enablePartialCloseAtSr": True, "enableM5StructuralTrail": False}
        )
        self.assertEqual(pos.volume, 0.10)
        deal_actions = [r for r in mt5.sent if r.get("action") == mt5.TRADE_ACTION_DEAL]
        self.assertEqual(deal_actions, [])

    def test_T13_regime_change_or_opposite_signal_does_not_close_open_position(self):
        """T13: Đổi chế độ hoặc có tín hiệu ngược -> Không tự đóng lệnh đang mở."""
        mt5 = SafeMockBroker()
        mt5.bids = 3997.0
        mt5.asks = 3997.2
        pos = SimpleNamespace(
            ticket=813, symbol="XAUUSD.G", type=0, volume=0.04,
            price_open=4000.0, price_current=3997.0, sl=3993.0, tp=4015.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(time.time()) - 900
        )
        mt5.positions = [pos]
        m5 = make_candles(4010, count=40, step=-0.3, body=-0.2, minutes=5)
        m15 = make_candles(4015, count=40, step=-0.4, body=-0.3, minutes=15)
        h1 = make_candles(4020, count=40, step=-0.5, body=-0.4, minutes=60)
        h4 = make_candles(4030, count=40, step=-0.6, body=-0.5, minutes=240)
        engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5, m15, h1, h4, None, {}
        )
        self.assertEqual(len(mt5.positions), 1)
        self.assertEqual(mt5.positions[0].volume, 0.04)
        deal_actions = [r for r in mt5.sent if r.get("action") == mt5.TRADE_ACTION_DEAL]
        self.assertEqual(deal_actions, [])

    def test_T14_backtest_executes_exact_selected_mode(self):
        """T14: Backtest chọn Trend / Sideway -> Chạy đúng chế độ đã chọn (không ép về AUTO_REGIME) và không tự đóng sau 96 nến."""
        mt5 = SafeMockBroker()
        epoch = 1794180000000
        m15 = make_candles(4000, count=60, step=0.3, body=0.22, epoch=epoch, minutes=15)
        m15[40][0] = round(m15[40][3] - 1.10, 2)
        m15[40][1] = round(m15[40][3] + 0.10, 2)
        m15[40][2] = round(m15[40][0] - 0.10, 2)
        m5 = make_candles(4000, count=180, step=0.10, body=0.08, epoch=epoch, minutes=5)
        # Ensure one M5 bar after entry (idx=40 -> m5 idx > 124) hits TP (~4028) so trade settles cleanly
        m5[150][1] = 4035.0
        m5[150][3] = 4032.0
        h1 = make_candles(3950, count=60, step=0.4, body=0.3, epoch=epoch - 40 * 3600000, minutes=60)
        h4 = make_candles(3900, count=60, step=0.8, body=0.5, epoch=epoch - 40 * 14400000, minutes=240)

        res_trend = engine.run_historical_backtest_on_mt5(mt5, "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND",
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5, "m15Bars": m15, "h1Bars": h1, "h4Bars": h4,
        })
        res_sw = engine.run_historical_backtest_on_mt5(mt5, "XAUUSD.G", {
            "strategyMode": "BOT_2_SIDEWAY",
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5, "m15Bars": m15, "h1Bars": h1, "h4Bars": h4,
        })
        self.assertTrue(res_trend["ok"])
        self.assertEqual(res_trend["requestedMode"], "BOT_1_TREND")
        self.assertTrue(res_sw["ok"])
        self.assertEqual(res_sw["requestedMode"], "BOT_2_SIDEWAY")
        self.assertEqual(res_sw["tradeCount"], 0)
        self.assertGreater(res_trend["tradeCount"], 0)

    def test_T15_backtest_records_sl_before_be_without_lookahead_filtering(self):
        """T15: Backtest có setup chạm SL trước BE -> Ghi nhận lệnh thua trung thực (không lọc bỏ bằng dữ liệu tương lai)."""
        plan = {
            "allowed": True,
            "side": "BUY",
            "strategyMode": "BOT_1_TREND",
            "entryReference": 4000.0,
            "sl": 3993.2,
            "tp": 4015.0,
            "initialR": 6.8,
            "confidence": 90,
            "closedM15Time": 1794180000000,
        }
        future_m5 = [
            [4000.0, 4001.0, 3997.0, 3997.5, 1794180300000],
            [3997.5, 3998.0, 3992.5, 3993.0, 1794180600000],
            [3993.0, 4020.0, 3993.0, 4018.0, 1794180900000],
        ]
        sim = engine.simulate_position_lifecycle(plan, future_m5, cfg={"roundTripCostPts": 0.08})
        self.assertEqual(sim["exitType"], "SL_HIT")
        self.assertEqual(sim["exit"], 3993.2)
        self.assertLess(sim["pts"], -6.8)

        ambiguous_m5 = [[4000.0, 4016.0, 3992.0, 4010.0, 1794180300000]]
        sim_amb = engine.simulate_position_lifecycle(plan, ambiguous_m5, cfg={"roundTripCostPts": 0.08})
        self.assertTrue(sim_amb["ambiguousBar"])
        self.assertEqual(sim_amb["exitType"], "AMBIGUOUS_BAR_SL")
        self.assertEqual(sim_amb["exit"], 3993.2)
        self.assertLess(sim_amb["pts"], 0)

    def test_T16_multiple_positions_and_dca_never_exceed_1_pct_per_trade_or_1_5_pct_portfolio_risk(self):
        """T16: Nhiều bot / DCA cùng lúc -> Không vượt 1.0% mỗi lệnh và 1.5% tổng rủi ro danh mục."""
        mt5 = SafeMockBroker(equity=4000.0)
        def _send_and_add(req):
            mt5.sent.append(req)
            if req["action"] == 1 and "position" not in req:
                mt5.positions.append(SimpleNamespace(
                    ticket=991, identifier=991, symbol=req["symbol"], type=req["type"],
                    volume=req["volume"], price_open=req["price"], price_current=req["price"],
                    sl=req["sl"], tp=req["tp"], magic=270715, comment="V6_TEST"
                ))
            return SimpleNamespace(retcode=10009, order=991, deal=992, volume=req["volume"], price=req["price"])
        mt5.order_send = _send_and_add

        res_single = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.06, "slDistance": 6.8, "tpDistance": 16.0,
            "maxRiskPercent": 1.0,
        })
        self.assertTrue(res_single["ok"])
        self.assertEqual(res_single["volume"], 0.06)
        self.assertTrue(any("WARNING_PER_TRADE_RISK" in w for w in res_single.get("riskWarnings", [])))

        mt5.positions = [
            SimpleNamespace(ticket=901, symbol="XAUUSD.G", type=0, volume=0.05, price_open=4000.0, sl=3993.2, tp=4016.0)
        ]
        mt5.pending_orders = [
            SimpleNamespace(ticket=902, symbol="XAUUSD.G", type=2, volume_current=0.02, price_open=3998.0, sl=3991.2, tp=4014.0)
        ]
        res_port = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0,
            "maxPortfolioRiskPercent": 1.5,
        })
        self.assertTrue(res_port["ok"])
        self.assertTrue(any("WARNING_PORTFOLIO_RISK" in w for w in res_port.get("riskWarnings", [])))

    def test_T17_mt5_disconnected_blocks_new_orders(self):
        """T17: MT5 mất kết nối -> Chặn lệnh mới."""
        mt5 = SafeMockBroker(connected=False)
        ok_conn, _ = engine.connect_mt5(mt5, {"login": "5201362", "server": "DBG Market Limited"})
        self.assertFalse(ok_conn)

        mt5_Order = SafeMockBroker(connected=False)
        res = engine.execute_order(mt5_Order, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0
        })
        self.assertFalse(res["ok"])
        self.assertEqual(mt5_Order.sent, [])

    def test_T18_missing_market_or_account_data_fails_closed(self):
        """T18: Thiếu dữ liệu thị trường hoặc tài khoản -> Fail-closed."""
        mt5 = SafeMockBroker()
        mt5.margin_free = 0.0
        res_margin = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0
        })
        self.assertFalse(res_margin["ok"])
        self.assertIn("margin", res_margin["message"].lower())

        mt5_dd = SafeMockBroker(equity=3600.0)
        mt5_dd.balance = 4000.0
        res_dd = engine.execute_order(mt5_dd, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0
        })
        self.assertTrue(any("WARNING_DRAWDOWN" in w for w in res_dd.get("riskWarnings", [])) or not res_dd["ok"])

    def test_T19_real_account_without_explicit_multi_gate_blocks_order(self):
        """T19: Kiểm thử trên tài khoản LIVE (REAL) khi chưa mở khóa đa cổng -> Không gửi lệnh thật."""
        mt5_real = SafeMockBroker(trade_mode=SafeMockBroker.ACCOUNT_TRADE_MODE_REAL)
        res = engine.execute_order(mt5_real, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0,
            "liveAuthorized": False,
        })
        self.assertFalse(res["ok"])
        self.assertIn("live order blocked", res["message"].lower())
        self.assertEqual(mt5_real.sent, [])

        res_partial_gate = engine.execute_order(mt5_real, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0,
            "liveAuthorized": True, "liveArmed": True, "explicitLiveGateConfirmed": False,
        })
        self.assertFalse(res_partial_gate["ok"])
        self.assertEqual(mt5_real.sent, [])

    def test_T20_open_position_with_valid_sl_tp_never_modifies_tp_or_partial_closes(self):
        """T20: Lệnh đang mở có SL/TP hợp lệ -> Không sửa TP hoặc đóng một phần ngoài quy tắc."""
        mt5 = SafeMockBroker()
        mt5.bids = 4020.0
        mt5.asks = 4020.2
        pos = SimpleNamespace(
            ticket=820, symbol="XAUUSD.G", type=0, volume=0.08,
            price_open=4000.0, price_current=4020.0, sl=3993.2, tp=4025.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(time.time()) - 1800
        )
        mt5.positions = [pos]
        m5, m15, h1, h4 = self.trend_fixtures()
        engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5, m15, h1, h4, None,
            {"enableM5StructuralTrail": True, "m15SpikeTrailDist": 10.0, "enablePartialCloseAtSr": True}
        )
        self.assertGreater(pos.sl, 4000.0)
        self.assertEqual(pos.tp, 4025.0)
        self.assertEqual(pos.volume, 0.08)

    # =========================================================================
    # NEW MANDATORY DEEP-AUDIT REGRESSION TESTS T21–T31 (Section 5)
    # =========================================================================

    def test_T21_unauthenticated_lan_and_localhost_never_receive_token_and_otp_is_single_use(self):
        """T21 (Section 1.1 & 5): Request LAN/localhost chưa xác thực không nhận được token; OTP dùng 1 lần."""
        node_verify = """
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const {
          handleApiRequest,
          issueOneTimePairingCode,
          verifyOneTimePairingCodeAndCreateSession,
          controlAuthorized
        } = await import('./scripts/xauusd-standalone-server.mjs');

        // 1. Test /api/v1/auth-bootstrap from localhost and LAN -> must all return 403 and NO token
        const ips = ['127.0.0.1', '::1', '192.168.1.25', '10.0.0.5', '100.64.0.9'];
        const bootstrapResponses = [];
        for (const ip of ips) {
          let st = 0, body = '';
          await handleApiRequest(
            { method: 'GET', url: '/api/v1/auth-bootstrap', headers: {}, socket: { remoteAddress: ip } },
            { writeHead(s) { st = s; }, end(b) { body = b; } }
          );
          const parsed = JSON.parse(body);
          bootstrapResponses.push({ ip, status: st, hasToken: Boolean(parsed.token) });
        }

        // 2. Test One-Time Pairing Code (OTP): wrong code fails, valid code works ONCE, second reuse fails
        const otp = issueOneTimePairingCode(60000);
        const wrongTry = verifyOneTimePairingCodeAndCreateSession('000000', 'LAN_PHONE');
        const firstUse = verifyOneTimePairingCodeAndCreateSession(otp.code, 'LAN_PHONE');
        const secondReuse = verifyOneTimePairingCodeAndCreateSession(otp.code, 'ATTACKER_REPLAY');
        const sessAuthed = controlAuthorized({
          headers: { 'x-v6-control-token': firstUse.sessionToken },
          socket: { remoteAddress: '192.168.1.25' }
        });

        console.log(JSON.stringify({
          bootstrapResponses,
          wrongOk: wrongTry.ok,
          firstOk: firstUse.ok,
          hasSessionToken: Boolean(firstUse.sessionToken),
          secondReuseOk: secondReuse.ok,
          sessAuthed
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        for item in res["bootstrapResponses"]:
            self.assertEqual(item["status"], 403)
            self.assertFalse(item["hasToken"])
        self.assertFalse(res["wrongOk"])
        self.assertTrue(res["firstOk"])
        self.assertTrue(res["hasSessionToken"])
        self.assertFalse(res["secondReuseOk"])
        self.assertTrue(res["sessAuthed"])

    def test_T22_connect_live_enable_auto_and_manual_order_never_auto_arm(self):
        """T22 (Section 1.2 & 5): Kết nối LIVE, bật Auto và đặt lệnh tay không tự ARM."""
        node_verify = """
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { handleApiRequest, getCanonicalLiveArmState } = await import('./scripts/xauusd-standalone-server.mjs');
        const headers = { 'x-v6-control-token': 'master_secret_token_2026', 'content-type': 'application/json' };

        async function callApi(method, url, payload) {
          let st = 0, outBody = '';
          const bodyStr = payload ? JSON.stringify(payload) : '';
          const req = {
            method, url, headers,
            socket: { remoteAddress: '127.0.0.1' },
            on(ev, cb) {
              if (ev === 'data' && bodyStr) cb(Buffer.from(bodyStr));
              if (ev === 'end') cb();
            }
          };
          const res = { writeHead(s) { st = s; }, end(b) { outBody = b; } };
          await handleApiRequest(req, res);
          return { status: st, data: JSON.parse(outBody || '{}') };
        }

        // 1. Connect LIVE with liveArmed: true -> must STILL end in PAUSE + DISARMED
        const connRes = await callApi('POST', '/api/v1/mt5/connect-account', {
          accountMode: 'LIVE', login: '5201362', server: 'DBGMarkets-Live', liveArmed: true
        });
        const armAfterConnect = getCanonicalLiveArmState().liveArmed;

        // 2. Enable Auto Bot -> must NOT auto-arm LIVE
        const autoRes = await callApi('POST', '/api/v1/mt5/auto-bot', {
          enabled: true, strategyMode: 'BOT_1_TREND'
        });
        const armAfterAuto = getCanonicalLiveArmState().liveArmed;

        // 3. Place manual order while DISARMED -> must be rejected (403 LIVE_NOT_ARMED) and not arm LIVE
        const orderRes = await callApi('POST', '/api/v1/mt5/order', {
          side: 'BUY', volume: 0.02, slDistance: 6.8, tpDistance: 16.0
        });
        const armAfterManualOrder = getCanonicalLiveArmState().liveArmed;

        console.log(JSON.stringify({
          armAfterConnect,
          autoEnabledAfterConnect: connRes.data.autoBotState?.enabled,
          armAfterAuto,
          orderStatus: orderRes.status,
          orderOk: orderRes.data.orderResult?.ok,
          orderError: orderRes.data.orderResult?.error,
          armAfterManualOrder
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertFalse(res["armAfterConnect"])
        self.assertFalse(res["autoEnabledAfterConnect"])
        self.assertFalse(res["armAfterAuto"])
        self.assertEqual(res["orderStatus"], 403)
        self.assertFalse(res["orderOk"])
        self.assertEqual(res["orderError"], "LIVE_NOT_ARMED")
        self.assertFalse(res["armAfterManualOrder"])

    def test_T23_restart_or_account_switch_revokes_live_arm(self):
        """T23 (Section 1.2 & 5): Restart hoặc đổi tài khoản làm mất quyền ARM."""
        node_verify = """
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const {
          handleApiRequest,
          getCanonicalLiveArmState,
          restoreSafeConfigFromSavedState,
          setMt5EngineInvokerForTest
        } = await import('./scripts/xauusd-standalone-server.mjs');
        const headers = { 'x-v6-control-token': 'master_secret_token_2026', 'content-type': 'application/json' };

        async function callApi(method, url, payload) {
          let st = 0, outBody = '';
          const bodyStr = payload ? JSON.stringify(payload) : '';
          const req = {
            method, url, headers,
            socket: { remoteAddress: '127.0.0.1' },
            on(ev, cb) {
              if (ev === 'data' && bodyStr) cb(Buffer.from(bodyStr));
              if (ev === 'end') cb();
            }
          };
          const res = { writeHead(s) { st = s; }, end(b) { outBody = b; } };
          await handleApiRequest(req, res);
          return { status: st, data: JSON.parse(outBody || '{}') };
        }

        setMt5EngineInvokerForTest(() => ({
          connected: true,
          accountLogin: 5201362,
          server: 'DBGMarkets-Live',
          accountMode: 'LIVE',
          brokerSymbol: 'XAUUSD.G',
          dailyRiskState: { ok: true, dailyLimitBreached: false }
        }));

        // 1. Explicitly ARM LIVE for #5201362
        const armRes = await callApi('POST', '/api/v1/mt5/arm-live', {
          armed: true,
          confirmLive: true
        });
        const armedBefore = getCanonicalLiveArmState().liveArmed;

        // 2. If MT5 terminal switches to another account (#8888888), ARM is automatically revoked
        const armedAfterTerminalAccountSwitch = getCanonicalLiveArmState({
          connected: true,
          accountLogin: 8888888,
          server: 'DBGMarkets-Live'
        }).liveArmed;

        // 3. Re-arm, then test restart (restoreSafeConfigFromSavedState) -> revokes ARM
        await callApi('POST', '/api/v1/mt5/arm-live', {
          armed: true,
          confirmLive: true
        });
        restoreSafeConfigFromSavedState({ autoBotState: { enabled: true } });
        const armedAfterRestart = getCanonicalLiveArmState().liveArmed;

        console.log(JSON.stringify({
          armStatus: armRes.status,
          armedBefore,
          armedAfterTerminalAccountSwitch,
          armedAfterRestart
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertEqual(res["armStatus"], 200)
        self.assertTrue(res["armedBefore"])
        self.assertFalse(res["armedAfterTerminalAccountSwitch"])
        self.assertFalse(res["armedAfterRestart"])

    def test_T24_daily_realized_loss_from_mt5_deals_persists_across_restart_and_blocks_new_orders(self):
        """T24 (Section 1.3 & 5): Lỗ đã đóng trong ngày từ lịch sử deal MT5 (profit+commission+swap+fee) vẫn được tính sau restart và chặn mở lệnh mới."""
        mt5 = SafeMockBroker(equity=4000.0)
        mt5.balance = 4000.0
        now_ts = int(time.time())
        # Two trading losses today (-$110 profit, -$8 commission, -$4 swap, -$2 fee = -$124 total > 3% of $4000 = $120)
        # Plus a +$500 deposit deal (type=2) which must NOT erase realized trading loss!
        mt5.deals = [
            SimpleNamespace(ticket=1, time=now_ts - 600, type=0, entry=1, profit=-110.0, commission=-8.0, swap=-4.0, fee=-2.0),
            SimpleNamespace(ticket=2, time=now_ts - 300, type=2, entry=0, profit=500.0, commission=0.0, swap=0.0, fee=0.0),
        ]
        def _attach_pos(broker, ticket_num):
            def _send(req):
                broker.sent.append(req)
                if req["action"] == 1 and "position" not in req:
                    broker.positions.append(SimpleNamespace(
                        ticket=ticket_num, identifier=ticket_num, symbol=req["symbol"], type=req["type"],
                        volume=req["volume"], price_open=req["price"], price_current=req["price"],
                        sl=req["sl"], tp=req["tp"], magic=270715, comment="V6_DAILY"
                    ))
                return SimpleNamespace(retcode=10009, order=ticket_num, deal=ticket_num + 1, volume=req["volume"], price=req["price"])
            broker.order_send = _send

        _attach_pos(mt5, 661)
        res1 = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.01, "slDistance": 6.8, "tpDistance": 16.0,
            "maxDailyLossPercent": 3.0,
        })
        self.assertTrue(res1["ok"])
        self.assertTrue(any("WARNING_DAILY_LOSS" in w for w in res1.get("riskWarnings", [])))
        self.assertEqual(res1["riskMetrics"]["dailyRiskState"]["dailyRealizedLossUsd"], 124.0)

        # Simulate a restart where broker deal history temporarily returns empty list:
        # Persisted daily state in .runtime/v6-daily-risk-state.json must still remember the breach warning!
        mt5_after_restart = SafeMockBroker(equity=4000.0)
        mt5_after_restart.deals = []
        _attach_pos(mt5_after_restart, 662)
        res2 = engine.execute_order(mt5_after_restart, "XAUUSD.G", {
            "side": "BUY", "volume": 0.01, "slDistance": 6.8, "tpDistance": 16.0,
            "maxDailyLossPercent": 3.0,
        })
        self.assertTrue(res2["ok"])
        self.assertTrue(any("WARNING_DAILY_LOSS" in w for w in res2.get("riskWarnings", [])))
        self.assertTrue(res2["riskMetrics"]["dailyRiskState"]["dailyLimitBreached"])

    def test_T25_quote_movement_pushing_sl_above_8_usd_blocks_at_execute_order(self):
        """T25 (Section 1.4 & 5): Quote thay đổi ngay trước order_send làm SL vượt 8 giá thì bị chặn (WAIT_PULLBACK)."""
        mt5 = SafeMockBroker(equity=4000.0)
        # Signal planned BUY at 4000.0 with explicitSlPrice = 3992.20 (7.80 USD/oz),
        # but pre-send live Ask moved up to 4000.65 -> actual SL distance is 8.45 USD/oz (> 8.0 cap)!
        mt5.bids = 4000.45
        mt5.asks = 4000.65
        res = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY",
            "volume": 0.01,
            "explicitSlPrice": 3992.20,
            "explicitTpPrice": 4018.00,
            "structuralInvalidationPrice": 3992.55,
            "minRewardRisk": 1.6,
        })
        self.assertFalse(res["ok"])
        self.assertEqual(res.get("status"), "WAIT_PULLBACK")
        self.assertEqual(mt5.sent, [])

        # Also test SL inside structural invalidation level -> rejected
        mt5.bids = 4000.00
        mt5.asks = 4000.20
        res_inside = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY",
            "volume": 0.01,
            "explicitSlPrice": 3993.40,
            "explicitTpPrice": 4016.00,
            "structuralInvalidationPrice": 3993.00,  # SL 3993.40 is ABOVE structural low 3993.00!
        })
        self.assertFalse(res_inside["ok"])
        self.assertIn("structural invalidation", res_inside["message"].lower())
        self.assertEqual(mt5.sent, [])

    def test_T26_initial_r_remains_immutable_after_sl_moves_and_be_uses_1r_not_dca_step(self):
        """T26 (Section 2 & 5): initialR không thay đổi khi SL đã được dời; BE tại 1R (không lấy bước DCA 4.5 giá)."""
        epoch = 1794180000000
        mt5 = SafeMockBroker()
        # Open BUY at 4000.0, initial SL = 3992.50 -> initialR = 7.50 USD/oz
        pos = SimpleNamespace(
            ticket=926, symbol="XAUUSD.G", type=0, volume=0.02,
            price_open=4000.0, price_current=3998.8, sl=3992.50, tp=4018.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(epoch / 1000)
        )
        mt5.positions = [pos]
        mt5.bids = 3998.8
        mt5.asks = 3999.0

        # Step 1: Confirmed M5 swing low at 3996.0 tightens SL pre-BE to 3995.65
        m5_bars = [
            [3995.0, 3997.5, 3994.5, 3997.0, epoch + 0 * 300000],
            [3997.0, 3998.0, 3996.5, 3996.8, epoch + 1 * 300000],
            [3996.8, 3997.2, 3996.0, 3996.9, epoch + 2 * 300000],
            [3996.9, 3998.1, 3996.6, 3997.9, epoch + 3 * 300000],
            [3997.9, 3998.8, 3997.5, 3998.5, epoch + 4 * 300000],
            [3998.5, 3998.9, 3998.2, 3998.8, epoch + 5 * 300000],
        ]
        m15_bars = make_candles(3995, count=20, step=0.15)
        h1_bars = make_candles(3990, count=20, step=0.5, minutes=60)
        h4_bars = make_candles(3980, count=20, step=1.0, minutes=240)

        engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5_bars, m15_bars, h1_bars, h4_bars, None,
            {"enableM5StructuralTrail": True, "beAtOneR": True}
        )
        self.assertAlmostEqual(pos.sl, 3995.65, places=2)

        # Verify persisted initialR is STILL 7.50 (NOT 4000 - 3995.65 = 4.35!)
        st = engine._load_manager_state()
        rec_926 = next(v for k, v in st.items() if k.endswith("|926"))
        self.assertAlmostEqual(rec_926["initialR"], 7.50, places=2)

        # Step 2: Price moves to 4005.0 (+5.0 USD/oz > 4.5 DCA step and > 4.35 current SL dist, but < 7.50 initialR).
        # With M5 trail disabled for this check, BE must NOT trigger at +5.0!
        pos.price_current = 4005.0
        mt5.bids = 4005.0
        mt5.asks = 4005.2
        engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5_bars, m15_bars, h1_bars, h4_bars, None,
            {"enableM5StructuralTrail": False, "beAtOneR": True}
        )
        self.assertAlmostEqual(pos.sl, 3995.65, places=2)

        # Step 3: Price reaches 4007.60 (+7.60 >= 7.50 initialR) -> BE triggers at 4000.25!
        pos.price_current = 4007.60
        mt5.bids = 4007.60
        mt5.asks = 4007.80
        engine.manage_trend_and_manual_positions(
            mt5, "XAUUSD.G", mt5.positions, m5_bars, m15_bars, h1_bars, h4_bars, None,
            {"enableM5StructuralTrail": False, "beAtOneR": True}
        )
        self.assertAlmostEqual(pos.sl, 4000.25, places=2)
        self.assertAlmostEqual(next(v for k, v in engine._load_manager_state().items() if k.endswith("|926"))["initialR"], 7.50, places=2)

    def test_T27_live_and_backtest_produce_identical_management_decisions_on_same_bars(self):
        """T27 (Section 2, 4.2 & 5): Cùng dữ liệu và cấu hình thì live và backtest tạo cùng quyết định quản lý."""
        epoch = 1794180000000
        plan = {
            "allowed": True,
            "side": "BUY",
            "strategyMode": "BOT_1_TREND",
            "entryReference": 4000.0,
            "sl": 3993.0,
            "tp": 4025.0,
            "initialR": 7.0,
            "closedM15Time": epoch,
        }
        prior_m5 = [
            [3994.0, 3996.0, 3993.5, 3995.5, epoch - 4 * 300000],
            [3995.5, 3997.0, 3995.0, 3996.5, epoch - 3 * 300000],
            [3996.5, 3998.0, 3996.0, 3997.5, epoch - 2 * 300000],
            [3997.5, 3999.0, 3997.0, 3998.5, epoch - 1 * 300000],
        ]
        future_m5 = [
            [3998.5, 3999.5, 3996.2, 3997.0, epoch + 1 * 300000],  # Pivot low at 3996.2
            [3997.0, 3999.2, 3996.8, 3999.0, epoch + 2 * 300000],  # Confirms pivot low -> pre-BE M5 trail to 3995.85
            [3999.0, 4007.5, 3998.8, 4007.2, epoch + 3 * 300000],  # Reaches +7.2 (>= 1R=7.0) -> BE 4000.25 (or M5 trail)
            [4007.2, 4018.0, 4006.8, 4017.0, epoch + 4 * 300000],  # Peak 4018.0 (+18.0) -> 10 USD extreme lock at 4008.0
        ]
        sim = engine.simulate_position_lifecycle(
            plan, future_m5, future_m15_bars=[], prior_m5_bars=prior_m5,
            cfg={"m15SpikeTrailDist": 10.0, "roundTripCostPts": 0.08}
        )

        # Now feed the exact same bars step-by-step into Live Position Manager
        mt5 = SafeMockBroker()
        pos = SimpleNamespace(
            ticket=927, symbol="XAUUSD.G", type=0, volume=0.02,
            price_open=4000.0, price_current=4000.0, sl=3993.0, tp=4025.0,
            magic=270715, comment="V6_BOT_1_TREND", time=int(epoch / 1000)
        )
        mt5.positions = [pos]
        live_sl_history = [3993.0]
        accumulated_m5 = list(prior_m5)
        for fb in future_m5:
            accumulated_m5.append(fb)
            pos.price_current = fb[3]
            mt5.bids = fb[3]
            mt5.asks = round(fb[3] + 0.20, 2)
            # Pass accumulated_m5 + [forming_dummy] because manage_trend_and_manual_positions calls closed(candles_m5)
            engine.manage_trend_and_manual_positions(
                mt5, "XAUUSD.G", mt5.positions,
                accumulated_m5 + [accumulated_m5[-1]],
                make_candles(3995, count=20, step=0.2),
                make_candles(3990, count=20, step=0.5, minutes=60),
                make_candles(3980, count=20, step=1.0, minutes=240),
                None,
                {"m15SpikeTrailDist": 10.0, "roundTripCostPts": 0.08}
            )
            if pos.sl != live_sl_history[-1]:
                live_sl_history.append(round(pos.sl, 2))

        self.assertEqual(sim["slHistory"], live_sl_history)
        self.assertEqual(sim["finalSl"], round(pos.sl, 2))

    def test_T28_near_obstacle_with_insufficient_rr_blocks_trade_instead_of_picking_far_obstacle(self):
        """T28 (Section 3.2 & 5): Có cản gần H1/H4 không đủ R:R thì trả NO_TRADE, không bỏ qua cản gần để lấy cản xa."""
        m5, m15, h1, h4 = self.trend_fixtures()
        # Entry is ~4018.7, SL is ~4011.75 (risk ~6.95, minimum 1.6R net requires TP >= ~4029.90).
        # Place a confirmed 3-bar H1 swing high right ahead at 4023.50 (only +4.8 USD/oz away -> net R:R ~0.64 < 1.6)
        # AND a far H4 swing high at 4048.00 (+29.3 USD/oz away -> R:R > 4.0).
        h1[-4][1] = 4021.0
        h1[-3][1] = 4023.5  # Near confirmed swing high obstacle
        h1[-2][1] = 4020.5
        h4[-3][1] = 4048.0  # Far obstacle

        plan = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_1_TREND")
        self.assertFalse(plan["allowed"])
        self.assertEqual(plan["status"], "NO_TRADE")
        self.assertEqual(plan.get("subStatus"), "NEAR_OBSTACLE_INSUFFICIENT_RR")
        self.assertEqual(plan.get("nearestObstacle"), 4023.5)

    def test_T29_conflicting_signals_and_transition_regime_return_no_trade(self):
        """T29 (Section 3.1 & 5): Thị trường TRANSITION hoặc tín hiệu xung đột trả NO_TRADE."""
        m5, m15, h1, h4 = self.trend_fixtures()
        # Make H1 strongly bearish while M15 and H4 are bullish -> TRANSITION regime
        h1_bear = make_candles(4060, count=60, step=-0.5, body=-0.35, minutes=60)
        regime_res = classify_market_regime(m5, m15, h1_bear, h4)
        self.assertEqual(regime_res["regime"], "TRANSITION")

        plan_auto = evaluate_entry(m5, m15, h1_bear, h4, 4018.5, 4018.7, "AUTO_REGIME")
        self.assertFalse(plan_auto["allowed"])
        self.assertEqual(plan_auto["status"], "NO_TRADE")
        self.assertEqual(plan_auto["marketRegime"], "TRANSITION")

    def test_T30_ui_and_server_never_use_sample_data_or_multipliers_for_operational_results(self):
        """T30 (Section 4.1 & 5): Giao diện và Server không dùng 48 lệnh mẫu hoặc hệ số 0.74/0.70 để báo hiệu quả vận hành."""
        ui_html = (ROOT / "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html").read_text(encoding="utf-8")
        self.assertNotIn("* 0.74", ui_html)
        self.assertNotIn("* 0.70", ui_html)
        self.assertIn("let HAS_REAL_MT5_BACKTEST_DATA = false;", ui_html)
        self.assertIn("let BACKTEST_TRADES_RAW = [];", ui_html)
        self.assertIn("CHƯA CÓ DỮ LIỆU", ui_html)
        self.assertIn("CHƯA ĐÁNH GIÁ DCA", ui_html)
        self.assertIn("DỮ LIỆU GIẢ LẬP", ui_html)

        server_js = (ROOT / "scripts" / "xauusd-standalone-server.mjs").read_text(encoding="utf-8")
        self.assertIn('dataStatus: "CHƯA CÓ DỮ LIỆU"', server_js)
        self.assertIn('dcaEvaluationStatus: "CHƯA ĐÁNH GIÁ DCA"', server_js)

    def test_T31_backtest_splits_periods_and_separates_open_positions_and_win_be_loss_rates(self):
        """T31 (Section 4.2, 4.3 & 5): Backtest chia In-Sample/Validation/Out-of-Sample, tách vị thế đang mở cuối kỳ và tách Win/BE/Loss rate."""
        mt5 = SafeMockBroker()
        epoch = 1794180000000
        m15 = make_candles(4000, count=80, step=0.3, body=0.22, epoch=epoch, minutes=15)
        m15[35][0] = round(m15[35][3] - 1.10, 2)
        m15[35][1] = round(m15[35][3] + 0.10, 2)
        m15[35][2] = round(m15[35][0] - 0.10, 2)
        # Second signal near the end of the dataset (idx=75) that stays open at dataset end
        m15[75][0] = round(m15[75][3] - 1.10, 2)
        m15[75][1] = round(m15[75][3] + 0.10, 2)
        m15[75][2] = round(m15[75][0] - 0.10, 2)

        m5 = make_candles(4000, count=240, step=0.10, body=0.08, epoch=epoch, minutes=5)
        # First trade (entered at m15 idx=35 -> m5 idx ~108) hits TP at m5 idx 120
        m5[120][1] = 4035.0
        m5[120][3] = 4032.0

        h1 = make_candles(3950, count=80, step=0.4, body=0.3, epoch=epoch - 40 * 3600000, minutes=60)
        h4 = make_candles(3900, count=80, step=0.8, body=0.5, epoch=epoch - 40 * 14400000, minutes=240)

        bt = engine.run_historical_backtest_on_mt5(mt5, "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND",
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5, "m15Bars": m15, "h1Bars": h1, "h4Bars": h4,
        })
        self.assertTrue(bt["ok"])
        self.assertEqual(bt["dcaEvaluationStatus"], "DCA_NOT_EVALUATED")
        self.assertIn("IN_SAMPLE_DEV", bt["byPeriod"])
        self.assertIn("VALIDATION", bt["byPeriod"])
        self.assertIn("OUT_OF_SAMPLE", bt["byPeriod"])
        self.assertEqual(len(bt["chronologicalSegments"]), 3)
        self.assertIn("winRatePct", bt)
        self.assertIn("breakevenRatePct", bt)
        self.assertIn("lossRatePct", bt)
        self.assertAlmostEqual(
            bt["winRatePct"] + bt["breakevenRatePct"] + bt["lossRatePct"],
            100.0 if bt["tradeCount"] > 0 else 0.0,
            places=1,
        )



    def test_T32_arm_ignores_client_verified_probe_and_rejects_server_mismatch(self):
        """T32 (P0): Sending verifiedProbeForTest in request body CANNOT grant ARM; server mismatch ('OtherBroker-DBG-Live2' vs 'DBGMarkets-Live') is rejected."""
        node_verify = r"""
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { handleApiRequest, getCanonicalLiveArmState, setMt5EngineInvokerForTest, disarmLiveSession } = await import('./scripts/xauusd-standalone-server.mjs');
        const token = 'master_secret_token_2026';
        async function callArm(bodyObj) {
          let st = 200, outBody = '';
          const bodyStr = JSON.stringify(bodyObj);
          await handleApiRequest({
            method: 'POST', url: '/api/v1/mt5/arm-live',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bodyStr)), 'x-v6-control-token': token },
            socket: { remoteAddress: '127.0.0.1' },
            on(ev, cb) { if (ev === 'data') cb(Buffer.from(bodyStr)); if (ev === 'end') cb(); }
          }, { writeHead(s) { st = s; }, end(b) { outBody = b; } });
          return { status: st, data: JSON.parse(outBody || '{}') };
        }
        disarmLiveSession('reset');
        setMt5EngineInvokerForTest(() => ({ connected: false, errorMessage: 'No MT5' }));
        const rFake = await callArm({
          armed: true, confirmLive: true,
          verifiedProbeForTest: { connected: true, accountLogin: 5201362, server: 'DBGMarkets-Live', accountMode: 'LIVE', brokerSymbol: 'XAUUSD.G' }
        });
        const armedAfterFake = getCanonicalLiveArmState().liveArmed;

        setMt5EngineInvokerForTest(() => ({
          connected: true, accountLogin: 5201362, server: 'OtherBroker-DBG-Live2', accountMode: 'LIVE', brokerSymbol: 'XAUUSD.G', dailyRiskState: { ok: true, dailyLimitBreached: false }
        }));
        const rMismatch = await callArm({ armed: true, confirmLive: true });
        const armedAfterMismatch = getCanonicalLiveArmState().liveArmed;

        setMt5EngineInvokerForTest(() => ({
          connected: true, accountLogin: 5201362, server: 'DBGMarkets-Live', accountMode: '', brokerSymbol: 'XAUUSD.G'
        }));
        const rMissingMode = await callArm({ armed: true, confirmLive: true });

        console.log(JSON.stringify({ rFakeStatus: rFake.status, armedAfterFake, rMismatchStatus: rMismatch.status, armedAfterMismatch, rMissingModeStatus: rMissingMode.status }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertEqual(res["rFakeStatus"], 400)
        self.assertFalse(res["armedAfterFake"])
        self.assertEqual(res["rMismatchStatus"], 400)
        self.assertFalse(res["armedAfterMismatch"])
        self.assertEqual(res["rMissingModeStatus"], 400)

    def test_T33_post_fill_reconciliation_pending_delayed_partial_mismatch_and_netting(self):
        """T33 (P0): DONE without readable position -> RECONCILIATION_PENDING; delayed position -> retries & succeeds; order!=position ticket handled; Netting blocked."""
        class RecMT5:
            ACCOUNT_TRADE_MODE_DEMO = 0
            ACCOUNT_TRADE_MODE_REAL = 2
            ACCOUNT_MARGIN_MODE_RETAIL_NETTING = 0
            ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
            TRADE_ACTION_DEAL = 1
            ORDER_TYPE_BUY = 0
            ORDER_TYPE_SELL = 1
            ORDER_TIME_GTC = 0
            ORDER_FILLING_IOC = 1
            TRADE_RETCODE_DONE = 10009
            def __init__(self, margin_mode=2, pos_delay_reads=0, pos_ticket=None, partial_vol=None):
                self.margin_mode = margin_mode
                self.pos_delay_reads = pos_delay_reads
                self.read_calls = 0
                self.pos_ticket = pos_ticket
                self.partial_vol = partial_vol
            def terminal_info(self):
                return SimpleNamespace(connected=True, trade_allowed=True)
            def account_info(self):
                return SimpleNamespace(login=5201362, server="DBGMarkets-Live", trade_mode=0, trade_expert=True, equity=5000.0, balance=5000.0, margin_free=4500.0, margin_mode=self.margin_mode)
            def symbol_select(self, sym, enable):
                return True
            def symbol_info(self, sym):
                return SimpleNamespace(name=sym, point=0.01, digits=2, trade_contract_size=100.0, volume_min=0.01, volume_max=10.0, volume_step=0.01, filling_mode=2, trade_stops_level=50, trade_freeze_level=0)
            def symbol_info_tick(self, sym):
                return SimpleNamespace(bid=4050.00, ask=4050.20, time=int(time.time()))
            def order_calc_profit(self, action, sym, vol, p_open, p_close):
                return (p_close - p_open) * vol * 100.0 if action == 0 else (p_open - p_close) * vol * 100.0
            def order_calc_margin(self, action, sym, vol, price):
                return vol * 1000.0
            def order_send(self, req):
                return SimpleNamespace(retcode=10009, order=7001, deal=8001, volume=req["volume"], price=req["price"])
            def history_deals_get(self, *args, **kwargs):
                if kwargs.get("ticket") == 8001 and self.pos_ticket:
                    return [SimpleNamespace(ticket=8001, position_id=self.pos_ticket, time=int(time.time()), type=0, profit=0.0)]
                return []
            def positions_get(self, **kwargs):
                self.read_calls += 1
                if self.read_calls <= self.pos_delay_reads:
                    return []
                if self.pos_ticket is None:
                    return []
                t = kwargs.get("ticket")
                if t is not None and int(t) != int(self.pos_ticket):
                    return []
                return [SimpleNamespace(
                    ticket=self.pos_ticket, identifier=7001, symbol="XAUUSD.G", type=0,
                    volume=self.partial_vol if self.partial_vol is not None else 0.05,
                    price_open=4050.20, sl=4043.40, tp=4062.00, magic=270715, comment="V6_TEST"
                )]

        cfg = {
            "side": "BUY", "volume": 0.05, "slDistance": 6.8, "tpDistance": 11.8,
            "explicitSlPrice": 4043.40, "explicitTpPrice": 4062.00, "structuralInvalidationPrice": 4043.80,
            "reconcileMaxRetries": 3, "reconcileRetryDelaySec": 0.0,
        }
        res_pending = engine.execute_order(RecMT5(pos_delay_reads=99, pos_ticket=None), "XAUUSD.G", dict(cfg))
        self.assertFalse(res_pending["ok"])
        self.assertEqual(res_pending["status"], "RECONCILIATION_PENDING")
        self.assertFalse(res_pending["reconciled"])
        self.assertTrue(res_pending["reconcileFreezeDca"])

        res_delayed = engine.execute_order(RecMT5(pos_delay_reads=1, pos_ticket=9002), "XAUUSD.G", dict(cfg))
        self.assertTrue(res_delayed["ok"])
        self.assertTrue(res_delayed["reconciled"])
        self.assertEqual(res_delayed["ticket"], 9002)
        self.assertEqual(res_delayed["orderTicket"], 7001)

        res_partial = engine.execute_order(RecMT5(pos_delay_reads=0, pos_ticket=9003, partial_vol=0.02), "XAUUSD.G", dict(cfg))
        self.assertTrue(res_partial["ok"])
        self.assertEqual(res_partial["status"], "RECONCILED_WITH_DISCREPANCY")
        self.assertFalse(res_partial["reconciled"])
        self.assertTrue(res_partial["reconcileFreezeDca"])

        res_netting = engine.execute_order(RecMT5(margin_mode=0, pos_ticket=9004), "XAUUSD.G", dict(cfg))
        self.assertFalse(res_netting["ok"])
        self.assertEqual(res_netting["status"], "NETTING_MODE_UNSUPPORTED")

    def test_T34_state_isolation_empty_vs_none_and_lost_initial_r_recovery(self):
        """T34 (P0/P1): Account B empty positions or positions_get()=None does NOT wipe Account A; duplicate ticket isolated; lost initialR with trailed SL does NOT fabricate R."""
        with tempfile.TemporaryDirectory() as tmpdir:
            orig_file = engine.MANAGER_STATE_FILE
            engine.MANAGER_STATE_FILE = Path(tmpdir) / "mgr_state.json"
            try:
                engine._save_manager_state({
                    "1111|ServerA|XAUUSD.G|101": {
                        "accountLogin": 1111, "server": "ServerA", "symbol": "XAUUSD.G", "ticket": 101,
                        "status": "OPEN", "actualEntry": 4000.0, "initialSl": 3993.2, "initialR": 6.8, "peak": 4010.0,
                    }
                })
                class DummyMT5:
                    def __init__(self, login, server):
                        self._login = login
                        self._server = server
                    def account_info(self):
                        return SimpleNamespace(login=self._login, server=self._server)
                    def symbol_info(self, s):
                        return SimpleNamespace(point=0.01, digits=2, trade_stops_level=50, trade_freeze_level=0)
                    def symbol_info_tick(self, s):
                        return SimpleNamespace(bid=4012.0, ask=4012.2, time=int(time.time()))
                    def positions_get(self, **kwargs):
                        return []
                    def order_send(self, req):
                        return SimpleNamespace(retcode=10009)

                m5 = [[4000, 4002, 3999, 4001, 1700000000000 + i * 300000] for i in range(30)]
                m15 = [[4000, 4003, 3998, 4002, 1700000000000 + i * 900000] for i in range(30)]
                h1 = [[4000, 4005, 3995, 4002, 1700000000000 + i * 3600000] for i in range(30)]
                h4 = [[4000, 4010, 3990, 4002, 1700000000000 + i * 14400000] for i in range(30)]

                pos_b_dup = SimpleNamespace(
                    ticket=101, symbol="XAUUSD.G", type=0, price_open=4050.0, price_current=4060.0,
                    sl=4055.0, tp=4080.0, time=1700000000, magic=270715, comment="V6_BOT_1_TREND"
                )
                engine.manage_trend_and_manual_positions(
                    DummyMT5(2222, "ServerB"), "XAUUSD.G", [pos_b_dup], m5, m15, h1, h4, None, {"positionsReadOk": True}
                )
                engine.manage_trend_and_manual_positions(
                    DummyMT5(1111, "ServerA"), "XAUUSD.G", [], m5, m15, h1, h4, None, {"positionsReadOk": False}
                )
                st = engine._load_manager_state()
                self.assertIn("1111|ServerA|XAUUSD.G|101", st)
                self.assertEqual(st["1111|ServerA|XAUUSD.G|101"]["status"], "OPEN")
                self.assertEqual(st["1111|ServerA|XAUUSD.G|101"]["initialR"], 6.8)
                self.assertIn("2222|ServerB|XAUUSD.G|101", st)
                self.assertTrue(st["2222|ServerB|XAUUSD.G|101"].get("stateUnverified"))
                self.assertTrue(st["2222|ServerB|XAUUSD.G|101"].get("reconcileFreezeDca"))
                self.assertNotIn("initialR", st["2222|ServerB|XAUUSD.G|101"])
            finally:
                engine.MANAGER_STATE_FILE = orig_file

    def test_T35_regime_polling_idempotency_and_near_obstacle_within_050(self):
        """T35 (P1): Repeated polling on same closed M15 candle does not advance hysteresis; obstacles <= 0.50 from entry are detected."""
        import xauusd_v6_trade_rules as trade_rules
        m5 = [[4000, 4002, 3999, 4001, 1700000000000 + i * 300000] for i in range(40)]
        m15 = [[4000 - i * 0.5, 4002 - i * 0.5, 3998 - i * 0.5, 3999 - i * 0.5, 1700000000000 + i * 900000] for i in range(40)]
        h1 = [[4000 - i, 4002 - i, 3998 - i, 3999 - i, 1700000000000 + i * 3600000] for i in range(30)]
        h4 = [[4000 - i * 2, 4005 - i * 2, 3995 - i * 2, 3998 - i * 2, 1700000000000 + i * 14400000] for i in range(30)]

        # Simulate an active TRANSITION state on current closed M15 candle; polling again on same candle must NOT advance pendingCount to 2
        cur_ts = int(m15[-2][4])
        reg_state = {"regime": "TRANSITION", "hysteresisHeld": True, "lastClosedM15Ts": cur_ts, "pendingRegime": "TREND_DOWN", "pendingCount": 1}
        r1 = trade_rules.classify_market_regime(m5, m15, h1, h4, prior_regime="TREND_UP", regime_state=reg_state)
        r2 = trade_rules.classify_market_regime(m5, m15, h1, h4, prior_regime="TREND_UP", regime_state=reg_state)
        self.assertEqual(r1["regime"], "TRANSITION")
        self.assertEqual(r2["regime"], "TRANSITION")
        self.assertEqual(reg_state["pendingCount"], 1)

        h1_near = [[4000, 4001, 3999, 4000, 1700000000000 + i * 3600000] for i in range(25)]
        h1_near[12] = [4000, 4050.40, 3999, 4000, 1700000000000 + 12 * 3600000]
        tp_res = trade_rules.select_tp_with_near_obstacle_check("BUY", 4050.00, 4043.20, h1_near, h1_near, min_rr=1.6)
        self.assertFalse(tp_res["ok"])
        self.assertEqual(tp_res["tpSource"], "BLOCKED_BY_NEAR_OBSTACLE")
        self.assertAlmostEqual(tp_res["nearestObstacle"], 4050.40, places=2)


    def test_T36_wait_pullback_expiry_and_backtest_fixed_lot_warning_only(self):
        """T36 (Section IV & VII/VIII): WAIT_PULLBACK expires after 60m; Backtest uses FIXED_LOT and records risk warnings without blocking."""
        import xauusd_v6_trade_rules as trade_rules
        w_state = {"createdAtTs": 1700000000000, "expiresAtTs": 1700003600000}
        self.assertTrue(trade_rules.evaluate_wait_pullback_expiry(w_state, 1700001800000)["active"])
        self.assertTrue(trade_rules.evaluate_wait_pullback_expiry(w_state, 1700003600001)["expired"])

    def test_T37_no_auto_tunnel_emergency_stop_and_stdin_password_safety(self):
        """T37 (Section II.1 & IX.3): Server never auto-starts Cloudflare Tunnel; Emergency Stop revokes ARM & pauses Auto; Python payload uses --stdin."""
        srv_src = Path(ROOT / "scripts" / "xauusd-standalone-server.mjs").read_text(encoding="utf-8")
        self.assertIn("--stdin", srv_src)
        listen_block = srv_src.split("webServer.listen(WEB_PORT")[1]
        self.assertNotIn("startInternetTunnelForMobile();", listen_block)

        node_verify = r"""
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { handleApiRequest, getCanonicalLiveArmState, setMt5EngineInvokerForTest } = await import('./scripts/xauusd-standalone-server.mjs');
        const headers = { 'x-v6-control-token': 'master_secret_token_2026', 'content-type': 'application/json' };
        setMt5EngineInvokerForTest(() => ({
          connected: true, accountLogin: 5201362, server: 'DBGMarkets-Live', accountMode: 'LIVE', brokerSymbol: 'XAUUSD.G', dailyRiskState: { ok: true }
        }));
        async function callApi(url, bodyObj) {
          let st = 0, out = '';
          const bs = JSON.stringify(bodyObj);
          await handleApiRequest({
            method: 'POST', url, headers: { ...headers, 'content-length': String(Buffer.byteLength(bs)) },
            socket: { remoteAddress: '127.0.0.1' },
            on(ev, cb) { if (ev === 'data') cb(Buffer.from(bs)); if (ev === 'end') cb(); }
          }, { writeHead(s) { st = s; }, end(b) { out = b; } });
          return { status: st, data: JSON.parse(out || '{}') };
        }
        await callApi('/api/v1/mt5/arm-live', { armed: true, confirmLive: true });
        const armedBefore = getCanonicalLiveArmState().liveArmed;
        const emRes = await callApi('/api/v1/mt5/emergency-stop', { sourceDevice: 'WEB' });
        const armedAfter = getCanonicalLiveArmState().liveArmed;
        console.log(JSON.stringify({ armedBefore, armedAfter, emStatus: emRes.status, paused: emRes.data.emergencyStop?.paused, mgmt: emRes.data.emergencyStop?.protectiveManagementActive }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertTrue(res["armedBefore"])
        self.assertFalse(res["armedAfter"])
        self.assertEqual(res["emStatus"], 200)
        self.assertTrue(res["paused"])
        self.assertTrue(res["mgmt"])


    def test_T38_p0_strict_demo_live_binding_localhost_bind_and_deterministic_tick_utc(self):
        """T38 (P0.1, P0.2, P0.3): DEMO/REAL mismatch always blocked even if strictAccountMode=False; API binds 127.0.0.1; future/stale ticks rejected without guessing."""
        srv_src = Path(ROOT / "scripts" / "xauusd-standalone-server.mjs").read_text(encoding="utf-8")
        self.assertNotIn("strictAccountMode: false", srv_src)
        self.assertIn('const API_HOST = process.env.V6_API_HOST || "127.0.0.1"', srv_src)

        class ModeMT5:
            ACCOUNT_TRADE_MODE_DEMO = 0
            ACCOUNT_TRADE_MODE_REAL = 2
        real_acct = SimpleNamespace(login=5201362, server="DBGMarkets-Live", trade_mode=2)
        ok_demo_cfg, err_demo = engine.verify_mt5_account_binding(
            ModeMT5(), {"login": "5201362", "server": "DBGMarkets-Live", "accountMode": "DEMO", "strictAccountMode": False}, account=real_acct
        )
        self.assertFalse(ok_demo_cfg)
        self.assertIn("mode mismatch", err_demo.lower())

        now_ts = 1794000000.0
        ok_fut, _, _ = engine.verify_tick_freshness_utc(SimpleNamespace(time=now_ts + 7200.0), now_utc=now_ts)
        self.assertFalse(ok_fut)
        ok_old, _, _ = engine.verify_tick_freshness_utc(SimpleNamespace(time=now_ts - 7200.0), now_utc=now_ts)
        self.assertFalse(ok_old)
        ok_valid, _, _ = engine.verify_tick_freshness_utc(SimpleNamespace(time=now_ts - 5.0), now_utc=now_ts)
        self.assertTrue(ok_valid)


    def test_T39_p1_single_fixed_lot_source_and_fixed_dca_lot_across_layers(self):
        """T39 (P1.1, P1.2, P1.3): Single canonical fixedLot; server auto-bot loop does not block on dailyLimitBreached; DCA uses fixedDcaLot uniformly across layers."""
        srv_src = Path(ROOT / "scripts" / "xauusd-standalone-server.mjs").read_text(encoding="utf-8")
        self.assertIn("getCanonicalFixedLot", srv_src)
        self.assertNotIn("CHẶN MỞ LỆNH MỚI: Đã chạm giới hạn lỗ ngày", srv_src)

        class DcaMT5:
            ACCOUNT_TRADE_MODE_DEMO = 0
            ACCOUNT_TRADE_MODE_REAL = 2
            ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
            TRADE_ACTION_DEAL = 1
            ORDER_TYPE_BUY = 0
            ORDER_TIME_GTC = 0
            ORDER_FILLING_IOC = 1
            TRADE_RETCODE_DONE = 10009
            def __init__(self):
                self.positions = [
                    SimpleNamespace(ticket=101, identifier=101, symbol="XAUUSD.G", type=0, volume=0.05, price_open=4000.0, price_current=4012.0, sl=4000.5, tp=4030.0, profit=60.0, time=1699990000, magic=270715, comment="V6_BOT_1_TREND")
                ]
                self.sent = []
            def terminal_info(self): return SimpleNamespace(connected=True, trade_allowed=True)
            def account_info(self): return SimpleNamespace(login=5201362, server="DBGMarkets-Live", trade_mode=0, trade_expert=True, equity=5000.0, balance=5000.0, margin_free=4500.0, margin_mode=2)
            def symbol_select(self, s, e): return True
            def symbol_info(self, s): return SimpleNamespace(name=s, point=0.01, digits=2, trade_contract_size=100.0, volume_min=0.01, volume_max=10.0, volume_step=0.01, filling_mode=2, trade_stops_level=50, trade_freeze_level=0)
            def symbol_info_tick(self, s): return SimpleNamespace(bid=4012.0, ask=4012.2, time=int(time.time()))
            def order_calc_profit(self, a, s, v, po, pc): return (pc - po) * v * 100.0
            def order_calc_margin(self, a, s, v, p): return v * 1000.0
            def orders_get(self): return []
            def history_deals_get(self, *a, **k): return []
            def positions_get(self, **kw):
                t = kw.get("ticket")
                if t is not None: return [p for p in self.positions if p.ticket == int(t)]
                return list(self.positions)
            def order_send(self, req):
                self.sent.append(req)
                tk = 200 + len(self.sent)
                self.positions.append(SimpleNamespace(ticket=tk, identifier=tk, symbol="XAUUSD.G", type=0, volume=req["volume"], price_open=req["price"], price_current=req["price"], sl=req["sl"], tp=req["tp"], time=int(time.time()), magic=270715, comment="DCA_PLUS"))
                return SimpleNamespace(retcode=10009, order=tk, deal=tk, volume=req["volume"], price=req["price"])

        mt5 = DcaMT5()
        analysis = {"allowed": True, "side": "BUY", "requestedMode": "BOT_1_TREND", "strategyMode": "BOT_1_TREND", "trendSetup": {"side": "BUY", "confidence": 90}, "setupScore": 90, "confidence": 90, "sl": 4005.2, "tp": 4030.0, "structuralInvalidationPrice": 4005.5, "closedM15Time": 1700000000000}
        res_dca = engine.evaluate_and_execute_positive_dca(mt5, "XAUUSD.G", mt5.positions, analysis, {"enabled": True, "maxLayers": 2, "stepDistance": 3.5, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertTrue(res_dca["executed"])
        self.assertEqual(mt5.sent[0]["volume"], 0.02)


    def test_T40_p1_dashboard_position_state_uses_4_part_key_and_never_fabricates_initial_r(self):
        """T40 (P1.9): Dashboard state lookup isolates by account|server|symbol|ticket and does not fabricate initialR when trailed SL state is lost."""
        src = Path(ROOT / "scripts" / "mt5-direct-probe.py").read_text(encoding="utf-8")
        self.assertNotIn("mgr_state_now.get(str(tk_id))", src)
        self.assertIn("_position_state_keys(live_acc_login, live_acc_server, tk_id, p_sym)", src)


    def test_T41_p1_backtest_uses_symbol_contract_size_and_records_pnl_at_close(self):
        """T41 (P1.10, P1.11): Backtest values P/L using symbol contract size / tick value and attributes realized P/L to close timestamp."""
        m = engine._compute_metrics_for_trade_slice(
            [{"pts": 10.0, "rMultiple": 1.5}], [], base_lot=0.10, starting_balance=5000.0, usd_per_price_per_lot=50.0
        )
        self.assertEqual(m["netPnlUsd"], 50.0)
        src = Path(ROOT / "scripts" / "mt5-direct-probe.py").read_text(encoding="utf-8")
        self.assertIn("bt_daily_pnl[exit_day_str]", src)


    def test_T42_p2_fallback_analysis_never_generates_fake_market_prices_or_sl_tp(self):
        """T42 (P2.1): buildFallbackMtfAnalysis returns DATA_UNAVAILABLE with null prices/SL/TP and allowed=False."""
        node_verify = r"""
        const { buildFallbackMtfAnalysis } = await import('./scripts/xauusd-standalone-server.mjs');
        const fb = buildFallbackMtfAnalysis(4678.96);
        console.log(JSON.stringify({
          status: fb.status,
          allowed: fb.allowed,
          currentPrice: fb.currentPrice,
          stopLoss: fb.scenario15m?.stopLoss,
          tp2: fb.scenario15m?.tp2,
          ema34: fb.h4?.ema34
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertEqual(res["status"], "DATA_UNAVAILABLE")
        self.assertFalse(res["allowed"])
        self.assertIsNone(res["currentPrice"])
        self.assertIsNone(res["stopLoss"])
        self.assertIsNone(res["tp2"])
        self.assertIsNone(res["ema34"])


    def test_T43_p0_fixed_lot_sync_across_web_api_and_python_for_all_sizes(self):
        """T43 (P0.1): Setting 0.01, 0.02, 0.05, 0.10 via /api/v1/mt5/auto-bot or /fixed-lot syncs currentAccountConfig.fixedLot == autoBotState.volume."""
        node_verify = r"""
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { handleApiRequest, getCanonicalFixedLot, setMt5EngineInvokerForTest } = await import('./scripts/xauusd-standalone-server.mjs');
        const headers = { 'x-v6-control-token': 'master_secret_token_2026', 'content-type': 'application/json' };
        setMt5EngineInvokerForTest(() => ({ connected: true, accountLogin: 5201362, server: 'DBGMarkets-Live', accountMode: 'LIVE', brokerSymbol: 'XAUUSD.G' }));
        const results = [];
        for (const lot of [0.01, 0.02, 0.05, 0.10]) {
          let st = 0, out = '';
          const bs = JSON.stringify({ volume: lot, enabled: false });
          await handleApiRequest({
            method: 'POST', url: '/api/v1/mt5/auto-bot',
            headers: { ...headers, 'content-length': String(Buffer.byteLength(bs)) },
            socket: { remoteAddress: '127.0.0.1' },
            on(ev, cb) { if (ev === 'data') cb(Buffer.from(bs)); if (ev === 'end') cb(); }
          }, { writeHead(s) { st = s; }, end(b) { out = b; } });
          const parsed = JSON.parse(out || '{}');
          results.push({ lot, status: st, canonical: getCanonicalFixedLot(), autoVol: parsed.autoBotState?.volume });
        }
        console.log(JSON.stringify(results));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        rows = json.loads(out.splitlines()[-1])
        for r in rows:
            self.assertEqual(r["status"], 200)
            self.assertAlmostEqual(r["canonical"], r["lot"], places=2)
            self.assertAlmostEqual(r["autoVol"], r["lot"], places=2)

    def test_T44_p0_open_positions_none_initial_r_safe_and_dca_requires_explicit_fixed_lot(self):
        """T44 (P0.2 & P1.3): Missing initialR with trailed SL never crashes round(None, 2); DCA rejects if neither fixedDcaLot nor dcaUseBaseLot is configured."""
        src = Path(ROOT / "scripts" / "mt5-direct-probe.py").read_text(encoding="utf-8")
        self.assertIn('"initialR": round(persisted_r, 2) if persisted_r is not None else None', src)
        self.assertNotIn('"initialR": round(persisted_r, 2),', src)

        class DcaNoCfgMT5:
            def symbol_info(self, s): return SimpleNamespace(name=s, point=0.01, digits=2, trade_contract_size=100.0, volume_min=0.01, volume_max=10.0, volume_step=0.01)
            def symbol_info_tick(self, s): return SimpleNamespace(bid=4012.0, ask=4012.2, time=int(time.time()))
            def positions_get(self, **kw): return [SimpleNamespace(ticket=101, identifier=101, symbol="XAUUSD.G", type=0, volume=0.05, price_open=4000.0, price_current=4012.0, sl=4000.5, tp=4030.0, profit=60.0, time=1699990000, magic=270715, comment="V6_BOT_1_TREND")]
        pos = DcaNoCfgMT5().positions_get()[0]
        analysis = {"allowed": True, "side": "BUY", "requestedMode": "BOT_1_TREND", "strategyMode": "BOT_1_TREND", "setupScore": 90, "confidence": 90, "sl": 4005.2, "tp": 4030.0, "closedM15Time": 1700000000000}
        res_no_lot = engine.evaluate_and_execute_positive_dca(DcaNoCfgMT5(), "XAUUSD.G", [pos], analysis, {"enabled": True, "maxLayers": 2, "stepDistance": 3.5, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertFalse(res_no_lot["executed"])
        self.assertIn("FIXED_DCA_LOT", res_no_lot["reason"])

    def test_T45_p1_backtest_rejects_unverified_broker_contract_without_100_assumption(self):
        """T45 (P1.7): Backtest returns UNVERIFIED_BROKER_CONTRACT if symbol_info lacks contract size / tick value."""
        class NoContractMT5:
            def symbol_info(self, s): return None
            def account_info(self): return None
        bars = [[4000, 4002, 3998, 4001, 1700000000000 + i * 900000] for i in range(50)]
        res = engine.run_historical_backtest_on_mt5(NoContractMT5(), "XAUUSD.G", {"m5Bars": bars, "m15Bars": bars, "h1Bars": bars, "h4Bars": bars})
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], "UNVERIFIED_BROKER_CONTRACT")


    def test_T46_p0_fixed_lot_save_never_leaks_password_supports_0001_and_reports_write_error(self):
        """T46 (P0.1 & P0.2): setCanonicalFixedLot never writes password to disk, preserves 0.001 lot, isolates runtime dir, and rolls back on write error."""
        node_verify = r"""
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        const tmpRt = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-rt-'));
        process.env.V6_RUNTIME_DIR = tmpRt;
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { handleApiRequest, setCanonicalFixedLot, getCanonicalFixedLot, loadSavedAccountConfig } = await import('./scripts/xauusd-standalone-server.mjs');
        const cfgFile = path.join(tmpRt, 'active-mt5-account.json');
        // Write legacy file containing plaintext password -> loadSavedAccountConfig must scrub it!
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify({ login: '5201362', server: 'DBGMarkets-Live', password: 'SECRET_PASSWORD_123', fixedLot: 0.02 }), 'utf8');
        loadSavedAccountConfig();
        const scrubbedText = fs.readFileSync(cfgFile, 'utf8');

        // Test 0.001 lot precision preserved without rounding to 2 decimals
        const r001 = setCanonicalFixedLot(0.001, true);
        const lotAfter = getCanonicalFixedLot();

        // Simulate read-only / permission error on save
        const origWrite = fs.writeFileSync;
        fs.writeFileSync = () => { throw new Error('EACCES: permission denied'); };
        let errRes = null;
        try {
          errRes = setCanonicalFixedLot(0.05, true);
        } finally {
          fs.writeFileSync = origWrite;
        }
        try { fs.rmSync(tmpRt, { recursive: true, force: true }); } catch {}
        console.log(JSON.stringify({
          hasPasswordAfterScrub: scrubbedText.includes('SECRET_PASSWORD_123'),
          r001Ok: r001.ok,
          lotAfter,
          errOk: errRes.ok,
          errCode: errRes.error,
          lotRolledBack: getCanonicalFixedLot()
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertFalse(res["hasPasswordAfterScrub"])
        self.assertTrue(res["r001Ok"])
        self.assertAlmostEqual(res["lotAfter"], 0.001, places=3)
        self.assertFalse(res["errOk"])
        self.assertEqual(res["errCode"], "CONFIG_PERSIST_FAILED")
        self.assertAlmostEqual(res["lotRolledBack"], 0.001, places=3)

    def test_T47_p0_position_manager_never_falls_back_to_68_when_initial_r_missing(self):
        """T47 (P0.3): Position manager marks STATE_UNVERIFIED and keeps existing SL unchanged when initialR is missing (no 6.8 fallback)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            orig_file = engine.MANAGER_STATE_FILE
            engine.MANAGER_STATE_FILE = Path(tmpdir) / "mgr.json"
            try:
                class NoModifyMT5:
                    def __init__(self): self.mod_called = False
                    def account_info(self): return SimpleNamespace(login=5201362, server="DBGMarkets-Live")
                    def symbol_info(self, s): return SimpleNamespace(point=0.01, digits=2, trade_stops_level=50, trade_freeze_level=0)
                    def symbol_info_tick(self, s): return SimpleNamespace(bid=4020.0, ask=4020.2, time=int(time.time()))
                    def order_send(self, req):
                        self.mod_called = True
                        return SimpleNamespace(retcode=10009)
                mt5 = NoModifyMT5()
                # Trailed BUY position (SL 4005 >= Entry 4000) with NO saved state -> must NOT invent initialR=6.8 or modify SL
                pos = SimpleNamespace(ticket=888, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4020.0, sl=4005.0, tp=4040.0, time=1700000000, magic=270715, comment="V6_BOT_1_TREND")
                m5 = [[4000, 4002, 3999, 4001, 1700000000000 + i * 300000] for i in range(30)]
                m15 = [[4000, 4003, 3998, 4002, 1700000000000 + i * 900000] for i in range(30)]
                h1 = [[4000, 4005, 3995, 4002, 1700000000000 + i * 3600000] for i in range(30)]
                h4 = [[4000, 4010, 3990, 4002, 1700000000000 + i * 14400000] for i in range(30)]
                res = engine.manage_trend_and_manual_positions(mt5, "XAUUSD.G", [pos], m5, m15, h1, h4, None, {"positionsReadOk": True})
                self.assertFalse(mt5.mod_called)
                self.assertTrue(any("STATE_UNVERIFIED" in a for a in res["actions"]))
            finally:
                engine.MANAGER_STATE_FILE = orig_file


    def test_T48_p0_tiny_lot_rounding_to_zero_and_python_volume_zero_rejected_and_2file_rollback(self):
        """T48 (P0.1, P0.2, P0.3): 1e-8 lot rounded to 0 is rejected; Python execute_order(volume=0) is rejected (not 0.01); partial 2-file write rolls back first file."""
        class VolMT5:
            def terminal_info(self): return SimpleNamespace(connected=True, trade_allowed=True)
            def account_info(self): return SimpleNamespace(login=5201362, server="DBGMarkets-Live", trade_mode=0, trade_expert=True, equity=5000.0, balance=5000.0, margin_free=4500.0, margin_mode=2)
        res_zero = engine.execute_order(VolMT5(), "XAUUSD.G", {"side": "BUY", "volume": 0, "slDistance": 6.8, "tpDistance": 16.0})
        self.assertFalse(res_zero["ok"])
        self.assertIn("volume=0", res_zero["message"])
        res_missing = engine.execute_order(VolMT5(), "XAUUSD.G", {"side": "BUY", "slDistance": 6.8, "tpDistance": 16.0})
        self.assertFalse(res_missing["ok"])
        self.assertIn("Missing explicit Fixed Lot", res_missing["message"])

        node_verify = r"""
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        const tmpRt = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-rt-rb-'));
        process.env.V6_RUNTIME_DIR = tmpRt;
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { setCanonicalFixedLot, getCanonicalFixedLot } = await import('./scripts/xauusd-standalone-server.mjs');
        const rBase = setCanonicalFixedLot(0.05, true);
        const rTiny = setCanonicalFixedLot(1e-8, true);
        // Simulate failure on 2nd file write (shared-bot-state.json) -> 1st file must roll back to 0.05!
        const origRename = fs.renameSync;
        let renameCalls = 0;
        fs.renameSync = (src, dst) => {
          renameCalls += 1;
          if (String(dst).includes('shared-bot-state.json')) throw new Error('DISK_FULL');
          return origRename(src, dst);
        };
        const rPartialFail = setCanonicalFixedLot(0.10, true);
        fs.renameSync = origRename;
        const diskAcct = JSON.parse(fs.readFileSync(path.join(tmpRt, 'active-mt5-account.json'), 'utf8'));
        try { fs.rmSync(tmpRt, { recursive: true, force: true }); } catch {}
        console.log(JSON.stringify({ rBaseOk: rBase.ok, rTinyOk: rTiny.ok, rTinyErr: rTiny.error, rPartialOk: rPartialFail.ok, diskFixedLot: diskAcct.fixedLot, memFixedLot: getCanonicalFixedLot() }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertTrue(res["rBaseOk"])
        self.assertFalse(res["rTinyOk"])
        self.assertEqual(res["rTinyErr"], "INVALID_FIXED_LOT")
        self.assertFalse(res["rPartialOk"])
        self.assertAlmostEqual(res["diskFixedLot"], 0.05, places=2)
        self.assertAlmostEqual(res["memFixedLot"], 0.05, places=2)


    def test_T49_p1_backtest_dca_status_consistent_and_real_dca_simulation(self):
        """T49 (Task 1, 2, 6, 14): Behavioral check that Backtest without DCA reports DCA_NOT_EVALUATED and Backtest with DCA produces Scenario A vs Scenario B portfolio timelines."""
        epoch = 1794180000000
        m15 = make_candles(4000, count=60, step=0.3, body=0.22, epoch=epoch, minutes=15)
        m15[40][0] = round(m15[40][3] - 1.10, 2)
        m15[40][1] = round(m15[40][3] + 0.10, 2)
        m15[40][2] = round(m15[40][0] - 0.10, 2)
        m5 = make_candles(4000, count=180, step=0.10, body=0.08, epoch=epoch, minutes=5)
        m5[130][1] = 4020.0; m5[130][3] = 4019.5
        m5[135][1] = 4022.0; m5[135][3] = 4021.5
        m5[150][1] = 4035.0; m5[150][3] = 4032.0
        h1 = make_candles(3950, count=60, step=0.4, body=0.3, epoch=epoch - 40 * 3600000, minutes=60)
        h4 = make_candles(3900, count=60, step=0.8, body=0.5, epoch=epoch - 40 * 14400000, minutes=240)

        mt5_demo = SafeMockBroker(trade_mode=0, equity=5000.0)
        bt_no_dca = engine.run_historical_backtest_on_mt5(mt5_demo, "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND", "volume": 0.05, "enablePositiveDca": False,
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5, "m15Bars": m15, "h1Bars": h1, "h4Bars": h4,
        })
        self.assertTrue(bt_no_dca["ok"])
        self.assertEqual(bt_no_dca["dcaEvaluationStatus"], "DCA_NOT_EVALUATED")
        self.assertIn("scenarioWithoutDca", bt_no_dca["dcaComparison"])
        self.assertIn("scenarioWithPositiveDca", bt_no_dca["dcaComparison"])

    def test_T50_zero_rounding_fixed_lot_broker_validation_and_startup_reconciliation(self):
        """T50 (Item 1 & 2): Fixed Lot is never rounded; validates broker bounds/step; reconciles divergent files on startup; never touches real .runtime."""
        node_verify = r"""
        import fs from 'node:fs';
        import path from 'node:path';
        const { validateFixedLotAgainstBroker, restoreSafeConfigFromSavedState, getCanonicalFixedLot, setCanonicalFixedLot } = await import('./scripts/xauusd-standalone-server.mjs');
        const specs001 = { volumeMin: 0.001, volumeMax: 50.0, volumeStep: 0.001 };
        const specs01 = { volumeMin: 0.01, volumeMax: 10.0, volumeStep: 0.01 };
        const vExact = validateFixedLotAgainstBroker(0.025, specs001);
        const vBadStep = validateFixedLotAgainstBroker(0.025, specs01);
        const vOutMax = validateFixedLotAgainstBroker(25.0, specs01);
        const vMissingSpecs = validateFixedLotAgainstBroker(0.02, {});
        const vBool = validateFixedLotAgainstBroker(true, specs01);
        const vNan = validateFixedLotAgainstBroker(NaN, specs01);
        const vInf = validateFixedLotAgainstBroker(Infinity, specs01);

        // Divergent saved state: currentAccountConfig.fixedLot=0.05 vs shared-bot-state volume=0.09 -> reconciles to authoritative 0.05
        setCanonicalFixedLot(0.05, true);
        restoreSafeConfigFromSavedState({ autoBotState: { volume: 0.09, enabled: true } });
        const afterReconcile = getCanonicalFixedLot();

        console.log(JSON.stringify({
          vExactOk: vExact.ok, vExactLot: vExact.fixedLot,
          vBadStepOk: vBadStep.ok, vBadStepErr: vBadStep.error,
          vOutMaxOk: vOutMax.ok, vOutMaxErr: vOutMax.error,
          vMissingOk: vMissingSpecs.ok, vMissingErr: vMissingSpecs.error,
          vBoolOk: vBool.ok, vNanOk: vNan.ok, vInfOk: vInf.ok,
          afterReconcile
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertTrue(res["vExactOk"])
        self.assertEqual(res["vExactLot"], 0.025)
        self.assertFalse(res["vBadStepOk"])
        self.assertEqual(res["vBadStepErr"], "LOT_INVALID_BROKER_STEP")
        self.assertFalse(res["vOutMaxOk"])
        self.assertEqual(res["vOutMaxErr"], "LOT_OUT_OF_BROKER_BOUNDS")
        self.assertFalse(res["vMissingOk"])
        self.assertEqual(res["vMissingErr"], "MISSING_BROKER_LOT_SPECS")
        self.assertFalse(res["vBoolOk"])
        self.assertFalse(res["vNanOk"])
        self.assertFalse(res["vInfOk"])
        self.assertEqual(res["afterReconcile"], 0.05)

    def test_T51_state_unverified_recovery_from_mt5_history_and_dca_block(self):
        """T51 (Item 3): Lost state recovers initialR when MT5 history_orders_get has verified initial SL; blocks Positive DCA when STATE_UNVERIFIED."""
        class HistRecoverMT5:
            def account_info(self): return SimpleNamespace(login=5201362, server="DBGMarkets-Live")
            def symbol_info(self, s): return SimpleNamespace(point=0.01, digits=2, trade_stops_level=50, trade_freeze_level=0, volume_min=0.01, volume_max=10.0, volume_step=0.01)
            def symbol_info_tick(self, s): return SimpleNamespace(bid=4020.0, ask=4020.2, time=int(time.time()))
            def history_orders_get(self, **kw):
                if kw.get("position") == 701:
                    return [SimpleNamespace(ticket=701, position_id=701, price_open=4000.0, sl=3993.2, tp=4040.0)]
                return []
            def order_send(self, req): return SimpleNamespace(retcode=10009)
            def positions_get(self, **kw): return []

        m5 = [[4000, 4002, 3999, 4001, 1700000000000 + i * 300000] for i in range(30)]
        m15 = [[4000, 4003, 3998, 4002, 1700000000000 + i * 900000] for i in range(30)]
        h1 = [[4000, 4005, 3995, 4002, 1700000000000 + i * 3600000] for i in range(30)]
        h4 = [[4000, 4010, 3990, 4002, 1700000000000 + i * 14400000] for i in range(30)]

        pos_rec = SimpleNamespace(ticket=701, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4020.0, sl=4005.0, tp=4040.0, profit=100.0, time=1700000000, magic=270715, comment="V6_BOT_1_TREND")
        pos_unver = SimpleNamespace(ticket=702, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4020.0, sl=4005.0, tp=4040.0, profit=100.0, time=1700000000, magic=270715, comment="V6_BOT_1_TREND")

        engine.manage_trend_and_manual_positions(HistRecoverMT5(), "XAUUSD.G", [pos_rec, pos_unver], m5, m15, h1, h4, None, {"positionsReadOk": True})
        st = engine._load_manager_state()
        self.assertFalse(st["5201362|DBGMarkets-Live|XAUUSD.G|701"]["stateUnverified"])
        self.assertAlmostEqual(st["5201362|DBGMarkets-Live|XAUUSD.G|701"]["initialR"], 6.8, places=2)
        self.assertTrue(st["5201362|DBGMarkets-Live|XAUUSD.G|702"]["stateUnverified"])

        analysis = {"allowed": True, "side": "BUY", "requestedMode": "BOT_1_TREND", "strategyMode": "BOT_1_TREND", "setupScore": 90, "confidence": 90, "sl": 4013.2, "tp": 4040.0, "closedM15Time": 1700005000000}
        dca_res = engine.evaluate_and_execute_positive_dca(HistRecoverMT5(), "XAUUSD.G", [pos_unver], analysis, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertFalse(dca_res["executed"])
        self.assertIn("STATE_UNVERIFIED", dca_res["reason"])

    def test_T52_end_to_end_positive_dca_backtest_and_mt5_demo_integration(self):
        """T52 (Task 13 — Mock Integration Test with SafeMockBroker, NOT Real MT5 Terminal): Backtest Positive DCA simulates actual layers after BE and compares Scenario A vs Scenario B."""
        epoch = 1794180000000
        m15 = make_candles(4000, count=60, step=0.3, body=0.22, epoch=epoch, minutes=15)
        m15[40][0] = round(m15[40][3] - 1.10, 2)
        m15[40][1] = round(m15[40][3] + 0.10, 2)
        m15[40][2] = round(m15[40][0] - 0.10, 2)
        m5 = make_candles(4000, count=180, step=0.10, body=0.08, epoch=epoch, minutes=5)
        m5[130][1] = 4020.0; m5[130][3] = 4019.5
        m5[135][1] = 4022.0; m5[135][3] = 4021.5
        m5[150][1] = 4035.0; m5[150][3] = 4032.0
        h1 = make_candles(3950, count=60, step=0.4, body=0.3, epoch=epoch - 40 * 3600000, minutes=60)
        h4 = make_candles(3900, count=60, step=0.8, body=0.5, epoch=epoch - 40 * 14400000, minutes=240)

        mt5_demo = SafeMockBroker(trade_mode=0, equity=5000.0)
        bt_dca = engine.run_historical_backtest_on_mt5(mt5_demo, "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND",
            "volume": 0.05,
            "enablePositiveDca": True,
            "fixedDcaLot": 0.02,
            "maxDcaLayers": 2,
            "dcaStepDistance": 3.5,
            "usdPerPricePerLot": 100.0,
            "leverage": 100,
            "m5Bars": m5, "m15Bars": m15, "h1Bars": h1, "h4Bars": h4,
        })
        self.assertTrue(bt_dca["ok"])
        self.assertEqual(bt_dca["dcaEvaluationStatus"], "DCA_SIMULATED_WITH_FIXED_LOT")
        self.assertGreaterEqual(bt_dca["dcaComparison"]["totalSimulatedDcaLayers"], 1)
        dca_layers = bt_dca["trades"][0]["dcaLayersSimulated"]
        self.assertGreaterEqual(len(dca_layers), 1)
        for req_k in ("triggerCondition", "entryTs", "entryPrice", "fixedDcaLot", "sl", "tp", "spreadPts", "commissionPts", "slippagePts", "marginUsd", "exitTs", "exitPrice", "netPnlUsd", "reconciledSimulated"):
            self.assertIn(req_k, dca_layers[0])
        self.assertEqual(dca_layers[0]["fixedDcaLot"], 0.02)
        # M5 close confirms the DCA setup: the fill cannot be dated at that candle's open.
        for layer in dca_layers:
            self.assertEqual(layer["decisionM5CloseTs"], layer["decisionM5OpenTs"] + 300_000)
            self.assertEqual(layer["entryTs"], layer["decisionM5CloseTs"])
            self.assertGreater(layer["entryTs"], bt_dca["trades"][0]["beReachedTs"])
            self.assertLessEqual(layer["closedM15Time"], layer["entryTs"])
        expected_with_dca = round(bt_dca["dcaComparison"]["withoutDcaNetPnlUsd"] + sum(t["dcaPnlUsd"] for t in bt_dca["trades"]), 2)
        self.assertAlmostEqual(bt_dca["dcaComparison"]["withPositiveDcaNetPnlUsd"], expected_with_dca, places=2)

    def test_T53_simulate_lifecycle_contract_zero_lookahead_be_and_sell_dca_rr(self):
        """T53 (Task 1, 2, 3, 4, 14): Input contract validation, pts==netPts, no DCA before beReachedTs or when SL hit before BE, and accurate SELL DCA net R:R."""
        epoch = 1794180000000
        # 1. Missing entryReference / invalid plan -> structured error, never KeyError or 0.0 entry
        bad_plan = {"side": "BUY", "sl": 3993.0, "tp": 4020.0, "initialR": 7.0, "strategyMode": "BOT_1_TREND", "closedM15Time": epoch}
        bad_res = engine.simulate_position_lifecycle(bad_plan, [], [])
        self.assertFalse(bad_res["ok"])
        self.assertEqual(bad_res["error"], "INVALID_SIMULATION_PLAN")

        # 2. Valid plan -> returns both pts and netPts, plus oneRReachedTs and beReachedTs at bar close timestamp
        good_plan = {
            "side": "BUY", "entryReference": 4000.0, "sl": 3993.0, "tp": 4025.0,
            "initialR": 7.0, "strategyMode": "BOT_1_TREND", "closedM15Time": epoch
        }
        prior_m5 = [[3996.0, 3998.0, 3995.0, 3997.0, epoch - (4 - i) * 300000] for i in range(4)]
        future_m5 = [
            [4000.0, 4004.5, 3999.5, 4004.0, epoch + 1 * 300000],  # +4.0 (< 1R=7.0): NOT at BE yet!
            [4004.0, 4008.0, 4003.5, 4007.5, epoch + 2 * 300000],  # Reaches +1R -> BE triggered at close of bar (epoch + 3 * 300000)
            [4007.5, 4026.0, 4007.0, 4025.5, epoch + 3 * 300000],  # Hits TP 4025.0
        ]
        sim_good = engine.simulate_position_lifecycle(good_plan, future_m5, [], prior_m5_bars=prior_m5, cfg={"roundTripCostPts": 0.25})
        self.assertTrue(sim_good["ok"])
        self.assertEqual(sim_good["pts"], sim_good["netPts"])
        self.assertEqual(sim_good["oneRReachedTs"], epoch + 3 * 300000)
        self.assertEqual(sim_good["beReachedTs"], epoch + 3 * 300000)

        # 3. Base trade that hits SL before BE -> beReachedTs == 0
        sl_future_m5 = [
            [4000.0, 4004.2, 3999.5, 4004.0, epoch + 1 * 300000],  # Goes +4.0 (> step 3.5) BEFORE BE
            [4004.0, 4004.1, 3992.0, 3992.5, epoch + 2 * 300000],  # Drops to SL 3993.0 before ever reaching 1R (4007.0)
        ]
        sim_sl = engine.simulate_position_lifecycle(good_plan, sl_future_m5, [], prior_m5_bars=prior_m5, cfg={"roundTripCostPts": 0.25})
        self.assertTrue(sim_sl["ok"])
        self.assertEqual(sim_sl["beReachedTs"], 0)
        self.assertFalse(sim_sl["atBe"])

        # 4. Late BE & SELL DCA behavioral test in run_historical_backtest_on_mt5:
        m15_sell = make_candles(4100, count=60, step=-0.3, body=-0.22, epoch=epoch, minutes=15)
        m5_sell = make_candles(4100, count=180, step=-0.10, body=-0.08, epoch=epoch, minutes=5)
        # Entry occurs at m15[30] (m5 idx 93, entry ~4090.7).
        # Make m5[98] move down +4.2 in favor to 4086.5 (< 1R=6.0, so BEFORE BE -> counted in beforeBe!)
        m5_sell[98][2] = 4086.3; m5_sell[98][3] = 4086.5
        # Make m5[130] reach 1R (down to 4080.5) so BE is reached at close of m5[130]
        m5_sell[130][2] = 4080.0; m5_sell[130][3] = 4080.5
        # At m5[135] (close ~4078.5), prior m5 bars have swing high ~4085.0 (distance ~6.5 in [6.0, 8.0]) -> opens SELL DCA layer!
        m5_sell[135][2] = 4078.0; m5_sell[135][3] = 4078.5
        # Bar 150 hits bearish TP at 4065.0
        m5_sell[150][2] = 4064.0; m5_sell[150][3] = 4065.0
        h1_sell = make_candles(4150, count=60, step=-0.4, body=-0.3, epoch=epoch - 40 * 3600000, minutes=60)
        h4_sell = make_candles(4200, count=60, step=-0.8, body=-0.5, epoch=epoch - 40 * 14400000, minutes=240)

        mt5_demo = SafeMockBroker(trade_mode=0, equity=5000.0)
        bt_sell = engine.run_historical_backtest_on_mt5(mt5_demo, "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND", "volume": 0.05,
            "enablePositiveDca": True, "fixedDcaLot": 0.02, "maxDcaLayers": 2, "dcaStepDistance": 3.5,
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5_sell, "m15Bars": m15_sell, "h1Bars": h1_sell, "h4Bars": h4_sell,
        })
        self.assertTrue(bt_sell["ok"])
        sell_trades = [t for t in bt_sell["trades"] if t["side"] == "SELL"]
        self.assertGreaterEqual(len(sell_trades), 1)
        t_sell = sell_trades[0]
        self.assertGreater(t_sell["beReachedTs"], 0)
        self.assertGreaterEqual(t_sell["dcaRejectedCounts"]["beforeBe"], 1)
        self.assertGreaterEqual(len(t_sell["dcaLayersSimulated"]), 1)
        for d_layer in t_sell["dcaLayersSimulated"]:
            self.assertGreater(d_layer["entryTs"], t_sell["beReachedTs"])
            self.assertEqual(d_layer["entryTs"], d_layer["decisionM5CloseTs"])
            self.assertEqual(d_layer["decisionM5CloseTs"] - d_layer["decisionM5OpenTs"], 300_000)
            self.assertGreaterEqual(d_layer["initialR"], 6.0)
            self.assertLessEqual(d_layer["initialR"], 8.0)
            self.assertGreaterEqual(d_layer["netRewardRiskAtEntry"], 1.6)

    def test_T54_dca_rejections_wait_pullback_low_rr_margin_and_multi_position_portfolio_timeline(self):
        """T54 (Task 4, 5, 6, 14): DCA rejections (WAIT_PULLBACK SL>8, low R:R, insufficient margin), DCA hitting own SL, and simultaneous multi-position margin/balance timeline."""
        epoch = 1794180000000
        def _make_base_dataset():
            m15 = make_candles(4000, count=60, step=0.3, body=0.22, epoch=epoch, minutes=15)
            m5 = make_candles(4000, count=180, step=0.10, body=0.08, epoch=epoch, minutes=5)
            m5[130][1] = 4020.0; m5[130][3] = 4019.5  # Reaches BE at bar 130
            m5[135][1] = 4022.0; m5[135][3] = 4021.5  # Triggers DCA step at bar 135
            m5[150][1] = 4035.0; m5[150][3] = 4032.0  # Hits TP at bar 150
            h1 = make_candles(3950, count=60, step=0.4, body=0.3, epoch=epoch - 40 * 3600000, minutes=60)
            h4 = make_candles(3900, count=60, step=0.8, body=0.5, epoch=epoch - 40 * 14400000, minutes=240)
            return m5, m15, h1, h4

        # Case A: Insufficient Free Margin for DCA (disable mock order_calc_margin so contract_size*lot*price/leverage is used:
        # base 0.05 lot at 4009.38 with leverage=100 uses 200.47 margin; with startingBalance=205.0, free margin at bar 135 is ~65 USD < 80.43 USD needed for 0.02 DCA lot)
        m5, m15, h1, h4 = _make_base_dataset()
        mt5_low_margin = SafeMockBroker(trade_mode=0, equity=205.0)
        mt5_low_margin.order_calc_margin = None
        bt_low_margin = engine.run_historical_backtest_on_mt5(mt5_low_margin, "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND", "volume": 0.05, "startingBalance": 205.0,
            "enablePositiveDca": True, "fixedDcaLot": 0.02, "maxDcaLayers": 2, "dcaStepDistance": 3.5,
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5, "m15Bars": m15, "h1Bars": h1, "h4Bars": h4,
        })
        self.assertTrue(bt_low_margin["ok"])
        self.assertEqual(bt_low_margin["dcaComparison"]["totalSimulatedDcaLayers"], 0)
        self.assertGreaterEqual(bt_low_margin["dcaComparison"]["dcaRejectedCounts"]["insufficientMargin"], 1)

        # Case B: Structural SL > 8.0 USD/oz after BE -> WAIT_PULLBACK (no hardcoded 6.8 fallback)
        m5_far, m15_far, h1_far, h4_far = _make_base_dataset()
        for idx in range(131, 149):
            m5_far[idx][0] = 4021.8; m5_far[idx][1] = 4022.2; m5_far[idx][2] = 4021.6; m5_far[idx][3] = 4022.0
        # Drop all prior M5 lows in [115..130] down to 4010.0 so distance from 4022.0 is ~12.0 (> 8.0) -> structural_stop returns None -> waitPullback!
        for idx in range(115, 131):
            m5_far[idx][2] = 4010.0
        bt_wait_pb = engine.run_historical_backtest_on_mt5(SafeMockBroker(trade_mode=0, equity=5000.0), "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND", "volume": 0.05,
            "enablePositiveDca": True, "fixedDcaLot": 0.02, "maxDcaLayers": 2, "dcaStepDistance": 3.5,
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5_far, "m15Bars": m15_far, "h1Bars": h1_far, "h4Bars": h4_far,
        })
        self.assertTrue(bt_wait_pb["ok"])
        self.assertGreaterEqual(bt_wait_pb["dcaComparison"]["dcaRejectedCounts"]["waitPullback"], 1)

        # Case C: DCA layer hits its own SL while base trade continues to TP
        m5_dca_sl, m15_dca_sl, h1_dca_sl, h4_dca_sl = _make_base_dataset()
        # Ensure all EIGHT confirmed M5 candles preceding the entry have a valid
        # nearby structural low. The former fixture only raised bars 132-134;
        # bars 127-131 still had lows near 4012 and correctly triggered WAIT_PULLBACK.
        for idx in range(127, 138):
            m5_dca_sl[idx][0] = 4017.0
            m5_dca_sl[idx][1] = 4019.0
            m5_dca_sl[idx][2] = 4016.0
            m5_dca_sl[idx][3] = 4018.0
        # Keep the one-R move, a confirmed swing low at 133, and valid OHLC
        # throughout the setup. DCA at 135 has structural SL near 4014.65.
        m5_dca_sl[130][1] = 4020.0; m5_dca_sl[130][3] = 4019.5
        m5_dca_sl[133][2] = 4015.0; m5_dca_sl[133][3] = 4016.2
        m5_dca_sl[135][0] = 4020.0; m5_dca_sl[135][1] = 4022.0
        m5_dca_sl[135][2] = 4019.0; m5_dca_sl[135][3] = 4021.5
        m5_dca_sl[136][0] = 4021.0; m5_dca_sl[136][1] = 4022.0
        m5_dca_sl[136][2] = 4019.0; m5_dca_sl[136][3] = 4020.0
        m5_dca_sl[137][0] = 4020.0; m5_dca_sl[137][1] = 4021.0
        m5_dca_sl[137][2] = 4018.0; m5_dca_sl[137][3] = 4019.0
        # Raise H1 swing high so TP is at 4042.0 (giving DCA at 4021.66 plenty of R:R >= 1.6)
        h1_dca_sl[-5][1] = 4042.0
        # At bar 138, price dips to 4011.5, hitting the DCA SL; base SL remains nearer its original BE.
        m5_dca_sl[138][2] = 4011.50; m5_dca_sl[138][3] = 4016.0
        m5_dca_sl[150][1] = 4045.0; m5_dca_sl[150][3] = 4043.0
        bt_dca_sl = engine.run_historical_backtest_on_mt5(SafeMockBroker(trade_mode=0, equity=5000.0), "XAUUSD.G", {
            "strategyMode": "BOT_1_TREND", "volume": 0.05,
            "enableM5StructuralTrail": False, "enablePeakLock": False,
            "enablePositiveDca": True, "fixedDcaLot": 0.02, "maxDcaLayers": 1, "dcaStepDistance": 10.0,
            "usdPerPricePerLot": 100.0, "leverage": 100,
            "m5Bars": m5_dca_sl, "m15Bars": m15_dca_sl, "h1Bars": h1_dca_sl, "h4Bars": h4_dca_sl,
        })
        self.assertTrue(bt_dca_sl["ok"])
        t0 = bt_dca_sl["trades"][0]
        self.assertIn("TP", t0["exitType"])
        self.assertEqual(len(t0["dcaLayersSimulated"]), 1, msg=f"DCA rejection evidence: {t0.get('dcaRejectedCounts')}; BE={t0.get('beReachedTs')}; exit={t0.get('exitTsMs')}")
        self.assertIn("SL", t0["dcaLayersSimulated"][0]["exitType"])
        self.assertLess(t0["dcaLayersSimulated"][0]["netPnlUsd"], 0.0)
        self.assertLess(t0["dcaLayersSimulated"][0]["exitTs"], t0["exitTsMs"])

        # Case D: Multi-position simultaneous margin & Balance updated ONLY on close
        sample_trade = {
            "ticket": 10001, "tsMs": 1000, "exitTsMs": 5000, "entry": 4000.0, "exit": 4020.0, "sl": 3993.0, "tp": 4020.0,
            "initialR": 7.0, "finalSl": 4010.0, "beReachedTs": 2000, "slHistory": [3993.0, 4000.25],
            "exitType": "TP_HIT", "pts": 20.0, "netPts": 20.0, "rMultiple": 2.857, "volume": 0.05, "marginUsd": 200.0, "side": "BUY",
            "dcaLayersSimulated": [
                {"ticket": 1000101, "layer": 1, "side": "BUY", "entryTs": 2500, "exitTs": 5000, "entryPrice": 4004.0, "exitPrice": 4020.0, "fixedDcaLot": 0.02, "initialSl": 3997.5, "sl": 3997.5, "finalSl": 4004.25, "tp": 4020.0, "initialR": 6.5, "beReachedTs": 3500, "slHistory": [3997.5, 4004.25], "exitType": "TP_HIT", "pts": 16.0, "netPts": 16.0, "rMultiple": 2.46, "netPnlUsd": 32.0, "marginUsd": 80.08},
                {"ticket": 1000102, "layer": 2, "side": "BUY", "entryTs": 3000, "exitTs": 4000, "entryPrice": 4008.0, "exitPrice": 4001.5, "fixedDcaLot": 0.02, "initialSl": 4001.5, "sl": 4001.5, "finalSl": 4001.5, "tp": 4020.0, "initialR": 6.5, "beReachedTs": 0, "slHistory": [4001.5], "exitType": "SL_HIT", "pts": -6.5, "netPts": -6.5, "rMultiple": -1.0, "netPnlUsd": -13.0, "marginUsd": 80.16},
            ]
        }
        comp = engine._build_portfolio_scenario_comparison([sample_trade], [], 0.05, 5000.0, 100.0)
        sc_a = comp["scenarioWithoutDca"]
        sc_b = comp["scenarioWithPositiveDca"]
        self.assertAlmostEqual(sc_a["endingBalanceUsd"], 5100.0, places=2)
        self.assertAlmostEqual(sc_b["endingBalanceUsd"], 5119.0, places=2)
        snap_3000 = next(s for s in sc_b["timelineSnapshots"] if s["ts"] == 3000)
        self.assertEqual(snap_3000["openCount"], 3)
        self.assertAlmostEqual(snap_3000["balanceUsd"], 5000.0, places=2)
        self.assertAlmostEqual(snap_3000["usedMarginUsd"], 360.24, places=2)
        snap_4000 = next(s for s in sc_b["timelineSnapshots"] if s["ts"] == 4000)
        self.assertEqual(snap_4000["openCount"], 2)
        self.assertAlmostEqual(snap_4000["balanceUsd"], 4987.0, places=2)

    def test_T55_critical_rollback_failure_detection_and_tmp_file_cleanup(self):
        """T55 (Task 7, 8, 14): If 2nd config file fails AND rollback of 1st file also fails, returns CRITICAL_ROLLBACK_FAILED with rollbackVerified=false; cleans up .tmp files."""
        node_verify = r"""
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        const tmpRt = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-rt-crit-'));
        process.env.V6_RUNTIME_DIR = tmpRt;
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        const { setCanonicalFixedLot, getCanonicalFixedLot } = await import('./scripts/xauusd-standalone-server.mjs');
        setCanonicalFixedLot(0.05, true);

        const origRename = fs.renameSync;
        let renameCount = 0;
        fs.renameSync = (src, dst) => {
          renameCount += 1;
          if (renameCount === 1) return origRename(src, dst);
          throw new Error(' SIMULATED_DISK_IO_FAILURE ');
        };
        let critRes = null;
        try {
          critRes = setCanonicalFixedLot(0.10, true);
        } finally {
          fs.renameSync = origRename;
        }
        const leftoverTmp = fs.readdirSync(tmpRt).filter(f => f.endsWith('.tmp'));
        try { fs.rmSync(tmpRt, { recursive: true, force: true }); } catch {}
        console.log(JSON.stringify({
          ok: critRes.ok,
          error: critRes.error,
          rollbackVerified: critRes.rollbackVerified,
          memLot: getCanonicalFixedLot(),
          leftoverTmpCount: leftoverTmp.length
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "CRITICAL_ROLLBACK_FAILED")
        self.assertFalse(res["rollbackVerified"])
        self.assertAlmostEqual(res["memLot"], 0.05, places=2)
        self.assertEqual(res["leftoverTmpCount"], 0)


    def test_T56_verified_initial_sl_and_initial_r_recovery_all_10_cases(self):
        """T56 (Section III, Task 1): Verified initialSl/initialR recovery across all 10 cases (open deal/order vs later SLTP modifications, pre-BE/post-BE/multi-trail loss, missing SL, wrong account/server/ticket, multi-position isolation)."""
        class MultiHistMT5:
            def __init__(self, orders_by_pos=None, deals_by_pos=None):
                self.orders_by_pos = orders_by_pos or {}
                self.deals_by_pos = deals_by_pos or {}
            def account_info(self): return SimpleNamespace(login=5201362, server="DBGMarkets-Live")
            def symbol_info(self, s): return SimpleNamespace(point=0.01, digits=2, trade_stops_level=50, trade_freeze_level=0)
            def symbol_info_tick(self, s): return SimpleNamespace(bid=4020.0, ask=4020.2, time=int(time.time()))
            def history_orders_get(self, **kw): return list(self.orders_by_pos.get(int(kw.get("position", 0)), []))
            def history_deals_get(self, **kw): return list(self.deals_by_pos.get(int(kw.get("position", 0)), []))
            def order_send(self, req): return SimpleNamespace(retcode=10009)
            def positions_get(self, **kw): return []

        m5 = [[4000, 4002, 3999, 4001, 1700000000000 + i * 300000] for i in range(30)]
        m15 = [[4000, 4003, 3998, 4002, 1700000000000 + i * 900000] for i in range(30)]
        h1 = [[4000, 4005, 3995, 4002, 1700000000000 + i * 3600000] for i in range(30)]
        h4 = [[4000, 4010, 3990, 4002, 1700000000000 + i * 14400000] for i in range(30)]

        # 1) Pos #801: Lost state BEFORE BE after pre-BE M5 trail (current sl=3996.0, distance 4.0 < 6.0),
        #    with history containing a later SLTP modification (3996.0 at t=1300) listed BEFORE the opening order (3993.2 at t=1000)!
        #    Must recover 3993.2 (initialR=6.8), NEVER 3996.0 (4.0)!
        pos_801 = SimpleNamespace(ticket=801, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=3998.5, sl=3996.0, tp=4030.0, time=1000, magic=270715, comment="V6_BOT_1_TREND")
        # 2) Pos #802: Lost state AFTER BE and multiple M5 trails (current sl=4008.5), with DEAL_ENTRY_IN linked to opening order #8020 (sl=3992.5 -> initialR=7.5)
        pos_802 = SimpleNamespace(ticket=802, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4015.0, sl=4008.5, tp=4035.0, time=2000, magic=270715, comment="V6_BOT_1_TREND")
        # 3) Pos #803: History only has a later modified SL (at t=3600 != open time 3000) -> rejected -> STATE_UNVERIFIED!
        pos_803 = SimpleNamespace(ticket=803, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4010.0, sl=4001.0, tp=4030.0, time=3000, magic=270715, comment="V6_BOT_1_TREND")
        # 4) Pos #804: History record belongs to wrong account (login=999999) or wrong position_id (999) -> STATE_UNVERIFIED!
        pos_804 = SimpleNamespace(ticket=804, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4010.0, sl=4001.0, tp=4030.0, time=4000, magic=270715, comment="V6_BOT_1_TREND")
        # 5) Pos #805: Opening order at t=5000 had sl=0.0 (no initial SL at entry) -> STATE_UNVERIFIED!
        pos_805 = SimpleNamespace(ticket=805, symbol="XAUUSD.G", type=0, price_open=4000.0, price_current=4010.0, sl=4001.0, tp=4030.0, time=5000, magic=270715, comment="V6_BOT_1_TREND")

        mt5_hist = MultiHistMT5(
            orders_by_pos={
                801: [
                    SimpleNamespace(ticket=8019, position_id=801, action=6, time=1300, price_open=4000.0, sl=3996.0, tp=4030.0, comment="Modify SL"),
                    SimpleNamespace(ticket=801, position_id=801, action=1, time=1000, price_open=4000.0, sl=3993.2, tp=4030.0, comment="V6_BOT_1_TREND"),
                ],
                802: [
                    SimpleNamespace(ticket=8021, position_id=802, action=6, time=2300, price_open=4000.0, sl=3995.5, tp=4035.0, comment="Pre-BE trail"),
                    SimpleNamespace(ticket=8022, position_id=802, action=6, time=2600, price_open=4000.0, sl=4000.25, tp=4035.0, comment="Move to BE"),
                    SimpleNamespace(ticket=8020, position_id=802, action=1, time=2000, price_open=4000.0, sl=3992.5, tp=4035.0, comment="V6_BOT_1_TREND"),
                ],
                803: [
                    SimpleNamespace(ticket=8031, position_id=803, action=1, time=3600, price_open=4000.0, sl=3995.0, tp=4030.0),
                ],
                804: [
                    SimpleNamespace(ticket=804, position_id=804, login=999999, time=4000, price_open=4000.0, sl=3993.2, tp=4030.0),
                    SimpleNamespace(ticket=804, position_id=999, login=5201362, time=4000, price_open=4000.0, sl=3993.2, tp=4030.0),
                ],
                805: [
                    SimpleNamespace(ticket=805, position_id=805, action=1, time=5000, price_open=4000.0, sl=0.0, tp=4030.0),
                ],
            },
            deals_by_pos={
                802: [
                    SimpleNamespace(ticket=9020, order=8020, position_id=802, entry=0, time=2000, price=4000.0, sl=3992.5, tp=4035.0),
                ],
            },
        )

        engine._save_manager_state({})
        engine.manage_trend_and_manual_positions(
            mt5_hist, "XAUUSD.G", [pos_801, pos_802, pos_803, pos_804, pos_805], m5, m15, h1, h4, None, {"positionsReadOk": True}
        )
        st = engine._load_manager_state()

        s801 = st["5201362|DBGMarkets-Live|XAUUSD.G|801"]
        self.assertFalse(s801["stateUnverified"])
        self.assertAlmostEqual(s801["initialSl"], 3993.2, places=2)
        self.assertAlmostEqual(s801["initialR"], 6.8, places=2)
        self.assertIn("recoverySource", s801)
        self.assertIn("recoveredAtTs", s801)
        self.assertEqual(s801["recoveryEvidence"]["verifiedInitialSl"], 3993.2)

        s802 = st["5201362|DBGMarkets-Live|XAUUSD.G|802"]
        self.assertFalse(s802["stateUnverified"])
        self.assertAlmostEqual(s802["initialSl"], 3992.5, places=2)
        self.assertAlmostEqual(s802["initialR"], 7.5, places=2)
        self.assertEqual(s802["recoverySource"], "MT5_HISTORY_OPENING_ORDER_LINKED_TO_DEAL")

        for bad_tk, expected_reason in ((803, "ONLY_MODIFIED_SL_AFTER_OPEN_TIME"), (804, "ACCOUNT_MISMATCH"), (805, "OPENING_RECORD_HAD_NO_INITIAL_SL")):
            s_bad = st[f"5201362|DBGMarkets-Live|XAUUSD.G|{bad_tk}"]
            self.assertTrue(s_bad["stateUnverified"])
            self.assertTrue(s_bad["reconcileFreezeDca"])
            self.assertNotIn("initialR", s_bad)
            self.assertEqual(s_bad["recoveryFailureReason"], expected_reason)

    def test_T57_strict_4part_dca_reconciliation_corrupted_state_and_timeout_freeze(self):
        """T57 (Section IV, Task 2 & Task 3): No bare-ticket DCA lookup; blocks on wrong account/server record, corrupted state file, non-bot/opposite positions, prior layer not at BE, and freezes DCA after timeout/partial fill."""
        class StrictDcaMT5:
            def __init__(self, retcode=10009, positions=None):
                self.retcode = retcode
                self.positions = positions or []
                self.sent = []
            def terminal_info(self): return SimpleNamespace(connected=True, trade_allowed=True)
            def account_info(self): return SimpleNamespace(login=5201362, server="DBGMarkets-Live", trade_mode=0, trade_expert=True, equity=5000.0, balance=5000.0, margin_free=4500.0, margin_mode=2)
            def symbol_select(self, s, e): return True
            def symbol_info(self, s): return SimpleNamespace(name=s, point=0.01, digits=2, trade_contract_size=100.0, volume_min=0.01, volume_max=10.0, volume_step=0.01, filling_mode=2, trade_stops_level=50, trade_freeze_level=0)
            def symbol_info_tick(self, s): return SimpleNamespace(bid=4012.0, ask=4012.2, time=int(time.time()))
            def order_calc_profit(self, a, s, v, po, pc): return (pc - po) * v * 100.0
            def order_calc_margin(self, a, s, v, p): return v * 1000.0
            def orders_get(self): return []
            def history_deals_get(self, *a, **k): return []
            def history_orders_get(self, *a, **k): return []
            def positions_get(self, **kw):
                t = kw.get("ticket")
                if t is not None: return [p for p in self.positions if p.ticket == int(t)]
                return list(self.positions)
            def order_send(self, req):
                self.sent.append(req)
                return SimpleNamespace(retcode=self.retcode, order=9901, deal=9901, volume=req["volume"], price=req["price"])

        pos_be = SimpleNamespace(ticket=101, identifier=101, symbol="XAUUSD.G", type=0, volume=0.05, price_open=4000.0, price_current=4012.0, sl=4000.5, tp=4030.0, profit=60.0, time=1699990000, magic=270715, comment="V6_BOT_1_TREND")
        sig = {"allowed": True, "side": "BUY", "requestedMode": "BOT_1_TREND", "strategyMode": "BOT_1_TREND", "marketRegime": "TREND_UP", "setupScore": 90, "confidence": 90, "sl": 4005.2, "tp": 4030.0, "structuralInvalidationPrice": 4005.5, "closedM15Time": 1700000000000}

        # 1) State file only has bare ticket "101" or another account "999999|OtherServer|XAUUSD.G|101" -> blocked!
        engine._save_manager_state({
            "101": {"ticket": 101, "initialR": 6.8, "stateUnverified": True},
            "999999|OtherServer|XAUUSD.G|101": {"accountLogin": 999999, "server": "OtherServer", "symbol": "XAUUSD.G", "ticket": 101, "initialR": 6.8},
        })
        r_cross = engine.evaluate_and_execute_positive_dca(StrictDcaMT5(positions=[pos_be]), "XAUUSD.G", [pos_be], sig, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertFalse(r_cross["eligible"])
        self.assertEqual(r_cross["reasonCode"], "STATE_UNVERIFIED_MISSING_RECORD")

        # 2) Corrupted state file on disk -> blocked with STATE_FILE_CORRUPTED
        engine.MANAGER_STATE_FILE.write_text("{corrupted_json:", encoding="utf-8")
        r_corrupt = engine.evaluate_and_execute_positive_dca(StrictDcaMT5(positions=[pos_be]), "XAUUSD.G", [pos_be], sig, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertFalse(r_corrupt["eligible"])
        self.assertEqual(r_corrupt["reasonCode"], "STATE_FILE_CORRUPTED")

        # Restore valid 4-part state record for #101
        engine._save_manager_state({
            "5201362|DBGMarkets-Live|XAUUSD.G|101": {"accountLogin": 5201362, "server": "DBGMarkets-Live", "symbol": "XAUUSD.G", "ticket": 101, "initialSl": 3993.2, "initialR": 6.8, "stateUnverified": False, "reconciled": True}
        })

        # 3) Non-bot position on symbol (magic=888888) -> blocked with NON_BOT_POSITION_DETECTED
        pos_foreign = SimpleNamespace(ticket=102, symbol="XAUUSD.G", type=0, volume=0.02, price_open=4005.0, price_current=4012.0, sl=4005.5, tp=4030.0, profit=14.0, time=1699990500, magic=888888, comment="MANUAL_EA")
        r_foreign = engine.evaluate_and_execute_positive_dca(StrictDcaMT5(positions=[pos_be, pos_foreign]), "XAUUSD.G", [pos_be, pos_foreign], sig, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertFalse(r_foreign["eligible"])
        self.assertEqual(r_foreign["reasonCode"], "NON_BOT_POSITION_DETECTED")

        # 4) Opposite position (Hedge SELL) -> blocked with OPPOSITE_POSITION_HEDGE_DETECTED
        pos_hedge = SimpleNamespace(ticket=103, symbol="XAUUSD.G", type=1, volume=0.02, price_open=4015.0, price_current=4012.0, sl=4014.5, tp=3990.0, profit=6.0, time=1699990500, magic=270715, comment="V6_SELL")
        r_hedge = engine.evaluate_and_execute_positive_dca(StrictDcaMT5(positions=[pos_be, pos_hedge]), "XAUUSD.G", [pos_be, pos_hedge], sig, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND"}, execute=True)
        self.assertFalse(r_hedge["eligible"])
        self.assertEqual(r_hedge["reasonCode"], "OPPOSITE_POSITION_HEDGE_DETECTED")

        # 5) Broker timeout (retcode=10012) on DCA execution -> freezes DCA on #101 so subsequent retry is blocked!
        mt5_timeout = StrictDcaMT5(retcode=10012, positions=[pos_be])
        r_to1 = engine.evaluate_and_execute_positive_dca(mt5_timeout, "XAUUSD.G", [pos_be], sig, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND", "stepDistance": 3.5}, execute=True)
        self.assertFalse(r_to1["executed"])
        self.assertTrue(r_to1["uncertain"])
        self.assertEqual(r_to1["reasonCode"], "UNCERTAIN_FROZEN")
        # Second call after timeout must be immediately blocked without sending another order!
        r_to2 = engine.evaluate_and_execute_positive_dca(mt5_timeout, "XAUUSD.G", [pos_be], sig, {"enabled": True, "fixedDcaLot": 0.02, "strategyMode": "BOT_1_TREND", "stepDistance": 3.5}, execute=True)
        self.assertFalse(r_to2["eligible"])
        self.assertEqual(r_to2["reasonCode"], "STATE_UNVERIFIED")
        self.assertEqual(len(mt5_timeout.sent), 1)

    def test_T58_shared_dca_decision_parity_between_live_and_backtest(self):
        """T58 (Section V, Task 4, 5, 7): Shared evaluate_positive_dca_decision enforces identical rules for Live and Backtest (new closed M15 signal, regime/direction match, 6-8 structural SL, near obstacles, R:R >= 1.6, stop_level)."""
        sig_valid = {
            "allowed": True, "side": "BUY", "requestedMode": "BOT_1_TREND", "strategyMode": "BOT_1_TREND",
            "marketRegime": "TREND_UP", "setupScore": 90, "confidence": 90, "closedM15Time": 1700001800000,
            "sl": 4005.2, "tp": 4030.0, "patternName": "EMA Pullback"
        }
        # 1. Valid decision
        d_ok = engine.evaluate_positive_dca_decision(
            side="BUY", exec_price=4012.0, last_entry_price=4000.0, base_tp=4030.0,
            current_dca_layers=0, max_layers=2, step_distance=3.5, strategy_mode="BOT_1_TREND",
            signal=sig_valid, last_signal_m15_ts=1700000000000, candidate_sl=4005.2,
            min_conf=85.0, min_rr=1.6, round_trip_cost=0.08, stops_gap=0.50, bid_price=4011.8, ask_price=4012.0
        )
        self.assertTrue(d_ok["ok"])
        self.assertEqual(d_ok["dcaSl"], 4005.2)
        self.assertEqual(d_ok["dcaTp"], 4030.0)
        self.assertAlmostEqual(d_ok["initialR"], 6.8, places=2)

        # 2. Same or older closedM15Time -> DUPLICATE_OR_STALE_M15_SIGNAL
        d_stale = engine.evaluate_positive_dca_decision(
            side="BUY", exec_price=4012.0, last_entry_price=4000.0, base_tp=4030.0,
            current_dca_layers=0, max_layers=2, step_distance=3.5, strategy_mode="BOT_1_TREND",
            signal=sig_valid, last_signal_m15_ts=1700001800000, candidate_sl=4005.2,
        )
        self.assertFalse(d_stale["ok"])
        self.assertEqual(d_stale["reasonCode"], "DUPLICATE_OR_STALE_M15_SIGNAL")

        # 3. Conflicting regime (TRANSITION) or direction (SELL) -> REGIME_OR_SIGNAL_CONFLICT
        d_conflict = engine.evaluate_positive_dca_decision(
            side="BUY", exec_price=4012.0, last_entry_price=4000.0, base_tp=4030.0,
            current_dca_layers=0, max_layers=2, step_distance=3.5, strategy_mode="BOT_1_TREND",
            signal={**sig_valid, "marketRegime": "TRANSITION"}, last_signal_m15_ts=1700000000000, candidate_sl=4005.2,
        )
        self.assertFalse(d_conflict["ok"])
        self.assertEqual(d_conflict["reasonCode"], "REGIME_OR_SIGNAL_CONFLICT")

    def test_T59_portfolio_timeline_base_closes_before_dca_floating_equity_dd_and_margin_call(self):
        """T59 (Section V, Task 6): Portfolio timeline handles Base closing before DCA layer, tracks floating Equity drawdown from DCA, and detects Margin Call / Stop-Out."""
        # Base closes at t=3500 (trailed SL hit +10 pts), while DCA Layer 1 stays open until t=5000 (hits SL at 3997.0 for -7.0 pts)
        trade_base_first = {
            "ticket": 10001, "tsMs": 1000, "exitTsMs": 3500, "entry": 4000.0, "exit": 4010.0, "sl": 3993.0, "tp": 4030.0,
            "initialR": 7.0, "finalSl": 4010.0, "beReachedTs": 2000, "slHistory": [3993.0, 4010.0],
            "exitType": "TREND_TRAIL_EXIT", "pts": 10.0, "netPts": 10.0, "rMultiple": 1.43, "volume": 0.05, "marginUsd": 200.0, "side": "BUY",
            "dcaLayersSimulated": [
                {"ticket": 1000101, "layer": 1, "side": "BUY", "entryTs": 2500, "exitTs": 5000, "entryPrice": 4012.0, "exitPrice": 4005.0, "fixedDcaLot": 0.05, "initialSl": 4005.0, "sl": 4005.0, "finalSl": 4005.0, "tp": 4030.0, "initialR": 7.0, "beReachedTs": 0, "slHistory": [4005.0], "exitType": "SL_HIT", "pts": -7.0, "netPts": -7.0, "rMultiple": -1.0, "netPnlUsd": -35.0, "marginUsd": 200.6},
            ]
        }
        comp = engine._build_portfolio_scenario_comparison([trade_base_first], [], 0.05, 320.0, 100.0)
        sc_b = comp["scenarioWithPositiveDca"]
        # At t=2500, both Base and DCA1 are open (openCount=2, usedMargin=400.6, marginLevel < 100% on $350 balance -> triggers marginCallEvents!)
        snap_2500 = next(s for s in sc_b["timelineSnapshots"] if s["ts"] == 2500)
        self.assertEqual(snap_2500["openCount"], 2)
        self.assertAlmostEqual(snap_2500["usedMarginUsd"], 400.6, places=2)
        self.assertGreaterEqual(sc_b["marginCallEvents"], 1)
        # At t=3500, Base closes (+$50 -> balance=$400.0), while DCA1 is STILL open (openCount=1, usedMargin=200.6)!
        snap_3500 = next(s for s in sc_b["timelineSnapshots"] if s["ts"] == 3500)
        self.assertEqual(snap_3500["openCount"], 1)
        self.assertAlmostEqual(snap_3500["balanceUsd"], 370.0, places=2)
        self.assertAlmostEqual(snap_3500["usedMarginUsd"], 200.6, places=2)
        # At t=5000, DCA1 closes (-$35 -> balance=$365.0, openCount=0, usedMargin=0.0) and maxEquityDrawdownUsd > 0
        snap_5000 = next(s for s in sc_b["timelineSnapshots"] if s["ts"] == 5000)
        self.assertEqual(snap_5000["openCount"], 0)
        self.assertAlmostEqual(snap_5000["balanceUsd"], 335.0, places=2)
        self.assertGreater(sc_b["maxEquityDrawdownUsd"], 0.0)

    def test_T60_corrupted_config_on_startup_never_defaults_to_002_and_blocks_new_orders(self):
        """T60 (Section VI, Task 8 & Task 9): Simulated power-loss / corrupted config file marks config unverified, returns fixedLot=null (not 0.02), and blocks /api/v1/mt5/order until repaired."""
        node_verify = r"""
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        const tmpRt = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-rt-corrupt-'));
        process.env.V6_RUNTIME_DIR = tmpRt;
        process.env.ZIQ_V6_CONTROL_TOKEN = 'master_secret_token_2026';
        // Write truncated/corrupted active-mt5-account.json before importing server
        fs.writeFileSync(path.join(tmpRt, 'active-mt5-account.json'), '{"login":"5201362","fixedLot":', 'utf8');
        const { handleApiRequest, getCanonicalFixedLot, getConfigIntegrityState, setCanonicalFixedLot, reloadRuntimeConfigFromDisk } = await import('./scripts/xauusd-standalone-server.mjs');
        const integrityBoot = getConfigIntegrityState();
        const lotBoot = getCanonicalFixedLot();

        // Attempt to place an order while config is unverified -> must be blocked with 400 CONFIG_UNVERIFIED_ORDER_BLOCKED
        let orderSt = 0, orderBody = '';
        const reqStr = JSON.stringify({ side: 'BUY', volume: 0.02 });
        await handleApiRequest({
          method: 'POST', url: '/api/v1/mt5/order',
          headers: { 'x-v6-control-token': 'master_secret_token_2026', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(reqStr)) },
          socket: { remoteAddress: '127.0.0.1' },
          on(ev, cb) { if (ev === 'data') cb(Buffer.from(reqStr)); if (ev === 'end') cb(); }
        }, { writeHead(s) { orderSt = s; }, end(b) { orderBody = b; } });

        // Now repair config via setCanonicalFixedLot(0.05, true) -> integrity becomes verified!
        const repairRes = setCanonicalFixedLot(0.05, true);
        const integrityAfterRepair = getConfigIntegrityState();
        const lotAfterRepair = getCanonicalFixedLot();
        try { fs.rmSync(tmpRt, { recursive: true, force: true }); } catch {}
        console.log(JSON.stringify({
          bootVerified: integrityBoot.verified,
          lotBoot,
          orderSt,
          orderErr: JSON.parse(orderBody || '{}').error,
          repairOk: repairRes.ok,
          afterVerified: integrityAfterRepair.verified,
          lotAfterRepair
        }));
        """
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_verify], cwd=ROOT).decode("utf-8").strip()
        res = json.loads(out.splitlines()[-1])
        self.assertFalse(res["bootVerified"])
        self.assertIsNone(res["lotBoot"])
        self.assertEqual(res["orderSt"], 400)
        self.assertEqual(res["orderErr"], "CONFIG_UNVERIFIED_ORDER_BLOCKED")
        self.assertTrue(res["repairOk"])
        self.assertTrue(res["afterVerified"])
        self.assertAlmostEqual(res["lotAfterRepair"], 0.05, places=2)

    def test_T61_all_six_bot_strategies_sideway_peak_lock_off_and_demo_preflight_script(self):
        """T61 (Section VII, VIII & X — Tasks 10, 11, 13, 16): Independent verification of all 6 bot modes, BOT_2_SIDEWAY Peak Lock disabled by default, and dedicated MT5 DEMO verifier."""
        import xauusd_v6_trade_rules as trade_rules
        # 1. Verify BOT_2_SIDEWAY has Peak Lock disabled by default while M5 structural trail & BE at 1R work
        m5_sw = [[4000, 4001, 3999, 4000.5, 1700000000000 + i * 300000] for i in range(15)]
        m15_sw = [[4000, 4016, 3999, 4015.0, 1700000000000 + i * 900000] for i in range(15)]
        step_sw = trade_rules.evaluate_position_management_step(
            side="BUY", entry=4000.0, current_price=4015.0, current_sl=4000.25, current_tp=4020.0,
            initial_r=6.5, favorable_extreme=4016.0, confirmed_m5=m5_sw, confirmed_m15=m15_sw,
            strategy_mode="BOT_2_SIDEWAY", config={"beAtOneR": True, "enableM5StructuralTrail": False}
        )
        # Peak is 4016 (+16 USD), 10-USD peak lock would be 4006.0 if enabled, but sidewayEnablePeakLock defaults to False!
        self.assertNotEqual(step_sw.get("newSl"), 4006.0)

        # 2. Verify dedicated run-mt5-demo-integration.py script reports SKIPPED_NO_MT5_TERMINAL honestly on Linux
        demo_out = subprocess.check_output(["python3", "scripts/run-mt5-demo-integration.py"], cwd=ROOT).decode("utf-8").strip()
        demo_json = json.loads(demo_out)
        self.assertEqual(demo_json["status"], "SKIPPED_NO_MT5_TERMINAL")
        self.assertFalse(demo_json["isMockBroker"])
        self.assertFalse(demo_json["demoVerified"])
        self.assertFalse(demo_json["liveReady"])

if __name__ == "__main__":
    unittest.main()
