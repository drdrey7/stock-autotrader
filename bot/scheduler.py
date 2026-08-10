import argparse
import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ScheduledJob:
    id: str
    schedule: str
    timezone: str
    command: str
    enabled: bool = False


JOBS = (
    ScheduledJob(
        "pre_market_scan", "30 8 * * 1-5", "America/New_York", "stock-engine scan --mode pre-market"
    ),
    ScheduledJob(
        "post_close_scan", "15 16 * * 1-5", "America/New_York", "stock-engine scan --mode post-close"
    ),
    ScheduledJob("health_smoke", "*/15 * * * *", "UTC", "stock-engine smoke"),
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Describe safe future engine schedules")
    parser.add_argument("command", choices=["describe"], default="describe", nargs="?")
    parser.parse_args()
    print(json.dumps({"status": "configuration_required", "jobs": [asdict(job) for job in JOBS]}))


if __name__ == "__main__":
    main()
