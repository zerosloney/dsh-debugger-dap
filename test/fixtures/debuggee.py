"""Richer debuggee for real-adapter e2e verification (dsh-debugger-dap)."""


def add(a, b):
    result = a + b   # line 5
    return result    # line 6


def main():
    count = 1
    total = add(count, 41)   # line 11
    for i in range(3):       # line 12
        total += i           # line 13
    print(f"total={total}")


if __name__ == "__main__":
    main()
