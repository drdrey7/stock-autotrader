import argparse
import json

from bot.strategies import registry


def smoke() -> dict[str, object]:
    return {"status": "ok", "mode": "smoke", "strategies": registry.metadata(), "broker_enabled": False}


def main() -> None:
    parser = argparse.ArgumentParser(description="Stock Autotrader private engine")
    parser.add_argument("command", choices=["smoke", "strategies"], default="smoke", nargs="?")
    args = parser.parse_args()
    payload = smoke() if args.command == "smoke" else {"strategies": registry.metadata()}
    print(json.dumps(payload, default=str))


if __name__ == "__main__":
    main()
