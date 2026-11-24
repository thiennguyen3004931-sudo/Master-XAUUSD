"""Test package marker: every test run is offline and may not reach a real MT5 terminal."""

try:
    from tests import v6_offline_mt5_guard as _v6_offline_mt5_guard  # noqa: F401
except ImportError:  # discover -s tests imports modules as top-level names
    import v6_offline_mt5_guard as _v6_offline_mt5_guard  # noqa: F401
