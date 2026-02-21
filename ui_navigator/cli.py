import argparse

def main() -> int:
    parser = argparse.ArgumentParser(prog="ui-navigator")
    parser.add_argument("--ping", action="store_true", help="Health check")
    args = parser.parse_args()

    if args.ping:
        print("ui-navigator: OK")
        return 0

    print("No command provided. Try: python -m ui_navigator.cli --ping")
    return 1

if __name__ == "__main__":
    raise SystemExit(main())